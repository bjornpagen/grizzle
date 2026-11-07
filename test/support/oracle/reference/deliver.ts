import { Array as Arr } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import { exprsOf, type Heading, keptRowsOf, type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import { deliveredHeading } from "#compiler/lower/conservative/types.ts"
import {
	type Bindings,
	columnIndex,
	noBindings,
	type Reference,
	layoutOf,
	sortRows,
	tupleOf
} from "#test/support/oracle/reference/evaluate.ts"

import {
	distinctRows,
	equal,
	referenceUnsupported,
	type Row,
	valueAt
} from "#test/support/oracle/reference/values.ts"

export interface ExpectedStatement {
	readonly label: string
	/** What the statement delivers: the main relation, a heading group of a heterogeneous union, or an attachment. */
	readonly role: "main" | "headingGroup" | "attachment"
	/** The count of the heading's leading parent-key columns: an attachment's parent key, none otherwise. */
	readonly parentKeyWidth: number
	/**
	 * The statement's output columns at the query's own types: the parent key first for an attachment, the unit
	 * column for a zero-column relation.
	 */
	readonly heading: Heading
	readonly rows: ReadonlyArray<Row>
}

const unitRows = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => Arr.map(rows, () => [true])

/**
 * A delivered relation: its label, its tuples under its heading, and the nodes whose tuple a correlated child of one of
 * its attachments reads as the delivered tuple.
 */
interface Delivered {
	readonly label: string
	readonly heading: Heading
	readonly rows: ReadonlyArray<Row>
	/** The labels of the nodes of its rows' chain, which a correlated child names in its column references. */
	readonly spine: ReadonlySet<NodeId>
}

/**
 * The rows' chain from `start`: the nodes whose rows are `start`'s rows under its heading, through every node that
 * keeps its input's rows (rel.ts keptRowsOf), and the attachments among them, outermost first.
 */
const spineOf = (start: RelNode) => {
	const nodes: Array<RelNode> = []
	const attachments: Array<NodeOf<"Attach">> = []
	for (let node: RelNode | undefined = start; node !== undefined; node = keptRowsOf(node)?.input) {
		nodes.push(node)
		if (node.kind === "Attach") {
			attachments.push(node)
		}
	}
	return { nodes, labels: new Set(Arr.map(nodes, (n) => n.id)), attachments }
}

/** The columns a subtree reads from each outer node, by its label: its correlation to the tuples in scope. */
const freeColumns = (ref: Reference, root: RelNode): ReadonlyMap<NodeId, ReadonlySet<string>> => {
	const reach = ref.reach(root)
	const labels = new Set(Arr.map([...reach], (n) => n.id))
	const out = new Map<NodeId, Set<string>>()
	for (const expr of exprClosure(Arr.flatMap([...reach], (n) => exprsOf(n)))) {
		if (expr.kind !== "column" || labels.has(expr.column.node)) {
			continue
		}
		const columns = out.get(expr.column.node) ?? new Set<string>()
		columns.add(expr.column.name)
		out.set(expr.column.node, columns)
	}
	return out
}

/**
 * The root's delivered rows: the root without an OrderedResult, and the union and take a heterogeneous delivery
 * splits into heading groups.
 *
 * Any other chain to a heterogeneous union (an attachment or a filter above it) is delivered per group too, which
 * the reference does not define.
 */
const rootShape = (root: RelNode) => {
	const rows = root.kind === "OrderedResult" ? root.input : root
	const hetero = (n: RelNode): NodeOf<"Union"> | undefined =>
		n.kind === "Union" && n.groups.length > 1 ? n : undefined
	if (rows.kind === "Take" && rows.correlation.length === 0) {
		const union = hetero(rows.input)
		if (union !== undefined) {
			return { rows, take: rows, union }
		}
	}
	const union = hetero(rows)
	if (union !== undefined) {
		return { rows, union }
	}
	for (const n of spineOf(rows).nodes) {
		if (hetero(n) !== undefined) {
			throw referenceUnsupported(
				`the delivery of the heterogeneous union ${n.id} beneath ${rows.kind}`
			)
		}
	}
	return { rows }
}

const groupRows = (
	ref: Reference,
	union: NodeOf<"Union">,
	index: number,
	take: NodeOf<"Take"> | undefined
): { readonly heading: Heading; readonly rows: ReadonlyArray<Row> } => {
	const group = union.groups[index]
	if (group === undefined) {
		throw referenceUnsupported(`heading group ${index} of ${union.id}`)
	}
	const rows = distinctRows(
		Arr.flatMap(group.arms, (arm) => {
			const r = ref.eval(arm, noBindings)
			return Arr.map(r.rows, (row) =>
				Arr.map(group.heading, (c) => valueAt(row, columnIndex(r.heading, c.name, arm.id)))
			)
		}),
		group.heading,
		`heading group ${index} of ${union.id}`,
		ref.identities
	)
	if (take === undefined) {
		return { heading: group.heading, rows }
	}
	return {
		heading: group.heading,
		rows: sortRows(group.heading, rows, take.order).slice(0, Number(ref.bound(take)))
	}
}

/**
 * An attachment's parent keys over its parent's delivered rows: the key heading, the correlation's parent columns
 * and then any parent column the child reads in the parent's heading order, its distinct values, and for each the
 * scope its child is evaluated in, every node of the parent's rows' chain bound to the key tuple.
 */
interface ParentKeys {
	readonly attach: NodeOf<"Attach">
	readonly heading: Heading
	readonly keys: ReadonlyArray<{ readonly key: Row; readonly scope: Bindings }>
}

const parentKeysOf = (
	ref: Reference,
	attach: NodeOf<"Attach">,
	parent: Pick<Delivered, "heading" | "rows" | "spine">
): ParentKeys => {
	const needed = new Set(Arr.map(attach.correlation, (c) => c.parent))
	for (const [node, columns] of freeColumns(ref, attach.child)) {
		if (!parent.spine.has(node)) {
			throw referenceUnsupported(
				`${attach.id}: a child correlated with ${node}, outside its parent's rows`
			)
		}
		for (const c of columns) {
			needed.add(c)
		}
	}
	for (const name of needed) {
		columnIndex(parent.heading, name, attach.id)
	}
	const heading: Heading = Arr.filter(parent.heading, (c) => needed.has(c.name))
	const keys = distinctRows(
		Arr.map(parent.rows, (row) =>
			Arr.map(heading, (c) => valueAt(row, columnIndex(parent.heading, c.name, attach.id)))
		),
		heading,
		`the parent keys of ${attach.id}`,
		ref.identities
	)
	const layout = layoutOf(heading)
	return {
		attach,
		heading,
		keys: Arr.map(keys, (key) => {
			const tuple = tupleOf(layout, key)
			return { key, scope: new Map(Arr.map([...parent.spine], (id) => [id, tuple] as const)) }
		})
	}
}

/**
 * One attachment of a delivered relation: its statement, and the child relation it delivers, which its own
 * attachments are keyed by.
 */
const attachmentOf = (
	ref: Reference,
	attach: NodeOf<"Attach">,
	parent: Delivered
): {
	readonly statement: ExpectedStatement
	readonly delivered: Omit<Delivered, "spine" | "label">
} => {
	const { heading: keyHeading, keys } = parentKeysOf(ref, attach, parent)
	const child = attach.child
	const keyLayout = layoutOf(keyHeading)
	const out: Array<Row> = []
	const children: Array<Row> = []
	for (const { key, scope } of keys) {
		const tuple = tupleOf(keyLayout, key)
		const rel = ref.eval(attach.child, scope)
		const correlated = Arr.filter(rel.rows, (row) =>
			Arr.every(attach.correlation, (c) => {
				const column = keyHeading[columnIndex(keyHeading, c.parent, attach.id)]
				const parentValue = tuple.get(c.parent)
				if (column === undefined || parentValue === undefined) {
					throw referenceUnsupported(`${attach.id}: a parent key column ${c.parent}`)
				}
				return equal(
					parentValue,
					valueAt(row, columnIndex(rel.heading, c.child, attach.id)),
					column.type
				)
			})
		)
		for (const row of correlated) {
			const childRow = Arr.map(child.heading, (c) =>
				valueAt(row, columnIndex(rel.heading, c.name, attach.id))
			)
			children.push(childRow)
			out.push([...key, ...(child.heading.length === 0 ? [true] : childRow)])
		}
	}
	const heading: Heading = [...keyHeading, ...deliveredHeading(child.heading)]
	return {
		statement: {
			label: `${parent.label}/${attach.name}`,
			role: "attachment",
			parentKeyWidth: keyHeading.length,
			heading,
			rows: distinctRows(out, heading, `the statement of ${attach.id}`, ref.identities)
		},
		delivered: {
			heading: child.heading,
			rows: distinctRows(children, child.heading, `the children of ${attach.id}`, ref.identities)
		}
	}
}

/**
 * What a query delivers, by the reference: the statements a query's delivery defines and the expected rows of each.
 *
 * The comparison aligns statements by label (compare.ts). The reference derives its statements from the IR alone and
 * never from the program it is compared with, so a lowering that drops a heading group or an
 * attachment, attaches the wrong child under a name, keys an attachment by other parent columns, or types a column
 * differently from the query shows up as a structural difference rather than a reference built to match it:
 *
 * - the main statement delivers the root's set, under the root's heading; a zero-column set delivers one private
 *   `true` per tuple in a column named __unit, the unit tuple as a row;
 * - a heterogeneous union delivers one statement per heading group, labeled "group <i>": the set of its
 *   arms' tuples under the group's heading, the first k of them in the completed order when the union is taken;
 * - a delivered relation carries the attachments on its rows' chain: the Attach nodes reached from it through nodes
 *   whose rows are their input's rows under the same heading (an attachment, a filter, a take, an ordered result). Each
 *   is one statement labeled "<parent label>/<name>". It delivers, for every distinct parent key, the parent key
 *   followed by each child tuple correlated with it: the child is a set per parent binding, and the parent set is
 *   unchanged. The parent key is the correlation's parent columns plus any parent column the child reads, in the
 *   parent's heading order. A nested attachment's parents are the child tuples its own parent statement delivers.
 *
 * Only the generator fragment is covered; an attachment anywhere else (beneath a projection, a join, a union arm) is
 * ReferenceUnsupported rather than a guess at what it delivers.
 *
 * The statements the delivery of the query rooted at `root` defines, with their expected rows, in delivery order: a
 * statement before its attachments.
 *
 * Every attachment the query holds must be one the delivery defines.
 */
export const expectedStatements = (
	ref: Reference,
	root: RelNode
): ReadonlyArray<ExpectedStatement> => {
	const out: Array<ExpectedStatement> = []
	const covered = new Set<RelNode>()
	const push = (statement: ExpectedStatement) => {
		if (Arr.some(out, (s) => s.label === statement.label)) {
			throw referenceUnsupported(`two statements labeled ${statement.label}`)
		}
		out.push(statement)
	}
	const deliverAttachments = (parent: Delivered, start: RelNode) => {
		for (const attach of spineOf(start).attachments) {
			covered.add(attach)
			const { statement, delivered } = attachmentOf(ref, attach, parent)
			push(statement)
			const childSpine = spineOf(attach.child)
			deliverAttachments(
				{ label: statement.label, ...delivered, spine: childSpine.labels },
				attach.child
			)
		}
	}
	const shape = rootShape(root)
	if (shape.union !== undefined) {
		for (const i of shape.union.groups.keys()) {
			const { heading, rows } = groupRows(ref, shape.union, i, shape.take)
			push({
				label: `group ${i}`,
				role: "headingGroup",
				parentKeyWidth: 0,
				heading: deliveredHeading(heading),
				rows: heading.length === 0 ? unitRows(rows) : rows
			})
		}
	} else {
		const rel = ref.eval(shape.rows, noBindings)
		const label = "main"
		push({
			label,
			role: "main",
			parentKeyWidth: 0,
			heading: deliveredHeading(rel.heading),
			rows: rel.heading.length === 0 ? unitRows(rel.rows) : rel.rows
		})
		const spine = spineOf(shape.rows)
		deliverAttachments(
			{ label, heading: rel.heading, rows: rel.rows, spine: spine.labels },
			shape.rows
		)
	}
	for (const node of ref.reach(root)) {
		if (node.kind === "Attach" && !covered.has(node)) {
			throw referenceUnsupported(
				`the delivery of the attachment ${node.id}, which is not on a delivered relation's rows`
			)
		}
	}
	return out
}
