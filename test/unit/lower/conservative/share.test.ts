/**
 * A term's shared subterms are evaluated once on every path (lower/conservative/expr/share.ts), and the rewrite keeps the
 * term's value on every row, NULL included.
 *
 * Each case draws a world of closed relations over two rosters, some keys held by no row (test/support/null/language.ts
 * World), one to five rows of it, and a generated field g built to read one subterm more than once
 * (share.fixtures.ts ShareShape): a predicate never NULL in two conditionals, a closed read of a flag compared to
 * literals in a chain, or in two conditionals, bare where Pick holds no row at the row's kind and under that presence,
 * two arms of one context, a chain guarded by Pick's presence whose ELSE arm is the chain at a flag Pick holds (shape
 * D's), or a drawn term. Beside it, h generates the shared subterm alone, so its SQL is the subterm's as the site prints it.
 *
 * - Meaning: the host evaluates g's expression and its rewrite, every rewrite a split or a factoring may take accepted
 *   (a size that never refuses), to one result at every row, a value, NULL or no value alike (scalar/compute/evaluate.ts).
 * - Work: in g's installed column, the shared predicate of "a boolean twice" and the flag of "a flag compared twice"
 *   occur once in the text, so on every path they are evaluated at most once, where unshared they are read twice
 *   (where a drawn arm reads the subterm itself, that read is the arm's own, and the case claims nothing of it).
 *
 * Oracle: the term's own value, the host's evaluation of the expression before the rewrite; and the count of the shared
 * subterm's SQL in the column's.
 *
 * Features: each shape, a shared subterm printed once, a NULL shared read and one beside the flags Pick holds, a NULL
 * value and a value, several rows.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { agree, exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import { persistentClosed } from "#compiler/physical/ddl/expr.ts"
import { compiledExpr, type EvalLeaves, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { hostColumns } from "#test/support/null/build.ts"
import { evalTerm, type Item, silent } from "#test/support/null/language.ts"
import {
	armsReadShared,
	caseGen,
	generatedExpr,
	generatedSql,
	installationOfCase,
	occurrences,
	type ShareCase,
	type ShareFeature,
	sharedSql
} from "#test/unit/lower/conservative/share.fixtures.ts"

/** What the host evaluates `expr` to at row `id`, as text: its value, NULL, or why it has none. */
const hostAt =
	(expr: ScalarExpr, closed: EvalLeaves["closed"]) =>
	(item: Item, id: number): string => {
		const table = predicateTable(expr)
		const value = compiledExpr(table)(
			{ value: undefined, column: hostColumns(item, id), closed },
			ProgramPatterns.of(tablePatterns(table))
		)
		return value.ok
			? value.value === sqlNull
				? "NULL"
				: Formatter.format(value.value)
			: `no value: ${Formatter.format(value.error)}`
	}

/** A term's shared subterms are evaluated once: its rewrite keeps its value at every row, and its column reads them once. */
export const aTermsSharedSubtermsAreEvaluatedOnceItsRewriteKeepsItsValueAtEveryRowAndItsColumnReadsThemOnce =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a boolean twice",
			"a flag compared twice",
			"a flag in two conditionals",
			"a guarded flag",
			"two arms of one context",
			"a guarded chain",
			"a drawn term",
			"a shared subterm printed once",
			"a NULL shared read",
			"a NULL flag beside the flags Pick holds",
			"a NULL value",
			"a value",
			"several rows"
		] satisfies ReadonlyArray<Reached<ShareFeature>>,
		check: (_, k: Case<ShareFeature>) => (sc: ShareCase) =>
			Effect.gen(function* () {
				k.note(sc.shape)
				const installation = installationOfCase(sc)
				const closed = persistentClosed(installation.checked)
				const g = generatedExpr(installation, "g")
				const rewritten = sharedExpr(g, {
					closed: installation.names.closedRelations,
					size: () => 0
				})
				const before = hostAt(g, closed)
				const after = hostAt(rewritten, closed)
				for (const [id, item] of sc.items.entries()) {
					const at = `row ${id} of ${Formatter.format(sc)}`
					yield* agree(
						[
							[`g's expression at ${at}`, before(item, id)],
							["its rewrite", after(item, id)]
						],
						exact
					)
					k.note(evalTerm(sc.world, item, sc.term, silent) === null ? "a NULL value" : "a value")
					if (sc.shared.kind === "flag" && sc.world.pick[item.kind] === undefined) {
						k.note("a NULL shared read")
						if (
							sc.shape === "a flag in two conditionals" &&
							Arr.some(sc.world.pick, (p) => p !== undefined)
						) {
							k.note("a NULL flag beside the flags Pick holds")
						}
					}
				}
				if (sc.items.length > 1) {
					k.note("several rows")
				}
				if (
					(sc.shape === "a boolean twice" || sc.shape === "a flag compared twice") &&
					!armsReadShared(sc)
				) {
					const column = generatedSql(installation, "g")
					const shared = sharedSql(installation, sc)
					const count = shared === undefined ? 0 : occurrences(column, shared)
					assert.ok(
						count <= 1,
						`g's column reads its shared subterm ${shared} at most once, not ${count} times: ${column}`
					)
					if (count === 1) {
						k.note("a shared subterm printed once")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the host's evaluation of the expression before the rewrite; the shared subterm's SQL counted in the column's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\t\tthis.#nonNullAt(s, facts) &&\n",
				replacement: "\t\t\t\t\ttrue &&\n",
				why: "A split takes a subterm that may be NULL: a NULL flag reaches the ELSE arm, the arm of the last value, where the term's own conditionals take their ELSE arms, so the rewrite's value differs at a row Pick holds no row for."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\t\t(isBoolean(s) || this.#valuesOf(s) !== undefined) &&\n",
				replacement: "\t\t\t\t\tthis.#valuesOf(s) !== undefined &&\n",
				why: "No split takes a boolean: a predicate read in two conditionals is printed in each, twice in g's column."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\tif (a === pair.a && b === pair.b) {\n\t\t\treturn hole\n",
				replacement: "\t\tif (a === pair.a && b === pair.b) {\n\t\t\treturn pair.a\n",
				why: "A factoring keeps the THEN arm's part where the arms differ: cond(p, greatest(X, 0), greatest(Y, 0)) becomes greatest(X, 0), which differs where p does not hold."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\t\t\t\tholdsFirst ? this.#cond(c, x, k, x) : this.#cond(c, k, x, x),\n",
				replacement:
					"\t\t\t\t\t\t\tholdsFirst ? this.#cond(c, k, x, x) : this.#cond(c, x, k, x),\n",
				why: "A factoring of an arm that is the other at a constant puts the constant on the wrong side: the guarded chain reads the flag `k` where Pick holds the row and the row's own flag where it holds none."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: "\t\t\t\tconst simple = simpleCase(chain, lower)\n",
				replacement: "\t\t\t\tconst simple = undefined\n",
				why: "A chain of equalities prints as conditionals, each comparing its subject again: the flag of a chain is printed once per comparison."
			}
		]
	})
