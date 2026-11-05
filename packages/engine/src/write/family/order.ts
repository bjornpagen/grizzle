/**
 * The statements of a family write, in the one order PostgreSQL admits, cut into statements the transport carries.
 *
 * PostgreSQL never defers a check, nor the unique slot (group, index), and it checks an ordered family's predecessor
 * key at the end of every statement. So every write runs its statements in one order, which also keeps each member's
 * copy of its owner's count right at every statement's end, whether the copy's foreign key is deferred or not:
 *
 * - deletes first, of every slot an owner vacates;
 * - then one count update for each owner whose count changes, which the copy's foreign key cascades into every member
 *   the deletes left;
 * - then inserts, each owner's members in ascending slot order, every one copying its owner's new count.
 *
 * Updating a count that falls before its deletes would cascade it into the member at the old last slot, which the
 * check refuses. Inserting before the deletes would put a member in a slot another still holds. A count updated more
 * than once would pass through counts no family has, which the owner's own checks on its count may refuse, and each
 * update rewrites the copy on every member. So a plan updates each count once, and an append is one update however
 * many members it adds.
 *
 * Each phase is cut into consecutive statements, each holding as many rows as fit: its arrays' literals within V8's
 * longest string, and its Bind message within PostgreSQL's longest message. A family larger than one statement goes as
 * consecutive inserts after its one count update. Each insert keeps every slot below its owner's new count and none
 * twice, and an ordered family's members go in ascending slot order, so every insert's first member of an owner finds
 * its predecessor already written. Only the owner's last slot and a counted family's closure wait for commit.
 */
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { defined, invariant } from "#compiler/core/invariant.ts"
import { maxStringLength, messageMaxBytes } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	type Member,
	type Owner,
	type Placed,
	placed,
	placedTexts,
	type Recount,
	recountTexts,
	type Vacated,
	vacatedTexts
} from "#compiler/write/family/draw.ts"

/**
 * One owner's change of an ordered family, as a rewrite of its tail. Its first `kept` members stay, the `dropped`
 * members after them go, and `suffix` follows the kept ones, so the family it leaves is the kept members then the
 * suffix, counted by their number. `kept + dropped` is the count the family has.
 *
 * Every form of change is a rewrite:
 * - an append keeps every member and drops none;
 * - a put keeps none and drops every one;
 * - an insert or a removal at a slot keeps the members before it and writes the rest again, one slot along.
 */
export interface Rewrite {
	readonly owner: Owner
	readonly kept: number
	readonly dropped: number
	readonly suffix: ReadonlyArray<Member>
}

/** A kept slot of a counted family given a new member, as swap-with-last moves the last member into a removed one's slot. */
export interface Refill {
	readonly slot: number
	readonly member: Member
}

/**
 * One owner's change of a counted family: a rewrite whose kept slots may also take new members, in ascending slot
 * order. Removing the member at slot i of n by swap-with-last keeps n − 1 members, drops the last, and refills slot i
 * with it.
 *
 * Only a counted family has refills. A refilled slot is empty between its delete and its insert, which leaves the
 * member at the next slot without its predecessor, and only a counted family's closure waits for commit.
 */
export interface CountedRewrite extends Rewrite {
	readonly refills: ReadonlyArray<Refill>
}

/** One family relation's write: its changes, one for each owner it changes, by the kind of family it is. */
export type FamilyWrite =
	| { readonly kind: "ordered"; readonly rewrites: ReadonlyArray<Rewrite> }
	| { readonly kind: "counted"; readonly rewrites: ReadonlyArray<CountedRewrite> }

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

/** One statement of a family write: what it does, and the rows its arrays carry. */
export type FamilyStatement =
	| { readonly kind: "delete"; readonly rows: NonEmptyReadonlyArray<Vacated> }
	| { readonly kind: "count"; readonly rows: NonEmptyReadonlyArray<Recount> }
	| { readonly kind: "insert"; readonly rows: NonEmptyReadonlyArray<Placed> }

/** The statements of one kind, in the order they run. */
type Phase<K extends FamilyStatement["kind"]> = ReadonlyArray<
	Extract<FamilyStatement, { readonly kind: K }>
>

/**
 * A family write's statements, phase by phase in the one order they run: its deletes, then its counts, then its
 * inserts. The order is the tuple's, so no plan holds another, and `plan.flat()` lists the statements as they are
 * sent.
 */
export type Plan = readonly [
	deletes: Phase<"delete">,
	counts: Phase<"count">,
	inserts: Phase<"insert">
]

/** A statement's rows as their texts, each in its row's layout (draw.ts): what its arrays carry, column by column. */
export const textsOf = (statement: FamilyStatement): ReadonlyArray<ReadonlyArray<string>> => {
	switch (statement.kind) {
		case "delete":
			return statement.rows.map(vacatedTexts)
		case "count":
			return statement.rows.map(recountTexts)
		case "insert":
			return statement.rows.map(placedTexts)
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

/**
 * One owner's part of a write: the count its family has and the count it leaves, the runs of slots it vacates and the
 * members it places, in ascending slot order.
 */
interface Part {
	readonly owner: Owner
	readonly before: number
	readonly after: number
	readonly vacated: ReadonlyArray<Vacated>
	readonly placed: ReadonlyArray<Placed>
}

/**
 * The part of one owner's rewrite: each refilled slot vacated and placed again, and the dropped tail vacated and the
 * suffix placed after the kept members, every placed member copying the count the rewrite leaves.
 */
const partOf = (rewrite: Rewrite, refills: ReadonlyArray<Refill>): Part => {
	const { owner, kept, dropped, suffix } = rewrite
	let below = -1
	for (const refill of refills) {
		invariant(
			below < refill.slot && refill.slot < kept,
			"a counted rewrite refills distinct kept slots, in ascending order"
		)
		below = refill.slot
	}
	const after = kept + suffix.length
	return {
		owner,
		before: kept + dropped,
		after,
		vacated: [
			...refills.map((refill) => ({ owner, from: refill.slot, to: refill.slot + 1 })),
			{ owner, from: kept, to: kept + dropped }
		].filter((run) => run.from < run.to),
		placed: [
			...refills.map((refill) => ({ owner, at: refill.slot, copy: after, member: refill.member })),
			...placed(owner, kept, after, suffix)
		]
	}
}

/** Each rewrite's part, an ordered family's refilling no slot. */
const rewritten = (write: FamilyWrite): ReadonlyArray<Part> => {
	switch (write.kind) {
		case "ordered":
			return write.rewrites.map((rewrite) => partOf(rewrite, []))
		case "counted":
			return write.rewrites.map((rewrite) => partOf(rewrite, rewrite.refills))
	}
}

/** Each owner's part of a write, which changes each owner once. */
const partsOf = (write: FamilyWrite): ReadonlyArray<Part> => {
	const parts = rewritten(write)
	const owners = new Set<string>()
	for (const part of parts) {
		const owner = JSON.stringify(part.owner)
		invariant(!owners.has(owner), "a family write changes each owner once")
		owners.add(owner)
	}
	return parts
}

/** The count update of an owner's part: none when its count stays, so a write updates each count at most once. */
const recountOf = (part: Part): readonly [] | readonly [Recount] =>
	part.after === part.before ? [] : [{ owner: part.owner, count: part.after }]

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

/**
 * A family write's plan: each owner's vacated runs, then the count of each owner whose count changes, then each
 * owner's placed members, each phase cut into the statements the transport carries; or the first row no statement can
 * carry, before any statement is planned.
 */
export const plan = (write: FamilyWrite, transport: Transport): Result.Result<Plan, Unsendable> => {
	const parts = partsOf(write)
	const deletes = cut(
		parts.flatMap((part) => part.vacated),
		vacatedTexts,
		transport
	)
	if (!deletes.ok) {
		return Result.err(unsendable("delete", deletes.error))
	}
	const counts = cut(parts.flatMap(recountOf), recountTexts, transport)
	if (!counts.ok) {
		return Result.err(unsendable("count", counts.error))
	}
	const inserts = cut(
		parts.flatMap((part) => part.placed),
		placedTexts,
		transport
	)
	if (!inserts.ok) {
		return Result.err(unsendable("insert", inserts.error))
	}
	const planned: Plan = [
		deletes.value.map((rows) => ({ kind: "delete", rows }) as const),
		counts.value.map((rows) => ({ kind: "count", rows }) as const),
		inserts.value.map((rows) => ({ kind: "insert", rows }) as const)
	]
	return Result.ok(planned)
}
