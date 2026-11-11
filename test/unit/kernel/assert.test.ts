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
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): assert-unordered-repeats-folded, assert-refused-any-reason,
 * assert-faulted-any-fault, assert-refused-at-any-value, assert-option-some-any-value and
 * assert-throws-refused-lookalike, each the assertion holding where its contract says it fails.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import {
	ChainRefused,
	type CliError,
	type CliStage,
	ConfigMissing,
	DraftRefused,
	FolderExists,
	MigrationNameRefused,
	RosterReordered,
	cliError as cliRefused
} from "#cli/errors.ts"

import { appendAll } from "#compiler/core/array.ts"
import {
	CompileError,
	type CompileReasonTag,
	malformedDescription,
	type ProseTag,
	prose,
	type ValueFault,
	valueFaultWords
} from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	assert,
	AssertionError,
	defined,
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
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

type Element = number | { readonly k: number }

/** Elements equal only when deepStrictEqual says so: small integers, their -0, and records of them. */
const elementGen: Gen<Element> = weighted<Element>([
	[1, int(-2, 2)],
	[1, constant(-0)],
	[1, (source) => ({ k: source.draw(int(0, 2)) })]
])

/**
 * The set oracle: element equality as deepStrictEqual has it on these elements (Object.is on numbers, so -0 is not 0,
 * and the field on records), and each element counted by it; two lists are one set when each holds every element once
 * and the counts agree.
 */
const sameElement = (x: Element, y: Element): boolean =>
	typeof x === "number"
		? typeof y === "number" && Object.is(x, y)
		: typeof y !== "number" && x.k === y.k

const sameCounts = (a: ReadonlyArray<Element>, b: ReadonlyArray<Element>): boolean =>
	Arr.every(
		[...a, ...b],
		(x) =>
			Arr.filter(a, (y) => sameElement(x, y)).length ===
			Arr.filter(b, (y) => sameElement(x, y)).length
	)

/**
 * Every stage a CLI refusal names; `listed` keeps the list whole, so a stage CliStage gains is a compile error here.
 */
const cliStages = [
	"usage",
	"config",
	"environment",
	"filesystem",
	"snapshot",
	"codes",
	"generate"
] as const satisfies ReadonlyArray<CliStage>
/** A CLI stage as one of the list's: compiles only while the list holds every stage CliStage has. */
const listed = (stage: CliStage): (typeof cliStages)[number] => stage

/** A CLI refusal at each stage, its text fields, where it has any, `text`: the stage follows from the reason. */
const cliRefusalAt: { readonly [Stage in CliStage]: (text: string) => CliError } = {
	usage: (text) => cliRefused(new MigrationNameRefused({ migration: text })),
	config: (text) => cliRefused(new ConfigMissing({ file: text })),
	environment: () => cliRefused(new ConnectionEnvironmentRefused({ variable: "PGOPTIONS" })),
	filesystem: (text) => cliRefused(new FolderExists({ schema: text, path: text })),
	snapshot: (text) =>
		cliRefused(
			new ChainRefused({
				schema: text,
				ident: text,
				directory: text,
				fault: { kind: "misnamed", folder: text }
			})
		),
	codes: (text) =>
		cliRefused(new RosterReordered({ schema: text, roster: text, earlier: text, later: text })),
	generate: (text) =>
		cliRefused(
			new DraftRefused({
				schema: text,
				step: "draft",
				error: malformedDescription(SourceLoc("planted", []), text)
			})
		)
}

/** An Option field's pattern: an Option of its own case, Some by a value or by any string. */
type OptionPattern =
	| { readonly kind: "none" }
	| { readonly kind: "value"; readonly value: string }
	| { readonly kind: "any string" }
const textGen = element(["fact", "other", ""] as const)
const optionGen: Gen<Option.Option<string>> = weighted<Option.Option<string>>([
	[1, constant(Option.none())],
	[1, map(textGen, (text) => Option.some(text))]
])

const optionPatternGen: Gen<OptionPattern> = weighted<OptionPattern>([
	[1, constant<OptionPattern>({ kind: "none" })],
	[1, map(textGen, (value): OptionPattern => ({ kind: "value", value }))],
	[1, constant<OptionPattern>({ kind: "any string" })]
])

/**
 * What a thunk does: return, throw a located refusal or a collision (two CompileError variants), throw a look-alike
 * (an Error carrying a reason field, no CompileError), or throw a plain Error.
 */
const thunkOutcomes = ["returns", "a refusal", "a collision", "a look-alike", "an Error"] as const

/** The reasons whose one fact is a sentence, each a located refusal a test plants. */
const proseTags: Arr.NonEmptyReadonlyArray<ProseTag> = [
	"MalformedDescription",
	"UnsupportedOperation",
	"UnsupportedLawFamily",
	"MissingDiscriminant",
	"AttachedParentUnbound",
	"AttachedPage",
	"DescribedHeadingMismatch",
	"ContractLiteral"
]

/** Every reason a planted thunk names: the located ones and the collision. */
const namedTags: Arr.NonEmptyReadonlyArray<CompileReasonTag> = [...proseTags, "IdentifierCollision"]
type ThunkOutcome = (typeof thunkOutcomes)[number]

/**
 * The value a thunk of that outcome throws: a located refusal and a look-alike at the located reason drawn, and the
 * collision variant, the one CompileError of the reason IdentifierCollision.
 */
const thrownOf = (
	outcome: ThunkOutcome,
	located: ProseTag
): { readonly kind: "returns" } | { readonly kind: "throws"; readonly value: unknown } => {
	switch (outcome) {
		case "returns":
			return { kind: "returns" }
		case "a refusal":
			return {
				kind: "throws",
				value: CompileError.make(prose(located, SourceLoc("planted", []), "a planted refusal"))
			}
		case "a collision":
			return {
				kind: "throws",
				value: CompileError.make({
					_tag: "IdentifierCollision",
					at: SourceLoc("planted", []),
					other: SourceLoc("planted too", []),
					identifier: "planted",
					what: "relation",
					declaration: "relation planted",
					otherDeclaration: "relation Planted"
				})
			}
		case "a look-alike":
			return {
				kind: "throws",
				value: Object.assign(new Error("a look-alike"), { reason: { _tag: located } })
			}
		case "an Error":
			return { kind: "throws", value: new Error("not a refusal") }
	}
}

/** Whether a block threw an AssertionError (anything else it threw fails the test). */
const assertionFails = (block: () => unknown): boolean => {
	const outcome = Result.try(block)
	if (Result.isSuccess(outcome)) {
		return false
	}
	if (outcome.failure instanceof AssertionError) {
		return true
	}
	throw outcome.failure
}

type Change = "permuted" | "removed" | "added" | "replaced" | "repeated"

/**
 * A permutation of `xs` by picks, or one element removed, added or replaced by another drawn element, or one of its
 * elements repeated.
 */
const changed = (
	xs: ReadonlyArray<Element>,
	change: Change,
	picks: ReadonlyArray<number>,
	other: Element
): ReadonlyArray<Element> => {
	const pool = [...xs]
	const permuted: Array<Element> = []
	for (const pick of picks) {
		if (pool.length === 0) {
			break
		}
		appendAll(permuted, pool.splice(pickIndex(pick, pool.length), 1))
	}
	appendAll(permuted, pool)
	/** The changed position; an empty list has none, so removing or replacing there changes nothing. */
	const at = permuted.length === 0 ? -1 : pickIndex(defined(picks[0], "six picks"), permuted.length)
	switch (change) {
		case "permuted":
			return permuted
		case "removed":
			return Arr.remove(permuted, at)
		case "added":
			return [...permuted, other]
		case "replaced":
			return Arr.map(permuted, (x, i) => (i === at ? other : x))
		case "repeated":
			return [
				...permuted,
				...(at < 0 ? [other, other] : [defined(permuted[at], "the changed position")])
			]
	}
}

/** Whether a list holds every element once, elements compared as the set oracle compares them. */
const distinct = (xs: ReadonlyArray<Element>): boolean =>
	Arr.every(xs, (x, i) => !Arr.some(Arr.drop(xs, i + 1), (y) => sameElement(x, y)))

/** The explorations of this file: every case one draw, one at a time. */
const spec = {
	literal: Formatter.format,
	kept: [],
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/** An outcome drawn against a named one: a success one case in three, else a failure of the named one half the time. */
interface Planted<A> {
	readonly outcome: number
	readonly same: boolean
	readonly other: A
	readonly named: A
}

const plantedGen =
	<A>(options: Arr.NonEmptyReadonlyArray<A>): Gen<Planted<A>> =>
	(source) => ({
		outcome: source.draw(int(0, 2)),
		same: source.draw(boolean),
		other: source.draw(element(options)),
		named: source.draw(element(options))
	})

describe("the assertion door", () => {
	it.effect(
		"holds unorderedEqual exactly between lists that are one set, each holding every element once",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "element counts under deepStrictEqual's equality"
						},
						...spec,
						suite: "unit/kernel/unordered-equal",
						draw: drawn((source) => ({
							xs: source.draw(array(elementGen, { min: 0, max: 6 })),
							change: source.draw(
								element(["permuted", "removed", "added", "replaced", "repeated"] as const)
							),
							picks: source.draw(array(pickGen, { min: 6, max: 6 })),
							other: source.draw(elementGen)
						})),
						runs: 300,
						coverage: required<`${Change} ${"holds" | "fails"}`>(
							[
								"permuted holds",
								"removed fails",
								"added fails",
								"replaced holds",
								"replaced fails",
								"repeated fails"
							],
							{ cases: 300, sense: notesOnly }
						)
					},
					({ xs, change, picks, other }, c) =>
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
						})
				)
			)
	)

	it.effect(
		"holds refused exactly for a failure of its reason, and succeeded exactly for a success",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the planted outcome and its reason" },
						...spec,
						suite: "unit/kernel/refused",
						draw: drawn(plantedGen(proseTags)),
						runs: 200,
						coverage: required<"success" | "same reason" | "other reason">(
							["success", "same reason", "other reason"],
							{ cases: 200, sense: notesOnly }
						)
					},
					({ outcome, same, other, named: reason }, c) =>
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
							c.note(
								Result.isSuccess(result) ? "success" : matches ? "same reason" : "other reason"
							)
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
						})
				)
			)
	)

	it.effect("holds faulted exactly for a failure that is its fault", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "specification", name: "the planted outcome and its fault" },
					...spec,
					suite: "unit/kernel/faulted",
					draw: drawn(plantedGen(valueFaultWords)),
					runs: 200,
					coverage: required<"success" | "same fault" | "other fault">(
						["success", "same fault", "other fault"],
						{ cases: 200, sense: notesOnly }
					)
				},
				({ outcome, same, other, named: fault }, c) =>
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
					})
			)
		)
	)

	it.effect(
		"holds refusedAt exactly for a failure whose named field holds the value, whatever its other fields",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the planted outcome and its stage" },
						...spec,
						suite: "unit/kernel/refused-at",
						draw: drawn((source) => ({
							planted: source.draw(plantedGen(cliStages)),
							text: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 12 }))
						})),
						runs: 200,
						coverage: required<"success" | "same stage" | "other stage">(
							["success", "same stage", "other stage"],
							{ cases: 200, sense: notesOnly }
						)
					},
					({ planted: { outcome, same, other, named }, text }, c) =>
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
						})
				)
			)
	)

	it.effect(
		"holds matchesObject on an Option field exactly when the field is an Option of the pattern's case and value",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the Option's case and value compared by hand" },
						...spec,
						suite: "unit/kernel/matches-option",
						draw: drawn((source) => ({
							table: source.draw(optionGen),
							column: source.draw(optionGen),
							pattern: source.draw(optionPatternGen)
						})),
						runs: 200,
						coverage:
							required<`${OptionPattern["kind"]} against ${"none" | "some"} ${"holds" | "fails"}`>(
								[
									"none against none holds",
									"none against some fails",
									"value against none fails",
									"value against some holds",
									"value against some fails",
									"any string against some holds",
									"any string against none fails"
								],
								{ cases: 200, sense: notesOnly }
							)
					},
					({ table, column, pattern }, c) =>
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
						})
				)
			)
	)

	it.effect(
		"holds throwsRefused exactly for a thunk that throws a CompileError of its reason",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the planted thunk's outcome and its reason" },
						...spec,
						suite: "unit/kernel/throws-refused",
						draw: drawn((source) => ({
							outcome: source.draw(element(thunkOutcomes)),
							same: source.draw(boolean),
							located: source.draw(element(proseTags)),
							named: source.draw(element(namedTags))
						})),
						runs: 300,
						coverage: required<`${ThunkOutcome} ${"holds" | "fails"}`>(
							[
								"returns fails",
								"a refusal holds",
								"a refusal fails",
								"a collision holds",
								"a collision fails",
								"a look-alike fails",
								"an Error fails"
							],
							{ cases: 300, sense: notesOnly }
						)
					},
					({ outcome, same, located, named }, c) =>
						Effect.sync(() => {
							const thrownReason: CompileReasonTag =
								outcome === "a collision" ? "IdentifierCollision" : located
							/** The reason thrown is named half the time: other reasons are many. */
							const reason = same ? thrownReason : named
							const thrown = thrownOf(outcome, located)
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
						})
				)
			)
	)
})
