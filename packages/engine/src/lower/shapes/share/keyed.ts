import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { inputsOf, type NodeOf, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type CarriedRead,
	carriedName,
	type ColumnEqualities,
	columnIn,
	type ColumnMap,
	emptyEnv,
	type Env,
	envOf,
	equalitiesOver,
	type InputSource,
	type LowerContext,
	namedMap,
	outputNames,
	restrictedEnv
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { fencedRead } from "#compiler/lower/conservative/step/index.ts"
import type { CtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import {
	type CopyClass,
	type CopyPlan,
	copyPlan,
	type CopySite,
	type DrivingSet,
	noCopies
} from "#compiler/lower/shapes/share/copies.ts"
import {
	atomsOf,
	type FixedOf,
	type KeyAtom,
	keyPlan,
	type Keys,
	type KeySource,
	type Lookups,
	type ReadAtom,
	readAtKeys,
	restrictionWalk,
	whole
} from "#compiler/lower/shapes/share/keys.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import {
	type Cte,
	type Expr,
	type FromSource,
	isSetQuery,
	type OperandSelect
} from "#compiler/sql/ast.ts"
import {
	arrayOf,
	arrays,
	call,
	col,
	columnDefinition,
	conjunction,
	core,
	cteRead,
	cteRefAs,
	type DefinedCte,
	derived,
	distinctCore,
	firstNonNull,
	keyedRead,
	keyedSet,
	lit,
	operandSelect,
	provedCore,
	operandUnionAll,
	select,
	target
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"

/**
 * A node computed at its key set (keys.ts), as every lowering realizes it: the key set a MATERIALIZED DISTINCT CTE of the
 * statement, defined at its first use, and the node at its rows, a union LATERAL per key with each arm at it, a fold
 * with the key below its aggregate, a read of stored relations LATERAL per key at it. A write's statements (statements.ts
 * StatementSharing) and a query's (lower/shapes dispatchIn) each hold it over their own WITH.
 */

/**
 * The key sets a query's statement computes its nodes at (keyPlan): each node the CTE policy shares in the statement's
 * WITH, by its label, the CTE's body the node at its key set; each such node every read of which reads it at values of
 * the statement's own alone (KeyAnalysis readsAtValues), inline at each read instead; each union or fold lowered in
 * place; and each sub-query the statement reads at several sites, computed once beside the rows that drive it
 * (copies.ts CopyPlan).
 */
export interface StatementKeys {
	readonly once: ReadonlyMap<NodeId, Keys>
	readonly atValues: ReadonlySet<NodeId>
	readonly inPlace: ReadonlyMap<RelNode, Keys>
	readonly copies: CopyPlan
}

/** No node computed at keys: a lowering whose own sharing keys its nodes (a write's), or that wants every row. */
export const noKeys: StatementKeys = {
	once: new Map(),
	atValues: new Set(),
	inPlace: new Map(),
	copies: noCopies
}

/**
 * The key sets of a query's DAG (keyPlan over its nodes, its roots whole): each node the CTE policy shares in the
 * statement's WITH (cte-policy CteDecision, statement scope) at its key set, each union or fold the statement lowers in
 * place at its own, and each class of copies it reads at several sites beside the rows that drive it (copies.ts
 * copyPlan), the physical analysis's fixings `fixed` equating a correlated read's columns, its `realization` telling
 * copies apart.
 */
export const queryKeys = (
	dag: ValidDag,
	cte: CtePlan,
	fixed: FixedOf,
	realization: (node: RelNode) => string
): StatementKeys => {
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
		inPlace: plan.inPlace,
		copies: copyPlan(dag, order, cte, new Set(once), realization)
	}
}

/**
 * Where a statement holds its key sets: its WITH entries, and each key set's CTE, defined at its first use; the scope
 * that lowers them; and which nodes it reads by an index lookup at keys (keys.ts Lookups), those it computes once read
 * where they stand.
 */
export interface KeyScope {
	readonly ctes: Set<Cte>
	readonly keySets: Map<Keys, DefinedCte>
	/**
	 * The statement's own scope, which lowers each WITH entry the statement computes at keys, its key sets and its nodes'
	 * bodies at them: an entry every scope of the statement reads, which no scope of the read that first defines it
	 * reaches, so a node a scope lowers its own way there (a fence's ordered stream or its search, LowerContext
	 * withLowering) is read as itself in the entry, as every other read of the entry reads it.
	 */
	readonly statement: LowerContext
	readonly lookups: Lookups
}

/**
 * A driving set's one evaluation of its copies (KeyedLowering carried) in the statement: being lowered, whose own read of
 * its driver reads it as it stands, as does every read of a driver of the set its copies' lowering makes; or the
 * statement's CTE of it.
 */
export type Carrier =
	| { readonly kind: "lowering" }
	| { readonly kind: "defined"; readonly cte: DefinedCte }

/** The restriction `restrictionWalk` places under `root`, as the lowering's scope holds it (restrictedEnv). */
export const pushedInto = (
	root: RelNode,
	restriction: ColumnEqualities
): ReadonlyMap<RelNode, ColumnEqualities> =>
	new Map(restrictionWalk(root, restriction).map((r) => [r.node, r.equalities] as const))

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
		scope: KeyScope,
		inner: (cx: LowerContext) => OperandSelect
	): OperandSelect {
		const cx = scope.statement
		if (readAtKeys(node)) {
			return this.atKeys(node, keys, cx, emptyEnv, scope)
		}
		if (!scope.lookups.readByLookup(node)) {
			return inner(cx)
		}
		const origin = { kind: "node", node: node.id } as const
		const keyRows = this.#keyRows(node, keys, scope)
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
		const keyRows = this.#keyRows(node, keys, scope)
		const equalities: ColumnEqualities = keyRows.named.map((n) => ({
			column: n.name,
			value: col(keyRows.alias, n.column)
		}))
		const within = restrictedEnv(env, pushedInto(node, equalities))
		const rows = cx.wrapAs(this.#keyed(node, cx, within, equalities), node.heading, origin, true)
		return select(
			distinctCore(headingTargetsOf(node, rows.map), [keyRows.item, rows.item], undefined)
		)
	}

	/**
	 * A driver of a driving set (copies.ts DrivingSet), as the scope reads it where a reader places it: the set's one
	 * evaluation (#carrier), its driver's rows with each class's copy carried beside them, every column of it, each
	 * class's arrays under their carried names (context.ts carriedName), in classes' order; none while that evaluation is
	 * lowered, whose read of its driver, and every read of a driver of the set its copies' lowering makes, reads it as it
	 * stands; `carriers` the statement's evaluations, each once its lowering began.
	 */
	carried(
		driving: DrivingSet,
		cx: LowerContext,
		scope: KeyScope,
		carriers: Map<DrivingSet, Carrier>
	): CarriedRead | undefined {
		const known = carriers.get(driving)
		if (known?.kind === "lowering") {
			return undefined
		}
		const cte = known?.cte ?? this.#carrier(driving, scope, carriers)
		const [first, ...rest] = driving.classes
		return {
			query: cteRead(cx.relationAlias({ kind: "node", node: driving.driver.id }), cte),
			carried: [
				...this.#carriedNames(first),
				...rest.flatMap((c) => this.#carriedNames(c))
			] as const
		}
	}

	/** The carried names of a class's arrays, one for each column of its copy's heading, in heading order. */
	#carriedNames(copied: CopyClass): NonEmptyReadonlyArray<string> {
		const [head, ...tail] = copied.representative.heading
		if (head === undefined) {
			throw defect("a carried copy's heading, of at least one column")
		}
		return [carriedName(copied.index, 0), ...tail.map((_, j) => carriedName(copied.index, j + 1))]
	}

	/**
	 * A site of a class of copies (copies.ts CopySite), as it reads its class's one evaluation: its own driver row's
	 * arrays, each in the driver's column map under its carried name (#carrier), read in lockstep, `SELECT c.* FROM
	 * (SELECT unnest(<driver row>.<array>), ...) AS c`, the copy's rows at that row, a set (#carrier made them one), no
	 * lookup and no scan; none where no driver row in scope carries them, its driver read where a restriction stands on
	 * it or by no reader that places it (LowerContext sourceAs).
	 */
	copied(node: RelNode, site: CopySite, cx: LowerContext, env: Env): OperandSelect | undefined {
		const row = env.columns.get(site.driver.id)
		const [head, ...tail] = node.heading
		if (row === undefined || head === undefined || !row.has(carriedName(site.copied.index, 0))) {
			return undefined
		}
		const origin = { kind: "node", node: node.id } as const
		const column = (c: (typeof node.heading)[number], j: number) => ({
			definition: columnDefinition(cx.supply.column(origin), cx.baseTypeRef(c.type)),
			array: defined(row.get(carriedName(site.copied.index, j)), "a carried class's every column")
		})
		const columns = [column(head, 0), ...tail.map((c, j) => column(c, j + 1))] as const
		const alias = cx.relationAlias(origin)
		return select(
			keyedSet(
				columns.map((c) => target(col(alias, c.definition.name))),
				[arrays({ kind: "carried", columns }, alias)],
				undefined,
				"a copy's rows its driver's row carries"
			)
		)
	}

	/**
	 * The one evaluation of a driving set's copies (copies.ts DrivingSet), the statement's MATERIALIZED CTE entered in its
	 * WITH past every CTE it reads: `SELECT d.*, a1.*, ... FROM <the driver> AS d, LATERAL (SELECT
	 * coalesce(array_agg(c.<column>), '{}'), ... FROM (<the class's copy, its outer columns d's>) AS c) AS a1, ...`, each
	 * lowered in the statement's scope (KeyScope `statement`), the driver as it stands (Carrier `lowering`), its rows the
	 * driver's, each with each class's copy at its values as arrays, one for each column of the copy, aligned. A LATERAL
	 * aggregate is never pulled up, so PostgreSQL computes each copy at each driver row's values, each of its reads a
	 * B-tree probe there, whatever it estimates of either side.
	 */
	#carrier(driving: DrivingSet, scope: KeyScope, carriers: Map<DrivingSet, Carrier>): DefinedCte {
		carriers.set(driving, { kind: "lowering" })
		const cx = scope.statement
		const driver = driving.driver
		const origin = { kind: "node", node: driver.id } as const
		const rows = cx.source(driver, emptyEnv)
		const carried = driving.classes.map((c) => this.#arrays(c, rows, cx))
		const targets = [
			...outputNames(driver.heading).map((name) => target(columnIn(rows.map, name))),
			...carried.flatMap((a) => a.targets)
		]
		const query = operandSelect(
			keyedRead(targets, [rows.item, ...carried.map((a) => a.item)], undefined)
		)
		const name = cx.relationAlias(origin)
		const columns = cx.supply.columns(targets.map(() => origin))
		scope.ctes.add({ name, materialized: "MATERIALIZED", query: namedQuery(query, columns) })
		const cte = { name, columns, set: isSetQuery(query) }
		carriers.set(driving, { kind: "defined", cte })
		return cte
	}

	/**
	 * One class's copy at each row of its driver's `rows`, as arrays (#carrier): `LATERAL (SELECT
	 * coalesce(array_agg(c.<column>), '{}'), ... FROM (<the copy>) AS c) AS a`, the copy lowered by `cx` with each column
	 * it reads of an outer row the driver row's column its place reads, its rows made a set where they may repeat, which a
	 * site reads as it would read the copy; a copy of no row at a driver row is the empty arrays, whose unnest is no row,
	 * where the aggregate alone is NULL.
	 */
	#arrays(
		copied: CopyClass,
		rows: InputSource,
		cx: LowerContext
	): { readonly item: FromSource; readonly targets: ReadonlyArray<ReturnType<typeof target>> } {
		const node = copied.representative
		const origin = { kind: "node", node: node.id } as const
		const outer = new Map<NodeId, Map<string, Expr>>()
		for (const o of copied.outer) {
			outer
				.getOrInsertComputed(o.read.node, () => new Map())
				.set(o.read.column, columnIn(rows.map, o.driver))
		}
		const query = cx.lower(node, envOf(outer))
		const distinct = isSetQuery(query)
			? query
			: ((): OperandSelect => {
					const repeated = cx.wrap(query, node.heading, origin)
					return select(
						distinctCore(headingTargetsOf(node, repeated.map), [repeated.item], undefined)
					)
				})()
		const copy = cx.wrap(distinct, node.heading, origin)
		const alias = cx.relationAlias(origin)
		const columns = node.heading.map(() => cx.supply.column(origin))
		const aggregates = node.heading.map((c) =>
			target(
				firstNonNull([
					call("array_agg", [columnIn(copy.map, c.name)]),
					lit.text(
						"{}",
						defined(
							arrayOf(cx.baseTypeRef(c.type)),
							"a base type's array: a set's is its roster's domain's"
						)
					)
				])
			)
		)
		return {
			item: derived(
				namedQuery(select(provedCore("oneRow", aggregates, [copy.item], undefined)), columns),
				alias,
				true
			),
			targets: columns.map((c) => target(col(alias, c)))
		}
	}

	/**
	 * A key set's rows, each key once, the statement's MATERIALIZED CTE of them, defined at its first use and read by
	 * every use after: `SELECT DISTINCT k FROM (<source 1> UNION ALL ...)`, each source its atoms read where the key set
	 * stands (a carried copy from its carrier, a stored relation at its constants, a key set it reads in turn), joined
	 * where two bind one slot, its keys' slots selected, each lowered in the statement's scope (KeyScope `statement`).
	 */
	#keyRows(
		node: RelNode,
		keys: Keys,
		scope: KeyScope
	): {
		readonly item: FromSource
		readonly alias: string
		readonly named: ReadonlyArray<{ readonly name: string; readonly column: string }>
	} {
		const origin = { kind: "node", node: node.id } as const
		const known = scope.keySets.get(keys)
		const cte = known ?? this.#keySetCte(node, keys, scope)
		if (known === undefined) {
			scope.keySets.set(keys, cte)
		}
		const alias = scope.statement.relationAlias(origin)
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
	#keySetCte(node: RelNode, keys: Keys, scope: KeyScope): DefinedCte {
		const cx = scope.statement
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
			const inner = this.#keyRows(atom.of, atom.keys, scope)
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
			this.#sourceRows(source, keys.columns, scope)
		)
		const unionAlias = cx.relationAlias(origin)
		const unionColumns = mapNonEmpty(keys.columns, () => cx.supply.column(origin))
		const union = derived(
			namedQuery(operandSelect(operandUnionAll(arms)), unionColumns),
			unionAlias,
			false
		)
		const query = select(
			distinctCore(
				mapNonEmpty(unionColumns, (c) => target(col(unionAlias, c))),
				[union],
				undefined
			)
		)
		const name = cx.relationAlias(origin)
		const columns = cx.supply.columns(keys.columns.map(() => origin))
		scope.ctes.add({ name, materialized: "MATERIALIZED", query: namedQuery(query, columns) })
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
		scope: KeyScope
	): ReturnType<typeof core> {
		const cx = scope.statement
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
						where.push(lowerExpr(cx, atom.condition, envOf([[atom.at, at]])))
					}
					bindAll(atom, (name) => columnIn(r.map, name), type, noSlots)
					return
				}
				case "keys": {
					const rows = this.#keyRows(atom.of, atom.keys, scope)
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
				const r = cx.sourceAs(node, restrictedEnv(emptyEnv, new Map([[node.input, at]])), true)
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
					namedQuery(
						fencedRead(
							mapNonEmpty(names, (c) => target(columnIn(r.map, c))),
							r.item,
							conjunction(equalitiesOver(cx, node.heading, r.map, at))
						),
						named.map((n) => n.column)
					),
					alias,
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
