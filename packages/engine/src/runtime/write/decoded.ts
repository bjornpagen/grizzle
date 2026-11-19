/**
 * The reads of the arrays factsDecoder admitted (program/decode.ts), each array's by the array itself: every row of it
 * read as the write reads a fact of its relation, by the write's own readers, which a write of that array takes instead
 * of reading its rows again. A caller's value is read once, and what the read returns is all of the value anything
 * after it sees (core/host.ts): decode's read of a row is that one read, so a write takes it, and a ChangeSet that takes
 * the array keeps the array as it is (write/changeset/value.ts), its rows read by no write again.
 *
 * Each array's reads are kept with the headings they were read under, and a write takes them only where its own
 * headings are equal (scalar/values/identity.ts samePlan): codes are an installation's, so a closed id is read alike
 * only under the same roster codes. A write under other headings reads the rows as it reads any. Decode freezes the
 * array and its rows, so neither holds anything after decode but what decode read.
 *
 * The reads are shared by every write that takes them, so a read holds only immutable values but those its write takes
 * again (identity.ts readAgain): a bytes value, the caller's array, checked again where the write takes it, and a set's
 * or a vector's copy, copied again, so no write hands out the copy a later write would take.
 *
 * The registry is keyed by the array as a handle: its identity is what decode admitted, so an equal array built
 * elsewhere is no decoded array, and is read as any is.
 */

import { isList } from "#compiler/core/record.ts"
import { type FamilyId, familyKey } from "#compiler/ir/law.ts"
import type { NestedReading, NestingLevels } from "#compiler/runtime/write/addition.ts"
import { type HeadingPlan, type ReadFact, samePlan } from "#compiler/scalar/values/identity.ts"

/**
 * A decoded array's reads: a flat relation's rows, each one fact read under `plan`, in the array's order; or a nested
 * relation's, each split and its levels read (runtime/write/addition.ts NestedReading), its levels' facts under `plans`.
 */
export type DecodedInput =
	| {
			readonly kind: "flat"
			readonly plan: HeadingPlan
			readonly reads: ReadonlyArray<ReadFact>
	  }
	| {
			readonly kind: "nested"
			readonly plans: NestingLevels<HeadingPlan>
			readonly readings: ReadonlyArray<NestedReading<unknown>>
	  }

/** Each decoded array's reads, by the array. */
const decoded = new WeakMap<object, DecodedInput>()

/** Records `rows`' reads: what decode read of the array it admitted, frozen with its rows. */
export const recordDecoded = (rows: ReadonlyArray<unknown>, input: DecodedInput): void => {
	decoded.set(rows, input)
}

/** Whether `rows` is an array decode admitted, frozen with its rows, whose reads it recorded. */
export const isDecoded = (rows: ReadonlyArray<unknown>): boolean => decoded.has(rows)

/** The reads recorded of `facts`, where it is an array decode admitted. */
const decodedOf = (facts: Iterable<unknown>): DecodedInput | undefined =>
	isList(facts) ? decoded.get(facts) : undefined

/** The reads of a flat relation's rows `facts`, where it is a decoded array whose facts were read under `plan`. */
export const keptReads = (
	facts: Iterable<unknown>,
	plan: HeadingPlan
): ReadonlyArray<ReadFact> | undefined => {
	const input = decodedOf(facts)
	return input?.kind === "flat" && samePlan(input.plan, plan) ? input.reads : undefined
}

/**
 * The readings of a nested relation's rows `facts`, where it is a decoded array whose levels were read under headings
 * equal to `levels`' (their normalizers' plans), with `levels` re-keyed by the families decode's additions name: each of
 * decode's families matched to one of `levels` by its key (ir/law.ts familyKey), once for the input, so a reading's
 * additions stand at the write's levels and no row spells a family's key.
 */
export const keptReadings = <L extends { readonly normalize: { readonly plan: HeadingPlan } }>(
	facts: Iterable<unknown>,
	levels: NestingLevels<L>
):
	| {
			readonly readings: ReadonlyArray<NestedReading<unknown>>
			readonly levels: NestingLevels<L>
	  }
	| undefined => {
	const input = decodedOf(facts)
	if (
		input?.kind !== "nested" ||
		input.plans.members.size !== levels.members.size ||
		!samePlan(input.plans.own, levels.own.normalize.plan)
	) {
		return undefined
	}
	const byKey = new Map([...levels.members].map(([id, level]) => [familyKey(id), level] as const))
	const members = new Map<FamilyId, L>()
	for (const [id, plan] of input.plans.members) {
		const level = byKey.get(familyKey(id))
		if (level === undefined || !samePlan(plan, level.normalize.plan)) {
			return undefined
		}
		members.set(id, level)
	}
	return { readings: input.readings, levels: { own: levels.own, members } }
}
