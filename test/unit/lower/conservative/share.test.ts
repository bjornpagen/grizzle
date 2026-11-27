/**
 * A term's shared subterms are evaluated once on every path (lower/conservative/expr/share.ts), and the rewrite keeps the
 * term's value on every row, NULL included.
 *
 * Each case draws a world of closed relations over two rosters, some keys held by no row (test/support/null/language.ts
 * World), one to five rows of it, and a generated field g built to read one subterm more than once
 * (share.fixtures.ts ShareShape): a predicate never NULL in two conditionals, a closed read of a flag compared to
 * literals in a chain, or in two conditionals, bare where Pick holds no row at the row's kind and under that presence,
 * two arms of one context, a chain guarded by Pick's presence whose ELSE arm is the chain at a flag Pick holds (shape
 * D's), the extremum of a closed read of a double Pick holds as 0 at one kind and -0 at another with itself, or a drawn
 * term.
 * Beside it, h generates the shared subterm alone, so its SQL is the subterm's as the site prints it.
 *
 * - Meaning: the host evaluates g's expression and its rewrite, every rewrite a split or a factoring may take accepted
 *   (a size that never refuses), to one result at every row, a value, NULL or no value alike, a float's zero by its
 *   sign (scalar/compute/evaluate.ts).
 * - Work: in g's installed column, the shared predicate of "a boolean twice" and the flag of "a flag compared twice"
 *   occur once in the text, so on every path they are evaluated at most once, where unshared they are read twice
 *   (where a drawn arm reads the subterm itself, that read is the arm's own, and the case claims nothing of it).
 *
 * Oracle: the term's own value, the host's evaluation of the expression before the rewrite; and the count of the shared
 * subterm's SQL in the column's.
 *
 * Features: each shape, a shared subterm printed once, a NULL shared read and one beside the flags Pick holds, a NULL
 * value and a value, several rows.
 *
 * The rewrite's work, counted, never timed (kernel/calls.ts callCounts):
 *
 * - No lowering reads a closed relation's rows: g lowered twice or three times reads them as often as once, the values
 *   a closed read takes and the host's reads of the relations being the installation's.
 * - A factoring tries a closed read's values only where the other arm may be the arm at one of them: over arms no value
 *   makes one of the other, g's lowering substitutes as often over a world of k kinds as of 2k and 3k; and an ELSE arm
 *   that is the THEN arm at a value is factored still.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { agree, exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { FieldTexts, sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import { closedLeaf } from "#compiler/runtime/write/fill.ts"
import {
	compiledExpr,
	type EvalLeaves,
	sqlNull,
	noParamLeaf
} from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { hostColumns } from "#test/support/null/build.ts"
import { evalTerm, type Item, silent } from "#test/support/null/language.ts"
import {
	type ApartCase,
	type ApartRead,
	apartGen,
	armsReadShared,
	caseGen,
	countedWorld,
	generatedExpr,
	generatedSql,
	installationOfCase,
	installationOfTerm,
	loweredG,
	occurrences,
	type ShareCase,
	type ShareFeature,
	sharedSql,
	type ValueArm,
	valueArmGen
} from "#test/unit/lower/conservative/share.fixtures.ts"

/** A host value as text, a float's -0 apart from 0, which Formatter.format prints alike. */
const valueText = (value: unknown): string =>
	Object.is(value, -0) ? "-0" : Formatter.format(value)

/** What the host evaluates `expr` to at row `id`, as text: its value, NULL, or why it has none. */
const hostAt =
	(expr: ScalarExpr, closed: EvalLeaves["closed"]) =>
	(item: Item, id: number): string => {
		const table = predicateTable(expr)
		const value = compiledExpr(table)(
			{ value: undefined, column: hostColumns(item, id), closed, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		)
		return value.ok
			? value.value === sqlNull
				? "NULL"
				: valueText(value.value)
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
			"a float read twice",
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
				const closed = closedLeaf(installation.names.closedIndex)
				const g = generatedExpr(installation, "g")
				const rewritten = sharedExpr(g, {
					closed: installation.names.closedRelations,
					host: closed,
					size: () => 0,
					texts: new FieldTexts()
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
				original:
					"\t\t\t\t\t\t\tholdsFirst ? this.#cond(c, x, k, x, facts) : this.#cond(c, k, x, x, facts),\n",
				replacement:
					"\t\t\t\t\t\t\tholdsFirst ? this.#cond(c, k, x, x, facts) : this.#cond(c, x, k, x, facts),\n",
				why: "A factoring of an arm that is the other at a constant puts the constant on the wrong side: the guarded chain reads the flag `k` where Pick holds the row and the row's own flag where it holds none."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t} else if (held.arm !== arm) {\n",
				replacement: "\t\t\t} else if (held.arm !== arm && false) {\n",
				why: "A split takes a float's two zeros as one class of `=`: greatest(x, x) over Pick's 0 and -0 tests x = 0 for both and gives one zero at the other's row."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: "\t\t\t\tconst simple = simpleCase(chain, lower)\n",
				replacement: "\t\t\t\tconst simple = undefined\n",
				why: "A chain of equalities prints as conditionals, each comparing its subject again: the flag of a chain is printed once per comparison."
			}
		]
	})

/**
 * The calls that read a closed relation's rows: its closed table made (analysis/schema.ts closedTableOf), the table
 * indexed for the host's reads (runtime/write/fill.ts indexedClosed), a column's values worked out (ir/rel.ts
 * closedValues), a cell read (closedCell).
 */
const rowReads = Object.freeze({
	tables: { file: "packages/engine/src/analysis/schema.ts", name: "closedTableOf" },
	indexes: { file: "packages/engine/src/runtime/write/fill.ts", name: "indexedClosed" },
	values: { file: "packages/engine/src/ir/rel.ts", name: "closedValues" },
	cells: { file: "packages/engine/src/ir/rel.ts", name: "closedCell" },
	read: { file: "packages/engine/src/lower/conservative/expr/share.ts", name: "closedReadValues" }
})

/** A case of the NULL language and how many times its g is lowered: twice or three times. */
const loweredTimesGen: Gen<{ readonly sc: ShareCase; readonly times: 2 | 3 }> = (s) => ({
	sc: s.draw(caseGen),
	times: s.draw(element([2, 3] as const))
})

/**
 * Lowering an expression reads no closed relation's rows: the values a closed read takes are its relation's, worked out
 * where the schema is checked (ir/law.ts ClosedTheoryRelation `values`), and the index the host reads the closed
 * relations by, which a constant subterm is evaluated over, the installation's (ir/physical.ts PhysicalNames
 * closedIndex). Over the
 * cases of share.fixtures' worlds, g lowered as its column is (physical/ddl/expr.ts lowerPersistent) twice or three
 * times reads the rows (rowReads) exactly as often as lowered once, whatever the rewrite reads of a closed read's values.
 */
export const loweringAnExpressionReadsNoClosedRelationsRowsItsValuesAndTheHostsReadsAreTheInstallations =
	property.explore(loweredTimesGen, {
		needs: {},
		situations: [
			"a closed read's values",
			"two lowerings",
			"three lowerings"
		] satisfies ReadonlyArray<
			Reached<"a closed read's values" | "two lowerings" | "three lowerings">
		>,
		check:
			(_, k: Case<"a closed read's values" | "two lowerings" | "three lowerings">) =>
			({ sc, times }) =>
				Effect.gen(function* () {
					const installation = installationOfCase(sc)
					const g = generatedExpr(installation, "g")
					const lowered = (n: number) =>
						Effect.sync(() => Array.from({ length: n }, () => loweredG(installation, g)))
					const [first, once] = yield* callCounts(lowered(1), rowReads)
					const [again, many] = yield* callCounts(lowered(times), rowReads)
					k.note(times === 2 ? "two lowerings" : "three lowerings")
					if (once.read > 0) {
						k.note("a closed read's values")
					}
					assert.ok(
						Arr.every(again, (sql) => sql === first[0]),
						"every lowering of g prints one column"
					)
					const { read: _once, ...onceRows } = once
					const { read: _many, ...manyRows } = many
					assert.deepEqual(
						manyRows,
						onceRows,
						`g lowered ${times} times reads the rows as often as once`
					)
				}),
		oracle: {
			kind: "specification",
			name: "a lowering's reads of closed rows, the installation's, counted (kernel/calls.ts callCounts) the same at one lowering and at several"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\tvalues: declared.map((f) => closedValues(rows, f.position)),\n",
				replacement:
					"\t\t\tget values() {\n\t\t\t\treturn declared.map((f) => closedValues(rows, f.position))\n\t\t\t},\n",
				why: "A closed read's values are worked out from its relation's rows wherever they are read, as share.ts did for each expression (pantry's Node, whose 35 rewrites read Pick-sized columns again each time): each lowering reads the rows again."
			},
			{
				file: "packages/engine/src/physical/ddl/names.ts",
				original: "\t\tclosedIndex: closedIndexOf(input.closedTable),\n",
				replacement:
					"\t\tget closedIndex() {\n\t\t\treturn closedIndexOf(input.closedTable)\n\t\t},\n",
				why: "The closed relations are indexed for the host's reads wherever an expression is lowered, as share.ts's Sharing and persistentClosed built the host's reads for each expression: each lowering indexes the rows again."
			}
		]
	})

/** An apart case at three sizes of its world: its kinds, twice and three times as many. */
const substitutionsAt = (c: ApartCase) =>
	Effect.gen(function* () {
		const counted: Array<number> = []
		for (const scale of [1, 2, 3]) {
			const installation = installationOfTerm(countedWorld(c.kinds * scale, c.flags), c.term)
			const g = generatedExpr(installation, "g")
			const [, counts] = yield* callCounts(
				Effect.sync(() => loweredG(installation, g)),
				factoringWork
			)
			counted.push(counts.substituted)
		}
		return counted
	})

/** The calls a factoring's tries are counted by: an arm substituted at a value (share.ts #substituted). */
const factoringWork = Object.freeze({
	substituted: {
		file: "packages/engine/src/lower/conservative/expr/share.ts",
		name: "#substituted"
	}
})

/**
 * A factoring tries a subterm's values only where the other arm may be the arm at one of them (share.ts #foldsTo): over
 * conditionals whose arms are operations of two kinds, a read of Pick's `n` in the THEN arm (share.fixtures.ts
 * apartGen), g's lowering substitutes as often over a world of k kinds as over 2k and 3k, where each try would
 * substitute the arm once per value of the read, as many as the world's kinds.
 */
export const aFactoringTriesASubtermsValuesOnlyWhereTheOtherArmMayBeTheArmAtOneOfThem =
	property.explore(apartGen, {
		needs: {},
		situations: ["a read alone", "a read beside a leaf"] satisfies ReadonlyArray<
			Reached<ApartRead>
		>,
		check: (_, n: Case<ApartRead>) => (c) =>
			Effect.gen(function* () {
				n.note(c.read)
				const [k, twice, thrice] = yield* substitutionsAt(c)
				assert.ok(
					k === twice && twice === thrice,
					`g's lowering substitutes as often at ${c.kinds}, ${2 * c.kinds} and ${3 * c.kinds} kinds, not ${k}, ${twice} and ${thrice} times`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a factoring's substitutions, counted (kernel/calls.ts callCounts), a function of the term alone where no value makes one arm of the other"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\tif (values === undefined || !this.#foldsTo(whole, x, other)) {\n",
				replacement: "\t\t\t\tif (values === undefined) {\n",
				why: "A factoring tries every value of a closed read though no value makes one arm of the other: each try substitutes the arm, once per value of the relation (pantry's Node: 1.4M tries, 52 s of its insert's compile)."
			}
		]
	})

/**
 * A conditional whose ELSE arm is its THEN arm at a value of a closed read, the arm folded, is factored, its ELSE arm's
 * literal printed once (share.fixtures.ts valueArmGen): the factoring's filter (share.ts #foldsTo) keeps every arm a
 * value may make, a decided conditional's arm and a constant operation's literal among them.
 */
export const aConditionalWhoseElseArmIsItsThenArmAtAClosedReadsValueIsFactored = property.explore(
	valueArmGen,
	{
		needs: {},
		situations: ["a decided conditional", "a constant operation"] satisfies ReadonlyArray<
			Reached<ValueArm>
		>,
		check: (_, k: Case<ValueArm>) => (c) =>
			Effect.sync(() => {
				k.note(c.arm)
				const installation = installationOfTerm(c.world, c.term)
				const column = generatedSql(installation, "g")
				const count = occurrences(column, String(c.literal))
				assert.equal(count, 1, `g's column prints ${c.literal} once, factored: ${column}`)
			}),
		oracle: {
			kind: "specification",
			name: "the factored column, its ELSE arm's literal counted in its SQL"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\t\t? folds(n.args[1], o) || folds(n.args[2], o)\n",
				replacement: "\t\t\t\t\t? false\n",
				why: "The filter reads a conditional decided at a value as no arm of it: `cond(p, cond(n = v, 1001, 1002), 1002)` is never factored, 1002 printed twice."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: '\t\t\t\t\t\t: o.kind === "literal" && n.args.every(toLiteral))\n',
				replacement: "\t\t\t\t\t\t: false)\n",
				why: "The filter reads an operation evaluated at a value as never a literal: `cond(p, greatest(n, 1001), 1001)` is never factored, 1001 printed twice."
			}
		]
	}
)
