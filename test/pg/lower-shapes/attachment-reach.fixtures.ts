/** What attachment-reach.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { Num } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import {
	fullWorldRole,
	type PgClassState,
	pgClassStates,
	servedRead,
	servedRun,
	type StateLoad,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { readWork } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"

const i = int4

/**
 * A ledger's sittings and item sessions, as qti-pie's holds them: each sitting of a learner's stage; each item session
 * of a learner by its place, of an item at a stage; each item's own control and each learner's stage's control, either
 * of which sets a session's attempt limit; and each session's attempts.
 */
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i }, ["sitting"])
const Session = relation("Session", { child: i, n: i, item: i, stage: i }, ["child", "n"])
const ItemControl = relation("ItemControl", { item: i, limit: i }, ["item"])
const StageControl = relation("StageControl", { child: i, stage: i, limit: i }, ["child", "stage"])
const Attempt = relation("Attempt", { child: i, n: i, at: i }, ["child", "n", "at"])
const Ledger = schema("AttachmentReach", [Sitting, Session, ItemControl, StageControl, Attempt], [])

/**
 * Each item session's control, as qti-pie's ItemSessionControl holds it: its limit by its item's control or by its
 * learner's stage's, a union over every learner's sessions, computed where it is read (no unit holds it, so nothing
 * stores it).
 */
const Control = derived(
	"Control",
	query(Ledger)
		.rule((r) => {
			const { child, n, item, stage } = v(Session, "byItem")
			const { limit } = v(ItemControl, "itemControl")
			return r
				.match(Session, { child, n, item, stage })
				.match(ItemControl, { item, limit })
				.find({ child, n, limit })
		})
		.rule((r) => {
			const { child, n, item, stage } = v(Session, "byStage")
			const { limit } = v(StageControl, "stageControl")
			return r
				.match(Session, { child, n, item, stage })
				.match(StageControl, { child, stage, limit })
				.find({ child, n, limit })
		})
)
const Controlled = schema.extend([Ledger], "AttachmentReachControlled", [Control], [])

/**
 * A sitting's item sessions, at the parameter, each with its control attached and, under the control, the attempts its
 * limit leaves it before its first, read from the control again at the session's key: metis's resume (`sitting`) reads
 * qti-pie's session control so (ledger/session-control.ts sessionControlOf, its `control` with `left` under it). The
 * learner comes of the sitting, so no statement value holds a column of Control.
 */
const sittingRead = query(Controlled)
	.rule((r) => {
		const { child, n, stage } = v(Session, "session")
		return r
			.match(Sitting, { sitting: r.param("sitting", i), child, stage })
			.match(Session, { child, n, stage })
			.find({ child, n })
	})
	.attach(
		"control",
		(head) =>
			query(Controlled)
				.rule((r) => {
					const { limit } = v(Control, "control")
					return r
						.match(Control, { child: head.child, n: head.n, limit })
						.find({ child: head.child, n: head.n, limit })
				})
				.attach(
					"left",
					(control) =>
						query(Controlled).rule((r) => {
							const { limit } = v(Control, "untried")
							return r
								.match(Control, { child: control.child, n: control.n, limit })
								.where(r.gt(limit, 0), r.not(Attempt, { child: control.child, n: control.n }))
								.find({ left: Num.sub(limit, 0) })
						}),
					"array"
				),
		"array"
	)

/** The schema installed through its first migration, with a reader whose workload's indexes the read earns. */
export const reachTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "attachment reach",
	fixture: Controlled,
	programs: { sittingRead },
	contexts: [],
	label: "attachment_reach",
	ambient: ordinarySession
})

/**
 * A case: the read sitting's `sessions` item sessions, of items 1 to `sessions`; `learners` learners' sittings beside it,
 * each of `beside` sessions; then `more` learners stored beside them before the read is run again; and the pg_class
 * state its tables stand in as each load ends (test/support/advice.ts PgClassState).
 */
export interface ReachCase {
	readonly sessions: number
	readonly learners: number
	readonly beside: number
	readonly more: number
	readonly state: PgClassState
}

export const reachGen: Gen<ReachCase> = (s) => ({
	sessions: s.draw(int(1, 8)),
	learners: s.draw(int(1, 4)),
	beside: s.draw(int(1, 8)),
	more: s.draw(int(20, 60)),
	state: s.draw(element(pgClassStates))
})

export type ReachFeature =
	| "beside few learners"
	| "beside many learners"
	| `its tables ${PgClassState}`

/**
 * The statements storing learners `from` to `to` (learner 1 the read sitting's, its sessions `sessions`, every other's
 * `beside`): each learner's sitting, its item sessions at stage 0, its stage's control, an attempt of each even session,
 * and each item's control.
 */
const stored = (
	installed: Installed,
	c: ReachCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const learners = `generate_series(${String(from)}, ${String(to)}) AS g(child)`
	const sessions = `generate_series(1, CASE WHEN child = 1 THEN ${String(c.sessions)} ELSE ${String(c.beside)} END) AS h(n)`
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT child, child, 0 FROM ${learners}`,
		`INSERT INTO ${names.table(Session)} SELECT child, n, n, 0 FROM ${learners}, ${sessions}`,
		`INSERT INTO ${names.table(StageControl)} SELECT child, 0, 2 FROM ${learners}`,
		`INSERT INTO ${names.table(Attempt)} SELECT child, n, 1 FROM ${learners}, ${sessions} WHERE n % 2 = 0`,
		...(from === 1
			? [
					`INSERT INTO ${names.table(ItemControl)} SELECT item, item % 3 FROM generate_series(1, ${String(Math.max(c.sessions, c.beside))}) AS g(item)`
				]
			: [])
	]
}

/**
 * The CTEs of a plan each read by one scan: a CTE a statement holds is read at two places at least, since one read alone
 * is printed in place (sql/print-once.ts), and a held one of one read is a tuplestore per row bought for nothing.
 */
const readOnce = (plan: PlanNode): ReadonlyArray<string> => {
	const reads = new Map<string, number>()
	for (const n of planNodes(plan)) {
		if (n.nodeType === "CTE Scan" && Option.isSome(n.cte)) {
			reads.set(n.cte.value, (reads.get(n.cte.value) ?? 0) + 1)
		}
	}
	return Arr.flatMap([...reads], ([name, count]) => (count === 1 ? [name] : []))
}

/**
 * One case in its one transaction, which the case's end rolls back: the read sitting's learner and `learners` beside it
 * stored, its tables stood in the case's pg_class state, and the read of the sitting run under its carried advice once
 * the plan laws hold over it (test/support/advice.ts servedRun); then `more` learners stored beside them, stood again,
 * and the read run again: its work (test/support/judge.ts readWork) is no more than before. The sitting's
 * rows are the same, and the control's read and the one under it each read Control at the session's key, each arm a
 * seek of the session and of its control, which no other learner's rows enter; where a control read at its key under
 * the head alone, the read under it unreached, left Control the statement's, every learner's sessions' controls derived
 * whole and scanned once per session, so each learner stored beside adds to the work.
 */
export const runReach = (
	installed: Installed,
	connection: PgConnection,
	c: ReachCase,
	k: Case<ReachFeature>
) =>
	Effect.gen(function* () {
		const session: BenchSession = { values: connection.queryValues }
		const names = namesOf(installed)
		const storing = (first: number, units: number): StateLoad => ({
			tables: [
				names.table(Sitting),
				names.table(Session),
				names.table(ItemControl),
				names.table(StageControl),
				names.table(Attempt)
			],
			units,
			load: (from, to) =>
				Effect.forEach(
					stored(installed, c, first + from - 1, first + to - 1),
					(sql) => connection.query(sql, []),
					{ discard: true }
				)
		})
		yield* standIn(session, storing(1, 1 + c.learners), c.state)
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Controlled, []),
			sittingRead,
			"the read of the sitting"
		)
		const explained = Effect.map(servedRun(session, read, { sitting: 1 }), (plan) => {
			const once = readOnce(plan)
			assert.ok(
				once.length === 0,
				`${Formatter.format(c)}: the read holds ${Arr.join(once, ", ")} as a CTE read by one scan\n${read.statement.sql}`
			)
			return readWork(plan)
		})
		const few = yield* explained
		yield* standIn(session, storing(2 + c.learners, c.more), c.state)
		const many = yield* explained
		assert.ok(
			many <= few,
			`${Formatter.format(c)}: the read of the sitting reads ${String(few)} rows beside ${String(c.learners)} learners and ${String(many)} beside ${String(c.learners + c.more)}\n${read.statement.sql}`
		)
		k.note(c.learners < 3 ? "beside few learners" : "beside many learners")
		k.note(`its tables ${c.state}`)
	})
