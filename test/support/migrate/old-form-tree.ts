/**
 * An id-keyed tree as grizzle installed one before trees were keyed by their root and start (da713e04): the first
 * migration and the snapshot of the schema below, drafted by grizzle 37c3de02's test kit (compile asDrafted, generate
 * from the empty snapshot, writeSnapshot over derivedOf), frozen as that generator wrote them
 * (old-form-tree.files.ts), since the current compiler draws no such tree: one keyed by a caller's id, its parent the
 * parent's id, its root field doc. A migration suite installs it as its first version and drafts the keyed tree from
 * its snapshot, the move every installed tree makes.
 *
 *   const Node = relation("Node", { id: uuid, doc: uuid, parent: uuid, at: drawn(natural), children: drawn(natural),
 *     start: drawn(natural), end: drawn(natural), kind: pg.int4, parentKind: accumulated(pg.int4, 0),
 *     before: accumulated(natural, 0n), after: accumulated(natural, 0n), total: accumulated(natural, 0n) }, ["id"])
 *   const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })
 *   schema("OldTree", { Node }, [
 *     nodes,
 *     fold(nodes, Monoid.count, on(Node, "parent", "before", "after"), on(Node, "id", "total")),
 *     contained(on(select(Node, (n) => n.gt(n.start, 0n)), "parent", "parentKind"), on(Node, "id", "kind"))
 *   ])
 *
 * Its schema is installed under its declared name, `old_tree`, which its migration's SQL and its snapshot's fingerprint
 * hold, so a suite installs it into a database no other case of it holds it in at once.
 */
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { succeeded } from "#test/support/assert.ts"
import { oldFormTreeFiles } from "#test/support/migrate/old-form-tree.files.ts"

/**
 * The old-form tree's installation as its generator left it: the snapshot its first migration reaches, that migration's
 * folder, and the old tree's two drawn law columns as its compiler named them, ‹n› (`copy`) and ‹ps›
 * (`parentStart`), with its table, which a direct writer of its rows names.
 */
export interface OldFormTree {
	readonly snapshot: DeploySnapshot
	readonly folder: FolderSource
	readonly columns: {
		readonly copy: string
		readonly parentStart: string
		readonly table: string
	}
}

/** The old-form tree's snapshot, read as the command line reads a committed one, its fingerprint checked. */
export const oldFormTree = (): OldFormTree => ({
	snapshot: succeeded(
		readSnapshot({ snapshot: oldFormTreeFiles.snapshot, manifest: oldFormTreeFiles.manifest }),
		"the old-form tree's committed snapshot reads"
	).snapshot,
	folder: oldFormTreeFiles.folder,
	columns: oldFormTreeFiles.columns
})
