import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import type { Arrival, Sent } from "#compiler/lower/shapes/index.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import {
	planStatementShares,
	ShareIndex,
	statementCtes
} from "#compiler/lower/shapes/share/statements.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { asc, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
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
 * - an attachment of a parent is fed the rows of the first earlier attachment of that parent computing its sub-query,
 *   and every other is sent, the sent statements answering in the order the program holds them.
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
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
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
					box: { kind: "unstated" },
					oracle: { kind: "unstated" },
					suite: "unit/lower/shapes/share-statements/ctes",
					literal: Formatter.format,
					generator: int(1, 4),
					limit: 4,
					coverage: requiredInSpace<"shared" | "inline">(["shared", "inline"]),
					caseHang
				},
				(reads, c) =>
					Effect.gen(function* () {
						const { built, copies } = repeated(reads)
						const ctes = statementCtes(new ShareIndex(built.dag), built.dag.roots[0], () => false)
						const expected =
							reads > 1 ? [succeeded(shareKey(built.dag, present(copies[0], "a copy")))] : []
						yield* agree(
							[
								["the share keys the statement computes once", [...new Set(ctes.values())]],
								["the copies' share key", expected]
							],
							set(structuralHash, exact)
						)
						unorderedEqual([...ctes.keys()], reads > 1 ? Arr.map(copies, (copy) => copy.id) : [])
						c.note(reads > 1 ? "shared" : "inline")
					})
			)
		)
	)
})

/**
 * Attachments of one parent over five fields each, so none is fused, each its jobs unfiltered, those past a least `a`,
 * or those below a most `b`: two attachments of one filter compute one sub-query, under one parameter.
 */
const Account = relation("Account", { id: pg.bigint, region: pg.integer }, ["id"])
const Job = relation(
	"Job",
	{ id: pg.bigint, account: pg.bigint, a: pg.integer, b: pg.integer, c: pg.integer, d: pg.integer },
	["id"]
)
const Jobs = schema("Jobs", { Account, Job }, [])

/** The accounts of a region a parameter names. */
const accounts = queryOver(Jobs).rule((r: RuleValue) => {
	const { id, region } = varsOver(Account, "account")
	return r
		.match(Account, { id, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ id })
})

/** The accounts with one attachment per filter of `filters` (0 none, 1 a least `a`, 2 a most `b`), in order. */
const attachedJobs = (filters: ReadonlyArray<number>): QueryValue =>
	Arr.reduce(filters, accounts, (q, filter, i) =>
		q.attach(
			`jobs${i}`,
			(p: Readonly<Record<string, unknown>>) =>
				queryOver(Jobs).rule((r: RuleValue) => {
					const { id, a, b, c, d } = varsOver(Job, "job")
					const jobs = r.match(Job, { id, account: p["id"], a, b, c, d })
					return filter === 0
						? jobs.find({ id, a, b, c, d })
						: filter === 1
							? jobs.where(r.gt(a, r.param("least", pg.integer))).find({ id, a, b, c, d })
							: jobs.where(r.lt(b, r.param("most", pg.integer))).find({ id, a, b, c, d })
				}),
			"array"
		)
	)

/**
 * The fixed rule as the oracle: the parent's statement is sent first; each attachment, in the order the program holds
 * them, is fed the rows of the first earlier attachment of its filter, and is sent otherwise, the sent statements
 * answering in that order.
 */
const expectedArrivals = (filters: ReadonlyArray<number>): ReadonlyArray<Arrival> => {
	const arrivals: Array<Arrival> = [{ kind: "sent", answer: 0 }]
	const firstOf = new Map<number, Sent>()
	for (const filter of filters) {
		const feeder = firstOf.get(filter)
		if (feeder === undefined) {
			const sent: Sent = { kind: "sent", answer: firstOf.size + 1 }
			firstOf.set(filter, sent)
			arrivals.push(sent)
		} else {
			arrivals.push({ kind: "fed", feeder })
		}
	}
	return arrivals
}

describe("attachment statements fed from an earlier one", () => {
	it.effect(
		"feed a later attachment from the first earlier one computing its sub-query, and send every other",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/lower/shapes/share-statements/feeds",
						literal: Formatter.format,
						/** One to three attachments, each of one of the three filters. */
						generator: (source) => {
							const count = source.draw(int(1, 3))
							return upTo(count, () => source.draw(int(0, 2)))
						},
						limit: 39,
						coverage: requiredInSpace<"fed" | "sent">(["fed", "sent"]),
						caseHang
					},
					(filters, c) =>
						Effect.sync(() => {
							const optimized = succeeded(compileTemplate(attachedJobs(filters), Jobs, testCompile))
								.programs.optimized
							const [main] = optimized.roots
							const filterOf = new Map<string, number>(
								Arr.map(filters, (filter, i) => [`jobs${i}`, filter])
							)
							assert.equal(main.attachments.length, filters.length)
							const arrivals: ReadonlyArray<Arrival> = [
								main.statement.arrival,
								...Arr.map(main.attachments, (a) => a.statement.arrival)
							]
							assert.deepEqual(
								arrivals,
								expectedArrivals(
									Arr.map(main.attachments, (a) =>
										present(filterOf.get(a.attach.name), `the filter of ${a.attach.name}`)
									)
								)
							)
							for (const arrival of Arr.drop(arrivals, 1)) {
								c.note(arrival.kind)
							}
						})
				)
			)
	)
})
