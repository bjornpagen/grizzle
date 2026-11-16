/** What the properties of assert.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Result } from "effect"
import { CompileError, type CompileReasonTag, prose, type ProseTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { AssertionError } from "#test/support/assert.ts"

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
export const thunkOutcomeOf = (
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
