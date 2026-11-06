import { describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { claimOf, queueSchema } from "#bench/queue/support/queue.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { isSetQuery } from "#compiler/sql/ast.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A carrier a write program fills holds a set (write/carriers memberRows), as every INSERT source does: a described
 * member's rows are read keyed where the member's lowering is a set and every cast into the carrier keeps its value,
 * and through SELECT DISTINCT otherwise. The write's duplicate-elimination placement leaves a member's root plain for
 * its consumer to bound, so the fill is that consumer: the work queue's claim carries its pick, a set, and fills a
 * second carrier with a projection of the carried pick, which the placement leaves plain; and a member read at a
 * numeric of a wider typmod than its relation's rounds onto it, so two of its rows may become one, which the same
 * member at the relation's own type cannot.
 */

/** A pure set of a numeric, the key its whole fact. */
const R = relation("R", { id: uuid, a: pg.numeric(10, 2) }, ["id", "a"])
const Narrow = schema("Narrow", { R }, [])

/** R's facts given in the relation parameter `given`, its `a` at `type`. */
const givenAt = (type: ReturnType<typeof pg.numeric>) =>
	query(Narrow).rule((r) => {
		const given = r.relation("given", { id: uuid, a: type })
		const { id, a } = v(R, "r")
		return r.match(given, { id, a }).find({ id, a })
	})

/** The stored fact of R a parameter keys, removed beside the addition, so the given rows travel in a carrier. */
const storedOne = query(Narrow).rule((r) => {
	const { id, a } = v(R, "r")
	return r
		.match(R, { id, a })
		.where(r.eq(id, r.param("id", uuid)))
		.find({ id, a })
})

/** How each carrier a program fills is filled, in program order: keyed, or bounded by SELECT DISTINCT. */
const fillsOf = (schemaValue: unknown, value: unknown): ReadonlyArray<"keyed" | "distinct"> => {
	const program = succeeded(
		compileWrite(
			checking(schemaValue),
			descOf(value),
			realityWrite(succeeded(testArtifacts(schemaValue, testCompile)))
		)
	)
	return Arr.flatMap(program.artifacts.optimized.statements, (s) => {
		if (s.step.kind !== "carrier" || s.step.step !== "fill") {
			return []
		}
		const ast = s.ast
		if (ast.kind !== "insert" || ast.source.kind !== "query") {
			return assert.fail("a carrier is filled by INSERT ... SELECT")
		}
		const source = ast.source.query
		assert.ok(isSetQuery(source), "a carrier's fill is a set")
		const body = source.body
		if (body.kind !== "core") {
			return assert.fail("a member's fill is one core over the member's rows")
		}
		return [body.distinct === false ? ("keyed" as const) : ("distinct" as const)]
	})
}

describe("a carrier's fill", () => {
	it("holds a set: keyed over a member that is one under casts that keep its values, bounded by DISTINCT otherwise", () => {
		const Queue = queueSchema("Queue")
		assert.deepEqual(
			fillsOf(Queue, claimOf(Queue)),
			["keyed", "distinct"],
			"the claim's pick is a set, and the projection of it that the placement leaves plain is bounded"
		)
		const removeAndGive = (type: ReturnType<typeof pg.numeric>) =>
			ChangeSet.empty(Narrow).delete(R, storedOne).insert(R, givenAt(type))
		assert.deepEqual(
			fillsOf(Narrow, removeAndGive(pg.numeric(10, 2))),
			["keyed"],
			"a member at its relation's own type keeps every value"
		)
		assert.deepEqual(
			fillsOf(Narrow, removeAndGive(pg.numeric(12, 4))),
			["distinct"],
			"a member cast onto a narrower numeric may round two rows onto one"
		)
	})
})
