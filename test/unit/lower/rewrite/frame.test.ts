import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import { rebuildDag, relNode } from "#compiler/ir/dag.ts"
import {
	conservativeMeta,
	metaSpecOf,
	type Rooted,
	type Roots,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { lexLess, multiset } from "#compiler/lower/optimize/demand/frame.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { Posting, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	caseQuery,
	passContext,
	ledgerCatalog,
	type Ran,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * The rewrite frame: rewrites run only in the optimized lowering, every applied rewrite strictly decreases its pass's
 * measure or the pass fails, and the same input rewrites identically.
 */

/**
 * A measure spelt as a string, one code unit per component: JavaScript orders strings lexicographically by code unit,
 * a proper prefix below, which is the order a measure is held to, computed by the engine and not by lexLess.
 */
const spelt = (measure: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(measure, (n) => String.fromCharCode(0x41 + n)),
		""
	)

const count = (xs: ReadonlyArray<number>, x: number): number =>
	Arr.filter(xs, (y) => y === x).length

/**
 * The Dershowitz–Manna multiset ordering over naturals: `smaller` lies below `larger` when they differ and every
 * element `smaller` holds more often than `larger` is outweighed by a strictly greater element `larger` holds more
 * often, so replacing one element by any number of strictly smaller ones decreases the multiset.
 */
const multisetBelow = (smaller: ReadonlyArray<number>, larger: ReadonlyArray<number>): boolean => {
	const support = [...new Set([...smaller, ...larger])]
	const excess = Arr.filter(support, (x) => count(smaller, x) > count(larger, x))
	const differs = Arr.some(support, (x) => count(smaller, x) !== count(larger, x))
	return (
		differs &&
		Arr.every(excess, (x) =>
			Arr.some(support, (y) => y > x && count(larger, y) > count(smaller, y))
		)
	)
}

/** What the measure suites reach: which of two measures lies below, and how a lexicographic comparison is decided. */
type MeasureFeature =
	| "below"
	| "equal"
	| "above"
	| "decided at a position"
	| "decided by a proper prefix"

describe("the measure and its order", () => {
	it.effect("compares lexicographically, a proper prefix below", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/rewrite/frame-lexicographic",
					literal: Formatter.format,
					generator: (source) =>
						[
							source.draw(array(int(0, 2), { min: 0, max: 3 })),
							source.draw(array(int(0, 2), { min: 0, max: 3 }))
						] as const,
					limit: 1600,
					coverage: requiredInSpace<MeasureFeature>([
						"below",
						"equal",
						"above",
						"decided at a position",
						"decided by a proper prefix"
					]),
					caseHang: Duration.minutes(2)
				},
				([after, before], c) =>
					Effect.sync(() => {
						const a = spelt(after)
						const b = spelt(before)
						c.note(a < b ? "below" : a === b ? "equal" : "above")
						if (a !== b) {
							c.note(
								Str.startsWith(b)(a) || Str.startsWith(a)(b)
									? "decided by a proper prefix"
									: "decided at a position"
							)
						}
						assert.equal(lexLess(after, before), a < b)
					})
			)
		)
	)

	it.effect(
		"orders multisets as the multiset ordering does: one element replaced by any number of smaller ones",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/frame-multiset",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(array(int(0, 3), { min: 0, max: 3 })),
								source.draw(array(int(0, 3), { min: 0, max: 3 }))
							] as const,
						limit: 7225,
						coverage: requiredInSpace<MeasureFeature>(["below", "equal", "above"]),
						caseHang: Duration.minutes(2)
					},
					([after, before], c) =>
						Effect.sync(() => {
							const below = multisetBelow(after, before)
							c.note(below ? "below" : multisetBelow(before, after) ? "above" : "equal")
							assert.equal(lexLess(multiset(after), multiset(before)), below)
						})
				)
			)
	)
})

describe("a DAG's roots", () => {
	it.effect(
		"a root stays at its position among the DAG's roots when a rewrite replaces it, the query's root first",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/frame-root-position",
						literal: Formatter.format,
						generator: element<"first" | "second">(["first", "second"]),
						limit: 2,
						coverage: requiredInSpace<"first" | "second">(["first", "second"]),
						caseHang: Duration.minutes(2)
					},
					(at, c) =>
						Effect.sync(() => {
							c.note(at)
							const q = new Q()
							const occurrence = () => ({
								source: q.base(Posting, conservativeMeta),
								bind: { id: "id", account: "account" },
								constants: {}
							})
							const other = q.project(q.region([occurrence()]), [["id", "id"]], conservativeMeta)
							const result = q.filter(
								q.region([occurrence()]),
								q.lit({ kind: "bool", value: true }, T.bool)
							)
							const roots: Rooted = at === "first" ? [result, other] : [other, result]
							const ran = succeeded(
								simplifyPass.run(
									{ dag: q.b.build(roots), params: [] },
									passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
								)
							)
							const replaced = ran.dag.roots[at === "first" ? 0 : 1]
							assert.equal(ran.dag.roots[at === "first" ? 1 : 0]?.id, other.id)
							assert.equal(replaced?.kind, "MatchRegion")
						})
				)
			)
	)
})

/**
 * A fresh copy of a DAG: every node rebuilt under its own label over its inputs' copies (dag.ts rebuildDag), each shared
 * node copied once, so the copy holds the same content in objects no pass has seen.
 */
const freshCopy = <R extends Roots>(dag: ValidDag<R>): ValidDag<R> =>
	rebuildDag(dag, (node, inputs) => relNode(node.id, { ...inputs, meta: metaSpecOf(node.meta) }))

/** What the frame suites reach: a pass that delivered the DAG it was given, and one that changed it. */
type FrameFeature = "a pass delivered the settled DAG" | "a pass changed the DAG"

describe("determinism", () => {
	it.effect(
		"the same input rewrites to the same DAG, certificates and SQL, run after run",
		(ctx) => {
			const passes = [semanticSimplification, relationalRewrites]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/lower/rewrite/frame-determinism",
						literal: Formatter.format,
						kept: [],
						draw: drawn(queryCaseGen(defaultGenConfig)),
						runs: 120,
						shrink: completeShrink,
						coverage: noCoverage,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(c) =>
						Effect.sync(() => {
							const run = () =>
								succeeded(
									runPasses(
										caseQuery(c),
										passes,
										passContext({ catalog: genCatalog(c.schema), evidence: "snapshot" })
									)
								)
							const sqlOf = (r: Ran): string =>
								Arr.join(
									Arr.map(
										flight(
											succeeded(
												lowerConservative(conservativeInput(r.query), {
													names: standInNames("s"),
													params: r.query.params,
													subject: { kind: "query" },
													meter: new BudgetMeter(compileBudgets)
												})
											).roots
										),
										(s) => s.sql.text
									),
									"\n"
								)
							const first = run()
							for (const again of [run(), run()]) {
								assert.deepEqual(again.query.dag, first.query.dag)
								assert.deepEqual(again.certificates, first.certificates)
								assert.equal(sqlOf(again), sqlOf(first))
							}
						})
				)
			)
		}
	)

	it.effect(
		"a frame that changes nothing in a DAG a frame delivered delivers it again, as collecting and annotating would",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/rewrite/frame-delivered",
						literal: Formatter.format,
						kept: [],
						draw: drawn(queryCaseGen(defaultGenConfig)),
						runs: 60,
						shrink: completeShrink,
						coverage: required<FrameFeature>(["a pass delivered the settled DAG"], {
							cases: 60,
							sense: notesOnly
						}),
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(q, c) =>
						Effect.sync(() => {
							const catalog = genCatalog(q.schema)
							const settled = succeeded(
								runPasses(
									caseQuery(q),
									[relationalRewrites],
									passContext({ catalog, evidence: "snapshot" })
								)
							).query
							for (const pass of [simplifyPass, existencePass, relationalRewrites]) {
								const again = succeeded(
									pass.run(settled, passContext({ catalog, evidence: "snapshot" }))
								)
								/** The same DAG as a fresh table with the same content gives, which no frame delivered. */
								const fresh = succeeded(
									pass.run(
										{ ...settled, dag: freshCopy(settled.dag) },
										passContext({ catalog, evidence: "snapshot" })
									)
								)
								assert.deepEqual(again.dag, fresh.dag)
								assert.equal(again.dag.roots[0].id, fresh.dag.roots[0].id)
								if (again.dag !== settled.dag) {
									assert.notEqual(
										succeeded(encode(again.dag, everyProperty)),
										succeeded(encode(settled.dag, everyProperty))
									)
								} else {
									c.note("a pass delivered the settled DAG")
								}
							}
						})
				)
			)
	)

	it.effect(
		"a pass computed cold from a fresh copy of a DAG equals the pass computed warm from the cached one",
		(ctx) => {
			const chain = [
				semanticSimplification,
				relationalRewrites,
				simplifyPass,
				existencePass,
				fusePass,
				relationalRewrites
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/lower/rewrite/frame-cold",
						literal: Formatter.format,
						kept: [],
						draw: drawn(queryCaseGen(defaultGenConfig)),
						runs: 150,
						shrink: completeShrink,
						/** The chain rewrites: the comparison covers changed DAGs, not only ones every pass delivered again. */
						coverage: required<FrameFeature>(["a pass changed the DAG"], {
							cases: 150,
							sense: notesOnly
						}),
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(q, c) =>
						Effect.sync(() => {
							const catalog = genCatalog(q.schema)
							let warm = caseQuery(q)
							for (const pass of chain) {
								const cold = { ...warm, dag: freshCopy(warm.dag) }
								const warmCtx = passContext({ catalog, evidence: "snapshot" })
								const coldCtx = passContext({ catalog, evidence: "snapshot" })
								const hot = succeeded(pass.run(warm, warmCtx))
								const fresh = succeeded(pass.run(cold, coldCtx))
								assert.deepEqual(hot.dag, fresh.dag)
								assert.equal(hot.dag.roots[0].id, fresh.dag.roots[0].id)
								assert.deepEqual(warmCtx.certificates.all(), coldCtx.certificates.all())
								if (hot.dag !== warm.dag) {
									c.note("a pass changed the DAG")
								}
								warm = hot
							}
						})
				)
			)
		},
		300_000
	)
})
