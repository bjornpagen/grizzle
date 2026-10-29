import { topoOrder } from "#compiler/ir/dag.ts"
import { type ColumnRef, exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import {
	exprsOf,
	type NodeOf,
	type Occurrence,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"

/** The occurrence a delete member is anchored on, with what the deletion reads around it. */
export interface DeleteAnchor {
	/** The member's region and the one occurrence of the relation in it. */
	readonly region: Region
	readonly occurrence: Occurrence
	/** The Filters between the member's head and the region, outermost first: each predicate reads its input's heading,
	 * which is the region's. */
	readonly filters: ReadonlyArray<NodeOf<"Filter">>
}

type Region = NodeOf<"MatchRegion">

/** The column a head's expression reads, when it is a plain column of `input`. */
const columnOf = (expr: ScalarExpr, input: RelNode): string | undefined =>
	expr.kind === "column" && expr.column.node === input.id ? expr.column.name : undefined

/** The node columns the expressions `exprs` read through column references. */
const exprReads = (exprs: ReadonlyArray<ScalarExpr>): ReadonlyArray<ColumnRef> =>
	exprClosure(exprs).flatMap((e) => (e.kind === "column" ? [e.column] : []))

/** Every column reference the subtree rooted at `root` makes, its expressions' and its inputs' at any depth. */
const subtreeReads = (root: RelNode): ReadonlyArray<ColumnRef> =>
	exprReads(topoOrder({ roots: [root] }).flatMap((node) => exprsOf(node)))

/** The anchor of a delete member rooted at `head` on `relation`, or undefined when the member is not anchored.
 *
 * A deletion whose member is its relation's own facts, selected by a match.
 *
 * A described delete member often reads the relation it deletes from: the work queue's claim deletes the Wanted
 * facts its pick names, `match(pick, { key }).match(Wanted, { key, due, attempts }).find({ key, due, attempts })`.
 * Its rows are stored facts of that relation, each the fact one occurrence of the relation in the member's region
 * matched. The exact deletion compares the member against the relation, so it reads the relation twice:
 * once to evaluate the member and once to find each fact to delete, two index probes per fact where one does.
 *
 * Such a member is anchored on that occurrence: the member's head returns, as each field of the relation, the variable
 * the occurrence binds that field's column to, and only Filters lie between the head and the region. The deletion
 * then removes exactly the facts the occurrence matches in some binding of the region, so the DELETE's own target
 * plays the occurrence: the rest of the region is its USING list, each variable the occurrence shares with another
 * occurrence an equality between the target's column and that occurrence's, the occurrence's constants and the
 * Filters' predicates conditions over the target's columns.
 *
 * An anchor is recognized only where removing the occurrence leaves the rest of the region meaningful on its own: a
 * variable the occurrence alone binds may be read by the head and the Filters, which read it from the target, but by
 * nothing else in the region (an equality, a correlation, another occurrence's constant or a source's outer
 * reference), and no source reads the occurrence's own source. Otherwise the member is not anchored and the deletion
 * compares, which is exact for every member. */
export const deleteAnchor = (head: RelNode, relation: RelationInfo): DeleteAnchor | undefined => {
	const fields = relation.heading.map((c) => c.name)
	if (
		head.heading.length !== fields.length ||
		!fields.every((f) => head.heading.some((c) => c.name === f))
	) {
		return undefined
	}
	/** Each field, the column of the node below the head it is read from. */
	const below: RelNode = head.kind === "ProjectSet" ? head.input : head
	const readAs = new Map<string, string>()
	if (head.kind === "ProjectSet") {
		for (const out of head.out) {
			const column = columnOf(out.expr, head.input)
			if (column === undefined) {
				return undefined
			}
			readAs.set(out.name, column)
		}
	} else {
		for (const f of fields) {
			readAs.set(f, f)
		}
	}
	const filters: Array<NodeOf<"Filter">> = []
	let node = below
	while (node.kind === "Filter") {
		filters.push(node)
		node = node.input
	}
	if (node.kind !== "MatchRegion") {
		return undefined
	}
	const region: Region = node
	const anchored = region.occurrences.filter(
		(o) =>
			o.source.kind === "Base" &&
			o.source.relation === relation.name &&
			o.source.relationKind === "relation"
	)
	const [occurrence] = anchored
	if (occurrence === undefined || anchored.length !== 1) {
		return undefined
	}
	/** The head returns, as each field, the variable the occurrence binds that field's column to. */
	const varOf = new Map(region.vars.map((v) => [v.name, v]))
	const holds = fields.every((f) => {
		const name = readAs.get(f)
		const v = name === undefined ? undefined : varOf.get(name)
		return v !== undefined && occurrence.bindings.some((b) => b.column === f && b.var === v)
	})
	if (!holds) {
		return undefined
	}
	/** The variables the occurrence alone binds, which nothing in the rest of the region may read. */
	const others = region.occurrences.filter((o) => o.id !== occurrence.id)
	const elsewhere = new Set<VarDecl>(others.flatMap((o) => o.bindings.map((b) => b.var)))
	const alone = new Set(occurrence.bindings.flatMap((b) => (elsewhere.has(b.var) ? [] : [b.var])))
	const aloneNames = new Set([...alone].map((v) => v.name))
	if (region.equalities.some((e) => alone.has(e.a) || alone.has(e.b))) {
		return undefined
	}
	if (region.correlated.some((c) => alone.has(c.var))) {
		return undefined
	}
	const readsAnchor = (reads: ReadonlyArray<ColumnRef>): boolean =>
		reads.some(
			(r) => r.node === occurrence.source.id || (r.node === region.id && aloneNames.has(r.name))
		)
	const constants = region.occurrences.flatMap((o) => o.constants.map((c) => c.expr))
	if (readsAnchor(exprReads([...constants, ...region.correlated.map((c) => c.expr)]))) {
		return undefined
	}
	if (others.some((o) => readsAnchor(subtreeReads(o.source)))) {
		return undefined
	}
	return Object.freeze({ region, occurrence, filters: Object.freeze(filters) })
}
