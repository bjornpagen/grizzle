import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { SelectionKey } from "#compiler/ir/physical.ts"
import type { HeadingColumn, NodeOf, Occurrence, VarDecl } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import {
	evaluationQuery,
	evaluationWidth,
	readsOnlyParameters
} from "#compiler/lower/conservative/call/index.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	type EvaluationLookup,
	extendEnv,
	type InputSource,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse,
	wholeSelect
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import type { Expr, FromSource, Target } from "#compiler/sql/ast.ts"
import {
	col,
	conjunction,
	derived,
	select,
	target,
	targetAs,
	unitTargets
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"

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
		return y.kind === "literal" && canonicalEquals(x.value, y.value)
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
	const lawTargets = mapNonEmpty(added, (a) => targetAs(col(table.alias, a.key.column), a.column))
	const body =
		scan.distinct === false
			? { ...scan, targets: [...scan.targets, ...lawTargets] }
			: { ...scan, targets: extendNonEmpty(scan.targets, lawTargets) }
	const widened = derived({ ...item.query, body }, item.alias, item.lateral)
	return {
		source: {
			...source,
			item: widened,
			columns: [...source.columns, ...added.map((a) => a.column)]
		},
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
 * How a region reads an occurrence at the values other occurrences' rows bind, a row site (lower/shapes/region
 * keyedChain): the occurrences it reads those values from, which the region places before it, and its source read at
 * their columns, `columnsOf` each placed occurrence's, in the region's scope `scope`. Every occurrence no site names is
 * read in the region's scope as it stands.
 */
export interface RowSite {
	readonly after: ReadonlyArray<Occurrence>
	readonly read: (columnsOf: (o: Occurrence) => ColumnMap, scope: Env) => InputSource
}

/** The row sites of a region, by occurrence: none in a region read as it stands. */
export type RowSites = ReadonlyMap<Occurrence, RowSite>

export const noRowSites: RowSites = new Map()

/**
 * A region lowered to its parts: the targets over its variables, its occurrences' derived tables in placement order
 * (each correlated one after what it reads), its FROM list, those tables in that order and before the first of the
 * occurrences that read one the evaluation of a call it hosts (regionEvaluations), and the conditions over them. The
 * conservative lowering reads its FROM list under WHERE; the optimized one may order its occurrences as a JOIN chain
 * (shapes/region) where the list is their tables alone.
 */
interface RegionParts {
	readonly targets: NonEmptyReadonlyArray<Target>
	/** The value of each column of the region's heading, in heading order. */
	readonly columns: ReadonlyArray<{ readonly column: HeadingColumn; readonly value: Expr }>
	readonly occurrences: ReadonlyArray<PlacedOccurrence>
	readonly from: ReadonlyArray<FromSource>
	/** The region's conditions with each variable's bindings equated in placement order (conditionsIn). */
	readonly conditions: ReadonlyArray<Expr>
	/**
	 * The region's conditions with each variable's bindings equated in the order `aliases` reads the occurrences: each
	 * binding after the first in that order compared with the first, every equality between two variables and every
	 * correlation of a bound one stated at the first binding of each in that order, the constants as placed. A lowering
	 * that fixes the order its occurrences are read in (a keyed chain, a JOIN chain) states them in that order, so each
	 * step's terms bind every variable an earlier step bound, where comparing each binding with the one placement put
	 * first left a variable the chain bound early unequated until the step that read that binding, last in the chain: three
	 * derivations a sitting read at a member's package and test, their member's place equated only to the member's own
	 * read after them, joined as a product of 34 rows each per item.
	 */
	readonly conditionsIn: (aliases: ReadonlyArray<string>) => ReadonlyArray<Expr>
}

/**
 * The calls a region's occurrences read the fields of that it evaluates once for them, by the occurrences that read
 * them: each call over an outer row (no statement holds it: call/index.ts readsOnlyParameters, and no host around the
 * region holds it: an attachment's parent rows' evaluations, call/index.ts parentEvaluations) whose evaluation key two
 * or more occurrences' field reads share, each occurrence by that key. Its evaluation stands in the region's FROM list,
 * LATERAL, before the first of them, once per binding of what it reads, and each of them reads it
 * (LowerContext.withEvaluations), so a rule that matches several fields of one call calls it once per binding.
 */
const regionEvaluations = (
	cx: LowerContext,
	node: Region,
	env: Env
): ReadonlyMap<Occurrence, string> => {
	const keyed = node.occurrences.flatMap((o) => {
		if (
			o.source.kind !== "Call" ||
			o.source.function.kind !== "field" ||
			readsOnlyParameters(cx, o.source)
		) {
			return []
		}
		const key = cx.evaluationKey(o.source)
		return cx.hostedEvaluation(o.source, key, env) === undefined ? [{ occurrence: o, key }] : []
	})
	return new Map(
		keyed.flatMap((k) =>
			keyed.filter((other) => other.key === k.key).length > 1
				? [[k.occurrence, k.key] as const]
				: []
		)
	)
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
 * equality in WHERE, at the variable's or column's type, at the operator its type resolves (ir/compare.ts
 * operatorSchemaOf). Unbound columns are existential witnesses and are simply not selected.
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
	const parts = regionParts(node, cx, env, noRowSites)
	return bindsEveryColumn(node)
		? wholeSelect(cx, node, parts.from, parts.targets, parts.conditions)
		: select(cx.setOf(node, parts.targets, parts.from, conjunction(parts.conditions)))
}

/**
 * Whether a region witnesses nothing: every column of each occurrence's source is bound to a variable of its heading or
 * fixed by a constant, so two distinct bindings of its sources' rows are two distinct bindings of its variables, and
 * over sets the region's bindings are a set with no deduplication (wholeSelect).
 */
const bindsEveryColumn = (node: Region): boolean => {
	const heading = new Set(node.heading.map((c) => c.name))
	return node.occurrences.every((o) =>
		o.source.heading.every(
			(c) =>
				o.bindings.some((b) => b.column === c.name && heading.has(b.var.name)) ||
				o.constants.some((k) => k.column === c.name)
		)
	)
}

/**
 * Constants fix source columns; they are evaluated with the whole region in scope. Every variable a binding, an
 * equality or a correlation names is one the region declares, and every column a binding or a constant names is one of
 * its source's heading (valid DAG). A row site (`sites`) is placed once every occurrence it reads values from is, and
 * read as its site reads it, LATERAL.
 */
export const regionParts = (
	node: Region,
	cx: LowerContext,
	env: Env,
	sites: RowSites
): RegionParts => {
	const at = nodeLabel(node)
	const local = localNodes(node)
	const varOf = new Map(node.vars.map((v) => [v.name, v]))
	/** Every comparison of a variable is at its type: a vector compares through the extension's qualified operator. */
	const equal = (v: VarDecl, a: Expr, b: Expr): Expr => cx.equal(v.type, a, b)
	const value = new Map<VarDecl, Expr>()
	/** The constants' conditions, as placed: no order of the occurrences moves them. */
	const where: Array<Expr> = []
	/** The variables whose value is a stored relation's column (`bindValue`). */
	const rowValued = new Set<VarDecl>()
	/**
	 * A variable's first value in placement is its value, the one every read of it in scope reads; but the first column
	 * of a stored relation bound to it takes over from a value no stored relation holds, a carrier's or a computed set's,
	 * the row source the region joins (`row`): every read of the variable placed after it reads the row's column, so a
	 * probe of the variable, an existence test's at its pairs among them, states it against the row it joins as it states
	 * the row's other columns, and PostgreSQL parameterizes the probe's key path by the row alone, as it does any other
	 * index's. metis's submit probed processed_attempt's key at its unit from the carrier and its coordinates from the row
	 * of the table it joins (x.doc = c.doc AND x.f0 = s.f0 AND x.f1 = s.f1), which PostgreSQL inside the anti join derives
	 * no x.doc = s.doc from, so the key's path needed both and lost, at ten loops, to a spanning index of the coordinates
	 * parameterized by the row alone.
	 */
	const bindValue = (v: VarDecl, e: Expr, row: boolean): void => {
		if (!value.has(v) || (row && !rowValued.has(v))) {
			value.set(v, e)
		}
		if (row) {
			rowValued.add(v)
		}
	}
	/** Each placed occurrence's bindings, by its alias, in placement order: what conditionsIn equates in an order. */
	const placedBindings: Array<{
		readonly alias: string
		readonly bindings: ReadonlyArray<{ readonly v: VarDecl; readonly e: Expr }>
	}> = []
	/** Each equality of two variables both bound when it settled, and each correlation of a bound variable. */
	const equated: Array<readonly [VarDecl, VarDecl]> = []
	/** Each variable no occurrence binds that an equality gave its partner's value: its value is its partner's. */
	const partner = new Map<VarDecl, VarDecl>()
	const correlatedBound: Array<{ readonly v: VarDecl; readonly e: Expr }> = []
	const from: Array<PlacedOccurrence> = []
	const items: Array<FromSource> = []
	const shared = sharedSources(node)
	const evaluating = regionEvaluations(cx, node, env)
	/** The attributes of each call's evaluation the region placed, by its evaluation key. */
	const evaluated = new Map<string, NonEmptyReadonlyArray<Expr>>()
	/** Each probed occurrence's law columns, by the field each stands for (`probeKeys`). */
	const probes = new Map<Occurrence, ReadonlyMap<string, Expr>>()
	/**
	 * Each placed occurrence's columns, and, for a source node only one occurrence matches, the node's columns: the
	 * scope a correlated source's outer references resolve in.
	 */
	const placedSources = new Map<NodeId, ColumnMap>()
	/** Each placed occurrence's columns, which a row site placed after it reads its values from. */
	const placedOf = new Map<Occurrence, ColumnMap>()

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
			const siteReady = (sites.get(o)?.after ?? []).every((a) => placedOf.has(a))
			return varsReady && sourcesReady && siteReady
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
		const key = evaluating.get(o)
		const correlated = needs.vars.size > 0 || needs.sources.size > 0 || key !== undefined
		const site = sites.get(o)
		const read =
			site !== undefined
				? site.read((a) => defined(placedOf.get(a), "a row site's value read after it"), scope())
				: key === undefined || o.source.kind !== "Call"
					? cx.sourceAs(o.source, scope(), correlated)
					: cx
							.withEvaluations(placedEvaluation(cx, o.source, key, scope(), evaluated, items))
							.sourceAs(o.source, scope(), correlated)
		const probe = shared.has(o.source.id)
			? undefined
			: withLawColumns(cx, o, read, probeKeys(cx, o))
		const source = probe?.source ?? read
		if (probe !== undefined) {
			probes.set(o, probe.probed)
		}
		from.push({ occurrence: o, item: source.item, alias: source.alias, map: source.map })
		placedOf.set(o, source.map)
		items.push(source.item)
		if (!shared.has(o.source.id)) {
			placedSources.set(o.source.id, source.map)
		}
		const bindings = o.bindings.map((b) => ({ v: b.var, e: columnIn(source.map, b.column) }))
		placedBindings.push({ alias: source.alias, bindings })
		for (const b of bindings) {
			bindValue(b.v, b.e, o.source.kind === "Base")
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
					equated.push([e.a, e.b])
				}
			} else if (a !== undefined) {
				value.set(e.b, a)
				partner.set(e.b, e.a)
			} else if (b !== undefined) {
				value.set(e.a, b)
				partner.set(e.a, e.b)
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
		const e = lowerExpr(cx, c.expr, scope())
		if (value.has(c.var)) {
			correlatedBound.push({ v: c.var, e })
		} else {
			value.set(c.var, e)
		}
	}

	/**
	 * The conditions with each variable's bindings equated in the order `aliases` reads the occurrences (RegionParts
	 * conditionsIn): the bindings first, each compared with its variable's first binding in that order, then the
	 * constants, then each equality of two variables and each correlation of a bound one at the first binding of each.
	 * Placement order, the default, states them as each occurrence is placed.
	 */
	const conditionsIn = (aliases: ReadonlyArray<string>): ReadonlyArray<Expr> => {
		const rank = new Map(aliases.map((alias, i) => [alias, i] as const))
		const ordered = placedBindings.toSorted(
			(a, b) => (rank.get(a.alias) ?? aliases.length) - (rank.get(b.alias) ?? aliases.length)
		)
		const first = new Map<VarDecl, Expr>()
		const terms: Array<Expr> = []
		for (const p of ordered) {
			for (const b of p.bindings) {
				const prior = first.get(b.v)
				if (prior === undefined) {
					first.set(b.v, b.e)
				} else {
					terms.push(equal(b.v, prior, b.e))
				}
			}
		}
		const firstOf = (v: VarDecl): Expr => {
			const p = partner.get(v)
			return (
				first.get(v) ??
				(p === undefined
					? defined(value.get(v), "a value of every variable an equality or a correlation settled")
					: firstOf(p))
			)
		}
		return [
			...terms,
			...where,
			...equated.map(([a, b]) => equal(a, firstOf(a), firstOf(b))),
			...correlatedBound.map((c) => equal(c.v, firstOf(c.v), c.e))
		]
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
	return {
		targets,
		columns,
		occurrences: from,
		from: items,
		conditions: conditionsIn(placedBindings.map((p) => p.alias)),
		conditionsIn
	}
}

/**
 * The evaluation the region holds of the call the field read `read` reads, of evaluation key `key`
 * (regionEvaluations), placed at the first read of it (placeEvaluation) and read by every read of it through its
 * columns, its attributes.
 */
const placedEvaluation = (
	cx: LowerContext,
	read: NodeOf<"Call">,
	key: string,
	env: Env,
	evaluated: Map<string, NonEmptyReadonlyArray<Expr>>,
	items: Array<FromSource>
): EvaluationLookup => {
	const attributes = evaluated.getOrInsertComputed(key, () => placeEvaluation(cx, read, env, items))
	return (_read, asked) => (asked === key ? { from: [], attributes } : undefined)
}

/**
 * A call's evaluation placed in `items`, the region's FROM list, as a LATERAL derived table, its query lowered in the
 * scope `env` its first read is placed in (call/index.ts evaluationQuery): its columns, the attributes of its row.
 */
const placeEvaluation = (
	cx: LowerContext,
	read: NodeOf<"Call">,
	env: Env,
	items: Array<FromSource>
): NonEmptyReadonlyArray<Expr> => {
	const origin = { kind: "node", node: read.id } as const
	const query = evaluationQuery(read, cx, env)
	const alias = cx.relationAlias(origin)
	const [first, ...rest] = Array.from({ length: evaluationWidth(read) }, () =>
		cx.supply.column(origin)
	)
	if (first === undefined) {
		defect("a call's row, of at least one field")
	}
	items.push(derived(namedQuery(query, [first, ...rest]), alias, true))
	return mapNonEmpty([first, ...rest], (c) => col(alias, c))
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const matchRegionLowering: Lowerers<"MatchRegion"> = { MatchRegion: lowerMatchRegion }
