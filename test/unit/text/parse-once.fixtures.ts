/** What the properties of parse-once.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	admittedClosedId,
	closedRelation,
	generatedField,
	generatedRelation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { selectBuilder } from "#compiler/schema/statements.ts"
import { regexField, str } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { Id } from "#test/support/ids.ts"

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
 * The closed relations a schema of the case holds, built afresh for each schema, so no description holds an admission
 * before its compile: the roster Kind; Rules, each handle's str.pattern a chosen pattern's match, in turn, which each
 * relation's p reads (C.at); and Labels, `rows` rows of the first pattern's member.
 */
const closedOf = (c: ParseCase, rows: number) => {
	const kinds = ["A", "B", "C", "D"] as const
	const Kind = closed.ordered("Kind", kinds)
	const Rules = closed.relation(
		"Rules",
		{ kind: closedId(Kind), pattern: str.pattern },
		["kind"],
		Arr.map(kinds, (kind, i) => ({ kind, pattern: patternAt(c, i % c.chosen.length).match }))
	)
	const Labels = closedRelation(
		"Labels",
		{ kind: admittedClosedId(Kind), label: descriptorOf(patternAt(c, 0)) },
		["kind"],
		Arr.map(Arr.take(handles, rows), (kind) => ({ kind, label: patternAt(c, 0).member })),
		[]
	)
	return { Kind, Rules, Labels }
}

/**
 * The case's relations, each copied `copies` times, over the closed relations `closedRelations`: relation r's copy k,
 * R{r}c{k}, holds an id, its text fields t{i}, and three generated fields: m, whether its first text matches its
 * pattern's match; w, the same match as a Logic.when guard, whose branch types its first text as of its pattern and the
 * match together (the text analysis of that conjunction, scalar/compute/typing.ts whenScope); and p, whether its first
 * text matches the pattern Rules holds at A, which reads every pattern Rules holds, whatever its key (check/closed.ts).
 */
const relationsOf = (c: ParseCase, copies: number, closedRelations: ReturnType<typeof closedOf>) =>
	Arr.flatMap(c.relations, (fields, r) =>
		Arr.map(indices(copies), (k) => {
			const name = `R${r}c${k}`
			const written: Readonly<Record<string, FieldBase>> = {
				id: Id,
				...Rec.fromEntries(
					Arr.map(fields, (t, i) => [`t${i}`, descriptorOf(patternAt(c, t))] as const)
				)
			}
			const match = patternAt(c, fields[0]).match
			const yes = computeCore.literal(pg.boolean, true)
			const no = computeCore.literal(pg.boolean, false)
			const R = generatedRelation(
				name,
				written,
				["id"],
				(row: Readonly<Record<string, unknown>>) => ({
					m: generatedField(
						pg.boolean,
						computeCore.cond(computeCore.matches(row["t0"], computeCore.pattern(match)), yes, no),
						[]
					),
					w: generatedField(
						pg.boolean,
						computeCore.when(
							computeCore.matches(row["t0"], computeCore.pattern(match)),
							() => yes,
							no
						),
						[]
					),
					p: generatedField(
						pg.boolean,
						computeCore.cond(
							computeCore.matches(row["t0"], closedRelations.Rules.at("pattern", "A")),
							yes,
							no
						),
						[]
					)
				}),
				[]
			)
			return [name, R] as const
		})
	)

/** The schema of the case's relations, `relations`, over its closed relations, `closedRelations`. */
const schemaOver = (
	relations: ReturnType<typeof relationsOf>,
	closedRelations: ReturnType<typeof closedOf>
) =>
	schema(
		"Parsed",
		[
			closedRelations.Kind,
			closedRelations.Rules,
			closedRelations.Labels,
			...Rec.values(Rec.fromEntries(relations))
		],
		[],
		[]
	)

/** The case's schema with each relation copied `copies` times and `rows` rows of Labels. */
export const schemaOf = (c: ParseCase, copies: number, rows: number) => {
	const closedRelations = closedOf(c, rows)
	return schemaOver(relationsOf(c, copies, closedRelations), closedRelations)
}

/**
 * The distinct patterns the case's schema holds, each once by its flags and source, whatever reads them: its text
 * fields' and its matches', every chosen pattern's match among Rules's rows.
 */
export const distinctPatterns = (c: ParseCase): number =>
	new Set(
		Arr.flatMap(c.chosen, (_, i) => [
			`${patternAt(c, i).flags}/${patternAt(c, i).source}`,
			`u/${patternAt(c, i).match}`
		])
	).size

/**
 * The distinct conjunctions the case's schema's guards type, each a relation's first text's pattern with its match:
 * one for each distinct pattern a first text declares.
 */
export const distinctConjunctions = (c: ParseCase): number =>
	new Set(Arr.map(c.relations, (fields) => fields[0])).size

/**
 * The case's schema as rowEvaluator reads it: each relation once, R{r}c0, as schemaOf makes it, with `selections`
 * selections of it, each its own source over one predicate, whether its first text holds a match of its pattern's
 * match, and a row of it holding each text field's member.
 */
export const evaluatorCaseOf = (c: ParseCase, selections: number) => {
	const closedRelations = closedOf(c, c.closedRows)
	const once = relationsOf(c, 1, closedRelations)
	const relations = Arr.map(c.relations, (fields, r) => {
		const [, R] = defined(once[r], `the relation R${r}c0`)
		const match = patternAt(c, fields[0]).match
		return {
			R,
			match,
			member: patternAt(c, fields[0]).member,
			row: {
				id: Id("018f0000-0000-7000-8000-000000000000"),
				...Rec.fromEntries(Arr.map(fields, (t, i) => [`t${i}`, patternAt(c, t).member] as const))
			},
			selections: Arr.map(indices(selections), () =>
				selectBuilder(R, (row: Readonly<Record<string, unknown>>) =>
					computeCore.matches(row["t0"], computeCore.pattern(match))
				)
			)
		}
	})
	return { schema: schemaOver(once, closedRelations), relations }
}

export const parseSites = Object.freeze({
	parsed: { file: "packages/text/src/regex/parse.ts", name: "parsePattern" },
	automata: { file: "packages/text/src/regex/nfa.ts", name: "buildNfa" },
	minimized: { file: "packages/text/src/regex/dfa.ts", name: "minimalDfa" },
	analyzed: { file: "packages/engine/src/text/refinement.ts", name: "analyzeTextIn" }
})

export type ParseFeature =
	| "one pattern"
	| "several patterns"
	| "a relation of several texts"
	| "several closed rows"
	| "a dotall pattern"
	| "a match that holds"
	| "a match that fails"
