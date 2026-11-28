import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	blogOf,
	boundPart,
	built,
	caseGen,
	equalValuesTwice,
	type Feature,
	hostAnswer,
	keyOf,
	matchesComment,
	referenceAnswer,
	refusalOf,
	situations
} from "#test/unit/check/folds.fixtures.ts"

/** A fold reads each fact it matches once, by a key is refused exactly where a match binds no key of its source, and otherwise folds every matched fact. Its budget is its suite's before it was a property (test/unit/check/folds.test.ts at 4ca3036a): 400 runs and 2000 steered cases. */
export const aFoldReadsEachFactItMatchesOnceByAKeyIsRefusedExactlyWhereAMatchBindsNoKeyOfItsSourceAndOtherwiseFoldsEveryMatchedFact =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 400, steered: 2000 },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (c) =>
			Effect.sync(() => {
				const b = built(c)
				const checked = checkAuthored(
					checking(blogOf(c.commentKey)),
					b.query,
					checkOptions("query")
				)
				const twoFields = c.commentKey.length === 2 && matchesComment(c)
				if (b.refusedAt !== undefined) {
					assert.equal(checked.ok, false, "a fold over a projection is refused")
					if (checked.ok) {
						return
					}
					const refusal = refusalOf(checked.error.reason)
					assert.deepEqual(
						refusal === undefined
							? undefined
							: { aggregate: refusal.aggregate, source: refusal.source, key: refusal.key },
						{ aggregate: c.fn, source: b.refusedAt, key: keyOf(c, b.refusedAt) },
						"the refusal names the aggregate as written, the match's source and its key"
					)
					if (twoFields && b.refusedAt === "Comment" && boundPart(c)) {
						k.note("refused a key of two fields bound in part")
					}
					k.note(`refused ${c.fn}`)
					k.note(`refused ${c.shape.kind}`)
					return
				}
				assert.equal(checked.ok, true, "a fold over keyed facts is admitted")
				if (!checked.ok) {
					return
				}
				k.note(`admitted ${c.fn}`)
				k.note(`admitted ${c.shape.kind}`)
				if (twoFields) {
					k.note("admitted a key of two fields")
				}
				if (c.constant) {
					k.note("a constant beside the fold")
				}
				if (c.shape.kind === "attached") {
					return
				}
				if (c.fn === "sum" && equalValuesTwice(c, b)) {
					k.note("equal values summed twice")
				}
				const root = checked.value.dag.roots[0]
				assert.deepEqual(
					referenceAnswer(root, checked.value.dag, c, b),
					hostAnswer(c, b),
					"the checked fold's answer is the host's fold over every matched fact"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the key rule turned into a checker, and the host's fold over the matched facts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\t\t\taggregates[0].head.fn",
				replacement: '\t\t\t\t\t"sum"',
				why: "The refusal names a sum whatever the head folds (check/checker.ts groupNode): a count over an unkeyed match is refused as a sum, which its author never wrote."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\tconst key = keys.find((k) => k.every((f) => bound.has(f)))",
				replacement: "\t\t\tconst key = keys.find((k) => k.some((f) => bound.has(f)))",
				why: "A match binding part of a key is read as keyed (check/checker.ts foldInput); the refusal oracle fails."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\t\t\t\tgroupHeading.filter((c) => !hiddenNames.has(c.name)).map((c) => c.name)",
				replacement:
					'\t\t\t\t\taggs.every((a) => a.spec.fn === "sum")\n\t\t\t\t\t\t? [\n\t\t\t\t\t\t\t\t...keyColumns.map((c) => c.name),\n\t\t\t\t\t\t\t\t...aggs.flatMap((a) =>\n\t\t\t\t\t\t\t\t\ta.spec.args.flatMap((e) => (e.kind === "column" ? [e.column.name] : []))\n\t\t\t\t\t\t\t\t)\n\t\t\t\t\t\t\t]\n\t\t\t\t\t\t: groupHeading.filter((c) => !hiddenNames.has(c.name)).map((c) => c.name)',
				why: "The checker binds a sum's fold to the tuple of its group keys and its argument, so equal values on distinct facts count once; the host fold's oracle fails at the sum arm."
			}
		]
	})
