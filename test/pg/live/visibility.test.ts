/**
 * The live leader's visibility judgment (adapter/live/leader.ts, a round's first step): a decoded transaction is sent on
 * only once the snapshot the leader reads sees its commit, so a read begun after its key arrives sees its change. A
 * transaction the leader decodes has its COMMIT record flushed, which is before it leaves PostgreSQL's proc array
 * (xact.c RecordTransactionCommit, then ProcArrayEndTransaction), so the leader can read it while every new snapshot
 * still holds it running; a key sent then wakes a subscription whose re-read misses the change, and no later key wakes
 * it again (the live exactness property hung on it under load, 93456d045).
 *
 * Each case draws a schedule of writer transactions, each one inserting a row of its own and committing, and the
 * moment a REPEATABLE READ observer takes its snapshot among their steps: before a writer began, while it runs, or after
 * it committed, in every order. The observer reads every writer's row at that moment, and once every writer committed
 * runs the leader's visibility judgment on the same transaction, so on the same snapshot, of every writer's
 * transaction id as pgoutput's Begin carries it (32 bits).
 *
 * Property: the judgment holds a writer's commit seen exactly where the observer's snapshot reads its row.
 *
 * The oracle is PostgreSQL's MVCC: the row a transaction wrote is read under a snapshot exactly where that snapshot
 * sees the transaction's commit.
 *
 * Features: a commit before the snapshot, a writer running across it below a later commit before it, a writer running
 * across it past every commit before it, a writer begun after it.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, constant } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { servedLiveOf } from "#compiler/plan/common.ts"
import {
	type Feature,
	featuresOf,
	judgedSeen,
	laterCommitBelow,
	Misjudged,
	scheduleGen
} from "#test/pg/live/visibility.fixtures.ts"
import { qualified } from "#test/support/substrate.ts"
import {
	freshSchema,
	ownerSession,
	Substrate,
	baseSubstrate
} from "#test/support/substrate/substrate.ts"

/**
 * The live leader's visibility judgment holds a commit seen exactly where a snapshot reads its row, over generated schedules.
 */
export const theLiveLeadersVisibilityJudgmentHoldsACommitSeenExactlyWhereASnapshotReadsItsRowOverCasesGeneratedSchedules =
	property.explore(
		aimed(scheduleGen, [
			[
				"a writer running across the snapshot below a later commit before it",
				constant(laterCommitBelow)
			]
		]),
		{
			needs: { substrate2: Substrate.fresh(baseSubstrate) },
			situations: [
				"a commit before the snapshot",
				"a writer running across the snapshot below a later commit before it",
				"a writer running across the snapshot past every commit before it",
				"a writer begun after the snapshot"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				({ substrate2 }, notes: Case<Feature>) =>
				(c) =>
					Effect.provideServiceEffect(
						Effect.gen(function* () {
							notes.noteAll(featuresOf(c))
							const substrate = yield* Substrate
							const schema = yield* substrate.schema(freshSchema)
							const table = qualified(schema, "written")
							yield* substrate.admin.query(`CREATE TABLE ${table} (writer int4 NOT NULL)`, [])
							const served = servedLiveOf(schema, { kind: "source", tables: {} })
							if (served.kind === "none") {
								return yield* Effect.die("a live source serves its texts")
							}
							const writers = yield* Effect.forEach(indices(c.writers), (writer) =>
								substrate.session({ ...ownerSession(), label: `writer ${writer}` })
							)
							const observer = yield* substrate.session({ ...ownerSession(), label: "observer" })
							yield* observer.beginBelow("repeatable read")
							const xids: Array<number> = Arr.map(indices(c.writers), () => 0)
							const read: { seen: ReadonlySet<number> } = { seen: new Set() }
							for (const step of c.steps) {
								switch (step.kind) {
									case "begin": {
										const writer = Arr.getUnsafe(writers, step.writer)
										yield* writer.begin
										yield* writer.query(`INSERT INTO ${table} (writer) VALUES ($1::int4)`, [
											String(step.writer)
										])
										const [row] = yield* writer.values(
											"SELECT pg_catalog.xid(pg_catalog.pg_current_xact_id())::pg_catalog.text",
											[]
										)
										xids[step.writer] = Number(row?.[0])
										break
									}
									case "commit":
										yield* Arr.getUnsafe(writers, step.writer).commit
										break
									case "snapshot": {
										const rows = yield* observer.values(
											`SELECT writer::pg_catalog.text FROM ${table}`,
											[]
										)
										read.seen = new Set(Arr.map(rows, ([writer]) => Number(writer)))
										break
									}
								}
							}
							const judged = yield* judgedSeen(observer, served, xids)
							yield* observer.commit
							const wrong = Arr.filter(
								indices(c.writers),
								(writer) => judged.has(writer) !== read.seen.has(writer)
							)
							if (wrong.length > 0) {
								return yield* new Misjudged({
									report: `${Arr.join(
										Arr.map(
											wrong,
											(writer) =>
												`writer ${writer} (xid ${xids[writer]}, ${Arr.getUnsafe(featuresOf(c), writer)}): judged ${judged.has(writer) ? "seen" : "unseen"}, its row ${read.seen.has(writer) ? "read" : "unread"} by the snapshot`
										),
										"\n"
									)}\n${Formatter.format(c)}`
								})
							}
						}).pipe(Effect.scoped),
						Substrate,
						Effect.map(substrate2, (taken) => taken.substrate)
					),
			oracle: {
				kind: "postgresql",
				name: "the observer's REPEATABLE READ snapshot reading each writer's row"
			},
			kills: [
				{
					file: "packages/engine/src/live/replication.ts",
					original: '\tif (full >= snapshot.horizon) {\n\t\treturn "ahead"\n\t}\n',
					replacement: "",
					why: "The leader places a decoded transaction at or past its snapshot's horizon, outside the running set, as seen, so a commit the leader decoded before it left the proc array reads as visible to a snapshot that does not see it: the defect 93456d045 fixed, which the kept case is."
				}
			],
			kept: [
				{
					token: ReplayToken(
						"test/pg/live/visibility.test.ts#theLiveLeadersVisibilityJudgmentHoldsACommitSeenExactlyWhereASnapshotReadsItsRowOverCasesGeneratedSchedules:-:1.0.0.0.1"
					),
					reason:
						"writer 1 runs across the snapshot past every commit before it, as a transaction whose COMMIT the leader decoded runs until it leaves the proc array: no snapshot sees it, and it stands at the snapshot's horizon, outside its running set",
					since: "2026-11-19"
				}
			]
		}
	)
