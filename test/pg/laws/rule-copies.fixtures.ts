/** What the property of rule-copies.test.ts reads: its schemas and templates, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { fullWorldRole, servedRead, servedRun } from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, seededTemplate } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { judgedPlans, judgedStatementsOf, readWork, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { storedSeed } from "#test/support/stored.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * metis's first budget in small (test/unit/physical/judge-copies.fixtures.ts): the sitting limits, a union of `arms`
 * rules over Assignment and Limit, each sitting's limit of each kind; and FirstBudget, `rules` rules, each a budget
 * written beside its sitting's limits and a fact of its own, its sitting not held, which a check holds to the limit. Each
 * rule reads the limits at its own budget's sitting, a copy of one sub-query each rule's judge reads at its row.
 */
const i = int4
const Assignment = relation("Assignment", { number: i, child: i, test: i }, ["number"])
const Limit = relation("Limit", { test: i, kind: i, seconds: i }, ["test", "kind"])
const Budget = relation("Budget", { child: i, stage: i, remaining: i }, ["child", "stage"])
const Used = relation("Used", { child: i, stage: i, used: i }, ["child", "stage"])
const Left = relation("Left", { child: i, stage: i, left: i }, ["child", "stage"])
const Paused = relation("Paused", { child: i, stage: i, paused: i }, ["child", "stage"])
const Suspended = relation("Suspended", { test: i }, ["test"])
const Base = schema("rule_copies", [Assignment, Limit, Budget, Used, Left, Paused, Suspended], [])

/** The sittings held: each assignment whose test is suspended. */
const held = query(Base).rule((r) => {
	const { number, child, test } = v(Assignment, "assignment")
	return r
		.match(Assignment, { number, child, test })
		.match(Suspended, { test })
		.find({ child, stage: number })
})

/** How many rules read the limits, and how many arms the limits have. */
interface Shape {
	readonly rules: 2 | 3
	readonly arms: 2 | 3
}

/** The limits: each sitting's limit of each kind, one rule a kind, `arms` of them. */
const limitsOf = (arms: Shape["arms"]) => {
	const arm = (kind: number) => (r: Rule<typeof Base>) => {
		const { number, child, test } = v(Assignment, "assignment")
		const { seconds } = v(Limit, "limit")
		return r
			.match(Assignment, { number, child, test })
			.match(Limit, { test, kind, seconds })
			.find({ child, stage: number, seconds })
	}
	const two = query(Base).rule(arm(1)).rule(arm(2))
	return arms === 2 ? two : two.rule(arm(3))
}

/** The shape's schema: the budgets beside their limits, one rule for each fact a budget stands beside. */
const schemaOf = (shape: Shape) => {
	const limits = limitsOf(shape.arms)
	const besideUsed = (r: Rule<typeof Base>) => {
		const { child, stage, remaining } = v(Budget, "budget")
		const { seconds } = v(limits, "limit")
		const { used } = v(Used, "used")
		return r
			.match(Budget, { child, stage, remaining })
			.match(limits, { child, stage, seconds })
			.match(Used, { child, stage, used })
			.where(r.not(held, { child, stage }))
			.find({ child, stage, remaining, limit: seconds })
	}
	const besideLeft = (r: Rule<typeof Base>) => {
		const { child, stage, remaining } = v(Budget, "budget")
		const { seconds } = v(limits, "limit")
		const { left } = v(Left, "left")
		return r
			.match(Budget, { child, stage, remaining })
			.match(limits, { child, stage, seconds })
			.match(Left, { child, stage, left })
			.where(r.not(held, { child, stage }))
			.find({ child, stage, remaining, limit: seconds })
	}
	const besidePaused = (r: Rule<typeof Base>) => {
		const { child, stage, remaining } = v(Budget, "budget")
		const { seconds } = v(limits, "limit")
		const { paused } = v(Paused, "paused")
		return r
			.match(Budget, { child, stage, remaining })
			.match(limits, { child, stage, seconds })
			.match(Paused, { child, stage, paused })
			.where(r.not(held, { child, stage }))
			.find({ child, stage, remaining, limit: seconds })
	}
	const two = query(Base).rule(besideUsed).rule(besideLeft)
	const FirstBudget = derived("FirstBudget", shape.rules === 2 ? two : two.rule(besidePaused))
	return schema.extend(
		[Base],
		"rule_copies_1",
		[FirstBudget],
		[check("First_budget", FirstBudget, (b) => b.eq(b.remaining, b.limit))]
	)
}

/**
 * The sittings stored, each with its assignment, its test's limits and its facts: a few hundred, one count, since a
 * worker holds a connection to each template its property's cases take, and a template a shape is all it can hold.
 */
const sittings = 400

/** Every test a sitting's assignment reads: a few, so each test's limits stand beside many sittings. */
const tests = 7

/** Every limit's seconds, which each budget written states as its remaining, so the law holds. */
const seconds = 60

/** The most budgets a copies case writes at once (Copies `touched`). */
const touchedMost = 60

/**
 * The stored rows of the sittings over `shape`, `sittings` of them: sitting n child n's assignment of test n mod 7, each
 * test's limit of each kind, and each fact a rule stands beside.
 */
const storedRows = (installed: Installed, shape: Shape): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const facts = Arr.take([names.table(Used), names.table(Left), names.table(Paused)], shape.rules)
	return [
		`INSERT INTO ${names.table(Assignment)} SELECT n, n, n % ${String(tests)} FROM generate_series(1, ${String(sittings)}) AS g(n)`,
		`INSERT INTO ${names.table(Limit)} SELECT t, k, ${String(seconds)} FROM generate_series(0, ${String(tests - 1)}) AS t(t), generate_series(1, ${String(shape.arms)}) AS k(k)`,
		...Arr.map(
			facts,
			(f) => `INSERT INTO ${f} SELECT n, n, 1 FROM generate_series(1, ${String(sittings)}) AS g(n)`
		)
	]
}

/**
 * The schema of each shape installed through its first migration, by `rules arms`, and its stored sittings
 * committed through the captures once per member, judged at their COMMIT (stored.ts storedSeed).
 */
const templateOf = (shape: Shape): SubstrateTemplate<Installed> =>
	seededTemplate({
		declaredIn: import.meta,
		name: `rule copies ${String(shape.rules)} ${String(shape.arms)}`,
		schema: schemaOf(shape),
		options: {
			ambient: ordinarySession,
			extensions: [],
			label: `rule_copies_${String(shape.rules)}_${String(shape.arms)}`
		},
		seed: storedSeed((installed) => storedRows(installed, shape))
	})

/** Each shape by its rules and arms. */
const shapes = {
	"2 2": { rules: 2, arms: 2 },
	"2 3": { rules: 2, arms: 3 },
	"3 2": { rules: 3, arms: 2 },
	"3 3": { rules: 3, arms: 3 }
} as const satisfies Readonly<Record<string, Shape>>

export const copiesTemplates: {
	readonly [K in keyof typeof shapes]: SubstrateTemplate<Installed>
} = {
	"2 2": templateOf(shapes["2 2"]),
	"2 3": templateOf(shapes["2 3"]),
	"3 2": templateOf(shapes["3 2"]),
	"3 3": templateOf(shapes["3 3"])
}

/**
 * A case: the shape, by its rules and arms, the sittings stored, each with its assignment, its test's limits and its
 * facts, and how many budgets a write touches, `touched`: the judge is measured at one budget written, then at
 * `touched`.
 */
export interface Copies {
	readonly shape: keyof typeof shapes
	readonly touched: number
}

export const copiesGen: Gen<Copies> = (s) => ({
	shape: s.draw(element(["2 2", "2 3", "3 2", "3 3"] as const)),
	touched: s.draw(int(20, touchedMost))
})

export type CopiesFeature =
	| "two rules"
	| "three rules"
	| "limits of two arms"
	| "limits of three arms"

/**
 * One case in its one transaction over a clone of its shape's template (copiesTemplates), which the case's end rolls
 * back: the template's committed sittings, `sittings` of them, sitting n child n's assignment of test n mod 7, each
 * test's limit of each kind, and each fact a rule stands beside; then, through the captures, the budget of sitting 1,
 * its remaining the limits' seconds, and the judge's statements explained over it before the judge runs, each under its
 * routine's advice (test/support/judge.ts judgedPlans, their work judge.ts readWork); then the budget of sitting 2, and
 * the budgets of sittings 3 to `touched`, each explained again.
 * Each copy of the limits a rule reads at its budget's sitting is computed once for each touched sitting and read there
 * by every rule, so the judge's work at k budgets is at most k times its work at one, c * k at every k: it grows with
 * the budgets, never with their square, and stands at none of the stored sittings beside them. A copy read at each
 * touched sitting's value from one evaluation at every sitting's, a CTE no index reads, scanned the evaluation whole
 * for each sitting (42, 600, 1,600, 4,800 and 16,000 rows at 1, 10, 20, 40 and 80 budgets, two rules over two arms, at
 * 242459f67; 38 a budget here).
 */
export const runCopies = (
	installed: Installed,
	connection: PgConnection,
	c: Copies,
	k: Case<CopiesFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const names = namesOf(installed)
		const shape = shapes[c.shape]
		yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
		/** The judge's work over the budgets of sittings `from` to `to`, written through the captures. */
		const written = (from: number, to: number) =>
			Effect.gen(function* () {
				yield* connection.query(
					`INSERT INTO ${names.table(Budget)} SELECT n, n, ${String(seconds)} FROM generate_series(${String(from)}, ${String(to)}) AS g(n)`,
					[]
				)
				const judged = yield* judgedPlans(
					(sql) => connection.queryValues(sql, []),
					installed.installation,
					judgedStatementsOf(installed.installation)
				)
				return Arr.reduce(judged, 0, (sum, { plan }) => sum + readWork(plan))
			})
		const one = yield* written(1, 1)
		const two = yield* written(2, 2)
		const many = yield* written(3, c.touched)
		assert.ok(
			two <= 2 * one && many <= c.touched * one,
			`${Formatter.format(c)}: the judge's scans read ${String(one)}, ${String(two)} and ${String(many)} rows over 1, 2 and ${String(c.touched)} budgets written, at most ${String(one)} for each budget`
		)
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		k.note(shape.rules === 2 ? "two rules" : "three rules")
		k.note(shape.arms === 2 ? "limits of two arms" : "limits of three arms")
	})

/**
 * A read of one child's budgets beside its sittings' limits, the limits an import bound to each budget's stage
 * (`limitsAt.bind({ stage })`), a copy correlated to each rule's row, read by two rules, each beside a fact of its own.
 * Each rule's region binds the stage from Budget, a stored relation it reads at the child, which the statement does not
 * hold whole: its copies stay where they stand, each read at its budget's stage, never computed beside every stored
 * budget.
 */
const limitsAt = query(Base)
	.rule((r) => {
		const { child, test } = v(Assignment, "assignment")
		const { seconds } = v(Limit, "limit")
		return r
			.match(Assignment, { number: r.param("stage", i), child, test })
			.match(Limit, { test, kind: 1, seconds })
			.find({ seconds })
	})
	.rule((r) => {
		const { child, test } = v(Assignment, "assignment")
		const { seconds } = v(Limit, "limit")
		return r
			.match(Assignment, { number: r.param("stage", i), child, test })
			.match(Limit, { test, kind: 2, seconds })
			.find({ seconds })
	})

const childsBudgets = query(Base)
	.rule((r) => {
		const { stage, remaining } = v(Budget, "budget")
		const { seconds } = v(limitsAt, "limit")
		const { used } = v(Used, "used")
		const child = r.param("child", i)
		return r
			.match(Budget, { child, stage, remaining })
			.match(limitsAt.bind({ stage }), { seconds })
			.match(Used, { child, stage, used })
			.find({ stage, remaining, limit: seconds })
	})
	.rule((r) => {
		const { stage, remaining } = v(Budget, "budget")
		const { seconds } = v(limitsAt, "limit")
		const { left } = v(Left, "left")
		const child = r.param("child", i)
		return r
			.match(Budget, { child, stage, remaining })
			.match(limitsAt.bind({ stage }), { seconds })
			.match(Left, { child, stage, left })
			.find({ stage, remaining, limit: seconds })
	})

/** The base schema installed through its first migration, with a reader whose workload's indexes the read earns. */
export const readTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "rule copies read",
	fixture: Base,
	programs: { childsBudgets },
	contexts: [],
	label: "rule_copies_read",
	ambient: ordinarySession
})

/**
 * A read case: the children stored, each with `each` budgets, its sittings' assignments, limits and facts, and the
 * children stored beside them before the read is explained again.
 */
export interface Read {
	readonly children: number
	readonly each: number
	readonly more: number
}

/** The most children a read case stores, its own and those it stores beside them after (Read `children`, `more`). */
const readChildrenMost = 60 + 300

/** The most budgets a read case's child holds (Read `each`). */
const eachMost = 6

export const readGen: Gen<Read> = (s) => ({
	children: s.draw(int(20, readChildrenMost - 300)),
	each: s.draw(int(2, eachMost)),
	more: s.draw(int(100, readChildrenMost - 60))
})

export type ReadFeature = "read beside a few children" | "read beside many children"

/**
 * One read case in its one transaction, which the case's end rolls back: children 1 to `children` with `each` budgets
 * each, child c's budget j at stage c * 10 + j, each stage's assignment of test stage mod 7, each test's limits and each
 * budget's facts; the read of child 1's budgets run under its carried advice once the plan laws hold over it
 * (test/support/advice.ts servedRun, its work test/support/judge.ts readWork); then `more` children stored beside them
 * alike, and the read run again. Its scans read the same rows both times: each rule reads its copy of the limits at its own
 * budget's stage, never beside every stored budget, whose rows the statement does not hold.
 */
export const runRead = (
	installed: Installed,
	connection: PgConnection,
	c: Read,
	k: Case<ReadFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const stored = (from: number, to: number, each: number) => {
			const stage = `c * 10 + j`
			const budgets = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(1, ${String(each)}) AS h(j)`
			return [
				`INSERT INTO ${names.table(Assignment)} SELECT ${stage}, c, (${stage}) % ${String(tests)} ${budgets}`,
				`INSERT INTO ${names.table(Budget)} SELECT c, ${stage}, ${String(seconds)} ${budgets}`,
				`INSERT INTO ${names.table(Used)} SELECT c, ${stage}, 1 ${budgets}`,
				`INSERT INTO ${names.table(Left)} SELECT c, ${stage}, 1 ${budgets}`
			]
		}
		for (const sql of [
			`INSERT INTO ${names.table(Limit)} SELECT t, k, ${String(seconds)} FROM generate_series(0, ${String(tests - 1)}) AS t(t), generate_series(1, 2) AS k(k)`,
			...stored(1, c.children, c.each)
		]) {
			yield* connection.query(sql, [])
		}
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Base, []),
			childsBudgets,
			"the read of child 1's budgets"
		)
		const explained = Effect.map(
			servedRun({ values: connection.queryValues }, read, { child: 1 }),
			readWork
		)
		const few = yield* explained
		for (const sql of stored(c.children + 1, c.children + c.more, c.each)) {
			yield* connection.query(sql, [])
		}
		const many = yield* explained
		assert.equal(
			many,
			few,
			`${Formatter.format(c)}: the read of child 1's ${String(c.each)} budgets reads the same rows beside ${String(c.children)} children and beside ${String(c.children + c.more)}`
		)
		k.note(c.children < 40 ? "read beside a few children" : "read beside many children")
	})
