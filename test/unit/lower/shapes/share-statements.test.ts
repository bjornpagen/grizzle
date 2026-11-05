import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import {
	planStatementShares,
	ShareIndex,
	statementCtes
} from "#compiler/lower/shapes/share/statements.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { asc, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * Sub-queries shared by the statements of one program and repeated inside one statement (shapes/share/statements.ts):
 * the carried sub-queries of a stratum's statements, the MATERIALIZED CTEs of one statement, and the attachment
 * statements a delivered program feeds from an earlier one. The first two rules are exhausted over the number of
 * copies:
 *
 * - n statements each reading `pick` carry it once, its every copy read through the carrier, exactly when n is more
 *   than one; the highest shared sub-query is chosen, so `first`, which pick reads, is never carried beside it;
 * - a statement reading r copies of an unbounded union computes it once as a CTE exactly when r is more than one;
 * - two attachments of one parent over the same sub-query are computed once, the later fed from the earlier; over
 *   different sub-queries each is sent.
 */

/**
 * The work queue's shape in miniature: `first` bounds a projection of one account's tasks to its first id, `pick` is a
 * union of two projections each over its own import of `first`, and each statement imports `pick` again.
 */
const program = (statements: number) => {
	const q = new Q()
	const first = () => {
		const m = q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { id: "id", account: "account" },
				constants: { account: q.param("a", T.uuid, "compare") }
			}
		])
		return q.take(
			q.project(m, [["id", "id"]], conservativeMeta),
			asc("id"),
			{ kind: "literal", k: 1n },
			[],
			conservativeMeta
		)
	}
	const arms: Array<RelNode> = []
	const pick = () => {
		const [x, y] = [
			q.project(first(), [["id", "id"]], conservativeMeta),
			q.project(first(), [["id", "id"]], conservativeMeta)
		]
		arms.push(x, y)
		return q.union([x, y], [])
	}
	const picks: Array<RelNode> = []
	/** Each statement reads `pick` under its own name, so the statements themselves differ. */
	const roots = Arr.map(indices(statements), (i) => {
		const p = pick()
		picks.push(p)
		return q.project(p, [[`id${i}`, "id"]], conservativeMeta)
	})
	const built = q.build(
		q.union(
			Arr.map(roots, (root, i) => q.project(root, [["id", `id${i}`]], conservativeMeta)),
			[]
		)
	)
	return { dag: built.dag, roots, picks, arms }
}

/**
 * A statement reading r copies of the union of two projections of tasks: an unbounded sub-query, which the CTE policy
 * shares only by its reads.
 */
const repeated = (reads: number) => {
	const q = new Q()
	const all = () =>
		q.union(
			[
				q.project(
					q.region([{ source: q.base(Task, conservativeMeta), bind: { id: "id" }, constants: {} }]),
					[["id", "id"]],
					conservativeMeta
				),
				q.project(
					q.region([
						{
							source: q.base(Task, conservativeMeta),
							bind: { id: "id", account: "account" },
							constants: {}
						}
					]),
					[["id", "id"]],
					conservativeMeta
				)
			],
			[]
		)
	/** Each read is a projection of its own copy: the highest node the copies share. */
	const copies = Array.from({ length: reads }, () =>
		q.project(all(), [["id", "id"]], conservativeMeta)
	)
	const built = q.build(q.union(copies, []))
	return { built, copies }
}

describe("sub-queries carried across a stratum's statements", () => {
	it.effect(
		"carry pick once, every copy through the carrier, exactly when enough statements read it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/shapes/share-statements/carried",
						literal: Formatter.format,
						generator: int(1, 4),
						limit: 4,
						coverage: requiredInSpace<"carried" | "inline">(["carried", "inline"]),
						caseHang
					},
					(statements, c) =>
						Effect.sync(() => {
							const p = program(statements)
							const shares = succeeded(planStatementShares(new ShareIndex(p.dag), p.roots))
							if (statements < 2) {
								assert.deepEqual(shares, [])
								c.note("inline")
								return
							}
							const [pick] = p.picks
							assert.equal(shares.length, 1)
							const share = present(shares[0], "the carried share")
							assert.equal(share.key, succeeded(shareKey(p.dag, present(pick, "a pick"))))
							unorderedEqual([...share.copies], p.picks)
							c.note("carried")
						})
				)
			)
	)
})

describe("sub-queries repeated inside one statement", () => {
	it.effect("compute an unbounded sub-query once exactly when it is read more than once", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/shapes/share-statements/ctes",
					literal: Formatter.format,
					generator: int(1, 4),
					limit: 4,
					coverage: requiredInSpace<"shared" | "inline">(["shared", "inline"]),
					caseHang
				},
				(reads, c) =>
					Effect.sync(() => {
						const { built, copies } = repeated(reads)
						const ctes = statementCtes(new ShareIndex(built.dag), built.dag.roots[0], () => false)
						const expected =
							reads > 1 ? [succeeded(shareKey(built.dag, present(copies[0], "a copy")))] : []
						assert.deepEqual([...ctes], expected)
						c.note(reads > 1 ? "shared" : "inline")
					})
			)
		)
	)
})

/**
 * Two attachments of one parent over five fields each, so neither is fused: the same sub-query twice, or the second
 * filtered by another parameter.
 */
const Account = relation("Account", { id: pg.bigint, region: pg.integer }, ["id"])
const Job = relation(
	"Job",
	{ id: pg.bigint, account: pg.bigint, a: pg.integer, b: pg.integer, c: pg.integer, d: pg.integer },
	["id"]
)
const Jobs = schema("Jobs", { Account, Job }, [])

const accounts = query(Jobs).rule((r) => {
	const { id, region } = v(Account, "account")
	return r
		.match(Account, { id, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ id })
})
type Second = "the same sub-query" | "a different sub-query"

const twice = (second: Second) =>
	accounts
		.attach(
			"jobs",
			(p) =>
				query(Jobs).rule((r) => {
					const { id, a, b, c, d } = v(Job, "job")
					return r.match(Job, { id, account: p.id, a, b, c, d }).find({ id, a, b, c, d })
				}),
			"array"
		)
		.attach(
			"again",
			(p) =>
				query(Jobs).rule((r) => {
					const { id, a, b, c, d } = v(Job, "job")
					const jobs = r.match(Job, { id, account: p.id, a, b, c, d })
					return second === "the same sub-query"
						? jobs.find({ id, a, b, c, d })
						: jobs.where(r.gt(a, r.param("least", pg.integer))).find({ id, a, b, c, d })
				}),
			"array"
		)

describe("attachment statements fed from an earlier one", () => {
	it.effect(
		"feed the later attachment from the earlier exactly when both compute one sub-query and two reads share",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/shapes/share-statements/feeds",
						literal: Formatter.format,
						generator: element<Second>(["the same sub-query", "a different sub-query"]),
						limit: 2,
						coverage: requiredInSpace<"fed" | "sent">(["fed", "sent"]),
						caseHang
					},
					(second, c) =>
						Effect.sync(() => {
							const optimized = succeeded(compileTemplate(twice(second), Jobs, testCompile))
								.programs.optimized
							const roles = Arr.map(flight(optimized.roots), (s) => s.role.kind)
							assert.deepEqual(roles, ["main", "attachment", "attachment"])
							const fed = second === "the same sub-query"
							assert.deepEqual(
								Arr.flatMap(flight(optimized.roots), (s, i) =>
									s.arrival.kind === "fed" ? [[i, s.arrival.feeder.answer]] : []
								),
								fed ? [[2, 1]] : []
							)
							c.note(fed ? "fed" : "sent")
						})
				)
			)
	)
})
