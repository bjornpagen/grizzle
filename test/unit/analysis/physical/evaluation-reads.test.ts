/**
 * The physical analysis reads each node's expressions once for what every subtree over it varies with
 * (analysis/physical/rules.ts outerOf, holdsLabel): a node's evaluation reads are its own expressions' columns and its
 * inputs' reads, less those its subtree binds, each input's computed once, where each node that asked (a node of at
 * most one row, its own computation's premise; a region's occurrence, its source's correlation) walked its whole
 * subtree and read every expression in it. On the ledger's installation (edullm qti-pie, its result composition without
 * its login), the walks took 6.6 s of the first 120 s of its judge's compile (lane PERF-PHYS's profile at d422b835a).
 * The work is counted, never timed (test/support/kernel/calls.ts): the calls of exprsOf.
 *
 * Oracle: linearity, read off the chain: every filter over the row is alike, so each costs the analysis what the third
 * added to the second.
 *
 * Features: a chain read whole and by a region; a chain one deep and sixteen deep.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	chainGen,
	judgedChain,
	type Reached
} from "#test/unit/analysis/physical/evaluation-reads.fixtures.ts"

const situations = [
	"a chain read whole",
	"a chain read by a region",
	"a chain one deep",
	"a chain sixteen deep"
] as const satisfies ReadonlyArray<ReachedOf<Reached>>

const box =
	"every chain of one to sixteen filters over the first row of Account, read as the program's result or as the occurrence of a region over it"

/** Analyzing a chain of one-row filters reads each filter's expressions once, however deep the chain. */
export const analyzingAChainOfOneRowFiltersReadsEachFiltersExpressionsOnce = property.exhaust(
	finite(chainGen),
	{
		needs: {},
		situations,
		check: (_, c: Case<Reached>) => (chain) => judgedChain(chain, c.note),
		oracle: {
			kind: "universal",
			name: "linearity: the calls of exprsOf analyzing a chain d deep are its two filters' and d − 2 times what the third filter added"
		},
		box,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original:
					"const evaluationReads = (root: RelNode): Justification => justify({ outer: outerOf(root) })",
				replacement:
					"const evaluationReads = (root: RelNode): Justification => { const nodes = [root]; const seen = new Set([root]); for (const at of nodes) { for (const input of inputsOf(at)) { if (!seen.has(input)) { seen.add(input); nodes.push(input) } } } const inside = new Set(nodes.map((n) => n.id)); return justify({ outer: nodes.flatMap((n) => exprsOf(n).flatMap((e) => columnRefs(e).filter((c) => !inside.has(c.node)))) }) }",
				why: "Each node that asks what its evaluation reads walks its whole subtree and reads every expression in it, as the analysis did at d422b835a: a filter k deep reads k nodes' expressions again, the reads grow with the square of the depth, and the property fails."
			}
		]
	}
)
