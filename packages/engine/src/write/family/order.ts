/**
 * The statements of a family write, in the one order PostgreSQL admits, cut into statements the transport carries
 * (rows-first.md §2).
 *
 * PostgreSQL never defers a check nor a unique slot (group, index), and checks a sequence's predecessor key and every
 * owner axis at the end of each statement; a counted family's closure and every family's last axis wait for commit. So
 * a write's statements go in one order:
 *
 * - deletes first: every removed member, every member a sequence's suffix rewrite re-places, and every member a move
 *   between groups re-places, by key, members before their owners (deepest relation first), and a tree rewritten whole
 *   by its root field;
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
 * Updating a count before its deletes and moves would cascade it into a member at or beyond the new count, which the
 * bound refuses: the shrink-order cascade failure. A count updated twice would pass through counts no family has. So
 * a plan updates each count once, and an append is one update however many members it adds.
 *
 * Each phase is cut into consecutive statements, each holding as many rows as fit: its arrays' literals within V8's
 * longest string, and its Bind message within PostgreSQL's longest message. A family larger than one statement goes as
 * consecutive inserts after its one count update, in ascending slot order.
 */
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { defined, invariant } from "#compiler/core/invariant.ts"
import { maxStringLength, messageMaxBytes } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import {
	keyTexts,
	type MemberKey,
	type Owner,
	type Recount,
	recountTexts,
	type Row,
	rowTexts
} from "#compiler/write/family/draw.ts"

/**
 * One member relation's rows of a write: those deleted by key, its trees deleted whole by their root fields' texts, its
 * kept rows updated in place, and its new and re-placed rows inserted, in the order they go: a sequence's members in
 * ascending slot order per owner, a tree's in pre-order.
 */
export interface RelationWrite {
	readonly relation: string
	readonly deletes: ReadonlyArray<MemberKey>
	readonly trees: ReadonlyArray<Owner>
	readonly updates: ReadonlyArray<Row>
	readonly inserts: ReadonlyArray<Row>
}

/** One family's owners whose count or ends change, each set by one count statement (draw.ts Recount). */
export interface OwnerWrite {
	readonly family: FamilyId
	readonly recounts: ReadonlyArray<Recount>
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
			readonly kind: "deleteTree"
			readonly relation: string
			readonly rows: NonEmptyReadonlyArray<Owner>
	  }
	| {
			readonly kind: "update"
			readonly relation: string
			readonly rows: NonEmptyReadonlyArray<Row>
	  }
	| {
			readonly kind: "count"
			readonly family: FamilyId
			readonly rows: NonEmptyReadonlyArray<Recount>
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
 * A write's statements, phase by phase in the one order they run: its deletes, its updates in place, its counts, its
 * inserts. The order is the tuple's, so no plan holds another, and `plan.flat()` lists the statements as they are sent.
 */
export type Plan = readonly [
	deletes: Phase<"delete" | "deleteTree">,
	updates: Phase<"update">,
	counts: Phase<"count">,
	inserts: Phase<"insert">
]

/** A statement's rows as their texts, each in its row's layout (draw.ts): what its arrays carry, column by column. */
export const textsOf = (statement: FamilyStatement): ReadonlyArray<ReadonlyArray<string>> => {
	switch (statement.kind) {
		case "delete":
			return statement.rows.map(keyTexts)
		case "deleteTree":
			return statement.rows
		case "update":
		case "insert":
			return statement.rows.map(rowTexts)
		case "count":
			return statement.rows.map(recountTexts)
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
export type Unsendable = Bound & { readonly statement: FamilyStatement["kind"] }

/** A text's array literal written alone, as the transport writes it: its length in UTF-16 code units and UTF-8 bytes. */
interface Alone {
	readonly units: number
	readonly bytes: number
}

/**
 * The literal of `text` alone, from the transport's own encoder (codec/recordset.ts arrayTexts), or none when it is
 * longer than `limit` code units.
 */
const aloneOf = (text: string, limit: number): Alone | undefined => {
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
	textsOfRow: (row: R) => ReadonlyArray<string>,
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
const unsendable = (statement: FamilyStatement["kind"], bound: Bound): Unsendable => ({
	...bound,
	statement
})

/** Each of `keys` once. */
const once = (keys: ReadonlyArray<ReadonlyArray<string>>, what: string): void => {
	const seen = new Set<string>()
	for (const key of keys) {
		const text = JSON.stringify(key)
		invariant(!seen.has(text), what)
		seen.add(text)
	}
}

/** A relation's write's statements: its deletes, its updates and its inserts. */
export type RelationPlan = readonly [
	deletes: Phase<"delete" | "deleteTree">,
	updates: Phase<"update">,
	inserts: Phase<"insert">
]

/**
 * A member relation's write cut into the statements the transport carries: its deletes by key, then its trees by root
 * field, its updates, and its inserts in their order; or the first row no statement can carry, before any statement is
 * planned. A row is deleted, updated and inserted at most once each, and updated only if neither deleted nor inserted.
 */
export const planRelation = (
	write: RelationWrite,
	transport: Transport
): Result.Result<RelationPlan, Unsendable> => {
	const { relation } = write
	once(write.deletes, "a write deletes each row once")
	once(
		write.inserts.map((r) => r.key),
		"a write inserts each row once"
	)
	once(
		write.updates.map((r) => r.key),
		"a write updates each row once"
	)
	const touched = new Set([
		...write.inserts.map((r) => JSON.stringify(r.key)),
		...write.deletes.map((k) => JSON.stringify(k))
	])
	invariant(
		write.updates.every((r) => !touched.has(JSON.stringify(r.key))),
		"a row updated in place is neither deleted nor inserted"
	)
	const deletes = cut(write.deletes, keyTexts, transport)
	if (!deletes.ok) {
		return Result.err(unsendable("delete", deletes.error))
	}
	const trees = cut(write.trees, (t: Owner): ReadonlyArray<string> => t, transport)
	if (!trees.ok) {
		return Result.err(unsendable("deleteTree", trees.error))
	}
	const updates = cut(write.updates, rowTexts, transport)
	if (!updates.ok) {
		return Result.err(unsendable("update", updates.error))
	}
	const inserts = cut(write.inserts, rowTexts, transport)
	if (!inserts.ok) {
		return Result.err(unsendable("insert", inserts.error))
	}
	const planned: RelationPlan = [
		[
			...deletes.value.map((rows) => ({ kind: "delete", relation, rows }) as const),
			...trees.value.map((rows) => ({ kind: "deleteTree", relation, rows }) as const)
		],
		updates.value.map((rows) => ({ kind: "update", relation, rows }) as const),
		inserts.value.map((rows) => ({ kind: "insert", relation, rows }) as const)
	]
	return Result.ok(planned)
}

/** A family's owners' counts cut into the statements the transport carries, each owner counted once. */
export const planOwners = (
	write: OwnerWrite,
	transport: Transport
): Result.Result<Phase<"count">, Unsendable> => {
	once(
		write.recounts.map((r) => r.owner),
		"a write counts each owner once"
	)
	const counts = cut(write.recounts, recountTexts, transport)
	if (!counts.ok) {
		return Result.err(unsendable("count", counts.error))
	}
	const planned: Phase<"count"> = counts.value.map(
		(rows) => ({ kind: "count", family: write.family, rows }) as const
	)
	return Result.ok(planned)
}
