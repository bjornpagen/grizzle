/** What magic-sets.test.ts reads: its schema, its reads and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import { Fn, type Term } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, fn, key, on, relation, rows, schema, unit } from "#compiler/public/schema.ts"
import { fullWorldRole, servedRead, servedRun } from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { readWork, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	countedAsVacuumed,
	type StatedDistinct,
	statedDistinct
} from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A ledger shaped as edullm's: each child's item sessions, each at a stage and keyed by it too (edullm's ItemSession key
 * (child, stage, package, item)), each session's attempts, and each attempt's mark.
 */
const Attempt = relation("Attempt", { child: i, n: i, at: i }, ["child", "n", "at"])
const ItemSession = relation("ItemSession", { child: i, n: i, stage: i }, ["child", "n"])
const Mark = relation("Mark", { child: i, n: i, at: i, score: i }, ["child", "n", "at"])
/**
 * A sitting of one child's stage, by its own number, and when it opened, the time of its stage's latest attempts: the
 * stage a read reaches through a stored row, never a parameter.
 */
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i, opened: i }, ["sitting"])
/**
 * A child's user id, by the id, its child beside it: metis's PersonUser, the entity an assignment's user names, whose key
 * determines the child.
 */
const ChildUser = relation("ChildUser", { user: i, child: i }, ["user"])
/**
 * A child's seat, keyed by its child and its own number and by its number alone, in the child's unit, its user and child
 * contained in the users, so its user determines its child (rel.ts StoredBase determined) and its unit: metis's
 * Assignment, keyed (child, number) and (number), in its learner's unit, its (user, child) contained in PersonUser
 * (number, person).
 */
const Seat = relation("Seat", { seat: i, child: i, user: i, since: i }, ["child", "seat"])
/**
 * A seat's grade and track, by the seat, and by its grade and track with it: metis's AssignmentGrade, its grade and
 * track every child's seats share.
 */
const SeatGrade = relation("SeatGrade", { seat: i, grade: i, track: i }, ["seat"])
/** The flags a seat may hold: a relation of booleans, an open one, whose key a seat's flag is contained in. */
const Flag = relation("Flag", { open: pg.boolean }, ["open"])
/**
 * A seat's flag and when it was set, keyed by the flag and the seat, its flag contained in the flags: a code, a boolean
 * every child's seats share, which its containment maps onto an open relation's key all the same.
 */
const SeatFlag = relation("SeatFlag", { open: pg.boolean, seat: i, set: i }, ["open", "seat"])
/** A course, its grade, track and title, the content every child's seats of the grade share: metis's catalog test. */
const Course = relation("Course", { course: i, grade: i, track: i, title: i }, ["course"])
/**
 * A stage's credit, the sum of the marks it is passed: a declared function of rows, as edullm's credit of an attempt
 * reads its values in force.
 */
const credit = fn("credit", {
	calls: [],
	args: { marks: rows({ n: i, score: i }) },
	returns: rows({ total: i }),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT sum(m.score)::integer FROM unnest(marks) AS m`
})
/**
 * The seats from `low` to `high`, each with its place from `low`: a row function of values, which reads no store, as a
 * call's array argument unnested with its ordinality.
 */
const seatRange = fn("seat_range", {
	calls: [],
	args: { low: i, high: i },
	returns: rows({ seat: i, place: i }),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT g, g - low FROM generate_series(low, high) AS g`
})
const Ledger = schema(
	"MagicSets",
	[
		Attempt,
		ItemSession,
		Mark,
		Sitting,
		ChildUser,
		Seat,
		SeatGrade,
		Flag,
		SeatFlag,
		Course,
		credit,
		seatRange
	],
	[
		key(on(ItemSession, "child", "stage", "n")),
		key(on(SeatGrade, "grade", "track", "seat")),
		key(on(Seat, "seat")),
		unit("Learner", { child: i }),
		contained(on(Seat, "user", "child"), on(ChildUser, "user", "child")),
		contained(on(SeatFlag, "open"), on(Flag, "open"))
	]
)

/** Each item session's latest attempt, by its child, its stage and its place: a fold of every attempt stored. */
const latest = query(Ledger).rule((r) => {
	const { child, n, at } = v(Attempt, "attempt")
	const { stage } = v(ItemSession, "session")
	return r
		.match(Attempt, { child, n, at })
		.match(ItemSession, { child, n, stage })
		.find({ child, stage, n, at: r.max(at) })
})

/** The marks of the latest attempts of a head row's child's stage, the attachment both reads read at each head row. */
const marksOf = (head: {
	readonly child: Term<number, unknown, unknown, "integer">
	readonly stage: Term<number, unknown, unknown, "integer">
}) =>
	query(Ledger).rule((r) => {
		const { n, at } = v(latest, "theirs")
		const { score } = v(Mark, "mark")
		return r
			.match(latest, { child: head.child, stage: head.stage, n, at })
			.match(Mark, { child: head.child, n, at, score })
			.find({ n, score })
	})

/**
 * A sitting's stage's latest attempts, each with the marks of its stage's latest attempts attached, as edullm's review
 * reads the latest attempt of each session of its sitting's stage beside each session (reviewOf's LatestAttempt, read
 * by the head at its sitting and by the marks' gradable at each row): the fold read by the head at the child and stage
 * its sitting's row holds and by the attachment at each head row's. The keys are the sitting's stored values, which
 * no parameter fixes.
 */
const sittingRead = query(Ledger)
	.rule((r) => {
		const { child, stage, n, at } = v(latest, "latest")
		const { opened } = v(Sitting, "sitting")
		return r
			.match(Sitting, { sitting: r.param("sitting", i), child, stage, opened })
			.match(latest, { child, stage, n, at })
			.find({ child, stage, n, at, opened })
	})
	.attach("marks", marksOf, "array")

/**
 * A child's stage's latest attempts at the parameters, with the same marks attached: the constant-column pass
 * (lower/optimize/propagate) reads the parameters in place of the head's child and stage, so the attachment's child
 * holds every column of its correlation at a parameter, one key for every head row, the statement's.
 */
const stageRead = query(Ledger)
	.rule((r) => {
		const { child, stage, n, at } = v(latest, "latest")
		return r
			.match(latest, { child, stage, n, at })
			.where(r.eq(child, r.param("child", i)), r.eq(stage, r.param("stage", i)))
			.find({ child, stage, n, at })
	})
	.attach("marks", marksOf, "array")

/**
 * A child's stage at the parameter child and a literal stage, read off its item sessions, with the marks of its latest
 * attempts attached: the constant-column pass (lower/optimize/propagate) reads the parameter and the literal in place of
 * the head's child and stage, so the attachment's child holds every column of its correlation at a value that reads no
 * relation, one key for every head row, the statement's (cte-policy keyPrefixBound), as a closed code a read names holds
 * a column of a correlation; no statement-held class restricts the literal's column (keys.ts statementHeld, a
 * parameter's alone).
 */
const literalRead = query(Ledger)
	.rule((r) => {
		const { child, n, stage } = v(ItemSession, "session")
		return r
			.match(ItemSession, { child, n, stage })
			.where(r.eq(child, r.param("child", i)), r.eq(stage, 0))
			.find({ child, stage })
	})
	.attach("marks", marksOf, "array")

/**
 * A child's seats of a course's grade, at the parameters, as metis's slot read (assign.ts slotAfter) reads a user's
 * active sittings of the assigned test's subject and grade: the course at the call's course, its grade and track every
 * child's seats of them share (a declared key they lead, two columns long), and the call's child's own seats by the
 * child's user id, which no key of the seats leads with but whose containment determines the child, the seats' unit.
 * The child's seats are read first: an occurrence whose bound fields determine its unit's key leads one a content row's
 * values bind, however much longer that one's prefix is (cte-policy keyedRegionChain Rank), never every child's seats of
 * the grade, as PostgreSQL's estimates entered metis's assignments by the grade's every sitting.
 */
const slotRead = query(Ledger).rule((r) => {
	const { seat, grade, track } = v(SeatGrade, "grade")
	const { title } = v(Course, "course")
	const { since } = v(Seat, "seat")
	return r
		.match(Course, { course: r.param("course", i), grade, track, title })
		.match(SeatGrade, { seat, grade, track })
		.match(Seat, { seat, user: r.param("user", i), since })
		.find({ seat, grade, title, since })
})

/**
 * A child's seats of one grade and track, at the parameters: the grade and track at parameters, fields that determine
 * no unit's key, beside the child's own seats by the child's user id. The grade's seats, which the read keeps none of,
 * are its existence test: a parameter names no unit by its source alone, so the child's seats are read at the user,
 * one unit's rows, and each seat's grade tested by its key (cte-policy semiJoinDriven, Rank), never every child's seats
 * of the grade and track, which their key (grade, track, seat) reads by its two-column prefix, driving the child's.
 */
const gradeRead = query(Ledger).rule((r) => {
	const { seat } = v(SeatGrade, "grade")
	const { since } = v(Seat, "seat")
	return r
		.match(SeatGrade, { seat, grade: r.param("grade", i), track: r.param("track", i) })
		.match(Seat, { seat, user: r.param("user", i), since })
		.find({ seat, since })
})

/**
 * The open ones of a range of seats, with each one's place and when its flag was set, at the parameters: the seats a row
 * function of the parameters yields, the range from `low` to `high`, beside the flag at the call's code, a boolean
 * every child's seats share, which leads the flags' key (open, seat). A code is a code whatever its source: the
 * parameter of a boolean identifies no seat, so it starts no prefix, and the range leads, each seat's flag then read at
 * the key (cte-policy keyedRegionChain), never every child's open seats, which the key's one-column prefix reads, before
 * the range. Each side keeps a column of its own, so the read is the region's chain, neither side an existence test.
 */
const openRead = query(Ledger).rule((r) => {
	const range = Fn.rows(seatRange, { low: r.param("low", i), high: r.param("high", i) })
	const { seat, place } = v(range, "range")
	const { set } = v(SeatFlag, "flag")
	return r
		.match(range, { seat, place })
		.match(SeatFlag, { seat, open: r.param("open", pg.boolean), set })
		.find({ seat, place, set })
})

/** The marks of the latest attempts of a child's stage, at the parameters: the rows a call's argument binds per row. */
const marksAt = query(Ledger).rule((r) => {
	const { n, at } = v(latest, "theirs")
	const { score } = v(Mark, "mark")
	const child = r.param("child", i)
	return r
		.match(latest, { child, stage: r.param("stage", i), n, at })
		.match(Mark, { child, n, at, score })
		.find({ n, score })
})

/**
 * A sitting's credit, the row function's rows argument bound at the sitting's row, as edullm's credit of each attempt
 * is called with its values in force: the fold the argument reads is read once per sitting row, at its child and stage
 * (cte-policy correlatedSites), never computed for every sitting's keys inside each row's call.
 */
const creditRead = query(Ledger).rule((r) => {
	const { child, stage, opened } = v(Sitting, "sitting")
	const marks = Fn.rows(credit, { marks: marksAt.bind({ child, stage }) })
	const { total } = v(marks, "credit")
	return r
		.match(Sitting, { sitting: r.param("sitting", i), child, stage, opened })
		.match(marks, { total })
		.find({ child, stage, opened, total })
})

/** The marks of a child's stage's latest attempts at one time, at the parameters: a fold bound at its aggregate too. */
const marksAtLatest = query(Ledger).rule((r) => {
	const { n } = v(latest, "theirs")
	const { score } = v(Mark, "mark")
	const child = r.param("child", i)
	const at = r.param("at", i)
	return r
		.match(latest, { child, stage: r.param("stage", i), n, at })
		.match(Mark, { child, n, at, score })
		.find({ n, score })
})

/**
 * A sitting's credit over the marks of its stage's latest attempts at the time it opened: the rows argument binds the
 * fold at the sitting row's child and stage and at its aggregate's value, the latest time, so the correlated site's
 * restriction names a column of the fold that is none of its grouping keys, which the fold cannot hold below its
 * aggregate and its reader keeps (lower/conservative/context.ts holdsInside), as edullm's sole paragraph reads its
 * significant children's count and first start, grouped by package, path and parent, at a node's own start.
 */
const latestCreditRead = query(Ledger).rule((r) => {
	const { child, stage, opened } = v(Sitting, "sitting")
	const marks = Fn.rows(credit, { marks: marksAtLatest.bind({ child, stage, at: opened }) })
	const { total } = v(marks, "credit")
	return r
		.match(Sitting, { sitting: r.param("sitting", i), child, stage, opened })
		.match(marks, { total })
		.find({ child, stage, opened, total })
})

/**
 * A sitting's stage's latest attempts, the sitting read only as an existence test of the head's child and stage (no
 * column of it delivered): the test's right side drives it (cte-policy semiJoinDriven), the fold read at the sitting's
 * keys alone, its chain led by the stage's sessions, never every attempt of the child first, as PostgreSQL's estimates
 * chose under a bare EXISTS.
 */
const existsRead = query(Ledger).rule((r) => {
	const { child, stage, n, at } = v(latest, "latest")
	return r
		.match(Sitting, { sitting: r.param("sitting", i), child, stage })
		.match(latest, { child, stage, n, at })
		.find({ child, stage, n, at })
})

/** The head both attachment reads attach to: a sitting by its number, its child and stage, and when it opened. */
const sittingHead = query(Ledger).rule((r) => {
	const { child, stage, opened } = v(Sitting, "sitting")
	return r
		.match(Sitting, { sitting: r.param("sitting", i), child, stage, opened })
		.find({ child, stage, opened })
})

/**
 * A sitting with its stage's latest attempts attached, each with its marks attached in turn, as edullm's item sessions
 * attach their attempts and each attempt its values: the attachment's child is an attachment, whose parent, the fold's
 * read at the sitting's keys, the parent key reaches through it (keys.ts restrictionWalk), never a fold derived whole
 * for the database and read beside each key.
 */
const nestedRead = sittingHead.attach(
	"latest",
	(head) =>
		query(Ledger)
			.rule((r) => {
				const { n, at } = v(latest, "theirs")
				return r
					.match(latest, { child: head.child, stage: head.stage, n, at })
					.find({ child: head.child, n, at })
			})
			.attach(
				"marks",
				(attempt) =>
					query(Ledger).rule((r) => {
						const { score } = v(Mark, "mark")
						return r
							.match(Mark, { child: attempt.child, n: attempt.n, at: attempt.at, score })
							.find({ score })
					}),
				"array"
			),
	"array"
)

/**
 * A sitting with each ordered pair of its stage's latest attempts attached: the attachment's child reads the fold twice,
 * each at the sitting's child and stage, both reads reached at the one key (keys.ts restrictionWalk) and the fold
 * derived once there, held in the key's query (lower/conservative/context.ts heldEnv), as edullm's credit reads the
 * attempt's numeric value in force for its score and for its maximum.
 */
const pairsRead = sittingHead.attach(
	"pairs",
	(head) =>
		query(Ledger).rule((r) => {
			const { n, at } = v(latest, "first")
			const { n: next, at: later } = v(latest, "second")
			return r
				.match(latest, { child: head.child, stage: head.stage, n, at })
				.match(latest, { child: head.child, stage: head.stage, n: next, at: later })
				.where(r.lt(n, next))
				.find({ n, at, next, later })
		}),
	"array"
)

/** Each read a case runs, by the keys it reads child 1's stage 0 at. */
export type StageRead =
	| "sitting"
	| "parameters"
	| "literal"
	| "slot"
	| "grade"
	| "open"
	| "credit"
	| "latest"
	| "exists"
	| "nested"
	| "pairs"

/** Child c's user id: one id a child, apart from every child's number, as metis's user ids are apart from its learners. */
const userOf = (c: number): number => 100_000 + c

/**
 * The children a case stores beside its own before any of them, each of one stage, one item session and one attempt
 * (`beside`, runStage): a store large beside one key's rows, so a read of any relation whole, or at a prefix every
 * child shares, reads past the bound of every case.
 *
 * @limitKind derived
 * @owner the stage property (magic-sets.test.ts)
 * @unit children
 * @scope the store each stage case reads beside its own children
 * @derivation The largest bound a case draws is three times a stage's rows at five sessions of four attempts, 3 × (1 +
 *   5 × (1 + 2 × 4)) = 138 rows, and each child beside adds a row to every relation the reads bind: 139 children pass it.
 */
const besideChildren = 139

/** The first child stored beside a case's own: past every child a case stores and every user id (userOf) of one. */
const besideFirst = 2 * userOf(0) + 1

/** Each read by its name, and the parameters it reads child 1's stage 0 at, `stages` per child. */
const stageReads = (stages: number) =>
	({
		sitting: { read: sittingRead, params: { sitting: stages } },
		parameters: { read: stageRead, params: { child: 1, stage: 0 } },
		literal: { read: literalRead, params: { child: 1 } },
		slot: { read: slotRead, params: { course: 0, user: userOf(1) } },
		grade: { read: gradeRead, params: { grade: 0, track: 0, user: userOf(1) } },
		open: { read: openRead, params: { open: true, low: stages, high: 2 * stages - 1 } },
		credit: { read: creditRead, params: { sitting: stages } },
		latest: { read: latestCreditRead, params: { sitting: stages } },
		exists: { read: existsRead, params: { sitting: stages } },
		nested: { read: nestedRead, params: { sitting: stages } },
		pairs: { read: pairsRead, params: { sitting: stages } }
	}) as const

/** The ledger installed through its first migration, with a reader whose workload's indexes the read earns. */
export const stageTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "magic sets stage read",
	fixture: Ledger,
	programs: {
		sittingRead,
		stageRead,
		literalRead,
		slotRead,
		gradeRead,
		openRead,
		creditRead,
		latestCreditRead,
		existsRead,
		nestedRead,
		pairsRead
	},
	label: "magic_sets_stage",
	ambient: ordinarySession
})

/**
 * The planner statistics a case reads under: the relations' sizes as a VACUUM counts them, their columns' as nothing
 * states them (`counted`), or the columns of each relation whose order a read's chain decides stated at one value or
 * each its own (`stated`, fill.ts statedDistinct): the attempts and the item sessions the fold joins, the sittings an
 * existence test of the head's rows reads, and the seats and their grades the slot read joins, so the estimates of a
 * seek by any column of one are all its rows or one: a perturbation of the planner's estimates, under which the plan a
 * read carries (cte-policy keyedRegionChain's order, which the declared keys and the call's values prove) stands.
 */
export type StageStatistics =
	| { readonly kind: "counted" }
	| {
			readonly kind: "stated"
			readonly attempt: StatedDistinct
			readonly session: StatedDistinct
			readonly sitting: StatedDistinct
			readonly seat: StatedDistinct
			readonly grade: StatedDistinct
	  }

/**
 * A case: the children stored, each with `stages` stages of `sessions` item sessions, each of `attempts` attempts and
 * their marks, and the children stored beside them before the read is explained again, under `statistics`.
 */
export interface StageCase {
	readonly children: number
	readonly stages: number
	readonly sessions: number
	readonly attempts: number
	readonly more: number
	readonly statistics: StageStatistics
}

const statedGen: Gen<StatedDistinct> = (s) => (s.draw(boolean) ? "unique" : "one value")

const statisticsGen: Gen<StageStatistics> = (s) =>
	s.draw(boolean)
		? {
				kind: "stated",
				attempt: s.draw(statedGen),
				session: s.draw(statedGen),
				sitting: s.draw(statedGen),
				seat: s.draw(statedGen),
				grade: s.draw(statedGen)
			}
		: { kind: "counted" }

export const stageGen: Gen<StageCase> = (s) => ({
	children: s.draw(int(10, 40)),
	stages: s.draw(int(4, 8)),
	sessions: s.draw(int(1, 5)),
	attempts: s.draw(int(2, 4)),
	more: s.draw(int(60, 200)),
	statistics: s.draw(statisticsGen)
})

export type StageFeature =
	| "beside a few children"
	| "beside many children"
	| "under statistics stating each attempt its own and every session one"
	| "under statistics stating each seat's grade its own and every seat one"

/** The runs of the scans of `table` a plan made, each scan's loops summed: a Bitmap Index Scan's are its heap scan's. */
const runsOf = (plan: PlanNode, table: string): number =>
	Arr.reduce(
		Arr.filter(
			[...planNodes(plan)],
			(n) => Option.contains(n.relation, table) && n.nodeType !== "Bitmap Index Scan"
		),
		0,
		(sum, n) => sum + n.actualLoops
	)

/**
 * One case in its one transaction, which the case's end rolls back: the children beside (besideChildren) stored, then
 * children 1 to `children`, child c's sitting of each stage, its item session n at stage n mod `stages`, each with
 * `attempts` attempts and a mark each, counted as a VACUUM counts them, under the case's statistics; the read of child
 * 1's stage 0 (`by` its sitting, or at the parameters) run under its carried advice once the plan laws hold over it
 * (test/support/advice.ts servedRun); then `more` children stored beside them alike, and the read run again. Both times
 * its scans read at most three times the stage's stored rows (test/support/judge.ts readWork), its sitting where
 * the read reaches the stage through it, its sessions, their attempts and marks: the head's fold at the sitting's child
 * and stage (a statement site, one evaluation of the fold LATERAL per key) or at the parameters, and the attachment's
 * at the head's rows, each read the stage's sessions by (child, stage), the chain's lead, and each session's attempts
 * by its key, the attachment each latest attempt's mark by its key, and each CTE row is the key or one of the stage's
 * latest attempts, read at most once by each reader (6 rows a session and 2 an attempt at most, within three times the
 * stage's 1 and 2). Every attempt of the child, its other stages', read first, passes the bound at four stages; a fold derived whole reads every child's rows, ten times at least; and an
 * attachment whose correlation the parameters hold, co-grouped as if no declared-key prefix bound it, joins every mark
 * of the child, its other stages', by the child alone. The pairs read's plan derives its fold once besides
 * (`derivations`), at the sitting's one key, however many reads of it the pairs make.
 */
export const runStage = (
	installed: Installed,
	connection: PgConnection,
	c: StageCase,
	k: Case<StageFeature>,
	by: StageRead
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const stored = (from: number, to: number) => {
			const sessions = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(1, ${String(c.stages * c.sessions)}) AS h(n)`
			const attempts = `${sessions}, generate_series(1, ${String(c.attempts)}) AS a(at)`
			return [
				`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)} + s, c, s, ${String(c.attempts)} FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
				`INSERT INTO ${names.table(ChildUser)} SELECT c + ${String(userOf(0))}, c FROM generate_series(${String(from)}, ${String(to)}) AS g(c)`,
				`INSERT INTO ${names.table(Seat)} SELECT c * ${String(c.stages)} + s, c, c + ${String(userOf(0))}, s FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
				`INSERT INTO ${names.table(SeatGrade)} SELECT c * ${String(c.stages)} + s, s, 0 FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
				`INSERT INTO ${names.table(SeatFlag)} SELECT s % 2 = 0, c * ${String(c.stages)} + s, s FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
				`INSERT INTO ${names.table(ItemSession)} SELECT c, n, n % ${String(c.stages)} ${sessions}`,
				`INSERT INTO ${names.table(Attempt)} SELECT c, n, at ${attempts}`,
				`INSERT INTO ${names.table(Mark)} SELECT c, n, at, at * 10 ${attempts}`
			]
		}
		const beside = (from: number, to: number) => {
			const children = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c)`
			return [
				`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)}, c, 0, 1 ${children}`,
				`INSERT INTO ${names.table(ChildUser)} SELECT c + ${String(userOf(0))}, c ${children}`,
				`INSERT INTO ${names.table(Seat)} SELECT c * ${String(c.stages)}, c, c + ${String(userOf(0))}, 0 ${children}`,
				`INSERT INTO ${names.table(SeatGrade)} SELECT c * ${String(c.stages)}, 0, 0 ${children}`,
				`INSERT INTO ${names.table(SeatFlag)} SELECT true, c * ${String(c.stages)}, 0 ${children}`,
				`INSERT INTO ${names.table(ItemSession)} SELECT c, 1, 1 % ${String(c.stages)} ${children}`,
				`INSERT INTO ${names.table(Attempt)} SELECT c, 1, 1 ${children}`,
				`INSERT INTO ${names.table(Mark)} SELECT c, 1, 1, 10 ${children}`
			]
		}
		const tables = Arr.map(
			[Attempt, ItemSession, Mark, Sitting, ChildUser, Seat, SeatGrade, Flag, SeatFlag, Course],
			(t) => names.table(t)
		)
		const stated =
			c.statistics.kind === "counted"
				? []
				: [
						statedDistinct(names.table(Attempt), c.statistics.attempt),
						statedDistinct(names.table(ItemSession), c.statistics.session),
						statedDistinct(names.table(Sitting), c.statistics.sitting),
						statedDistinct(names.table(Seat), c.statistics.seat),
						statedDistinct(names.table(SeatGrade), c.statistics.grade)
					]
		yield* standUpJudge(connection, installed.installation)
		for (const sql of [
			`INSERT INTO ${names.table(Flag)} VALUES (true), (false)`,
			`INSERT INTO ${names.table(Course)} SELECT s, s, 0, s FROM generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
			...beside(besideFirst, besideFirst + besideChildren - 1),
			...stored(1, c.children),
			...Arr.map(tables, countedAsVacuumed),
			...stated
		]) {
			yield* connection.query(sql, [])
		}
		const { read: program, params: at } = stageReads(c.stages)[by]
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Ledger),
			program,
			`the read of child 1's stage by ${by}`
		)
		const explained = servedRun({ values: connection.queryValues }, read, at)
		/**
		 * The stage's stored rows: child 1's sitting of stage 0 where the read reaches it, its sessions, their attempts and
		 * marks; for the slot read, the course, child 1's seats and their grades; for the grade read, child 1's seats and
		 * their grades; for the open read, the range of child 1's seats, from `stages` on, and their flags.
		 */
		const own =
			by === "slot"
				? 1 + 2 * c.stages
				: by === "grade" || by === "open"
					? 2 * c.stages
					: (by === "parameters" || by === "literal" ? 0 : 1) + c.sessions * (1 + 2 * c.attempts)
		/**
		 * The rows the read may scan: three times the stage's. The pairs read derives its fold once per key, held in the
		 * key's query (lower/conservative/context.ts heldEnv), each of its two reads a scan of the stage's latest attempts,
		 * the second once per row of the first: the stage's sessions squared, within three times its rows at five sessions.
		 */
		const bound = 3 * own
		/**
		 * The times the plan derived the fold, `latest`, over every loop: each derivation reads the stage's item sessions
		 * and each session's attempts, its chain led by one of them, so the fewer runs of the scans of the two relations
		 * count them, whichever leads. The pairs read derives it once, at the sitting's one key, both its reads scans of
		 * that one derivation. Derived at each read, it is derived twice at least, which the rows' bound cannot tell at the
		 * drawn sizes: the second derivation reads the stage's sessions and attempts once more, fewer rows than the held
		 * CTE's second scan reads in its place, once for each row of the first, and PostgreSQL reads it again for each row
		 * of the first from the sort it keeps of it, which scans nothing (the kill of share/keyed.ts pushedInto's held
		 * set, 33 rows against the held CTE's 48 at five sessions of two attempts, both within the bound of 78).
		 */
		const derivations = (plan: PlanNode): number =>
			Math.min(runsOf(plan, names.tableIdent(ItemSession)), runsOf(plan, names.tableIdent(Attempt)))
		const bounded = (children: number) =>
			Effect.map(explained, (plan) => {
				const scanned = readWork(plan)
				assert.ok(
					scanned <= bound,
					`${Formatter.format(c)}: the read of child 1's stage beside ${String(children)} children reads ${String(scanned)} rows, past its bound ${String(bound)} (the stage's ${String(own)})`
				)
				if (by === "pairs") {
					const derived = derivations(plan)
					assert.ok(
						derived === 1,
						`${Formatter.format(c)}: the pairs of child 1's stage beside ${String(children)} children derive the fold ${String(derived)} times, where held at the sitting's one key it is derived once`
					)
				}
			})
		yield* bounded(c.children)
		for (const sql of [
			...stored(c.children + 1, c.children + c.more),
			...Arr.map(tables, countedAsVacuumed)
		]) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.children + c.more)
		k.note(c.children < 25 ? "beside a few children" : "beside many children")
		if (
			c.statistics.kind === "stated" &&
			c.statistics.attempt === "unique" &&
			c.statistics.session === "one value"
		) {
			k.note("under statistics stating each attempt its own and every session one")
		}
		if (
			c.statistics.kind === "stated" &&
			c.statistics.grade === "unique" &&
			c.statistics.seat === "one value"
		) {
			k.note("under statistics stating each seat's grade its own and every seat one")
		}
	})
