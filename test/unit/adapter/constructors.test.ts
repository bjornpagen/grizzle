import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { serializationRefusal, transientReason } from "#adapter/errors/execution.ts"
import { applyOutcome, transientFailureOf } from "#adapter/outcomes/index.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import { fenceReason } from "#adapter/wire/batch.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import type { UniqueAbort } from "#compiler/plan/change.ts"
import { admittedIdentifier } from "#compiler/plan/common.ts"
import * as Public from "#index.ts"
import { assert } from "#test/support/assert.ts"
import {
	adapterBound,
	allFeatures,
	constructorCases,
	type DrawnReason,
	engineReason,
	type Feature,
	publicBound,
	publiclyBuilt,
	publicReason,
	publicServerError,
	type Reads,
	reportFields,
	serializableOf,
	staleOf
} from "#test/unit/adapter/constructors.fixtures.ts"

/**
 * The public failure and outcome constructors build every failure and outcome exactly as the adapter does, carrying
 * each drawn fact, and the adapter's classifications build the same values.
 *
 * Budget: its suite's count before the conversion (unit/adapter/public-constructors: 1000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a). At those counts its kill "40P01 is read as 40001, a deadlock as a
 * serialization failure." survived at TEST_SEED=1 (toolchain-test run of 2026-11-16 08:21Z); at the runner's 150 runs
 * and 200 steered, which it was landed at, it is killed, so it keeps them.
 */
export const thePublicFailureAndOutcomeConstructorsBuildEveryFailureAndOutcomeExactlyAsTheAdapterDoesCarryingEachDrawnFactAndTheAdaptersClassificationsBuildTheSameValues =
	property.explore(constructorCases, {
		needs: {},
		situations: allFeatures satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: CaseOf<Feature>) => (drawnCase) =>
			Effect.sync(() => {
				switch (drawnCase.kind) {
					case "report": {
						c.note("report")
						const r = drawnCase.report
						for (const field of reportFields) {
							const value = r[field]
							if (value === "") {
								c.note("report field empty")
							} else if (value !== undefined) {
								c.note("report field given")
							}
						}
						const error = publicServerError(r)
						const serializable = serializableOf(error)
						if (serializable !== undefined) {
							c.note("report serializable")
						}
						const refused = serializationRefusal(error)
						assert.deepEqual(
							refused,
							serializable === undefined
								? undefined
								: new Public.TransientFailure({ reason: serializable, error })
						)
						for (const step of ["lock", "guard"] as const) {
							const stale = staleOf(step, error)
							assert.deepEqual(Option.getOrUndefined(fenceReason(step, error)), stale)
							if (stale === undefined) {
								continue
							}
							c.note("report stale")
							const snapshot = new Public.StaleSnapshot({
								reason: stale,
								snapshot: drawnCase.snapshot,
								error
							})
							assert.equal<string>(snapshot.snapshot, drawnCase.snapshot)
							assert.equal(snapshot.reason, stale)
							assert.equal(snapshot.error, error)
						}
						return
					}
					case "abort": {
						c.note(drawnCase.matched ? "abort matched" : "abort unmatched")
						c.note(`abort ${drawnCase.reason}`)
						const error = publicServerError({
							...drawnCase.report,
							constraint: drawnCase.constraint
						})
						const listed = drawnCase.matched
							? drawnCase.constraint
							: `${drawnCase.constraint}_other`
						const aborts: ReadonlyArray<UniqueAbort> = [
							{
								constraint: admittedIdentifier(listed),
								relation: StoredRelationName(drawnCase.relation),
								reason: drawnCase.reason
							}
						]
						const failure = transientFailureOf(error, aborts)
						const reason: DrawnReason =
							drawnCase.reason === "PutTargetConflict"
								? { _tag: drawnCase.reason, relation: drawnCase.relation }
								: {
										_tag: drawnCase.reason,
										relation: drawnCase.relation,
										constraint: drawnCase.constraint
									}
						assert.deepEqual(
							failure,
							drawnCase.matched
								? new Public.TransientFailure({ reason: publicReason(reason), error })
								: undefined
						)
						if (failure !== undefined) {
							assert.ok(publiclyBuilt(failure) && publiclyBuilt(failure.reason))
						}
						return
					}
					case "transient": {
						c.note(`transient ${drawnCase.reason._tag}`)
						const converted = transientReason(engineReason(drawnCase.reason))
						assert.deepEqual(converted, publicReason(drawnCase.reason))
						assert.ok(publiclyBuilt(converted))
						return
					}
					case "bound": {
						c.note(`bound ${drawnCase.bound._tag}`)
						const converted = adapterBound(drawnCase.bound)
						assert.deepEqual(converted, publicBound(drawnCase.bound))
						assert.ok(publiclyBuilt(converted))
						return
					}
					case "committed": {
						const outcome: ApplyOutcome<Reads> = applyOutcome.committed(
							drawnCase.counts,
							drawnCase.reads
						)
						c.note(`outcome ${outcome.kind}`)
						assert.ok(Object.isFrozen(outcome))
						const changed = Arr.some(
							drawnCase.counts,
							(count) => count.added !== 0n || count.deleted !== 0n || count.put !== 0n
						)
						switch (outcome.kind) {
							case "accepted":
								assert.ok(changed, "accepted only when some count is nonzero")
								assert.deepEqual(outcome.counts, drawnCase.counts)
								assert.ok(Object.isFrozen(outcome.counts))
								assert.ok(Arr.every(outcome.counts, (count) => Object.isFrozen(count)))
								assert.equal(outcome.reads, drawnCase.reads)
								return
							case "no-change":
								assert.ok(!changed, "no-change only when every count is zero")
								assert.equal(outcome.reads, drawnCase.reads)
								return
						}
					}
					case "rejected": {
						c.note("outcome invariant-rejected")
						const outcome: ApplyOutcome<Reads> = applyOutcome.invariantRejected(
							drawnCase.refused,
							drawnCase.witness
						)
						assert.ok(Object.isFrozen(outcome))
						assert.deepEqual(outcome, {
							kind: "invariant-rejected",
							refused: drawnCase.refused,
							witness: drawnCase.witness
						})
						return
					}
					case "outside": {
						c.note("outcome outside-world")
						const outcome: ApplyOutcome<Reads> = applyOutcome.outsideWorld(drawnCase.relation)
						assert.ok(Object.isFrozen(outcome))
						assert.deepEqual(outcome, { kind: "outside-world", relation: drawnCase.relation })
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "each constructor carries its facts as given, and the adapter's classification of the same facts is the public value"
		},
		budget: { runs: 150, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/errors/failures.ts",
				original:
					'const said = (text: string | undefined): string | undefined => (text === "" ? undefined : text)',
				replacement: "const said = (text: string | undefined): string | undefined => text",
				why: "An empty report field is kept as one that says something."
			},
			{
				file: "packages/grizzle/src/adapter/errors/execution.ts",
				original: "\t\t\t? new Deadlock()",
				replacement: "\t\t\t? new SerializationFailure()",
				why: "40P01 is read as 40001, a deadlock as a serialization failure."
			}
		]
	})
