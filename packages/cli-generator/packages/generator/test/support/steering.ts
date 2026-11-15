import { type Draw, steered } from "@bjornpagen/testing/explore"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"

/**
 * A draw that takes `unaimed` unless the case's steering still names one of `features` as pending, then what `aimAt` draws for one
 * of those, drawn from the case's own stream: the aim is part of the generated value, so the case the search prints,
 * shrinks and keeps is the one that ran.
 */
export const aimedAmong = <F extends string, T>(
	features: ReadonlyArray<F>,
	unaimed: Gen<T>,
	aimAt: (feature: F) => Gen<T>
): Draw<T, T, F> =>
	steered(
		(steering) =>
			Option.match(
				Option.flatMap(steering, (pending) =>
					Arr.match(
						Arr.filter(features, (feature) => pending.names(feature)),
						{ onEmpty: () => Option.none(), onNonEmpty: Option.some }
					)
				),
				{
					onNone: () => unaimed,
					onSome: (pendingFeatures) => (source) =>
						source.draw(aimAt(source.draw(element(pendingFeatures))))
				}
			),
		(value) => value
	)
