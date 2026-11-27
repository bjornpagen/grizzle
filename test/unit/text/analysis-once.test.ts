/**
 * A text pattern is analyzed once, where its descriptor is admitted: compiling a schema, from its str.regex descriptors
 * through ownership, the law model and the installation, runs the text analysis (text/refinement.ts analyzeTextIn) and
 * its subset construction (scalar/regex/dfa.ts minimalDfa) exactly once for each distinct pattern its fields declare,
 * however many relations, keys, containments and closed rows read it. Every later reader, a key's B-tree entry, a row's
 * size, a planned UNIQUE, a text domain, reads the language the descriptor carries.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls while the compile runs
 * (kernel/calls.ts callCounts), so the guard does not depend on the machine. Each case draws the distinct patterns, the
 * relations over them, two keys a relation, a containment between relations of one pattern, and a closed relation
 * whose rows carry a pattern's value.
 *
 * Oracle: the specification, one analysis and one subset construction a distinct pattern, counted by V8's coverage.
 *
 * Features: one pattern and several, a pattern several relations read, a containment, closed rows, an unbounded
 * pattern.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import {
	admittedClosedId,
	closedBuilder as closed,
	closedRelation,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { containedBuilder, keyBuilder, onBuilder } from "#compiler/schema/statements.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	caseGen,
	containmentOf,
	type CountFeature,
	type FieldPattern,
	patterns
} from "#test/unit/text/analysis-once.fixtures.ts"

/** The text analysis runs once for each distinct pattern a schema's fields declare, whatever reads it. Its budget is its suite's before it was a property (test/unit/text/analysis-once.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const theTextAnalysisRunsOnceForEachDistinctPatternASchemasFieldsDeclareWhateverReadsIt =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"one pattern",
			"several patterns",
			"a pattern several relations read",
			"a containment",
			"closed rows",
			"an unbounded pattern"
		] satisfies ReadonlyArray<Reached<CountFeature>>,
		check: (_2, k: Case<CountFeature>) => (c) =>
			Effect.gen(function* () {
				const patternAt = (i: number): FieldPattern =>
					defined(patterns[defined(c.chosen[i], "a chosen pattern")], "a pattern")
				const [compiled, counts] = yield* callCounts(
					Effect.sync(() => {
						const descriptors = Arr.map(c.chosen, (_, i) => {
							const p = patternAt(i)
							return p.flags === "u" ? regexField(p.source, ["u"]) : regexField(p.source, ["su"])
						})
						const descriptorAt = (i: number): FieldBase =>
							defined(descriptors[i], "a pattern's descriptor")
						const statements: Array<Statement> = []
						const relations = Arr.map(c.relations, (texts, r) => {
							const fields = Rec.fromEntries(
								Arr.map(texts, (t, i): readonly [string, FieldBase] => [`t${i}`, descriptorAt(t)])
							)
							const R = relation(`R${r}`, { id: Id, ...fields }, ["id"], [])
							Arr.forEach(texts, (t, i) => {
								if (patternAt(t).bounded) {
									statements.push(
										keyBuilder(onBuilder(R, [`t${i}`])),
										keyBuilder(onBuilder(R, ["id", `t${i}`]))
									)
								}
							})
							return { name: `R${r}`, value: R }
						})
						const [source, target] = relations
						if (containmentOf(c, (t) => patternAt(t).bounded) && target !== undefined) {
							statements.push(
								containedBuilder(
									onBuilder(source.value, ["id", "t0"]),
									onBuilder(target.value, ["id", "t0"])
								)
							)
						}
						const Kind = closed("Kind", ["A", "B"], "ordered", [])
						const label = patternAt(0)
						const Labels = closedRelation(
							"Labels",
							{ kind: admittedClosedId(Kind), label: descriptorAt(0) },
							["kind"],
							Arr.map(Arr.take(["A", "B"], c.closedRows), (kind) => ({
								kind,
								label: label.member
							})),
							[]
						)
						const owned = ownedInput(
							schema(
								"Counted",
								[
									Kind,
									Labels,
									...Rec.values(
										Rec.fromEntries(Arr.map(relations, (r) => [r.name, r.value] as const))
									)
								],
								statements,
								[]
							)
						)
						return owned.ok
							? compileInstallation(
									owned.value,
									completeInstallOptions(
										owned.value,
										installationsOf(owned.value),
										[],
										[],
										firstCodebook(rostersOf(owned.value))
									)
								)
							: owned
					}),
					{
						analyzeText: {
							file: "packages/engine/src/text/refinement.ts",
							name: "analyzeTextIn"
						},
						minimalDfa: {
							file: "packages/text/src/regex/dfa.ts",
							name: "minimalDfa"
						}
					}
				)
				succeeded(compiled, "the schema compiles")
				k.note(c.chosen.length === 1 ? "one pattern" : "several patterns")
				if (
					Arr.some(
						indices(c.chosen.length),
						(t) => Arr.filter(c.relations, (texts) => texts.includes(t)).length > 1
					)
				) {
					k.note("a pattern several relations read")
				}
				if (containmentOf(c, (t) => patternAt(t).bounded)) {
					k.note("a containment")
				}
				if (c.closedRows > 0) {
					k.note("closed rows")
				}
				if (Arr.some(indices(c.chosen.length), (i) => !patternAt(i).bounded)) {
					k.note("an unbounded pattern")
				}
				assert.equal(counts.analyzeText, c.chosen.length, "one analysis a distinct pattern")
				assert.equal(
					counts.minimalDfa,
					c.chosen.length,
					"one subset construction a distinct pattern"
				)
			}),
		oracle: {
			kind: "specification",
			name: "one analysis and one subset construction a distinct pattern, counted by V8's precise coverage"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/text/field.ts",
				original: "\tconst patterns: Patterns = [Object.freeze({ source, flags: resolved })]",
				replacement:
					"\tconst patterns: Patterns = [Object.freeze({ source, flags: resolved })]\n\ttextLookup(patterns)",
				why: "str.regex analyzes its pattern a second time; the count of analyses a distinct pattern fails."
			}
		]
	})
