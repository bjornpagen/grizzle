/**
 * The closures a physical analysis hands out are made outside its scopes (analysis/physical/analyze.ts nodeAnalysisOf,
 * propsOf, realizationIn, contributionIn, propsStep, FoldedRules): V8 holds every variable a closure of a scope captures
 * in that scope's one context, and keeps a closure an analysis made past the analysis through its own metadata (a
 * hidden class's constructor, an allocation site's boilerplate) once the code that made it is optimized, which a unit
 * run never reaches; a closure made in analysisOver's scope kept that scope's context, the env and the edges and the
 * PropsUnder with its fold's memo of every node's properties among it (GENMEM: six physical props contexts so pinned in
 * edullm's qti generate at hub a212aa699). So the property reads what the handed closure is: the analysis's `of`, the
 * one a placement's plan keeps, is the reader nodeAnalysisOf makes, whose source reads the properties, the decisions and
 * the observed nodes alone, and names neither the env nor the edges.
 *
 * Oracle: specification. Kill: analysisOver hands out its own `of`, reading the env and the edges.
 *
 * Features: none beyond the space.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import { analyzePhysical, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"

/** A physical analysis's `of` is made outside analysisOver's scope: it reads neither the env nor the edges. */
export const aPhysicalAnalysissOfIsMadeOutsideItsScopeReadingNeitherTheEnvNorTheEdges =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [],
		check: () => (q) =>
			Effect.sync(() => {
				const analysis = analyzePhysical(q.query.dag, {
					context: "snapshot",
					catalog: genCatalog(q.schema),
					realization: unplaced,
					roots: "result"
				})
				const source = analysis.of.toString()
				assert.ok(
					!Str.includes("env")(source) && !Str.includes("edges")(source),
					`the analysis's of reads neither the env nor the edges: ${source}`
				)
			}),
		oracle: { kind: "specification", name: "a handed closure captures what it reads alone" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/analyze.ts",
				original: "\t\tof: nodeAnalysisOf(props, env.realization, observedNodes(order, edges)),\n",
				replacement:
					"\t\tof: (node) => ({ props: props.of(node), realization: realizationOf(env.realization, node), observed: observedNodes(order, edges).has(node), contribution: contributionIn(props)(node) }),\n",
				why: "analysisOver hands out a closure of its own scope, reading the env and the edges, so a placement's plan that keeps the analysis keeps analysisOver's context and every memo in it."
			}
		]
	})
