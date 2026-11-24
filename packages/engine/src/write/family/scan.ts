/**
 * A family's members drawn in SQL, in slot order, inside the statement that writes them: the values the host once drew
 * from a read of the stored group, computed by PostgreSQL from the group as the statement finds it. A migration's
 * backfill draws a family added to stored rows by the same scan, every group from slot 0 (deploy/diff/backfill.ts), so
 * a value is drawn one way, whoever draws it.
 *
 * A scan draws each group of one family from its first drawn slot to its last as windows over the group's rows in slot
 * order, never a walk of one member per step: each column a layer of its own, a derived table over the layer below it,
 * which reads every column below it. Each drawn column is its fill rule (ir/fill.ts), the one the nested walk fills by:
 *
 * - an index its slot, a copy of the count the group's count, an owner copy the owner's column, each read off its row;
 * - a predecessor copy the member before it's column, lag() over the group in slot order, and at the group's first
 *   drawn slot its seed's (the stored member before it, GroupState `stored`), or the family's base at slot 0;
 * - a fold plane's after `combine(befores, x)` where the fold's selection holds and its before elsewhere, combined as the
 *   fold's CHECK proves it, drawn whole as its first before combined with the running aggregate of every step of the
 *   group up to it, by its operation's aggregate (ir/monoid.ts accumulations), the frame ROWS from the group's first
 *   row to the current one; and its before, the after before it, lag() again.
 *
 * A generated field a rule reads is its generation over the row, as PostgreSQL stores it. Every column is placed in the
 * first layer whose columns below it hold everything it reads: its own row's columns and, for a predecessor copy, the
 * member before it's. So a scan's cost is a sort of its rows and a pass of each layer over them, whatever the length of
 * a group.
 *
 * A chain is drawn by recursion (`chainLayer`): columns that read themselves back across the member before them, a
 * predecessor copy of a column that reads the copy through its row (a generated field over it, or a fold's after whose
 * step reads it) among them, and with a fold any of whose accumulators they hold every accumulator of that fold. No
 * window draws such a column, since each member's value is its rule over the member before's: the chain is a left fold
 * whose step is those rules. Its layer is a recursive CTE over the layer below it, each group's first drawn slot from its
 * seed or the family's base, and each next slot its rules over that row and the slot before it, joined at the next
 * slot; it costs a step for each member, in as many rounds as its longest group has drawn slots.
 *
 * Every drawn column is cast to its type's base, so no domain's CHECK runs before the write that stores the value, which
 * judges it there.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId } from "#compiler/core/ids.ts"
import { type OperatorNames, typedEq } from "#compiler/ir/compare.ts"
import { columnReads, fieldReads, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Family, FamilyFold } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
import {
	type ColumnKey,
	columnKey,
	columnKeyOf,
	generationOf,
	type LawRelation,
	type NativeColumn
} from "#compiler/ir/law.ts"
import {
	type Accumulation,
	accumulations,
	type CombineBuild,
	type CombineStep,
	deltaOf,
	type MonoidPlane,
	monoidSpecs,
	stepValue
} from "#compiler/ir/monoid.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { envOf } from "#compiler/lower/conservative/context.ts"
import { lowerExpr, lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type {
	Cte,
	Expr,
	FromItem,
	FromSource,
	Select,
	SetCore,
	Target,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	col,
	cteRefAs,
	cUtf8Collation,
	derived,
	eq,
	gt,
	join,
	lit,
	provedCore,
	select,
	targetAs,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"

/** A CTE's rows by the native columns they hold, each under a column name of the CTE. */
export interface Shaped {
	readonly name: string
	readonly columns: ReadonlyMap<ColumnKey, string>
}

/** A CTE of rows of a family's groups: each row's group key columns, in the family's group order, beside its columns. */
export interface PerGroup extends Shaped {
	readonly group: NonEmptyReadonlyArray<string>
}

/**
 * The members a scan walks, one row per member at its final slot: its group's key, its slot, its group's first drawn
 * slot and count, every column of the member the family's rules read, every column of its owner its owner copies
 * read (`owner`), as the members copy them, and the columns it passes through by name, read by no rule (`through`):
 * a backfill's tid of the row a member is stored at, none of a write's.
 */
export interface ScanRows extends PerGroup {
	readonly slot: string
	readonly first: string
	readonly count: string
	readonly owner: ReadonlyMap<ColumnKey, string>
	readonly through: ReadonlyArray<string>
}

/** A scan's own rows: the members it walked, each with the columns it carries and the ones it drew, by key, and those it
 * passed through by name. */
export interface Scanned extends PerGroup {
	readonly slot: string
	readonly first: string
	readonly count: string
	readonly through: ReadonlyArray<string>
}

/** What a scan draws: a family's member columns, each with its rule, in the order the family fills them. */
export interface ScanSpec {
	readonly family: Family
	readonly member: LawRelation
	readonly drawn: ReadonlyArray<FillColumn>
	readonly rows: ScanRows
	readonly group: GroupState
}

/**
 * What a scan's groups hold before the members it draws:
 * - `base`: nothing, each group drawn from slot 0 and the family's base, and no stored member read: an immutable
 *   family's at SERIALIZABLE, whose group is written whole with its owner, so a stored member a write sends again is met
 *   by the arbiter at its key, and any write that appends to a stored group is refused by the family's owner axis or
 *   at its slot, whatever the slots drawn (write/family/additions.ts);
 * - `stored`: its stored members, `seed` each group's member before its first drawn slot, for every group drawn from
 *   past slot 0, read by a probe of its group (write/probe.ts).
 */
export type GroupState =
	| { readonly kind: "base" }
	| { readonly kind: "stored"; readonly seed: PerGroup }

/** A scan: its recursive CTE, and the CTE's rows as the scan shapes them, every column it carries or draws by key. */
export interface Scan {
	readonly cte: Cte
	readonly rows: Scanned
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** A row a rule reads columns of, by key: the member's own, the member before it, or its owner. */
export type Read = (key: ColumnKey) => Expr | undefined

/** A column's value at an alias, by its name in its CTE's shape. */
export const readAt =
	(alias: string, shape: Shaped): Read =>
	(key) => {
		const column = shape.columns.get(key)
		return column === undefined ? undefined : col(alias, column)
	}

/** The columns of a scan's rows, each native column under the name `name` gives it, by the scan's key. */
export const rowColumns = (
	columns: ReadonlyArray<NativeColumn>,
	name: (column: NativeColumn) => string
): ReadonlyMap<ColumnKey, string> => new Map(columns.map((c) => [columnKey(c), name(c)] as const))

/** The name of a native column among a scan's rows, none where it neither carries nor draws it. */
export const scannedColumn = (rows: Shaped, column: NativeColumn): string | undefined =>
	rows.columns.get(columnKey(column))

/** Whether two rows' group key columns name one group of `family`, column by column, each at its group field's type. */
const sameGroup = (
	names: OperatorNames,
	family: Family,
	a: string,
	aGroup: NonEmptyReadonlyArray<string>,
	b: string,
	bGroup: NonEmptyReadonlyArray<string>
): Expr =>
	and(
		mapNonEmpty(aGroup, (column, i) =>
			typedEq(
				defined(family.group[i], "a group field").owner.type,
				col(a, column),
				col(b, defined(bGroup[i], "a group key column of each side")),
				names
			)
		)
	)

/**
 * How a scan lowers what it reads of a row and writes of a type: a row expression (a generated field's generation, a
 * conjunct of a fold's selection) over the row's columns, each field it reads by `field` at its name; a type's base,
 * which every drawn column is cast to; and the installed names its literals and a group key's operators are spelled by
 * (lowerLiteral, typedEq). A write lowers them as its statements do (`writeLowering`); a migration's backfill as the
 * installation's persistent expressions are (deploy/diff/backfill.ts).
 */
export interface ScanLowering {
	readonly names: PhysicalNames
	readonly expression: (expr: ScalarExpr, field: (name: string) => Expr) => Expr
	readonly baseType: (type: ScalarType) => TypeRef
}

/** A write's lowering of its scans: its statements' expressions, literals and types. */
export const writeLowering = (w: WriteContext): ScanLowering => ({
	names: w.names,
	expression: (expr, field) => {
		const scope = new Map<NodeId, Map<string, Expr>>()
		for (const read of columnReads([expr])) {
			scope.getOrInsertComputed(read.node, () => new Map()).set(read.name, field(read.name))
		}
		return lowerExpr(w.cx, expr, envOf(scope))
	},
	baseType: (type) => w.cx.baseTypeRef(type)
})

/** A fold's selection over the member's row, its conjuncts ANDed, none where it steps over every member. */
const selection = (
	lowering: ScanLowering,
	fold: FamilyFold,
	value: (key: ColumnKey) => Expr
): Expr | undefined => {
	const [first, ...rest] = fold.where.map((c) =>
		lowering.expression(c, (name) => value(columnKeyOf(name)))
	)
	return first === undefined ? undefined : and([first, ...rest])
}

/**
 * A row's value at each column (`value`), as a write reads it: its own column where it holds one, else a generated
 * field's generation over its other columns. A column the row neither holds nor generates is a defect: a caller's rows
 * hold every column a rule or a generation reads.
 */
const ownValue =
	(relation: LawRelation, own: Read, lowering: ScanLowering) =>
	(key: ColumnKey): Expr => {
		const value = (k: ColumnKey): Expr => {
			const held = own(k)
			if (held !== undefined) {
				return held
			}
			const field = relation.fields.find((f) => columnKeyOf(f.name) === k)
			const generation = field === undefined ? undefined : generationOf(field)
			if (generation !== undefined) {
				return lowering.expression(generation, (name) => value(columnKeyOf(name)))
			}
			throw defect(`the column ${k} of ${relation.name}, which a write reads`)
		}
		return value(key)
	}

/**
 * A row's value at `column`, as `ownValue` reads a row through `read`, a scan's row at its alias (`readAt`) or a row
 * read from several: its column where `read` carries one, else a generated field's generation over its other columns,
 * in the field's base type.
 */
export const scannedValue = (
	w: WriteContext,
	relation: LawRelation,
	read: Read,
	column: NativeColumn
): Expr => {
	const key = columnKey(column)
	const value = ownValue(relation, read, writeLowering(w))(key)
	return read(key) !== undefined || column.kind !== "field"
		? value
		: cast(value, w.cx.baseTypeRef(column.field.type))
}

/** The columns a layer of a scan holds, each by its name in every layer: the rows', and each drawn column once drawn. */
interface Layout {
	readonly group: NonEmptyReadonlyArray<string>
	readonly slot: string
	readonly first: string
	readonly count: string
	/** The rows' own columns, by key: each carried one under its scanned name, each drawn one's stored value apart. */
	readonly own: ReadonlyMap<ColumnKey, string>
	readonly owner: ReadonlyMap<ColumnKey, string>
	/** The seed's columns, the member stored before each group's first drawn slot, each a predecessor copy reads; a group
	 * drawn from slot 0 holds the copy's base there. */
	readonly seed: ReadonlyMap<ColumnKey, string>
	/** The scanned name of every carried and drawn column, by key: what the member before a row is read by. */
	readonly scanned: ReadonlyMap<ColumnKey, string>
}

/**
 * A column read before what it reads is drawn: the reader stays unbuilt, waiting on `on`, which a later layer draws or,
 * in a cycle, none does.
 */
type Built =
	| { readonly kind: "built"; readonly expr: Expr }
	| { readonly kind: "waiting"; readonly on: ReadonlySet<ColumnKey> }

/** How a scan builds a combine in SQL: the bigint one a count adds, and each scalar operation's SQL. */
const sqlCombine: CombineBuild<Expr> = {
	one: lit.int(1, types.bigint),
	apply: (fn, left, right) => {
		switch (fn) {
			case "add":
				return binary("+", left, right)
			case "union":
				return binary("|", left, right)
			case "intersection":
				return binary("&", left, right)
			case "greatest":
				return { kind: "greatest", args: [left, right] }
			case "concat":
				return binary("||", left, right)
		}
	}
}

/** The empty text: string_agg's delimiter, since concat has no separator, and concat's step off a fold's selection. */
const emptyText = (): Expr => lit.text("", types.text)

/**
 * A fold plane's running after (ir/monoid.ts MonoidPlane) over its group's rows in slot order from the first through
 * the current one: its first before combined with the running aggregate of its deltas (Accumulation), each the delta
 * where the fold's selection holds and the step off it elsewhere: add's 0, concat's empty text, or an idempotent
 * operation's first before. An exact accumulation sums a value delta in numeric, its first before with it; count's ones
 * are bigints, whose sum PostgreSQL takes in numeric. Each is what the fold's CHECK proves of the after at every slot
 * from the first before on, since every monoid of a fold is associative.
 */
const runningAfter = (
	plane: MonoidPlane,
	first: Expr,
	delta: CombineStep<Expr>,
	selected: Expr | undefined,
	running: (fn: Accumulation["aggregate"], args: NonEmptyReadonlyArray<Expr>) => Expr,
	to: TypeRef
): Expr => {
	const { aggregate, exact, off } = accumulations[plane.fn]
	const numeric = exact && delta.kind === "value"
	const arithmetic = (e: Expr): Expr => (numeric ? cast(e, types.numeric) : e)
	const value = arithmetic(stepValue(delta, sqlCombine))
	const neutral = ((): Expr => {
		switch (off) {
			case "zero":
				return lit.int(0, numeric ? types.numeric : types.bigint)
			case "empty":
				return emptyText()
			case "first":
				return first
		}
	})()
	const masked: Expr =
		selected === undefined
			? value
			: {
					kind: "case",
					operand: undefined,
					whens: [{ when: selected, result: value }],
					else: neutral
				}
	return cast(
		sqlCombine.apply(
			plane.fn,
			arithmetic(first),
			running(aggregate, aggregate === "string_agg" ? [masked, emptyText()] : [masked])
		),
		to
	)
}

/**
 * The scan of `spec` (see the header): a CTE of every row `spec.rows` holds, each with the columns it carries and the
 * family's columns its rules draw, by key, drawn layer by layer over each group in slot order.
 */
export const scanOf = (lowering: ScanLowering, supply: NameSupply, spec: ScanSpec): Scan => {
	const name = supply.relation(internal("family scan"))
	const rows = spec.rows
	const drawnKeys = new Set(spec.drawn.map((c) => columnKey(c.column)))
	const carried = [...rows.columns].filter(([key]) => !drawnKeys.has(key))
	const group = mapNonEmpty(spec.family.group, () => supply.column(internal("scan group")))
	const slot = supply.column(internal("scan slot"))
	const first = supply.column(internal("scan first slot"))
	const count = supply.column(internal("scan count"))
	const columns = new Map<ColumnKey, string>([
		...carried.map(([key]) => [key, supply.column(internal("scan carried"))] as const),
		...spec.drawn.map((c) => [columnKey(c.column), supply.column(internal("scan drawn"))] as const)
	])
	const { through } = rows
	const out: Scanned = { name, group, slot, first, count, columns, through }
	const own = new Map<ColumnKey, string>(
		[...rows.columns.keys()].map((key) => [
			key,
			drawnKeys.has(key)
				? supply.column(internal("scan stored"))
				: defined(columns.get(key), "a carried column")
		])
	)
	const owner = new Map(
		[...rows.owner.keys()].map((k) => [k, supply.column(internal("scan owner"))])
	)
	const seed = new Map(
		spec.drawn.flatMap((c) =>
			c.rule.kind === "predecessor"
				? [[columnKey(c.rule.to), supply.column(internal("scan seed"))] as const]
				: []
		)
	)
	const layout: Layout = { group, slot, first, count, own, owner, seed, scanned: columns }
	/** The predecessor copy reading each seed column, by the column's key: its type, and its base at slot 0. */
	const seedReaders = new Map(
		spec.drawn.flatMap((c) =>
			c.rule.kind === "predecessor"
				? [[columnKey(c.rule.to), { type: c.type, base: c.rule.base }] as const]
				: []
		)
	)
	const seedReader = (key: ColumnKey) =>
		defined(seedReaders.get(key), `the predecessor copy reading the seed's ${key}`)
	/** One arm of the base layer: the rows of `rows` its WHERE keeps, each seed column from `seedColumn`. */
	const arm = (
		r: string,
		from: ReadonlyArray<FromItem>,
		where: Expr,
		seedColumn: (key: ColumnKey, reader: ReturnType<typeof seedReader>) => Expr
	): SetCore =>
		provedCore(
			"keyed",
			[
				...mapNonEmpty(rows.group, (c, i) =>
					targetAs(col(r, c), defined(group[i], "a scan group column"))
				),
				targetAs(col(r, rows.slot), slot),
				targetAs(col(r, rows.first), first),
				targetAs(col(r, rows.count), count),
				...through.map((c) => targetAs(col(r, c), c)),
				...[...rows.columns].map(([key, c]) =>
					targetAs(col(r, c), defined(own.get(key), "a row column"))
				),
				...[...rows.owner].map(([key, c]) =>
					targetAs(col(r, c), defined(owner.get(key), "an owner column"))
				),
				...[...seed].map(([key, c]) => {
					const reader = seedReader(key)
					return targetAs(cast(seedColumn(key, reader), lowering.baseType(reader.type)), c)
				})
			],
			from,
			where
		)
	const zero = lit.int(0, types.bigint)
	const r0 = supply.relation(internal("scan base row"))
	/** The groups drawn from slot 0, whose first member reads the family's base. */
	const fromBase = arm(r0, [cteRefAs(rows.name, r0)], eq(col(r0, rows.first), zero), (_, reader) =>
		lowerLiteral(lowering.names, reader.base, reader.type)
	)
	const seededFrom = (stored: PerGroup): SetCore => {
		const r1 = supply.relation(internal("scan seeded row"))
		const s1 = supply.relation(internal("scan seed"))
		return arm(
			r1,
			[
				join(
					cteRefAs(rows.name, r1),
					cteRefAs(stored.name, s1),
					sameGroup(lowering.names, spec.family, r1, rows.group, s1, stored.group)
				)
			],
			gt(col(r1, rows.first), zero),
			(key) => col(s1, defined(stored.columns.get(key), "a seed column"))
		)
	}
	const based = select(
		unionAll(
			"disjoint",
			spec.group.kind === "stored" ? [fromBase, seededFrom(spec.group.seed)] : [fromBase]
		)
	)
	let below: Layer = {
		query: based,
		columns: [
			...group,
			slot,
			first,
			count,
			...through,
			...own.values(),
			...owner.values(),
			...seed.values()
		]
	}
	const drawn = new Set<ColumnKey>()
	const chains = chainsOf(spec)
	const chained = new Set(chains.flatMap((chain) => chain.columns.map((c) => columnKey(c.column))))
	const pending: Array<FillColumn> = spec.drawn.filter((c) => !chained.has(columnKey(c.column)))
	const waitingChains = [...chains]
	while (pending.length > 0 || waitingChains.length > 0) {
		const at = supply.relation(internal("scan layer"))
		const ready = pending.flatMap((c) => {
			const built = columnOf(lowering, spec, layout, at, drawn, c)
			return built.kind === "built"
				? [
						{
							c,
							expr: built.expr,
							name: defined(columns.get(columnKey(c.column)), "a drawn column")
						}
					]
				: []
		})
		if (ready.length === 0) {
			const chain = waitingChains.find((x) => [...x.reads].every((k) => drawn.has(k)))
			if (chain === undefined) {
				throw defect(
					`an order of the layers of ${spec.family.id.owner}.${spec.family.id.count}'s scan on ${spec.member.name}, whose columns read each other within a row only where the fill order refuses them`
				)
			}
			below = chainLayer(lowering, supply, spec, layout, below, chain)
			for (const c of chain.columns) {
				drawn.add(columnKey(c.column))
			}
			waitingChains.splice(waitingChains.indexOf(chain), 1)
			continue
		}
		below = {
			query: select(
				provedCore(
					"keyed",
					[
						...below.columns.map((n) => targetAs(col(at, n), n)),
						...ready.map(({ expr, name: n }) => targetAs(expr, n))
					],
					[over(below, at)],
					undefined
				)
			),
			columns: [...below.columns, ...ready.map(({ name: n }) => n)]
		}
		for (const { c } of ready) {
			drawn.add(columnKey(c.column))
			pending.splice(pending.indexOf(c), 1)
		}
	}
	const top = supply.relation(internal("scan top"))
	const body = select(
		provedCore(
			"keyed",
			[...group, slot, first, count, ...through, ...columns.values()].map((n) =>
				targetAs(col(top, n), n)
			),
			[over(below, top)],
			undefined
		)
	)
	return {
		cte: {
			name,
			columns: [...group, slot, first, count, ...through, ...columns.values()],
			materialized: undefined,
			query: body
		},
		rows: out
	}
}

/**
 * A layer of a scan: its query and the names of the columns it delivers, in order, which the layer above lists where it
 * reads it as a derived table, and reads by name.
 */
interface Layer {
	readonly query: Select
	readonly columns: ReadonlyArray<string>
}

/** `layer` as the derived table `alias`, its columns listed as it delivers them. */
const over = (layer: Layer, alias: string): FromSource =>
	derived(layer.query, alias, layer.columns, false)

/**
 * One drawn column of a scanned member over the layer `at` below it, which holds `drawn`: its fill rule over the row's
 * own columns, its slot and its group's count, its owner's columns, and the member before it, lag() over the group in
 * slot order and the seed or the family's base at the group's first drawn slot; a fold plane's after as its running
 * aggregate (runningAfter). It waits on each drawn column it reads that `at` does not hold.
 */
const columnOf = (
	lowering: ScanLowering,
	spec: ScanSpec,
	layout: Layout,
	at: string,
	drawn: ReadonlySet<ColumnKey>,
	c: FillColumn
): Built => {
	const waits = new Set<ColumnKey>()
	const holding = (key: ColumnKey): Expr | undefined => {
		if (drawnKeysOf(spec).has(key) && !drawn.has(key)) {
			waits.add(key)
		}
		const scanned = layout.scanned.get(key)
		return scanned === undefined ? undefined : col(at, scanned)
	}
	const order = [{ expr: col(at, layout.slot), direction: "ASC" as const }]
	const partition = layout.group.map((g) => col(at, g))
	/** The member before the row's `e`: lag(e, 1, e), whose default, the row's own `e` at its group's first appended row,
	 * no rule reads, since a predecessor copy takes its seed's or its base there (`firstBefore`), and which names no NULL. */
	const lag = (e: Expr): Expr => ({
		...call("lag", [e, lit.int(1, types.integer), e]),
		over: windowOf(partition, order)
	})
	const running = (fn: Accumulation["aggregate"], args: NonEmptyReadonlyArray<Expr>): Expr => ({
		...call(fn, args),
		over: {
			partitionBy: partition,
			orderBy: order,
			frame: { start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" } }
		}
	})
	/**
	 * A column of the row as its rules read it: drawn where a rule draws it, else its own, and a generated field its
	 * generation over the row read so, which reads a column the scan draws at its drawn value, as PostgreSQL generates
	 * the field from the row the write stores.
	 */
	const value = ownValue(
		spec.member,
		(key) => {
			if (drawnKeysOf(spec).has(key)) {
				return holding(key)
			}
			const column = layout.own.get(key)
			return column === undefined ? undefined : col(at, column)
		},
		lowering
	)
	/** A column of the member before the row, lag() of the row's scanned column, a generation over them read so. */
	const before = ownValue(
		spec.member,
		(key) => {
			const e = holding(key)
			return e === undefined ? undefined : lag(e)
		},
		lowering
	)
	const atFirst = eq(col(at, layout.slot), col(at, layout.first))
	/** A predecessor copy's value at the group's first drawn slot: its base at slot 0, else the seed's column. */
	const firstBefore = (to: NativeColumn, base: Expr): Expr => ({
		kind: "case",
		operand: undefined,
		whens: [{ when: eq(col(at, layout.first), lit.int(0, types.bigint)), result: base }],
		else: col(at, defined(layout.seed.get(columnKey(to)), "a seed column"))
	})
	const to = lowering.baseType(c.type)
	const rule = c.rule
	const built = (expr: Expr): Built =>
		waits.size === 0 ? { kind: "built", expr: cast(expr, to) } : { kind: "waiting", on: waits }
	switch (rule.kind) {
		case "index":
			return built(col(at, layout.slot))
		case "copy":
			return built(col(at, layout.count))
		case "ownerCopy":
			return built(
				ownValue(
					spec.family.owner,
					(key) => {
						const column = layout.owner.get(key)
						return column === undefined ? undefined : col(at, column)
					},
					lowering
				)(columnKey(rule.to))
			)
		case "predecessor": {
			const base = lowerLiteral(lowering.names, rule.base, c.type)
			const later = before(columnKey(rule.to))
			return built({
				kind: "case",
				operand: undefined,
				whens: [{ when: atFirst, result: firstBefore(rule.to, base) }],
				else: later
			})
		}
		case "after": {
			const plane = rule.plane
			const own = defined(rule.befores[plane], `the before of plane ${plane}`)
			const pred = spec.drawn.find((d) => columnKey(d.column) === columnKey(own))
			if (pred?.rule.kind !== "predecessor" || columnKey(pred.rule.to) !== columnKey(c.column)) {
				throw defect(
					`the before ${columnKey(own)} of ${columnKey(c.column)}, which its predecessor axis copies from the after before it`
				)
			}
			const first = cast(
				firstBefore(pred.rule.to, lowerLiteral(lowering.names, pred.rule.base, pred.type)),
				lowering.baseType(pred.type)
			)
			const monoid = monoidSpecs[rule.fold.monoid]
			const accumulates = defined(monoid.planes[plane], `the ${monoid.name} fold's plane ${plane}`)
			const step: CombineStep<Expr> =
				rule.step.kind === "one"
					? { kind: "one" }
					: { kind: "value", expr: value(columnKey(rule.step.x)) }
			const delta = deltaOf(
				accumulates,
				step,
				() => value(columnKey(defined(rule.befores[0], "the first plane's before"))),
				sqlCombine
			)
			const selected = selection(lowering, rule.fold, value)
			return built(runningAfter(accumulates, first, delta, selected, running, to))
		}
		case "given":
		case "owner":
		case "self":
		case "base":
		case "count":
		case "start":
		case "end":
		case "last":
		case "generated":
			throw defect(
				`a ${rule.kind} rule among the columns a scan of ${spec.family.id.owner}.${spec.family.id.count} draws`
			)
	}
}

/** The keys of the columns a scan draws. */
const drawnKeysOf = (spec: ScanSpec): ReadonlySet<ColumnKey> =>
	new Set(spec.drawn.map((c) => columnKey(c.column)))

/**
 * Columns a scan draws by recursion (`chainLayer`): its columns, in the order the family fills them, and the drawn
 * columns outside it they read, which layers below it draw.
 */
interface Chain {
	readonly columns: NonEmptyReadonlyArray<FillColumn>
	readonly reads: ReadonlySet<ColumnKey>
}

/** A read of a drawn column by another, of the member's own row or (`across`) of the member before it. */
interface ScanRead {
	readonly to: ColumnKey
	readonly across: boolean
}

/**
 * The chains of a scan (see the header): each strongly connected set of its drawn columns, by what each reads as its
 * window draws it (`columnOf`), that reads itself across the member before it, with every accumulator of each fold
 * one of its afters is: the columns no window draws. A predecessor copy reads its source's drawn columns on the member
 * before; a fold's after its step's and its selection's, and a met plane its first plane's before, on its own row, never
 * its own befores, which its running aggregate needs none of. Every other cycle of a row's reads the fill order refuses
 * (analysis/theory/fill.ts), so a set that reads itself reads itself across a member.
 */
const chainsOf = (spec: ScanSpec): ReadonlyArray<Chain> => {
	const byKey = new Map(spec.drawn.map((c) => [columnKey(c.column), c] as const))
	/** The drawn columns a value of `key` on a member's row reads: itself where drawn, else a generated field's reads'. */
	const drawnReads = (key: ColumnKey): ReadonlyArray<ColumnKey> => {
		if (byKey.has(key)) {
			return [key]
		}
		const field = spec.member.fields.find((f) => columnKeyOf(f.name) === key)
		return field?.writing.kind === "generated"
			? fieldReads([field.writing.expr]).flatMap((name) => drawnReads(columnKeyOf(name)))
			: []
	}
	const readsOfColumn = (c: FillColumn): ReadonlyArray<ScanRead> => {
		const rule = c.rule
		switch (rule.kind) {
			case "predecessor":
				return drawnReads(columnKey(rule.to)).map((to) => ({ to, across: true }))
			case "after": {
				const met = monoidSpecs[rule.fold.monoid].planes[rule.plane]?.delta === "met"
				return [
					...(rule.step.kind === "value" ? [columnKey(rule.step.x)] : []),
					...fieldReads(rule.fold.where).map(columnKeyOf),
					...(met ? [columnKey(defined(rule.befores[0], "a fold's first before"))] : [])
				].flatMap((k) => drawnReads(k).map((to) => ({ to, across: false })))
			}
			case "given":
			case "owner":
			case "self":
			case "base":
			case "index":
			case "copy":
			case "count":
			case "start":
			case "end":
			case "ownerCopy":
			case "last":
			case "generated":
				return []
		}
	}
	const reads = new Map(spec.drawn.map((c) => [columnKey(c.column), readsOfColumn(c)] as const))
	/** Tarjan's strongly connected components of the reads, each a set of drawn columns' keys. */
	const components: Array<ReadonlySet<ColumnKey>> = []
	const index = new Map<ColumnKey, number>()
	const low = new Map<ColumnKey, number>()
	const stack: Array<ColumnKey> = []
	const onStack = new Set<ColumnKey>()
	const visit = (v: ColumnKey): void => {
		index.set(v, index.size)
		low.set(v, index.size - 1)
		stack.push(v)
		onStack.add(v)
		for (const { to } of reads.get(v) ?? []) {
			if (!index.has(to)) {
				visit(to)
				low.set(
					v,
					Math.min(
						defined(low.get(v), "a visited column"),
						defined(low.get(to), "a visited column")
					)
				)
			} else if (onStack.has(to)) {
				low.set(
					v,
					Math.min(
						defined(low.get(v), "a visited column"),
						defined(index.get(to), "a visited column")
					)
				)
			}
		}
		if (low.get(v) === index.get(v)) {
			const component = new Set<ColumnKey>()
			for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
				onStack.delete(w)
				component.add(w)
				if (w === v) {
					break
				}
			}
			components.push(component)
		}
	}
	for (const key of reads.keys()) {
		if (!index.has(key)) {
			visit(key)
		}
	}
	/** Each fold's accumulators among the drawn columns, by the fold's law: its afters and the befores copying them. */
	const foldOf = (c: FillColumn): FamilyFold | undefined => {
		const rule = c.rule
		if (rule.kind === "after") {
			return rule.fold
		}
		if (rule.kind === "predecessor") {
			const target = byKey.get(columnKey(rule.to))
			return target?.rule.kind === "after" ? target.rule.fold : undefined
		}
		return undefined
	}
	const chained = components.filter((component) =>
		[...component].some((k) => (reads.get(k) ?? []).some((r) => r.across && component.has(r.to)))
	)
	/** The chains, each closed over the folds its afters are of, and merged where two hold one fold. */
	const merged: Array<Set<ColumnKey>> = []
	for (const component of chained) {
		const folds = new Set(
			[...component].flatMap((k) => {
				const fold = foldOf(defined(byKey.get(k), "a drawn column"))
				return fold === undefined ? [] : [fold]
			})
		)
		const closed = new Set([
			...component,
			...spec.drawn.flatMap((c) => {
				const fold = foldOf(c)
				return fold !== undefined && folds.has(fold) ? [columnKey(c.column)] : []
			})
		])
		const meeting = merged.filter((m) => [...closed].some((k) => m.has(k)))
		for (const m of meeting) {
			for (const k of m) {
				closed.add(k)
			}
			merged.splice(merged.indexOf(m), 1)
		}
		merged.push(closed)
	}
	return merged.map((keys) => {
		const columns = spec.drawn.filter((c) => keys.has(columnKey(c.column)))
		const [first, ...rest] = columns
		return {
			columns: [defined(first, "a chain's column"), ...rest],
			reads: new Set(
				[...keys].flatMap((k) =>
					(reads.get(k) ?? []).flatMap((r) => (keys.has(r.to) ? [] : [r.to]))
				)
			)
		}
	})
}

/**
 * A fold plane's after at one member, as a chain draws it: `combine(befores, x)` where the fold's selection holds and
 * its before elsewhere, in exact arithmetic where its operation sums a value (ir/monoid.ts accumulations), as the fold's
 * CHECK proves it.
 */
const steppedAfter = (
	fold: FamilyFold,
	plane: 0 | 1,
	befores: NonEmptyReadonlyArray<Expr>,
	step: CombineStep<Expr>,
	selected: Expr | undefined
): Expr => {
	const accumulates = defined(monoidSpecs[fold.monoid].planes[plane], `plane ${plane} of a fold`)
	const numeric = accumulations[accumulates.fn].exact && step.kind === "value"
	const arithmetic = (e: Expr): Expr => (numeric ? cast(e, types.numeric) : e)
	const before = defined(befores[plane], `the before of plane ${plane}`)
	const after = sqlCombine.apply(
		accumulates.fn,
		arithmetic(before),
		arithmetic(
			stepValue(
				deltaOf(accumulates, step, () => befores[0], sqlCombine),
				sqlCombine
			)
		)
	)
	return selected === undefined
		? after
		: { kind: "case", operand: undefined, whens: [{ when: selected, result: after }], else: before }
}

/**
 * The layer drawing `chain` over the layer `below` (see the header): a recursive CTE of every row below with the chain's
 * columns, each group's first drawn slot drawn from its seed or the family's base, each next slot from that slot's row
 * and the one before it, joined at its group and slot; the layer below a CTE of its own, which both terms read. Each
 * column is its rule over the row as the chain reads it: a predecessor copy its source on the member before, a fold's
 * after its combine over its befores, each of its own row, and a column of the chain one of its own row reads its value
 * there; every column is cast to its base, and a text collated as every stored text is, so the two terms agree.
 */
const chainLayer = (
	lowering: ScanLowering,
	supply: NameSupply,
	spec: ScanSpec,
	layout: Layout,
	below: Layer,
	chain: Chain
): Layer => {
	const rows = supply.relation(internal("scan chain rows"))
	const name = supply.relation(internal("scan chain"))
	const inChain = new Set(chain.columns.map((c) => columnKey(c.column)))
	const names = chain.columns.map((c) =>
		defined(layout.scanned.get(columnKey(c.column)), "a drawn column")
	)
	const columns = [...below.columns, ...names]
	/** A row's column at `alias`, by its scanned name: every carried and drawn column the layer below holds. */
	const held =
		(alias: string): Read =>
		(key) => {
			const n = layout.scanned.get(key)
			return n === undefined ? undefined : col(alias, n)
		}
	/** The chain's columns of the row at `at`, the member before it at `before` (none at a group's first drawn slot). */
	const drawnAt = (at: string, before: string | undefined): ReadonlyArray<Target> => {
		const memo = new Map<ColumnKey, Expr>()
		const value = ownValue(
			spec.member,
			(key) => (inChain.has(key) ? chained(key) : held(at)(key)),
			lowering
		)
		const previous = ownValue(spec.member, held(before ?? at), lowering)
		const chained = (key: ColumnKey): Expr => {
			const known = memo.get(key)
			if (known !== undefined) {
				return known
			}
			const c = defined(
				chain.columns.find((x) => columnKey(x.column) === key),
				"a column of the chain"
			)
			const rule = c.rule
			const expr = ((): Expr => {
				switch (rule.kind) {
					case "predecessor":
						return before === undefined
							? {
									kind: "case",
									operand: undefined,
									whens: [
										{
											when: eq(col(at, layout.first), lit.int(0, types.bigint)),
											result: lowerLiteral(lowering.names, rule.base, c.type)
										}
									],
									else: col(at, defined(layout.seed.get(columnKey(rule.to)), "a seed column"))
								}
							: previous(columnKey(rule.to))
					case "after":
						return steppedAfter(
							rule.fold,
							rule.plane,
							mapNonEmpty(
								[defined(rule.befores[0], "a fold's first before"), ...rule.befores.slice(1)],
								(b) => value(columnKey(b))
							),
							rule.step.kind === "one"
								? { kind: "one" }
								: { kind: "value", expr: value(columnKey(rule.step.x)) },
							selection(lowering, rule.fold, value)
						)
					case "given":
					case "owner":
					case "self":
					case "base":
					case "index":
					case "copy":
					case "count":
					case "start":
					case "end":
					case "ownerCopy":
					case "last":
					case "generated":
						throw defect(`a ${rule.kind} rule among the columns a chain of a scan draws`)
				}
			})()
			const base = lowering.baseType(c.type)
			const typed = cast(expr, base)
			const collated: Expr =
				base.kind === "builtin" && base.name === "text"
					? { kind: "collate", expr: typed, collation: cUtf8Collation }
					: typed
			memo.set(key, collated)
			return collated
		}
		return [
			...below.columns.map((n) => targetAs(col(at, n), n)),
			...chain.columns.map((c, i) =>
				targetAs(chained(columnKey(c.column)), defined(names[i], "a chain column's name"))
			)
		]
	}
	const first = supply.relation(internal("scan chain first"))
	const next = supply.relation(internal("scan chain next"))
	const before = supply.relation(internal("scan chain before"))
	const top = supply.relation(internal("scan chain row"))
	const seeded = provedCore(
		"keyed",
		drawnAt(first, undefined),
		[cteRefAs(rows, first)],
		eq(col(first, layout.slot), col(first, layout.first))
	)
	const stepped = provedCore(
		"keyed",
		drawnAt(next, before),
		[
			join(
				cteRefAs(name, before),
				cteRefAs(rows, next),
				and([
					sameGroup(lowering.names, spec.family, before, layout.group, next, layout.group),
					eq(
						col(next, layout.slot),
						binary("+", col(before, layout.slot), lit.int(1, types.bigint))
					)
				])
			)
		],
		undefined
	)
	return {
		query: {
			...select(
				provedCore(
					"keyed",
					columns.map((n) => targetAs(col(top, n), n)),
					[cteRefAs(name, top)],
					undefined
				)
			),
			with: {
				recursive: true,
				ctes: [
					{ name: rows, columns: below.columns, materialized: undefined, query: below.query },
					{
						name,
						columns,
						materialized: undefined,
						query: select(unionAll("disjoint", [seeded, stepped]))
					}
				]
			}
		},
		columns
	}
}
