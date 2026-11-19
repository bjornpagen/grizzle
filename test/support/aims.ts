import type { Reached } from "@bjornpagen/testing/features"
import { type Gen, oneOf, type Steered, steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"

/**
 * A steered space with aims, as gen's `aimed` is a plain space's: while a situation `aims` names is pending, a case is
 * one of the pending situations' aims, drawn among them, so no aim that seldom reaches its situation holds back the
 * others; otherwise `space`'s case under the same steering. The generator draws it, so it is the case the search runs,
 * prints and keeps.
 */
export const aimedSteered = <A, const F extends string>(
	space: Steered<A, F>,
	aims: ReadonlyArray<readonly [Reached<F>, Gen<A>]>
): Steered<A, F> =>
	steered((steering) => {
		const open = Arr.filter(aims, ([situation]) =>
			Option.exists(steering, (pending) => pending.has(situation))
		)
		return Arr.isReadonlyArrayNonEmpty(open)
			? oneOf(Arr.map(open, ([, aim]) => aim))
			: space.under(steering)
	})
