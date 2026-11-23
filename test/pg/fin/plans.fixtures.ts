/** What the property of plans.test.ts reads: the planted load, its seeded templates, its space and a plan's facts. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, constant, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import {
	type ExplainOptions,
	findNodes,
	indexAccesses,
	type PlanMode,
	type PlanNode,
	rowsRead
} from "#bench/harness/explain.ts"
import { seededFamilyTemplate } from "#test/pg/fin/family.ts"
import { seededSeatTemplate } from "#test/pg/fin/installed.ts"
import { nodeBatchParams, nodeBatchSql, RELATIONS, Trees } from "#test/pg/fin/tree.ts"
import { loadTree, rowsByDepth, type TreeRow } from "#test/pg/substrate/tree.ts"
import { pickGen } from "#test/support/pick.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** The EXPLAIN options of a plan reading: no WAL, no SERIALIZE. */
export const planned: ExplainOptions = { wal: false, serialize: { kind: "off" } }

/** The planted loads: one tree of 20,000 rows of fan-out up to four, and 200 owners of 100 ordered members each. */
export const load = { tree: 20_000, fanout: 4, owners: 200, members: 100 } as const

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
export type Subject = (typeof subjects)[number]

export const subjectOf = (row: TreeRow, depth: number): Subject =>
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

export type PlanFeature =
	| `${"the export" | "a family's members"}, ${PlanMode} plan`
	| `the descendants of ${Subject}, ${PlanMode} plan`

/** The node types of a recursive read, none of which a family or tree read may plan. */
const RECURSIVE: ReadonlyArray<string> = ["Recursive Union", "WorkTable Scan", "CTE Scan"]

export const planFacts = (plan: PlanNode) => ({
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

/** The planted tree's rows, in pre-order, and the rows at each depth below the root. */
export const rows = loadTree(load.tree, load.fanout)
export const byDepth = rowsByDepth(rows)

const starts: ReadonlyMap<number, number> = new Map(Arr.map(rows, (r) => [r.id, r.start] as const))

/** A row's start by its substrate key: the key the keyed tree names it by. */
export const startOf = (id: number): number => defined(starts.get(id), "a loaded row's start")

/** Every read planned custom and generic: the export, a family's members and the descendants of each subject. */
export const planSituations: ReadonlyArray<Reached<PlanFeature>> = nonEmpty(
	Arr.flatMap(["custom", "generic"] as const, (mode): ReadonlyArray<PlanFeature> => [
		`the export, ${mode} plan`,
		`a family's members, ${mode} plan`,
		...Arr.map(subjects, (subject): PlanFeature => `the descendants of ${subject}, ${mode} plan`)
	]),
	"the plan situations"
)

/** The probes: every depth below the planted tree's root alike, and every owner of the family load. */
export const probes = probeGen(byDepth.length - 1)

/**
 * The tree with its planted load, written whole and vacuumed once per member (installed.ts seededSeatTemplate), where
 * the search loaded it once before its cases; a case reads it and writes nothing. Vacuumed, as autovacuum's insert
 * threshold leaves a loaded table and as the plan-shape law's filled state is (test/pg/physical/plan-shape.test.ts): its
 * pages all-visible and its size counted, every column's statistics the installation's declared ones, which an ANALYZE
 * leaves as they are. Merely analyzed, its pages none all-visible, the export's plan turns on the unit's size: on
 * PostgreSQL 19, over 20,000 rows of one doc, `WHERE doc = $1 ORDER BY start` sorts a bitmap scan of the unit for every
 * declared unit of 2^1 to 2^12 rows and reads an index in order only at 2^0 and 2^14, where vacuumed it reads an index
 * in order, alone, at every size (~/.cache/grizzle/DECLSTATS-work/unitscale/export.sh, export.log, 2026-11-23).
 */
export const plansTree = seededSeatTemplate(import.meta, Trees, RELATIONS, "plans tree", (trees) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* trees.session.begin
		yield* trees.session.query(nodeBatchSql(trees), nodeBatchParams(rows))
		yield* trees.session.commit
		yield* s.admin.query(`VACUUM ${trees.table("Node")}`, [])
	})
)

/**
 * The ordered family with its planted load of 200 owners of 100 members, written and vacuumed once per member
 * (family.ts seededFamilyTemplate), where the search loaded it once before its cases, vacuumed as the tree is
 * (`plansTree`).
 */
export const plansFamily = seededFamilyTemplate(import.meta, "ordered", "plans family", (family) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const f = family.seat
		const fc = (relation: string, role: string) => f.column(relation, role)
		const familyLoaded = yield* attempt(f.session, [
			`INSERT INTO ${f.table("Owner")} (${fc("Owner", "id")}, ${fc("Owner", "n")}) SELECT o, ${load.members} FROM pg_catalog.generate_series(1, ${load.owners}) AS o`,
			`INSERT INTO ${f.table("Member")} (${fc("Member", "member")}, ${fc("Member", "g")}, ${fc("Member", "at")}, ${fc("Member", "‹n›")}) SELECT o * ${load.members} + a, o, a, ${load.members} FROM pg_catalog.generate_series(1, ${load.owners}) AS o, pg_catalog.generate_series(0, ${load.members - 1}) AS a`
		])
		assert.equal(familyLoaded.kind, "committed", "the family load is a family state")
		yield* s.admin.query(`VACUUM ${f.table("Owner")}, ${f.table("Member")}`, [])
	})
)
