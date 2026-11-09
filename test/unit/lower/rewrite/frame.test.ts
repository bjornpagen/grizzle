/**
 * The rewrite frame: rewrites run only in the optimized lowering, every applied rewrite strictly lowers its pass's
 * potential, a natural, or the pass fails (which every suite that runs a pass checks on every rewrite), and the same
 * input rewrites identically.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
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
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { Posting, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	caseQuery,
	passContext,
	ledgerCatalog,
	type Ran,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** Where the rewritten root sits among a DAG's roots: first, the query's own, or after it. */
type RootPosition = "the query's root" | "a later root"

describe("a DAG's roots", () => {
	it.effect(
		"a root stays at its position among the DAG's roots when a rewrite replaces it, the query's root first",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/lower/rewrite/frame-root-position",
						literal: Formatter.format,
						/** Two or three roots, the one a rewrite replaces at any position among them. */
						generator: (source) => {
							const roots = source.draw(int(2, 3))
							return { roots, at: source.draw(int(0, roots - 1)) }
						},
						limit: 5,
						coverage: requiredInSpace<RootPosition>(["the query's root", "a later root"]),
						caseHang
					},
					({ roots, at }, c) =>
						Effect.sync(() => {
							c.note(at === 0 ? "the query's root" : "a later root")
							const q = new Q()
							const occurrence = () => ({
								source: q.base(Posting, conservativeMeta),
								bind: { id: "id", account: "account" },
								constants: {}
							})
							/** Each other root a projection of its own region, which simplification keeps. */
							const built: Rooted = Arr.makeBy(roots, (i) =>
								i === at
									? q.filter(q.region([occurrence()]), q.lit({ kind: "bool", value: true }, T.bool))
									: q.project(q.region([occurrence()]), [["id", "id"]], conservativeMeta)
							)
							const ran = succeeded(
								simplifyPass.run(
									{ dag: q.b.build(built), params: [] },
									passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
								)
							)
							assert.equal(ran.dag.roots.length, roots)
							for (const [i, root] of ran.dag.roots.entries()) {
								if (i === at) {
									assert.equal(root.kind, "MatchRegion")
								} else {
									assert.equal(root.id, defined(built[i], "the root as built").id)
								}
							}
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
						oracle: { kind: "unstated" },
						suite: "unit/lower/rewrite/frame-determinism",
						literal: Formatter.format,
						kept: [],
						draw: drawn(queryCaseGen(defaultGenConfig)),
						runs: 120,
						shrink: completeShrink,
						coverage: noCoverage,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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
													names: standInNames("s", schemaCodes(c.schema)),
													params: r.query.params,
													subject: { kind: "query" }
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
						oracle: { kind: "unstated" },
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
						caseHang
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
						oracle: { kind: "unstated" },
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
						caseHang
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
		}
	)
})
