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
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): flights-drift-extra (the drift check reads the server's lock-table
 * settings in a flight of their own before its own).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { applyOnSession, checkDrift, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import { type MigrationTarget, parseTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { type MigrationSession, migrationSession } from "#adapter/migrate/session.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { kept, reviewedSource } from "#test/pg/migrate/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftChain, fromEmpty, noDeclarations, ownedBy } from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { frameOf, type Tapped, tappedSession } from "#test/support/wire-tap.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

const versions = [
	[shopV1, noDeclarations],
	[shopV2, noDeclarations],
	[shopV3, shopV3Declared]
] as const

/** A history of `versions` folders, applied first up to folder `split` (0: none, the empty snapshot), then whole. */
interface History {
	readonly versions: number
	readonly split: number
}

/** Every history of one to three versions, each split at every folder from none to its last. */
const historyGen: Gen<History> = (source) => {
	const count = source.draw(int(1, versions.length))
	return { versions: count, split: source.draw(int(0, count)) }
}

type FlightFeature =
	| "an absent ledger admitted"
	| "every folder in one apply"
	| "a no-transaction file"
	| "the rest of a history after its start"
	| "nothing pending"

/** The steps an apply ran, as its report says: the survey step, each applied folder's files (a transactional file one
 * flight; a no-transaction file one for its folder row, recorded unfinished under the ledger's lock before its first
 * statement so that no Db runs while its statements run alone, one per statement and one for its rows) or its row
 * alone, the schema's drift check, and the release of its apply lock. */
const stepsOf = (
	target: MigrationTarget,
	report: SchemaApplyReport,
	c: { note: (f: FlightFeature) => void }
) => {
	const parsed = succeeded(parseTarget(target, { database: "unparsed", roles: { kind: "stems" } }))
	let steps = 1
	for (const applied of report.applied) {
		const folder = defined(
			Option.getOrUndefined(Arr.findFirst(parsed.folders, (f) => f.name === applied.folder)),
			`the applied folder ${applied.folder}`
		)
		if (folder.files.length === 0) {
			steps += 1
		}
		for (const name of applied.files) {
			const file = defined(
				Option.getOrUndefined(Arr.findFirst(folder.files, (f) => f.name === name)),
				`the applied file ${name}`
			)
			if (file.noTransaction) {
				c.note("a no-transaction file")
			}
			steps += file.noTransaction ? 1 + file.statements.length + 1 : 1
		}
	}
	if (report.applied.length === 0) {
		c.note("nothing pending")
	}
	return steps + 2
}

/** The apply of `target` on the tapped session: its round trips are exactly the steps its report says it ran. */
const appliedIn = (
	tapped: Tapped,
	m: MigrationSession,
	target: MigrationTarget,
	c: { note: (f: FlightFeature) => void }
) =>
	Effect.gen(function* () {
		const mark = tapped.mark()
		const [report] = yield* applyOnSession(m, [target])
		const window = tapped.since(mark)
		const ran = defined(report, "the schema's report")
		assert.equal(
			window.roundTrips,
			stepsOf(target, ran, c),
			`${target.snapshot.schema}: round trips of the apply`
		)
		return ran
	})

/** The drift check of `target`'s snapshot alone: one round trip, framed by its BEGIN and ROLLBACK, ending idle. */
const admittedAlone = (tapped: Tapped, m: MigrationSession, target: MigrationTarget) =>
	Effect.gen(function* () {
		const snapshot = target.snapshot
		const statements = succeeded(statementsFor(snapshot.schema))
		const mark = tapped.mark()
		yield* checkDrift(m, snapshot, statements)
		const window = tapped.since(mark)
		assert.equal(window.roundTrips, 1, "the drift check is one round trip")
		assert.deepEqual(
			frameOf(window),
			{
				kind: "framed",
				isolation: "SERIALIZABLE",
				access: "read write",
				deferrable: false,
				end: "rollback"
			},
			"the drift check's framing"
		)
		assert.deepEqual(window.backend.at(-1), { type: "Z", status: "I" }, "the drift check ends idle")
	})

layer(Substrate.layer)("every step of grizzle migrate is one flight", (it) => {
	it.effect("an apply sends one flight per step, and the drift check after it exactly one", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const owner = substrate.owner.role
				return yield* exhaust(
					{
						box: "the shop's histories of one to three versions, each applied up to every split folder, then whole, then again",
						oracle: {
							kind: "specification",
							name: "the runner's documented steps restated over its report: one round trip per step, the drift check one"
						},
						suite: "migrate/flights",
						generator: historyGen,
						literal: Formatter.format,
						coverage: requiredInSpace<FlightFeature>([
							"an absent ledger admitted",
							"every folder in one apply",
							"a no-transaction file",
							"the rest of a history after its start",
							"nothing pending"
						]),
						caseHang
					},
					(history, c) =>
						Effect.gen(function* () {
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
						})
				)
			})
		)
	)
})
