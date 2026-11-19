/** What the properties of rule-probes.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { probes as probesOf } from "#compiler/analysis/theory/query.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { judgeBodiesOf, judgedStatementsIn, plannedQueryOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"
import { probedRule } from "#test/support/probed.ts"

/** One case: D's arms, whether each holds T's a to a literal of its own, and whether each joins U by k. */
interface Shape {
	readonly arms: 1 | 2 | 3
	readonly literal: boolean
	readonly joined: boolean
}

export const shapeGen: Gen<Shape> = (s) => ({
	arms: s.draw(element<Shape["arms"]>([1, 2, 3])),
	literal: s.draw(boolean),
	joined: s.draw(boolean)
})

export type Reached = "a block whose probes outnumber its statements" | "a block of two statements"

/** The schema of a shape: T, U and S on a base level, D over them and S's containment in it above. */
const schemaOf = (shape: Shape) => {
	const T = relation("T", { k: pg.integer, a: pg.integer }, ["k"])
	const U = relation("U", { k: pg.integer }, ["k"])
	const S = relation("S", { k: pg.integer }, ["k"])
	/** Mutable, so the containment over them is no unit-local rule but a probed one, whose probes the test reads. */
	const Base = schema("rule_probes", [T, U, S], [mutable(T), mutable(U), mutable(S)])
	const first = query(Base).rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 1 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({ k })
	})
	const second = first.rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 2 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({ k })
	})
	const third = second.rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 3 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({ k })
	})
	const D = derived("D", shape.arms === 1 ? first : shape.arms === 2 ? second : third)
	return schema.extend(Base, "rule_probes_1", [D], [contained(on(S, "k"), on(D, "k"))])
}

/** A guarded block of the judge: whether it reads a delta of removed rows, the one a DELETE or an UPDATE fills, and its
 * probe statements, each printed as PostgreSQL reads it. */
interface Block {
	readonly olds: boolean
	readonly statements: ReadonlyArray<string>
}

/** The guarded blocks of the judge's body: each IF's branches, a tamper check's holding no probe statement. */
const blocksOf = (body: ReadonlyArray<PlStatement>): ReadonlyArray<Block> =>
	Arr.flatMap(body, (s) =>
		s.kind === "if"
			? Arr.map(s.branches, (b): Block => ({
					olds: Str.includes("__delta_olds_")(printExpr(b.condition)),
					statements: Arr.map(judgedStatementsIn(b.body), plannedQueryOf)
				}))
			: []
	)

/** Judges the judge of `shape`'s installation. */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const built = schemaOf(shape)
	const owned = owning(built)
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	/** The probes of the removed side of every rule trigger's table, each occurrence of the touched relation one. */
	const probes = Arr.reduce(succeeded(testArtifacts(built, testCompile)).laws.rules, 0, (n, rule) =>
		Arr.reduce(rule.tables, n, (m, table) =>
			table.touches.kind === "added"
				? m
				: m + probesOf(probedRule(rule.rule), table.relation.name, "removed", rule.law.loc).length
		)
	)
	let statements = 0
	for (const block of blocksOf(judgeBodiesOf(installation))) {
		assert.equal(
			new Set(block.statements).size,
			block.statements.length,
			"the judge: each probe statement once in its guarded block"
		)
		if (block.statements.length >= 2) {
			note("a block of two statements")
		}
		if (block.olds) {
			statements += block.statements.length
		}
	}
	if (probes > statements) {
		note("a block whose probes outnumber its statements")
	}
}
