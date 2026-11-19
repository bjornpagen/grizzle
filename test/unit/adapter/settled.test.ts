/**
 * The combinator a caller applies to run a call past its transient refusals (packages/grizzle/src/adapter/public/
 * settled.ts settled): a call is run again at once while it fails `transient`, as many times as it does, and ends with
 * its first value or its first failure of any other kind, as it is, a failure whose `retry` is `"safe"` among them,
 * which settled never runs again; its failure's type is every kind the call fails with but `transient` (Settled over
 * every CallError, which the typed ending below states).
 *
 * - Property: over drawn runs of a call, up to six transient refusals and then a value or a failure of another kind,
 *   settled runs the call exactly once past each refusal and ends with the run's ending. Oracle: the specification of
 *   the combinator, the run's ending and its count of attempts.
 *
 * Features: no transient refusal; transient refusals before the end; ended by a value; ended by a failure whose
 * `retry` is `"safe"`; ended by a failure whose `retry` is `"never"`.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { type Settled, settled } from "#adapter/public/settled.ts"
import { type CallError, callError } from "#compiler/live/index.ts"

/** A failure of another kind than `transient` that ends a run: one whose `retry` is `"safe"`, or one whose is never. */
const endingFailures = [
	callError("transport", { message: "the exchange broke" }),
	callError("tokenExpired", { message: "the token expired" }),
	callError("stale", { message: "the database is past the deployed snapshot" }),
	callError("commitUnknown", { message: "COMMIT got no answer" }),
	callError("failed", { message: "the statement was refused" })
] as const satisfies ReadonlyArray<CallError>

/** One run of a call: its transient refusals, then its ending, a value or a failure of another kind. */
interface Run {
	readonly refusals: number
	readonly ending:
		| { readonly kind: "value"; readonly value: number }
		| { readonly kind: "failure"; readonly error: (typeof endingFailures)[number] }
}

const runGen: Gen<Run> = (source) => ({
	refusals: source.draw(int(0, 6)),
	ending: source.draw(
		weighted<Run["ending"]>([
			[1, (s) => ({ kind: "value", value: s.draw(int(0, 9)) })],
			[2, (s) => ({ kind: "failure", error: s.draw(element(endingFailures)) })]
		])
	)
})

type SettledFeature =
	| "no transient refusal"
	| "transient refusals before the end"
	| "ended by a value"
	| "ended by a failure whose retry is safe"
	| "ended by a failure whose retry is never"

/** A transient refusal, SERIALIZABLE's. */
const refusal = callError("transient", {
	message: "could not serialize access",
	reason: "SerializationFailure"
})

/** settled runs a call again past each of its transient refusals and ends with the call's first other ending. */
export const settledRunsACallAgainPastEachTransientRefusalAndEndsWithItsFirstOtherEnding =
	property.explore(runGen, {
		needs: {},
		situations: [
			"no transient refusal",
			"transient refusals before the end",
			"ended by a value",
			"ended by a failure whose retry is safe",
			"ended by a failure whose retry is never"
		] satisfies ReadonlyArray<Reached<SettledFeature>>,
		check: (_, c: Case<SettledFeature>) => (run) =>
			Effect.gen(function* () {
				c.note(run.refusals === 0 ? "no transient refusal" : "transient refusals before the end")
				if (run.ending.kind === "value") {
					c.note("ended by a value")
				} else {
					c.note(
						run.ending.error.retry === "safe"
							? "ended by a failure whose retry is safe"
							: "ended by a failure whose retry is never"
					)
				}
				const attempts = { made: 0 }
				const call = Effect.suspend((): Effect.Effect<number, CallError> => {
					attempts.made += 1
					if (attempts.made <= run.refusals) {
						return Effect.fail(refusal)
					}
					if (attempts.made > run.refusals + 1) {
						return Effect.die(`attempt ${attempts.made} of a run that ends at ${run.refusals + 1}`)
					}
					return run.ending.kind === "value"
						? Effect.succeed(run.ending.value)
						: Effect.fail(run.ending.error)
				})
				const ended: Effect.Effect<number, Settled> = settled(call)
				const answer = yield* Effect.result(ended)
				assert.equal(attempts.made, run.refusals + 1, "one attempt past each transient refusal")
				assert.deepEqual(
					answer,
					run.ending.kind === "value"
						? Result.succeed(run.ending.value)
						: Result.fail(run.ending.error),
					"the run's ending, as it is"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the combinator's contract: one attempt past each transient refusal, ended by the first other ending"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/public/settled.ts",
				original: '=> error.kind === "transient"',
				replacement: "=> false",
				why: "A transient refusal ends the call, which is run once; a run with a refusal fails."
			},
			{
				file: "packages/grizzle/src/adapter/public/settled.ts",
				original: '=> error.kind === "transient"',
				replacement: '=> error.retry === "safe"',
				why: "Every failure whose retry is safe runs the call again, a transport break and an expired token among them; a run ended by one attempts past its end."
			}
		]
	})
