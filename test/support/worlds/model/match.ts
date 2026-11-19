import { Array as Arr, Record as Rec } from "effect"
import { sameValue } from "#test/support/laws/model.ts"
import { factKeySet } from "#test/support/worlds/model/host.ts"
import type { HostFact } from "#test/support/worlds/model/types.ts"

/** Whether a model fact is a fact the real system showed: the same fields, each at the same value. */
export const factMeets = (expected: HostFact, observed: HostFact): boolean => {
	const fields = Rec.keys(expected)
	return (
		fields.length === Rec.keys(observed).length &&
		Arr.every(fields, (field) => sameValue(expected[field], observed[field]))
	)
}

/**
 * Whether each item meets a candidate of its own, items in order and candidates tried in order: a candidate an item
 * meets is consumed, so no two items meet one candidate, and the items meet as many candidates as they are.
 */
export const everyMeets = <A, B>(
	items: ReadonlyArray<A>,
	candidates: ReadonlyArray<B>,
	meet: (item: A, candidate: B) => boolean
): boolean => {
	const [item, ...more] = items
	return (
		item === undefined ||
		Arr.some(
			[...candidates.entries()],
			([at, candidate]) =>
				meet(item, candidate) && everyMeets(more, candidates.toSpliced(at, 1), meet)
		)
	)
}

/** Whether a list of facts the real system showed holds no fact twice, each fact by every field and its value. */
const distinctFacts = (facts: ReadonlyArray<HostFact>): boolean =>
	factKeySet(facts).size === facts.length

/**
 * Whether two lists of facts hold the same facts as keyed sets: the real system showed each fact once, and each model
 * fact meets a fact it showed of its own, as many as it showed. A delivery that repeats a fact is no set, so it agrees
 * with no model, whatever the model holds.
 */
export const sameFacts = (
	expected: ReadonlyArray<HostFact>,
	observed: ReadonlyArray<HostFact>
): boolean =>
	expected.length === observed.length &&
	distinctFacts(observed) &&
	everyMeets(expected, observed, factMeets)
