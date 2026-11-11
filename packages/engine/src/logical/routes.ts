import { compareText } from "#compiler/core/canonical.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import {
	type Heading,
	type NodeOf,
	type RelDag,
	type RelNode,
	unionArms
} from "#compiler/ir/rel.ts"
import { routable } from "#compiler/ir/scalar.ts"
import type { LogicalAnalysis } from "#compiler/logical/annotate.ts"
import type { Props } from "#compiler/logical/props.ts"

/**
 * What a read program's answer depends on, by the installed relations it reads: each stored relation, with its routes,
 * and each materialized derived relation, whose rows a refresh replaces all at once. A change of any other relation
 * changes no answer of it, and a change of a stored relation's row whose routed fields all differ from the parameters
 * they route by changes no answer under that binding.
 */
export interface Footprint {
	readonly tables: ReadonlyMap<string, Routes>
	readonly views: ReadonlySet<string>
}

/**
 * The routes of a stored relation a read program reads: each field every read of the relation fixes to one declared
 * scalar parameter of a routable carrier (ir/scalar.ts routable), to that parameter's declared name, in code point order
 * of the fields. None routes every change of the relation to every binding.
 */
export type Routes = ReadonlyMap<string, string>

/**
 * What a consumer reads of a node's rows: each column, to the parameters it is fixed to in every row the consumer's
 * answer depends on. A row whose column differs from them is one the answer does not depend on.
 */
type Restriction = ReadonlyMap<string, ReadonlySet<ParamId>>

const unrestricted: Restriction = new Map()

/** The parameters each column of a node is fixed to per evaluation (logical/props.ts Props fixed). */
const paramFixed = (props: Props): Restriction => {
	const out = new Map<string, ReadonlySet<ParamId>>()
	for (const [column, names] of props.fixed) {
		const params = names.flatMap((n) => (n.name.kind === "param" ? [n.name.param] : []))
		if (params.length > 0) {
			out.set(column, new Set(params))
		}
	}
	return out
}

/** Both restrictions at once: each column to every parameter either fixes it to. */
const joined = (a: Restriction, b: Restriction): Restriction => {
	const out = new Map<string, Set<ParamId>>()
	for (const r of [a, b]) {
		for (const [column, params] of r) {
			const held = out.get(column) ?? new Set<ParamId>()
			for (const p of params) {
				held.add(p)
			}
			out.set(column, held)
		}
	}
	return out
}

/**
 * What every consumer's restriction holds: each column all of them fix, to the parameters all of them fix it to. A row
 * any one consumer depends on is one the program's answer depends on.
 */
const common = (received: ReadonlyArray<Restriction>): Restriction => {
	const [first, ...rest] = received
	if (first === undefined) {
		return unrestricted
	}
	const out = new Map<string, ReadonlySet<ParamId>>()
	for (const [column, params] of first) {
		const kept = [...params].filter((p) => rest.every((r) => r.get(column)?.has(p) === true))
		if (kept.length > 0) {
			out.set(column, new Set(kept))
		}
	}
	return out
}

/** A restriction closed under a node's classes of equal columns: a column equal to a fixed one is fixed alike. */
const closedUnder = (props: Props, r: Restriction): Restriction => {
	const out = new Map<string, Set<ParamId>>()
	for (const [column, params] of r) {
		for (const member of props.classes.get(column) ?? [column]) {
			const held = out.get(member) ?? new Set<ParamId>()
			for (const p of params) {
				held.add(p)
			}
			out.set(member, held)
		}
	}
	return out
}

/** The restriction on the columns `columns` names, each kept under its own name. */
const within = (r: Restriction, columns: Iterable<string>): Restriction => {
	const out = new Map<string, ReadonlySet<ParamId>>()
	for (const column of columns) {
		const params = r.get(column)
		if (params !== undefined) {
			out.set(column, params)
		}
	}
	return out
}

/** The restriction on a heading's columns. */
const onHeading = (r: Restriction, heading: Heading): Restriction =>
	within(
		r,
		heading.map((c) => c.name)
	)

/** The restriction carried along `pairs`, each consumer column's parameters given to the input column it pairs with. */
const carried = (
	r: Restriction,
	pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>
): Restriction => {
	const out = new Map<string, Set<ParamId>>()
	for (const { from, to } of pairs) {
		const params = r.get(from)
		if (params === undefined) {
			continue
		}
		const held = out.get(to) ?? new Set<ParamId>()
		for (const p of params) {
			held.add(p)
		}
		out.set(to, held)
	}
	return out
}

/**
 * What a match region's occurrence reads of its source's rows: each source column bound to a variable the region's
 * restriction fixes, and each one the occurrence fixes to a parameter itself. A region's rows are the joins of its
 * occurrences' rows, each bound column equal to its variable, so a source row whose bound column differs from its
 * variable's parameter joins into no row the answer depends on.
 */
const occurrenceReads = (
	occurrence: NodeOf<"MatchRegion">["occurrences"][number],
	r: Restriction
): Restriction =>
	joined(
		carried(
			r,
			occurrence.bindings.map((b) => ({ from: b.var.name, to: b.column }))
		),
		new Map(
			occurrence.constants.flatMap((c) =>
				c.expr.kind === "param" ? [[c.column, new Set([c.expr.param])] as const] : []
			)
		)
	)

/**
 * What a node gives each of its inputs, from what its own consumers read of it (`r`, closed under its classes): an input
 * whose row the node keeps as it is, under its own columns, is read as the node is; a join's other side through the
 * columns it pairs; a fold, a window or an ordered set through the columns it groups by, whose groups' rows are each
 * group's own; a projection through the columns it outputs as they are; an attachment's child through its
 * correlation. A node whose rows each depend on every row of its input (a take, a nearest search, a recursion, a
 * producer) restricts nothing it reads. A source reads no node.
 */
const reads = (node: RelNode, r: Restriction): ReadonlyArray<readonly [RelNode, Restriction]> => {
	switch (node.kind) {
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "SelfRef":
			return []
		case "MatchRegion":
			return node.occurrences.map((o) => [o.source, occurrenceReads(o, r)] as const)
		case "Filter":
		case "OrderedResult":
			return [[node.input, onHeading(r, node.input.heading)]]
		case "Forbid":
			return [[node.violation, onHeading(r, node.violation.heading)]]
		case "ProjectSet":
			return [
				[
					node.input,
					carried(
						r,
						node.out.flatMap((o) =>
							o.expr.kind === "column" && o.expr.column.node === node.input.id
								? [{ from: o.name, to: o.expr.column.name }]
								: []
						)
					)
				]
			]
		case "SemiJoin":
		case "AntiJoin":
			return [
				[node.left, onHeading(r, node.left.heading)],
				[
					node.right,
					carried(
						r,
						node.on.map((p) => ({ from: p.left, to: p.right }))
					)
				]
			]
		case "Intersect":
		case "Difference":
			return [
				[node.left, onHeading(r, node.left.heading)],
				[node.right, onHeading(r, node.right.heading)]
			]
		case "Union":
			return unionArms(node.groups).map((arm) => [arm, onHeading(r, arm.heading)] as const)
		case "Group":
		case "OrderedSetAggregate":
			return [[node.input, within(r, node.keys)]]
		case "Window":
			return [[node.input, within(r, node.partition)]]
		case "Attach":
			return [
				[node.parent, onHeading(r, node.parent.heading)],
				[
					node.child,
					carried(
						r,
						node.correlation.map((c) => ({ from: c.parent, to: c.child }))
					)
				]
			]
		case "Take":
		case "Produce":
			return [[node.input, unrestricted]]
		case "ApproximateNearest":
			return [[node.source, unrestricted]]
		case "Recursive":
			return [
				[node.base, unrestricted],
				[node.step, unrestricted],
				[node.self, unrestricted]
			]
	}
}

/**
 * The footprint of a read program (Footprint), over its DAG at the base level, every world relation it reads its
 * definition (program/workload/world.ts inlineWorlds), and the logical analysis of that DAG, `analysis`, whose fixed
 * facts it reads; `params` are the program's declared parameters.
 *
 * What the answer depends on is read from the roots down: a root's every row; then each node's, what every consumer of
 * it reads of its rows (`common`), joined with the parameters its own fixed facts fix each column to and closed under
 * its classes; then what it reads of each input (`reads`). A Base reads its relation through its occurrence, so a field
 * of a stored relation routes by a parameter when every Base over the relation fixes it to that parameter; a field of a
 * carrier whose PostgreSQL text is not its codec's text routes nothing. A Base over a world relation is no node of a
 * base-level DAG.
 */
export const footprintOf = (
	dag: RelDag,
	analysis: LogicalAnalysis,
	params: ReadonlyArray<ParamDecl>
): Footprint => {
	const received = new Map<NodeId, Array<Restriction>>()
	const receive = (node: RelNode, r: Restriction): void => {
		const held = received.get(node.id)
		if (held === undefined) {
			received.set(node.id, [r])
		} else {
			held.push(r)
		}
	}
	for (const root of dag.roots) {
		receive(root, unrestricted)
	}
	const scans = new Map<string, Array<{ readonly heading: Heading; readonly r: Restriction }>>()
	const views = new Set<string>()
	for (const node of topoOrder(dag).toReversed()) {
		const props = analysis.of(node).props
		const r = closedUnder(props, joined(common(received.get(node.id) ?? []), paramFixed(props)))
		if (node.kind === "Base") {
			switch (node.relationKind) {
				case "relation":
					scans.set(node.relation, [
						...(scans.get(node.relation) ?? []),
						{ heading: node.heading, r }
					])
					break
				case "derived":
					views.add(node.relation)
					break
				case "world":
					throw defect(`a base-level program reads no world relation; it reads ${node.relation}`)
			}
		}
		for (const [input, read] of reads(node, r)) {
			receive(input, read)
		}
	}
	const named = new Map(
		params.flatMap((p) => (p.kind === "scalar" ? [[p.id, p.name] as const] : []))
	)
	const tables = new Map<string, Routes>()
	for (const relation of [...scans.keys()].toSorted(compareText)) {
		const occurrences = scans.get(relation) ?? []
		const fixed = common(occurrences.map((o) => o.r))
		const routes: Array<readonly [string, string]> = []
		for (const column of occurrences[0]?.heading ?? []) {
			const [param] = [...(fixed.get(column.name) ?? [])]
				.flatMap((p) => {
					const name = named.get(p)
					return name === undefined ? [] : [name]
				})
				.toSorted(compareText)
			if (param !== undefined && routable[column.type.carrier]) {
				routes.push([column.name, param])
			}
		}
		tables.set(relation, new Map(routes.toSorted(([a], [b]) => compareText(a, b))))
	}
	return { tables, views: new Set([...views].toSorted(compareText)) }
}
