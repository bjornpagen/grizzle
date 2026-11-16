/** What the property of substrate.test.ts reads: its spaces, models and helpers. */

import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import {
	array,
	characterOf,
	element,
	type Gen,
	int,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Result, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

/** A word of lowercase letters joined by single underscores, its letters `max` at most. */
const wordGen =
	(max: number): Gen<string> =>
	(source) =>
		Arr.join(
			source.draw(
				array(string(characterOf(lowercase), { min: 1, max: Math.max(1, Math.floor(max / 3)) }), {
					min: 1,
					max: 3
				})
			),
			"_"
		)

/** A fault that breaks the word rule. */
type WordFault =
	| "a digit"
	| "a capital"
	| "empty"
	| "a leading underscore"
	| "a trailing underscore"
	| "a double underscore"
	| "a dash"

const faultOf = (word: string, fault: WordFault): string => {
	switch (fault) {
		case "a digit":
			return `${word}2`
		case "a capital":
			return Str.capitalize(word)
		case "empty":
			return ""
		case "a leading underscore":
			return `_${word}`
		case "a trailing underscore":
			return `${word}_`
		case "a double underscore":
			return `${word}__${word}`
		case "a dash":
			return `${word}-x`
	}
}

/** A word the rule admits, or one with a fault planted. */
interface Word {
	readonly text: string
	readonly fault: Option.Option<WordFault>
}

export const drawnWord = (max: number): Gen<Word> =>
	weighted<Word>([
		[4, (source) => ({ text: source.draw(wordGen(max)), fault: Option.none() })],
		[
			1,
			(source) => {
				const fault = source.draw(
					element([
						"a digit",
						"a capital",
						"empty",
						"a leading underscore",
						"a trailing underscore",
						"a double underscore",
						"a dash"
					] as const)
				)
				return { text: faultOf(source.draw(wordGen(max)), fault), fault: Option.some(fault) }
			}
		]
	])

/** Whether `make` throws. */
export const refuses = (make: () => unknown): boolean => Result.isFailure(Result.try(make))

/** Every role, login and role schema name the naming door mints under an allocated schema, and a test's role. */
export const mintedUnder = (schema: string): ReadonlyArray<string> => {
	const installation = identity.schema(parsedSchemaName(schema))
	const role = identity.role(installation, parsedName("Worker"))
	return [
		identifierOf(role),
		identifierOf(identity.login(installation, parsedName("web"))),
		identifierOf(identity.roleSchema(role))
	]
}

/** A schema name that is no allocation: its pid not digits, its random part short or gone, or a plain word. */
export const unallocatedGen: Gen<string> = (source) => {
	const label = source.draw(wordGen(8))
	const pid = source.draw(int(1, 99_999))
	return source.draw(
		element([
			`${label}_${pid}_3`,
			`${label}_p${pid}_3_0000000005`,
			`${label}_${pid}_3_000000005`,
			label,
			`${label}__${pid}`
		])
	)
}

/** A plain lowercase identifier's characters after its first: letters, digits and underscores. */
const identifierRest = nonEmpty(
	Arr.fromIterable("abcdefghijklmnopqrstuvwxyz0123456789_"),
	"identifier characters"
)

type IdentifierFault = "a capital" | "a dash" | "a leading digit" | "empty" | "a space"

/** A plain lowercase identifier of a drawn length around the byte limit, or one with a fault planted. */
interface Identifier {
	readonly text: string
	readonly fault: Option.Option<IdentifierFault>
}

export const identifierGen: Gen<Identifier> = (source) => {
	const length = source.draw(
		weighted<number>([
			[3, int(maxIdentifierBytes - 1, maxIdentifierBytes + 1)],
			[1, int(1, maxIdentifierBytes + 8)]
		])
	)
	const text = `${source.draw(characterOf(lowercase))}${source.draw(string(characterOf(identifierRest), { min: length - 1, max: length - 1 }))}`
	const fault = source.draw(
		weighted<Option.Option<IdentifierFault>>([
			[3, () => Option.none()],
			[
				1,
				(s) =>
					Option.some(
						s.draw(element(["a capital", "a dash", "a leading digit", "empty", "a space"] as const))
					)
			]
		])
	)
	return Option.match(fault, {
		onNone: () => ({ text, fault }),
		onSome: (planted) => ({
			text:
				planted === "a capital"
					? Str.capitalize(text)
					: planted === "a dash"
						? `${text}-`
						: planted === "a leading digit"
							? `1${text}`
							: planted === "empty"
								? ""
								: `${text} `,
			fault
		})
	})
}

export type NameFeature =
	| "an identifier admitted"
	| "an identifier past the limit"
	| "an identifier refused"
	| "allocated"
	| "a label refused"
	| "a label past the limit"
	| "a role named"
	| "a role refused"
	| "a role past the limit"
	| "no allocation"
