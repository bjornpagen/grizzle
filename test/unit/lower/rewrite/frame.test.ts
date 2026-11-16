/**
 * The rewrite frame (lower/optimize/demand/frame.ts rewritePass): rewrites run only in the optimized lowering, every
 * applied rewrite strictly lowers its pass's potential, a natural, or the pass fails (which every suite that runs a pass
 * checks on every rewrite), and:
 *
 * - a root a rewrite replaces stays at its position among the DAG's roots, the query's root first;
 * - the same input rewrites to the same DAG, certificates and SQL, run after run;
 * - a pass given a DAG a frame settled delivers that very DAG where it changes nothing, and otherwise one whose content
 *   differs, the DAG a fresh copy of the same content gives;
 * - a pass computed cold from a fresh copy of a DAG equals the pass computed warm from the one a pass delivered.
 *
 * Oracle: the frame's statement over an exhaustive space of root positions (a specification); for the rest, universal
 * laws over generated queries: determinism, and a pass's result a function of its input's content alone.
 *
 * Features: the query's root and a later root replaced; a pass that delivered the settled DAG; a pass that changed it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { conservativeMeta, type Rooted } from "#compiler/ir/rel.ts"
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
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { upTo } from "#test/support/up-to.ts"
import { Posting, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	type FrameFeature,
	freshCopy,
	type RootPosition
} from "#test/unit/lower/rewrite/frame.fixtures.ts"
import {
	caseQuery,
	ledgerCatalog,
	passContext,
	type Ran,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** A DAG's roots a root stays at its position among the DAG's roots when a rewrite replaces it, the query's root first. */
export const aDAGsRootsARootStaysAtItsPositionAmongTheDAGsRootsWhenARewriteReplacesItTheQuerysRootFirst =
	property.exhaust(
		finite((source) => {
			const roots = source.draw(int(2, 3))
			return { roots, at: source.draw(int(0, roots - 1)) }
		}),
		{
			needs: {},
			situations: ["the query's root", "a later root"] satisfies ReadonlyArray<
				Reached<RootPosition>
			>,
			check:
				(_, c: Case<RootPosition>) =>
				({ roots, at }) =>
					Effect.sync(() => {
						c.note(at === 0 ? "the query's root" : "a later root")
						const q = new Q()
						const occurrence = () => ({
							source: q.base(Posting, conservativeMeta),
							bind: { id: "id", account: "account" },
							constants: {}
						})
						/** Each other root a projection of its own region, which simplification keeps. */
						const built: Rooted = nonEmptyList(
							upTo(roots, (i) =>
								i === at
									? q.filter(q.region([occurrence()]), q.lit({ kind: "bool", value: true }, T.bool))
									: q.project(q.region([occurrence()]), [["id", "id"]], conservativeMeta)
							),
							"the roots"
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
					}),
			oracle: {
				kind: "specification",
				name: "a replaced root stays at its position, every other root as built"
			},
			box: "two or three roots, the one simplification replaces at each position",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/editor.ts",
					original: "\t\tconst done = finishCells(this.base.roots, (root) => this.#rootCell(root))",
					replacement:
						"\t\tconst done = finishCells([...this.base.roots].reverse(), (root) => this.#rootCell(root))",
					why: "The editor finishes a DAG with its roots reversed; the frame-root-position search fails."
				}
			]
		}
	)

/** Determinism the same input rewrites to the same DAG, certificates and SQL, run after run. */
export const determinismTheSameInputRewritesToTheSameDAGCertificatesAndSQLRunAfterRun =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		situations: [],
		check: () => (c) =>
			Effect.gen(function* () {
				const passes = [semanticSimplification, relationalRewrites]
				return yield* Effect.sync(() => {
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
			}),
		oracle: {
			kind: "universal",
			name: "one input rewrites to one DAG, one certificate list and one SQL text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original: "\t\t\tthis.#counter += 1",
				replacement: "\t\t\tthis.#counter += 1 + Math.floor(Math.random() * 3)",
				why: "Fresh identifiers skip a random count, so labels differ run to run; the frame-determinism search fails."
			}
		]
	})

/** Determinism a frame that changes nothing in a DAG a frame delivered delivers it again, as collecting and annotating would. */
export const determinismAFrameThatChangesNothingInADAGAFrameDeliveredDeliversItAgainAsCollectingAndAnnotatingWould =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		situations: ["a pass delivered the settled DAG"] satisfies ReadonlyArray<Reached<FrameFeature>>,
		check: (_, c: Case<FrameFeature>) => (q) =>
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
					const again = succeeded(pass.run(settled, passContext({ catalog, evidence: "snapshot" })))
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
			}),
		oracle: {
			kind: "universal",
			name: "a pass that changes nothing delivers its input, and its result is its input's content's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/frame.ts",
				original: "\teditor.version === 0 ? query : { ...query, dag: editor.finish() }",
				replacement: "\t({ ...query, dag: editor.finish() })",
				why: "A pass that changes nothing delivers a rebuilt copy of its DAG; the frame-delivered search fails."
			}
		]
	})

/** Determinism a pass computed cold from a fresh copy of a DAG equals the pass computed warm from the cached one. */
export const determinismAPassComputedColdFromAFreshCopyOfADAGEqualsThePassComputedWarmFromTheCachedOne =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		situations: ["a pass changed the DAG"] satisfies ReadonlyArray<Reached<FrameFeature>>,
		check: (_, c: Case<FrameFeature>) => (q) =>
			Effect.gen(function* () {
				const chain = [
					semanticSimplification,
					relationalRewrites,
					simplifyPass,
					existencePass,
					fusePass,
					relationalRewrites
				]
				return yield* Effect.sync(() => {
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
			}),
		oracle: {
			kind: "universal",
			name: "a pass's result is a function of its input's content: cold from a fresh copy equals warm"
		},
		kept: [],
		kills: []
	})
