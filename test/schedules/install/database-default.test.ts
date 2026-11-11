/**
 * Two installations into one database at once: each sets the database's default_transaction_isolation, one row of
 * pg_db_role_setting, and both commit.
 *
 * Every installation's first migration runs the database-default blocks (databaseDefaults,
 * each as sql/print.ts prints it), each an ALTER DATABASE ... SET of the database's one pg_db_role_setting row. Two
 * transactions that update that row at once fail the later with XX000 (tuple concurrently updated), as installations
 * into one shared worker database did; so each block first takes a transaction-scoped advisory lock, and a second
 * installation's block waits for the first to commit, then sets the default again.
 *
 * Over every interleaving of two installations' transactions, each running the blocks and committing as the
 * database's owner (`every`): both commit; in an interleaving where both ran their blocks before either
 * committed, the later block waited on the earlier installation, and in any other nothing waited; and the database's
 * default isolation is SERIALIZABLE after.
 *
 * Oracle: the specification restated as a judge of each interleaving (judge), over every interleaving, reduced by
 * sleep sets; the database's settings read after each.
 *
 * Feature: an interleaving in which a block waited, which the space must hold.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): database-default-unlocked (a block tries its advisory lock and runs on
 * without it, so two installations update the settings row at once).
 */

import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { databaseDefaults } from "#compiler/physical/ddl/isolation.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import {
	allowed,
	every,
	exploreEnv,
	exploreInterleavings,
	type Interleaving,
	type Judgment,
	refusedJudgment,
	relationsFootprint,
	runawayInterleavings,
	interleaveStep,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const installations = ["first", "second"] as const

/** The blocks each installation runs, every one a write of the database's settings row. */
const blocks = Arr.map(databaseDefaults, (d) =>
	interleaveStep(printStatement(d), relationsFootprint(["pg_db_role_setting"]))
)

const txns: ReadonlyArray<Txn> = Arr.map(installations, (session): Txn => ({
	kind: "direct",
	session,
	steps: blocks,
	end: "commit",
	after: undefined
}))

/** The database's own settings, as the observer reads them. */
const settings =
	"SELECT pg_catalog.array_to_string(s.setconfig, ',') FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0::oid"

/** When a session's move at `step` was issued on the run's clock: its first block at 0, its COMMIT after its blocks. */
const issued = (run: Interleaving, session: string, at: number): number =>
	Option.getOrThrowWith(
		Arr.findFirst(run.moves, (m) => m.session === session && m.step === at),
		() => new Error(`${session}'s move ${at} never ran`)
	).issued

/** Why a run is not allowed, or undefined. */
const judge = (run: Interleaving): Judgment => {
	const failed = Arr.filter(Rec.values(run.results), (r) => r._tag !== "Committed")
	if (failed.length > 0) {
		return refusedJudgment(
			`every installation commits: ${Arr.join(
				Arr.map(
					failed,
					(r) => `${r.session} ${r._tag === "Failed" ? describeStepOutcome(r.failure) : r._tag}`
				),
				"; "
			)}`
		)
	}
	const [first, second] = installations
	const begins = (s: string) => issued(run, s, 0)
	const commits = (s: string) => issued(run, s, blocks.length)
	const overlapped = begins(first) < commits(second) && begins(second) < commits(first)
	if (overlapped) {
		const [earlier, later] = begins(first) < begins(second) ? [first, second] : [second, first]
		if (
			!Arr.some(
				run.waits,
				(w) => w.session === later && Arr.some(w.holders, (h) => h.session === earlier)
			)
		) {
			return refusedJudgment(
				`${later}'s block, run before ${earlier} committed, waited on no lock of ${earlier}`
			)
		}
	} else if (run.waits.length > 0) {
		return refusedJudgment("installations that ran one after the other waited")
	}
	if (run.state._tag !== "Read") {
		return refusedJudgment("the database's settings were not read")
	}
	const set = Arr.flatMap(run.state.rows, (row) => Str.split(row[0] ?? "", ","))
	if (!set.includes("default_transaction_isolation=serializable")) {
		return refusedJudgment(
			`the database's default isolation is SERIALIZABLE: ${Arr.join(set, ", ")}`
		)
	}
	return allowed
}

layer(Substrate.layer, { excludeTestServices: true })(
	"two installations into one database at once",
	(it) => {
		it.effect(
			"both set the database's default isolation and commit, the later waiting on the earlier",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const env = yield* exploreEnv(s)
					const direct = yield* openActors(s, {
						first: { kind: "raw", as: s.owner },
						second: { kind: "raw", as: s.owner }
					})
					const report = yield* exploreInterleavings(
						env,
						{ direct, grizzle: {} },
						{
							name: "two installations' database defaults",
							txns,
							reset: Effect.void,
							state: { _tag: "Read", sql: settings },
							model: (run) => Effect.sync(() => judge(run)),
							maxInterleavings: runawayInterleavings
						},
						every
					)
					assert.ok(report.blocked > 0, `of ${report.interleavings} interleavings none blocked`)
				})
		)
	}
)
