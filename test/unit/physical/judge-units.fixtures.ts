/** What judge-units.test.ts reads: its space, its schemas, and the statement-wide reads of a whole rule's statements. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import type { Cte, FromItem, FromSource, OperandSelect } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { judgedStatementsOf, raisedRule } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/**
 * One case: the roots a whole rule's recursion is seeded from, a union of `arms` rules over Node, read again beside the
 * recursion by the containment's target, once, or twice, the second read joined to the root's node.
 */
export interface Roots {
	readonly arms: 2 | 3
	readonly beside: "once" | "twice"
}

export const rootsGen: Gen<Roots> = (s) => ({
	arms: s.draw(element<Roots["arms"]>([2, 3])),
	beside: s.draw(element<Roots["beside"]>(["once", "twice"]))
})

export type Reached =
	| "roots of two rules"
	| "roots of three rules"
	| "read again once"
	| "read again twice"

const Node = relation(
	"Node",
	{ doc: pg.integer, start: pg.integer, parent: pg.integer, kind: pg.integer },
	["doc", "start"]
)
const Base = schema("judge_units", [Node], [])

/** The roots: each node its own parent of kind 1, of kind 2, and, with three rules, of kind 3. */
const rootsOf = (arms: Roots["arms"]) => {
	const two = query(Base)
		.rule((r) => {
			const { doc, start } = v(Node, "root")
			return r.match(Node, { doc, start, parent: start, kind: 1 }).find({ doc, node: start })
		})
		.rule((r) => {
			const { doc, start } = v(Node, "root")
			return r.match(Node, { doc, start, parent: start, kind: 2 }).find({ doc, node: start })
		})
	return arms === 2
		? two
		: two.rule((r) => {
				const { doc, start } = v(Node, "root")
				return r.match(Node, { doc, start, parent: start, kind: 3 }).find({ doc, node: start })
			})
}

/** The case's schema: the walk from the roots, and a containment of every node of kind 0 in the roots and the walk. */
const schemaOf = (c: Roots): FixtureSchema => {
	const roots = rootsOf(c.arms)
	const walk = query(Base).recursive("Walk", {
		row: { doc: pg.integer, node: pg.integer },
		base: [
			(r) => {
				const { doc, node } = v(roots, "root")
				return r.match(roots, { doc, node }).find({ doc, node })
			}
		],
		rec: [
			(r, self) => {
				const { doc, node } = v(self, "at")
				const { start } = v(Node, "child")
				return r
					.match(self, { doc, node })
					.match(Node, { doc, parent: node, start })
					.where(r.ne(start, node))
					.find({ doc, node: start })
			}
		]
	})
	const Leaf = derived(
		"Leaf",
		query(Base).rule((r) => {
			const { doc, start } = v(Node, "n")
			return r.match(Node, { doc, start, kind: 0 }).find({ doc, node: start })
		})
	)
	const Reach = derived(
		"Reach",
		c.beside === "once"
			? query(Base)
					.rule((r) => {
						const { doc, node } = v(walk, "walked")
						return r.match(walk, { doc, node }).find({ doc, node })
					})
					.rule((r) => {
						const { doc, node } = v(roots, "root")
						return r.match(roots, { doc, node }).find({ doc, node })
					})
			: query(Base)
					.rule((r) => {
						const { doc, node } = v(walk, "walked")
						return r.match(walk, { doc, node }).find({ doc, node })
					})
					.rule((r) => {
						const { doc, node } = v(roots, "root")
						return r.match(roots, { doc, node }).find({ doc, node })
					})
					.rule((r) => {
						const { doc, node } = v(roots, "root")
						return r
							.match(roots, { doc, node })
							.match(Node, { doc, start: node, kind: 2 })
							.find({ doc, node })
					})
	)
	return schema.extend(
		[Base],
		"judge_units_1",
		[Leaf, Reach],
		[contained(on(Leaf, "doc", "node"), on(Reach, "doc", "node"))]
	)
}

/** Whether a statement's FROM sources name a stored table, one outside the session's own schema, at any depth. */
const readsStored = (query: OperandSelect): boolean => {
	let stored = false
	const source = (s: FromSource): void => {
		if (
			(s.kind === "table" || s.kind === "probe") &&
			typeof s.table !== "string" &&
			s.table.schema !== "pg_temp"
		) {
			stored = true
		}
	}
	const item = (i: FromItem): void => {
		if (i.kind === "joins") {
			source(i.first)
			for (const step of i.steps) {
				source(step.source)
			}
			return
		}
		source(i)
	}
	visitSelect(query, { ...inertVisitor, fromItem: item })
	return stored
}

/** The CTEs of a statement's own WITH, the statement-wide ones, that read a stored table. */
const statementWide = (query: OperandSelect): ReadonlyArray<Cte> =>
	Arr.filter(query.with?.ctes ?? [], (cte) => cte.query.kind === "select" && readsStored(cte.query))

/** Every CTE of any WITH of a statement, at any depth. */
const everyCte = (query: OperandSelect): ReadonlyArray<Cte> => {
	const ctes: Array<Cte> = []
	visitSelect(query, {
		...inertVisitor,
		with: (w) => {
			for (const cte of w.ctes) {
				ctes.push(cte)
			}
		}
	})
	return ctes
}

/**
 * Judges case `c`: no statement of its whole rule reads a stored table through a CTE of its own WITH, one computed once
 * for the statement over every unit's rows; and one of them reads Node through a CTE of a WITH inside it, the roots its
 * readers each keep at the unit, computed once per unit.
 */
export const judgedOverUnits = (c: Roots, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(c))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const whole = new Set<string>(
		Arr.flatMap(installation.laws.rules, (rule) =>
			rule.rule.kind === "whole" ? [identifierOf(rule.named)] : []
		)
	)
	const statements = Arr.filter(judgedStatementsOf(installation), (s) =>
		Option.exists(raisedRule(s), (rule) => whole.has(rule))
	)
	assert.ok(statements.length > 0, `${Formatter.format(c)}: the rule is judged whole`)
	note(c.arms === 2 ? "roots of two rules" : "roots of three rules")
	note(c.beside === "once" ? "read again once" : "read again twice")
	for (const { query: statement } of statements) {
		assert.deepEqual(
			Arr.map(statementWide(statement), (cte) => cte.name),
			[],
			`${Formatter.format(c)}: a whole rule's statement reads no stored table through a CTE of its own WITH, which reads every unit's rows`
		)
	}
	assert.ok(
		Arr.some(statements, (s) =>
			Arr.some(everyCte(s.query), (cte) => cte.query.kind === "select" && readsStored(cte.query))
		),
		`${Formatter.format(c)}: the roots its readers keep at the unit are one CTE inside the statement, computed once per unit`
	)
}
