/** What the properties of share-statements.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { finite, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { upTo } from "#test/support/up-to.ts"
import { asc, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * The work queue's shape in miniature: `first` bounds a projection of one account's tasks to its first id, `pick` is a
 * union of two projections each over its own import of `first`, and each statement imports `pick` again.
 */
export const program = (statements: number) => {
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
export const repeated = (reads: number) => {
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

export const Jobs = schema("Jobs", [Account, Job], [])

/** The accounts of a region a parameter names. */
const accounts = queryOver(Jobs).rule((r: RuleValue) => {
	const { id, region } = varsOver(Account, "account")
	return r
		.match(Account, { id, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ id })
})

/** The accounts with one attachment per filter of `filters` (0 none, 1 a least `a`, 2 a most `b`), in order. */
export const attachedJobs = (filters: ReadonlyArray<number>): QueryValue =>
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
 * The fixed rule as the oracle: the parent's rows are the statement's first part; each attachment, in the order the
 * program holds them, is fed the rows of the first earlier attachment of its filter, and is a part of its own
 * otherwise, the parts in that order: each one's answer, the position of the rows it reads among the parts'.
 */
export const expectedAnswers = (filters: ReadonlyArray<number>): ReadonlyArray<number> => {
	const answers: Array<number> = [0]
	const firstOf = new Map<number, number>()
	for (const filter of filters) {
		const feeder = firstOf.get(filter)
		if (feeder === undefined) {
			const own = firstOf.size + 1
			firstOf.set(filter, own)
			answers.push(own)
		} else {
			answers.push(feeder)
		}
	}
	return answers
}

/** One to three attachments, each of one of the three filters. */
export const attachmentFilters = finite((source) => {
	const count = source.draw(int(1, 3))
	return upTo(count, () => source.draw(int(0, 2)))
})
