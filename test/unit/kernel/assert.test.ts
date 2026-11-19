/**
 * The assertion door (test/support/assert.ts): each assertion holds exactly where its contract says, and fails as an
 * AssertionError everywhere else.
 *
 * - refused and succeeded hold exactly for a failure of the named reason and for a success. Oracle: the planted
 *   outcome, which the case states before it asserts.
 * - throwsRefused holds exactly for a thunk that throws a CompileError of its reason, and returns what it threw. Oracle:
 *   the planted outcome.
 *
 * Features: a success, the named reason and another; each thunk outcome holding and failing.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { CompileError, type CompileReasonTag, prose } from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import { refusalLoc, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	assertionFails,
	namedTags,
	plantedGen,
	proseTags,
	thunkOutcomeOf,
	type ThunkOutcome,
	thunkOutcomes
} from "#test/unit/kernel/assert.fixtures.ts"

/**
 * The assertion door holds refused exactly for a failure of its reason, and succeeded exactly for a success.
 *
 * Budget: its suite's count before the conversion (unit/kernel/refused: 200 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theAssertionDoorHoldsRefusedExactlyForAFailureOfItsReasonAndSucceededExactlyForASuccess =
	property.explore(plantedGen(proseTags), {
		needs: {},
		situations: ["success", "same reason", "other reason"] satisfies ReadonlyArray<
			Reached<"success" | "same reason" | "other reason">
		>,
		check:
			(_, c: Case<"success" | "same reason" | "other reason">) =>
			({ outcome, same, other, named: reason }) =>
				Effect.sync(() => {
					/** A failure of the named reason is planted half the time: other reasons are many. */
					const failureReason = same ? reason : other
					const result: Result.Result<number, CompileError> =
						outcome === 0
							? Result.succeed(7)
							: Result.fail(
									CompileError.make(
										prose(failureReason, SourceLoc("planted", []), "a planted refusal")
									)
								)
					const matches = Result.isFailure(result) && result.failure.reason._tag === reason
					c.note(Result.isSuccess(result) ? "success" : matches ? "same reason" : "other reason")
					assert.equal(
						assertionFails(() => refused(result, reason)),
						!matches
					)
					assert.equal(
						assertionFails(() => {
							succeeded(result)
						}),
						Result.isFailure(result)
					)
					if (matches) {
						assert.equal(formatLoc(refusalLoc(refused(result, reason))), "planted")
					}
					if (Result.isSuccess(result)) {
						assert.equal(succeeded(result), 7)
					}
				}),
		oracle: { kind: "specification", name: "the planted outcome and its reason" },
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/loc.ts",
				original: `\tconst head = path === "" ? loc.label : \`\${loc.label} at \${path}\``,
				replacement: `\tconst head = path === "" ? \`\${loc.label} at \${path}\` : loc.label`,
				why: `Operator mutant (arm-swap) at packages/engine/src/core/loc.ts:146 in formatLoc: \`path === "" ? loc.label : \`\${loc.label} at \${path}\`\` becomes \`path === "" ? \`\${loc.label} at \${path}\` : loc.label\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			}
		]
	})

/**
 * The assertion door holds throwsRefused exactly for a thunk that throws a CompileError of its reason.
 *
 * Budget: its suite's count before the conversion (unit/kernel/throws-refused: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theAssertionDoorHoldsThrowsRefusedExactlyForAThunkThatThrowsACompileErrorOfItsReason =
	property.explore(
		(source) => ({
			outcome: source.draw(element(thunkOutcomes)),
			same: source.draw(boolean),
			located: source.draw(element(proseTags)),
			named: source.draw(element(namedTags))
		}),
		{
			needs: {},
			situations: [
				"returns fails",
				"a refusal holds",
				"a refusal fails",
				"a collision holds",
				"a collision fails",
				"a look-alike fails",
				"an Error fails"
			] satisfies ReadonlyArray<Reached<`${ThunkOutcome} ${"holds" | "fails"}`>>,
			check:
				(_, c: Case<`${ThunkOutcome} ${"holds" | "fails"}`>) =>
				({ outcome, same, located, named }) =>
					Effect.sync(() => {
						const thrownReason: CompileReasonTag =
							outcome === "a collision" ? "IdentifierCollision" : located
						/** The reason thrown is named half the time: other reasons are many. */
						const reason = same ? thrownReason : named
						const thrown = thunkOutcomeOf(outcome, located)
						const thunk = (): number => {
							if (thrown.kind === "throws") {
								throw thrown.value
							}
							return 7
						}
						const holds =
							(outcome === "a refusal" || outcome === "a collision") &&
							thrown.kind === "throws" &&
							thrownReason === reason
						c.note(`${outcome} ${holds ? "holds" : "fails"}`)
						assert.equal(
							assertionFails(() => throwsRefused(thunk, reason)),
							!holds
						)
						if (holds) {
							assert.ok(
								Object.is(throwsRefused(thunk, reason), thrown.value),
								"it returns the error thrown"
							)
						}
					}),
			oracle: { kind: "specification", name: "the planted thunk's outcome and its reason" },
			budget: { runs: 300, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/errors.ts",
					original: '\tError.isError(value) && "_tag" in value && value._tag === "CompileError"',
					replacement: '\tError.isError(value) && "_tag" in value && value._tag !== "CompileError"',
					why: "Operator mutant (comparison) at packages/engine/src/core/errors.ts:1015 in isCompileError: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
