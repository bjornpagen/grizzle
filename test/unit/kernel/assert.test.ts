/**
 * The assertion door (test/support/assert.ts): each assertion holds exactly where its contract says, and fails as an
 * AssertionError everywhere else.
 *
 * - unorderedEqual holds exactly between two lists that are one set, each holding every element once. Oracle: element
 *   counts under deepStrictEqual's equality, a second implementation.
 * - refused and succeeded hold exactly for a failure of the named reason and for a success; faulted exactly for the
 *   named fault; refusedAt exactly for a failure whose named field holds the value. Oracle: the planted outcome, which
 *   the case states before it asserts.
 * - matchesObject on an Option field holds exactly for an Option of the pattern's case and value. Oracle: the case and
 *   value compared by hand.
 * - throwsRefused holds exactly for a thunk that throws a CompileError of its reason, and returns what it threw. Oracle:
 *   the planted outcome.
 *
 * Features: each change of a list (permuted, removed, added, replaced, repeated) holding and failing; a success, the
 * named reason, fault or stage, and another; each Option pattern against none and some; each thunk outcome holding and
 * failing.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, boolean, codePoint, element, string } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, Result } from "effect"
import { type CliError } from "#cli/errors.ts"
import {
	CompileError,
	type CompileReasonTag,
	prose,
	type ValueFault,
	valueFaultWords
} from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	assert,
	faulted,
	matchers,
	matchesObject,
	refusalLoc,
	refused,
	refusedAt,
	succeeded,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import { pickGen } from "#test/support/pick.ts"
import {
	assertionFails,
	type Change,
	changed,
	cliRefusalAt,
	cliStages,
	distinct,
	elementGen,
	listed,
	namedTags,
	optionGen,
	type OptionPattern,
	optionPatternGen,
	plantedGen,
	proseTags,
	sameCounts,
	thunkOutcomeOf,
	type ThunkOutcome,
	thunkOutcomes
} from "#test/unit/kernel/assert.fixtures.ts"

/** The assertion door holds unorderedEqual exactly between lists that are one set, each holding every element once. */
export const theAssertionDoorHoldsUnorderedEqualExactlyBetweenListsThatAreOneSetEachHoldingEveryElementOnce =
	property.explore(
		(source) => ({
			xs: source.draw(array(elementGen, { min: 0, max: 6 })),
			change: source.draw(
				element(["permuted", "removed", "added", "replaced", "repeated"] as const)
			),
			picks: source.draw(array(pickGen, { min: 6, max: 6 })),
			other: source.draw(elementGen)
		}),
		{
			needs: {},
			situations: [
				"permuted holds",
				"removed fails",
				"added fails",
				"replaced holds",
				"replaced fails",
				"repeated fails"
			] satisfies ReadonlyArray<Reached<`${Change} ${"holds" | "fails"}`>>,
			check:
				(_, c: Case<`${Change} ${"holds" | "fails"}`>) =>
				({ xs, change, picks, other }) =>
					Effect.sync(() => {
						const ys = changed(xs, change, picks, other)
						const holds = sameCounts(xs, ys) && distinct(xs) && distinct(ys)
						c.note(`${change} ${holds ? "holds" : "fails"}`)
						assert.equal(
							assertionFails(() => {
								unorderedEqual(xs, ys)
							}),
							!holds
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "element counts under deepStrictEqual's equality"
			},
			kept: [],
			kills: []
		}
	)

/** The assertion door holds refused exactly for a failure of its reason, and succeeded exactly for a success. */
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
		kept: [],
		kills: []
	})

/** The assertion door holds faulted exactly for a failure that is its fault. */
export const theAssertionDoorHoldsFaultedExactlyForAFailureThatIsItsFault = property.explore(
	plantedGen(valueFaultWords),
	{
		needs: {},
		situations: ["success", "same fault", "other fault"] satisfies ReadonlyArray<
			Reached<"success" | "same fault" | "other fault">
		>,
		check:
			(_, c: Case<"success" | "same fault" | "other fault">) =>
			({ outcome, same, other, named: fault }) =>
				Effect.sync(() => {
					/** The named fault is planted half the time: other faults are many. */
					const actual = same ? fault : other
					const result: Result.Result<number, ValueFault> =
						outcome === 0 ? Result.succeed(7) : Result.fail(actual)
					const matches = Result.isFailure(result) && result.failure === fault
					c.note(Result.isSuccess(result) ? "success" : matches ? "same fault" : "other fault")
					assert.equal(
						assertionFails(() => {
							faulted(result, fault)
						}),
						!matches
					)
				}),
		oracle: { kind: "specification", name: "the planted outcome and its fault" },
		kept: [],
		kills: []
	}
)

/** The assertion door holds refusedAt exactly for a failure whose named field holds the value, whatever its other fields. */
export const theAssertionDoorHoldsRefusedAtExactlyForAFailureWhoseNamedFieldHoldsTheValueWhateverItsOtherFields =
	property.explore(
		(source) => ({
			planted: source.draw(plantedGen(cliStages)),
			text: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 12 }))
		}),
		{
			needs: {},
			situations: ["success", "same stage", "other stage"] satisfies ReadonlyArray<
				Reached<"success" | "same stage" | "other stage">
			>,
			check:
				(_, c: Case<"success" | "same stage" | "other stage">) =>
				({ planted: { outcome, same, other, named }, text }) =>
					Effect.sync(() => {
						const stage = listed(named)
						/** The named stage is planted half the time: other stages are many. */
						const failureStage = same ? stage : other
						const refusal = cliRefusalAt[failureStage](text)
						const result: Result.Result<number, CliError> =
							outcome === 0 ? Result.succeed(7) : Result.fail(refusal)
						const matches = Result.isFailure(result) && result.failure.stage === stage
						c.note(Result.isSuccess(result) ? "success" : matches ? "same stage" : "other stage")
						assert.equal(
							assertionFails(() => {
								refusedAt(result, "stage", stage)
							}),
							!matches
						)
						if (matches) {
							assert.equal(refusedAt(result, "stage", stage), refusal)
						}
					}),
			oracle: { kind: "specification", name: "the planted outcome and its stage" },
			kept: [],
			kills: []
		}
	)

/** The assertion door holds matchesObject on an Option field exactly when the field is an Option of the pattern's case and value. */
export const theAssertionDoorHoldsMatchesObjectOnAnOptionFieldExactlyWhenTheFieldIsAnOptionOfThePatternsCaseAndValue =
	property.explore(
		(source) => ({
			table: source.draw(optionGen),
			column: source.draw(optionGen),
			pattern: source.draw(optionPatternGen)
		}),
		{
			needs: {},
			situations: [
				"none against none holds",
				"none against some fails",
				"value against none fails",
				"value against some holds",
				"value against some fails",
				"any string against some holds",
				"any string against none fails"
			] satisfies ReadonlyArray<
				Reached<`${OptionPattern["kind"]} against ${"none" | "some"} ${"holds" | "fails"}`>
			>,
			check:
				(_, c: Case<`${OptionPattern["kind"]} against ${"none" | "some"} ${"holds" | "fails"}`>) =>
				({ table, column, pattern }) =>
					Effect.sync(() => {
						const fields = { table, column }
						const expected =
							pattern.kind === "none"
								? Option.none()
								: Option.some(pattern.kind === "value" ? pattern.value : matchers.any(String))
						/** The oracle: the case agrees, and a Some's value is the pattern's (any string passes). */
						const holds = Option.isNone(table)
							? pattern.kind === "none"
							: pattern.kind === "any string" ||
								(pattern.kind === "value" && pattern.value === table.value)
						c.note(
							`${pattern.kind} against ${Option.isNone(table) ? "none" : "some"} ${holds ? "holds" : "fails"}`
						)
						assert.equal(
							assertionFails(() => {
								matchesObject(fields, { table: expected })
							}),
							!holds
						)
					}),
			oracle: { kind: "specification", name: "the Option's case and value compared by hand" },
			kept: [],
			kills: []
		}
	)

/** The assertion door holds throwsRefused exactly for a thunk that throws a CompileError of its reason. */
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
			kept: [],
			kills: []
		}
	)
