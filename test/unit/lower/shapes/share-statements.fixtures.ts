/** What the properties of share-statements.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { boolean, element, finite, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { withoutSourceLocs } from "#compiler/core/canonical.ts"
import { functionDigest } from "#compiler/core/fingerprint.ts"
import { type FunctionVolatility, functionVolatilities } from "#compiler/core/function.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { heading } from "#test/support/unit/ir/fixture.ts"
import { asc, Q, T, Task } from "#test/support/unit/lower/conservative/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"

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
 * What a statement's repeated sub-query is: the union of two projections of tasks, an unbounded sub-query, which the CTE
 * policy shares by its reads; a closed relation, whose rows are constants; or a step of a navigation over the tasks,
 * which every lowering reads apart (cte-policy readWhole for the last two).
 */
export type Repeated = "union" | "closed" | "step"

/** Each repeated sub-query by the reads of it, one to four. */
export const repeatedGen: Gen<readonly [Repeated, number]> = element<readonly [Repeated, number]>(
	Arr.flatMap(["union", "closed", "step"] as const, (subject) =>
		Arr.map([1, 2, 3, 4] as const, (reads) => [subject, reads] as const)
	)
)

/** A statement reading r copies of `subject`, each the highest node the copies share. */
export const repeated = (subject: Repeated, reads: number) => {
	const q = new Q()
	const copy = (): RelNode => {
		switch (subject) {
			case "union":
				return q.project(
					q.union(
						[
							q.project(
								q.region([
									{ source: q.base(Task, conservativeMeta), bind: { id: "id" }, constants: {} }
								]),
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
					),
					[["id", "id"]],
					conservativeMeta
				)
			case "closed":
				return q.closed(
					"Kind",
					[{ name: "id", type: T.kind }],
					[[{ kind: "handle", handle: "Automatic" }], [{ kind: "handle", handle: "Manual" }]]
				)
			case "step": {
				const tasks = q.region([
					{ source: q.base(Task, conservativeMeta), bind: { id: "id" }, constants: {} }
				])
				return q.node({
					kind: "Step",
					input: tasks,
					heading: tasks.heading,
					loc: undefined,
					meta: conservativeMeta
				})
			}
		}
	}
	const copies = Array.from({ length: reads }, copy)
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

/**
 * A program of several statements over a chain of shared sub-queries, for the planning's rounds: level 0 bounds one
 * account's tasks to their first id, as `first` does, and each level above is the union of a copy of the level below
 * and a bound of its own, so a copy of a level holds a copy of every level under it. Statement `i` reads, under its
 * own name, one fresh copy of each level `reads[i]` names: a level two statements read is carried, the highest first,
 * and a level read only inside a carried one is then read by the carrier's fill alone.
 */
export const chained = (reads: ReadonlyArray<ReadonlyArray<0 | 1 | 2>>) => {
	const q = new Q()
	const bound = (level: number) => {
		const m = q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { id: "id", account: "account" },
				constants: { account: q.param(`a${level}`, T.uuid, "compare") }
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
	const level = (l: 0 | 1 | 2): RelNode =>
		l === 0
			? bound(0)
			: q.union(
					[
						q.project(level(l === 2 ? 1 : 0), [["id", "id"]], conservativeMeta),
						q.project(bound(l), [["id", "id"]], conservativeMeta)
					],
					[]
				)
	const roots = Arr.map(reads, (levels, i) =>
		q.project(
			q.union(
				Arr.map(levels, (l) => q.project(level(l), [["id", "id"]], conservativeMeta)),
				[]
			),
			[[`id${i}`, "id"]],
			conservativeMeta
		)
	)
	const built = q.build(
		q.union(
			Arr.map(roots, (root, i) => q.project(root, [["id", `id${i}`]], conservativeMeta)),
			[]
		)
	)
	return { dag: built.dag, roots }
}

/** Two to four statements, each reading one to three of the chain's levels. */
export const chainedGen: Gen<ReadonlyArray<ReadonlyArray<0 | 1 | 2>>> = (s) =>
	Arr.map(indices(s.draw(int(2, 4))), () => {
		const levels = Arr.filter([0, 1, 2] as const, () => s.draw(int(0, 1)) === 1)
		return levels.length === 0 ? ([0] as const) : levels
	})

/**
 * Two reads of the rows of a declared function `drawn` of volatility `volatility` at one parameter (Fn.rows), each an
 * expensive closed node the share planning may key: two calls built alike, or one call read twice (`twice`). Statement
 * `i` reads read `i` under its own name; the program's one root reads both, so as one statement it reads the call or
 * calls twice.
 */
export const drawnCalls = (volatility: FunctionVolatility, twice: boolean) => {
	const q = new Q()
	const call = () =>
		q.node({
			kind: "Call",
			function: {
				kind: "declared",
				name: "drawn",
				volatility,
				definition: functionDigest(`drawn ${volatility}`, withoutSourceLocs)
			},
			args: [{ kind: "value", name: "n", expr: q.param("n", T.int8, "compare"), type: T.int8 }],
			heading: heading(["id", T.uuid]),
			loc: undefined,
			meta: conservativeMeta
		})
	const first = call()
	const reads = [first, twice ? first : call()] as const
	const roots = Arr.map(reads, (read, i) => q.project(read, [[`id${i}`, "id"]], conservativeMeta))
	const built = q.build(
		q.union(
			Arr.map(roots, (root, i) => q.project(root, [["id", `id${i}`]], conservativeMeta)),
			[]
		)
	)
	return { dag: built.dag, root: built.dag.roots[0], roots, calls: [...new Set(reads)] }
}

/** A function's volatility, and whether its rows are read by two calls or by one call twice. */
export const drawnCallsGen = finite((source) => ({
	volatility: source.draw(element(functionVolatilities)),
	twice: source.draw(boolean)
}))
