/** What the property of unit-delete-cost.test.ts reads: its schema, its space, and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { type Explained, type PlanNode, planNodes } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, mutable, on, relation, schema, tree, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Nodes of documents of packages, edullm's qti.node: each document a tree rooted at (pkg, path), keyed (pkg, path,
 * start), its path long, so the key's index is deeper than an index over (pkg, path) and a column of few values, which
 * deduplicates to an entry or two a document. The workload's read of a document's nodes of a kind and above, a range
 * after (pkg, path), asks for that index, (pkg, path, kind), whose order the range needs. A package's documents
 * outnumber a document's nodes and the stored packages outnumber both, so PostgreSQL estimates a document's nodes at
 * about one row, as it does a key's, and reads a lookup at the key through the shallower index, filtering start over
 * every node of the document (edullm's node delete through (package, path, element_children), 138 buffers a row).
 */
const Name = str.bytes(256, str.regex("^.*$", "su"))

const Node = relation(
	"Node",
	{
		pkg: int8,
		path: Name,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		kind: int8
	},
	["pkg", "path", "start"]
)

const build = (name: string) =>
	schema(
		name,
		[Node],
		[
			tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["pkg", "path"] }),
			mutable(Node),
			unit("Package", { pkg: int8 })
		]
	)

type Schema = ReturnType<typeof build>

/** The workload's read of a document's nodes of kind `kind` and above: an equality prefix (pkg, path) and a range on
 * kind, so its index's order is the range's. */
const byKindOf = (s: Schema) =>
	query(s).rule((r) => {
		const { start, kind } = v(Node, "n")
		return r
			.match(Node, { pkg: r.param("pkg", int8), path: r.param("path", Name), start, kind })
			.where(r.ge(kind, r.param("kind", int8)))
			.find({ start })
	})

/** The kinds a document's nodes hold, a column of few values. */
const kinds = 3

/** A case: the packages stored beside the written one, each package's documents and each document's nodes, and the
 * statistics PostgreSQL holds when the package is deleted. */
export interface Stored {
	readonly packages: number
	readonly documents: number
	readonly nodes: number
	readonly statistics: "none" | "analyzed"
}

/** Tens of packages of ten documents of tens of nodes: fewer nodes a document than packages, so PostgreSQL estimates a
 * document's nodes at about one row. */
export const storedGen: Gen<Stored> = (s) => ({
	packages: s.draw(int(40, 60)),
	documents: 10,
	nodes: s.draw(int(20, 40)),
	statistics: s.draw(element(["none", "analyzed"] as const))
})

export type DeleteFeature = "deleted with no statistics" | "deleted analyzed"

/** A document's path, long: `document/`, its package and number, then 230 x. */
const pathOf = (pkg: number, doc: number): string =>
	`document/${Str.padStart(4, "0")(String(pkg))}/${Str.padStart(6, "0")(String(doc))}${Str.repeat(230)("x")}`

/** A document's tree as its nested fact states it: a root of kind 0 with every other node its child, node i of kind
 * i mod `kinds`. */
const documentOf = (pkg: number, doc: number, nodes: number) => ({
	pkg: BigInt(pkg),
	path: pathOf(pkg, doc),
	kind: 0n,
	children: Arr.map(indices(nodes - 1), (i) => ({ kind: BigInt((i + 1) % kinds), children: [] }))
})

/** The rows a scan reads over all its loops: its output and what its filters removed. */
const readOf = (n: PlanNode): number =>
	(n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops

/** Whether a plan node scans a relation: a heap, index, bitmap heap or TID scan, never the ModifyTable that writes it. */
const scans = (n: PlanNode): boolean =>
	Str.endsWith(" Scan")(n.nodeType) && n.nodeType !== "Bitmap Index Scan"

/** A plan's DELETE nodes: each ModifyTable of a DELETE, with the scans below it, which meet the rows it deletes. */
const deletesOf = (explained: Explained): ReadonlyArray<PlanNode> =>
	Arr.filter(
		[...planNodes(explained.plan)],
		(n) => n.nodeType === "ModifyTable" && Option.contains(n.operation, "Delete")
	)

/**
 * One case on a fresh installation: `packages` packages of `documents` documents of `nodes` nodes stored through the
 * Db, ANALYZE where the case draws it, then package 1 deleted whole (deleteWhere by pkg) under EXPLAIN (ANALYZE) and
 * rolled back. The unit delete, the write's one statement that deletes, meets each node it deletes once: its DELETE of
 * Node reads one row of Node for each it deletes, whatever the stored packages beside it and the index the workload's
 * range asks of Node. A DELETE at the doomed keys read them through (pkg, path, kind), every node of its document a
 * loop.
 */
export const runDelete = (stored: Stored, c: Case<DeleteFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("UnitDeleteCost"), "unitdeletecost", {
				programs: { byKind: byKindOf(build("UnitDeleteCost")) },
				logins: () => []
			})
			const S: Schema = build(fx.installed.declared)
			const substrate = yield* Substrate
			const db = yield* openFull(fx, S)
			for (const pkgs of Arr.chunksOf(
				Arr.map(indices(stored.packages), (p) => p + 1),
				10
			)) {
				const store = yield* observedChange(
					db,
					ChangeSet.empty(S).insert(
						Node,
						Arr.flatMap(pkgs, (p) =>
							Arr.map(indices(stored.documents), (d) => documentOf(p, d, stored.nodes))
						)
					),
					attemptLabel,
					{ kind: "none" }
				)
				const applied = yield* store.apply({})
				assert.equal(
					applied.value.kind,
					"accepted",
					`packages ${Formatter.format(pkgs)} are stored`
				)
			}
			if (stored.statistics === "analyzed") {
				yield* Effect.forEach(fx.tables, (table) => substrate.admin.query(`ANALYZE ${table}`, []), {
					discard: true
				})
			}
			const plans = yield* explainedChange(
				db,
				ChangeSet.empty(S).deleteWhere({ Node: { pkg: 1n } }),
				{}
			)
			const node = fx.relationName("Node")
			const deletes = Arr.filter(Arr.flatMap(plans, deletesOf), (n) =>
				Option.contains(n.relation, node)
			)
			assert.equal(deletes.length, 1, "the delete of a package runs one DELETE of Node")
			const read = Arr.flatMap(deletes, (d) =>
				Arr.filter([...planNodes(d)], (n) => scans(n) && Option.contains(n.relation, node))
			)
			const rows = Arr.reduce(read, 0, (sum, n) => sum + readOf(n))
			const deleted = stored.documents * stored.nodes
			assert.ok(
				rows <= deleted,
				`${Formatter.format(stored)}: the unit delete's DELETE of Node reads ${rows} rows of Node for the ${deleted} it deletes: ${Formatter.format(
					Arr.map(read, (n) => ({
						node: n.nodeType,
						index: Option.getOrUndefined(n.index),
						loops: n.actualLoops,
						rows: n.actualRows,
						removed: n.rowsRemovedByFilter
					}))
				)}`
			)
			c.note(stored.statistics === "none" ? "deleted with no statistics" : "deleted analyzed")
		})
	)
