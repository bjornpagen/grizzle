import { Array as Arr, Order } from "effect"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { type NodeOf, type RelNode, unionArms } from "#compiler/ir/rel.ts"
import { routable } from "#compiler/ir/scalar.ts"
import type { Footprint } from "#compiler/logical/routes.ts"
import type { AnalyzedQuery } from "#compiler/program/workload/compile.ts"
import type { ServedFootprint } from "#compiler/served/forms.ts"

/**
 * A second reading of a read program's footprint (logical/routes.ts footprintOf), over the same base-level DAG and the
 * same logical analysis's fixed facts, read the other way: footprintOf pushes what each node's consumers read of its
 * rows down from the roots; this climbs each field of each Base up every path to a root, through the nodes that carry
 * its value, and asks where on each path a fixed fact or an occurrence's constant ties it to a parameter.
 *
 * One edge of a consumer over its input, as a field's value climbs it: the consumer's columns an input column's value
 * is in every row the consumer's answer reads (`up`), and the parameters the edge itself fixes an input column to (an
 * occurrence's constants). A node whose every row may depend on every input row (a take, a nearest search, a producer,
 * a recursion) carries no column: no restriction above it reaches what it reads. A fold, an ordered set and a window
 * carry their group's columns alone, a join's other side its paired columns, an attachment's child its correlated ones.
 */
interface Climb {
	readonly consumer: RelNode
	readonly up: (column: string) => ReadonlyArray<string>
	readonly fixes: (column: string) => ReadonlyArray<ParamId>
}

const none = (): ReadonlyArray<string> => []

const unfixed = (): ReadonlyArray<ParamId> => []

const same = (column: string): ReadonlyArray<string> => [column]

/** The occurrence's climb: each source column to the variables it binds, and to the parameters it is fixed to. */
const occurrenceClimb = (
	node: RelNode,
	o: NodeOf<"MatchRegion">["occurrences"][number]
): readonly [RelNode, Climb] => [
	o.source,
	{
		consumer: node,
		up: (column) =>
			Arr.map(
				Arr.filter(o.bindings, (b) => b.column === column),
				(b) => b.var.name
			),
		fixes: (column) =>
			Arr.flatMap(o.constants, (c) =>
				c.column === column && c.expr.kind === "param" ? [c.expr.param] : []
			)
	}
]

/** Each input of `node` with the climb its edge offers a column of it, an input reached twice once per edge. */
const climbsOf = (node: RelNode): ReadonlyArray<readonly [RelNode, Climb]> => {
	const climb = (input: RelNode, up: Climb["up"]): readonly [RelNode, Climb] => [
		input,
		{ consumer: node, up, fixes: unfixed }
	]
	switch (node.kind) {
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "SelfRef":
			return []
		case "MatchRegion":
			return Arr.map(node.occurrences, (o) => occurrenceClimb(node, o))
		case "Filter":
		case "OrderedResult":
			return [climb(node.input, same)]
		case "Forbid":
			return [climb(node.violation, same)]
		case "ProjectSet":
			return [
				climb(node.input, (column) =>
					Arr.flatMap(node.out, (o) =>
						o.expr.kind === "column" &&
						o.expr.column.node === node.input.id &&
						o.expr.column.name === column
							? [o.name]
							: []
					)
				)
			]
		case "SemiJoin":
		case "AntiJoin":
			return [
				climb(node.left, same),
				climb(node.right, (column) =>
					Arr.map(
						Arr.filter(node.on, (p) => p.right === column),
						(p) => p.left
					)
				)
			]
		case "Intersect":
		case "Difference":
			return [climb(node.left, same), climb(node.right, same)]
		case "Union": {
			const heading = new Set(Arr.map(node.heading, (c) => c.name))
			return Arr.map(unionArms(node.groups), (arm) =>
				climb(arm, (column) => (heading.has(column) ? [column] : []))
			)
		}
		case "Group":
		case "OrderedSetAggregate":
			return [climb(node.input, (column) => (Arr.contains(node.keys, column) ? [column] : []))]
		case "Window":
			return [climb(node.input, (column) => (Arr.contains(node.partition, column) ? [column] : []))]
		case "Attach":
			return [
				climb(node.parent, same),
				climb(node.child, (column) =>
					Arr.map(
						Arr.filter(node.correlation, (c) => c.child === column),
						(c) => c.parent
					)
				)
			]
		case "Take":
		case "Produce":
			return [climb(node.input, none)]
		case "ApproximateNearest":
			return [climb(node.source, none)]
		case "Recursive":
			return [climb(node.base, none), climb(node.step, none), climb(node.self, none)]
	}
}

/** What every set of `sets` holds; nothing for no set. */
const everyOf = (sets: ReadonlyArray<ReadonlySet<ParamId>>): ReadonlySet<ParamId> => {
	const [first, ...rest] = sets
	return first === undefined
		? new Set()
		: new Set(Arr.filter([...first], (p) => Arr.every(rest, (s) => s.has(p))))
}

/** Texts in code point order. */
const sorted = (texts: Iterable<string>): ReadonlyArray<string> => Arr.sort(texts, Order.String)

/**
 * The footprint of a read program by climbing (see the header): over its base-level DAG, as its plan reads it
 * (program/workload/compile.ts workloadQueryRead), the logical analysis of that DAG, and its declared parameters. A Base's field is tied to a parameter on a path when a
 * node on it fixes a column carrying the field's value (or one equal to it there, by the node's classes) to that
 * parameter, or an edge on it is an occurrence's constant of it; it is tied for the program when it is on every path to
 * a root, and a root's own answer reads every row, so a path that reaches a root untied ties nothing. A stored
 * relation's field routes by the least-named declared scalar parameter every Base over it ties it to, its carrier
 * routable; a materialized view is read whole.
 */
export const climbedFootprint = ({ dag, analysis, params }: AnalyzedQuery): Footprint => {
	const order = topoOrder(dag)
	const consumers = new Map<NodeId, Array<Climb>>()
	for (const node of order) {
		for (const [input, climb] of climbsOf(node)) {
			consumers.set(input.id, [...(consumers.get(input.id) ?? []), climb])
		}
	}
	const roots = new Set(Arr.map(dag.roots, (r) => r.id))
	const memo = new Map<string, ReadonlySet<ParamId>>()
	const tied = (node: RelNode, carrying: ReadonlySet<string>): ReadonlySet<ParamId> => {
		const props = analysis.of(node).props
		const columns = new Set(Arr.flatMap([...carrying], (c) => [c, ...(props.classes.get(c) ?? [])]))
		const at = `${node.id} ${Arr.join(sorted(columns), " ")}`
		const known = memo.get(at)
		if (known !== undefined) {
			return known
		}
		const here = Arr.flatMap([...columns], (c) =>
			Arr.flatMap(props.fixed.get(c) ?? [], (n) => (n.name.kind === "param" ? [n.name.param] : []))
		)
		const above = [
			...(roots.has(node.id) ? [new Set<ParamId>()] : []),
			...Arr.map(consumers.get(node.id) ?? [], (climb) => {
				const next = new Set(Arr.flatMap([...columns], (c) => climb.up(c)))
				const edge = Arr.flatMap([...columns], (c) => climb.fixes(c))
				return new Set([...edge, ...(next.size === 0 ? [] : tied(climb.consumer, next))])
			})
		]
		const out = new Set([...here, ...everyOf(above)])
		memo.set(at, out)
		return out
	}
	const named = new Map(
		Arr.flatMap(params, (p) => (p.kind === "scalar" ? [[p.id, p.name] as const] : []))
	)
	const scans = new Map<string, Array<NodeOf<"Base">>>()
	const views = new Set<string>()
	for (const node of order) {
		if (node.kind === "Base") {
			if (node.relationKind === "derived") {
				views.add(node.relation)
			} else {
				scans.set(node.relation, [...(scans.get(node.relation) ?? []), node])
			}
		}
	}
	const tables = new Map<string, ReadonlyMap<string, string>>()
	for (const relation of sorted(scans.keys())) {
		const bases = scans.get(relation) ?? []
		const [first] = bases
		const routes: Array<readonly [string, string]> = []
		for (const column of first?.heading ?? []) {
			const [param] = sorted(
				Arr.flatMap([...everyOf(Arr.map(bases, (b) => tied(b, new Set([column.name]))))], (p) => {
					const name = named.get(p)
					return name === undefined ? [] : [name]
				})
			)
			if (param !== undefined && routable[column.type.carrier]) {
				routes.push([column.name, param])
			}
		}
		tables.set(relation, new Map(routes))
	}
	return { tables, views: new Set(sorted(views)) }
}

/**
 * A footprint as a served read names it, under the installation's names `names`: each table and view by its installed
 * identifier, each routed field by its installed column; read off the naming door, never through program/served.ts.
 */
export const installedFootprint = (footprint: Footprint, names: PhysicalNames): ServedFootprint => {
	const out: Record<string, Readonly<Record<string, string>>> = {}
	for (const [relation, routes] of footprint.tables) {
		const columns: Record<string, string> = {}
		for (const [field, param] of routes) {
			columns[names.column(relation, field)] = param
		}
		out[names.relation(relation).name] = columns
	}
	for (const view of footprint.views) {
		out[names.relation(view).name] = {}
	}
	return out
}
