/** What the properties of parse-once.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	admittedClosedId,
	closedBuilder as closed,
	closedRelation,
	generatedField,
	generatedRelation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { defined } from "#test/support/assert.ts"

/** A pattern a text field may declare, the pattern its relation's generated field matches, and a member a row holds. */
interface Pattern {
	readonly source: string
	readonly flags: "u" | "su"
	readonly match: string
	readonly member: string
}

const patterns: Arr.NonEmptyReadonlyArray<Pattern> = [
	{ source: "^[a-z]{1,6}$", flags: "u", match: "^a", member: "abc" },
	{ source: "^(?:yes|no)$", flags: "u", match: "s$", member: "yes" },
	{ source: "^.{0,12}$", flags: "su", match: "\\n", member: "x\ny" },
	{ source: "^[A-Z][0-9]{2}$", flags: "u", match: "[0-9]", member: "B12" }
]

/** The texts the host reads: members and non-members of every pattern and of every match. */
const texts: Arr.NonEmptyReadonlyArray<string> = [
	"",
	"a",
	"abc",
	"ABC",
	"yes",
	"no",
	"x\ny",
	"B12",
	"b12",
	"aaaaaaaaaaaaa",
	"s"
]

/** The closed roster's handles, a closed row for each in the multiplied schema. */
export const handles: Arr.NonEmptyReadonlyArray<string> = ["A", "B", "C", "D"]

interface ParseCase {
	/** The distinct patterns the schema declares, by their place in `patterns`, each once. */
	readonly chosen: Arr.NonEmptyReadonlyArray<number>
	/** Each relation's text fields, by their pattern's place in `chosen`. */
	readonly relations: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
	/** How many times the multiplied schema copies each relation. */
	readonly copies: number
	/** The closed rows the drawn schema holds, at least one; the multiplied one holds a row for every handle. */
	readonly closedRows: number
	/** The texts each generated field and each bind check reads. */
	readonly texts: Arr.NonEmptyReadonlyArray<string>
}

export const caseGen: Gen<ParseCase> = (source) => {
	const drawnPatterns = Arr.dedupe(
		source.draw(array(int(0, patterns.length - 1), { min: 1, max: 3 }))
	)
	const chosen: Arr.NonEmptyReadonlyArray<number> = [
		defined(drawnPatterns[0], "a drawn pattern"),
		...Arr.drop(drawnPatterns, 1)
	]
	const fieldsOf: Gen<Arr.NonEmptyReadonlyArray<number>> = (inner) => [
		inner.draw(int(0, chosen.length - 1)),
		...inner.draw(array(int(0, chosen.length - 1), { min: 0, max: 2 }))
	]
	const drawnTexts = source.draw(array(element(texts), { min: 1, max: 24 }))
	return {
		chosen,
		relations: [source.draw(fieldsOf), ...source.draw(array(fieldsOf, { min: 0, max: 3 }))],
		copies: source.draw(int(2, 3)),
		closedRows: source.draw(int(1, 2)),
		texts: [defined(drawnTexts[0], "a drawn text"), ...Arr.drop(drawnTexts, 1)]
	}
}

export const patternAt = (c: ParseCase, place: number): Pattern =>
	defined(patterns[defined(c.chosen[place], "a chosen pattern")], "a pattern")

const descriptorOf = (p: Pattern): FieldBase =>
	p.flags === "u" ? regexField(p.source, ["u"]) : regexField(p.source, ["su"])

/**
 * The case's schema with each relation copied `copies` times and `rows` closed rows: relation r's copy k, R{r}c{k},
 * holds an id, its text fields t{i}, and m, generated as whether its first text matches its pattern's match.
 */
export const schemaOf = (c: ParseCase, copies: number, rows: number) => {
	const relations = Arr.flatMap(c.relations, (fields, r) =>
		Arr.map(indices(copies), (k) => {
			const name = `R${r}c${k}`
			const written: Readonly<Record<string, FieldBase>> = {
				id: uuid,
				...Rec.fromEntries(
					Arr.map(fields, (t, i) => [`t${i}`, descriptorOf(patternAt(c, t))] as const)
				)
			}
			const match = patternAt(c, fields[0]).match
			const R = generatedRelation(
				name,
				written,
				["id"],
				(row: Readonly<Record<string, unknown>>) => ({
					m: generatedField(
						pg.boolean,
						computeCore.cond(
							computeCore.matches(row["t0"], computeCore.pattern(match)),
							computeCore.literal(pg.boolean, true),
							computeCore.literal(pg.boolean, false)
						),
						[]
					)
				}),
				[]
			)
			return [name, R] as const
		})
	)
	const Kind = closed("Kind", ["A", "B", "C", "D"], [])
	const Labels = closedRelation(
		"Labels",
		{ kind: admittedClosedId(Kind), label: descriptorOf(patternAt(c, 0)) },
		["kind"],
		Arr.map(Arr.take(handles, rows), (kind) => ({ kind, label: patternAt(c, 0).member })),
		[]
	)
	return schema("Parsed", [Kind, Labels, ...Rec.values(Rec.fromEntries(relations))], [], [])
}

export const parseSites = Object.freeze({
	admitted: { file: "packages/engine/src/scalar/regex/patterns.ts", name: "admittedParse" },
	parsed: { file: "packages/engine/src/scalar/regex/parse.ts", name: "parsePattern" }
})

export type ParseFeature =
	| "one pattern"
	| "several patterns"
	| "a relation of several texts"
	| "several closed rows"
	| "a dotall pattern"
	| "a match that holds"
	| "a match that fails"
