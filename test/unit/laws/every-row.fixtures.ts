/** What the property of every-row.test.ts reads: its box, its schemas, and each case's judgement. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { everyRowProbe, type ProbedRule } from "#compiler/analysis/theory/query.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { noClock } from "#compiler/ir/clock.ts"
import type { InferredMatch, InferredQuery } from "#compiler/ir/desc.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { probedRule } from "#test/support/probed.ts"
import { type HostFacts, referenceRows } from "#test/support/unit/analysis/theory/support.ts"
import { boxSchemaOf, gates, type Gate, laws } from "#test/unit/laws/every-row.schema.ts"

export interface Case {
	/** The value T's b is held at in D's second arm, T at a literal b, and in its third, T at b whose a no S holds. */
	readonly literal: Gate
	readonly negated: Gate
	readonly law: (typeof laws)[number]
	readonly facts: HostFacts
}

/** A drawn state: up to four rows of T, three of S and four of G, over small values, lawful or not. */
const factsGen: Gen<HostFacts> = (s) => ({
	T: Arr.map(s.draw(subset([1, 2, 3, 4], { min: 0, max: 4 })), (k) => ({
		k,
		a: s.draw(int(0, 3)),
		b: s.draw(int(0, 3))
	})),
	S: Arr.map(s.draw(subset([1, 2, 3], { min: 0, max: 3 })), (id) => ({ id, a: s.draw(int(0, 3)) })),
	G: Arr.map(s.draw(subset([0, 1, 2, 3], { min: 0, max: 4 })), (x) => ({ x }))
})

export const caseGen: Gen<Case> = (s) => ({
	literal: s.draw(element(gates)),
	negated: s.draw(element(gates)),
	law: s.draw(element(laws)),
	facts: s.draw(factsGen)
})

export type Feature =
	| "a check that finds a row"
	| "a check that finds none"
	| "a fact only a later arm derives"
	| "a containment"
	| "a row check"
	| "a key"

export const features: readonly [Feature, ...Array<Feature>] = [
	"a check that finds a row",
	"a check that finds none",
	"a fact only a later arm derives",
	"a containment",
	"a row check",
	"a key"
]

/** A probe over every row: its region, the delta of the rows a transaction adds, read as the relation itself. */
const overEveryRow = (probe: InferredQuery): InferredQuery => {
	const stage = probe.stage
	if (stage.kind !== "rules") {
		return assert.fail("a probe of rules")
	}
	const match = (m: InferredMatch): InferredMatch =>
		m.source.kind === "delta" && m.source.side === "added"
			? { ...m, source: { kind: "relation", name: m.source.relation } }
			: m.source.kind === "query"
				? { ...m, source: { ...m.source, query: overEveryRow(m.source.query) } }
				: m
	return {
		...probe,
		stage: {
			...stage,
			arms: Arr.map(stage.arms, (rule) => ({ ...rule, matches: Arr.map(rule.matches, match) }))
		}
	}
}

/** `rule` with its breaking side's first arm alone: what reads a fact of that arm only. */
const firstArmOf = (rule: ProbedRule): ProbedRule => {
	switch (rule.kind) {
		case "contained":
			return { ...rule, from: { ...rule.from, arms: [rule.from.arms[0]] } }
		case "key":
		case "check":
			return { ...rule, side: { ...rule.side, arms: [rule.side.arms[0]] } }
	}
}

/**
 * One case: the rule's check over every row (analysis/theory/query.ts everyRowProbe), its region every row of its
 * anchor, read by the reference evaluator, finds a row exactly where the rule's violation query does, and the same
 * rows where the two are of one heading.
 */
export const judged = (c: Case, note: (f: Feature) => void): void => {
	const artifacts = succeeded(testArtifacts(boxSchemaOf(c), testCompile))
	const rule = defined(artifacts.laws.rules[0], "the case's rule over a query")
	const theory = artifacts.laws.theory
	const violations = succeeded(theoryViolations(artifacts.laws.checked, theory))
	const forbid = defined(violations.forbids.get(rule.law.id), "the rule's violation query")
	if (forbid.kind !== "Forbid") {
		return assert.fail("a Forbid node")
	}
	const meant = referenceRows(theory, violations.dag, forbid.violation, c.facts)
	const probed = probedRule(rule.rule)
	const stored = (name: string): boolean => Arr.some(rule.tables, (t) => t.relation.name === name)
	const heading = Arr.join(
		Arr.sort(
			Arr.map(forbid.violation.heading, (h) => h.name),
			Order.String
		),
		","
	)
	const foundBy = (r: ProbedRule) => {
		const checked = succeeded(
			checkQuery(artifacts.laws.checked, overEveryRow(everyRowProbe(r, stored, rule.law.loc)), {
				read: "region",
				clock: noClock,
				label: "the check over every row",
				session: CheckSession.own()
			})
		)
		const root = defined(checked.dag.roots[0], "the probe's root")
		return {
			heading: Arr.join(
				Arr.sort(
					Arr.map(root.heading, (h) => h.name),
					Order.String
				),
				","
			),
			rows: referenceRows(theory, checked.dag, root, c.facts)
		}
	}
	const found = foundBy(probed)
	const any = found.rows.size > 0
	assert.equal(
		any,
		meant.size > 0,
		`the check over every row finds ${any ? "a row" : "none"} where the violation query finds ${meant.size}`
	)
	if (found.heading === heading) {
		assert.deepEqual(
			new Set(found.rows),
			new Set(meant),
			"the check over every row finds the violation query's facts"
		)
	}
	note(any ? "a check that finds a row" : "a check that finds none")
	if (any && foundBy(firstArmOf(probed)).rows.size === 0) {
		note("a fact only a later arm derives")
	}
	note(c.law === "contained" ? "a containment" : c.law === "check" ? "a row check" : "a key")
}
