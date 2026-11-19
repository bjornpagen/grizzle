import { assert, lacks } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type AgreedFeature,
	caseOf,
	certifiedIn,
	dangles,
	optimizedIn,
	queries,
	queryNames,
	sketchGen
} from "#test/pg/recursion/graph/existence.fixtures.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Endpoint existence during deferred violations the transaction artifact of each query agrees with the reference over a violated deferred law. */
export const endpointExistenceDuringDeferredViolationsTheTransactionArtifactOfEachQueryAgreesWithTheReferenceOverAViolatedDeferredLaw =
	property.explore(sketchGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(
			queryNames,
			(q): AgreedFeature => `${q} agreed over a dangling edge`
		) satisfies ReadonlyArray<Reached<AgreedFeature>>,
		/** Its pre-conversion budget: runs 16, coverage cases 32 (existence.test.ts at 4fbc3e95). */
		budget: { runs: 16, steered: 32 },
		check:
			({ tx }, c: Case<AgreedFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const schema = yield* seat.schema("deferred")

							const labelled = caseOf(k.query, queries[k.query], k.network, k.person)
							const outcome = yield* runLabelledOracle(
								labelled,
								optimizedIn("transaction"),
								reference,
								{
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								}
							)
							assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
							const agreed = yield* runLabelledOracle(
								labelled,
								optimizedIn("transaction"),
								conservative,
								{
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								}
							)
							assert.equal(agreed.comparison.equal, true, printOutcome(agreed))
							lacks(certifiedIn(labelled, "transaction"), "R03.elimination")
							c.note(
								`${k.query} agreed over ${dangles(k.network) ? "a dangling edge" : "a lawful state"}`
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator and the conservative lowering over the same state, its deferred laws perhaps violated"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/evidence.ts",
				original: '\ttransaction: ["immediate", "queryLocal"]',
				replacement: '\ttransaction: ["immediate", "committedSnapshot", "queryLocal"]',
				why: "A transaction admits committed-snapshot evidence (ir/evidence.ts admits), so a deferred containment, which may be false before COMMIT, proves existence inside a transaction."
			}
		]
	})
