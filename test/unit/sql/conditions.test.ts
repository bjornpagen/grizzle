/**
 * A query's conditions are rewritten by the one walk of them (sql/transform.ts conditionsRewritten): each core's WHERE
 * and each on or left join's ON, at every depth a derived table reaches, exactly once, each beside its own core's whole
 * FROM, and nothing else; and a rewrite that keeps every condition keeps the query itself. seekingSuffixes
 * (sql/suffix.ts) rewrites through it.
 *
 * Each case draws a core of one to three FROM items, each a table, a derived table over a core of its own (two levels
 * down at most) or a join chain of one to three on, left and cross steps, with or without a WHERE. Its conditions are
 * numbered equalities, and the rewrite marks a condition with the count of its core's FROM items.
 *
 * Oracle: the query built from the case's shape with each condition marked in place, a second construction, printed.
 *
 * Features: a WHERE, an on join, a left join, a cross join, a join chain beside another item, and a derived table's
 * core with a condition.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { printStatement } from "#compiler/sql/print.ts"
import { conditionsRewritten } from "#compiler/sql/transform.ts"
import {
	caseGen,
	type ConditionFeature,
	type CoreShape,
	conditionFeatures,
	featuresOf,
	marked,
	queryOf
} from "#test/unit/sql/conditions.fixtures.ts"

/** Every condition of a query is rewritten once, beside its core's FROM, and a kept rewrite keeps the query. */
export const everyConditionOfAQueryIsRewrittenOnceBesideItsCoresFrom = property.explore(caseGen, {
	needs: {},
	situations: conditionFeatures,
	check: (_, k: Case<ConditionFeature>) => (c: CoreShape) =>
		Effect.sync(() => {
			for (const feature of featuresOf(c)) {
				k.note(feature)
			}
			const query = queryOf(c, (e) => e)
			assert.equal(
				printStatement(conditionsRewritten(query, (e, from) => marked(e, from.length))),
				printStatement(queryOf(c, marked)),
				`${Formatter.format(c)}: each condition marked in place, beside its core's FROM`
			)
			assert.equal(
				conditionsRewritten(query, (e) => e) === query,
				true,
				`${Formatter.format(c)}: a rewrite that keeps every condition keeps the query`
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the case's query built again with each condition marked in place"
	},
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/transform.ts",
			original: "\t\t\t\t\t\t\tconst on = rewrite(s.on, core.from)\n",
			replacement: "\t\t\t\t\t\t\tconst on = s.on\n",
			why: "A join's ON left as it was: suffix.ts's walk rewrote the ONs, so a seek joined on a suffix test would lose its range."
		},
		{
			file: "packages/engine/src/sql/transform.ts",
			original: "\t\t\t\t\t\t\tconst on = rewrite(s.on, core.from)\n",
			replacement: "\t\t\t\t\t\t\tconst on = rewrite(s.on, [item])\n",
			why: "An ON read beside its join chain alone: a condition over a column of another FROM item finds no origin."
		},
		{
			file: "packages/engine/src/sql/transform.ts",
			original:
				"\t\t\tconst where = core.where === undefined ? undefined : rewrite(core.where, core.from)\n",
			replacement: "\t\t\tconst where = core.where\n",
			why: "The WHERE left as it was."
		},
		{
			file: "packages/engine/src/sql/transform.ts",
			original: '\t\t\t\t\t\tcase "on":\n\t\t\t\t\t\tcase "left": {\n',
			replacement: '\t\t\t\t\t\tcase "left":\n\t\t\t\t\t\t\treturn s\n\t\t\t\t\t\tcase "on": {\n',
			why: "A left join's ON left as it was."
		},
		{
			file: "packages/engine/src/sql/transform.ts",
			original:
				"\t\t\treturn where === core.where && from.every((item, i) => item === core.from[i])\n\t\t\t\t? core\n",
			replacement: "\t\t\treturn false\n\t\t\t\t? core\n",
			why: "A core rebuilt where no condition changed: the query is a new one, which every reader that keeps a query it was handed compares by identity."
		}
	]
})
