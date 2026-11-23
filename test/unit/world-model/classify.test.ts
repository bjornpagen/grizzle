/**
 * classifyEntry, the writable-entry rule of README "Writing through a role" restated clause by clause over the model's
 * entries, held to grizzle's own analysis (packages/engine/src/schema/entry.ts writableEntry) over every entry of a
 * small space.
 *
 * The base holds two ordinary relations P(id, v) and Q(id, w), each keyed by id, the roster K, and the context C { x }.
 * An entry's rule matches its would-be target T (P or Q), T's two fields each written by a head variable, by the same head variable as the field before, fixed by a
 * literal, a context term or a variable a context match binds, unnamed, or bound to a variable nothing else reads; its
 * head adds nothing, a literal, a context term or a second field naming a head variable; one further member joins
 * another relation, rivals T as a supplier, negates another relation or the context, compares a head variable, matches
 * the context or filters by the roster; and the entry is that rule or the same rule twice.
 *
 * Every entry is a query grizzle's builder admits, built as the executor builds an installation's entries (execute/describe.ts
 * definitionOf). The rule and the analysis find it writable or not alike; a writable one
 * alike in its target, each head field's target field and standing (keyed, claim-fixed or free), and its fills; a
 * refused one by a clause the analysis's reason allows, since the analysis scans T's fields in its own order and the
 * rule names the first failing clause in the README's.
 *
 * Every shape's head holds a field by construction: a head extra of none or a duplicate is drawn only beside a field
 * use that puts a head variable in the head, and two rules only of such uses. The oracle is a second implementation,
 * grizzle's writable-entry analysis. Features, required in the space: every refusal of the rule, every kind of further
 * member beside a writable entry, every fill and every standing of a head field.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { writableEntry } from "#compiler/schema/entry.ts"
import { definitionOf } from "#test/support/worlds/execute/describe.ts"
import { classifyEntry } from "#test/support/worlds/model/host.ts"
import {
	allowedBy,
	entryOfShape,
	fillOfFixed,
	key,
	pairBase,
	pairBuilt,
	pairDesc,
	pairSources,
	shapes,
	situations,
	verdictFeatures
} from "#test/unit/world-model/classify.fixtures.ts"

/** The writable-entry rule classifies every entry of the small space as grizzle's writable-entry analysis does. */
export const theWritableEntryRuleClassifiesEveryEntryOfTheSmallSpaceAsGrizzlesWritableEntryAnalysisDoes =
	property.exhaust(finite(shapes), {
		needs: {},
		situations: situations,
		check: (_, c) => (s) =>
			Effect.gen(function* () {
				const entry = entryOfShape(s)
				const what = Formatter.format(s)
				const built = yield* Effect.result(
					definitionOf(pairBase, pairSources, entry.rules, pairBuilt.base, what)
				)
				if (Result.isFailure(built)) {
					return assert.fail(`the builder refuses the entry, ${built.failure.message}: ${what}`)
				}
				const analysed = writableEntry(
					pairDesc,
					{
						name: "Entry",
						query: defined(queryValueDesc(built.success), `the Description of ${what}`)
					},
					{ kind: "probed" }
				)
				const actual = classifyEntry(pairBase, entry)
				if (!analysed.ok) {
					assert.equal(
						actual.kind,
						"read-only",
						`the analysis refuses ${analysed.error.reason.kind}: ${what}`
					)
					if (actual.kind === "read-only") {
						assert.ok(
							Arr.contains(allowedBy(analysed.error.reason, key), actual.reason),
							`the rule names ${actual.reason}, the analysis ${analysed.error.reason.kind}: ${what}`
						)
					}
				} else {
					const w = analysed.value
					assert.deepEqual(
						actual,
						{
							kind: "writable",
							target: w.target,
							head: Rec.fromEntries(
								Arr.map(
									[...w.head],
									([name, h]) => [name, { field: h.field, kind: h.kind }] as const
								)
							),
							fills: Rec.fromEntries(
								Arr.map(w.fixed, (f) => [f.field, fillOfFixed(f.value)] as const)
							)
						},
						`the rule writes the entry as the analysis does: ${what}`
					)
				}
				c.noteAll(verdictFeatures(s, actual))
			}),
		oracle: {
			kind: "second-implementation",
			name: "grizzle's writable-entry analysis (schema/entry.ts writableEntry)"
		},
		box: "every entry over P, Q or D of one rule, every field use, head extra and further member, or of the rule written twice, every head holding a field",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/entry.ts",
				original: "\t\t\tout.getOrInsert(relation.name, relation)",
				replacement: "\t\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/schema/entry.ts:138 in relationsOf: `out.set(relation.name, relation)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6). Restated over its getOrInsert spelling (lane UNIFY7)."
			}
		]
	})
