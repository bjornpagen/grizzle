/** What the properties of replace-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Result } from "effect"
import { type PlanNode, planNodes, rowsScannedAndPaired } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	mutable,
	on,
	ordered,
	relation,
	schema,
	tree,
	unit
} from "#compiler/public/schema.ts"
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

/**
 * The box's schema: a Doc owning its tree of nodes, its lines and its tags, every relation mutable, since a replace
 * deletes the unit whole: a Doc's row inside the unit of its id, and its members inside the unit of their doc.
 */
const build = (name: string) =>
	schema(
		name,
		[Doc, Node, Line, Tag],
		[
			tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] }),
			counted(on(Node, "doc"), fin(Doc, "nodes")),
			ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
			counted(on(Tag, "doc"), fin(Doc, "tags")),
			mutable(Doc),
			mutable(Node),
			mutable(Line),
			mutable(Tag),
			unit("Document", { id: pg.bigint }),
			unit("Body", { doc: pg.bigint })
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

export const sketchGen: Gen<Sketch> = (source) => ({
	situation: source.draw(element(situations)),
	tree: source.draw(element(trees)),
	n: source.draw(element([100, 200]))
})

export type Feature = `${Situation} in ${TreeShape}`

export const features: Arr.NonEmptyReadonlyArray<Feature> = Arr.flatMap(trees, (t) =>
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

export const costText = (c: Cost): string =>
	`${c.read} rows read and paired by the unit delete at ${c.rows} rows a family (the write's statements ${c.written}, ${c.pages} pages read, ${c.temp} temp pages written)`

/** Whether a plan deletes: a ModifyTable node of a DELETE. */
const deletes = (plan: PlanNode): boolean =>
	Arr.some(
		[...planNodes(plan)],
		(n) => n.nodeType === "ModifyTable" && Option.contains(n.operation, "Delete")
	)

/**
 * The cost of replacing a unit of `rows` rows a family, stored first through the Db, on a fresh installation whose
 * tables autovacuum leaves alone, with the times PostgreSQL had analyzed its tables when the write began, which a
 * never-analyzed installation holds at none.
 */
export const costOf = (situation: Situation, tree: TreeShape, rows: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("ReplaceCost"), "replacecost", {
				programs: {},
				logins: []
			})
			const S: Schema = build(fx.installed.declared)
			const substrate = yield* Substrate
			yield* Effect.forEach(
				fx.tables,
				(table) =>
					substrate.admin.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`, []),
				{ discard: true }
			)
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
