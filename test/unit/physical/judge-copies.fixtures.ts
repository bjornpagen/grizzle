/** What judge-copies.test.ts reads: its space, its schemas, and the reads of the limits' tables in each judge. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, String as Str } from "effect"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import type { FromItem, FromSource, OperandSelect } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { judgedDeltaReadsOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/**
 * One case, metis's first budget reduced: the limits, a union of `arms` rules over Assignment and Limit, each sitting's
 * limit; and a derived relation of `rules` rules, each a budget written beside its sitting's limit, read at the budget's
 * own sitting, beside a fact of its own, its sitting not held, which a check holds to the limit; or
 * (`names`) of two rules, a budget beside the limit of its stage and beside the limit of its resumed sitting, a column
 * of another name and the same domain.
 */
export type Budgets =
	| { readonly kind: "facts"; readonly rules: 2 | 3; readonly arms: 2 | 3 }
	| { readonly kind: "names"; readonly arms: 2 | 3 }

export const budgetsGen: Gen<Budgets> = (s) =>
	s.draw(element<Budgets["kind"]>(["facts", "names"])) === "facts"
		? {
				kind: "facts",
				rules: s.draw(element<2 | 3>([2, 3])),
				arms: s.draw(element<2 | 3>([2, 3]))
			}
		: { kind: "names", arms: s.draw(element<2 | 3>([2, 3])) }

export type Reached =
	| "two rules"
	| "three rules"
	| "limits of two arms"
	| "limits of three arms"
	| "read at two columns' names"

const i = pg.integer
const Assignment = relation("Assignment", { number: i, child: i, test: i }, ["number"])
const Limit = relation("Limit", { test: i, kind: i, seconds: i }, ["test", "kind"])
const Budget = relation("Budget", { child: i, stage: i, resumed: i, remaining: i }, [
	"child",
	"stage"
])
const Used = relation("Used", { child: i, stage: i, used: i }, ["child", "stage"])
const Left = relation("Left", { child: i, stage: i, left: i }, ["child", "stage"])
const Paused = relation("Paused", { child: i, stage: i, paused: i }, ["child", "stage"])
const Suspended = relation("Suspended", { test: i }, ["test"])
const Base = schema("judge_copies", [Assignment, Limit, Budget, Used, Left, Paused, Suspended], [])

/** The sittings held: each assignment whose test is suspended, a join of two relations. */
const held = query(Base).rule((r) => {
	const { number, child, test } = v(Assignment, "assignment")
	return r
		.match(Assignment, { number, child, test })
		.match(Suspended, { test })
		.find({ child, stage: number })
})

/** The limits: each sitting's limit of each kind, one rule a kind, `arms` of them. */
const limitsOf = (arms: Budgets["arms"]) => {
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

/** The case's schema: the budgets beside their limits, one rule for each fact or each column a limit is read at. */
const schemaOf = (c: Budgets): FixtureSchema => {
	const limits = limitsOf(c.arms)
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
	const atStage = (r: Rule<typeof Base>) => {
		const { child, stage, remaining } = v(Budget, "budget")
		const { seconds } = v(limits, "limit")
		return r
			.match(Budget, { child, stage, remaining })
			.match(limits, { child, stage, seconds })
			.find({ child, stage, remaining, limit: seconds })
	}
	const atResumed = (r: Rule<typeof Base>) => {
		const { child, stage, resumed, remaining } = v(Budget, "budget")
		const { seconds } = v(limits, "limit")
		return r
			.match(Budget, { child, stage, resumed, remaining })
			.match(limits, { child, stage: resumed, seconds })
			.find({ child, stage, remaining, limit: seconds })
	}
	const facts = query(Base).rule(besideUsed).rule(besideLeft)
	const FirstBudget = derived(
		"FirstBudget",
		c.kind === "names"
			? query(Base).rule(atStage).rule(atResumed)
			: c.rules === 2
				? facts
				: facts.rule(besidePaused)
	)
	return schema.extend(
		[Base],
		"judge_copies_1",
		[FirstBudget],
		[check("First_budget", FirstBudget, (b) => b.eq(b.remaining, b.limit))]
	)
}

/** The reads of Limit's table in `statement`, at any depth: each FROM source that names it. */
const limitReadsOf = (statement: OperandSelect): number => {
	let reads = 0
	const source = (s: FromSource): void => {
		if (s.kind === "table" && typeof s.table !== "string" && s.table.name === "limit") {
			reads += 1
		}
	}
	const item = (it: FromItem): void => {
		if (it.kind === "joins") {
			source(it.first)
			for (const step of it.steps) {
				source(step.source)
			}
			return
		}
		source(it)
	}
	visitSelect(statement, { ...inertVisitor, fromItem: item })
	return reads
}

/**
 * Judges case `c`: each judge statement of the check over the budgets written, or under `names` the assignments written,
 * whose sittings each rule reads the limits of at its own column, reads Limit's table once for each arm of the limits, the limits
 * computed once for each touched budget's sitting and each rule reading that sitting's carried rows, whatever the name of
 * the column it reads it at; read at each rule's row where it stands, each rule spelled the limits again, `rules` times
 * `arms` reads.
 */
export const judgedOnce = (c: Budgets, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(c))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	/** The delta whose judge reads the limits at several sites: the budgets', or under `names` the assignments'. */
	const over = c.kind === "facts" ? "__delta_news_budget_" : "__delta_news_assignment_"
	const statements = Arr.filter(judgedDeltaReadsOf(installation), (s) =>
		Arr.some([...s.deltas], Str.startsWith(over))
	)
	assert.ok(statements.length > 0, `the check is judged over ${over}`)
	note(
		c.kind === "names" ? "read at two columns' names" : c.rules === 2 ? "two rules" : "three rules"
	)
	note(c.arms === 2 ? "limits of two arms" : "limits of three arms")
	for (const { statement } of statements) {
		const reads = limitReadsOf(statement.query)
		assert.ok(
			reads <= c.arms,
			`${Formatter.format(c)}: a judge reads Limit ${reads} times, where the limits computed once read it ${c.arms} times`
		)
	}
}
