/**
 * An admitted pattern is parsed where a program compiles, never where it runs (scalar/regex/patterns.ts): a law model's
 * compile parses each pattern once in each table it holds, so its parses are a function of the distinct patterns its
 * schema declares and matches, whatever reads them; and the host's per-row reads, a generated field's match over a row
 * and a refined parameter's bind check, parse none, reading the compiled table (LawModel.patterns, codec/scalar.ts
 * refinedMember).
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts). Each
 * case draws the distinct patterns, relations whose text fields declare them and whose generated field matches a
 * pattern against the first, a closed relation's rows, and the texts the host reads. The schema compiles as drawn and
 * with every reader multiplied, each relation copied and every closed row held, and the two compiles' parses agree.
 * Then each relation's generated field is evaluated over every text and each refined field's bind check judges every
 * text, with no parse at all, each answer the reference's (oracle/reference/evaluate.ts patternMember).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { paramEncoder } from "#compiler/codec/scalar.ts"
import { indices } from "#compiler/core/array.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { admittedClosedId } from "#compiler/scalar/closed-id.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { everyWrite } from "#compiler/schema/reach.ts"
import {
	closed,
	closedRelation,
	generatedField,
	generatedRelation
} from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { closedLeaf, hostEvaluator } from "#compiler/write/family/fold.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { ownedInput } from "#test/support/policy.ts"

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
const handles: Arr.NonEmptyReadonlyArray<string> = ["A", "B", "C", "D"]

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

const caseGen: Gen<ParseCase> = (source) => {
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

const patternAt = (c: ParseCase, place: number): Pattern =>
	defined(patterns[defined(c.chosen[place], "a chosen pattern")], "a pattern")

const descriptorOf = (p: Pattern): FieldBase =>
	p.flags === "u" ? regexField(p.source, ["u"]) : regexField(p.source, ["su"])

/**
 * The case's schema with each relation copied `copies` times and `rows` closed rows: relation r's copy k, R{r}c{k},
 * holds an id, its text fields t{i}, and m, generated as whether its first text matches its pattern's match.
 */
const schemaOf = (c: ParseCase, copies: number, rows: number) => {
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
							computeCore.matches(row["t0"], match),
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
	return schema("Parsed", { Kind, Labels, ...Rec.fromEntries(relations) }, [], [])
}

const parseSites = {
	admitted: { file: "packages/engine/src/scalar/regex/patterns.ts", name: "admittedParse" },
	parsed: { file: "packages/engine/src/scalar/regex/parse.ts", name: "parsePattern" }
}

type ParseFeature =
	| "one pattern"
	| "several patterns"
	| "a relation of several texts"
	| "several closed rows"
	| "a dotall pattern"
	| "a match that holds"
	| "a match that fails"
	| "a refused bind"

describe("an admitted pattern", () => {
	it.effect(
		"is parsed where its program compiles, once a table whatever reads it, and never per row",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "no parse per row or bind; a compile's parses a function of its distinct patterns"
						},
						suite: "unit/text/parse-once",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<ParseFeature>(
							[
								"one pattern",
								"several patterns",
								"a relation of several texts",
								"several closed rows",
								"a dotall pattern",
								"a match that holds",
								"a match that fails",
								"a refused bind"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const drawnOwned = succeeded(ownedInput(schemaOf(c, 1, c.closedRows)), "it owns")
							const multipliedOwned = succeeded(
								ownedInput(schemaOf(c, c.copies, handles.length)),
								"the multiplied schema owns"
							)
							const [model, drawnCounts] = yield* callCounts(
								Effect.sync(() => compileLaws(drawnOwned, everyWrite(drawnOwned))),
								parseSites
							)
							const [, multipliedCounts] = yield* callCounts(
								Effect.sync(() => compileLaws(multipliedOwned, everyWrite(multipliedOwned))),
								parseSites
							)
							const laws = succeeded(model, "the schema compiles")
							assert.ok(drawnCounts.admitted > 0, "the compile parses its patterns")
							assert.equal(
								multipliedCounts.admitted,
								drawnCounts.admitted,
								"a compile's parses are the same however many readers its patterns have"
							)
							const codes = firstCodebook(rostersOf(drawnOwned))
							const evaluate = hostEvaluator(codes, closedLeaf(new Map()), laws.patterns)
							const relations = Arr.map(c.relations, (fields, r) => {
								const relation = defined(
									laws.checked.relations.get(`R${r}c0`),
									"a checked relation"
								)
								const fieldOf = (name: string) =>
									defined(
										Arr.findFirst(relation.fields, (f) => f.name === name).pipe(
											Option.getOrUndefined
										),
										`the field ${name}`
									)
								const writing = fieldOf("m").writing
								const generated =
									writing.kind === "generated" ? writing.expr : assert.fail("m is generated")
								const encoders = Arr.map(fields, (_, i) =>
									paramEncoder(fieldOf(`t${i}`).type, `t${i}`, codes)
								)
								return { relation, fields, generated, encoders }
							})
							const [answers, rowCounts] = yield* callCounts(
								Effect.sync(() =>
									Arr.map(relations, ({ relation, generated, encoders }) => ({
										matched: Arr.map(c.texts, (text) =>
											evaluate(relation, generated, (field) => (field === "t0" ? text : undefined))
										),
										bound: Arr.map(encoders, (encode) =>
											Arr.map(c.texts, (text) => encode(text).ok)
										)
									}))
								),
								parseSites
							)
							assert.equal(rowCounts.parsed, 0, "no pattern is parsed per row or per bind")
							Arr.forEach(relations, ({ fields, relation }, r) => {
								const answer = defined(answers[r], "a relation's answers")
								const match = patternAt(c, fields[0]).match
								Arr.forEach(c.texts, (text, j) => {
									const matched = defined(answer.matched[j], "a match")
									const expected = patternMember(
										{ patterns: [{ source: match, flags: "u" }] },
										text
									)
									k.note(expected ? "a match that holds" : "a match that fails")
									assert.ok(
										matched.ok && matched.value === expected,
										`${relation.name}.m over ${Formatter.format(text)}: ${Formatter.format(matched)}`
									)
								})
								Arr.forEach(fields, (t, i) => {
									const pattern = patternAt(c, t)
									Arr.forEach(c.texts, (text, j) => {
										const bound = defined(answer.bound[i]?.[j], "a bind")
										if (!bound) {
											k.note("a refused bind")
										}
										assert.equal(
											bound,
											patternMember(
												{ patterns: [{ source: pattern.source, flags: pattern.flags }] },
												text
											),
											`${relation.name}.t${i}'s bind of ${Formatter.format(text)}`
										)
									})
								})
							})
							k.note(c.chosen.length === 1 ? "one pattern" : "several patterns")
							if (Arr.some(c.relations, (fields) => fields.length > 1)) {
								k.note("a relation of several texts")
							}
							if (c.closedRows > 1) {
								k.note("several closed rows")
							}
							if (Arr.some(indices(c.chosen.length), (i) => patternAt(c, i).flags === "su")) {
								k.note("a dotall pattern")
							}
						})
				)
			)
	)
})
