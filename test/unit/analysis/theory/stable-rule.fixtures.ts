/** What the property of stable-rule.test.ts reads: its box, each case's schema, and its judgement. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { Fn, Type } from "#compiler/public/compute.ts"
import { int4, money } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, fn, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"

/** The value the rule reads beside its relation's rows: a declared function's call of each volatility, or a conversion
 * of an integer to money, which reads the session's lc_monetary. */
const values = ["an immutable function", "a stable function", "a conversion to money"] as const
/** Where the derived relation the check reads computes it: in its head, or in a condition of its rule. */
const sites = ["head", "condition"] as const
/** How the rule is judged: whole over the units a transaction wrote (A and W immutable), or by its probes (A and W
 * mutable, each in a unit of its own, so the check reads the rows of two units). */
const judgements = ["whole", "probes"] as const

export interface Case {
	readonly value: (typeof values)[number]
	readonly site: (typeof sites)[number]
	readonly judged: (typeof judgements)[number]
}

export const caseGen: Gen<Case> = (s) => ({
	value: s.draw(element(values)),
	site: s.draw(element(sites)),
	judged: s.draw(element(judgements))
})

export type Feature = Case["value"] | `in the ${Case["site"]}` | `judged by ${Case["judged"]}`

const A = relation("A", { id: int4, n: int4, x: int4 }, ["id", "n"])

/** An id D reads A's rows at, keyed by its own field. */
const W = relation("W", { wid: int4 }, ["wid"])

/** The declared function of the case's volatility, `x` doubled. */
const doubled = (volatility: "immutable" | "stable") =>
	fn("doubled", {
		calls: [],
		args: { x: int4 },
		returns: int4,
		volatility,
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT $1 * 2`
	})

/** A's and W's schema, both immutable where the case is judged whole and mutable where its probes judge it, A in the
 * unit of its id and W in the unit of its own, with `doubled`. */
const baseOf = (c: Case) => {
	const called = doubled(c.value === "a stable function" ? "stable" : "immutable")
	return {
		called,
		Base: schema(
			"Stable",
			[A, W, called],
			c.judged === "probes"
				? [unit("As", { id: int4 }), unit("Ws", { wid: int4 }), mutable(A), mutable(W)]
				: []
		)
	}
}

/**
 * Each value's schema at each site: A(id, n, x) and W(wid); D, A's rows at an id W holds with w, the value of x, and u,
 * the value of n, computed in D's head, or each of x and n and the condition that x's value is at most n's; and a check
 * over D that w is at most u.
 */
const schemas = {
	"function, head": (c: Case) => {
		const { called, Base } = baseOf(c)
		const D = derived(
			"D",
			query(Base).rule((r) => {
				const { id, n, x } = v(A, "a")
				return r
					.match(A, { id, n, x })
					.match(W, { wid: id })
					.find({ id, w: Fn.call(called, { x }), u: Fn.call(called, { x: n }) })
			})
		)
		return schema.extend([Base], "Stable_1", [D], [check("Bounded", D, (t) => t.le(t.w, t.u))])
	},
	"function, condition": (c: Case) => {
		const { called, Base } = baseOf(c)
		const D = derived(
			"D",
			query(Base).rule((r) => {
				const { id, n, x } = v(A, "a")
				return r
					.match(A, { id, n, x })
					.match(W, { wid: id })
					.where(r.le(Fn.call(called, { x }), Fn.call(called, { x: n })))
					.find({ id, w: x, u: n })
			})
		)
		return schema.extend([Base], "Stable_1", [D], [check("Bounded", D, (t) => t.le(t.w, t.u))])
	},
	"money, head": (c: Case) => {
		const { Base } = baseOf(c)
		const D = derived(
			"D",
			query(Base).rule((r) => {
				const { id, n, x } = v(A, "a")
				return r
					.match(A, { id, n, x })
					.match(W, { wid: id })
					.find({ id, w: Type.cast(x, money), u: Type.cast(n, money) })
			})
		)
		return schema.extend([Base], "Stable_1", [D], [check("Bounded", D, (t) => t.le(t.w, t.u))])
	},
	"money, condition": (c: Case) => {
		const { Base } = baseOf(c)
		const D = derived(
			"D",
			query(Base).rule((r) => {
				const { id, n, x } = v(A, "a")
				return r
					.match(A, { id, n, x })
					.match(W, { wid: id })
					.where(r.le(Type.cast(x, money), Type.cast(n, money)))
					.find({ id, w: x, u: n })
			})
		)
		return schema.extend([Base], "Stable_1", [D], [check("Bounded", D, (t) => t.le(t.w, t.u))])
	}
} as const

/** The case's schema (`schemas`). */
const schemaOf = (c: Case) =>
	schemas[`${c.value === "a conversion to money" ? "money" : "function"}, ${c.site}`](c)

/**
 * One case: the schema's artifacts, built as generate builds them, its rule's violation queries written
 * (laws/model/violations.ts theoryViolations), are refused exactly where its rule reads a stable value, the refusal naming
 * the rule; where every value is immutable they build, the rule judged as the case says.
 */
export const judged = (c: Case, note: (f: Feature) => void): void => {
	const artifacts = testArtifacts(schemaOf(c), testCompile)
	note(c.value)
	note(`in the ${c.site}`)
	note(`judged by ${c.judged}`)
	if (c.value !== "an immutable function") {
		if (artifacts.ok) {
			return assert.fail(`${c.value} in the ${c.site} is refused`)
		}
		const reason = artifacts.error.reason
		if (reason._tag !== "UnsupportedOperation") {
			return assert.fail(
				`${c.value} in the ${c.site} is refused as UnsupportedOperation, not ${reason._tag}`
			)
		}
		return assert.equal(reason.at.label, "check Bounded", "the refusal stands at the rule")
	}
	if (!artifacts.ok) {
		return assert.fail(`an immutable value's rule builds: ${artifacts.error.message}`)
	}
	const [rule, ...more] = artifacts.value.laws.rules
	if (rule === undefined || more.length > 0) {
		return assert.fail("the schema states one rule, the check")
	}
	assert.equal(
		rule.rule.kind === "whole",
		c.judged === "whole",
		"the check is judged whole exactly where A is immutable"
	)
	assert.ok(
		theoryViolations(artifacts.value.laws.checked, artifacts.value.laws.theory).ok,
		"its violation queries are written"
	)
}
