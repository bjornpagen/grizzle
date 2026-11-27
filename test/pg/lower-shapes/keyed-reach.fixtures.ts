/** What keyed-reach.test.ts reads: its schema, its reads and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { rowsRead } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
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
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"

const i = pg.integer

/**
 * A learner's attempts as edullm's ledger holds them: an answer attempt at its own instant, a submission naming the save
 * it submits, each save at its instant, and the values recorded at each instant, each relation keyed by the learner and
 * its own key, in the learner's unit.
 */
const Answer = relation("Answer", { child: i, attempt: i, at: i }, ["child", "attempt"])
const Submit = relation("Submit", { child: i, attempt: i, save: i }, ["child", "attempt"])
const Save = relation("Save", { child: i, save: i, at: i }, ["child", "save"])
const Value = relation("Value", { child: i, at: i, name: i, value: i }, ["child", "at", "name"])
const Learners = schema(
	"KeyedReach",
	[Answer, Submit, Save, Value],
	[unit("Learner", { child: i })]
)

/**
 * The instant an attempt's values stand at, edullm's AttemptValueAt: an answer attempt's own instant, or the instant of
 * the save a submission names, a derived relation of two rules, each keyed by the attempt.
 */
const AttemptValueAt = derived(
	"AttemptValueAt",
	query(Learners)
		.rule((r) => {
			const { child, attempt, at } = v(Answer, "answer")
			return r.match(Answer, { child, attempt, at }).find({ child, attempt, at })
		})
		.rule((r) => {
			const { child, attempt, save } = v(Submit, "submit")
			const { at } = v(Save, "save")
			return r
				.match(Submit, { child, attempt, save })
				.match(Save, { child, save, at })
				.find({ child, attempt, at })
		})
)
const Ledger = schema.extend([Learners], "KeyedReachDerived", [AttemptValueAt], [])

/** An attempt's instant, read by the attempt's whole key at the parameters. */
const valueAt = query(Ledger).rule((r) => {
	const { child, attempt, at } = v(AttemptValueAt, "valueAt")
	return r
		.match(AttemptValueAt, { child, attempt, at })
		.where(r.eq(child, r.param("child", i)), r.eq(attempt, r.param("attempt", i)))
		.find({ at })
})

/** An attempt's values, its instant read by the attempt's whole key and joined to the values recorded then. */
const valuesOf = query(Ledger).rule((r) => {
	const { child, attempt, at } = v(AttemptValueAt, "valueAt")
	const { name, value } = v(Value, "value")
	return r
		.match(AttemptValueAt, { child, attempt, at })
		.match(Value, { child, at, name, value })
		.where(r.eq(child, r.param("child", i)), r.eq(attempt, r.param("attempt", i)))
		.find({ name, value })
})

/** The reads a case explains. */
const keyedReads = { valueAt, valuesOf } as const
export type KeyedRead = keyof typeof keyedReads

/** The schemas installed through their first migration, with a reader whose workload's indexes the reads earn. */
export const keyedReachTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "keyed reach",
	fixture: Ledger,
	programs: keyedReads,
	contexts: [],
	label: "keyed_reach",
	ambient: ordinarySession
})

/**
 * A case: the read; the attempt asked, an answer or a submission, of child 1; `children` children stored, each of
 * `attempts` attempts, the odd ones answers and the even ones submissions of a save of their own, each instant with
 * `values` values; then `more` children stored beside them before the read is run again; and the pg_class state its
 * tables stand in as each load ends (test/support/advice.ts PgClassState).
 */
export interface KeyedReachCase {
	readonly read: KeyedRead
	readonly asked: "answer" | "submission"
	readonly children: number
	readonly attempts: number
	readonly values: number
	readonly more: number
	readonly state: PgClassState
}

export const keyedReachGen: Gen<KeyedReachCase> = (s) => ({
	read: s.draw(element<KeyedRead>(["valueAt", "valuesOf"])),
	asked: s.draw(element<KeyedReachCase["asked"]>(["answer", "submission"])),
	children: s.draw(int(2, 8)),
	attempts: s.draw(int(2, 6)),
	values: s.draw(int(1, 4)),
	more: s.draw(int(200, 600)),
	state: s.draw(element(pgClassStates))
})

export type KeyedReachFeature =
	| "an answer's instant"
	| "a submission's save's instant"
	| "the values at the instant"
	| `its tables ${PgClassState}`

/**
 * The statements storing children `from` to `to`: each child's attempts, the odd ones answers at instant 10a and the
 * even ones submissions of save a at instant 10a + 1, each instant's values; AttemptValueAt's table, where the
 * installation stores it, filled as its upkeep fills it.
 */
const stored = (
	installed: Installed,
	c: KeyedReachCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const grid = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(1, ${String(c.attempts)}) AS h(a)`
	const instants = `${grid}, generate_series(1, ${String(c.values)}) AS k(n)`
	const holding = installed.installation.checked.holdings.get(AttemptValueAt.name)
	return [
		`INSERT INTO ${names.table(Answer)} SELECT c, a, 10 * a ${grid} WHERE a % 2 = 1`,
		`INSERT INTO ${names.table(Save)} SELECT c, a, 10 * a + 1 ${grid} WHERE a % 2 = 0`,
		`INSERT INTO ${names.table(Submit)} SELECT c, a, a ${grid} WHERE a % 2 = 0`,
		`INSERT INTO ${names.table(Value)} SELECT c, 10 * a + 1 - a % 2, n, n ${instants}`,
		...(holding?.kind === "stored"
			? [
					`INSERT INTO ${names.table(AttemptValueAt)} (child, attempt, at) SELECT c, a, 10 * a + 1 - a % 2 ${grid}`
				]
			: [])
	]
}

/**
 * One case in its one transaction, which the case's end rolls back: children 1 to `children` stored, then `more`
 * children beside them, its tables stood in the case's pg_class state as each load ends; the read of child 1's asked
 * attempt run under its carried advice once the plan laws hold over it (test/support/advice.ts servedRun), Law 2 among
 * them: every column the read binds of each relation, its key, the learner among them, is its scan's index condition,
 * inside a CTE of the statement as anywhere, so the union of the two rules is derived at the key in each arm, never
 * whole. It reads at most twice the rows its key reaches: the asked attempt's answer, or its submission and the save it
 * names, and, for `valuesOf`, the values at its instant. A union derived whole for every learner reads each learner's
 * attempts and saves, past the bound and the law.
 */
export const runKeyedReach = (
	installed: Installed,
	connection: PgConnection,
	c: KeyedReachCase,
	k: Case<KeyedReachFeature>
) =>
	Effect.gen(function* () {
		const session: BenchSession = { values: connection.queryValues }
		const names = namesOf(installed)
		const holding = installed.installation.checked.holdings.get(AttemptValueAt.name)
		const storing = (first: number, units: number): StateLoad => ({
			tables: [
				names.table(Answer),
				names.table(Submit),
				names.table(Save),
				names.table(Value),
				...(holding?.kind === "stored" ? [names.table(AttemptValueAt)] : [])
			],
			units,
			load: (from, to) =>
				Effect.forEach(
					stored(installed, c, first + from - 1, first + to - 1),
					(sql) => connection.query(sql, []),
					{ discard: true }
				)
		})
		yield* standUpJudge(connection, installed.installation)
		yield* standIn(session, storing(1, c.children), c.state)
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Ledger, []),
			keyedReads[c.read],
			`${Formatter.format(c)}: ${c.read}`
		)
		const attempt = c.asked === "answer" ? 1 : 2
		/** The rows the key reaches: the answer, or the submission and its save, and the values at the instant. */
		const own = (c.asked === "answer" ? 1 : 2) + (c.read === "valuesOf" ? c.values : 0)
		const bound = 2 * own
		yield* standIn(session, storing(c.children + 1, c.more), c.state)
		const plan = yield* servedRun(session, read, { child: 1, attempt })
		const scanned = rowsRead(plan)
		assert.ok(
			scanned <= bound,
			`${read.scope.label} beside ${String(c.children + c.more)} children reads ${String(scanned)} rows, past its bound ${String(bound)} (the key reaches ${String(own)})\n${read.statement.sql}`
		)
		k.note(c.asked === "answer" ? "an answer's instant" : "a submission's save's instant")
		if (c.read === "valuesOf") {
			k.note("the values at the instant")
		}
		k.note(`its tables ${c.state}`)
	})
