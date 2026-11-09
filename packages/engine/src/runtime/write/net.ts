import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import * as Order from "#compiler/core/order.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { digestOf } from "#compiler/scalar/values/bytes.ts"
import { admittedText, type FactIdentity } from "#compiler/scalar/values/identity.ts"

/** Strings by code point. */
const codePointOrder = (a: string, b: string) => {
	const order = compareCodePoints(a, b)
	return order < 0 ? -1 : order > 0 ? 1 : 0
}

type Fact = { readonly [field: string]: unknown }

export type AddedTag = "insert" | "put"
export type RemovedTag = "delete" | "displaced"

interface Tagged<T> {
	readonly fact: Fact
	readonly tag: T
}

/** One stratum's actual change to one relation, by fact identity. */
export interface StratumChange {
	readonly added: ReadonlyTupleMap<FactIdentity, Tagged<AddedTag>>
	readonly removed: ReadonlyTupleMap<FactIdentity, Tagged<RemovedTag>>
}

interface Counts {
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

export interface NettedRelation {
	/** delta.added(R) and delta.removed(R), by fact identity, each fact with the tag of the change that survived. */
	readonly added: ReadonlyTupleMap<FactIdentity, Tagged<AddedTag>>
	readonly removed: ReadonlyTupleMap<FactIdentity, Tagged<RemovedTag>>
	readonly counts: Counts
}

/** One returned row of a stratum's statements: what it made present or absent, and why. */
export type ChangeRow =
	| {
			readonly side: "added"
			readonly identity: FactIdentity
			readonly fact: Fact
			readonly tag: AddedTag
	  }
	| {
			readonly side: "removed"
			readonly identity: FactIdentity
			readonly fact: Fact
			readonly tag: RemovedTag
	  }

/** A stratum's change to one relation from its statements' returned rows, by set difference: added is S' \ S and
 * removed is S \ S', with S' = (S \ D) ∪ A. A fact the rows both remove and add, identical in every field, is in S and
 * S' alike (or in neither), so it is in neither side: a generated addition whose identity sequence lags the stored
 * values (a direct writer's explicit values) can draw the very key the stratum's delete freed, and the fact set is then
 * unchanged for it, as psql leaves it after the DELETE and the INSERT. A fact both an insert and a put requested is
 * counted once, under put; a removal a delete member requested is a delete even where a put also displaced it. */
export const stratumChange = (rows: Iterable<ChangeRow>): StratumChange => {
	const added = new TupleMap<FactIdentity, Tagged<AddedTag>>()
	const removed = new TupleMap<FactIdentity, Tagged<RemovedTag>>()
	for (const row of rows) {
		if (row.side === "added") {
			const seen = added.get(row.identity)
			if (seen === undefined || (seen.tag === "insert" && row.tag === "put")) {
				added.set(row.identity, { fact: row.fact, tag: row.tag })
			}
		} else {
			const seen = removed.get(row.identity)
			if (seen === undefined || (seen.tag === "displaced" && row.tag === "delete")) {
				removed.set(row.identity, { fact: row.fact, tag: row.tag })
			}
		}
	}
	for (const identity of added.keys()) {
		if (removed.delete(identity)) {
			added.delete(identity)
		}
	}
	return { added, removed }
}

const countOf = (
	added: ReadonlyTupleMap<FactIdentity, Tagged<AddedTag>>,
	removed: ReadonlyTupleMap<FactIdentity, Tagged<RemovedTag>>
): Counts => {
	let insert = 0n
	let put = 0n
	let deleted = 0n
	for (const a of added.values()) {
		if (a.tag === "put") {
			put += 1n
		} else {
			insert += 1n
		}
	}
	for (const r of removed.values()) {
		if (r.tag === "delete") {
			deleted += 1n
		}
	}
	return { added: insert, deleted, put }
}

/** The strata's changes to one relation, in stratum order, netted.
 *
 * Deltas and counts netted across strata.
 *
 * The realization reports, for each stratum and each relation it writes, what that stratum's statements actually
 * changed, from their RETURNING channels: the facts it made present, each tagged by the kind of member that requested
 * it, and the facts it made absent, each tagged delete when a delete member of the stratum requested it and displaced
 * when only a put's implied deletion removed it. This module nets those per-stratum changes into the
 * outcome:
 *
 * - delta.added(R) and delta.removed(R): walking the strata in order, a removal cancels a pending addition of the same
 *   fact and an addition cancels a pending removal, so delta.added(R) is R in the final state minus R in the initial
 *   state and delta.removed(R) the reverse. A fact one stratum adds and a later one removes is in
 *   neither, and so is one removed and later restored; a fact replaced by put is its old fact removed and its new one
 *   added.
 * - counts: the same walk over the tagged changes, each surviving change counted under its tag: added counts surviving
 *   insert additions, generated additions included, put counts surviving put additions, and deleted counts surviving
 *   delete removals; a displaced occupant is never counted. Within one stratum, a fact both an insert
 *   and a put requested counts once, under put (stratumChange). Across strata each stratum's change is attributed to
 *   that stratum's own members and the attributions are netted, as the realization's per-stratum RETURNING carriers
 *   give them and as a brute-force oracle counts them. So the counts are the same whichever statement the compiler chose, but follow the
 *   strata: sequence(insert(R, [y]), put(R, [y])) over a state without y counts y under added, since the later put is
 *   an exact repeat there. These are the rules of one add-wins transition, applied per stratum and netted across
 *   strata.
 * - the outcome kind: accepted when some count is nonzero, no-change otherwise. It follows the counts
 *   alone, so a sequence whose only net effect is a displaced occupant is no-change.
 *
 * Facts are compared by fact identity (`identity.ts`): equal exactly when PostgreSQL's equality holds on
 * every field. relationIdentity gives the identity function of a relation's heading. */
export const netStrata = (steps: ReadonlyArray<StratumChange>): NettedRelation => {
	const added = new TupleMap<FactIdentity, Tagged<AddedTag>>()
	const removed = new TupleMap<FactIdentity, Tagged<RemovedTag>>()
	for (const step of steps) {
		for (const [identity, change] of step.removed) {
			if (added.has(identity)) {
				added.delete(identity)
			} else {
				removed.set(identity, change)
			}
		}
		for (const [identity, change] of step.added) {
			if (removed.has(identity)) {
				removed.delete(identity)
			} else {
				added.set(identity, change)
			}
		}
	}
	return { added, removed, counts: countOf(added, removed) }
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
	readonly relation: string
}

/** The changes the strata made to one relation, in stratum order, of the strata that changed it. */
export const relationChanges = (
	strata: ReadonlyArray<ReadonlyMap<string, StratumChange>>,
	relation: string
): ReadonlyArray<StratumChange> =>
	strata.flatMap((s) => {
		const change = s.get(relation)
		return change === undefined ? [] : [change]
	})

/** The outcome's counts: one entry per relation the ChangeSet writes, in code point order of the names,
 * each netted over the strata in order. A written relation no stratum changed counts zero. */
export const outcomeCounts = (
	written: ReadonlyArray<string>,
	strata: ReadonlyArray<ReadonlyMap<string, StratumChange>>
): ReadonlyArray<RelationCounts> =>
	[...new Set(written)].toSorted(codePointOrder).map((relation) => ({
		relation,
		...netStrata(relationChanges(strata, relation)).counts
	}))

/**
 * The identity function of a heading's facts as a write statement's rows convert them: each field's canonical text in
 * field-name order, as factIdentity gives it (`identity.ts`), a bytes field's the digest the statement returned of it
 * (codec/row.ts tupleConverter), which is its canonical text. The rows are PostgreSQL's output, converted by the
 * fields' own codecs under the installation's codes, so nothing is admitted again. Only returned digests meet here, so
 * two facts of one identity whose bytes differ would be a SHA-256 collision between rows PostgreSQL wrote.
 */
export const relationIdentity = (
	heading: Heading,
	codes: Codebook
): ((fact: Fact) => FactIdentity) => {
	const fields = heading
		.map((column) => ({ name: column.name, spec: carrierSpecOf(column.type, codes) }))
		.toSorted(Order.mapInput(codePointOrder, (field: { readonly name: string }) => field.name))
	return (fact) =>
		Object.freeze(
			fields.map((field) =>
				field.spec.carrier === "bytes"
					? digestOf(fact[field.name])
					: admittedText(field.spec, fact[field.name])
			)
		)
}
