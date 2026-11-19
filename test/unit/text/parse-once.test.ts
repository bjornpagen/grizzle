/**
 * An admitted pattern is parsed where a program compiles, never where it runs (scalar/regex/patterns.ts): a law model's
 * compile parses each pattern once in each table it holds, so its parses are a function of the distinct patterns its
 * schema declares and matches, whatever reads them; and the host's per-row reads, a generated field's match over a row,
 * parse none, reading the compiled table (LawModel.patterns). A parameter's pattern is PostgreSQL's to check, by its
 * own pattern domain, so no bind reads one.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts). Each
 * case draws the distinct patterns, relations whose text fields declare them and whose generated field matches a
 * pattern against the first, a closed relation's rows, and the texts the host reads. The schema compiles as drawn and
 * with every reader multiplied, each relation copied and every closed row held, and the two compiles' parses agree.
 * Then each relation's generated field is evaluated over every text, with no parse at all, each answer the reference's
 * (oracle/reference/evaluate.ts patternMember). And rowEvaluator over the schema, each relation's row of its members
 * evaluated as a row of one selection of it and then, by an evaluator of its own, of several, each its own source over
 * the one predicate, parses each pattern once, however many of its sources read it: its sources share one table.
 *
 * Features: one pattern and several, a relation of several texts, several closed rows, a dotall pattern, a match that
 * holds and one that fails.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { closedLeaf, evaluatedRelation, hostEvaluator } from "#compiler/runtime/write/fill.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	caseGen,
	evaluatorCaseOf,
	handles,
	type ParseFeature,
	parseSites,
	patternAt,
	schemaOf
} from "#test/unit/text/parse-once.fixtures.ts"

/** An admitted pattern is parsed where its program compiles, once a table whatever reads it, and never per row. Its budget is its suite's before it was a property (test/unit/text/parse-once.test.ts at 4ca3036a): 40 runs and 40 steered cases. */
export const anAdmittedPatternIsParsedWhereItsProgramCompilesOnceATableWhateverReadsItAndNeverPerRow =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"one pattern",
			"several patterns",
			"a relation of several texts",
			"several closed rows",
			"a dotall pattern",
			"a match that holds",
			"a match that fails"
		] satisfies ReadonlyArray<Reached<ParseFeature>>,
		check: (_, k: Case<ParseFeature>) => (c) =>
			Effect.gen(function* () {
				const drawnOwned = succeeded(ownedInput(schemaOf(c, 1, c.closedRows)), "it owns")
				const multipliedOwned = succeeded(
					ownedInput(schemaOf(c, c.copies, handles.length)),
					"the multiplied schema owns"
				)
				const [model, drawnCounts] = yield* callCounts(
					Effect.sync(() => compileLaws(drawnOwned, everySlice(drawnOwned), { kind: "planned" })),
					parseSites
				)
				const [, multipliedCounts] = yield* callCounts(
					Effect.sync(() =>
						compileLaws(multipliedOwned, everySlice(multipliedOwned), { kind: "planned" })
					),
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
				const evaluate = hostEvaluator(closedLeaf(new Map()), laws.patterns)
				const relations = Arr.map(c.relations, (fields, r) => {
					const relation = defined(laws.checked.relations.get(`R${r}c0`), "a checked relation")
					const fieldOf = (name: string) =>
						defined(
							Arr.findFirst(relation.fields, (f) => f.name === name).pipe(Option.getOrUndefined),
							`the field ${name}`
						)
					const writing = fieldOf("m").writing
					const generated =
						writing.kind === "generated" ? writing.expr : assert.fail("m is generated")
					return {
						relation,
						evaluated: evaluatedRelation(relation.fields, codes),
						fields,
						generated
					}
				})
				const [answers, rowCounts] = yield* callCounts(
					Effect.sync(() =>
						Arr.map(relations, ({ evaluated, generated }) => ({
							matched: Arr.map(c.texts, (text) =>
								evaluate(evaluated, predicateTable(generated), (field) =>
									field === "t0" ? text : undefined
								)
							)
						}))
					),
					parseSites
				)
				assert.equal(rowCounts.parsed, 0, "no pattern is parsed per row")
				Arr.forEach(relations, ({ fields, relation }, r) => {
					const answer = defined(answers[r], "a relation's answers")
					const match = patternAt(c, fields[0]).match
					Arr.forEach(c.texts, (text, j) => {
						const matched = defined(answer.matched[j], "a match")
						const expected = patternMember({ patterns: [{ source: match, flags: "u" }] }, text)
						k.note(expected ? "a match that holds" : "a match that fails")
						assert.ok(
							matched.ok && matched.value === expected,
							`${relation.name}.m over ${Formatter.format(text)}: ${Formatter.format(matched)}`
						)
					})
				})
				const evaluatorRun = (selections: number) =>
					callCounts(
						Effect.sync(() => {
							const built = evaluatorCaseOf(c, selections)
							const evaluate = succeeded(
								rowEvaluator(built.schema),
								"rowEvaluator compiles the schema"
							)
							return Arr.map(built.relations, ({ R, match, member, row, selections: sources }) => {
								const admitted = evaluate.admit(R, row)
								return {
									expected: patternMember({ patterns: [{ source: match, flags: "u" }] }, member),
									selected: Arr.map(sources, (source) =>
										Result.isSuccess(admitted)
											? evaluate(source, admitted.success).selected
											: assert.fail(
													`a row of each member, inside its domains: ${Formatter.format(admitted)}`
												)
									)
								}
							})
						}),
						parseSites
					)
				const [, oneCounts] = yield* evaluatorRun(1)
				const [evaluated, manyCounts] = yield* evaluatorRun(c.copies)
				assert.equal(
					manyCounts.admitted,
					oneCounts.admitted,
					"an evaluator parses each pattern once, however many of its sources read it"
				)
				Arr.forEach(evaluated, ({ expected, selected }) =>
					Arr.forEach(selected, (s) =>
						assert.ok(
							Result.isSuccess(s) && s.success === expected,
							`a selection by its match: ${Formatter.format(s)}`
						)
					)
				)
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
			}),
		oracle: {
			kind: "specification",
			name: "no parse per row; a compile's parses a function of its distinct patterns"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original: "\t\tthis.parse({ source, flags: matchFlags }).matcher.matches(text)\n\n\t/**",
				replacement:
					"\t\tadmittedParse({ source, flags: matchFlags }).matcher.matches(text)\n\n\t/**",
				why: "A compiled table's match parses its pattern on every call; the host's per-row reads parse, and the property fails."
			}
		]
	})
