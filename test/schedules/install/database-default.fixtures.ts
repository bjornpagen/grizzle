import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { databaseDefaults } from "#compiler/physical/ddl/isolation.ts"
import { printCommands } from "#compiler/sql/print.ts"
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
	interleaveStep,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const installations = ["first", "second"] as const

/**
 * The steps each installation runs: each block's commands as a driver sends them, one message each (sql/print.ts
 * printCommands), the database lock's and the block's own, every one footprinted on the database's settings row, so no
 * step of one installation commutes with another's.
 */
const blocks = Object.freeze(
	Arr.flatMap(databaseDefaults, (d) =>
		Arr.map(printCommands(d), (command) =>
			interleaveStep(command, relationsFootprint(["pg_db_role_setting"]))
		)
	)
)

const txns: ReadonlyArray<Txn> = Arr.map(installations, (session): Txn => ({
	kind: "direct",
	begin: beginSerializableAction,
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

/**
 * Two installations' blocks run in every interleaving over the case's own database, each as its owner: the judge holds
 * every run, and some run blocked.
 */
export const installationsCase = Effect.gen(function* () {
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
			model: (run) => Effect.sync(() => judge(run))
		},
		every
	)
	assert.ok(report.blocked > 0, `of ${report.interleavings} interleavings none blocked`)
})
