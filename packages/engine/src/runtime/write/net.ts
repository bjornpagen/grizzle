import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import * as Order from "#compiler/core/order.ts"
import { type TextsKey, textsKey } from "#compiler/core/text.ts"
import { addInto, type Side, type Weighted, weightOf, type ZSet } from "#compiler/core/zset.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { digestOf } from "#compiler/scalar/values/bytes.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"

/** Strings by code point. */
const codePointOrder = (a: string, b: string) => {
	const order = compareCodePoints(a, b)
	return order < 0 ? -1 : order > 0 ? 1 : 0
}

type Fact = { readonly [field: string]: unknown }

export type AddedTag = "insert" | "put"
export type RemovedTag = "delete" | "displaced"

/** Why a fact changed: the kind of member that made it present, or absent. */
export type Tag = AddedTag | RemovedTag

/** Each tag with the side of the change it tags, and its rank: a fact several rows of one stratum change on one side
 * stands under the tag of highest rank, so a fact both an insert and a put requested under put, and a removal a delete
 * member requested under delete even where a put also displaced it. */
const tags = {
	insert: { side: "added", rank: 0 },
	put: { side: "added", rank: 1 },
	displaced: { side: "removed", rank: 0 },
	delete: { side: "removed", rank: 1 }
} as const satisfies Record<Tag, { readonly side: Side; readonly rank: number }>

/** A change to one relation as a Z-set (core/zset.ts): its facts by identity, each with the tag of the change it
 * stands by. */
export type RelationChange = ZSet<TextsKey, Tag>

interface Counts {
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

/** One returned row of a stratum's statements: a fact it made present or absent, and why. */
export interface ChangeRow {
	readonly identity: TextsKey
	readonly tag: Tag
}

/** A stratum's change to one relation from its statements' returned rows: the facts they made present less the facts
 * they made absent, S' - S, with S' = (S \ D) ∪ A. A and D are sets, so a fact several rows of one side return stands on
 * that side once, under its tag of highest rank (`tags`). A fact the rows both remove and add, identical in every field,
 * is in S and S' alike (or in neither), so its weights sum to 0 and it is in neither side: the fact set is unchanged
 * for it, as psql leaves it after the DELETE and the INSERT. */
export const stratumChange = (rows: Iterable<ChangeRow>): Map<TextsKey, Weighted<Tag>> => {
	const sides = {
		added: new Map<TextsKey, Weighted<Tag>>(),
		removed: new Map<TextsKey, Weighted<Tag>>()
	}
	for (const row of rows) {
		const { side, rank } = tags[row.tag]
		const seen = sides[side].get(row.identity)
		if (seen === undefined || tags[seen.value].rank < rank) {
			sides[side].set(row.identity, { weight: weightOf[side], value: row.tag })
		}
	}
	return addInto(sides.added, sides.removed)
}

/** No stratum's change: the empty Z-set, which a relation no stratum changed holds. */
const noChange: RelationChange = new Map()

/** One relation's change over the strata that changed it, in stratum order: each stratum's change (`stratumChange`)
 * summed into the sum of those before it (core/zset.ts addInto). */
export const relationChange = (strata: ReadonlyArray<Iterable<ChangeRow>>): RelationChange => {
	const [first, ...later] = strata.map((rows) => stratumChange(rows))
	return first === undefined ? noChange : later.reduce(addInto, first)
}

/** Each standing fact of a netted change counted under its tag: added counts insert additions, generated additions
 * included, put counts put additions, and deleted counts delete removals; a displaced occupant is never counted. */
const countOf = (change: RelationChange): Counts => {
	let added = 0n
	let put = 0n
	let deleted = 0n
	for (const { value } of change.values()) {
		switch (value) {
			case "insert":
				added += 1n
				break
			case "put":
				put += 1n
				break
			case "delete":
				deleted += 1n
				break
			case "displaced":
				break
		}
	}
	return { added, deleted, put }
}

/** accepted when some relation's count is nonzero, no-change otherwise. */
export const outcomeKind = (counts: Iterable<Counts>): "accepted" | "no-change" => {
	for (const c of counts) {
		if (c.added !== 0n || c.deleted !== 0n || c.put !== 0n) {
			return "accepted"
		}
	}
	return "no-change"
}

export interface RelationCounts extends Counts {
	readonly relation: StoredRelationName
}

/**
 * The outcome's counts: one entry per relation the ChangeSet writes, in code point order of the names, each the sum of
 * the strata's changes to it in stratum order (`relationChange`), its standing facts counted under their tags. A
 * written relation no stratum changed counts zero.
 *
 * The realization reports, for each stratum and each relation it writes, the rows its statements returned from their
 * RETURNING channels, what that stratum actually changed (`stratumChange`). The strata's changes sum to delta.added(R)
 * and delta.removed(R), R in the final state less R in the initial one: a fact one stratum adds and a later one removes
 * is in neither, and so is one removed and later restored; a fact replaced by put is its old fact removed and its new
 * one added. Each stratum's
 * change is attributed to that stratum's own members, so a standing fact counts under the tag of the stratum that
 * changed it last, as the realization's per-stratum RETURNING carriers give it and as a brute-force oracle counts it.
 * So the counts are the same whichever statement the compiler chose, but follow the strata: sequence(insert(R, [y]),
 * put(R, [y])) over a state without y counts y under added, since the later put is an exact repeat there. The outcome
 * kind follows the counts alone (`outcomeKind`), so a sequence whose only net effect is a displaced occupant is
 * no-change.
 *
 * Facts are compared by fact identity (`identity.ts`): equal exactly when PostgreSQL's equality holds on every field.
 * relationIdentity gives the identity function of a relation's heading.
 */
export const outcomeCounts = (
	written: ReadonlyArray<StoredRelationName>,
	strata: ReadonlyArray<ReadonlyMap<StoredRelationName, ReadonlyArray<ChangeRow>>>
): ReadonlyArray<RelationCounts> =>
	[...new Set(written)].toSorted(codePointOrder).map((relation) => ({
		relation,
		...countOf(
			relationChange(
				strata.flatMap((s) => {
					const rows = s.get(relation)
					return rows === undefined ? [] : [rows]
				})
			)
		)
	}))

/**
 * The identity function of a heading's facts as a write statement's rows convert them: each field's canonical text in
 * field-name order, keyed (core/text.ts TextsKey), as factIdentity gives it (`identity.ts`), a bytes field's the digest
 * the statement returned of it
 * (codec/row.ts tupleConverter), which is its canonical text. The rows are PostgreSQL's output, converted by the
 * fields' own codecs under the installation's codes, so nothing is admitted again. Only returned digests meet here, so
 * two facts of one identity whose bytes differ would be a SHA-256 collision between rows PostgreSQL wrote.
 */
export const relationIdentity = (heading: Heading, codes: Codebook): ((fact: Fact) => TextsKey) => {
	const fields = heading
		.map((column) => ({ name: column.name, spec: carrierSpecOf(column.type, codes) }))
		.toSorted(Order.mapInput(codePointOrder, (field: { readonly name: string }) => field.name))
	return (fact) =>
		textsKey(
			fields.map((field) =>
				field.spec.carrier === "bytes"
					? digestOf(fact[field.name])
					: admittedText(field.spec, fact[field.name])
			)
		)
}
