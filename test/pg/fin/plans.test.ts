/**
 * The reads of families and trees through grizzle's installed indexes, on PostgreSQL 19rc1 (fin.md §11, "Plan
 * audits", trees.md §3, §5): every ordered and tree read is an index or range scan of the index grizzle installs for it,
 * with no sort, no sequential scan and no recursion, and returns exactly the rows the parent links say it should.
 *
 * The reads, each over a planted, analyzed load and each planned custom and generic (R04):
 *
 * - **the export**, `WHERE doc = $1 ORDER BY start`: one scan of T1's UNIQUE (r, start), reading each row once;
 * - **descendants** of a row, `start > n.start AND start < n.end`: a range scan of T1 reading exactly them;
 * - **ancestors** of a row, `start <= n.start AND end > n.start`: a range scan of T1 up to the row, filtered by end;
 * - **an ordered family's members**, `WHERE g = $1 ORDER BY at`: a scan of the family key UNIQUE (g, at) reading exactly
 *   its members, whether the planner sorts them after a bitmap scan or reads them in order.
 *
 * - **Oracles:** EXPLAIN's plan shape (bench/harness/explain.ts), its index named by the installed catalog's role
 *   (installed.ts), never by an allocated name; and each read's rows against the tree's parent links
 *   (families/tree.ts descendantsOf, ancestorsOf) or the family as written, a second implementation that reads no
 *   interval.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import {
	explain,
	type ExplainOptions,
	explainServerStatement,
	findNodes,
	indexAccesses,
	type PlanMode,
	type PlanNode,
	rowsRead
} from "#bench/harness/explain.ts"
import { constraintOf as familyConstraintOf, familySeat } from "#test/pg/fin/family.ts"
import { type Catalogued, seatOf } from "#test/pg/fin/installed.ts"
import { nativesOf, nodeBatchParams, nodeBatchSql, RELATIONS, Trees } from "#test/pg/fin/tree.ts"
import { loadTree, type TreeRow } from "#test/pg/substrate/tree.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { ancestorsOf, descendantsOf } from "#test/support/families/tree.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The EXPLAIN options of a plan reading: no WAL, no SERIALIZE. */
const planned: ExplainOptions = { wal: false, serialize: { kind: "off" } }

/** The planted loads: one tree of 20,000 rows of fan-out up to four, and 200 owners of 100 ordered members each. */
const load = { tree: 20_000, fanout: 4, owners: 200, members: 100 } as const

/** A row whose reads a probe plans: the root's first child, a subtree under 100 rows, a leaf, and the deepest row. */
type Subject = "a quarter of the tree" | "a subtree under 100 rows" | "a leaf" | "the deepest row"

type Probe =
	| { readonly read: "the export"; readonly mode: PlanMode }
	| {
			readonly read: "descendants" | "ancestors"
			readonly subject: Subject
			readonly mode: PlanMode
	  }
	| { readonly read: "a family's members"; readonly mode: PlanMode }

type PlanFeature =
	| `${"the export" | "a family's members"}, ${PlanMode} plan`
	| `the ${"descendants" | "ancestors"} of ${Subject}, ${PlanMode} plan`

const probeName = (p: Probe): PlanFeature =>
	p.read === "descendants" || p.read === "ancestors"
		? `the ${p.read} of ${p.subject}, ${p.mode} plan`
		: `${p.read}, ${p.mode} plan`

const SUBJECTS: ReadonlyArray<Subject> = [
	"a quarter of the tree",
	"a subtree under 100 rows",
	"a leaf",
	"the deepest row"
]

const PROBES: Arr.NonEmptyReadonlyArray<Probe> = nonEmpty(
	Arr.flatMap(["custom", "generic"] as const, (mode): ReadonlyArray<Probe> => [
		{ read: "the export", mode },
		{ read: "a family's members", mode },
		...Arr.flatMap(SUBJECTS, (subject): ReadonlyArray<Probe> => [
			{ read: "descendants", subject, mode },
			{ read: "ancestors", subject, mode }
		])
	]),
	"a probe"
)

/** The node types of a recursive read, none of which a family or tree read may plan. */
const RECURSIVE: ReadonlyArray<string> = ["Recursive Union", "WorkTable Scan", "CTE Scan"]

const planFacts = (plan: PlanNode) => ({
	indexes: Arr.dedupe(Arr.map(indexAccesses(plan), (a) => a.index)),
	sorts: findNodes(plan, "Sort").length,
	seqScans: findNodes(plan, "Seq Scan").length,
	recursive: Arr.filter(
		Arr.map(
			findNodes(plan, () => true),
			(n) => n.nodeType
		),
		(t) => RECURSIVE.includes(t)
	),
	read: rowsRead(plan)
})

const depthOf = (rows: ReadonlyArray<TreeRow>, id: number): number => ancestorsOf(rows, id).length

layer(Substrate.layer)(
	"family and tree reads through grizzle's installed indexes on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"read a tree in document order with no sort, each subtree's descendants and each row's ancestors by scans of T1's index, and a family's members by its key, with no sequential scan and no recursion",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const trees = yield* seatOf(Trees, RELATIONS, "plans tree")
						const family = yield* familySeat("ordered", "plans family")
						const rows = loadTree(load.tree, load.fanout)
						yield* trees.session.begin
						yield* trees.session.query(nodeBatchSql(trees), nodeBatchParams(rows))
						yield* trees.session.commit
						const f = family.seat
						const fc = (relation: string, role: string) => f.column(relation, role)
						const familyLoaded = yield* attempt(f.session, [
							`INSERT INTO ${f.table("Owner")} (${fc("Owner", "id")}, ${fc("Owner", "n")}) SELECT o, ${load.members} FROM pg_catalog.generate_series(1, ${load.owners}) AS o`,
							`INSERT INTO ${f.table("Member")} (${fc("Member", "member")}, ${fc("Member", "g")}, ${fc("Member", "at")}, ${fc("Member", "‹n›")}) SELECT o * ${load.members} + a, o, a, ${load.members} FROM pg_catalog.generate_series(1, ${load.owners}) AS o, pg_catalog.generate_series(0, ${load.members - 1}) AS a`
						])
						assert.equal(familyLoaded.kind, "committed", "the family load is a family state")
						yield* s.admin.query(
							`ANALYZE ${trees.table("Node")}, ${f.table("Owner")}, ${f.table("Member")}`,
							[]
						)
						const t1 = Option.getOrThrow(
							Arr.findFirst(trees.constraints, (c: Catalogued) =>
								nativesOf(c).includes("document order")
							)
						).name
						const key = Option.getOrThrow(
							Arr.findFirst(f.constraints, (c: Catalogued) =>
								Option.contains(familyConstraintOf(family, c), "key")
							)
						).name
						const subjectOf = (subject: Subject): TreeRow => {
							switch (subject) {
								case "a quarter of the tree":
									return defined(rows[1])
								case "a subtree under 100 rows":
									return Option.getOrThrow(
										Arr.findFirst(rows, (r) => r.end - r.start > 1 && r.end - r.start < 100)
									)
								case "a leaf":
									return Option.getOrThrow(Arr.findFirst(rows, (r) => r.children === 0))
								case "the deepest row":
									return defined(
										Arr.sort(
											rows,
											Order.mapInput(Order.flip(Order.Number), (r: TreeRow) => depthOf(rows, r.id))
										)[0]
									)
							}
						}
						const t = (role: string) => trees.column("Node", role)
						return yield* exhaust(
							{
								suite: "fin/plans",
								generator: element(PROBES),
								literal: Formatter.format,
								limit: PROBES.length,
								box: "the export, the descendants and ancestors of four rows of a 20,000-row tree, and one family's members among 200, each planned custom and generic",
								oracle: {
									kind: "postgresql",
									name: "EXPLAIN's plan shape: T1's or the family key's index alone, no Sort, no Seq Scan, no recursive node; each read's rows against the tree's parent links or the family as written"
								},
								coverage: requiredInSpace<PlanFeature>(nonEmpty(Arr.map(PROBES, probeName))),
								caseHang
							},
							(probe, c) =>
								Effect.gen(function* () {
									const session = probe.read === "a family's members" ? f.session : trees.session
									const query = (() => {
										switch (probe.read) {
											case "the export":
												return {
													sql: `SELECT ${t("id")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 ORDER BY ${t("start")}`,
													params: ["0"]
												}
											case "descendants": {
												const n = subjectOf(probe.subject)
												return {
													sql: `SELECT ${t("id")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 AND ${t("start")} > $2::int8 AND ${t("start")} < $3::int8`,
													params: ["0", String(n.start), String(n.end)]
												}
											}
											case "ancestors": {
												const n = subjectOf(probe.subject)
												return {
													sql: `SELECT ${t("id")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 AND ${t("start")} < $2::int8 AND ${t("end")} > $2::int8`,
													params: ["0", String(n.start)]
												}
											}
											case "a family's members":
												return {
													sql: `SELECT ${fc("Member", "member")} FROM ${f.table("Member")} WHERE ${fc("Member", "g")} = $1::int4 ORDER BY ${fc("Member", "at")}`,
													params: ["7"]
												}
										}
									})()
									const e =
										probe.mode === "custom"
											? yield* explain(session, query.sql, query.params, planned)
											: yield* explainServerStatement(
													session,
													query.sql,
													query.params,
													"generic",
													planned
												)
									const facts = planFacts(e.plan)
									const name = probeName(probe)
									yield* Effect.promise(() => ctx.annotate(`${name}: ${Formatter.format(facts)}`))
									assert.deepEqual(
										facts.indexes,
										[probe.read === "a family's members" ? key : t1],
										`${name} reads its index alone`
									)
									assert.equal(facts.seqScans, 0, `${name} scans nothing sequentially`)
									assert.deepEqual(facts.recursive, [], `${name} does not recurse`)
									const answered = yield* session.values(query.sql, query.params)
									const got = Arr.map(answered, (r) => Number(r[0]))
									switch (probe.read) {
										case "the export":
											assert.equal(facts.sorts, 0, `${name} sorts nothing`)
											assert.equal(facts.read, load.tree, `${name} reads each row once`)
											assert.deepEqual(
												got,
												Arr.map(rows, (r) => r.id),
												`${name} is the pre-order`
											)
											break
										case "descendants": {
											const n = subjectOf(probe.subject)
											assert.equal(facts.read, n.end - n.start - 1, `${name} reads exactly them`)
											assert.deepEqual(
												Arr.sort(got, Order.Number),
												Arr.sort(descendantsOf(rows, n.id), Order.Number),
												`${name} are the rows under it by their parent links`
											)
											break
										}
										case "ancestors": {
											const n = subjectOf(probe.subject)
											assert.ok(facts.read <= n.start, `${name} reads no row after it in pre-order`)
											assert.deepEqual(
												Arr.sort(got, Order.Number),
												Arr.sort(ancestorsOf(rows, n.id), Order.Number),
												`${name} are the rows above it by their parent links`
											)
											break
										}
										case "a family's members":
											assert.equal(facts.read, load.members, `${name} reads exactly its members`)
											assert.deepEqual(
												got,
												Arr.map(Arr.range(0, load.members - 1), (a) => 7 * load.members + a),
												`${name} come in slot order`
											)
											break
									}
									c.note(name)
								})
						)
					})
				)
		)
	}
)
