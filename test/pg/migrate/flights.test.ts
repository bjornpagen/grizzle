/**
 * Every step of `grizzle migrate` is one flight, counted on the protocol through the tap (test/support/wire-tap.ts).
 *
 * A step is a list of statements sent together: an apply sends the survey step (the session's role, each schema's
 * owner, apply lock and ledger), one flight per transactional file, one for a no-transaction file's folder row, which
 * the stale-Db fence records before its statements, one per statement of it and one for its ledger rows, one per
 * folder recorded alone, then one drift check per schema and the release of its apply lock. The drift check alone is
 * exactly one flight: the ledger's two reads apart, then one SERIALIZABLE transaction that replays the snapshot into a
 * scratch schema, reads both and rolls back.
 *
 * - **Property:** each apply's round trips are exactly the steps its report says it ran, and each drift check run
 *   alone after it is one round trip, framed as a read-write SERIALIZABLE transaction that rolls back (frameOf, the
 *   frame's structure read off its simple queries), the session idle after it.
 * - **Oracle:** the flight model (stepsOf), the runner's documented steps restated over its own report.
 * - **Box, exhausted:** the shop's histories of one to three versions, each applied first up to a split folder (none at
 *   all: the empty snapshot, with no ledger yet), then whole, then again with nothing pending.
 * - **Features:** an absent ledger admitted, every folder in one apply, a no-transaction file, the rest of a history
 *   after its start, and nothing pending.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { migrationSession } from "#adapter/migrate/session.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import {
	admittedAlone,
	appliedIn,
	type FlightFeature,
	historyGen,
	versions
} from "#test/pg/migrate/flights.fixtures.ts"
import { kept, reviewedSource } from "#test/pg/migrate/support.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, ownedBy } from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

/** Every step of grizzle migrate is one flight an apply sends one flight per step, and the drift check after it exactly one. */
export const flights = property.exhaust(finite(historyGen), {
	needs: { caseSubstrate: Substrate.installing },
	situations: [
		"an absent ledger admitted",
		"every folder in one apply",
		"a no-transaction file",
		"the rest of a history after its start",
		"nothing pending"
	] satisfies ReadonlyArray<Reached<FlightFeature>>,
	check:
		({ caseSubstrate }, c: Case<FlightFeature>) =>
		(history) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const owner = substrate.owner.role

					const allocated = yield* substrate.schema({ create: false, label: "flights" })
					const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
					const tapped = yield* tappedSession({
						cluster: substrate.cluster,
						database: substrate.database,
						role: owner,
						password: substrate.owner.password
					})
					const m = migrationSession(tapped.session, {
						database: substrate.database,
						roles: { kind: "stems" }
					})
					const over = {
						schema: atName(allocated),
						owner: ownedBy(owner),
						extensions: [],
						codes: firstCodes
					}
					const folders: ReadonlyArray<GenerateResult> = draftChain(
						Arr.map(versions.slice(0, history.versions), ([desc, declared]) => ({
							desc,
							options: over,
							declared
						})),
						fromEmpty
					)
					const sources = Arr.map(folders, (g) => reviewedSource(g, kept))
					const last = defined(folders.at(-1), "the history's last folder")
					const whole: MigrationTarget = { snapshot: last.snapshot, folders: sources }
					const first: MigrationTarget =
						history.split === 0
							? {
									snapshot: emptySnapshot({ schemaName: last.snapshot.schemaName, schema }),
									folders: []
								}
							: {
									snapshot: defined(folders[history.split - 1], "the split folder").snapshot,
									folders: sources.slice(0, history.split)
								}
					yield* appliedIn(tapped, m, first, c)
					yield* admittedAlone(tapped, m, first)
					const ledger = yield* readLedger(m, schema, succeeded(statementsFor(schema)))
					if (ledger.complete.length === 0 && ledger.partial === undefined) {
						c.note("an absent ledger admitted")
					}
					const rest = yield* appliedIn(tapped, m, whole, c)
					if (rest.applied.length === folders.length) {
						c.note("every folder in one apply")
					} else if (rest.applied.length > 0) {
						c.note("the rest of a history after its start")
					}
					yield* admittedAlone(tapped, m, whole)
					yield* appliedIn(tapped, m, whole, c)
				}),
				Substrate,
				caseSubstrate
			),
	oracle: {
		kind: "specification",
		name: "the runner's documented steps restated over its report: one round trip per step, the drift check one"
	},
	box: "the shop's histories of one to three versions, each applied up to every split folder, then whole, then again",
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original: "\tconst answered = yield* Effect.mapError(",
			replacement:
				"\tyield* Effect.orDie(session.apart([oneShotStatement(lockTableRead.sql, [])]))\n\tconst answered = yield* Effect.mapError(",
			why: "The drift check reads the server's lock-table settings in a flight of their own before its own."
		}
	]
})
