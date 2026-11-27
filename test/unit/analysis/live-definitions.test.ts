/**
 * A checked schema's canonical relations cost their definitions' size, never their size by their depth
 * (analysis/schema.ts CheckedSchema, analysis/derived/canonical.ts): over a chain of live derived relations, each
 * reading the definition below it as an import, each query is checked once, in the one session of the definitions'
 * checks, as its canonical form and as every import of it alike; each closed node is digested once, bottom-up, every
 * form over it reading its digest (ir/dag.ts CanonicalDigests); and each node is annotated once, every definition's
 * analysis reading the shared annotations of the imports below it (logical/annotate.ts SharedAnalyses). Where a
 * session, a digest or an analysis of each definition's own walked the whole chain below it again, the work was the
 * square of its length.
 *
 * The counts are work, never time: V8's precise coverage counts the checker's import checks (check/checker.ts
 * #importChecked), the digests' numberings (ir/dag-digest.ts ReachNumbering edge) and the analyses' annotations
 * (logical/annotate.ts annotate), each against the chain's own nodes and edges. The box is exhausted: chains of one to
 * nine definitions (live-definitions.fixtures.ts).
 *
 * Features: a chain of one definition, a chain of several.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { inputsOf } from "#compiler/ir/rel.ts"
import { own } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import { decodedSchema } from "#test/support/fixtures/ir/desc.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { chainOf } from "#test/unit/analysis/live-definitions.fixtures.ts"

type ChainFeature = "a chain of one definition" | "a chain of several"

/**
 * A checked schema's canonical relations cost their definitions' size, never their size by their depth: each query
 * checked once, as its canonical form and as every import of it alike; each closed node digested once, numbered as its
 * own form's root and once by each edge into it, read by its digest in every form over it (ir/dag.ts CanonicalDigests);
 * and each node annotated once, every analysis over it reading the shared annotations of the imports below it.
 */
export const aCheckedSchemaChecksDigestsAndAnalyzesEachQueryItsDefinitionsReadOnce =
	property.exhaust(finite(int(1, 9)), {
		needs: {},
		box: "chains of one to nine live definitions, each reading the one below it",
		situations: ["a chain of one definition", "a chain of several"] satisfies ReadonlyArray<
			Reached<ChainFeature>
		>,
		check: (_, k: Case<ChainFeature>) => (length) =>
			Effect.gen(function* () {
				k.note(length === 1 ? "a chain of one definition" : "a chain of several")
				const owned = succeeded(own(decodedSchema(chainOf(length))), "the chain owns")
				const [checked, counts] = yield* callCounts(
					Effect.sync(() => succeeded(checkedSchema(owned), "the chain checks")),
					{
						imports: { file: "packages/engine/src/check/checker.ts", name: "#importChecked" },
						numbered: { file: "packages/engine/src/ir/dag-digest.ts", name: "edge" },
						annotated: { file: "packages/engine/src/logical/annotate.ts", name: "annotate" }
					}
				)
				const nodes = topoOrder(checked.canonicalOf(`D${length}`).definition.checked.dag)
				const edges = Arr.reduce(nodes, 0, (n, node) => n + inputsOf(node).length)
				assert.equal(
					counts.imports,
					length,
					`a chain of ${length} definitions checks each of its ${length} queries once, as its canonical form and as every import of it alike`
				)
				assert.equal(
					counts.numbered,
					nodes.length + edges,
					`its ${nodes.length} nodes are each numbered once as their own form's root and once by each of their ${edges} edges`
				)
				assert.equal(
					counts.annotated,
					nodes.length,
					`its ${nodes.length} nodes are each annotated once, whichever definitions' analyses read them`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one import check per definition, one numbering per closed node and per edge into it, one annotation per node (kernel/calls.ts callCounts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\t\t\tconst checked = unwrap(checkClosedImport(this, label, query, session))\n",
				replacement:
					"\t\t\t\tconst checked = unwrap(checkClosedImport(this, label, query, new CheckSession(this.patterns)))\n",
				why: "Each query is checked in a session of its own, which checks the whole chain of imports below it again: a chain of n definitions checks its queries n(n + 1) / 2 times."
			},
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\t\t\treturn form?.ok === true ? form.value : undefined\n",
				replacement: "\t\t\t\treturn undefined\n",
				why: "Each form digested whole, the forms below it walked again, not read by their digests: a chain of n definitions numbers its nodes n deep, the work the square of its depth."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\t\tconst analyses = new SharedAnalyses(queryEvidence, session.closedRoots())\n",
				replacement: "\t\t\tconst analyses = new SharedAnalyses(queryEvidence, () => false)\n",
				why: "Each definition's analysis annotates every import below it again: a chain of n definitions annotates its nodes n deep."
			}
		]
	})
