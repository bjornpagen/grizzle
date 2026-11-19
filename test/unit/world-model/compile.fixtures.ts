/** What the properties of compile.test.ts read: its spaces, models and helpers. */

import type * as Engine from "@bjornpagen/grizzle-text/base/result"
import { type Aimed, aimed, constant, type Gen, map } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { additionsOf } from "#test/support/worlds/features.ts"
import { defaultScope } from "#test/support/worlds/generate/enumerate.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import {
	everyActionWorth,
	type Weights,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import type {
	Action,
	AdditionFeature,
	Allowed,
	InstallSpec,
	ModelState
} from "#test/support/worlds/model/types.ts"

export type CompileFeature = "compiled" | "compile-refused" | AdditionFeature

/** The additions the suite requires. */
const additions: Arr.NonEmptyReadonlyArray<AdditionFeature> = ["addition:entry", "addition:whole"]

export const situations: Arr.NonEmptyReadonlyArray<CompileFeature> = [
	"compiled",
	"compile-refused",
	...additions
]

/** What a case writes under: a drawn installation, or the addition it aims at. */
type CompileSketch =
	| Readonly<{ kind: "drawn"; install: InstallSpec }>
	| Readonly<{ kind: "aimed"; addition: AdditionFeature }>

/** The sketch of a case writing under a drawn installation of the documents base. */
const drawnSketchGen: Gen<CompileSketch> = map(installGen(docsBase), (install): CompileSketch => ({
	kind: "drawn",
	install
}))

/**
 * A case's sketch: a drawn installation; and where a witness's turn aims at an addition no witness reached yet, that
 * addition, which the case aims its action at.
 */
export const sketchSpace: Aimed<CompileSketch, CompileFeature> = aimed(
	drawnSketchGen,
	Arr.map(
		additions,
		(addition) => [addition, constant<CompileSketch>({ kind: "aimed", addition })] as const
	)
)

/**
 * The installation a case writes under: an aimed case's, the documents base's README-shaped worlds (docsInstall), whose
 * admin writes every relation whole and whose member writes its notes through a query entry; the drawn one otherwise.
 */
export const installOf = (sketch: CompileSketch): InstallSpec => {
	switch (sketch.kind) {
		case "drawn":
			return sketch.install
		case "aimed":
			return docsInstall
	}
}

/** The weights a case's action is drawn under: `weights`, aimed for an aimed case at the addition it aims at. */
export const aimedWeights = (sketch: CompileSketch, weights: Weights): Weights => {
	switch (sketch.kind) {
		case "drawn":
			return weights
		case "aimed":
			return {
				...weights,
				aims: {
					kind: "every",
					features: [sketch.addition],
					read: compiledAdditions,
					worth: everyActionWorth,
					scope: defaultScope
				}
			}
	}
}

/** What an apply notes where the model admits it past its compile: its additions (features.ts additionsOf). */
const compiledAdditions =
	(state: ModelState, action: Action) =>
	({ observation }: Allowed): ReadonlyArray<string> =>
		action.kind === "apply" && observation.kind !== "compile-refused"
			? additionsOf(state, action)
			: []

/** A compile's refusal; none when it compiles. */
export const refusalOf = <A, E>(compiled: Engine.Result<A, E>): E | undefined =>
	compiled.ok ? undefined : compiled.error

/** A run's weights cut to applies: every other kind off, its validity shares as drawn. */
export const appliesOnly = (weights: Weights): Weights => ({
	...weights,
	actions: { ...zeroWeights.actions, apply: 1 },
	kinds: ["apply"]
})
