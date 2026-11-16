/** What the properties of assert.test.ts read: its spaces, models and helpers. */

import { boolean, constant, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Result } from "effect"
import { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import {
	ChainRefused,
	type CliError,
	cliError as cliRefused,
	type CliStage,
	ConfigMissing,
	DraftRefused,
	FolderExists,
	MigrationNameRefused,
	RosterReordered
} from "#cli/errors.ts"
import { appendAll } from "#compiler/core/array.ts"
import {
	CompileError,
	type CompileReasonTag,
	malformedDescription,
	prose,
	type ProseTag
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { AssertionError, defined } from "#test/support/assert.ts"
import { pickIndex } from "#test/support/pick.ts"

type Element = number | { readonly k: number }

/** Elements equal only when deepStrictEqual says so: small integers, their -0, and records of them. */
export const elementGen: Gen<Element> = weighted<Element>([
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

export const sameCounts = (a: ReadonlyArray<Element>, b: ReadonlyArray<Element>): boolean =>
	Arr.every(
		[...a, ...b],
		(x) =>
			Arr.filter(a, (y) => sameElement(x, y)).length ===
			Arr.filter(b, (y) => sameElement(x, y)).length
	)

/**
 * Every stage a CLI refusal names; `listed` keeps the list whole, so a stage CliStage gains is a compile error here.
 */
export const cliStages = [
	"usage",
	"config",
	"environment",
	"filesystem",
	"snapshot",
	"codes",
	"generate"
] as const satisfies ReadonlyArray<CliStage>

/** A CLI stage as one of the list's: compiles only while the list holds every stage CliStage has. */
export const listed = (stage: CliStage): (typeof cliStages)[number] => stage

/** A CLI refusal at each stage, its text fields, where it has any, `text`: the stage follows from the reason. */
export const cliRefusalAt: { readonly [Stage in CliStage]: (text: string) => CliError } = {
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
export type OptionPattern =
	| { readonly kind: "none" }
	| { readonly kind: "value"; readonly value: string }
	| { readonly kind: "any string" }

const textGen = element(["fact", "other", ""] as const)

export const optionGen: Gen<Option.Option<string>> = weighted<Option.Option<string>>([
	[1, constant(Option.none())],
	[1, map(textGen, (text) => Option.some(text))]
])

export const optionPatternGen: Gen<OptionPattern> = weighted<OptionPattern>([
	[1, constant<OptionPattern>({ kind: "none" })],
	[1, map(textGen, (value): OptionPattern => ({ kind: "value", value }))],
	[1, constant<OptionPattern>({ kind: "any string" })]
])

/**
 * What a thunk does: return, throw a located refusal or a collision (two CompileError variants), throw a look-alike
 * (an Error carrying a reason field, no CompileError), or throw a plain Error.
 */
export const thunkOutcomes = [
	"returns",
	"a refusal",
	"a collision",
	"a look-alike",
	"an Error"
] as const

/** The reasons whose one fact is a sentence, each a located refusal a test plants. */
export const proseTags: Arr.NonEmptyReadonlyArray<ProseTag> = [
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
export const namedTags: Arr.NonEmptyReadonlyArray<CompileReasonTag> = [
	...proseTags,
	"IdentifierCollision"
]

export type ThunkOutcome = (typeof thunkOutcomes)[number]

/**
 * The value a thunk of that outcome throws: a located refusal and a look-alike at the located reason drawn, and the
 * collision variant, the one CompileError of the reason IdentifierCollision.
 */
export const thrownOf = (
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
export const assertionFails = (block: () => unknown): boolean => {
	const outcome = Result.try(block)
	if (Result.isSuccess(outcome)) {
		return false
	}
	if (outcome.failure instanceof AssertionError) {
		return true
	}
	throw outcome.failure
}

export type Change = "permuted" | "removed" | "added" | "replaced" | "repeated"

/**
 * A permutation of `xs` by picks, or one element removed, added or replaced by another drawn element, or one of its
 * elements repeated.
 */
export const changed = (
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
export const distinct = (xs: ReadonlyArray<Element>): boolean =>
	Arr.every(xs, (x, i) => !Arr.some(Arr.drop(xs, i + 1), (y) => sameElement(x, y)))

/** An outcome drawn against a named one: a success one case in three, else a failure of the named one half the time. */
interface Planted<A> {
	readonly outcome: number
	readonly same: boolean
	readonly other: A
	readonly named: A
}

export const plantedGen =
	<A>(options: Arr.NonEmptyReadonlyArray<A>): Gen<Planted<A>> =>
	(source) => ({
		outcome: source.draw(int(0, 2)),
		same: source.draw(boolean),
		other: source.draw(element(options)),
		named: source.draw(element(options))
	})
