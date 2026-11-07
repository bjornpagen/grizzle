/**
 * The backfill of the families a migration adds to relations that may hold rows (rows-first §6): grizzle draws every
 * value a family holds (each index, count, copy and accumulator), so a family new to stored rows takes its values from
 * SQL over those rows, in the migration that adds it, never from the reviewer.
 *
 * Each column the backfill writes is added with a placeholder DEFAULT (AlterTableAction addColumnDefault): the value it
 * holds where its family is empty, 0 for a count or an index and the fold's identity for an accumulator or an end, which
 * the backfill overwrites on every row that has a member before the DROP DEFAULT. The backfill runs after every column's
 * ADD COLUMN and before every constraint that reads one (slots structure.backfill, structure.constraints), and VALIDATE
 * then proves it: a value it drew wrongly is a violation of the family's own natives, never a silent state.
 *
 * - **Counted:** ‹i› = row_number() OVER (PARTITION BY g ORDER BY the member key) − 1, and ‹n› the group's count. The
 *   member key is a key of the stored rows, so the order is total and no two members tie (rows-first §0).
 * - **Ordered:** the drawn index the same, by the member key: the stored rows carry no order of the caller's.
 * - **Folds:** each plane's after a running aggregate of its masked step in index order, its frame ROWS BETWEEN UNBOUNDED
 *   PRECEDING AND CURRENT ROW, never RANGE, which would merge peers; each before its predecessor's after, the identity
 *   at the first slot (lag); and the owner's end its last member's after, the identity for an empty group (the
 *   placeholder default).
 * - **Trees:** each row's sibling index by its key, its count and its parent's count, its pre-order interval and its
 *   parent's start, by the one recursive step a migration holds: the closure of the parent relation, from which each
 *   row's subtree size, and its start as the sum over its ancestors of one plus the sizes of their earlier siblings.
 *
 * - **Tree folds:** over each row's siblings in slot order, their order by start, the root alone at slot 0, its before
 *   the identity; each row's end its last child's after.
 * - **Copies:** each copy an axis carries is its target's value, joined to the row its axis names, after every family's
 *   own columns are drawn and after any copy it reads; a row its axis names no row for keeps the copy's base.
 *
 * Window functions and the one recursive CTE are admitted here: a migration is reviewed text, and grizzle's limits on
 * them are limits on its run-time queries. What the backfill cannot draw from stored rows alone (copies that read each
 * other, a fold over a copy, a family whose drawn columns are partly stored) is refused, naming the family.
 */
import { Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { nameKey } from "#compiler/deploy/snapshot/objects.ts"
import type { SnapshotTheory } from "#compiler/deploy/snapshot/types.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { AxisKind, Family, FamilyFold, FoldPlane, TreeShape } from "#compiler/ir/family.ts"
import type { NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	lowerPersistent,
	persistentClosed,
	persistentLiteral
} from "#compiler/physical/ddl/expr.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type {
	Assignment,
	Expr,
	FromItem,
	FromSource,
	ObjectName,
	Select,
	SqlStatement,
	Target,
	TypeRef,
	Update,
	WindowSpec
} from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	binary,
	call,
	cast,
	col,
	core,
	countStar,
	cte,
	cteRefAs,
	derived,
	eq,
	join,
	lit,
	not,
	objectName,
	provedCore,
	select,
	setOperation,
	tableCol,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"

/** The columns of each table the target's families draw, by table key (nameKey), then column, each with the value it
 * holds where its family is empty: the placeholder DEFAULT a migration adds it under to a table that may hold rows. */
export type DrawnColumns = ReadonlyMap<string, ReadonlyMap<string, Expr>>

/** The columns this migration adds to a table under their placeholder defaults, in the order it adds them. */
export interface BackfilledTable {
	readonly table: ObjectName
	readonly columns: ReadonlyArray<string>
}

/** Each table's columns this migration adds under their placeholder defaults, by table key (nameKey). */
export type Backfilled = ReadonlyMap<string, BackfilledTable>

/** What the backfill of a migration reads besides its target: the previous snapshot's theory, which names the key the
 * stored rows of a relation are distinct by, whether a table of the target holds rows before the migration, and the
 * columns the migration adds under their placeholder defaults (DrawnColumns). */
export interface BackfillInput {
	readonly installation: Installation
	readonly previous: SnapshotTheory
	readonly mayHoldRows: (table: ObjectName) => boolean
	readonly added: Backfilled
}

/** The SQL of a migration's backfill: the UPDATEs that draw its families' values over the stored rows, in order, then
 * the DROP DEFAULT of every column the migration added under a placeholder. */
export interface Backfill {
	readonly updates: ReadonlyArray<SqlStatement>
	readonly dropDefaults: ReadonlyArray<SqlStatement>
}

const backfillLoc = SourceLoc("backfill", [])

/** A function declaration, so that control flow knows a call never returns. */
function refuseBackfill(family: Family, what: string): never {
	throw new Refusal(
		unsupported(
			backfillLoc,
			`backfilling the family ${family.owner.name}.${family.count.name} added to relations that may hold rows: ${what}`
		)
	)
}

/** The stored relation of the target's theory named `name`: a family's owner and member are stored relations. */
const relationOf = (installation: Installation, name: string): RelationInfo => {
	const r = installation.laws.theory.relations[name]
	if (r?.kind !== "relation") {
		throw defect(`a family's relation ${name} is a stored relation of the theory`)
	}
	return r
}

/** The table a stored relation is installed as. */
const tableOf = (installation: Installation, name: string): ObjectName =>
	objectName(installation.names.schema, relationOf(installation, name).ident)

/** The installed column of a family's native column: a field's, or a law column's own identifier. */
const columnOf = (c: NativeColumn): string => (c.kind === "field" ? c.field.column : c.column)

/** A literal of `type` in a persistent expression: typed by its base, never cast to a domain (persistentLiteral). */
const literalOf = (installation: Installation, value: TypedLiteral, type: ScalarType): Expr =>
	persistentLiteral(installation.names, value, type)

const zero: TypedLiteral = { kind: "int", value: 0n }

/** The value 0 of a family's counts and indices, typed by its count's base. */
const zeroOf = (installation: Installation, family: Family): Expr =>
	literalOf(installation, zero, family.count.type)

/** A fold plane's identity, typed by its end's base: its accumulators' value at the first slot, and its end's for an
 * empty family. */
const identityOf = (installation: Installation, plane: FoldPlane): Expr =>
	literalOf(installation, plane.identity, plane.end.type)

/**
 * The columns the target's families draw (DrawnColumns): on a member, the counted index ‹i› or the ordered index, the
 * copy ‹n›, each fold plane's before and after; on an owner, the count and each fold plane's end; a tree's interval and
 * its parent's start among them; and every copy an axis carries (Copy) on its source. Each holds 0 where its family is
 * empty, but an accumulator or an end, which holds its plane's identity, and a copy, which holds its base.
 */
export const drawnColumns = (installation: Installation): DrawnColumns => {
	const out = new Map<string, Map<string, Expr>>()
	const put = (relation: string, column: string, value: Expr): void => {
		const key = nameKey(tableOf(installation, relation))
		const of = out.get(key) ?? new Map<string, Expr>()
		of.set(column, value)
		out.set(key, of)
	}
	for (const family of installation.laws.families) {
		const member = family.member.name
		const owner = family.owner.name
		const nothing = zeroOf(installation, family)
		put(member, columnOf(family.index), nothing)
		put(member, family.copy, nothing)
		put(owner, family.count.column, nothing)
		if (family.members.kind === "tree") {
			put(member, family.members.start.column, nothing)
			put(member, family.members.end.column, nothing)
			put(member, family.members.parentStart, nothing)
		}
		for (const fold of family.folds) {
			for (const plane of fold.planes) {
				const identity = identityOf(installation, plane)
				put(member, columnOf(plane.before), identity)
				put(member, columnOf(plane.after), identity)
				put(owner, plane.end.column, identity)
			}
		}
		for (const copy of copiesOf(installation, family)) {
			const base = baseOf(installation, copy.from)
			if (base !== undefined) {
				put(copy.axis === "last" ? owner : member, columnOf(copy.from), base)
			}
		}
	}
	return out
}

/** A window over a partition in an order, ROWS from the partition's first row to the current one when `running`. */
const window = (
	partitionBy: ReadonlyArray<Expr>,
	orderBy: ReadonlyArray<Expr>,
	running: boolean
): WindowSpec => ({
	partitionBy,
	orderBy: orderBy.map(asc),
	frame: running
		? { start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" } }
		: undefined
})

/** A window function's call over `over`. */
const over = (
	fn: "row_number" | "sum" | "max" | "bit_or" | "string_agg" | "lag",
	args: ReadonlyArray<Expr>,
	spec: WindowSpec
): Expr => ({
	...call(fn, args),
	over: spec
})

/** One layer of the backfill's derived tables: the columns it computes, each over the layer below's columns. */
interface Layer {
	readonly columns: ReadonlyArray<{ readonly name: string; readonly expr: Expr }>
}

/**
 * The rows of `source`, one per row it holds, with each column the layers compute: `carried` read off the source
 * itself, then each layer a derived table over the one below it, which reads every column below it by name, so a window
 * of a layer reads its own layer's inputs only. A layer of no column adds no table.
 */
const layered = (
	source: FromSource,
	carried: NonEmptyReadonlyArray<string>,
	layers: ReadonlyArray<Layer>
): Select => {
	let from: FromSource = source
	const names: Array<string> = [...carried]
	let query: Select | undefined
	let depth = 0
	for (const layer of layers) {
		if (layer.columns.length === 0) {
			continue
		}
		const targets: ReadonlyArray<Target> = [
			...names.map((n) => targetAs(tableCol(n), n)),
			...layer.columns.map((c) => targetAs(c.expr, c.name))
		]
		query = select(provedCore("keyed", targets, [from], undefined))
		for (const c of layer.columns) {
			names.push(c.name)
		}
		depth += 1
		from = derived(query, `l${depth}`, [], false)
	}
	if (query === undefined) {
		throw defect("a backfill computes at least one column")
	}
	return query
}

/** The names a backfill's layers give what they compute, none of them a field's, since no declared name starts with an
 * underscore. */
const indexName = "__i"
const countName = "__n"
const stepName = (f: number): string => `__x_${f}`
const afterName = (f: number, p: number): string => `__after_${f}_${p}`
const beforeName = (f: number, p: number): string => `__before_${f}_${p}`

/** The running aggregate of a monoid's first plane over its masked steps (count's and sum's a sum of the steps, each 0
 * where its selection fails, max's a max, each the least value there, or's a union, each the empty set there, and
 * concat's the steps' concatenation in the family's order, each the empty text there), with the arguments it takes
 * beside the step: string_agg's empty delimiter. */
const runningOf = (
	fold: FamilyFold
): {
	readonly fn: "sum" | "max" | "bit_or" | "string_agg"
	readonly after: ReadonlyArray<Expr>
} => {
	switch (fold.monoid) {
		case "count":
		case "sum":
			return { fn: "sum", after: [] }
		case "max":
			return { fn: "max", after: [] }
		case "or":
		case "twos":
			return { fn: "bit_or", after: [] }
		case "concat":
			return { fn: "string_agg", after: [lit.text("", types.text)] }
	}
}

/** The step of a fold on a member's row, masked by its selection: the value it combines where the selection holds, and
 * the value its monoid's running aggregate leaves unchanged elsewhere (0 for count and sum, the identity for max, or and
 * twos). Count and sum step in numeric, exactly; max, or and twos in their end's base type. */
const maskedStep = (
	installation: Installation,
	member: RelationInfo,
	fold: FamilyFold,
	base: TypeRef,
	identity: Expr
): Expr => {
	const exact = fold.monoid === "count" || fold.monoid === "sum"
	const value =
		fold.step.kind === "one"
			? lit.int(1n, types.numeric)
			: cast(tableCol(fold.step.field.column), exact ? types.numeric : base)
	const neutral = exact ? lit.int(0n, types.numeric) : identity
	const conjuncts = fold.where.map((w) =>
		lowerPersistent(installation.names, w, {
			reads: {
				kind: "row",
				column: (ref) => member.fields.find((f) => f.name === ref.name)?.column
			},
			closed: persistentClosed(installation.checked),
			loc: backfillLoc
		})
	)
	return isNonEmpty(conjuncts)
		? {
				kind: "case",
				operand: undefined,
				whens: [{ when: and(conjuncts), result: value }],
				else: neutral
			}
		: value
}

/** Whether `columns` holds the column of a native column. */
const holds = (columns: ReadonlySet<string>, c: NativeColumn): boolean => columns.has(columnOf(c))

/**
 * The columns the backfill orders a family's stored members by and joins its rows back on: the member's primary key,
 * a key of its stored rows; or, when the migration adds a field of that key (an ordered family's index is often one),
 * the key the previous snapshot records, which the stored rows are distinct by.
 */
const memberKey = (
	family: Family,
	member: RelationInfo,
	previous: SnapshotTheory,
	added: ReadonlySet<string>
): NonEmptyReadonlyArray<string> => {
	const own = mapNonEmpty(member.primaryFields, (f) => f.column)
	if (!own.some((c) => added.has(c))) {
		return own
	}
	const was = previous.relations[member.name]
	if (was?.kind !== "relation") {
		return refuseBackfill(family, `${member.name}'s stored rows have no key the snapshot records`)
	}
	const columns = was.primaryKey.map((name) => {
		const field = was.fields.find((f) => f.name === name)
		if (field === undefined) {
			throw defect(`the snapshot's relation ${member.name} records its key field ${name}`)
		}
		return field.column
	})
	if (!isNonEmpty(columns) || columns.some((c) => added.has(c))) {
		return refuseBackfill(family, `the key ${member.name}'s stored rows were distinct by is gone`)
	}
	return columns
}

/** A fold of a family by its place among the family's folds, which names its columns in the backfill's layers. */
interface FoldAt {
	readonly fold: FamilyFold
	readonly f: number
}

/** Each fold's masked step over a member's row (maskedStep), in its first plane's end's base type. */
const stepColumns = (
	installation: Installation,
	member: RelationInfo,
	folds: ReadonlyArray<FoldAt>
): Layer["columns"] =>
	folds.map(({ fold, f }) => {
		const [first] = fold.planes
		const base = baseTypeRef(installation.names, first.end.type)
		return {
			name: stepName(f),
			expr: maskedStep(installation, member, fold, base, identityOf(installation, first))
		}
	})

/**
 * The layers that accumulate each fold over rows that carry its step (stepColumns), each partition its family's group
 * in `inOrder`: each first plane's after, the running aggregate of its steps, its frame ROWS from the partition's first
 * row to the current one; each before its predecessor's after, the identity at the first slot; and twos's second plane,
 * the running union of each step's meet with the first plane before it, and its before the same way.
 */
const planeLayers = (
	installation: Installation,
	folds: ReadonlyArray<FoldAt>,
	partition: ReadonlyArray<Expr>,
	inOrder: ReadonlyArray<Expr>
): ReadonlyArray<Layer> => {
	const firstAfters: Layer = {
		columns: folds.map(({ fold, f }) => {
			const [first] = fold.planes
			const base = baseTypeRef(installation.names, first.end.type)
			return {
				name: afterName(f, 0),
				expr: cast(
					over(
						runningOf(fold).fn,
						[tableCol(stepName(f)), ...runningOf(fold).after],
						window(partition, inOrder, true)
					),
					base
				)
			}
		})
	}
	const befores = (p: number): Layer => ({
		columns: folds.flatMap(({ fold, f }) => {
			const plane = fold.planes[p]
			return plane === undefined
				? []
				: [
						{
							name: beforeName(f, p),
							expr: over(
								"lag",
								[
									tableCol(afterName(f, p)),
									lit.int(1n, types.integer),
									identityOf(installation, plane)
								],
								window(partition, inOrder, false)
							)
						}
					]
		})
	})
	const secondAfters: Layer = {
		columns: folds.flatMap(({ fold, f }) => {
			const second = fold.planes[1]
			if (second === undefined) {
				return []
			}
			const base = baseTypeRef(installation.names, second.end.type)
			const met = binary("&", tableCol(beforeName(f, 0)), tableCol(stepName(f)))
			return [
				{
					name: afterName(f, 1),
					expr: cast(over("bit_or", [met], window(partition, inOrder, true)), base)
				}
			]
		})
	}
	return [firstAfters, befores(0), secondAfters, befores(1)]
}

/** A fold plane's columns the backfill writes on its member, by `added`. */
const planesAdded = (fold: FamilyFold, added: ReadonlySet<string>): boolean =>
	fold.planes.some((p) => holds(added, p.before) || holds(added, p.after))

/** A family's member UPDATE: every column of its member the migration adds, drawn over the member's stored rows. */
const memberUpdate = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>
): Update | undefined => {
	const { installation } = input
	const member = relationOf(installation, family.member.name)
	const index = columnOf(family.index)
	const drawIndex = added.has(index)
	const folds = family.folds.flatMap((fold, f) => (planesAdded(fold, added) ? [{ fold, f }] : []))
	if (drawIndex && folds.length < family.folds.length) {
		return refuseBackfill(
			family,
			"its index is drawn anew while a fold keeps its stored accumulators"
		)
	}
	const assignments: Array<Assignment> = []
	const assign = (column: string, value: string): void => {
		if (added.has(column)) {
			assignments.push({ column, value: col("b", value) })
		}
	}
	assign(index, indexName)
	assign(family.copy, countName)
	for (const { fold, f } of folds) {
		for (const [p, plane] of fold.planes.entries()) {
			assign(columnOf(plane.before), beforeName(f, p))
			assign(columnOf(plane.after), afterName(f, p))
		}
	}
	if (!isNonEmpty(assignments)) {
		return undefined
	}
	const key = memberKey(family, member, input.previous, added)
	const group = mapNonEmpty(family.group, (g) => g.member.column)
	const carried = [...new Set([...key, ...group])]
	if (!isNonEmpty(carried)) {
		throw defect("a member carries its key")
	}
	const partition = group.map(tableCol)
	const inOrder = [tableCol(indexName)]
	const numbered = binary(
		"-",
		over("row_number", [], window(partition, key.map(tableCol), false)),
		lit.int(1n, types.bigint)
	)
	const steps: Layer = {
		columns: [
			{ name: indexName, expr: drawIndex ? numbered : tableCol(index) },
			{ name: countName, expr: { ...countStar(), over: window(partition, [], false) } },
			...stepColumns(installation, member, folds)
		]
	}
	const rows = layered({ kind: "table", table, alias: "m" }, carried, [
		steps,
		...planeLayers(installation, folds, partition, inOrder)
	])
	return {
		kind: "update",
		with: undefined,
		table,
		alias: "t",
		set: assignments,
		from: [derived(rows, "b", [], false)],
		where: and(mapNonEmpty(key, (k) => eq(col("t", k), col("b", k)))),
		returning: []
	}
}

/** A family's owner UPDATE: every column of its owner the migration adds, its last member's (its count's copy, each
 * plane's after), read off the member's backfilled rows; an owner with no member keeps its placeholder, which is the
 * value it holds (0, the identity). */
const ownerUpdate = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	memberTable: ObjectName,
	added: ReadonlySet<string>
): Update | undefined => {
	const assignments: Array<Assignment> = []
	if (added.has(family.count.column)) {
		assignments.push({ column: family.count.column, value: col("m", family.copy) })
	}
	for (const fold of family.folds) {
		for (const plane of fold.planes) {
			if (added.has(plane.end.column)) {
				assignments.push({ column: plane.end.column, value: col("m", columnOf(plane.after)) })
			}
		}
	}
	if (!isNonEmpty(assignments) || !input.mayHoldRows(memberTable)) {
		return undefined
	}
	const last = eq(
		col("m", columnOf(family.index)),
		binary("-", col("m", family.copy), lit.int(1n, types.bigint))
	)
	return {
		kind: "update",
		with: undefined,
		table,
		alias: "t",
		set: assignments,
		from: [{ kind: "table", table: memberTable, alias: "m" }],
		where: and([
			...mapNonEmpty(family.group, (g) => eq(col("t", g.owner.column), col("m", g.member.column))),
			last
		]),
		returning: []
	}
}

/** A core grouped by `groupBy`. */
const grouped = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	groupBy: ReadonlyArray<Expr>
): Select => select({ ...provedCore("grouped", targets, from, undefined), groupBy })

/** The names the tree's backfill gives what it computes, none a field's (no declared name starts with an underscore). */
const ancestorName = (k: number): string => `__a_${k}`
const descendantName = (k: number): string => `__d_${k}`
const closureName = "__closure"
const sizedName = "__sized"
const rankedName = "__ranked"
const steppedName = "__stepped"
const startedName = "__started"
const foldedName = "__folded"

/**
 * A tree's UPDATE: each row's drawn columns over the stored rows, under one WITH RECURSIVE.
 *
 * - `__closure`: every (ancestor-or-self, descendant) pair, the one recursive step: each row with itself, then each
 *   pair extended by a child of its descendant, the root, which is its own parent, never its own child; UNION, so the
 *   closure is a set and ends however the stored parents point.
 * - `__sized`: each row's subtree size, and its children, the rows whose parent it is but itself.
 * - `__ranked`: each row's sibling index, row_number() by its key among the rows of its parent, the root alone at 0,
 *   and its siblings' count, its parent's count.
 * - `__stepped`: each row's step, one plus the sizes of its earlier siblings, 0 for the root.
 * - `__started`: each row's start, the sum of the steps of its ancestors and itself: its pre-order index.
 *
 * - `__folded`: each fold over the tree, over each row's siblings in slot order, which is their order by start, the
 *   root alone at slot 0 (planeLayers): the root's before the identity, as its first-slot pin holds it, and its after
 *   its own step's, the one state NP's fold suite admits a root (test/pg/fin/fold.test.ts).
 *
 * Its end is its start plus its size, its copy of the count its siblings' count (the root's own count, as the root pin
 * reads it), and its parent's start the start of its parent's row, the root's own 0. A row the closure reaches from no
 * root, under stored parents that make no tree, is drawn anyway, and VALIDATE refuses it by the tree's laws. Each fold's
 * end is a row's last child's after (treeEndUpdate).
 */
const treeUpdate = (
	input: BackfillInput,
	family: Family,
	shape: TreeShape,
	table: ObjectName,
	added: ReadonlySet<string>
): Update => {
	const { installation } = input
	const member = relationOf(installation, family.member.name)
	const owner = mapNonEmpty(family.group, (g) => g.owner.column)
	const parent = mapNonEmpty(family.group, (g) => g.member.column)
	const key = memberKey(family, member, input.previous, added)
	const folds: ReadonlyArray<FoldAt> = family.folds.map((fold, f) => ({ fold, f }))
	const self = (alias: string): FromSource => ({ kind: "table", table, alias })
	const rootOf = (alias: string): Expr =>
		and(
			mapNonEmpty(family.group, (g) => eq(col(alias, g.member.column), col(alias, g.owner.column)))
		)
	const none = lit.int(0n, types.bigint)
	const one = lit.int(1n, types.bigint)
	const ancestors = owner.map((_, k) => ancestorName(k))
	const descendants = owner.map((_, k) => descendantName(k))
	const closure = cte(
		closureName,
		[...ancestors, ...descendants],
		select(
			setOperation("UNION", [
				core(
					[
						...owner.map((c, k) => targetAs(col("t", c), ancestorName(k))),
						...owner.map((c, k) => targetAs(col("t", c), descendantName(k)))
					],
					[self("t")],
					undefined
				),
				core(
					[
						...owner.map((_, k) => targetAs(col("c", ancestorName(k)), ancestorName(k))),
						...owner.map((c, k) => targetAs(col("t", c), descendantName(k)))
					],
					[
						join(
							cteRefAs(closureName, "c"),
							self("t"),
							and([
								...mapNonEmpty(parent, (p, k) => eq(col("t", p), col("c", descendantName(k)))),
								not(rootOf("t"))
							])
						)
					],
					undefined
				)
			])
		)
	)
	const sized = cte(
		sizedName,
		[],
		grouped(
			[
				...owner.map((_, k) => targetAs(col("c", ancestorName(k)), ancestorName(k))),
				targetAs(countStar(), "__size"),
				targetAs(
					{
						...countStar(),
						filter: and([
							...mapNonEmpty(parent, (p, k) => eq(col("t", p), col("c", ancestorName(k)))),
							not(rootOf("t"))
						])
					},
					"__children"
				)
			],
			[
				join(
					cteRefAs(closureName, "c"),
					self("t"),
					and(mapNonEmpty(owner, (c, k) => eq(col("t", c), col("c", descendantName(k)))))
				)
			],
			owner.map((_, k) => col("c", ancestorName(k)))
		)
	)
	const carried = [...new Set([...key, ...owner, ...parent])]
	const siblings = [...parent.map((p) => col("t", p)), rootOf("t")]
	const ranked = cte(
		rankedName,
		[],
		select(
			provedCore(
				"keyed",
				[
					...carried.map((c) => targetAs(col("t", c), c)),
					targetAs(rootOf("t"), "__root"),
					targetAs(col("s", "__size"), "__size"),
					targetAs(col("s", "__children"), "__children"),
					targetAs(
						{
							kind: "case",
							operand: undefined,
							whens: [{ when: rootOf("t"), result: none }],
							else: binary(
								"-",
								over(
									"row_number",
									[],
									window(
										siblings,
										key.map((k) => col("t", k)),
										false
									)
								),
								one
							)
						},
						"__at"
					),
					targetAs({ ...countStar(), over: window(siblings, [], false) }, "__siblings"),
					...stepColumns(installation, member, folds).map((c) => targetAs(c.expr, c.name))
				],
				[
					join(
						self("t"),
						cteRefAs(sizedName, "s"),
						and(mapNonEmpty(owner, (c, k) => eq(col("t", c), col("s", ancestorName(k)))))
					)
				],
				undefined
			)
		)
	)
	const steps = folds.map(({ f }) => stepName(f))
	const rankedColumns = [
		...carried,
		"__root",
		"__size",
		"__children",
		"__at",
		"__siblings",
		...steps
	]
	/** Each fold over the tree, its family each row's siblings in slot order, the root alone at slot 0: the layers over
	 * the ranked rows that accumulate it (planeLayers). */
	const foldCarried: NonEmptyReadonlyArray<string> = [
		...key,
		...parent.filter((p) => !key.includes(p)),
		"__root",
		"__at",
		...steps
	]
	const folded = isNonEmpty(folds)
		? [
				cte(
					foldedName,
					[],
					layered(
						cteRefAs(rankedName, "r"),
						foldCarried,
						planeLayers(
							installation,
							folds,
							[...parent.map((p) => tableCol(p)), tableCol("__root")],
							[tableCol("__at")]
						)
					)
				)
			]
		: []
	const planes = folds.flatMap(({ fold, f }) =>
		fold.planes.flatMap((plane, p) => [
			{ column: columnOf(plane.before), name: beforeName(f, p) },
			{ column: columnOf(plane.after), name: afterName(f, p) }
		])
	)
	const stepped = cte(
		steppedName,
		[],
		select(
			provedCore(
				"keyed",
				[
					...rankedColumns.map((c) => targetAs(col("r", c), c)),
					targetAs(
						{
							kind: "case",
							operand: undefined,
							whens: [{ when: col("r", "__root"), result: none }],
							else: binary(
								"+",
								one,
								binary(
									"-",
									over(
										"sum",
										[col("r", "__size")],
										window(
											[...parent.map((p) => col("r", p)), col("r", "__root")],
											[col("r", "__at")],
											true
										)
									),
									col("r", "__size")
								)
							)
						},
						"__step"
					)
				],
				[cteRefAs(rankedName, "r")],
				undefined
			)
		)
	)
	const started = cte(
		startedName,
		[],
		grouped(
			[
				...owner.map((_, k) => targetAs(col("c", descendantName(k)), descendantName(k))),
				targetAs(call("sum", [col("st", "__step")]), "__start")
			],
			[
				join(
					cteRefAs(closureName, "c"),
					cteRefAs(steppedName, "st"),
					and(mapNonEmpty(owner, (c, k) => eq(col("st", c), col("c", ancestorName(k)))))
				)
			],
			owner.map((_, k) => col("c", descendantName(k)))
		)
	)
	const drawn: Select = select(
		provedCore(
			"keyed",
			[
				...key.map((k) => targetAs(col("st", k), k)),
				targetAs(col("st", "__at"), "__at"),
				targetAs(col("st", "__children"), "__children"),
				targetAs(
					{
						kind: "case",
						operand: undefined,
						whens: [{ when: col("st", "__root"), result: col("st", "__children") }],
						else: col("st", "__siblings")
					},
					"__n"
				),
				targetAs(cast(col("s", "__start"), types.bigint), "__start"),
				targetAs(
					cast(binary("+", col("s", "__start"), col("st", "__size")), types.bigint),
					"__end"
				),
				targetAs(cast(col("ps", "__start"), types.bigint), "__ps"),
				...planes.map(({ name }) => targetAs(col("f", name), name))
			],
			[
				{
					kind: "joins",
					first: cteRefAs(steppedName, "st"),
					steps: [
						{
							kind: "on",
							source: cteRefAs(startedName, "s"),
							on: and(mapNonEmpty(owner, (c, k) => eq(col("s", descendantName(k)), col("st", c))))
						},
						{
							kind: "on",
							source: cteRefAs(startedName, "ps"),
							on: and(mapNonEmpty(parent, (p, k) => eq(col("ps", descendantName(k)), col("st", p))))
						},
						...(isNonEmpty(folds)
							? [
									{
										kind: "on" as const,
										source: cteRefAs(foldedName, "f"),
										on: and(mapNonEmpty(key, (k) => eq(col("f", k), col("st", k))))
									}
								]
							: [])
					]
				}
			],
			undefined
		)
	)
	const set: NonEmptyReadonlyArray<Assignment> = [
		{ column: columnOf(family.index), value: col("b", "__at") },
		{ column: family.count.column, value: col("b", "__children") },
		{ column: family.copy, value: col("b", "__n") },
		{ column: shape.start.column, value: col("b", "__start") },
		{ column: shape.end.column, value: col("b", "__end") },
		{ column: shape.parentStart, value: col("b", "__ps") },
		...planes.map(({ column, name }) => ({ column, value: col("b", name) }))
	]
	return {
		kind: "update",
		with: { recursive: true, ctes: [closure, sized, ranked, stepped, started, ...folded] },
		table,
		alias: "t",
		set,
		from: [derived(drawn, "b", [], false)],
		where: and(mapNonEmpty(key, (k) => eq(col("t", k), col("b", k)))),
		returning: []
	}
}

/** A tree's fold ends: each row's end its last child's after, read off the backfilled rows; a leaf keeps its
 * placeholder, the identity, which an empty family's end is. */
const treeEndUpdate = (family: Family, table: ObjectName): Update | undefined => {
	const set = family.folds.flatMap((fold) =>
		fold.planes.map((plane) => ({
			column: plane.end.column,
			value: col("c", columnOf(plane.after))
		}))
	)
	if (!isNonEmpty(set)) {
		return undefined
	}
	return {
		kind: "update",
		with: undefined,
		table,
		alias: "t",
		set,
		from: [{ kind: "table", table, alias: "c" }],
		where: and([
			...mapNonEmpty(family.group, (g) => eq(col("c", g.member.column), col("t", g.owner.column))),
			not(
				and(
					mapNonEmpty(family.group, (g) => eq(col("c", g.member.column), col("c", g.owner.column)))
				)
			),
			eq(
				col("c", columnOf(family.index)),
				binary("-", col("c", family.copy), lit.int(1n, types.bigint))
			)
		]),
		returning: []
	}
}

/** The columns a family draws beside its copies: its index, copy and count, its folds' planes and ends, and a tree's
 * interval and parent's start. */
const familyColumns = (family: Family): ReadonlySet<string> =>
	new Set<string>([
		columnOf(family.index),
		family.copy,
		family.count.column,
		...family.folds.flatMap((fold) =>
			fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after), p.end.column])
		),
		...(family.members.kind === "tree"
			? [family.members.start.column, family.members.end.column, family.members.parentStart]
			: [])
	])

/**
 * A copy a family's axis carries (rows-first §6 as amended): a column the host fills on the axis's source row, `from`,
 * with the value of `to` on the row the axis names, its target. The owner axis names each member's owner, a tree's
 * row its parent's, the root its own (it references itself), so no row lacks one; the predecessor axis names the
 * member at the slot before, and the first slot holds the copy's base; the last axis names an owner's last member, and
 * an empty family holds the base. The base is an accumulated field's declared start: the placeholder the copy is added
 * under, which the backfill leaves wherever the axis names no row.
 */
interface Copy {
	readonly family: Family
	readonly axis: AxisKind
	readonly from: NativeColumn
	readonly to: NativeColumn
	/** The table `from` is on: the member's, or the owner's for the last axis. */
	readonly source: ObjectName
	/** The table `to` is on: the owner's for the owner axis, the member's otherwise. */
	readonly target: ObjectName
}

/** Whether the host fills a column: a law column, or a drawn or accumulated field. */
const hostFilled = (c: NativeColumn): boolean =>
	c.kind === "law" || c.field.writing.kind === "drawn" || c.field.writing.kind === "accumulated"

/** The copies a family's axes carry beside its formers' own columns (familyColumns), in axis order. */
const copiesOf = (installation: Installation, family: Family): ReadonlyArray<Copy> => {
	const own = familyColumns(family)
	const member = tableOf(installation, family.member.name)
	const owner = tableOf(installation, family.owner.name)
	return (["owner", "predecessor", "last"] as const).flatMap((axis) =>
		family.axes[axis].flatMap((pair): ReadonlyArray<Copy> =>
			hostFilled(pair.from) && !own.has(columnOf(pair.from))
				? [
						{
							family,
							axis,
							from: pair.from,
							to: pair.to,
							source: axis === "last" ? owner : member,
							target: axis === "owner" ? owner : member
						}
					]
				: []
		)
	)
}

/** A copy's base: an accumulated field's declared start; a law column has none, so a copy of one is never drawn. */
const baseOf = (installation: Installation, c: NativeColumn): Expr | undefined =>
	c.kind === "field" && c.field.writing.kind === "accumulated"
		? literalOf(installation, c.field.writing.start, c.field.type)
		: undefined

/** Whether every member of a tree but its root is the row a column reference names: a tree's family leaves the root
 * out, so the predecessor and last axes never name it. */
const nonRoot = (family: Family, alias: string): ReadonlyArray<Expr> =>
	family.members.kind === "tree"
		? [
				not(
					and(
						mapNonEmpty(family.group, (g) =>
							eq(col(alias, g.member.column), col(alias, g.owner.column))
						)
					)
				)
			]
		: []

/** A copy's UPDATE: its column set, on every source row, to `to` on the row its axis names, read as the table stood
 * before the statement; a source row whose axis names none keeps its base. */
const copyUpdate = (copy: Copy): Update => {
	const { family, from, to } = copy
	const index = columnOf(family.index)
	const predecessorOf = (row: string, before: string): Expr =>
		eq(col(before, index), binary("-", col(row, index), lit.int(1n, types.bigint)))
	const where = ((): NonEmptyReadonlyArray<Expr> => {
		switch (copy.axis) {
			case "owner":
				return mapNonEmpty(family.group, (g) =>
					eq(col("t", g.member.column), col("a", g.owner.column))
				)
			case "predecessor":
				return [
					...mapNonEmpty(family.group, (g) =>
						eq(col("t", g.member.column), col("a", g.member.column))
					),
					...nonRoot(family, "t"),
					...nonRoot(family, "a"),
					predecessorOf("t", "a")
				]
			case "last":
				return [
					...mapNonEmpty(family.group, (g) =>
						eq(col("a", g.member.column), col("t", g.owner.column))
					),
					...nonRoot(family, "a"),
					eq(col("a", index), binary("-", col("a", family.copy), lit.int(1n, types.bigint)))
				]
		}
	})()
	return {
		kind: "update",
		with: undefined,
		table: copy.source,
		alias: "t",
		set: [{ column: columnOf(from), value: col("a", columnOf(to)) }],
		from: [{ kind: "table", table: copy.target, alias: "a" }],
		where: and(where),
		returning: []
	}
}

/** The column a copy fills, by its table and its column. */
const fillKey = (table: ObjectName, column: string): string => `${nameKey(table)}\u0000${column}`

/**
 * The copies' UPDATEs in an order that reads every copy's target after it is drawn: a copy whose target column is
 * another copy's comes after it. A copy of itself along its axis (a tree's column copied from its parent's, a member's
 * from its predecessor's) holds its base on every row, which its placeholder is, so it reads itself as it stands. Two
 * copies that read each other have no such order and are refused.
 */
const orderedCopies = (copies: ReadonlyArray<Copy>): ReadonlyArray<Copy> => {
	const by = new Map(copies.map((c) => [fillKey(c.source, columnOf(c.from)), c] as const))
	const done = new Set<string>()
	const placed: Array<Copy> = []
	const visiting = new Set<string>()
	const place = (c: Copy): void => {
		const key = fillKey(c.source, columnOf(c.from))
		if (done.has(key)) {
			return
		}
		if (visiting.has(key)) {
			return refuseBackfill(
				c.family,
				`the copies along its axes read each other, ${columnOf(c.from)} among them`
			)
		}
		visiting.add(key)
		const reads = by.get(fillKey(c.target, columnOf(c.to)))
		if (reads !== undefined && reads !== c) {
			place(reads)
		}
		visiting.delete(key)
		done.add(key)
		placed.push(c)
	}
	for (const c of copies) {
		place(c)
	}
	return placed
}

/** The columns an expression reads, by name. */
const readColumns = (e: Expr): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column") {
				out.push(x.column)
			}
			return x
		}
	})
	return out
}

/** The member columns a family's folds read: each value step's field and each selection's columns. */
const foldReads = (installation: Installation, family: Family): ReadonlySet<string> => {
	const member = relationOf(installation, family.member.name)
	return new Set(
		family.folds.flatMap((fold) => [
			...(fold.step.kind === "value" ? [fold.step.field.column] : []),
			...fold.where.flatMap((w) =>
				readColumns(
					lowerPersistent(installation.names, w, {
						reads: {
							kind: "row",
							column: (ref) => member.fields.find((f) => f.name === ref.name)?.column
						},
						closed: persistentClosed(installation.checked),
						loc: backfillLoc
					})
				)
			)
		])
	)
}

/**
 * The backfill of every family of the target whose columns this migration adds to a table that may hold rows
 * (Backfill), family by family in the law model's order: its member's UPDATE, then its owner's, which reads the
 * member's backfilled rows (a tree's one UPDATE, then its fold ends); then every copy this migration adds, in an order
 * that reads each copy's target once it is drawn (orderedCopies). A family whose columns are all new to tables that hold
 * no row needs none: its placeholders are the values an empty family holds.
 */
export const backfillOf = (input: BackfillInput): Backfill => {
	const { installation } = input
	const updates: Array<SqlStatement> = []
	for (const family of installation.laws.families) {
		const memberTable = tableOf(installation, family.member.name)
		const ownerTable = tableOf(installation, family.owner.name)
		const onMember = new Set(
			input.mayHoldRows(memberTable) ? (input.added.get(nameKey(memberTable))?.columns ?? []) : []
		)
		const onOwner = new Set(
			input.mayHoldRows(ownerTable) ? (input.added.get(nameKey(ownerTable))?.columns ?? []) : []
		)
		const memberColumns = new Set<string>([
			columnOf(family.index),
			family.copy,
			...family.folds.flatMap((fold) =>
				fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after)])
			)
		])
		const ownerColumns = new Set<string>([
			family.count.column,
			...family.folds.flatMap((fold) => fold.planes.map((p) => p.end.column))
		])
		const mine = new Set([...onMember].filter((c) => memberColumns.has(c)))
		const theirs = new Set([...onOwner].filter((c) => ownerColumns.has(c)))
		if (family.members.kind === "tree") {
			const shape = family.members
			const columns = [
				columnOf(family.index),
				family.count.column,
				family.copy,
				shape.start.column,
				shape.end.column,
				shape.parentStart,
				...family.folds.flatMap((fold) =>
					fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after), p.end.column])
				)
			]
			const drawnHere = columns.filter((c) => onMember.has(c))
			if (drawnHere.length === 0) {
				continue
			}
			if (drawnHere.length < columns.length) {
				return refuseBackfill(family, "its drawn columns are partly stored already")
			}
			updates.push(treeUpdate(input, family, shape, memberTable, onMember))
			const ends = treeEndUpdate(family, memberTable)
			if (ends !== undefined) {
				updates.push(ends)
			}
			continue
		}
		if (mine.size === 0 && theirs.size === 0) {
			continue
		}
		const m = memberUpdate(input, family, memberTable, mine)
		if (m !== undefined) {
			updates.push(m)
		}
		const o = ownerUpdate(input, family, ownerTable, memberTable, theirs)
		if (o !== undefined) {
			updates.push(o)
		}
	}
	const drawnCopies = installation.laws.families.flatMap((family) =>
		copiesOf(installation, family).filter(
			(c) =>
				input.mayHoldRows(c.source) &&
				(input.added.get(nameKey(c.source))?.columns ?? []).includes(columnOf(c.from))
		)
	)
	const copied = new Set(drawnCopies.map((c) => fillKey(c.source, columnOf(c.from))))
	for (const family of installation.laws.families) {
		const member = tableOf(installation, family.member.name)
		const read = [...foldReads(installation, family)].filter((c) => copied.has(fillKey(member, c)))
		if (isNonEmpty(read)) {
			return refuseBackfill(
				family,
				`a fold that steps over the copies ${read.join(", ")}, drawn after it`
			)
		}
	}
	for (const c of orderedCopies(drawnCopies)) {
		updates.push(copyUpdate(c))
	}
	const dropDefaults = [...input.added.values()].flatMap(
		({ table, columns }): ReadonlyArray<SqlStatement> => {
			const [first, ...rest] = columns
			return first === undefined
				? []
				: [
						{
							kind: "alterTable",
							table,
							actions: mapNonEmpty([first, ...rest], (column) => ({ kind: "dropDefault", column }))
						}
					]
		}
	)
	return { updates, dropDefaults }
}
