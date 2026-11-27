/** What the property of generated-disjoint.test.ts reads: the text types a case draws, its maps, and its oracle. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Gen } from "@bjornpagen/testing/gen"
import { element } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Text } from "#compiler/public/compute.ts"
import { generated } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"
import { owning } from "#test/support/policy.ts"
import { jsMatcher } from "#test/support/regex.ts"

/**
 * A text type a case draws, with the ECMAScript test of its language and its byte bound: capitals, small letters,
 * digits, small letters and digits, three to five small letters, and any text of at most two bytes.
 */
const texts = [
	{ name: "capitals", text: str.regex("^[A-Z]+$", "u"), holds: jsMatcher("^[A-Z]+$", "u") },
	{ name: "small letters", text: str.regex("^[a-z]+$", "u"), holds: jsMatcher("^[a-z]+$", "u") },
	{ name: "digits", text: str.regex("^[0-9]+$", "u"), holds: jsMatcher("^[0-9]+$", "u") },
	{
		name: "small letters and digits",
		text: str.regex("^[a-z0-9]*$", "u"),
		holds: jsMatcher("^[a-z0-9]*$", "u")
	},
	{
		name: "three to five small letters",
		text: str.regex("^[a-z]{3,5}$", "u"),
		holds: jsMatcher("^[a-z]{3,5}$", "u")
	},
	{
		name: "any text of at most 2 bytes",
		text: str.bytes(2, str.regex("^.*$", "su")),
		holds: (value: string) => new TextEncoder().encode(value).length <= 2
	}
] as const

/** A text type a case draws. */
export type DrawnText = (typeof texts)[number]

/** The map the generation expression applies to the stored field it reads: none, or ASCII's case fold. */
const generationMaps = ["identity", "lowerAscii"] as const
export type GenerationMap = (typeof generationMaps)[number]

export interface DisjointCase {
	readonly declared: DrawnText
	readonly stored: DrawnText
	readonly map: GenerationMap
}

export const disjointCaseGen: Gen<DisjointCase> = (source) => ({
	declared: source.draw(element(texts)),
	stored: source.draw(element(texts)),
	map: source.draw(element(generationMaps))
})

/** The installation of a relation whose generated field of the declared type is the stored field mapped. */
export const installedCase = (c: DisjointCase): Result.Result<Installation, CompileError> => {
	const owned = owning(
		schema(
			"Disjoint",
			[
				relation.generated("Generated", { lex: c.stored.text, node: Id }, ["node"], (row) => ({
					value: generated(
						c.declared.text,
						c.map === "lowerAscii" ? Text.lowerAscii(row.lex) : row.lex
					)
				}))
			],
			[]
		)
	)
	return compileInstallation(owned, installOptions(owned))
}

/** The characters the drawn languages tell apart: a capital, a small letter, a digit and a letter of two bytes. */
const alphabet = ["A", "a", "0", "é"] as const

/** Every text of at most four characters over the alphabet, the empty one first, a layer of each length in turn. */
const candidates: ReadonlyArray<string> = Arr.flatMap(
	Array.from({ length: 5 }, (_, length) => length),
	(length) =>
		Arr.reduce(
			Array.from({ length }, () => alphabet),
			[""],
			(prefixes: ReadonlyArray<string>, letters) =>
				Arr.flatMap(prefixes, (prefix) => Arr.map(letters, (c) => `${prefix}${c}`))
		)
)

/** ASCII's case fold, written out: each capital its small letter, every other character as it is. */
const foldAscii = (value: string): string =>
	Arr.join(
		Arr.map(Str.split(value, ""), (c) => (c >= "A" && c <= "Z" ? Str.toLowerCase(c) : c)),
		""
	)

/**
 * A value some row could generate into the declared type, the oracle's witness of their overlap: a stored value its
 * type holds, mapped, that the declared type holds too, searched over every candidate text; none where none is.
 * Each drawn pair that overlaps does so at a text of at most three characters over these four.
 */
export const overlapWitness = (c: DisjointCase): Option.Option<string> =>
	Arr.findFirst(
		Arr.map(Arr.filter(candidates, c.stored.holds), (v) =>
			c.map === "lowerAscii" ? foldAscii(v) : v
		),
		c.declared.holds
	)
