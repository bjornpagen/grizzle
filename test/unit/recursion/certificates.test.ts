/**
 * Generated recursions against the termination proof rules: for every recursive definition the generator draws, the
 * checker's verdict is the one a reference model of the rules gives, and so is the certificate's family and state
 * estimate.
 *
 * A definition walks Graph's edges from a parameter root, with a state of its node, a counter-like column h and a tag
 * column t of one integer carrier, and a mark m of text. Its base arms seed h, t and m with literals; its recursive arms
 * deliver for h a literal, a copy of h or of t, a step h + k, k + h or h - k under zero to two guards on h (a comparison
 * either way round with a literal or a parameter, a range, or a disequality), a product or a sum with the edge's cost,
 * or the cost itself; for t a literal, a copy, the cost or the cost plus a literal, or a product; for m a literal or a
 * copy. A recursive arm may also pin h to a vertex's rank, so h is data there. A head literal is typed, untyped (the
 * state column types it) or a narrower integer literal cast to the carrier, which are one value to the rules.
 *
 * The reference model, written from the rules as termination.ts states them:
 *
 * - a literal is one value; data (the edge's columns, a pinned h, a computed term over data only) counts once; a copy
 *   of the column's own state adds nothing; a copy of another column widens to that column's values;
 * - h + k, k + h and h - k with k a nonzero integer literal are a counter when a guard bounds h on the side it moves
 *   towards: the last value the guards admit is the tightest bound, and the counter produces that value plus its
 *   step, which must stay inside the carrier (a parameter bound is the carrier's extreme), or the recursion is
 *   refused for carrier overflow;
 * - any other term computed from a column's own value is unbounded computed state, refused;
 * - a counter counts every integer from its least to its greatest value: the seeds' range when every other value is
 *   a known literal, the carrier's range otherwise, widened to what the counter produces;
 * - the estimate is the product over the columns, recorded and never refused, whatever its size; the family is
 *   finiteCarrier without a counter, boundedState with an increasing one, wellFounded with only decreasing ones;
 * - a counter's step is exact integer arithmetic, narrowed into the carrier: from every value the counter can hold,
 *   least to greatest, each of its steps stays inside the carrier, the step past its last state included, or the
 *   narrowing is unproved, PartialOperation, which admission decides after the rules above. Every other integer
 *   arithmetic the definition computes is narrowed under the guard that it fits, as a program writes it.
 *
 * The model restates the rules, so a rule that is unsound in both, an estimate below the states a recursion really
 * reaches, would pass the comparison. So every admitted definition also runs, by the reference evaluator's fixpoint,
 * over small generated graphs: it must reach its fixpoint, and no vertex may carry more distinct states than the
 * estimate over that graph. The rules count a column's data once, the states per combination of carrier values, and a
 * vertex holds a state for each value the graph's data gives a column there (edges of two costs into it, or the cost
 * beside the cost plus one), so over a graph the model counts a column's data as the distinct values its data forms
 * take on the graph's edges. That comparison bites where a vertex reaches the bound, so the draw holds definitions
 * without data whose estimate a vertex with a self-loop reaches exactly. The fixpoint runs where the reference reaches it within its step limit
 * under the estimate; a definition whose estimate over a graph is past that limit, such as a counter stepping toward a
 * bound near the carrier's extreme, is held to its verdict, family and estimate alone. A guard's literal bound is drawn
 * near the carrier's extremes too, where a counter's next value leaves the carrier before the bound is checked.
 *
 * Oracle: the reference model of the rules (a second implementation of termination.ts), and the reference evaluator's
 * fixpoint over generated graphs. Features: each rule's situations (featureTests), a fixpoint reached, at its estimate,
 * past the reference's step limit, and a vertex holding more states than the estimate with its data once.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { maxIterations } from "#test/support/oracle/reference/evaluate.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	carrierEdgeGen,
	type CertificateFeature,
	certificateCaseOf,
	dataValuesOver,
	descOfSpec,
	estimateOf,
	estimateWith,
	featureTests,
	pastStepLimitGen,
	sameRefusal,
	specGen,
	statesPerVertex,
	verdict
} from "#test/unit/recursion/certificates.fixtures.ts"
import { Graph, theRecursive } from "#test/unit/recursion/fixtures.ts"

/**
 * Generated recursions against the termination proof rules gives every generated definition the verdict, family and
 * estimate the rules give it, and no vertex more states than the estimate at the fixpoint.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/recursion/certificates.test.ts:1415 at 8cad5bce, its runs and its coverage's cases).
 */
export const generatedRecursionsAgainstTheTerminationProofRulesGivesEveryGeneratedDefinitionTheVerdictFamilyAndEstimateTheRulesGiveItAndNoVertexMoreStatesThanTheEstimateAtTheFixpoint =
	property.explore(
		aimed(certificateCaseOf(specGen), [
			["carrier overflow at a literal bound", certificateCaseOf(carrierEdgeGen)],
			["a narrowing unproved one step past a literal bound", certificateCaseOf(carrierEdgeGen)],
			["a fixpoint past the reference's step limit", certificateCaseOf(pastStepLimitGen)]
		]),
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: [
				...Arr.map(featureTests, ([name]) => name),
				"a fixpoint reached",
				"a fixpoint at its estimate",
				"a vertex holding more states than the estimate with its data once",
				"a fixpoint past the reference's step limit"
			] satisfies ReadonlyArray<Reached<CertificateFeature>>,
			check:
				(_, c: Case<CertificateFeature>) =>
				([spec, graphs]) =>
					Effect.sync(() => {
						const estimate = estimateOf(spec)
						const expected = verdict(estimate)
						c.noteAll(
							Arr.flatMap(featureTests, ([name, has]) =>
								has({ spec, verdict: expected }) ? [name] : []
							)
						)
						const r = checkAuthored(checking(Graph), descOfSpec(spec), checkOptions("query"))
						if (expected.kind === "refused") {
							if (r.ok) {
								throw new Error(`admitted, not refused for ${expected.refusal.kind}`)
							}
							if (expected.refusal.kind === "unprovedNarrowing") {
								if (r.error.reason._tag !== "PartialOperation") {
									throw new Error(`${r.error.message}, not an unproved narrowing`)
								}
								return
							}
							if (
								r.error.reason._tag !== "RecursionRefused" ||
								!sameRefusal(r.error.reason.cause, expected.refusal)
							) {
								throw new Error(`${r.error.message}, not ${expected.refusal.kind}`)
							}
							return
						}
						if (!r.ok) {
							throw new Error(`${r.error.message}, not admitted`)
						}
						const recursive = theRecursive(r.value)
						const cert = recursive.termination
						if (
							cert.kind !== expected.family ||
							cert.stateEstimate !== expected.estimate ||
							cert.premises.length !== (expected.counters ? 1 : 0)
						) {
							throw new Error(
								`${cert.kind} with estimate ${cert.stateEstimate}, not ${expected.family} with ${expected.estimate}`
							)
						}
						for (const g of graphs) {
							/** The estimate over the graph: each column's data counts the values it takes on the graph's edges. */
							const over = estimateWith(spec, dataValuesOver(spec, g))
							if (over.kind === "refused") {
								throw new Error(`refused for ${over.refusal.kind} over a graph`)
							}
							if (over.estimate * BigInt(g.ranks.length) > BigInt(maxIterations)) {
								c.note("a fixpoint past the reference's step limit")
								continue
							}
							const reached = BigInt(statesPerVertex(r.value, recursive, g))
							c.note("a fixpoint reached")
							if (reached > over.estimate) {
								throw new Error(
									`a vertex carries ${reached} states at the fixpoint, above the estimate ${over.estimate} over the graph's data (${cert.stateEstimate} with its data once)`
								)
							}
							if (reached === over.estimate) {
								c.note("a fixpoint at its estimate")
							}
							if (reached > cert.stateEstimate) {
								c.note("a vertex holding more states than the estimate with its data once")
							}
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "a reference model of termination.ts's rules, and the reference evaluator's fixpoint over generated graphs"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/recursion/certificates.test.ts#generatedRecursionsAgainstTheTerminationProofRulesGivesEveryGeneratedDefinitionTheVerdictFamilyAndEstimateTheRulesGiveItAndNoVertexMoreStatesThanTheEstimateAtTheFixpoint:100.8:0.2.5.1.1.1.0.d.1.0.2.0.0.0.0.4.0.0.0.1.0.2.0.1.0.2.1.1.4.3.0.7.0.0.1.1.5.6.4.0.0.1.3.1.1.4.6.9.e.3.193r.1bb7.3.6tj.5fh.2.17yx.26l.2.5nq.joz.6.qhc.qcx.5.1ebv.6"
					),
					reason:
						"a counter stepping by -3 toward a bound near smallint's minimum reaches the minimum, from where its next step leaves smallint: once admitted with 131116 states per vertex, and the reference's fixpoint over them ran for an hour",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/recursion/certificates.test.ts#generatedRecursionsAgainstTheTerminationProofRulesGivesEveryGeneratedDefinitionTheVerdictFamilyAndEstimateTheRulesGiveItAndNoVertexMoreStatesThanTheEstimateAtTheFixpoint:-:g.0.0.0.0.0.0.0.0.0.5.0.1.1.1.1.0.1.0.0.0.0.0"
					),
					reason:
						"plants a fixpoint at its estimate: a counter stepping by 1 to a literal bound, with a mark switch, over a self-loop",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/recursion/certificates.test.ts#generatedRecursionsAgainstTheTerminationProofRulesGivesEveryGeneratedDefinitionTheVerdictFamilyAndEstimateTheRulesGiveItAndNoVertexMoreStatesThanTheEstimateAtTheFixpoint:10.4:0.1.0.0.0.0.0.0.0.0.4.1.0.0.0.2.0.0.0.1.0.0.1.1.0.1.0.0.0.0.0"
					),
					reason:
						"plants a carrier overflow at a literal bound: a counter stepping by 3 below smallint's maximum less one, which the drawn guards reach a few times a run",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/recursion/certificates.test.ts#generatedRecursionsAgainstTheTerminationProofRulesGivesEveryGeneratedDefinitionTheVerdictFamilyAndEstimateTheRulesGiveItAndNoVertexMoreStatesThanTheEstimateAtTheFixpoint:-:f.1.1.0.0.0.0.4.1.0.0.0.0.1.1.0.3.0.0.0.0.0.4.1.0.0.0.0.1.1.0.3.0.0.0.0.0.0.1.1.2.0.0.3.pa8.pa8.1.pa8.0.0.0.pa8.2.pa8.0"
					),
					reason:
						"two arms read an edge's cost and the cost plus one into t, and a vertex entered by edges of costs 1 and -1 holds 7 states, which the estimate, counting t's data once, puts at 6: the fixpoint compared a vertex with the data once",
					since: "2026-10-29"
				}
			],
			kills: [
				{
					file: "packages/engine/src/check/recursion/termination.ts",
					original: "\t\tconst produced = limit + delta",
					replacement: "\t\tconst produced = limit + delta + delta",
					why: "A counter's last produced value read one step past its bound; the certificates search fails."
				}
			]
		}
	)
