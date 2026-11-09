import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { SelectionKey } from "#compiler/ir/physical.ts"
import type { HeadingColumn, NodeOf, Occurrence, VarDecl } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	distinctSelect,
	type Env,
	extendEnv,
	type InputSource,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import type { Expr, FromSource, Target } from "#compiler/sql/ast.ts"
import { col, target, unitTargets } from "#compiler/sql/build.ts"

type Region = NodeOf<"MatchRegion">

/** The first occurrence for which `ready` holds and its position, if one does. */
const firstReady = (
	pending: ReadonlyArray<Occurrence>,
	ready: (o: Occurrence) => boolean
): { readonly occurrence: Occurrence; readonly position: number } | undefined => {
	for (const [position, occurrence] of pending.entries()) {
		if (ready(occurrence)) {
			return { occurrence, position }
		}
	}
	return undefined
}

/** Whether an expression reads no column: a literal, or an operation over literals alone. */
const readsNoColumn = (e: ScalarExpr): boolean => e.kind !== "column" && e.args.every(readsNoColumn)

/**
 * Whether two expressions that read no column compute one value by the same operations: one structure, operators,
 * casts and literals, at one type. Any other kind is no match, which only leaves a read unprobed.
 */
const sameValue = (x: ScalarExpr, y: ScalarExpr): boolean => {
	if (!sameScalarType(x.type, y.type) || x.args.length !== y.args.length) {
		return false
	}
	const args = (): boolean =>
		x.args.every((a, i) => {
			const b = y.args[i]
			return b !== undefined && sameValue(a, b)
		})
	if (x.kind === "literal") {
		return y.kind === "literal" && canonicalEquals(x.value, y.value, everyProperty)
	}
	if (x.kind === "op") {
		return y.kind === "op" && x.op === y.op && args()
	}
	if (x.kind === "cast") {
		return y.kind === "cast" && x.cast === y.cast && args()
	}
	return false
}

/**
 * Whether a guard conjunct of a selection key holds as one of an occurrence's constants: an equality of a field of the
 * occurrence's relation, matched by its name, with a value reading no column, which the occurrence fixes that field to
 * by a structurally equal value.
 */
const holdsAsConstant = (g: ScalarExpr, fixed: ReadonlyMap<string, ScalarExpr>): boolean => {
	if (g.kind !== "op" || nativeOp(g.op)?.fn !== "eq" || g.args.length !== 2) {
		return false
	}
	const [a, b] = g.args
	const fixes = (column: ScalarExpr | undefined, value: ScalarExpr | undefined): boolean => {
		if (column?.kind !== "column" || value === undefined || !readsNoColumn(value)) {
			return false
		}
		const constant = fixed.get(column.column.name)
		return constant !== undefined && sameValue(value, constant)
	}
	return fixes(a, b) || fixes(b, a)
}

/**
 * The selection keys an occurrence of a stored relation is probed by (ir/physical.ts SelectionKey): each key every
 * conjunct of whose guard holds as one of the occurrence's constants, as a set over the ordered selection, and whose
 * term's field the occurrence fixes by a constant. That field's constant is compared with the key's law column instead
 * of the field, which the key's UNIQUE index serves: exactly, since the column is the field where every conjunct holds
 * and NULL elsewhere, and no constant is NULL. The guard's own constants stay, redundant beside it. A source more
 * than one occurrence matches is shared, and none of its occurrences is probed.
 */
const probeKeys = (cx: LowerContext, o: Occurrence): ReadonlyArray<SelectionKey> => {
	const source = o.source
	if (source.kind !== "Base" || source.relationKind !== "relation") {
		return []
	}
	const fixed = new Map(o.constants.map((c) => [c.column, c.expr] as const))
	return cx.names
		.selectionKeys(source.relation)
		.filter((k) => fixed.has(k.field) && k.guard.every((g) => holdsAsConstant(g, fixed)))
}

/**
 * A Base occurrence's source read beside the law columns of `keys`: each added to the scan's targets under a fresh
 * column of the derived table, by its term's field. A scan the lowering spells as no plain core over its one table
 * is read as it is, unprobed.
 */
const withLawColumns = (
	cx: LowerContext,
	o: Occurrence,
	source: InputSource,
	keys: ReadonlyArray<SelectionKey>
): { readonly source: InputSource; readonly probed: ReadonlyMap<string, Expr> } | undefined => {
	const item = source.item
	if (item.kind !== "derived" || item.query.body.kind !== "core" || o.source.kind !== "Base") {
		return undefined
	}
	const scan = item.query.body
	const [table, ...more] = scan.from
	if (table?.kind !== "table" || more.length > 0 || !isNonEmpty(keys)) {
		return undefined
	}
	const added = mapNonEmpty(keys, (k) => ({
		key: k,
		column: cx.supply.column({ kind: "node", node: o.source.id })
	}))
	const lawTargets = mapNonEmpty(added, (a) => target(col(table.alias, a.key.column)))
	const body =
		scan.distinct === false
			? { ...scan, targets: [...scan.targets, ...lawTargets] }
			: { ...scan, targets: extendNonEmpty(scan.targets, lawTargets) }
	const widened = {
		...item,
		query: { ...item.query, body },
		columns: [...item.columns, ...added.map((a) => a.column)]
	}
	return {
		source: { ...source, item: widened, columns: widened.columns },
		probed: new Map(added.map((a) => [a.key.field, col(source.alias, a.column)] as const))
	}
}

/** The labels of the nodes local to the region, which column references name: itself and its occurrences' sources. */
const localNodes = (node: Region): ReadonlySet<NodeId> =>
	new Set([node.id, ...node.occurrences.map((o) => o.source.id)])

/** The labels of the source nodes that more than one occurrence of the region matches. */
const sharedSources = (node: Region): ReadonlySet<NodeId> => {
	const seen = new Set<NodeId>()
	const shared = new Set<NodeId>()
	for (const o of node.occurrences) {
		if (seen.has(o.source.id)) {
			shared.add(o.source.id)
		}
		seen.add(o.source.id)
	}
	return shared
}

const ambiguous = (node: Region, source: NodeId, reader: string): never =>
	refuse(
		"MalformedDescription",
		nodeLabel(node),
		`an outer reference from ${reader} to one occurrence: the source ${source} is matched by several occurrences of the region, so a reference to it names none of them`
	)

/** The variables of the region and the occurrence sources an occurrence's source reads through outer references. */
const occurrenceNeeds = (
	cx: LowerContext,
	node: Region,
	o: Occurrence,
	shared: ReadonlySet<NodeId>
): { readonly vars: ReadonlySet<string>; readonly sources: ReadonlySet<NodeId> } => {
	const refs = [...cx.freeRefs(o.source)]
	const vars = new Set(refs.flatMap(([ref, columns]) => (ref === node.id ? [...columns] : [])))
	const sources = new Set<NodeId>()
	for (const [ref] of refs) {
		if (
			ref === node.id ||
			ref === o.source.id ||
			!node.occurrences.some((other) => other.source.id === ref)
		) {
			continue
		}
		if (shared.has(ref)) {
			ambiguous(node, ref, `the source ${o.source.id} of occurrence ${o.id}`)
		}
		sources.add(ref)
	}
	return { vars, sources }
}

/** Whether an expression reads a node local to the region; a read of a shared source is refused as ambiguous. */
const readsLocal = (
	node: Region,
	expr: ScalarExpr,
	local: ReadonlySet<NodeId>,
	shared: ReadonlySet<NodeId>
): boolean =>
	exprClosure([expr]).some((x) => {
		if (x.kind !== "column") {
			return false
		}
		if (shared.has(x.column.node)) {
			ambiguous(node, x.column.node, `expression ${expr.id}`)
		}
		return local.has(x.column.node)
	})

/** One occurrence of a lowered region: its derived table, the table's alias, and the source's columns through it. */
export interface PlacedOccurrence {
	readonly occurrence: Occurrence
	readonly item: FromSource
	readonly alias: string
	readonly map: ColumnMap
}

/**
 * A region lowered to its parts: the targets over its variables, its occurrences' derived tables in placement order
 * (each correlated one after what it reads), and the conditions over them. The conservative lowering reads them as one
 * FROM list under WHERE; the optimized one may order them as a JOIN chain (shapes/region).
 */
interface RegionParts {
	readonly targets: NonEmptyReadonlyArray<Target>
	/** The value of each column of the region's heading, in heading order. */
	readonly columns: ReadonlyArray<{ readonly column: HeadingColumn; readonly value: Expr }>
	readonly occurrences: ReadonlyArray<PlacedOccurrence>
	readonly conditions: ReadonlyArray<Expr>
}

/**
 * MatchRegion: a rule's connected matches, the set of its complete variable bindings.
 *
 *   SELECT DISTINCT r2.c1, r3.c4
 *   FROM (<source 1>) AS r2(c1, c2), (<source 2>) AS r3(c3, c4)
 *   WHERE r3.c3 = r2.c2 AND r2.c1 = $1::uuid
 *
 * Each occurrence reads its source as a derived table. A variable takes its value from the first column bound to it;
 * every further column bound to it, every equality between variables, every constant and every correlation becomes an
 * equality in WHERE, at the variable's or column's type, so two vectors compare through the extension's qualified
 * operator (vector/equality.ts). Unbound columns are existential witnesses and are simply not selected.
 * The region's heading is its variables, and the bindings are a set: SELECT DISTINCT over the variables,
 * so a witness repeated by fanout or a key the baseline does not trust never repeats a binding.
 *
 * A source whose subtree reads the region's variables or another occurrence's source through outer references is
 * correlated: it is placed after the occurrences that bind what it reads, as a LATERAL derived table. A variable bound
 * nowhere takes the value of its correlation or of a variable it is equated with. A cycle of correlations, or a
 * variable with no value, is refused.
 *
 * One source node may be matched by several occurrences (a shared query matched twice): each occurrence is its own
 * derived table with its own columns, so bindings and constants read the occurrence's columns, never the node's. An
 * outer reference names a node, not an occurrence, so a reference to a source node that several occurrences share
 * does not say which of them it reads, and is refused as MalformedDescription.
 */
const lowerMatchRegion: NodeLowerer<"MatchRegion"> = (node, cx, env) => {
	const parts = regionParts(node, cx, env)
	return distinctSelect(
		parts.targets,
		parts.occurrences.map((o) => o.item),
		parts.conditions
	)
}

/**
 * Constants fix source columns; they are evaluated with the whole region in scope. Every variable a binding, an
 * equality or a correlation names is one the region declares, and every column a binding or a constant names is one of
 * its source's heading (valid DAG).
 */
export const regionParts = (node: Region, cx: LowerContext, env: Env): RegionParts => {
	const at = nodeLabel(node)
	const local = localNodes(node)
	const varOf = new Map(node.vars.map((v) => [v.name, v]))
	/** Every comparison of a variable is at its type: a vector compares through the extension's qualified operator. */
	const equal = (v: VarDecl, a: Expr, b: Expr): Expr => cx.equal(v.type, a, b)
	const value = new Map<VarDecl, Expr>()
	const where: Array<Expr> = []
	/** A variable's first value is its value; every later one is compared with it. */
	const bindValue = (v: VarDecl, e: Expr): void => {
		const prior = value.get(v)
		if (prior === undefined) {
			value.set(v, e)
		} else {
			where.push(equal(v, prior, e))
		}
	}
	const from: Array<PlacedOccurrence> = []
	const shared = sharedSources(node)
	/** Each probed occurrence's law columns, by the field each stands for (`probeKeys`). */
	const probes = new Map<Occurrence, ReadonlyMap<string, Expr>>()
	/**
	 * Each placed occurrence's columns, and, for a source node only one occurrence matches, the node's columns: the
	 * scope a correlated source's outer references resolve in.
	 */
	const placedSources = new Map<NodeId, ColumnMap>()

	const regionColumns = (): ColumnMap => {
		const map = new Map<string, Expr>()
		for (const [v, e] of value) {
			map.set(v.name, e)
		}
		return map
	}
	const scope = (): Env => extendEnv(env, [...placedSources.entries(), [node.id, regionColumns()]])

	const bound = new Set(node.occurrences.flatMap((o) => o.bindings.map((b) => b.var)))
	/** A variable bound by no occurrence takes its correlation's value when that reads nothing local. */
	const deferred: Array<Region["correlated"][number]> = []
	for (const c of node.correlated) {
		const readsRegion = readsLocal(node, c.expr, local, shared)
		if (!bound.has(c.var) && !value.has(c.var) && !readsRegion) {
			value.set(c.var, lowerExpr(cx, c.expr, env))
		} else {
			deferred.push(c)
		}
	}

	/** Place occurrences in declared order, each once everything it reads is in scope. */
	const pending = [...node.occurrences]
	while (pending.length > 0) {
		const ready = firstReady(pending, (o) => {
			const needs = occurrenceNeeds(cx, node, o, shared)
			const varsReady = [...needs.vars].every((name) => {
				const v = varOf.get(name)
				return v !== undefined && value.has(v)
			})
			const sourcesReady = [...needs.sources].every((s) => placedSources.has(s))
			return varsReady && sourcesReady
		})
		if (ready === undefined) {
			return refuse(
				"UnsupportedOperation",
				at,
				"an order of the region's occurrences in which every correlated source follows what it reads"
			)
		}
		const o = ready.occurrence
		pending.splice(ready.position, 1)
		const needs = occurrenceNeeds(cx, node, o, shared)
		const correlated = needs.vars.size > 0 || needs.sources.size > 0
		const read = cx.sourceAs(o.source, scope(), correlated)
		const probe = shared.has(o.source.id)
			? undefined
			: withLawColumns(cx, o, read, probeKeys(cx, o))
		const source = probe?.source ?? read
		if (probe !== undefined) {
			probes.set(o, probe.probed)
		}
		from.push({ occurrence: o, item: source.item, alias: source.alias, map: source.map })
		if (!shared.has(o.source.id)) {
			placedSources.set(o.source.id, source.map)
		}
		for (const b of o.bindings) {
			bindValue(b.var, columnIn(source.map, b.column))
		}
	}

	/** Each placed occurrence once, in declared order. */
	const declared = from.toSorted(
		(a, b) => node.occurrences.indexOf(a.occurrence) - node.occurrences.indexOf(b.occurrence)
	)
	for (const { occurrence: o, map: columns } of declared) {
		for (const c of o.constants) {
			readsLocal(node, c.expr, local, shared)
			const type = columnType(o.source.heading, c.column)
			const probed = probes.get(o)?.get(c.column)
			where.push(
				cx.equal(type, probed ?? columnIn(columns, c.column), lowerExpr(cx, c.expr, scope()))
			)
		}
	}

	/** Equalities: an unbound variable takes its partner's value; two bound ones are compared. Each round settles
	 * every equality it can, in order, and keeps the rest, until a round settles none. */
	let equalities: ReadonlyArray<Region["equalities"][number]> = node.equalities
	let progress = true
	while (progress) {
		const unsettled: Array<Region["equalities"][number]> = []
		for (const e of equalities) {
			const a = value.get(e.a)
			const b = value.get(e.b)
			if (a !== undefined && b !== undefined) {
				if (e.a !== e.b) {
					where.push(equal(e.a, a, b))
				}
			} else if (a !== undefined) {
				value.set(e.b, a)
			} else if (b !== undefined) {
				value.set(e.a, b)
			} else {
				unsettled.push(e)
			}
		}
		progress = unsettled.length < equalities.length
		equalities = unsettled
	}

	const unresolved = equalities[0]
	if (unresolved !== undefined) {
		return refuse(
			"MalformedDescription",
			at,
			`a value for ${unresolved.a.name} or ${unresolved.b.name}: a binding or a correlation`
		)
	}

	for (const c of deferred) {
		bindValue(c.var, lowerExpr(cx, c.expr, scope()))
	}

	const columns = node.heading.map((column) => {
		const v = varOf.get(column.name)
		const e = v === undefined ? undefined : value.get(v)
		if (e === undefined) {
			return refuse(
				"MalformedDescription",
				at,
				`a value for the variable ${column.name}: a binding, an equality or a correlation`
			)
		}
		return { column, value: e }
	})
	const targets = isNonEmpty(columns) ? mapNonEmpty(columns, (c) => target(c.value)) : unitTargets
	return { targets, columns, occurrences: from, conditions: where }
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const matchRegionLowering: Lowerers<"MatchRegion"> = { MatchRegion: lowerMatchRegion }
