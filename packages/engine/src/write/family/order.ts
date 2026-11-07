/**
 * The statements of a family write, in the one order PostgreSQL admits, cut into statements the transport carries
 * (rows-first.md §2).
 *
 * PostgreSQL never defers a check nor a unique slot (group, index), and checks a sequence's predecessor key and every
 * owner axis at the end of each statement; a counted family's closure and every family's last axis wait for commit. So
 * a write's statements go in one order:
 *
 * - deletes first: every removed member, every member a sequence's suffix rewrite re-places, and every member a move
 *   between groups re-places, by key, members before their owners (deepest relation first);
 * - then updates in place, by key: a counted member moved into a slot a delete freed, a member whose accumulators a
 *   refill changes, and a member whose caller fields change; each sets every column but its key, its groups and its
 *   copies of its owners' counts, which the owner axes cascade. A move goes only into a freed slot, so no slot is held
 *   twice at any row's update, and every member below its owner's new count holds a slot below it before the count
 *   falls;
 * - then each changed owner's one count statement, its count and ends together, which the owner axis cascades into
 *   every member's copy;
 * - then inserts: new and re-placed members, whole, owners before their members (shallowest relation first), a
 *   sequence's members in ascending slot order per owner and a tree's in pre-order, so each statement's first member of
 *   an owner finds its predecessor already written.
 *
 * Why updates come before counts: a counted removal is swap-with-last, so the last member moves, by an update, into the
 * slot a delete freed. Were the count to fall first, the owner axis would cascade the new count n − 1 into every
 * member's ‹n›, the last member's included while it still holds slot n − 1, and the bound `CHECK (i < ‹n›)` refuses it
 * at that statement's end: the shrink-order cascade failure. After the moves, every member below the new count holds a
 * slot below it, so the count falls safely. An update never sets a member's ‹n› (the cascade does), and a refill's
 * accumulators are checked row by row (`after = combine(before, x)`, the first-slot pin), each true of the row the
 * update writes; the predecessor axis it also changes is a counted family's, deferred, so its prefix proof waits for
 * commit. A sequence's suffix is never updated in place but deleted and inserted again, since its predecessor axis is
 * immediate. A count updated twice would pass through counts no family has, so a plan updates each count once, and an
 * append is one update however many members it adds.
 *
 * Each phase is cut into consecutive statements, each holding as many rows as fit: its arrays' literals within V8's
 * longest string, and its Bind message within PostgreSQL's longest message. A family larger than one statement goes as
 * consecutive inserts after its one count update, in ascending slot order.
 *
 * Inside each update and insert statement, rows go ordered by their pattern input (pattern-order.ts): the values a
 * row CHECK's or a generated field's match reads its pattern from, so each pattern PostgreSQL compiles serves every row
 * of it in the statement, where rows cycling through more patterns than its cache of compiled ones holds would compile
 * one per row. Only a statement's own rows are reordered, after the cut, so the statements keep their order: a
 * statement's predecessor keys and owner axes are checked at its end, and no two of its rows hold one slot, so its rows
 * go in any order.
 */
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { defined, invariant } from "#compiler/core/invariant.ts"
import { maxStringLength, messageMaxBytes } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { ReadonlyTupleMap, ReadonlyTupleSet } from "#compiler/core/tuple-map.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import {
	type CountRow,
	countTexts,
	keyTexts,
	type MemberKey,
	type Owner,
	type Recount,
	type Row,
	rowTexts
} from "#compiler/write/family/draw.ts"
import { byPatternInput } from "#compiler/write/family/pattern-order.ts"

/**
 * One member relation's rows of a write, each kind a set by its key's texts, compared element by element
 * (core/tuple-map.ts), so no row is written twice by one kind: those deleted by key, its kept rows a refill rewrites in
 * place ahead of the change it draws (analysis/theory/refill.ts),
 * its other kept rows updated in place, and its new and re-placed rows inserted, in the order they go: a sequence's
 * members in ascending slot order per owner, a tree's in pre-order.
 */
export interface RelationWrite {
	readonly relation: string
	readonly deletes: ReadonlyTupleSet<MemberKey>
	readonly refills: ReadonlyTupleMap<MemberKey, Row>
	readonly updates: ReadonlyTupleMap<MemberKey, Row>
	readonly inserts: ReadonlyTupleMap<MemberKey, Row>
}

/** One family's owners whose count or ends change, each set by one count statement (draw.ts Recount), by its group key
 * texts. */
export interface OwnerWrite {
	readonly family: FamilyId
	readonly recounts: ReadonlyTupleMap<Owner, Recount>
	/**
	 * The recounts' groups the read found stored: each one's count is a statement of its own, never carried by an insert
	 * row of its owner, which at a stored key is the owner's exact repeat or the key law's refusal. Every other group is
	 * fresh, its owner inserted by the stratum, whose insert row may carry its count and ends.
	 */
	readonly stored: ReadonlyTupleSet<Owner>
}

/**
 * The bytes of a Bind message beside its parameters' texts, as the wire writes it: `statement`, its own fields and its
 * statement's name; `parameter`, the fields each parameter adds.
 */
export interface BindFrame {
	readonly statement: number
	readonly parameter: number
}

/**
 * What one statement carries, one array per column: a Bind message of at most `messageBytes` bytes, as its length
 * word counts it, around `frame`, and array literals of at most `literalUnits` UTF-16 code units each.
 */
export interface Transport {
	readonly messageBytes: number
	readonly literalUnits: number
	readonly frame: BindFrame
}

/** The transport in force over the wire's frame: PostgreSQL's longest message and V8's longest string. */
export const inForce = (frame: BindFrame): Transport => ({
	messageBytes: messageMaxBytes.value,
	literalUnits: maxStringLength.value,
	frame
})

/**
 * One statement of a family write: what it does, the relation it writes or the family whose owners it counts, and the
 * rows its arrays carry.
 */
export type FamilyStatement =
	| {
			readonly kind: "delete"
			readonly relation: string
			readonly rows: NonEmptyReadonlyArray<MemberKey>
	  }
	| {
			readonly kind: "refill"
			readonly relation: string
			readonly rows: NonEmptyReadonlyArray<Row>
	  }
	| {
			readonly kind: "update"
			readonly relation: string
			readonly rows: NonEmptyReadonlyArray<Row>
	  }
	| {
			readonly kind: "count"
			readonly family: FamilyId
			readonly rows: NonEmptyReadonlyArray<CountRow>
	  }
	| {
			readonly kind: "insert"
			readonly relation: string
			readonly rows: NonEmptyReadonlyArray<Row>
	  }

/** The statements of the kinds `K`, in the order they run. */
export type Phase<K extends FamilyStatement["kind"]> = ReadonlyArray<
	Extract<FamilyStatement, { readonly kind: K }>
>

/**
 * A write's statements, phase by phase in the one order they run: its deletes, its refills, its updates in place, its
 * counts, its inserts. The order is the tuple's, so no plan holds another, and `plan.flat()` lists the statements as
 * they are sent.
 */
export type Plan = readonly [
	deletes: Phase<"delete">,
	refills: Phase<"refill">,
	updates: Phase<"update">,
	counts: Phase<"count">,
	inserts: Phase<"insert">
]

/** A statement's rows as their texts, each in its row's layout (draw.ts): what its arrays carry, column by column. */
export const textsOf = (statement: FamilyStatement): ReadonlyArray<ReadonlyArray<ParamText>> => {
	switch (statement.kind) {
		case "delete":
			return statement.rows.map(keyTexts)
		case "refill":
		case "update":
		case "insert":
			return statement.rows.map(rowTexts)
		case "count":
			return statement.rows.map(countTexts)
	}
}

/**
 * Why a row cannot go even alone: its column at `column` would make an array literal longer than `limit` code units,
 * or its Bind message would be `bytes` long, past `limit`.
 */
type Bound =
	| { readonly kind: "literal"; readonly column: number; readonly limit: number }
	| { readonly kind: "message"; readonly bytes: number; readonly limit: number }

/** A row of a `statement` that no statement can carry, even alone: the write is refused before any statement is sent. */
export type Unsendable = Bound & { readonly statement: FamilyStatement["kind"] | "read" }

/** A text's array literal written alone, as the transport writes it: its length in UTF-16 code units and UTF-8 bytes. */
interface Alone {
	readonly units: number
	readonly bytes: number
}

/**
 * The literal of `text` alone, from the transport's own encoder (codec/recordset.ts arrayTexts), or none when it is
 * longer than `limit` code units.
 */
const aloneOf = (text: ParamText, limit: number): Alone | undefined => {
	const literal = arrayTexts("", [""], [[text]], limit)
	if (!literal.ok) {
		return undefined
	}
	const written = defined(literal.value[0], "an input of one column writes one literal")
	return { units: written.length, bytes: utf8Length(written) }
}

/**
 * Rows cut into consecutive statements, each holding the rows after the last one's until the next would not fit, so
 * each is as long as the transport lets it be. The literal of k rows' texts is their literals alone joined, less k − 1:
 * each join drops a closing and an opening brace and adds a comma. A row too large to go alone refuses the cut.
 */
const cut = <R>(
	rows: ReadonlyArray<R>,
	textsOfRow: (row: R) => ReadonlyArray<ParamText>,
	transport: Transport
): Result.Result<ReadonlyArray<NonEmptyReadonlyArray<R>>, Bound> => {
	const statements: Array<NonEmptyReadonlyArray<R>> = []
	let open: Open<R> | undefined
	for (const row of rows) {
		const alone: Array<Alone> = []
		for (const [column, text] of textsOfRow(row).entries()) {
			const one = aloneOf(text, transport.literalUnits)
			if (one === undefined) {
				return Result.err({ kind: "literal", column, limit: transport.literalUnits })
			}
			alone.push(one)
		}
		const bytes = alone.reduce(
			(sum, one) => sum + transport.frame.parameter + one.bytes,
			transport.frame.statement
		)
		if (bytes > transport.messageBytes) {
			return Result.err({ kind: "message", bytes, limit: transport.messageBytes })
		}
		const grown = open === undefined ? undefined : joined(open.size, alone, transport)
		if (open === undefined || grown === undefined) {
			if (open !== undefined) {
				statements.push(open.rows)
			}
			open = { rows: [row], size: { literals: alone.map((one) => one.units), message: bytes } }
		} else {
			open.rows.push(row)
			open = { rows: open.rows, size: grown }
		}
	}
	if (open !== undefined) {
		statements.push(open.rows)
	}
	return Result.ok(statements)
}

/** A statement's size: its arrays' literal lengths, column by column, and its Bind message's length. */
interface Size {
	readonly literals: ReadonlyArray<number>
	readonly message: number
}

/** The statement a cut is filling: its rows, in order, and its size. */
interface Open<R> {
	readonly rows: [R, ...Array<R>]
	readonly size: Size
}

/**
 * The size of a statement of `size` with one more row, whose literals alone are `alone`: each literal grows by the
 * row's literal less one, and the Bind message by those growths. None when the transport cannot carry it.
 */
const joined = (
	size: Size,
	alone: ReadonlyArray<Alone>,
	transport: Transport
): Size | undefined => {
	invariant(alone.length === size.literals.length, "a phase's rows share their columns")
	const literals = size.literals.map(
		(units, column) => units + defined(alone[column], "a row has each column").units - 1
	)
	const message = alone.reduce((sum, one) => sum + one.bytes - 1, size.message)
	return literals.every((units) => units <= transport.literalUnits) &&
		message <= transport.messageBytes
		? { literals, message }
		: undefined
}

/** A row's bound as the bound of a row of a `statement`. */
const unsendable = (statement: Unsendable["statement"], bound: Bound): Unsendable => ({
	...bound,
	statement
})

/** A relation's write's statements: its deletes, its refills, its updates and its inserts. */
export type RelationPlan = readonly [
	deletes: Phase<"delete">,
	refills: Phase<"refill">,
	updates: Phase<"update">,
	inserts: Phase<"insert">
]

/**
 * A member relation's write cut into the statements the transport carries: its deletes by key, its refills, its updates,
 * and its inserts in their order; or the first row no statement can carry, before any statement is planned. A row
 * updated in place is neither deleted nor inserted.
 */
export const planRelation = (
	write: RelationWrite,
	transport: Transport,
	input: ReadonlySet<number>
): Result.Result<RelationPlan, Unsendable> => {
	const { relation } = write
	invariant(
		[...write.updates.keys(), ...write.refills.keys()].every(
			(k) => !write.deletes.has(k) && !write.inserts.has(k)
		) && [...write.refills.keys()].every((k) => !write.updates.has(k)),
		"a row updated in place is neither deleted nor inserted, and is refilled or updated, not both"
	)
	const deletes = cut([...write.deletes], keyTexts, transport)
	if (!deletes.ok) {
		return Result.err(unsendable("delete", deletes.error))
	}
	const refills = cut([...write.refills.values()], rowTexts, transport)
	if (!refills.ok) {
		return Result.err(unsendable("refill", refills.error))
	}
	const updates = cut([...write.updates.values()], rowTexts, transport)
	if (!updates.ok) {
		return Result.err(unsendable("update", updates.error))
	}
	const inserts = cut([...write.inserts.values()], rowTexts, transport)
	if (!inserts.ok) {
		return Result.err(unsendable("insert", inserts.error))
	}
	const planned: RelationPlan = [
		deletes.value.map((rows) => ({ kind: "delete", relation, rows }) as const),
		refills.value.map(
			(rows) => ({ kind: "refill", relation, rows: byPatternInput(rows, rowTexts, input) }) as const
		),
		updates.value.map(
			(rows) => ({ kind: "update", relation, rows: byPatternInput(rows, rowTexts, input) }) as const
		),
		inserts.value.map(
			(rows) => ({ kind: "insert", relation, rows: byPatternInput(rows, rowTexts, input) }) as const
		)
	]
	return Result.ok(planned)
}

/** A family's owners' count statement rows cut into the statements the transport carries. */
export const planOwners = (
	family: FamilyId,
	rows: ReadonlyArray<CountRow>,
	transport: Transport
): Result.Result<Phase<"count">, Unsendable> => {
	const counts = cut(rows, countTexts, transport)
	if (!counts.ok) {
		return Result.err(unsendable("count", counts.error))
	}
	const planned: Phase<"count"> = counts.value.map(
		(chunk) => ({ kind: "count", family, rows: chunk }) as const
	)
	return Result.ok(planned)
}

/** What one read of a family's stored suffixes carries (statements.ts suffixReadSql): member keys and group keys. */
export interface ReadPart {
	readonly keys: ReadonlyArray<MemberKey>
	readonly groups: ReadonlyArray<Owner>
}

/**
 * A family's read cut into the reads the transport carries: its member keys in runs, each run one read whose group
 * arrays are empty, then its groups in runs, each one read whose key arrays are empty; each read's empty arrays counted
 * in its Bind message. The reads' rows together are the one read's: each returns the suffix of every group it touches
 * from its own least slot, so their union, as a set by key, holds every member from the least slot of all. A key or
 * group no read can carry alone refuses the cut.
 */
export const planRead = (
	keys: ReadonlyArray<MemberKey>,
	groups: ReadonlyArray<Owner>,
	widths: { readonly key: number; readonly group: number },
	transport: Transport
): Result.Result<ReadonlyArray<ReadPart>, Unsendable> => {
	/** The transport for reads of one kind: the other kind's empty arrays, `{}` each, in every Bind message. */
	const beside = (empty: number): Transport => ({
		...transport,
		frame: {
			statement: transport.frame.statement + empty * (transport.frame.parameter + 2),
			parameter: transport.frame.parameter
		}
	})
	const byKey = cut(keys, keyTexts, beside(widths.group))
	if (!byKey.ok) {
		return Result.err(unsendable("read", byKey.error))
	}
	const byGroup = cut(groups, (g: Owner): ReadonlyArray<ParamText> => g, beside(widths.key))
	if (!byGroup.ok) {
		return Result.err(unsendable("read", byGroup.error))
	}
	return Result.ok([
		...byKey.value.map((run): ReadPart => ({ keys: run, groups: [] })),
		...byGroup.value.map((run): ReadPart => ({ keys: [], groups: run }))
	])
}
