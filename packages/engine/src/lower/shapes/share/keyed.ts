import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import {
	edgesOf,
	inputsOf,
	type NodeOf,
	regionVarClasses,
	type RelNode,
	unionArms,
	type ValidDag
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnEqualities,
	type ColumnMap,
	columnIn,
	type Env,
	emptyEnv,
	equalitiesOver,
	type LowerContext,
	namedMap,
	outputNames
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { fencedRead } from "#compiler/lower/conservative/step/index.ts"
import type { CtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import {
	atomsOf,
	type FixedOf,
	type KeyAtom,
	keyPlan,
	type Keys,
	type KeySource,
	type Lookups,
	type ReadAtom,
	whole
} from "#compiler/lower/shapes/share/keys.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Cte, Expr, FromSource, OperandSelect } from "#compiler/sql/ast.ts"
import {
	col,
	conjunction,
	core,
	cteRefAs,
	type DefinedCte,
	derived,
	distinctCore,
	operandSelect,
	operandUnionAll,
	select,
	target
} from "#compiler/sql/build.ts"

/**
 * A node computed at its key set (keys.ts), as every lowering realizes it: the key set a MATERIALIZED DISTINCT CTE of the
 * statement, defined at its first use, and the node at its rows, a union LATERAL per key with each arm at it, a fold
 * with the key below its aggregate, a read of stored relations LATERAL per key at it. A write's statements (statements.ts
 * StatementSharing) and a query's (lower/shapes dispatchIn) each hold it over their own WITH.
 */

/**
 * The key sets a query's statement computes its nodes at (keyPlan): each node the CTE policy shares in the statement's
 * WITH, by its label, the CTE's body the node at its key set; each such node every read of which reads it at values of
 * the statement's own alone (KeyAnalysis readsAtValues), inline at each read instead; and each union or fold lowered in
 * place.
 */
export interface StatementKeys {
	readonly once: ReadonlyMap<NodeId, Keys>
	readonly atValues: ReadonlySet<NodeId>
	readonly inPlace: ReadonlyMap<RelNode, Keys>
}

/** No node computed at keys: a lowering whose own sharing keys its nodes (a write's), or that wants every row. */
export const noKeys: StatementKeys = { once: new Map(), atValues: new Set(), inPlace: new Map() }

/**
 * The key sets of a query's DAG (keyPlan over its nodes, its roots whole): each node the CTE policy shares in the
 * statement's WITH (cte-policy CteDecision, statement scope) at its key set, and each union or fold the statement
 * lowers in place at its own, the physical analysis's fixings `fixed` equating a correlated read's columns.
 */
export const queryKeys = (dag: ValidDag, cte: CtePlan, fixed: FixedOf): StatementKeys => {
	const order = topoOrder(dag)
	const place = new Map(order.map((node, i) => [node, i] as const))
	const once = order.filter((node) => {
		const decision = cte.decisions[node.id]
		return (
			decision?.scope.kind === "statement" &&
			(decision.strategy === "materialized" || decision.strategy === "notMaterialized")
		)
	})
	const plan = keyPlan({
		nodes: order,
		roots: new Map(dag.roots.map((r) => [r, whole] as const)),
		once: once.map((node) => [node]),
		fixed,
		inputs: inputsOf,
		height: (node) => place.get(node) ?? 0
	})
	return {
		once: new Map(
			once.flatMap((node, i) => {
				const keys = plan.once[i]
				return keys === undefined ? [] : [[node.id, keys] as const]
			})
		),
		atValues: new Set(once.flatMap((node, i) => (plan.atValues[i] === true ? [node.id] : []))),
		inPlace: plan.inPlace
	}
}

/**
 * Where a statement holds its key sets: its WITH entries, and each key set's CTE, defined at its first use; and which
 * nodes it reads by an index lookup at keys (keys.ts Lookups), those it computes once read where they stand.
 */
export interface KeyScope {
	readonly ctes: Set<Cte>
	readonly keySets: Map<Keys, DefinedCte>
	readonly lookups: Lookups
	/**
	 * Whether the statement lowers a node where it is read, neither a CTE nor a carrier of its, so a restriction placed
	 * on the node's rows there restricts that read alone (pushedInto).
	 */
	readonly inPlace: (node: RelNode) => boolean
}

/** Each DAG's references to each node, one per edge (ir/rel.ts edgesOf), counted once: a DAG is immutable. */
const referenceCounts = new WeakMap<ValidDag, ReadonlyMap<RelNode, number>>()

/** How many times `dag`'s nodes read each node (`referenceCounts`). */
const referencesIn = (dag: ValidDag): ReadonlyMap<RelNode, number> => {
	const known = referenceCounts.get(dag)
	if (known !== undefined) {
		return known
	}
	const out = new Map<RelNode, number>()
	for (const node of topoOrder(dag)) {
		for (const input of edgesOf(node)) {
			out.set(input, (out.get(input) ?? 0) + 1)
		}
	}
	referenceCounts.set(dag, out)
	return out
}

/**
 * Where a union or a fold read at keys is read at them inside its own fences: each node under it a step's input whose
 * rows the keys restrict, with the equalities that restrict it (LowerContext withRestricted). A union's arm, or a fold's
 * input at its grouping keys, is reached at the keys, each column by the name it has there, through a projection of
 * columns, a filter, the left side of an existence test, an intersection or a difference, a step, and a region to every
 * source that binds the column's variable or one its equalities join, each keeping the rows at those values alone of
 * what it reads; at a step, the restriction stands on the input inside its fence, where PostgreSQL moves it into every
 * relation the input reads, an index lookup at the key, and goes on to the steps the input reads in turn. Every node on
 * the way is read once in the DAG and lowered where it is read (KeyScope `inPlace`), so the restriction keeps the rows
 * of that one read. A restriction over the union's arm, or over the fold's input, stands at the fence and goes no
 * further (PostgreSQL moves no qualifier into a subquery with an OFFSET, step/index.ts fencedRead): metis's hold gate
 * read the read-aloud stamps of the due assignments, a union of three rules each a navigation's chain of steps, its
 * first step every assignment, which per due key read all 97,379 assignments again.
 */
const pushedInto = (
	node: NodeOf<"Union"> | NodeOf<"Group">,
	restriction: ColumnEqualities,
	references: ReadonlyMap<RelNode, number>,
	inPlace: (node: RelNode) => boolean
): ReadonlyMap<RelNode, ColumnEqualities> => {
	const out = new Map<RelNode, ColumnEqualities>()
	const descend = (at: RelNode, equalities: ColumnEqualities): void => {
		if (equalities.length === 0 || references.get(at) !== 1 || !inPlace(at)) {
			return
		}
		switch (at.kind) {
			case "ProjectSet": {
				const input = at.input
				descend(
					input,
					equalities.flatMap((e) => {
						const x = at.out.find((o) => o.name === e.column)?.expr
						return x?.kind === "column" && x.column.node === input.id
							? [{ column: x.column.name, value: e.value }]
							: []
					})
				)
				return
			}
			case "Filter":
				descend(at.input, equalities)
				return
			case "SemiJoin":
			case "AntiJoin":
			case "Intersect":
			case "Difference":
				descend(at.left, equalities)
				return
			case "Step":
				if (references.get(at.input) === 1 && inPlace(at.input)) {
					out.set(at.input, equalities)
					descend(at.input, equalities)
				}
				return
			case "MatchRegion": {
				const classOf = regionVarClasses(at)
				const bySource = new Map<
					RelNode,
					Array<{ readonly column: string; readonly value: Expr }>
				>()
				for (const e of equalities) {
					const v = at.vars.find((x) => x.name === e.column)
					if (v === undefined) {
						continue
					}
					for (const o of at.occurrences) {
						for (const b of o.bindings) {
							if (o.source.kind !== "Base" && classOf(b.var) === classOf(v)) {
								bySource
									.getOrInsertComputed(o.source, () => [])
									.push({ column: b.column, value: e.value })
							}
						}
					}
				}
				for (const [source, columns] of bySource) {
					descend(source, columns)
				}
				return
			}
			case "Union":
				for (const arm of unionArms(at.groups)) {
					descend(arm, equalities)
				}
				return
			case "Group":
				descend(
					at.input,
					equalities.filter((e) => at.keys.includes(e.column))
				)
				return
			case "ApproximateNearest":
			case "Attach":
			case "Base":
			case "Call":
			case "Closed":
			case "Context":
			case "Delta":
			case "Forbid":
			case "InputSet":
			case "OrderedResult":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Take":
			case "Window":
				return
		}
	}
	switch (node.kind) {
		case "Union":
			for (const arm of unionArms(node.groups)) {
				descend(arm, restriction)
			}
			break
		case "Group":
			descend(
				node.input,
				restriction.filter((e) => node.keys.includes(e.column))
			)
			break
	}
	return out
}

/**
 * A union or a fold read at keys, each restricted column of it equal to its value: lower/shapes/union keyedUnion, each
 * arm at the values, or lower/shapes/aggregate keyedGroup, the keys restricted below the aggregate.
 */
export type KeyedRead = (
	node: NodeOf<"Union"> | NodeOf<"Group">,
	cx: LowerContext,
	env: Env,
	restriction: ColumnEqualities
) => OperandSelect

/** The targets of every column of a node's heading, each read through `columns`; one at least, a set's row. */
const headingTargetsOf = (
	node: RelNode,
	columns: ColumnMap
): NonEmptyReadonlyArray<ReturnType<typeof target>> => {
	const [first, ...rest] = node.heading.map((c) => target(columnIn(columns, c.name)))
	if (first === undefined) {
		throw defect("a held node's heading, of at least one column")
	}
	return [first, ...rest]
}

/**
 * Whether a node held at its keys is read at them inside (StatementSharing #atKeys): a union, each arm at the keys, or a
 * fold, below its aggregate, where a restriction placed over either reaches no arm and no group; a join's restriction
 * stands over it, its EXISTS a semi-join PostgreSQL plans with the join's sources.
 */
export const readAtKeys = (node: RelNode): node is NodeOf<"Union"> | NodeOf<"Group"> =>
	node.kind === "Union" || node.kind === "Group"

/**
 * A key set's sources, each that reads what an earlier one reads once: two copies of one sub-query read the same rows
 * (`sameRows`, a share key), so a source whose atoms read copies of the same nodes, each column at the same place among its slots,
 * at no value of the statement's own, repeats the earlier one's rows; one that reads a value is kept.
 */
const distinctSources = (
	sameRows: (node: RelNode) => string,
	sources: NonEmptyReadonlyArray<KeySource>
): NonEmptyReadonlyArray<KeySource> => {
	/** What a source reads, as text: none for one that reads a value of the statement's, which is always kept. */
	const textOf = (source: KeySource): string | undefined => {
		if (
			source.fixed.length > 0 ||
			atomsOf(source).some(
				(a) => a.kind === "filtered" || (a.kind === "read" && a.constants.length > 0)
			)
		) {
			return undefined
		}
		const places = new Map<string, number>()
		const place = (slot: string): number => places.getOrInsertComputed(slot, () => places.size)
		const atomText = (a: KeyAtom): string =>
			`${a.kind === "keys" ? `keys ${a.of.id}` : sameRows(a.node)}(${a.bindings
				.map((b) => `${b.column}=${place(b.slot)}`)
				.join(",")})`
		return `${source.seeds.map(atomText).join(" ")} | ${source.steps.map(atomText).join(" ")} -> ${source.keys.map((k) => `${k.column}=${place(k.slot)}`).join(",")}`
	}
	const [first, ...rest] = sources
	const firstText = textOf(first)
	const seen = new Set<string>(firstText === undefined ? [] : [firstText])
	const kept = rest.filter((source) => {
		const text = textOf(source)
		if (text === undefined) {
			return true
		}
		if (seen.has(text)) {
			return false
		}
		seen.add(text)
		return true
	})
	return [first, ...kept]
}

/**
 * The lowering of nodes at key sets (keys.ts KeyRestriction): `keyed` reads a union or a fold at keys, `sameRows` names the
 * rows a node delivers, equal for two copies of one sub-query, by which repeated sources are read once.
 */
export class KeyedLowering {
	readonly #keyed: KeyedRead
	readonly #sameRows: (node: RelNode) => string

	constructor(keyed: KeyedRead, sameRows: (node: RelNode) => string) {
		this.#keyed = keyed
		this.#sameRows = sameRows
	}

	/**
	 * A node's rows at its key set's rows: a union or a fold read at them inside (#atKeys); a read of stored relations
	 * alone (Lookups), LATERAL per key, `SELECT DISTINCT r.* FROM <the key set> AS k, LATERAL (SELECT ... FROM (<the
	 * node>) AS r WHERE r.<key> = k.<key> OFFSET 0) AS r`, where PostgreSQL moves each key into the relations the node
	 * reads, an index lookup, with no plan that rescans the key set's CTE on a nested loop's inner side, as the EXISTS over
	 * the key set it read the node by allowed at an estimate of one row; and any other node as it is, its inputs computed
	 * at the keys it passes them (KeyAnalysis), where read at its own keys it would meet them in a join over a set the
	 * statement holds, which no index reads: lower-shapes/read-once's join of the derived relation's CTE with the items,
	 * 900 rows each rescanning the CTE's 450 at an estimate of one.
	 */
	body(
		node: RelNode,
		keys: Keys,
		cx: LowerContext,
		scope: KeyScope,
		inner: (cx: LowerContext) => OperandSelect
	): OperandSelect {
		if (readAtKeys(node)) {
			return this.atKeys(node, keys, cx, emptyEnv, scope)
		}
		if (!scope.lookups.readByLookup(node)) {
			return inner(cx)
		}
		const origin = { kind: "node", node: node.id } as const
		const keyRows = this.#keyRows(node, keys, cx, scope)
		const rows = cx.wrap(inner(cx), node.heading, origin)
		const atKey = cx.wrapAs(
			fencedRead(
				headingTargetsOf(node, rows.map),
				rows.item,
				conjunction(
					equalitiesOver(
						cx,
						node.heading,
						rows.map,
						keyRows.named.map((n) => ({ column: n.name, value: col(keyRows.alias, n.column) }))
					)
				)
			),
			node.heading,
			origin,
			true
		)
		return select(
			distinctCore(headingTargetsOf(node, atKey.map), [keyRows.item, atKey.item], undefined)
		)
	}

	/**
	 * A union's or a fold's rows at its key set's rows (readAtKeys): each key once, and the node LATERAL beside it read at
	 * that key, `SELECT u.* FROM (SELECT DISTINCT k FROM <the keys>) AS p, LATERAL (<the node at k>) AS u`, a union with
	 * each arm at the key (keyedUnion), a fold with the key restricted below its aggregate (keyedGroup); PostgreSQL moves
	 * no restriction placed over a union or a fold into its arms or below its grouping, so restricting the whole would
	 * read every row of every arm.
	 */
	atKeys(
		node: NodeOf<"Union"> | NodeOf<"Group">,
		keys: Keys,
		cx: LowerContext,
		env: Env,
		scope: KeyScope
	): OperandSelect {
		const origin = { kind: "node", node: node.id } as const
		const keyRows = this.#keyRows(node, keys, cx, scope)
		const equalities: ColumnEqualities = keyRows.named.map((n) => ({
			column: n.name,
			value: col(keyRows.alias, n.column)
		}))
		const within = cx.withRestricted(
			pushedInto(node, equalities, referencesIn(cx.dag), scope.inPlace)
		)
		const rows = cx.wrapAs(this.#keyed(node, within, env, equalities), node.heading, origin, true)
		return select(
			distinctCore(headingTargetsOf(node, rows.map), [keyRows.item, rows.item], undefined)
		)
	}

	/**
	 * A key set's rows, each key once, the statement's MATERIALIZED CTE of them, defined at its first use and read by
	 * every use after: `SELECT DISTINCT k FROM (<source 1> UNION ALL ...)`, each source its atoms read where the key set
	 * stands (a carried copy from its carrier, a stored relation at its constants, a key set it reads in turn), joined
	 * where two bind one slot, its keys' slots selected.
	 */
	#keyRows(
		node: RelNode,
		keys: Keys,
		cx: LowerContext,
		scope: KeyScope
	): {
		readonly item: FromSource
		readonly alias: string
		readonly named: ReadonlyArray<{ readonly name: string; readonly column: string }>
	} {
		const origin = { kind: "node", node: node.id } as const
		const known = scope.keySets.get(keys)
		const cte = known ?? this.#keySetCte(node, keys, cx, scope)
		if (known === undefined) {
			scope.keySets.set(keys, cte)
		}
		const alias = cx.relationAlias(origin)
		return {
			item: cteRefAs(cte.name, alias),
			alias,
			named: keys.columns.map((name, i) => ({
				name,
				column: defined(cte.columns[i], "a key set's CTE column, one a key column")
			}))
		}
	}

	/**
	 * The CTE of a key set's rows (#keyRows), entered in the statement's WITH past every CTE its sources read; or the CTE
	 * of the one key set its one source reads, each key a column of it, which already holds those rows, each once.
	 */
	#keySetCte(node: RelNode, keys: Keys, cx: LowerContext, scope: KeyScope): DefinedCte {
		const origin = { kind: "node", node: node.id } as const
		const [first, ...rest] = distinctSources(this.#sameRows, keys.sources)
		const [atom, ...others] = first.seeds
		if (
			rest.length === 0 &&
			others.length === 0 &&
			first.steps.length === 0 &&
			first.fixed.length === 0 &&
			atom?.kind === "keys"
		) {
			const inner = this.#keyRows(atom.of, atom.keys, cx, scope)
			const columns = keys.columns.map((c) => {
				const slot = first.keys.find((k) => k.column === c)?.slot
				const bound = atom.bindings.find((b) => b.slot === slot)?.column
				return inner.named.find((n) => n.name === bound)?.column
			})
			const cte = scope.keySets.get(atom.keys)
			if (
				cte !== undefined &&
				columns.every((c) => c !== undefined) &&
				new Set(columns).size === columns.length
			) {
				return {
					name: cte.name,
					columns,
					set: true
				}
			}
		}
		const arms = mapNonEmpty([first, ...rest], (source) =>
			this.#sourceRows(source, keys.columns, cx, scope)
		)
		const unionAlias = cx.relationAlias(origin)
		const unionColumns = mapNonEmpty(keys.columns, () => cx.supply.column(origin))
		const union = derived(operandSelect(operandUnionAll(arms)), unionAlias, unionColumns, false)
		const query = select(
			distinctCore(
				mapNonEmpty(unionColumns, (c) => target(col(unionAlias, c))),
				[union],
				undefined
			)
		)
		const name = cx.relationAlias(origin)
		const columns = cx.supply.columns(keys.columns.map(() => origin))
		scope.ctes.add({ name, columns, materialized: "MATERIALIZED", query })
		return { name, columns, set: true }
	}

	/**
	 * One key source's rows, its keys selected in order: its seeds read where it stands, joined where two bind one slot;
	 * then each step, in order, an index lookup at the slots the atoms before it bind (KeyAnalysis #lookup), LATERAL: a
	 * navigation's step with the values inside its own fence (LowerContext withRestricted), which a restriction over it
	 * would stop at; any other, a stored relation or a plain read of stored relations, read apart at those values,
	 * `LATERAL (SELECT <its columns> FROM <the read> WHERE <a slot's column> = <the earlier atom's value> OFFSET 0)`
	 * (step/index.ts fencedRead). PostgreSQL reads each step for each row of the atoms before it, a lookup at their
	 * values, as a navigation's chain of steps is read from what the statement fixes outward, with no plan in which it
	 * places a step first and scans it whole, nor rescans a set the statement holds on a nested loop's inner side, which
	 * no step is: metis's first budget judge read the content of every test beside the seats a COMMIT wrote, its key set
	 * joining the two as plain FROM items, 257 rows of a population of 128 tests where one seat's test is one row.
	 */
	#sourceRows(
		source: KeySource,
		columns: NonEmptyReadonlyArray<string>,
		cx: LowerContext,
		scope: KeyScope
	): ReturnType<typeof core> {
		const from: Array<FromSource> = []
		const where: Array<Expr> = []
		const atSlot = new Map<string, { readonly expr: Expr; readonly type: ScalarType }>()
		const noSlots: ReadonlySet<string> = new Set()
		for (const f of source.fixed) {
			atSlot.set(f.slot, { expr: lowerExpr(cx, f.expr, emptyEnv), type: f.expr.pgType })
		}
		/**
		 * Each binding of `atom` read through `column`: a slot bound before it equal to its value, but those `inside` holds,
		 * which the step equates inside it (`lookups`); others bound by it.
		 */
		const bindAll = (
			atom: KeyAtom,
			column: (name: string) => Expr | undefined,
			type: (name: string) => ScalarType,
			inside: ReadonlySet<string>
		): void => {
			for (const b of atom.bindings) {
				const value = column(b.column)
				if (value === undefined || inside.has(b.slot)) {
					continue
				}
				const known = atSlot.get(b.slot)
				if (known === undefined) {
					atSlot.set(b.slot, { expr: value, type: type(b.column) })
				} else {
					where.push(cx.equal(known.type, known.expr, value))
				}
			}
		}
		/** `atom` joined where the source stands: its item a FROM item, its constants and its slots' equalities the WHERE's. */
		const joined = (atom: KeyAtom): void => {
			switch (atom.kind) {
				case "read":
				case "outer":
				case "filtered": {
					const r = cx.source(atom.node, emptyEnv)
					const type = (name: string): ScalarType => columnType(atom.node.heading, name)
					from.push(r.item)
					if (atom.kind === "read") {
						for (const c of atom.constants) {
							where.push(
								cx.equal(type(c.column), columnIn(r.map, c.column), lowerExpr(cx, c.expr, emptyEnv))
							)
						}
					} else if (atom.kind === "filtered") {
						const at = new Map(
							[...atom.columns].map(([name, column]) => [name, columnIn(r.map, column)] as const)
						)
						where.push(lowerExpr(cx, atom.condition, new Map([[atom.at, at]])))
					}
					bindAll(atom, (name) => columnIn(r.map, name), type, noSlots)
					return
				}
				case "keys": {
					const rows = this.#keyRows(atom.of, atom.keys, cx, scope)
					from.push(rows.item)
					bindAll(
						atom,
						(name) => {
							const n = rows.named.find((x) => x.name === name)
							return n === undefined ? undefined : col(rows.alias, n.column)
						},
						(name) => columnType(atom.of.heading, name),
						noSlots
					)
					return
				}
			}
		}
		/**
		 * The equalities a step reads its node at: each constant at its value, and each column bound to a slot an atom
		 * before it binds at that slot's value.
		 */
		const lookups = (atom: ReadAtom): ColumnEqualities => [
			...atom.constants.map((c) => ({ column: c.column, value: lowerExpr(cx, c.expr, emptyEnv) })),
			...atom.bindings.flatMap((b) => {
				const known = atSlot.get(b.slot)
				return known === undefined ? [] : [{ column: b.column, value: known.expr }]
			})
		]
		for (const atom of source.seeds) {
			joined(atom)
		}
		for (const atom of source.steps) {
			const node = atom.node
			const type = (name: string): ScalarType => columnType(node.heading, name)
			const at = lookups(atom)
			const inside: ReadonlySet<string> = new Set(atSlot.keys())
			if (node.kind === "Step") {
				const r = cx.withRestricted(new Map([[node.input, at]])).sourceAs(node, emptyEnv, true)
				from.push(r.item)
				bindAll(atom, (name) => columnIn(r.map, name), type, inside)
				continue
			}
			const r = cx.source(node, emptyEnv)
			const origin = { kind: "node", node: node.id } as const
			const alias = cx.relationAlias(origin)
			const names = outputNames(node.heading)
			const named = cx.freshColumns(names, origin)
			from.push(
				derived(
					fencedRead(
						mapNonEmpty(names, (c) => target(columnIn(r.map, c))),
						r.item,
						conjunction(equalitiesOver(cx, node.heading, r.map, at))
					),
					alias,
					named.map((n) => n.column),
					true
				)
			)
			const read = namedMap(alias, named)
			bindAll(atom, (name) => columnIn(read, name), type, inside)
		}
		const targets = columns.map((c) => {
			const k = defined(
				source.keys.find((x) => x.column === c),
				"a key column every source of a key set binds"
			)
			return target(
				defined(atSlot.get(k.slot), "a key's slot, bound by an atom of its source").expr
			)
		})
		return core(targets, from, conjunction(where))
	}
}
