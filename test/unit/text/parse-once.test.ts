/**
 * An admitted pattern is parsed where a program compiles, never where it runs (scalar/regex/patterns.ts): a law model's
 * compile holds one table (analysis/schema.ts CheckedSchema `patterns`), so it parses, builds the automaton of and
 * minimizes each distinct pattern its schema declares and matches once, and analyzes each conjunction its guards type
 * once, whatever reads them: its closed rows' membership, its closed pattern payload's admission (check/closed.ts), its
 * guards' typing (text/refinement.ts AnalyzedPatterns `language`) and its compiled program's table (laws/model/model.ts
 * lawPatterns). The host's per-row reads, a generated field's match over a row, parse none, reading the compiled table
 * (LawModel.patterns). A parameter's pattern is PostgreSQL's to check, by its own pattern domain, so no bind reads one.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts). Each
 * case draws the distinct patterns, relations whose text fields declare them and whose generated fields match a pattern
 * against the first, plain, as a guard, and as the closed relation Rules holds it at the row's kind, a closed
 * relation's rows, and the texts the host reads. The schema compiles as drawn and with every reader multiplied, each
 * relation copied and every closed row held: the drawn compile's parses, automata and minimizations are at most one for
 * each distinct pattern, its analyses at most one for each distinct conjunction, and the two compiles' counts agree.
 * Then each relation's generated field is evaluated over every text, with no parse at all, each answer the reference's
 * (oracle/reference/evaluate.ts patternMember). And rowEvaluator over the schema, each relation's row of its members
 * evaluated as a row of one selection of it and then, by an evaluator of its own, of several, each its own source over
 * the one predicate, parses each pattern once, however many of its sources read it: its sources share one table.
 *
 * Features: one pattern and several, a relation of several texts, several closed rows, a dotall pattern, a match that
 * holds and one that fails.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { closedLeaf, evaluatedRelation, hostEvaluator } from "#compiler/runtime/write/fill.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	caseGen,
	distinctConjunctions,
	distinctPatterns,
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
				assert.ok(drawnCounts.parsed > 0, "the compile parses its patterns")
				for (const work of ["parsed", "automata", "minimized"] as const) {
					assert.ok(
						drawnCounts[work] <= distinctPatterns(c),
						`${drawnCounts[work]} ${work} for ${distinctPatterns(c)} distinct patterns: one at most for each`
					)
				}
				assert.ok(
					drawnCounts.analyzed <= distinctConjunctions(c),
					`${drawnCounts.analyzed} analyses for ${distinctConjunctions(c)} distinct conjunctions: one at most for each`
				)
				assert.deepEqual(
					multipliedCounts,
					drawnCounts,
					"a compile's parses, automata, minimizations and analyses are the same however many readers its patterns have"
				)
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
						evaluated: evaluatedRelation(relation.fields),
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
				assert.equal(rowCounts.automata, 0, "no automaton is built per row")
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
				const evaluatorRun = (selections: number) => {
					const built = evaluatorCaseOf(c, selections)
					return callCounts(
						Effect.sync(() => {
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
				}
				const [, oneCounts] = yield* evaluatorRun(1)
				const [evaluated, manyCounts] = yield* evaluatorRun(c.copies)
				assert.equal(
					manyCounts.parsed,
					oneCounts.parsed,
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
			name: "no parse per row; a compile's parses, automata and minimizations at most one for each distinct pattern, its analyses one for each conjunction, whatever reads them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original: "\t\tthis.#parse({ source, flags: matchFlags }).matcher.matches(text)\n\n\t/**",
				replacement:
					"\t\tnew CompilePatterns().parse({ source, flags: matchFlags }).matcher.matches(text)\n\n\t/**",
				why: "A compiled table's match parses its pattern on every call; the host's per-row reads parse, and the property fails."
			},
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original:
					"\t\treturn bySource.getOrInsertComputed(pattern.source, () => new PatternEntry(pattern))",
				replacement: "\t\treturn new PatternEntry(pattern)",
				why: "A compile's table enters a pattern again at each read: a pattern its closed rows, its guards and its program read is parsed, built and minimized once for each, past one for each distinct pattern."
			},
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original: ".getOrInsertComputed(pattern.source, () => compile.parse(pattern))",
				replacement:
					".getOrInsertComputed(pattern.source, () => new CompilePatterns().parse(pattern))",
				why: "A compiled program parses its patterns afresh where its compile's table parsed them: every pattern its closed rows or its Rules admitted is parsed twice."
			},
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original: "\t\tthis.#entry({ source, flags: matchFlags }).value()",
				replacement: "\t\tnew PatternEntry({ source, flags: matchFlags }).value()",
				why: "A closed pattern payload is admitted outside its compile's table (check/closed.ts), so the compiled program parses every pattern Rules holds again."
			},
			{
				file: "packages/engine/src/text/refinement.ts",
				original:
					"\t\tthis.#languages.getOrInsertComputed(\n\t\t\tpatterns.flatMap((p) => [p.flags, p.source]),\n\t\t\t() => languageIn(patterns, this)\n\t\t)",
				replacement: "\t\tlanguageIn(patterns, this)",
				why: "A compile analyzes a conjunction again at each guard that types it: the copied relations' guards analyze it once a copy, and the counts differ."
			}
		]
	})
