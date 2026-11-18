/** What the properties of flights.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { applyOnSession, checkDrift, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import { type MigrationTarget, parseTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { frameOf, type Tapped } from "#test/support/wire-tap.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

export const versions = [
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
export const historyGen: Gen<History> = (source) => {
	const count = source.draw(int(1, versions.length))
	return { versions: count, split: source.draw(int(0, count)) }
}

export type FlightFeature =
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
export const appliedIn = (
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
export const admittedAlone = (tapped: Tapped, m: MigrationSession, target: MigrationTarget) =>
	Effect.gen(function* () {
		const snapshot = target.snapshot
		const statements = succeeded(statementsFor(snapshot.schema))
		const mark = tapped.mark()
		yield* checkDrift(m, snapshot, statements, [])
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
