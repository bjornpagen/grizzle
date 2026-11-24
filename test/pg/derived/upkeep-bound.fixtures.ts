/** What the property of upkeep-bound.test.ts reads: its schema and template, its space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
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
	largeTables,
	raisedRule,
	scannedWork,
	standUpJudge
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
 * The learners who answered: live (LiveReason `unboundedUpkeep`), its unit, (child), the learner's own, so an upkeep of
 * it would re-derive the learner's whole history at each answer; its readers read its definition at the keys they bind.
 */
const Answered = derived(
	"Answered",
	query(Base).rule((r) => {
		const { child } = v(Answer, "a")
		return r.match(Answer, { child }).find({ child })
	})
)

/**
 * A rule over each, each a containment of a selected side, which the judge probes key by key over closed relations
 * (laws/model/plan.ts containmentDischarge): every counted session is a session, read over SessionCount's side of news,
 * which its upkeep's INSERT fills inside the judge; and every learner who answered is enrolled, read over Answer's side
 * of news through Answered's definition at the learner the answer binds.
 */
const UpkeepBound = schema.extend(
	[Base],
	"UpkeepBound_1",
	[SessionCount, Answered],
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
	versions: [{ schema: UpkeepBound, logins: [], declarations: noDeclarations }],
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

export type UpkeepFeature = "the stored relation's upkeep ran" | "the live relation's rule probed"

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
				for (const setting of largeTables) {
					yield* session.query(setting, [])
				}
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

/** Each statement measured, named (`named`), with its work (`scannedWork`). */
const measured = (plans: ReadonlyArray<JudgePlan<JudgeStatement>>) =>
	Arr.map(plans, (p) => ({ statement: named(p.statement), rows: scannedWork(p.plan) }))

/**
 * One case on a fresh clone, in one session: learner 1 enrolled with `few` sessions of `answers` answers, committed, and
 * the judge's work at a fresh answer's COMMIT measured (`answerWork`); then `more` sessions of `answers` answers added
 * to the same learner, committed, and the work measured again. Each statement reads the same rows both times: its
 * stored relation's upkeep re-derives the one session the answer touched, at (child, s), never the learner's other
 * sessions, and the probe of the live relation's rule reads Answered's definition at the answer's learner, and its
 * Enrolled row, never its history; an upkeep of Answered, at (child), would read every answer of the learner, which
 * `more` adds to.
 */
export const runUpkeep = (
	installed: Installed,
	session: RawSession,
	d: UpkeepCase,
	c: Case<UpkeepFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(session, installed.installation)
		yield* committedJudged(session, [
			`INSERT INTO ${namesOf(installed).table(Enrolled)} (child) VALUES (1)`,
			...sessionsSql(installed, 1, d.few, d.answers)
		])
		const few = yield* answerWork(installed, session, d.answers)
		yield* committedJudged(session, sessionsSql(installed, d.few + 1, d.few + d.more, d.answers))
		const many = yield* answerWork(installed, session, d.answers)
		const enrolledRule = defined(
			Option.getOrUndefined(
				Arr.findFirst(installed.installation.laws.rules, (r) => r.law.reads.has("Enrolled"))
			),
			"the rule over Answered, the one rule that reads Enrolled"
		).named
		assert.deepEqual(
			measured(many),
			measured(few),
			`${Formatter.format(d)}: each statement the judge runs at an answer's COMMIT reads the same rows beside ${d.few} sessions of the learner and beside ${d.few + d.more}`
		)
		if (
			Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === "SessionCount")
		) {
			c.note("the stored relation's upkeep ran")
		}
		if (
			Arr.some(
				few,
				(p) =>
					p.statement.kind === "rule" &&
					Option.contains(raisedRule(p.statement.statement), identifierOf(enrolledRule))
			)
		) {
			c.note("the live relation's rule probed")
		}
	})
