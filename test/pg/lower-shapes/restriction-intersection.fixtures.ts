/** What restriction-intersection.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import type { BenchSession } from "#bench/harness/session.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
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

const i = pg.integer

/**
 * Each child's sittings of its stages, its item sessions at their stages (keyed by child, stage and place too), and two
 * kinds of a session's controls, holds and pauses, each keyed by the session's child, stage and place and the control's
 * own number, as edullm's session control unites a session's stage controls and its own.
 */
const ItemSession = relation("ItemSession", { child: i, n: i, stage: i }, ["child", "n"])
const Hold = relation("Hold", { child: i, stage: i, n: i, held: i }, [
	"child",
	"stage",
	"n",
	"held"
])
const Pause = relation("Pause", { child: i, stage: i, n: i, held: i }, [
	"child",
	"stage",
	"n",
	"held"
])
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i }, ["sitting"])
/**
 * Two kinds of a stage's scores, each row a stage's score of an x and a y, keyed by its x first and by its y first, never
 * by its stage first; and probes, each an x and a y at a stage, of a batch: a read at a probe's x and stage and one at
 * its y and stage share the stage alone, no prefix of either key.
 */
const Score = relation("Score", { x: i, y: i, stage: i, v: i }, ["x", "stage", "v"])
const Grade = relation("Grade", { x: i, y: i, stage: i, v: i }, ["x", "stage", "v"])
const Probe = relation("Probe", { batch: i, probe: i, x: i, y: i, stage: i }, ["batch", "probe"])
const Ledger = schema(
	"RestrictionIntersection",
	[ItemSession, Hold, Pause, Sitting, Score, Grade, Probe],
	[
		key(on(ItemSession, "child", "stage", "n")),
		key(on(Score, "y", "stage", "v")),
		key(on(Grade, "y", "stage", "v"))
	]
)

/** Each session's controls, its holds and its pauses: a union. */
const control = query(Ledger)
	.rule((r) => {
		const { child, stage, n, held } = v(Hold, "hold")
		return r.match(Hold, { child, stage, n, held }).find({ child, stage, n, held })
	})
	.rule((r) => {
		const { child, stage, n, held } = v(Pause, "pause")
		return r.match(Pause, { child, stage, n, held }).find({ child, stage, n, held })
	})

/**
 * A sitting's sessions, each with its stage's controls and its own attached, as edullm's controlOf reads session control
 * at a session's stage and at the session itself: the attachment's child unites two rules, each a read of the union, one
 * at the session's child and stage and one at its child, stage and place, two restrictions that share the child and the
 * stage.
 */
const controlRead = query(Ledger)
	.rule((r) => {
		const { child, n, stage } = v(ItemSession, "session")
		return r
			.match(Sitting, { sitting: r.param("sitting", i), child, stage })
			.match(ItemSession, { child, n, stage })
			.find({ child, n, stage })
	})
	.attach(
		"controls",
		(head) =>
			query(Ledger)
				.rule((r) => {
					const { n: other, held } = v(control, "stageWide")
					return r
						.match(control, { child: head.child, stage: head.stage, n: other, held })
						.find({ other, held })
				})
				.rule((r) => {
					const { n: other, held } = v(control, "own")
					return r
						.match(control, { child: head.child, stage: head.stage, n: other, held })
						.where(r.eq(other, head.n))
						.find({ other, held })
				}),
		"array"
	)

/** Each stage's scores of each x and y: a union of both kinds. */
const scored = query(Ledger)
	.rule((r) => {
		const { x, y, stage, v: value } = v(Score, "score")
		return r.match(Score, { x, y, stage, v: value }).find({ x, y, stage, value })
	})
	.rule((r) => {
		const { x, y, stage, v: value } = v(Grade, "grade")
		return r.match(Grade, { x, y, stage, v: value }).find({ x, y, stage, value })
	})

/**
 * A batch's probes, each with its stage's scores of its x and of its y attached: the attachment's child unites two
 * rules, each a read of the scores, one at the probe's x and stage and one at its y and stage, each a prefix of one of
 * the scores' keys, and the two share the stage alone, which leads neither key.
 */
const probeRead = query(Ledger)
	.rule((r) => {
		const { probe, x, y, stage } = v(Probe, "probe")
		return r
			.match(Probe, { batch: r.param("batch", i), probe, x, y, stage })
			.find({ probe, x, y, stage })
	})
	.attach(
		"scores",
		(head) =>
			query(Ledger)
				.rule((r) => {
					const { y: other, value } = v(scored, "byX")
					return r
						.match(scored, { x: head.x, y: other, stage: head.stage, value })
						.find({ other, value })
				})
				.rule((r) => {
					const { x: other, value } = v(scored, "byY")
					return r
						.match(scored, { x: other, y: head.y, stage: head.stage, value })
						.find({ other, value })
				}),
		"array"
	)

/** The ledger installed through its first migration, with a reader whose workload's indexes the reads earn. */
export const intersectionTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "restriction intersection",
	fixture: Ledger,
	programs: { controlRead, probeRead },
	contexts: [],
	label: "restriction_intersection",
	ambient: ordinarySession
})

/**
 * A case: the children stored, each with `stages` stages of `sessions` item sessions, each session `controls` holds and
 * `controls` pauses; the children stored beside them before the read is run again; the pg_class state its tables
 * stand in as each load ends (test/support/advice.ts PgClassState).
 */
export interface IntersectionCase {
	readonly children: number
	readonly stages: number
	readonly sessions: number
	readonly controls: number
	readonly more: number
	readonly state: PgClassState
}

export const intersectionGen: Gen<IntersectionCase> = (s) => ({
	children: s.draw(int(10, 30)),
	stages: s.draw(int(2, 4)),
	sessions: s.draw(int(3, 8)),
	controls: s.draw(int(1, 3)),
	more: s.draw(int(60, 160)),
	state: s.draw(element(pgClassStates))
})

export type IntersectionFeature =
	| "beside a few children"
	| "beside many children"
	| `its tables ${PgClassState}`

/**
 * The statements storing children `from` to `to`: child c's sitting of each stage, its item session n at stage n mod
 * `stages`, each with `controls` holds and `controls` pauses.
 */
const stored = (
	installed: Installed,
	c: IntersectionCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const children = `generate_series(${String(from)}, ${String(to)}) AS g(c)`
	const sessions = `FROM ${children}, generate_series(1, ${String(c.stages * c.sessions)}) AS h(n)`
	const controls = `${sessions}, generate_series(1, ${String(c.controls)}) AS k(held)`
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)} + s, c, s FROM ${children}, generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
		`INSERT INTO ${names.table(ItemSession)} SELECT c, n, n % ${String(c.stages)} ${sessions}`,
		`INSERT INTO ${names.table(Hold)} SELECT c, n % ${String(c.stages)}, n, held ${controls}`,
		`INSERT INTO ${names.table(Pause)} SELECT c, n % ${String(c.stages)}, n, held ${controls}`
	]
}

/** The case's children `first` on, `units` of them, stored as one load (`stored`, test/support/advice.ts standIn). */
const storing = (
	installed: Installed,
	connection: PgConnection,
	c: IntersectionCase,
	first: number,
	units: number
): StateLoad => {
	const names = namesOf(installed)
	return {
		tables: [names.table(ItemSession), names.table(Hold), names.table(Pause), names.table(Sitting)],
		units,
		load: (from, to) =>
			Effect.forEach(
				stored(installed, c, first + from - 1, first + to - 1),
				(sql) => connection.query(sql, []),
				{ discard: true }
			)
	}
}

/**
 * The children a controls case stores beside its own before any of them, each of one sitting at stage 0, one item
 * session, one hold and one pause, numbered past every child a case stores (`besideFirst`): `rows` children, one past
 * the read's bound, so a read of any relation whole, or at a prefix every child shares, reads past it.
 */
const besideControls = (
	installed: Installed,
	c: IntersectionCase,
	rows: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const children = `FROM generate_series(${String(besideFirst)}, ${String(besideFirst + rows - 1)}) AS g(c)`
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)}, c, 0 ${children}`,
		`INSERT INTO ${names.table(ItemSession)} SELECT c, 1, 1 % ${String(c.stages)} ${children}`,
		`INSERT INTO ${names.table(Hold)} SELECT c, 1 % ${String(c.stages)}, 1, 1 ${children}`,
		`INSERT INTO ${names.table(Pause)} SELECT c, 1 % ${String(c.stages)}, 1, 1 ${children}`
	]
}

/** The first child, and the first stage, stored beside a case's own: past every child and stage a case stores. */
const besideFirst = 1_000_000

/**
 * One case in its one transaction, which the case's end rolls back: the children beside (`besideControls`) stored, then
 * children 1 to `children`, its tables stood in the case's pg_class state, the read of child 1's stage 0 through its
 * sitting run under its carried advice once the plan laws hold over it (test/support/advice.ts servedRun); then `more`
 * children stored beside them, stood again, and the read run again. Both times its work (test/support/judge.ts
 * readWork) is at most four times what each of the stage's sessions delivers, the stage's controls, and its sitting and sessions: each session's attachment derives the union once
 * at the session's child and stage, the part both its rules' reads share, and each rule scans those held rows once. A
 * union reached by neither read, the statement's CTE derived for every child stored and scanned twice for each session,
 * reads every child's controls, past the bound with ten children stored.
 */
export const runControls = (
	installed: Installed,
	connection: PgConnection,
	c: IntersectionCase,
	k: Case<IntersectionFeature>
) =>
	Effect.gen(function* () {
		const session: BenchSession = { values: connection.queryValues }
		/** The stage's controls, its sessions' holds and pauses, which each of its sessions delivers; and its sitting and sessions. */
		const stageControls = 2 * c.sessions * c.controls
		const bound = 4 * (c.sessions * stageControls + 1 + c.sessions)
		for (const sql of besideControls(installed, c, bound + 1)) {
			yield* connection.query(sql, [])
		}
		yield* standIn(session, storing(installed, connection, c, 1, c.children), c.state)
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Ledger, []),
			controlRead,
			"the read of child 1's stage"
		)
		const bounded = (children: number) =>
			Effect.map(servedRun(session, read, { sitting: c.stages }), (plan) => {
				const work = readWork(plan)
				assert.ok(
					work <= bound,
					`${Formatter.format(c)}: the read of child 1's stage beside ${String(children)} children reads ${String(work)} rows, past its bound ${String(bound)}\n${read.statement.sql}`
				)
			})
		yield* bounded(c.children)
		yield* standIn(session, storing(installed, connection, c, c.children + 1, c.more), c.state)
		yield* bounded(c.children + c.more)
		k.note(c.children < 20 ? "beside a few children" : "beside many children")
		k.note(`its tables ${c.state}`)
	})

/**
 * A probe case: `xs` x values and `ys` y values scored at each of `stages` stages, both kinds; a batch of `probes`
 * probes at stage 0, probe p at x p and y p; then `more` stages scored beside them before the read is run again; and
 * the pg_class state its tables stand in as each load ends (test/support/advice.ts PgClassState).
 */
export interface ProbeCase {
	readonly stages: number
	readonly xs: number
	readonly ys: number
	readonly probes: number
	readonly more: number
	readonly state: PgClassState
}

export const probeGen: Gen<ProbeCase> = (s) => {
	const xs = s.draw(int(2, 6))
	const ys = s.draw(int(2, 6))
	return {
		stages: s.draw(int(1, 3)),
		xs,
		ys,
		probes: s.draw(int(1, Math.min(xs, ys))),
		more: s.draw(int(10, 40)),
		state: s.draw(element(pgClassStates))
	}
}

export type ProbeFeature = "beside few stages" | "beside many stages" | `its tables ${PgClassState}`

/**
 * The statements storing stages `from` to `to`: each x's and y's score of both kinds; the batch's probes with the
 * first stages.
 */
const storedScores = (
	installed: Installed,
	c: ProbeCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const grid = `FROM generate_series(1, ${String(c.xs)}) AS a(x), generate_series(1, ${String(c.ys)}) AS b(y), generate_series(${String(from)}, ${String(to)}) AS t(s)`
	return [
		`INSERT INTO ${names.table(Score)} SELECT x, y, s, x * 10 + y ${grid}`,
		`INSERT INTO ${names.table(Grade)} SELECT x, y, s, x * 10 + y + 1 ${grid}`,
		...(from === 0
			? [
					`INSERT INTO ${names.table(Probe)} SELECT 1, p, p, p, 0 FROM generate_series(1, ${String(c.probes)}) AS g(p)`
				]
			: [])
	]
}

/**
 * The stages a probe case scores beside its own before any of them, numbered past every stage a case scores
 * (`besideFirst`), each one score and one grade of x 1 and y 1, and as many batches of one probe each: a store large
 * beside the read's rows: `rows` stages, one past the read's bound, so a read of any relation whole, or at a prefix
 * every stage shares, reads past it.
 */
const besideScores = (installed: Installed, rows: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const stages = `FROM generate_series(${String(besideFirst)}, ${String(besideFirst + rows - 1)}) AS t(s)`
	return [
		`INSERT INTO ${names.table(Score)} SELECT 1, 1, s, 11 ${stages}`,
		`INSERT INTO ${names.table(Grade)} SELECT 1, 1, s, 12 ${stages}`,
		`INSERT INTO ${names.table(Probe)} SELECT s, 1, 1, 1, s ${stages}`
	]
}

/**
 * One probe case in its one transaction, which the case's end rolls back: the stages beside (`besideScores`) scored,
 * then stages 0 to `stages` - 1 and the batch's probes stored, its tables stood in the case's pg_class state, the read
 * of the batch run under its carried advice once the plan laws hold over it (test/support/advice.ts servedRun); then
 * `more` stages scored beside them, stood again, and the read run again. Both times its work (test/support/judge.ts
 * readWork) is at most four times what its probes' stage holds
 * for each probe, and its probes: each probe's attachment derives the scores once at its stage, the part both its
 * rules' reads share, though no key leads with it, and each rule scans those held rows once. The scores reached by
 * neither read, the statement's CTE derived for every stage scored and scanned twice for each probe, read every stage's
 * scores, past the bound once three stages are scored.
 */
export const runProbes = (
	installed: Installed,
	connection: PgConnection,
	c: ProbeCase,
	k: Case<ProbeFeature>
) =>
	Effect.gen(function* () {
		const session: BenchSession = { values: connection.queryValues }
		/** The probes' stage's scores of both kinds, which each probe's derivation reads. */
		const stageScores = 2 * c.xs * c.ys
		const bound = 4 * (c.probes * stageScores + c.probes + 1)
		const names = namesOf(installed)
		/** Stages `first` on, `units` of them, scored as one load (`storedScores`, test/support/advice.ts standIn). */
		const scoring = (first: number, units: number): StateLoad => ({
			tables: [names.table(Score), names.table(Grade), names.table(Probe)],
			units,
			load: (from, to) =>
				Effect.forEach(
					storedScores(installed, c, first + from - 1, first + to - 1),
					(sql) => connection.query(sql, []),
					{ discard: true }
				)
		})
		for (const sql of besideScores(installed, bound + 1)) {
			yield* connection.query(sql, [])
		}
		yield* standIn(session, scoring(0, c.stages), c.state)
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Ledger, []),
			probeRead,
			"the read of the batch"
		)
		const bounded = (stages: number) =>
			Effect.map(servedRun(session, read, { batch: 1 }), (plan) => {
				const work = readWork(plan)
				assert.ok(
					work <= bound,
					`${Formatter.format(c)}: the read of the batch beside ${String(stages)} stages reads ${String(work)} rows, past its bound ${String(bound)}\n${read.statement.sql}`
				)
			})
		yield* bounded(c.stages)
		yield* standIn(session, scoring(c.stages, c.more), c.state)
		yield* bounded(c.stages + c.more)
		k.note(c.stages < 3 ? "beside few stages" : "beside many stages")
		k.note(`its tables ${c.state}`)
	})
