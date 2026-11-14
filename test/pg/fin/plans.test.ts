/**
 * The reads of families and trees through grizzle's installed indexes, on PostgreSQL 19rc2 (fin.md §11, "Plan audits",
 * trees.md §3, §5): the export, every subtree's descendants and every family's members are an index or range scan of
 * the index grizzle installs for them, with no sort, no sequential scan and no recursion, and return exactly the rows
 * the parent links say they should.
 *
 * The reads, each over a planted, analyzed load and each planned custom or generic as the search draws (R04), of a row
 * drawn at every depth below the root alike and of an owner drawn among them all. A row's ancestors are no such read:
 * `start <= n.start AND end > n.start` reads every row before it in pre-order, so for a row late in it the planner
 * rightly scans the table, and no index grizzle installs serves it.
 *
 * Both plans are a served read's: every statement of a served workload is a named prepared statement
 * (core/prepared.ts), which PostgreSQL plans custom for its first five executions on a session and may plan generic
 * from its sixth (PostgreSQL 19 plancache.c choose_custom_plan), so an application's read of a tree or a family runs on
 * either.
 *
 * - **the export**, `WHERE doc = $1 ORDER BY start`: one scan of an index led by (r, start), the tree's primary key
 *   (T1) or the owner axis's target superkey (r, start, children), reading each row once;
 * - **descendants** of a row, `start > n.start AND start < n.end`: a range scan of such an index reading exactly them;
 * - **an ordered family's members**, `WHERE g = $1 ORDER BY at`: a scan of the family key UNIQUE (g, at) reading
 *   exactly its members, whether the planner sorts them after a bitmap scan or reads them in order.
 *
 * - **Oracles:** EXPLAIN's plan shape (bench/harness/explain.ts), its index named by the installed catalog's role
 *   (installed.ts), never by an allocated name; and each read's rows against the tree's parent links
 *   (families/tree.ts descendantsOf) or the family as written, a second implementation that reads no interval.
 *
 * Plant: ~/.cache/grizzle-release/TREEKEY/plants/fin-plans-tree-key-start-first.patch, the tree's primary key planned
 * as (start, r), leaves the export no index in its order and must turn the property red.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, constant, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
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
import { loadTree, rowsByDepth, type TreeRow } from "#test/pg/substrate/tree.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { descendantsOf } from "#test/support/families/tree.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** The EXPLAIN options of a plan reading: no WAL, no SERIALIZE. */
const planned: ExplainOptions = { wal: false, serialize: { kind: "off" } }

/** The planted loads: one tree of 20,000 rows of fan-out up to four, and 200 owners of 100 ordered members each. */
const load = { tree: 20_000, fanout: 4, owners: 200, members: 100 } as const

/**
 * What a row whose reads a probe plans is: one of the root's children, a row heading 100 rows or more below them, a
 * row heading fewer, or a leaf.
 */
const subjects = [
	"a quarter of the tree",
	"a subtree of 100 rows or more",
	"a subtree under 100 rows",
	"a leaf"
] as const
type Subject = (typeof subjects)[number]

const subjectOf = (row: TreeRow, depth: number): Subject =>
	depth === 1
		? "a quarter of the tree"
		: row.children === 0
			? "a leaf"
			: row.end - row.start < 100
				? "a subtree under 100 rows"
				: "a subtree of 100 rows or more"

/**
 * What a probe reads: the export, the descendants of a row below the root, drawn as its depth and a pick among the
 * rows at it, or the members of a drawn owner.
 */
type Read =
	| Readonly<{ kind: "the export" }>
	| Readonly<{ kind: "descendants"; depth: number; pick: number }>
	| Readonly<{ kind: "a family's members"; owner: number }>

/** A probe's read, planned generic or custom. */
interface ProbeSketch {
	readonly generic: boolean
	readonly read: Read
}

/** Every depth below the root alike, to `deepest`, and every owner of the family load. */
const probeGen = (deepest: number): Gen<ProbeSketch> => {
	const depths = nonEmpty(
		upTo(deepest, (i) => i + 1),
		"a depth below the root"
	)
	const descendants: Gen<Read> = (source) => ({
		kind: "descendants",
		depth: source.draw(element(depths)),
		pick: source.draw(pickGen)
	})
	return (source) => ({
		generic: source.draw(boolean),
		read: source.draw(
			weighted<Read>([
				[1, constant<Read>({ kind: "the export" })],
				[4, descendants],
				[1, map(int(1, load.owners), (owner): Read => ({ kind: "a family's members", owner }))]
			])
		)
	})
}

type PlanFeature =
	| `${"the export" | "a family's members"}, ${PlanMode} plan`
	| `the descendants of ${Subject}, ${PlanMode} plan`

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

layer(Substrate.layer)(
	"family and tree reads through grizzle's installed indexes on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"read a tree in document order with no sort, each subtree's descendants by a range scan of T1's index, and a family's members by its key, with no sequential scan and no recursion",
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
						/** Every index of the tree in document order: each led by its root field, then its start, the primary
						 * key (T1) among them, and the owner axis's target superkey (doc, start, children), which serves alike. */
						const inOrder = Arr.map(
							Arr.filter(
								trees.constraints,
								(c: Catalogued) =>
									nativesOf(c).includes("document order") ||
									(c.columns[0] === "doc" && c.columns[1] === "start")
							),
							(c) => c.name
						)
						const key = Option.getOrThrow(
							Arr.findFirst(f.constraints, (c: Catalogued) =>
								Option.contains(familyConstraintOf(family, c), "key")
							)
						).name
						const byDepth = rowsByDepth(rows)
						const starts = new Map(Arr.map(rows, (r) => [r.id, r.start] as const))
						/** A row's start by its substrate key: the key the keyed tree names it by. */
						const startOf = (id: number): number => defined(starts.get(id), "a loaded row's start")
						const modes: ReadonlyArray<PlanMode> = ["custom", "generic"]
						const situations = nonEmpty(
							Arr.flatMap(modes, (mode): ReadonlyArray<PlanFeature> => [
								`the export, ${mode} plan`,
								`a family's members, ${mode} plan`,
								...Arr.map(
									subjects,
									(subject): PlanFeature => `the descendants of ${subject}, ${mode} plan`
								)
							])
						)
						const t = (role: string) => trees.column("Node", role)
						return yield* explore(
							{
								suite: "fin/plans",
								draw: drawn(probeGen(byDepth.length - 1)),
								literal: Formatter.format,
								oracle: {
									kind: "postgresql",
									name: "EXPLAIN's plan shape: T1's or the family key's index alone, no Sort, no Seq Scan, no recursive node; each read's rows against the tree's parent links or the family as written"
								},
								coverage: required<PlanFeature>(situations, { cases: 64, sense: notesOnly }),
								kept: [],
								runs: 32,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(sketch, c) =>
								Effect.gen(function* () {
									const mode: PlanMode = sketch.generic ? "generic" : "custom"
									const read = sketch.read
									const subjectAt = (depth: number, pick: number) => {
										const row = pickFrom(
											defined(byDepth[depth], `the rows at depth ${depth}`),
											pick
										)
										return { row, subject: subjectOf(row, depth) }
									}
									const session = read.kind === "a family's members" ? f.session : trees.session
									const probe = (() => {
										switch (read.kind) {
											case "the export":
												return {
													name: `the export, ${mode} plan` as const,
													sql: `SELECT ${t("start")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 ORDER BY ${t("start")}`,
													params: ["0"]
												}
											case "descendants": {
												const { row, subject } = subjectAt(read.depth, read.pick)
												return {
													name: `the descendants of ${subject}, ${mode} plan` as const,
													sql: `SELECT ${t("start")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 AND ${t("start")} > $2::int8 AND ${t("start")} < $3::int8`,
													params: ["0", String(row.start), String(row.end)]
												}
											}
											case "a family's members":
												return {
													name: `a family's members, ${mode} plan` as const,
													sql: `SELECT ${fc("Member", "member")} FROM ${f.table("Member")} WHERE ${fc("Member", "g")} = $1::int4 ORDER BY ${fc("Member", "at")}`,
													params: [String(read.owner)]
												}
										}
									})()
									const name: PlanFeature = probe.name
									const e =
										mode === "custom"
											? yield* explain(session, probe.sql, probe.params, planned)
											: yield* explainServerStatement(
													session,
													probe.sql,
													probe.params,
													"generic",
													planned
												)
									const facts = planFacts(e.plan)
									const [only, ...more] = facts.indexes
									assert.ok(
										only !== undefined &&
											more.length === 0 &&
											(read.kind === "a family's members" ? only === key : inOrder.includes(only)),
										`${name} reads its index alone, one in its order: ${Formatter.format(facts.indexes)}`
									)
									assert.equal(facts.seqScans, 0, `${name} scans nothing sequentially`)
									assert.deepEqual(facts.recursive, [], `${name} does not recurse`)
									const answered = yield* session.values(probe.sql, probe.params)
									const got = Arr.map(answered, (r) => Number(r[0]))
									switch (read.kind) {
										case "the export":
											assert.equal(facts.sorts, 0, `${name} sorts nothing`)
											assert.equal(facts.read, load.tree, `${name} reads each row once`)
											assert.deepEqual(
												got,
												Arr.map(rows, (r) => startOf(r.id)),
												`${name} is the pre-order`
											)
											break
										case "descendants": {
											const { row } = subjectAt(read.depth, read.pick)
											assert.equal(
												facts.read,
												row.end - row.start - 1,
												`${name} reads exactly them`
											)
											assert.deepEqual(
												Arr.sort(got, Order.Number),
												Arr.sort(Arr.map(descendantsOf(rows, row.id), startOf), Order.Number),
												`${name} are the rows under it by their parent links`
											)
											break
										}
										case "a family's members":
											assert.equal(facts.read, load.members, `${name} reads exactly its members`)
											assert.deepEqual(
												got,
												Arr.map(
													upTo(load.members, (i) => i),
													(a) => read.owner * load.members + a
												),
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
