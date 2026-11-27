/** What take-probe.test.ts reads: its schema, its reads and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import { outline } from "#bench/query/support/plans.ts"
import { identity } from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { planAsRun } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { BudgetedCluster } from "#test/support/substrate/budget.ts"
import { countedAsVacuumed } from "#test/support/substrate/fill.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"

const i = pg.integer

/** Parents, and each parent's children, keyed by the parent and the child's id, each with a score. */
const Parent = relation("Parent", { id: i }, ["id"])
const Child = relation("Child", { parent: i, id: i, score: i }, ["parent", "id"])
const Probes = schema("TakeProbe", [Parent, Child], [])

/** A take's k: one, or a few. */
export type TakeK = 1 | 3

const takeKs = [1, 3] as const satisfies ReadonlyArray<TakeK>

/** A parent's k best children by score, ties broken by id: the take each read takes per parent. */
const best = (k: TakeK) =>
	query(Probes)
		.rule((r) => {
			const { id, score } = v(Child, "child")
			return r
				.match(Child, { parent: r.param("parent", Child.fields.parent), id, score })
				.find({ id, score })
		})
		.orderBy(["score", "desc"], ["id", "asc"])
		.take(k)

/** The parents up to a parameter, each with its k best children attached. */
const attached = (k: TakeK) =>
	query(Probes)
		.rule((r) => {
			const { id } = v(Parent, "parent")
			return r
				.match(Parent, { id })
				.where(r.le(id, r.param("upto", i)))
				.find({ id })
		})
		.attach(
			"best",
			(head) =>
				query(Probes)
					.rule((r) => {
						const { id, score } = v(Child, "child")
						return r.match(Child, { parent: head.id, id, score }).find({ id, score })
					})
					.orderBy(["score", "desc"], ["id", "asc"])
					.take(k),
			"array"
		)

/** A relation parameter's parents, each with its k best children, the take correlated through `bind`. */
const bound = (k: TakeK) =>
	query(Probes).rule((r) => {
		const wanted = r.relation("parents", { id: i })
		const { id: parent } = v(wanted, "wanted")
		const top = best(k).bind({ parent })
		const { id, score } = v(top, "top")
		return r.match(wanted, { id: parent }).match(top, { id, score }).find({ parent, id, score })
	})

/** How a read reaches its take: as an attachment's child, or bound to a relation parameter's facts. */
export type Form = "an attachment's child" | "bound to a relation parameter's facts"

const forms = [
	"an attachment's child",
	"bound to a relation parameter's facts"
] as const satisfies ReadonlyArray<Form>

const reads = {
	attached1: attached(1),
	attached3: attached(3),
	bound1: bound(1),
	bound3: bound(3)
} as const

/** The read of a form at a k. */
const readOf = (form: Form, k: TakeK) =>
	form === "an attachment's child"
		? k === 1
			? reads.attached1
			: reads.attached3
		: k === 1
			? reads.bound1
			: reads.bound3

/** The schema installed through its first migration, with a reader whose workload's indexes the reads earn. */
export const takeProbeTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "take probe",
	fixture: Probes,
	programs: reads,
	label: "take_probe",
	ambient: ordinarySession
})

/**
 * A case: the read's form and k; `parents` parents read, beside `others` no read reaches, each parent with `children`
 * children, more than k, so a probe that read a parent's every child would read more than its k. The parents number
 * more than a heap page holds children (a page of 8 kB holds about 185), so each child of a parent stands on a page of
 * its own, and a row read is a page read.
 */
export interface ProbeCase {
	readonly form: Form
	readonly k: TakeK
	readonly parents: number
	readonly others: number
	readonly children: number
}

export const probeGen: Gen<ProbeCase> = (s) => {
	const k = s.draw(element<TakeK>(takeKs))
	return {
		form: s.draw(element<Form>(forms)),
		k,
		parents: s.draw(int(1, 40)),
		others: s.draw(int(300, 600)),
		children: s.draw(int(k + 2, 24))
	}
}

export type ProbeFeature = Form | "k = 1" | "k = 3" | "one parent" | "several parents"

/**
 * The statements storing the case: every parent, the read ones first, and the children, every parent's first child,
 * then every parent's second, so no two children of a parent share a heap page; then each table counted as a VACUUM
 * counts it.
 */
const stored = (installed: Installed, c: ProbeCase): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const all = String(c.parents + c.others)
	return [
		`INSERT INTO ${names.table(Parent)} (id) SELECT p FROM generate_series(1, ${all}) AS g(p)`,
		`INSERT INTO ${names.table(Child)} (parent, id, score) SELECT p, q, (pg_catalog.hashint4(p * 1000 + q) & 1023) ` +
			`FROM generate_series(1, ${String(c.children)}) AS h(q), generate_series(1, ${all}) AS g(p) ORDER BY q, p`,
		...Arr.map([Parent, Child], (t) => countedAsVacuumed(names.table(t)))
	]
}

/** What a scan read itself, beyond its children: its shared buffers, hit or read. */
const ownPages = (n: PlanNode): number =>
	n.buffers.sharedHit +
	n.buffers.sharedRead -
	Arr.reduce(n.children, 0, (sum, c) => sum + c.buffers.sharedHit + c.buffers.sharedRead)

/**
 * One case in its one transaction, which the case's end rolls back: the parents and their children stored, the read
 * run under EXPLAIN (ANALYZE, BUFFERS), and the pages its scans of the children read counted against n × (h + k + 1),
 * n the parents read, h the height of the index the probes descend (pageinspect bt_metap: the root's level, plus one,
 * read as it stands on the case's clone by the cluster's bootstrap superuser, the one role pageinspect admits, its
 * pages physical, so the case's uncommitted rows' splits count), k the take: each parent's probe descends the index
 * once, its h pages ending at the leaf of its first entry; its k entries, contiguous in the index and fewer than a leaf
 * holds, reach at most one leaf more; and its k rows stand on k heap pages, whatever the relation's size.
 */
export const runTakeProbe = (
	installed: Installed,
	clone: {
		readonly connection: PgConnection
		readonly cluster: BudgetedCluster
		readonly database: string
	},
	c: ProbeCase,
	k: Case<ProbeFeature>
) =>
	Effect.gen(function* () {
		const connection = clone.connection
		for (const sql of stored(installed, c)) {
			yield* connection.query(sql, [])
		}
		const read = readOf(c.form, c.k)
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(compileTemplate(read, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		/** The parents read: the first `parents` ids, or every other id of the first twice as many. */
		const params = paramTexts(
			statement,
			c.form === "an attachment's child"
				? { upto: c.parents }
				: { parents: Array.from({ length: c.parents }, (_, n) => ({ id: 2 * n + 1 })) },
			declaredOf(template, read, undefined, options)
		)
		const plan = yield* planAsRun(connection.queryValues, statement.sql, params)
		const quoted = namesOf(installed).table(Child)
		const child = regex('\\."([^"]+)"$').exec(quoted)?.[1]
		const scans = Iterator.from(planNodes(plan))
			.filter((n) => Option.getOrUndefined(n.relation) === child)
			.toArray()
		const schemaName = parsedSchemaName(installed.declared)
		const indexes = [...new Set(Arr.flatMap(scans, (n) => Option.toArray(n.index)))]
		const heights = yield* Effect.scoped(
			Effect.gen(function* () {
				const superuser = yield* superuserClient(
					clone.cluster,
					clone.database,
					"take probe heights"
				)
				yield* superuser.query("CREATE EXTENSION IF NOT EXISTS pageinspect", [])
				/** The schema pageinspect is installed in, which no search path need hold. */
				const inspect = String(
					(yield* superuser.query(
						"SELECT n.nspname::text FROM pg_catalog.pg_extension AS e JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace WHERE e.extname = 'pageinspect'",
						[]
					))[0]?.[0]
				)
				return yield* Effect.forEach(indexes, (index) =>
					Effect.map(
						superuser.query(
							`SELECT (level + 1)::text FROM ${quoteIdent(inspect)}.bt_metap(${quoteString(`${quoteIdent(schemaName)}.${quoteIdent(index)}`)})`,
							[]
						),
						(rows) => Number(rows[0]?.[0])
					)
				)
			})
		)
		const height = Arr.reduce(heights, 0, (most, h) => Math.max(most, h))
		const pages = Arr.reduce(scans, 0, (sum, n) => sum + ownPages(n))
		const bound = c.parents * (height + c.k + 1)
		assert.ok(
			scans.length > 0 && indexes.length > 0 && pages <= bound,
			`${Formatter.format(c)}: the read's scans of the children read ${String(pages)} pages, past n × (h + k + 1) = ${String(c.parents)} × (${String(height)} + ${String(c.k)} + 1) = ${String(bound)}\n${statement.sql}\n${outline(plan, 0)}`
		)
		k.note(c.form)
		k.note(c.k === 1 ? "k = 1" : "k = 3")
		k.note(c.parents === 1 ? "one parent" : "several parents")
	})
