/** What the property of upkeep-bound.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	committedJudged,
	type JudgePlan,
	type JudgeStatement,
	judgeRun,
	judgeStatementsOf,
	keyedWork,
	probeCostOf,
	raisedRule,
	standUpJudge,
	wideScans
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A learner enrolled, the learner's unit's root. */
const Enrolled = relation("Enrolled", { child: pg.integer }, ["child"])
/** A learner's sessions, keyed by the learner first, as every relation of a learner's unit is. */
const Session = relation("Session", { child: pg.integer, s: pg.integer }, ["child", "s"])
/** The answers a learner gave in a session, in the learner's unit. */
const Answer = relation("Answer", { child: pg.integer, s: pg.integer, n: pg.integer }, [
	"child",
	"s",
	"n"
])

/** The three relations, closed, each in the learner's unit: a write inserts, and the judge probes its rules key by key. */
const Base = schema(
	"UpkeepBound",
	[Enrolled, Session, Answer],
	[unit("Learner", { child: pg.integer })]
)

/**
 * Each session's answers counted: stored (analysis/derived/storage.ts), its definition unit-local in the learner's unit
 * and its unit, (child, s), wider than the learner's, so its upkeep re-derives the sessions a write touched alone.
 */
const SessionCount = derived(
	"SessionCount",
	query(Base).rule((r) => {
		const { child, s, n } = v(Answer, "a")
		return r.match(Answer, { child, s, n }).find({ child, s, answers: r.count() })
	})
)

/**
 * The learners who answered: its unit, (child), the learner's own, which bounds no upkeep, stored by its checked delta
 * form (analysis/theory/upkeep.ts deltaBoundOf), its one occurrence of Answer read by a seek at the learner
 * (analysis/theory/unit.ts StepBy `seek`): an answer gains the learner's fact, read from the row it wrote, and a fact it
 * may withdraw is checked by one descent of an index of Answer at the learner; so an answer of a learner who answered
 * gains nothing, and the rule over it reads no news of it.
 */
const Answered = derived(
	"Answered",
	query(Base).rule((r) => {
		const { child } = v(Answer, "a")
		return r.match(Answer, { child }).find({ child })
	})
)

/**
 * Each learner's answers counted: live (LiveReason `unboundedUpkeep`), a fold at (child), the learner's own unit, which
 * no delta form reads, so an upkeep of it would re-derive the learner's whole history at each answer.
 */
const Tally = derived(
	"Tally",
	query(Base).rule((r) => {
		const { child, s, n } = v(Answer, "a")
		return r.match(Answer, { child, s, n }).find({ child, answers: r.count() })
	})
)

/**
 * A rule over each, each a containment of a selected side, which the judge probes key by key over closed relations
 * (laws/model/plan.ts containmentDischarge): every counted session is a session, read over SessionCount's side of news,
 * which its upkeep's INSERT fills inside the judge; and every learner who answered is enrolled, read over Answered's
 * side of news, which its upkeep's INSERT fills where the answer is the learner's first.
 */
const UpkeepBound = schema.extend(
	[Base],
	"UpkeepBound_1",
	[SessionCount, Answered, Tally],
	[
		contained(
			on(
				select(SessionCount, (c) => c.ge(c.answers, 1n)),
				"child",
				"s"
			),
			on(Session, "child", "s")
		),
		contained(
			on(
				select(Answered, (a) => a.ge(a.child, 0)),
				"child"
			),
			on(Enrolled, "child")
		)
	]
)

/** UpkeepBound installed through its first migration, with no login. */
export const upkeepBoundTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "upkeep bound",
	content: { schema: "UpkeepBound", logins: [] },
	versions: [{ schema: UpkeepBound, declarations: noDeclarations }],
	options: {
		label: "upkeep_bound",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * A case: learner 1's sessions before the first measure, `few`, those added before the second, `more`, and the answers
 * of each, `answers`; the second measure's learner holds `more` sessions beside the first's, every one in the same unit.
 */
export interface UpkeepCase {
	readonly few: 1 | 4
	readonly more: 16 | 64
	readonly answers: 1 | 3
}

export const upkeepGen: Gen<UpkeepCase> = (s) => ({
	few: s.draw(element([1, 4] as const)),
	more: s.draw(element([16, 64] as const)),
	answers: s.draw(element([1, 3] as const))
})

export type UpkeepFeature = "the stored relation's upkeep ran" | "Answered's upkeep ran"

/** The statements that store learner 1's sessions `from` to `to`, each with `answers` answers, numbered 1 up. */
const sessionsSql = (installed: Installed, from: number, to: number, answers: number) => {
	const names = namesOf(installed)
	const series = `FROM generate_series(${from}, ${to}) AS g(s)`
	return [
		`INSERT INTO ${names.table(Session)} (child, s) SELECT 1, s ${series}`,
		`INSERT INTO ${names.table(Answer)} (child, s, n) SELECT 1, s, n ${series}, generate_series(1, ${answers}) AS h(n)`
	]
}

/**
 * The judge's work at COMMIT of a write of one answer, a fresh one of session 1, measured on `session` in a transaction
 * rolled back, before the judge reads its deltas (test/support/judge.ts judgeRun): each statement the judge runs over
 * them, SessionCount's upkeep's DELETE and INSERT, run as phase A runs them, and each rule's probe over a delta holding a
 * row, Answer's side of news or SessionCount's, which the upkeep's INSERT filled, with its work (`scannedWork`).
 */
const answerWork = (installed: Installed, session: RawSession, answers: number) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				yield* session.query(
					`INSERT INTO ${namesOf(installed).table(Answer)} (child, s, n) VALUES (1, 1, ${answers + 1})`,
					[]
				)
				return yield* judgeRun(
					(sql) => session.values(sql, []),
					installed.installation,
					judgeStatementsOf(installed.installation)
				)
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return work
	})

/** A statement of the judge, named for a report: an upkeep's write by its relation, a rule's test by its rule. */
const named = (statement: JudgeStatement): string => {
	switch (statement.kind) {
		case "upkeep":
			return `the ${statement.statement.kind} of ${statement.relation}'s upkeep`
		case "rule":
			return `a test of rule ${Formatter.format(raisedRule(statement.statement))}`
	}
}

/**
 * Each statement measured, named (`named`), with its keyed work and the tables it reads whole by a scan that costs more
 * than a probe, `probeCost` (test/support/judge.ts keyedWork, wideScans).
 */
const measured = (plans: ReadonlyArray<JudgePlan<JudgeStatement>>, probeCost: number) =>
	Arr.map(plans, (p) => ({
		statement: named(p.statement),
		rows: keyedWork(p.plan, probeCost),
		wide: wideScans(p.plan, probeCost)
	}))

/**
 * The other learners every case holds beside learner 1, each with one row of each relation, so every table is larger
 * than one probe of it and PostgreSQL looks a key up in it, as at a production's size, with no planner setting: a
 * table of a page or two it reads whole for what a probe costs (test/support/judge.ts keyedWork).
 *
 * @limitKind derived
 * @owner the upkeep bounds (upkeep-bound.test.ts)
 * @unit learners
 * @scope the background each case measures beside
 * @evidence ~/.cache/grizzle/DECLSTATS-work/unitscale/run3.sh, its output unitscale3.log beside it (2026-11-23): a
 *   delta's reader declared at 10 rows is read by a probe of the key at every table from 2^10 rows, a hash over a scan below; at 2,048 rows each table is a dozen pages
 */
const background = 2048

/**
 * Holds two measures of one case to the bound: no statement reads a table larger than a probe whole, and each does the
 * same keyed work both times.
 */
const heldToTheBound = (
	few: ReadonlyArray<JudgePlan<JudgeStatement>>,
	many: ReadonlyArray<JudgePlan<JudgeStatement>>,
	probeCost: number,
	what: string
) => {
	const before = measured(few, probeCost)
	const after = measured(many, probeCost)
	for (const m of [...before, ...after]) {
		assert.deepEqual(m.wide, [], `${what}: ${m.statement} reads no table larger than a probe whole`)
	}
	assert.deepEqual(after, before, what)
}

/**
 * One case on a fresh clone, in one session: learner 1 enrolled with `few` sessions of `answers` answers, committed, and
 * the judge's work at a fresh answer's COMMIT measured (`answerWork`); then `more` sessions of `answers` answers added
 * to the same learner, committed, and the work measured again. Each statement reads the same rows both times:
 * SessionCount's upkeep re-derives the one session the answer touched, at (child, s), never the learner's other
 * sessions, and Answered's upkeep reads the answer and Answered's row at the learner by its key, never the
 * learner's history; an upkeep of Tally, at (child), would read every answer of the learner, which `more` adds to.
 */
export const runUpkeep = (
	installed: Installed,
	session: RawSession,
	d: UpkeepCase,
	c: Case<UpkeepFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(session, installed.installation)
		const probeCost = yield* probeCostOf((sql) => session.values(sql, []))
		const names = namesOf(installed)
		const others = `FROM generate_series(2, ${background + 1}) AS g(child)`
		yield* committedJudged(session, [
			`INSERT INTO ${names.table(Enrolled)} (child) SELECT child ${others}`,
			`INSERT INTO ${names.table(Session)} (child, s) SELECT child, 1 ${others}`,
			`INSERT INTO ${names.table(Answer)} (child, s, n) SELECT child, 1, 1 ${others}`,
			`INSERT INTO ${names.table(Enrolled)} (child) VALUES (1)`,
			...sessionsSql(installed, 1, d.few, d.answers)
		])
		const few = yield* answerWork(installed, session, d.answers)
		yield* committedJudged(session, sessionsSql(installed, d.few + 1, d.few + d.more, d.answers))
		const many = yield* answerWork(installed, session, d.answers)
		heldToTheBound(
			few,
			many,
			probeCost,
			`${Formatter.format(d)}: each statement the judge runs at an answer's COMMIT does the same keyed work beside ${d.few} sessions of the learner and beside ${d.few + d.more}, beside ${background} other learners`
		)
		if (
			Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === "SessionCount")
		) {
			c.note("the stored relation's upkeep ran")
		}
		if (
			Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === "Answered")
		) {
			c.note("Answered's upkeep ran")
		}
	})

/** An item a learner's session showed, at its instant, in the learner's unit. */
const Shown = relation("Shown", { child: pg.integer, s: pg.integer, at: pg.integer }, [
	"child",
	"s",
	"at"
])
/** A moment a learner's session recorded, an instant at which its items stopped interacting, in the learner's unit. */
const Moment = relation("Moment", { child: pg.integer, s: pg.integer, at: pg.integer }, [
	"child",
	"s",
	"at"
])

/** The two relations, closed, each in the learner's unit. */
const SpanBase = schema("SpanBound", [Shown, Moment], [unit("Learner", { child: pg.integer })])

/** Whether a span's rule matches the item shown first, as ledger's presentedSpans does, or the moment. */
export type SpanOrder = "shown first" | "moment first"

/**
 * Each item shown with its session's least moment after it, the instant it stopped interacting: ledger's
 * presentedSpans. Stored at (child, s), wider than the learner's unit, rooted at the item by a successor
 * (analysis/theory/successor.ts): of the session's moments its fold reads only the least past the item's instant, one
 * descent of Moment's key order, which navigation reads it by (analysis/theory/navigate.ts #chain), the rule matching
 * the moment first or second.
 */
const spanOf = (order: SpanOrder) =>
	derived(
		"Span",
		query(SpanBase).rule((r) => {
			const { child, s, at } = v(Shown, "shown")
			const { at: later } = v(Moment, "next")
			const matched =
				order === "shown first"
					? r.match(Shown, { child, s, at }).match(Moment, { child, s, at: later })
					: r.match(Moment, { child, s, at: later }).match(Shown, { child, s, at })
			return matched.where(r.gt(later, at)).find({ child, s, at, end: r.min(later) })
		})
	)

/** Span by the match its rule states first. */
const spans = {
	"shown first": spanOf("shown first"),
	"moment first": spanOf("moment first")
} as const

/** SpanBound installed through its first migration, with no login, its rule matching as `order` says. */
const spanBoundTemplate = (order: SpanOrder) =>
	migratedTemplate({
		declaredIn: import.meta,
		name: `span bound, ${order}`,
		content: { schema: "SpanBound", logins: [] },
		versions: [
			{
				schema: schema.extend([SpanBase], "SpanBound_1", [spans[order]], []),
				declarations: noDeclarations
			}
		],
		options: {
			label: order === "shown first" ? "span_bound_shown" : "span_bound_moment",
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})

/** SpanBound with its rule matching the item first, and with it matching the moment first. */
export const spanShownFirst = spanBoundTemplate("shown first")
export const spanMomentFirst = spanBoundTemplate("moment first")

/**
 * A case: which match the span's rule states first; the items session 1 of learner 1 shows, `shown`, at instants 10 to
 * 10·shown; its moments before the first measure, four, at 15 to 45, each five after an item's; and those added before
 * the second, `added`, after every item's end, at 105 and later.
 */
export interface SpanCase {
	readonly order: SpanOrder
	readonly shown: 1 | 4
	readonly added: 16 | 64
}

export const spanGen: Gen<SpanCase> = (s) => ({
	order: s.draw(element<SpanOrder>(["shown first", "moment first"])),
	shown: s.draw(element([1, 4] as const)),
	added: s.draw(element([16, 64] as const))
})

export type SpanFeature = `the successor's upkeep ran, ${SpanOrder}`

/** The statements that store the other learners' sessions, each one item shown and one moment after it, beside learner
 * 1's (`background`). */
const spanBackgroundSql = (installed: Installed): ReadonlyArray<string> => {
	const others = `FROM generate_series(2, ${background + 1}) AS g(child)`
	return [
		`INSERT INTO ${namesOf(installed).table(Shown)} (child, s, at) SELECT child, 1, 10 ${others}`,
		`INSERT INTO ${namesOf(installed).table(Moment)} (child, s, at) SELECT child, 1, 15 ${others}`
	]
}

/** The statement that stores learner 1's session 1's moments `from` to `to`, each at `instant`, a SQL term of the series' i. */
const momentsSql = (installed: Installed, from: number, to: number, instant: string) =>
	`INSERT INTO ${namesOf(installed).table(Moment)} (child, s, at) SELECT 1, 1, ${instant} FROM generate_series(${from}, ${to}) AS g(i)`

/**
 * Session 1's spans as Span's table holds them, each item's instant and end, by instant: each item's end the moment five
 * after it, whatever moments after every end are added.
 */
const spansHeld = (installed: Installed, session: RawSession, d: SpanCase) =>
	Effect.gen(function* () {
		const rows = yield* session.values(
			`SELECT at, "end" FROM ${namesOf(installed).table(spans[d.order])} WHERE child = 1 AND s = 1 ORDER BY at`,
			[]
		)
		assert.deepEqual(
			Arr.map(rows, (row) => Arr.map(row, String)),
			Array.from({ length: d.shown }, (_, i) => [String(10 * (i + 1)), String(10 * (i + 1) + 5)]),
			`${Formatter.format(d)}: each item's span ends at the least moment after it`
		)
	})

/**
 * The judge's work at COMMIT of a write of one moment of session 1, after every other, measured on `session` in a
 * transaction rolled back (test/support/judge.ts judgeRun): Span's upkeep's DELETE and INSERT, each statement's work
 * (`scannedWork`).
 */
const momentWork = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				yield* session.query(
					`INSERT INTO ${namesOf(installed).table(Moment)} (child, s, at) VALUES (1, 1, 100000)`,
					[]
				)
				return yield* judgeRun(
					(sql) => session.values(sql, []),
					installed.installation,
					judgeStatementsOf(installed.installation)
				)
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return work
	})

/**
 * One case on a fresh clone, in one session: session 1 of learner 1 with `shown` items and four moments after them,
 * committed, and the judge's work at a later moment's COMMIT measured (`momentWork`); then `added` moments more,
 * committed, and the work measured again. Each statement reads the same rows both times: Span's upkeep re-derives the
 * session the moment touched, reading each item and, for each, the one moment past it, where a fold over every moment
 * past each item reads the `added` moments too, for every item.
 */
export const runSpan = (
	installed: Installed,
	session: RawSession,
	d: SpanCase,
	c: Case<SpanFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(session, installed.installation)
		const probeCost = yield* probeCostOf((sql) => session.values(sql, []))
		yield* committedJudged(session, [
			...spanBackgroundSql(installed),
			`INSERT INTO ${namesOf(installed).table(Shown)} (child, s, at) SELECT 1, 1, 10 * k FROM generate_series(1, ${d.shown}) AS g(k)`,
			momentsSql(installed, 1, 4, "10 * i + 5")
		])
		yield* spansHeld(installed, session, d)
		const few = yield* momentWork(installed, session)
		yield* committedJudged(session, [momentsSql(installed, 5, 4 + d.added, "100 + i")])
		yield* spansHeld(installed, session, d)
		const many = yield* momentWork(installed, session)
		heldToTheBound(
			few,
			many,
			probeCost,
			`${Formatter.format(d)}: each statement the judge runs at a moment's COMMIT does the same keyed work beside 4 moments of the session and beside ${4 + d.added}, beside ${background} other learners`
		)
		if (Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === "Span")) {
			c.note(`the successor's upkeep ran, ${d.order}`)
		}
	})

/**
 * Each session's latest moment: ledger's latestMoments. Stored at (child, s), its one rule's fold of Moment's instant at
 * the session the extreme of the key's last field there, Moment's last row at (child, s), one descent of its key
 * (analysis/theory/navigate.ts extremeOf), where a fold read every moment of the session at each write.
 */
const Latest = derived(
	"Latest",
	query(SpanBase).rule((r) => {
		const { child, s, at } = v(Moment, "moment")
		return r.match(Moment, { child, s, at }).find({ child, s, last: r.max(at) })
	})
)

/**
 * Each session showing an item at an instant no moment stands at. Stored at (child, s), its head the session alone, so
 * at a session it derives one fact at most, which one witness derives (analysis/theory/navigate.ts oneWitness), where
 * its upkeep read every item of the session.
 */
const Unmoved = derived(
	"Unmoved",
	query(SpanBase).rule((r) => {
		const { child, s, at } = v(Shown, "shown")
		return r
			.match(Shown, { child, s, at })
			.where(r.not(Moment, { child, s, at }))
			.find({ child, s })
	})
)

/** A fold whose upkeep reads one row at the unit: the latest moment, or a session with an unmoved item. */
export type FoldShape = "latest" | "unmoved"

/** SpanBase with `shape`'s relation above it, installed through its first migration, with no login. */
const foldBoundTemplate = (shape: FoldShape) =>
	migratedTemplate({
		declaredIn: import.meta,
		name: `fold bound, ${shape}`,
		content: { schema: "SpanBound", logins: [] },
		versions: [
			{
				schema: schema.extend(
					[SpanBase],
					"SpanBound_1",
					[shape === "latest" ? Latest : Unmoved],
					[]
				),
				declarations: noDeclarations
			}
		],
		options: {
			label: shape === "latest" ? "latest_bound" : "unmoved_bound",
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})

export const latestBound = foldBoundTemplate("latest")
export const unmovedBound = foldBoundTemplate("unmoved")

/**
 * A case: the shape, and how many rows of session 1 its unit gains between the two measures, `added`: moments after
 * every other for the latest moment, items shown at instants no moment stands at for the unmoved session.
 */
export interface FoldCase {
	readonly shape: FoldShape
	readonly added: 16 | 64
}

export const foldGen: Gen<FoldCase> = (s) => ({
	shape: s.draw(element<FoldShape>(["latest", "unmoved"])),
	added: s.draw(element([16, 64] as const))
})

export type FoldFeature = `the ${FoldShape} upkeep ran`

/** What the shape's table holds at session 1 of learner 1, as text: its latest moment, or the session itself. */
const foldHeld = (
	installed: Installed,
	session: RawSession,
	shape: FoldShape,
	expected: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const table = namesOf(installed).table(shape === "latest" ? Latest : Unmoved)
		const rows = yield* session.values(
			shape === "latest"
				? `SELECT "last" FROM ${table} WHERE child = 1 AND s = 1`
				: `SELECT s FROM ${table} WHERE child = 1 AND s = 1`,
			[]
		)
		assert.deepEqual(
			Arr.map(rows, (row) => Arr.map(row, String)),
			[[...expected]],
			`${shape}: its table holds the session's fact`
		)
	})

/**
 * One case on a fresh clone, in one session: session 1 of learner 1 with four items shown at 10 to 40 and four moments
 * at 101 to 104, committed, and the judge's work at a later moment's COMMIT measured (`momentWork`); then `added` rows
 * more, moments after every other for the latest moment, items shown at 1001 and on for the unmoved session, committed,
 * and the work measured again. Each statement reads the same rows both times: the latest moment's upkeep reads the
 * session's last moment, the unmoved session's one witness, where a fold or a distinct projection read every row.
 */
export const runFold = (
	installed: Installed,
	session: RawSession,
	d: FoldCase,
	c: Case<FoldFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const shown = (from: number, to: number, instant: string) =>
			`INSERT INTO ${names.table(Shown)} (child, s, at) SELECT 1, 1, ${instant} FROM generate_series(${from}, ${to}) AS g(i)`
		yield* standUpJudge(session, installed.installation)
		const probeCost = yield* probeCostOf((sql) => session.values(sql, []))
		yield* committedJudged(session, [
			...spanBackgroundSql(installed),
			shown(1, 4, "10 * i"),
			momentsSql(installed, 1, 4, "100 + i")
		])
		yield* foldHeld(installed, session, d.shape, [d.shape === "latest" ? "104" : "1"])
		const few = yield* momentWork(installed, session)
		yield* committedJudged(session, [
			d.shape === "latest"
				? momentsSql(installed, 5, 4 + d.added, "100 + i")
				: shown(1, d.added, "1000 + i")
		])
		yield* foldHeld(installed, session, d.shape, [
			d.shape === "latest" ? String(104 + d.added) : "1"
		])
		const many = yield* momentWork(installed, session)
		heldToTheBound(
			few,
			many,
			probeCost,
			`${Formatter.format(d)}: each statement the judge runs at a moment's COMMIT does the same keyed work beside four rows of the session and beside ${4 + d.added}, beside ${background} other learners`
		)
		const relation = d.shape === "latest" ? "Latest" : "Unmoved"
		if (Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === relation)) {
			c.note(`the ${d.shape} upkeep ran`)
		}
	})
