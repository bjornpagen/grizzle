/**
 * The cost of replacing a stored unit grows linearly with the unit, on PostgreSQL 19: a ChangeSet deleting a stored
 * unit whole and inserting it again in one stratum (write/delete/unit.ts), edullm's re-publish of a package, at units of
 * n, 2n and 4n rows. The unit is a Doc owning a tree of nodes as its counted family's members (qti-pie's and edullm's
 * shape, a test's tree of instances), an ordered family of lines, and a counted family of tags, each family one group
 * of the unit's size. The tree is a complete tree of four children a node, numbered in breadth-first order, so each node
 * has a path from its root and siblings before it; or a root with every other node its child, so every node has every
 * other as a sibling. The unit is replaced by the same value, every row kept and none written, or with its first child,
 * its first line or its first tag changed, which breaks the kept rows of a tree behind that node, of a sequence behind
 * that line, and of a counted group with that tag.
 *
 * Property, for each situation and tree: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the unit,
 * from n to 2n and from 2n to 4n, and so do the unit delete's alone, the write's one statement that deletes. A cost of a
 * fixed part and a part per row, a·n + b, at most doubles, since its fixed part does not double, whatever constant a plan
 * switch between sizes adds below that part; a cost with any term above linear more than doubles once that term
 * outgrows the fixed part, which the sizes reach: no slack, no threshold, no clock. A kept-row judgement that reads a
 * row's group, its earlier siblings or its path once per row grows by more, and so does a family additions statement
 * that finds each node it inserts again among its siblings by reading them: the tree's sibling key is a UNIQUE over
 * the node's law column of its parent, which a probe reaches by binding that column (laws/model/uniques.ts
 * GuardedReach), and a probe that binds a stored row's other columns beside its key lets PostgreSQL, holding no
 * statistics, read the row through the parent's index instead (write/probe.ts Equal). The guarded reach is no case
 * of this law: a node re-inserted after its siblings were removed meets them only as dead index entries, which the
 * rows read do not count. The pages the statements read and
 * the temp they wrote are reported beside the rows, unjudged. Every size is measured on a fresh installation that no
 * ANALYZE has run on when the write begins, which the case checks (pg_stat_user_tables): the unit a case stores first is
 * committed, which autovacuum may analyze later, after the write it measures. Every statement of the write passes the
 * structural audit (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: each situation in each tree at a smallest size n of 100 and of 200 rows, the unit stored beside a
 * second unit of 3,200 rows a family that the write leaves alone (`beside`). Each size's write is applied once, its
 * statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by
 * ROLLBACK (bench/write/support/writes.ts explainedChange). The oracle is the law itself; test/pg/write/whole judges the
 * rows the same statements write and keep against a model of the units.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { type PlanNode, planNodes, rowsScannedAndPaired } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, on, ordered, relation, schema, tree } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

const Doc = relation(
	"Doc",
	{
		id: pg.bigint,
		note: pg.bigint,
		nodes: drawn(natural),
		lines: drawn(natural),
		tags: drawn(natural)
	},
	["id"]
)
const Node = relation(
	"Node",
	{
		doc: pg.bigint,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		label: pg.bigint
	},
	["doc", "start"]
)
const Line = relation("Line", { doc: pg.bigint, at: drawn(natural), words: pg.bigint }, [
	"doc",
	"at"
])
const Tag = relation("Tag", { doc: pg.bigint, label: pg.bigint }, ["doc", "label"])

const build = (name: string) =>
	schema(
		name,
		[Doc, Node, Line, Tag],
		[
			tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] }),
			counted(on(Node, "doc"), fin(Doc, "nodes")),
			ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
			counted(on(Tag, "doc"), fin(Doc, "tags"))
		]
	)

type Schema = ReturnType<typeof build>

/** The replace's value beside the stored one: the same, or one changed at its first child, line or tag. */
const situations = [
	"replaced unchanged",
	"its first child changed",
	"its first line changed",
	"its first tag changed"
] as const

type Situation = (typeof situations)[number]

/** The unit's tree: a complete tree of four children a node, deep, its nodes' siblings few; or a root with every other
 * node its child, every node a sibling of every other. */
const trees = ["a complete tree", "a root and its children"] as const

type TreeShape = (typeof trees)[number]

/** A case: its situation, its tree, and the smallest size its law measures it at, n rows of each family; 2n and 4n
 * follow. */
interface Sketch {
	readonly situation: Situation
	readonly tree: TreeShape
	readonly n: number
}

const sketchGen: Gen<Sketch> = (source) => ({
	situation: source.draw(element(situations)),
	tree: source.draw(element(trees)),
	n: source.draw(element([100, 200]))
})

type Feature = `${Situation} in ${TreeShape}`

const features: Arr.NonEmptyReadonlyArray<Feature> = Arr.flatMap(trees, (t) =>
	Arr.map(situations, (s): Feature => `${s} in ${t}`)
)

/**
 * The rows of each family of the unit stored beside the one replaced, which the write leaves alone: a database holds
 * other packages beside the one a publish replaces, and a plan PostgreSQL might choose for a unit alone in its tables,
 * a scan of each table whole where every row of it is the unit's, reads them too, so the replaced unit's keyed reads
 * stay the cheaper plan at every size the law measures.
 */
const beside = 3200

/** A node of a tree as its nested fact states it: its label and its children in order. */
interface Labelled {
	readonly label: bigint
	readonly children: ReadonlyArray<Labelled>
}

/** The children a node of a tree of `rows` nodes has, node i's being fanout · i + 1 to fanout · i + fanout: four in a
 * complete tree, and in a root and its children every node but the root, the root's. */
const fanoutOf = (tree: TreeShape, rows: number): number =>
	tree === "a complete tree" ? 4 : rows - 1

/**
 * The unit's value at size `rows`: its tree of `rows` nodes in the shape `tree`, node i labelled i, its `rows` lines and
 * `rows` tags; `changed` names the one row it changes, if any: node 1, the first child of the root, line 0 or tag 0.
 */
const unitFacts = (doc: bigint, rows: number, changed: Situation, tree: TreeShape) => {
	const fanout = fanoutOf(tree, rows)
	const bump = (situation: Situation, i: number): bigint =>
		situation === changed && i === 0 ? 1_000_000n : 0n
	const node = (i: number): Labelled => ({
		label: BigInt(i) + bump("its first child changed", i - 1),
		children: Arr.filterMap(indices(fanout), (c) => {
			const child = fanout * i + c + 1
			return child < rows ? Result.succeed(node(child)) : Result.failVoid
		})
	})
	return {
		doc: {
			id: doc,
			note: 0n,
			lines: Arr.map(indices(rows), (i) => ({
				words: BigInt(i) + bump("its first line changed", i)
			}))
		},
		node: { doc, ...node(0) },
		tags: Arr.map(indices(rows), (i) => ({
			doc,
			label: BigInt(i) + bump("its first tag changed", i)
		}))
	}
}

/** The units `units` inserted, each a doc's id, size and changed row (unitFacts). */
const insertOf = (
	s: Schema,
	units: ReadonlyArray<{
		readonly doc: bigint
		readonly rows: number
		readonly changed: Situation
		readonly tree: TreeShape
	}>
) => {
	const facts = Arr.map(units, (u) => unitFacts(u.doc, u.rows, u.changed, u.tree))
	return ChangeSet.empty(s)
		.insert(
			Doc,
			Arr.map(facts, (f) => f.doc)
		)
		.insert(
			Node,
			Arr.map(facts, (f) => f.node)
		)
		.insert(
			Tag,
			Arr.flatMap(facts, (f) => f.tags)
		)
}

/**
 * What one size's write cost: the rows its unit delete read and paired, the rows all its statements did, and the pages
 * they read and the temp they wrote.
 */
interface Cost {
	readonly rows: number
	readonly read: number
	readonly written: number
	readonly pages: number
	readonly temp: number
}

const costText = (c: Cost): string =>
	`${c.read} rows read and paired by the unit delete at ${c.rows} rows a family (the write's statements ${c.written}, ${c.pages} pages read, ${c.temp} temp pages written)`

/** Whether a plan deletes: a ModifyTable node of a DELETE. */
const deletes = (plan: PlanNode): boolean =>
	Arr.some(
		[...planNodes(plan)],
		(n) => n.nodeType === "ModifyTable" && Option.contains(n.operation, "Delete")
	)

/**
 * The cost of replacing a unit of `rows` rows a family, stored first through the Db, on a fresh installation, with the
 * times PostgreSQL had analyzed its tables when the write began, which a never-analyzed installation holds at none.
 */
const costOf = (situation: Situation, tree: TreeShape, rows: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("ReplaceCost"), "replacecost", {
				programs: {},
				logins: []
			})
			const S: Schema = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const stored = yield* observedChange(
				db,
				insertOf(S, [
					{ doc: 1n, rows, changed: "replaced unchanged", tree },
					{ doc: 2n, rows: beside, changed: "replaced unchanged", tree: "a complete tree" }
				]),
				attemptLabel,
				{ kind: "none" }
			)
			const applied = yield* stored.apply({})
			assert.equal(applied.value.kind, "accepted", `the unit of ${rows} rows a family is stored`)
			const write = insertOf(S, [{ doc: 1n, rows, changed: situation, tree }]).delete(Doc, [
				{ id: 1n, note: 0n }
			])
			const substrate = yield* Substrate
			const analyzed = yield* substrate.admin.queryValues(
				`SELECT coalesce(sum(analyze_count + autoanalyze_count), 0)::text FROM pg_catalog.pg_stat_user_tables WHERE relid IN (${Arr.join(
					Arr.map(fx.tables, (table) => `'${table}'::pg_catalog.regclass`),
					", "
				)})`,
				[]
			)
			const plans = yield* explainedChange(db, write)
			const unit = Arr.filter(plans, (p) => deletes(p.plan))
			assert.equal(
				unit.length,
				1,
				`the replace of ${rows} rows a family runs one statement that deletes`
			)
			const violations = yield* writeAuditViolations(db, write)
			assert.deepEqual(violations, [], "every statement of the write passes the structural audit")
			return {
				analyzed: Number(analyzed[0]?.[0]),
				cost: {
					rows,
					read: Arr.reduce(unit, 0, (sum, p) => sum + rowsScannedAndPaired(p.plan)),
					written: Arr.reduce(plans, 0, (sum, p) => sum + rowsScannedAndPaired(p.plan)),
					pages: Arr.reduce(
						plans,
						0,
						(sum, p) => sum + p.plan.buffers.sharedHit + p.plan.buffers.sharedRead
					),
					temp: Arr.reduce(plans, 0, (sum, p) => sum + p.plan.buffers.tempWritten)
				} satisfies Cost
			}
		})
	)

layer(Substrate.layer)("the cost of replacing a stored unit", (it) => {
	it.effect("the rows it reads at most double with each doubling of the unit", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "pg/write/replace-cost",
					generator: sketchGen,
					literal: Formatter.format,
					box: "each situation of the box at units of n, 2n and 4n nodes, lines and tags, each size on a fresh installation, at n of 100 and of 200",
					oracle: {
						kind: "specification",
						name: "linear growth: a cost of a fixed part and a part per row at most doubles when its rows double, the fixed part not doubling, and a cost above linear more than doubles"
					},
					coverage: requiredInSpace<Feature>(features),
					caseHang,
					concurrency: 1
				},
				(sketch, c) =>
					Effect.gen(function* () {
						const [n, twice, four] = yield* Effect.all(
							[
								costOf(sketch.situation, sketch.tree, sketch.n),
								costOf(sketch.situation, sketch.tree, 2 * sketch.n),
								costOf(sketch.situation, sketch.tree, 4 * sketch.n)
							],
							{ concurrency: 1 }
						)
						c.note(`${sketch.situation} in ${sketch.tree}`)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`${sketch.situation}: the installation measured at ${at.cost.rows} rows a family was analyzed`
							)
						}
						const sizes = Arr.join(Arr.map([n.cost, twice.cost, four.cost], costText), "; ")
						assert.ok(
							twice.cost.read <= 2 * n.cost.read && four.cost.read <= 2 * twice.cost.read,
							`${sketch.situation} in ${sketch.tree}: its unit delete reads rows faster than linearly: ${sizes}`
						)
						assert.ok(
							twice.cost.written <= 2 * n.cost.written &&
								four.cost.written <= 2 * twice.cost.written,
							`${sketch.situation} in ${sketch.tree}: its replace reads rows faster than linearly: ${sizes}`
						)
					})
			)
		)
	)
})
