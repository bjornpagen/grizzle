/** What the property of refined-restriction.test.ts reads: its box, each case's schema, and its judgement. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import { contract, natural, pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { owning } from "#test/support/policy.ts"

/**
 * How the derived rule equates its budget's stage, a Stage, with Type.base of the assignment's number, a natural: the
 * stage itself on either side, as metis's FirstBudget wrote it, or Type.base of it, as metis wrote it once refused.
 */
const equalities = [
	"stage = base(number)",
	"base(number) = stage",
	"base(stage) = base(number)"
] as const
/** The rules of the timing limits' union: one, which navigation inlines, or two, which it reads apart. */
const widths = [1, 2] as const

export interface Case {
	readonly equality: (typeof equalities)[number]
	readonly width: (typeof widths)[number]
}

export const caseGen: Gen<Case> = (s) => ({
	equality: s.draw(element(equalities)),
	width: s.draw(element(widths))
})

export type Feature =
	| Case["equality"]
	| "a union of one rule"
	| "a union of two rules"
	| "metis's first budget"

const stageKey = Symbol("Stage")
/** A sitting's stage, a contract over pg.bigint, as qti-pie's SittingKey is. */
const Stage = contract<typeof stageKey>()("Stage", pg.bigint, (s) => Logic.ge(s, 0n))

const Assignment = relation("Assignment", { child: pg.integer, number: natural }, [
	"child",
	"number"
])
const Budget = relation("Budget", { child: pg.integer, stage: Stage, remaining: pg.bigint }, [
	"child",
	"stage"
])
const Limit = relation("Limit", { number: natural, seconds: pg.bigint }, ["number"])
const Base = schema("refined_restriction", [Assignment, Budget, Limit], [])

/** Each assignment's sitting, its stage its number cast into Stage under the contract's key. */
const sittings = query(Base).rule((r) => {
	const { child, number } = v(Assignment, "assignment")
	return r
		.match(Assignment, { child, number })
		.find({ child, number, stage: Type.cast(Type.base(number), Budget.fields.stage, stageKey) })
})

/** A rule of the timing limits: each sitting's limit, where its seconds are positive, or where they are none. */
const timed = (r: Rule<typeof Base>, positive: boolean) => {
	const { child, number, stage } = v(sittings, "sitting")
	const { seconds } = v(Limit, "limit")
	return r
		.match(sittings, { child, number, stage })
		.match(Limit, { number, seconds })
		.where(positive ? r.gt(seconds, 0n) : r.le(seconds, 0n))
		.find({ child, stage, seconds })
}

const limitsOf = (width: Case["width"]) =>
	width === 1
		? query(Base).rule((r) => timed(r, true))
		: query(Base)
				.rule((r) => timed(r, true))
				.rule((r) => timed(r, false))

/**
 * The case's schema, metis's FirstBudget's: First, each budget beside its sitting's limit, where the budget's stage
 * is the assignment's number, matching Budget at the stage, the limits at it and Assignment at the child, and a check
 * of it, which the judge's probes of each relation First reads hold, Assignment's among them.
 */
const schemaOf = (c: Case) => {
	const limits = limitsOf(c.width)
	const First = derived(
		"First",
		query(Base).rule((r) => {
			const { child, stage, remaining } = v(Budget, "budget")
			const { seconds } = v(limits, "limit")
			const { number } = v(Assignment, "assignment")
			return r
				.match(Budget, { child, stage, remaining })
				.match(limits, { child, stage, seconds })
				.match(Assignment, { number, child })
				.where(
					c.equality === "stage = base(number)"
						? r.eq(stage, Type.base(number))
						: c.equality === "base(number) = stage"
							? r.eq(Type.base(number), stage)
							: r.eq(Type.base(stage), Type.base(number))
				)
				.find({ child, stage, remaining, limit: seconds })
		})
	)
	return schema.extend(
		[Base],
		"refined_restriction_1",
		[First],
		[check("Within", First, (f) => f.le(f.remaining, f.limit))]
	)
}

/** One case: the schema compiles to its installation, its judge's statements among it. */
export const judged = (c: Case, note: (f: Feature) => void): void => {
	const owned = owning(schemaOf(c))
	const installation = compileInstallation(owned, installOptions(owned))
	assert.ok(
		installation.ok,
		`a check over a rule equating a Stage with a natural's base, ${c.equality}, beside a union of ${c.width} compiles: ${installation.ok ? "" : installation.error.message}`
	)
	note(c.equality)
	note(c.width === 1 ? "a union of one rule" : "a union of two rules")
	if (c.equality === "stage = base(number)" && c.width === 2) {
		note("metis's first budget")
	}
}
