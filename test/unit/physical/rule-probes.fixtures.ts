/** What the properties of rule-probes.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { probe, probeKey, probeRows } from "#compiler/analysis/theory/query.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { Num, Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
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

export type Reached = "a probe of several rows" | "a probe whose rows outnumber its arms"

/**
 * The schema of a shape: T, U and S on a base level, D over them and S's containment in it above. D's head computes its
 * k from T's, so no field of it delivers the unit its arms read within, and the installation keeps it live
 * (analysis/derived/storage.ts, `hidden`): the containment into it reads its definition, whose probes the test reads.
 */
const schemaOf = (shape: Shape) => {
	const T = relation("T", { k: pg.integer, a: pg.integer }, ["k"])
	const U = relation("U", { k: pg.integer }, ["k"])
	const S = relation("S", { j: pg.integer }, ["j"])
	/** Mutable, T and U inside the unit of their key and S inside the unit of its own, so the containment over them reads
	 * the rows of two units, two borrows, and is no whole rule but a probed one, whose probes the test reads. */
	const Base = schema(
		"rule_probes",
		[T, U, S],
		[
			unit("Ks", { k: pg.integer }),
			unit("Js", { j: pg.integer }),
			mutable(T),
			mutable(U),
			mutable(S)
		]
	)
	const first = query(Base).rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 1 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({
			k: Type.cast(Num.add(k, 0), pg.integer)
		})
	})
	const second = first.rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 2 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({
			k: Type.cast(Num.add(k, 0), pg.integer)
		})
	})
	const third = second.rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 3 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({
			k: Type.cast(Num.add(k, 0), pg.integer)
		})
	})
	const D = derived("D", shape.arms === 1 ? first : shape.arms === 2 ? second : third)
	return schema.extend([Base], "rule_probes_1", [D], [contained(on(S, "j"), on(D, "k"))])
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

/** The arms of a probe's rows: its meeting part's one match, the union of its rows, or the probe's one row itself. */
const rowArmsOf = (q: InferredQuery): number => {
	const stage = q.stage
	const first = stage.kind === "rules" ? stage.arms[0].matches[0] : undefined
	return first?.source.kind === "query" && first.source.query.stage.kind === "rules"
		? first.source.query.stage.arms.length
		: 1
}

/** Judges the judge of `shape`'s installation and the probe of each removed side. */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const built = schemaOf(shape)
	const owned = owning(built)
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const laws = succeeded(testArtifacts(built, testCompile)).laws
	const containments = laws.theory.regionFacts.containments
	for (const rule of laws.rules) {
		for (const table of rule.tables) {
			if (table.touches.kind === "added") {
				continue
			}
			const probed = probedRule(rule.rule)
			const rows = probeRows(probed, table.relation.name, "removed", containments, rule.law.loc)
			const read = probe(probed, table.relation.name, "removed", containments, rule.law.loc)
			const distinct = new Set(Arr.map(rows, probeKey)).size
			assert.equal(
				read === undefined ? 0 : rowArmsOf(read),
				distinct,
				`the probe of ${table.relation.name}'s removed rows reads each of its ${rows.length} rows once, one arm of each key`
			)
			if (distinct >= 2) {
				note("a probe of several rows")
			}
			if (rows.length > distinct) {
				note("a probe whose rows outnumber its arms")
			}
		}
	}
	for (const block of blocksOf(judgeBodiesOf(installation))) {
		assert.ok(
			block.statements.length <= 1,
			"the judge: one probe statement in each guarded block, none in a tamper check's"
		)
	}
}
