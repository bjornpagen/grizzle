/**
 * The backfill of the families a migration adds to relations that may hold rows: grizzle draws every
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
 *   member key is a key of the stored rows, so the order is total and no two members tie.
 * - **Ordered:** an index the migration adds drawn the same, by the member key: an index new to the stored rows carries
 *   no order of the caller's. A stored index whose family only changes its group is kept (deploy/diff/declared.ts
 *   sameSequence), and every column drawn anew reads it: the caller's order.
 * - **Folds:** each plane's after a running aggregate of its masked step in index order, its frame ROWS BETWEEN UNBOUNDED
 *   PRECEDING AND CURRENT ROW, never RANGE, which would merge peers; each before its predecessor's after, the identity
 *   at the first slot (lag); and the owner's end its last member's after, the identity for an empty group (the
 *   placeholder default).
 * - **Trees:** each row's sibling index by its key, its count and its parent's count, and its pre-order interval, by
 *   the one recursive step a migration holds: the closure of the parent relation, (r…, parent) into (r…, start), from
 *   which each row's subtree size, and its start as the sum over its ancestors of one plus the sizes of their earlier
 *   siblings. A tree whose index the migration keeps keeps its caller's sibling order: every column drawn anew reads
 *   the stored index, and only the columns the migration adds are written. The stored start and end are its rows'
 *   pre-order, kept as its index is (deploy/diff/declared.ts sameSequence): a parent drawn anew is drawn from them first,
 *   each row's parent the start of the row of its root value whose interval holds its own most tightly, read off one
 *   sorted stream of the intervals' bounds (parentDerivation), and a migration that draws a tree's start or end anew on a
 *   table that may hold rows is refused, naming the tree.
 *
 * - **Tree folds:** over each row's siblings in slot order, their order by start, the root alone at slot 0, its before
 *   the identity; each row's end its last child's after. A fold added to a tree that holds rows, or changed on one, is
 *   drawn over its stored slots alone.
 * - **Copies:** each copy an axis carries is its target's value, joined to the row its axis names; a row its axis names
 *   no row for keeps the copy's base.
 *
 * Each of these is a derivation (Derivation): rows computed apart from the table it draws on, each meeting a row of the
 * table at a key the table stores. A derivation reads every column another draws as that one draws it, and is placed
 * after each derivation drawing a column it reads (ordered): a copy after the column it copies and the axis it rides, a
 * fold after every copy its step or selection reads, an end after its afters. Along a tree each row's copy reads its
 * parent's column, its fold's step its own copies and its end its children's afters, so each column drawn whole in that
 * order holds every row after every row it reads. A column that reads itself through the columns it is drawn from has
 * no such order, and is refused, naming the cycle.
 *
 * Each table the backfill draws on is written by one UPDATE (passes), every column of it the backfill draws set at
 * once, each derivation a CTE of its WITH: a migration writes one new version of each row it backfills, however many of
 * its families' columns it draws. Every UPDATE is a join of sets of rows, each derivation met at a key by a LEFT JOIN, so
 * none is a probe run once per row, which before any index of the table exists (structure.backfill runs before them)
 * would read the whole table for each of its rows.
 *
 * Window functions and the one recursive CTE are admitted here: a migration is reviewed text, and grizzle's limits on
 * them are limits on its run-time queries.
 */
import { Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	dedupeNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { nameKey } from "#compiler/deploy/snapshot/objects.ts"
import type { SnapshotTheory } from "#compiler/deploy/snapshot/types.ts"
import { compareAt, type OperatorNames, operatorSchemaOf, typedEq } from "#compiler/ir/compare.ts"
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
	Cte,
	Expr,
	FromItem,
	FromSource,
	JoinStep,
	ObjectName,
	Select,
	SetCore,
	SqlStatement,
	Target,
	TypeRef,
	TypeSchema,
	Update,
	WindowSpec,
	With
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
	or,
	provedCore,
	select,
	setOperation,
	tableCol,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { identityHooks, transformExpr, transformSelect } from "#compiler/sql/transform.ts"

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
 * stored rows of a relation are distinct by; the schema of the operators comparing two values of a column of a previous
 * table as the previous snapshot types it, which a column the migration drops at its end holds while the backfill runs;
 * whether a table of the target holds rows before the migration; and the columns the migration adds under their
 * placeholder defaults (DrawnColumns). */
export interface BackfillInput {
	readonly installation: Installation
	readonly previous: SnapshotTheory
	readonly previousOperators: (table: string, column: string) => TypeSchema | undefined
	readonly mayHoldRows: (table: ObjectName) => boolean
	readonly added: Backfilled
}

/**
 * A key of a table the backfill's derivations rely on being unique over its stored rows, which no constraint holds
 * while the backfill runs: the duplicates its law refuses, `query`, run before any derivation (Backfill checks).
 */
export interface KeyCheck {
	readonly law: Identifier<"law">
	readonly query: Select
}

/** The SQL of a migration's backfill: the checks of the keys its derivations rely on (KeyCheck), the UPDATEs that draw
 * its families' values over the stored rows, in order, then the DROP DEFAULT of every column the migration added under
 * a placeholder. */
export interface Backfill {
	readonly checks: ReadonlyArray<KeyCheck>
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
 * copy ‹n›, each fold plane's before and after; on an owner, the count and each fold plane's end; a tree's parent and
 * interval among them; and every copy an axis carries (Copy) on its source. Each holds 0 where its family is
 * empty, but an accumulator or an end, which holds its plane's identity, and a copy, which holds its base.
 */
export const drawnColumns = (installation: Installation): DrawnColumns => {
	const out = new Map<string, Map<string, Expr>>()
	const families = familyCells(installation)
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
			put(member, family.members.parent.column, nothing)
			put(member, family.members.start.column, nothing)
			put(member, family.members.end.column, nothing)
		}
		for (const fold of family.folds) {
			for (const plane of fold.planes) {
				const identity = identityOf(installation, plane)
				put(member, columnOf(plane.before), identity)
				put(member, columnOf(plane.after), identity)
				put(owner, plane.end.column, identity)
			}
		}
		for (const copy of copiesOf(installation, family, families)) {
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
	fn: "row_number" | "sum" | "max" | "min" | "bit_or" | "string_agg" | "lag",
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

/** A query core of the backfill: one SELECT's targets over its FROM, never DISTINCT. */
type Core = Extract<SetCore, { readonly distinct: false }>

/**
 * The rows of `source`, one per row it holds, with each column the layers compute: `carried` read off the source
 * itself, then each layer a derived table over the one below it, which reads every column below it by name, so a window
 * of a layer reads its own layer's inputs only. A layer of no column adds no table. The top layer's core.
 */
const layered = (
	source: FromSource,
	carried: NonEmptyReadonlyArray<string>,
	layers: ReadonlyArray<Layer>
): Core => {
	let from: FromSource = source
	const names: Array<string> = [...carried]
	let top: Core | undefined
	let depth = 0
	for (const layer of layers) {
		if (layer.columns.length === 0) {
			continue
		}
		const targets: ReadonlyArray<Target> = [
			...names.map((n) => targetAs(tableCol(n), n)),
			...layer.columns.map((c) => targetAs(c.expr, c.name))
		]
		top = provedCore("keyed", targets, [from], undefined)
		for (const c of layer.columns) {
			names.push(c.name)
		}
		depth += 1
		from = derived(select(top), `l${depth}`, [], false)
	}
	if (top === undefined) {
		throw defect("a backfill computes at least one column")
	}
	return top
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

/** A column of a member key, with the schema of the operators that compare its values (ir/compare.ts operatorSchemaOf). */
interface KeyColumn {
	readonly column: string
	readonly operators: TypeSchema | undefined
}

/**
 * The columns the backfill orders a family's stored members by and joins its rows back on: the member's primary key,
 * a key of its stored rows; or, when the migration adds a field of that key (an ordered family's index is often one),
 * the key the previous snapshot records, which the stored rows are distinct by. Each column compares at the type it
 * holds while the backfill runs: a field the member keeps at its type in the target, which the migration's Structure
 * converted it to before the backfill, and a field the migration drops at the type the previous snapshot records, the
 * column standing until the migration's removals at its end.
 */
const memberKey = (
	input: BackfillInput,
	family: Family,
	member: RelationInfo,
	added: ReadonlySet<string>
): NonEmptyReadonlyArray<KeyColumn> => {
	const names = input.installation.names
	const own = mapNonEmpty(member.primaryFields, (f) => ({
		column: f.column,
		operators: operatorSchemaOf(names, f.type)
	}))
	if (!own.some((c) => added.has(c.column))) {
		return own
	}
	const was = input.previous.relations[member.name]
	if (was?.kind !== "relation") {
		return refuseBackfill(family, `${member.name}'s stored rows have no key the snapshot records`)
	}
	const columns = was.primaryKey.map((name): KeyColumn => {
		const field = was.fields.find((f) => f.name === name)
		if (field === undefined) {
			throw defect(`the snapshot's relation ${member.name} records its key field ${name}`)
		}
		const kept = member.fields.find((f) => f.column === field.column)
		return {
			column: field.column,
			operators:
				kept === undefined
					? input.previousOperators(was.ident, field.column)
					: operatorSchemaOf(names, kept.type)
		}
	})
	if (!isNonEmpty(columns) || columns.some((c) => added.has(c.column))) {
		return refuseBackfill(family, `the key ${member.name}'s stored rows were distinct by is gone`)
	}
	return columns
}

/** Whether the rows `left` and `right` hold one member key, each column at its operators. */
const sameKey = (key: NonEmptyReadonlyArray<KeyColumn>, left: string, right: string): Expr =>
	and(
		mapNonEmpty(key, (k) => compareAt("=", k.operators, col(left, k.column), col(right, k.column)))
	)

/** A member key's columns met by the same columns of a drawing's rows (Match). */
const keyMatch = (key: NonEmptyReadonlyArray<KeyColumn>): NonEmptyReadonlyArray<Match> =>
	mapNonEmpty(key, (k) => ({ target: k.column, source: k.column, operators: k.operators }))

/** The type of a family's group field at `k`, its owner's side, which its member's side shares. */
const groupType = (family: Family, k: number): ScalarType =>
	defined(family.group[k], "a group field").owner.type

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

/** A family's member derivation: every column of its member the migration adds, drawn over the member's rows. */
const memberDerivation = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>
): Derivation | undefined => {
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
	const assignments: Array<Drawn> = []
	const assign = (column: string, value: string): void => {
		if (added.has(column)) {
			assignments.push({ column, value })
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
	const keyed = memberKey(input, family, member, added)
	const key = mapNonEmpty(keyed, (k) => k.column)
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
	return {
		table,
		with: undefined,
		core: layered({ kind: "table", table, alias: "m" }, carried, [
			steps,
			...planeLayers(installation, folds, partition, inOrder)
		]),
		match: keyMatch(keyed),
		set: assignments,
		reads: cellsOf(table, [
			...carried,
			...(drawIndex ? [] : [index]),
			...foldReads(installation, member, folds)
		])
	}
}

/** A column a derivation draws, and the name of the column of its rows that holds it. */
interface Drawn {
	readonly column: string
	readonly value: string
}

/**
 * A column a derivation meets each row of its table by: the table's `target` holds the value the derivation's row holds
 * in `source`, compared at `operators` (ir/compare.ts operatorSchemaOf).
 */
interface Match {
	readonly target: string
	readonly source: string
	readonly operators: TypeSchema | undefined
}

/**
 * One body of the backfill, a family's member part, owner, tree parent, tree, tree end or copy: rows computed apart from
 * the table whose columns it draws, `core` under its own WITH, each with the columns `match` meets a row of `table` at
 * and every value it draws (`set`); and every column it reads, on any table (`reads`). The columns `match` meets are a
 * key of `table` that no derivation draws, its member key or its owner's key, so a row of the table meets at most one of
 * its rows, at the values the table stores. Nothing it holds reads a row of the table but through its own FROM, so it is
 * one join of sets of rows, never a probe run once per row (passes).
 */
interface Derivation {
	readonly table: ObjectName
	readonly with: With | undefined
	readonly core: Core
	readonly match: NonEmptyReadonlyArray<Match>
	readonly set: NonEmptyReadonlyArray<Drawn>
	readonly reads: ReadonlyArray<Cell>
}

/** The rows of a derivation read off `table` under `alias`: each of `columns` once, by its own name, and each of
 * `computed` by its name, of the rows `where` keeps. */
const readOff = (
	table: ObjectName,
	alias: string,
	columns: NonEmptyReadonlyArray<string>,
	computed: ReadonlyArray<{ readonly name: string; readonly expr: Expr }>,
	where: Expr | undefined
): Core =>
	provedCore(
		"keyed",
		[
			...dedupeNonEmpty(columns).map((c) => targetAs(col(alias, c), c)),
			...computed.map((c) => targetAs(c.expr, c.name))
		],
		[{ kind: "table", table, alias }],
		where
	)

/** Each group field of a family met at the operators of its type, the table's side `target` and the rows' `source`:
 * each its owner's key field or its member's group field. */
const groupMatch = (
	names: OperatorNames,
	family: Family,
	target: "owner" | "member",
	source: "owner" | "member"
): NonEmptyReadonlyArray<Match> =>
	mapNonEmpty(family.group, (g) => ({
		target: g[target].column,
		source: g[source].column,
		operators: operatorSchemaOf(names, g.owner.type)
	}))

/** Whether a family's member at `alias` is its last: its index one less than its copy of the count. */
const lastOf = (family: Family, alias: string): Expr =>
	eq(
		col(alias, columnOf(family.index)),
		binary("-", col(alias, family.copy), lit.int(1n, types.bigint))
	)

/** A family's owner derivation: every column of its owner the migration adds, its last member's (its count's copy,
 * each plane's after), read off the member's drawn rows; an owner with no member keeps its placeholder, which is the
 * value it holds (0, the identity). */
const ownerDerivation = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	memberTable: ObjectName,
	added: ReadonlySet<string>
): Derivation | undefined => {
	const set: Array<Drawn> = []
	const afters: Array<string> = []
	if (added.has(family.count.column)) {
		set.push({ column: family.count.column, value: family.copy })
	}
	for (const fold of family.folds) {
		for (const plane of fold.planes) {
			if (added.has(plane.end.column)) {
				set.push({ column: plane.end.column, value: columnOf(plane.after) })
				afters.push(columnOf(plane.after))
			}
		}
	}
	if (!isNonEmpty(set) || !input.mayHoldRows(memberTable)) {
		return undefined
	}
	const group = mapNonEmpty(family.group, (g) => g.member.column)
	return {
		table,
		with: undefined,
		core: readOff(
			memberTable,
			"m",
			[...group, ...set.map((d) => d.value)],
			[],
			lastOf(family, "m")
		),
		match: groupMatch(input.installation.names, family, "owner", "member"),
		set,
		reads: [
			...cellsOf(
				table,
				family.group.map((g) => g.owner.column)
			),
			...cellsOf(memberTable, [
				...family.group.map((g) => g.member.column),
				columnOf(family.index),
				family.copy,
				...afters
			])
		]
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
 * A tree's derivation: each row's drawn columns over its rows, under one WITH RECURSIVE.
 *
 * - `__closure`: every (ancestor-or-self, descendant) pair, the one recursive step: each row with itself, then each
 *   pair extended by a child of its descendant, the root, which is its own parent, never its own child; UNION, so the
 *   closure is a set and ends however the stored parents point.
 * - `__sized`: each row's subtree size, and its children, the rows whose parent it is but itself.
 * - `__ranked`: each row's sibling index, its stored one where the migration keeps the index, the caller's order, else
 *   row_number() by its key among the rows of its parent, the root alone at 0; and its siblings' count, its parent's
 *   count.
 * - `__stepped`: each row's step, one plus the sizes of its earlier siblings, 0 for the root.
 * - `__started`: each row's start, the sum of the steps of its ancestors and itself: its pre-order index.
 *
 * - `__folded`: each fold over the tree, over each row's siblings in slot order, which is their order by start, the
 *   root alone at slot 0 (planeLayers): the root's before the identity, as its first-slot pin holds it, and its after
 *   its own step's, the one state NP's fold suite admits a root (test/pg/fin/fold.test.ts).
 *
 * Its end is its start plus its size, and its copy of the count its siblings' count (each root's own count, as the root
 * pin reads it). A row the closure reaches from no root, under stored parents that make no tree, is drawn anyway, and
 * VALIDATE refuses it by the tree's laws. Each fold's
 * end is a row's last child's after (treeEndDerivation). It sets the columns `added` holds alone, none where it holds none
 * of them.
 */
const treeDerivation = (
	input: BackfillInput,
	family: Family,
	shape: TreeShape,
	table: ObjectName,
	added: ReadonlySet<string>
): Derivation | undefined => {
	const { installation } = input
	const member = relationOf(installation, family.member.name)
	const owner = mapNonEmpty(family.group, (g) => g.owner.column)
	const parent = mapNonEmpty(family.group, (g) => g.member.column)
	const keyed = memberKey(input, family, member, added)
	const key = mapNonEmpty(keyed, (k) => k.column)
	const folds: ReadonlyArray<FoldAt> = family.folds.flatMap((fold, f) =>
		planesAdded(fold, added) ? [{ fold, f }] : []
	)
	const self = (alias: string): FromSource => ({ kind: "table", table, alias })
	const rootOf = (alias: string): Expr =>
		and(
			mapNonEmpty(family.group, (g) =>
				typedEq(
					g.owner.type,
					col(alias, g.member.column),
					col(alias, g.owner.column),
					installation.names
				)
			)
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
								...mapNonEmpty(parent, (p, k) =>
									typedEq(
										groupType(family, k),
										col("t", p),
										col("c", descendantName(k)),
										installation.names
									)
								),
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
							...mapNonEmpty(parent, (p, k) =>
								typedEq(
									groupType(family, k),
									col("t", p),
									col("c", ancestorName(k)),
									installation.names
								)
							),
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
					and(
						mapNonEmpty(owner, (c, k) =>
							typedEq(
								groupType(family, k),
								col("t", c),
								col("c", descendantName(k)),
								installation.names
							)
						)
					)
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
						holds(added, family.index)
							? {
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
								}
							: col("t", columnOf(family.index)),
						"__at"
					),
					targetAs({ ...countStar(), over: window(siblings, [], false) }, "__siblings"),
					...stepColumns(installation, member, folds).map((c) => targetAs(c.expr, c.name))
				],
				[
					join(
						self("t"),
						cteRefAs(sizedName, "s"),
						and(
							mapNonEmpty(owner, (c, k) =>
								typedEq(
									groupType(family, k),
									col("t", c),
									col("s", ancestorName(k)),
									installation.names
								)
							)
						)
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
					select(
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
					and(
						mapNonEmpty(owner, (c, k) =>
							typedEq(
								groupType(family, k),
								col("st", c),
								col("c", ancestorName(k)),
								installation.names
							)
						)
					)
				)
			],
			owner.map((_, k) => col("c", descendantName(k)))
		)
	)
	const drawn: Core = provedCore(
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
			targetAs(cast(binary("+", col("s", "__start"), col("st", "__size")), types.bigint), "__end"),
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
						on: and(
							mapNonEmpty(owner, (c, k) =>
								typedEq(
									groupType(family, k),
									col("s", descendantName(k)),
									col("st", c),
									installation.names
								)
							)
						)
					},
					...(isNonEmpty(folds)
						? [
								{
									kind: "on" as const,
									source: cteRefAs(foldedName, "f"),
									on: sameKey(keyed, "f", "st")
								}
							]
						: [])
				]
			}
		],
		undefined
	)
	const set = [
		{ column: columnOf(family.index), value: "__at" },
		{ column: family.count.column, value: "__children" },
		{ column: family.copy, value: "__n" },
		{ column: shape.start.column, value: "__start" },
		{ column: shape.end.column, value: "__end" },
		...planes.map(({ column, name }) => ({ column, value: name }))
	].filter((a) => added.has(a.column))
	if (!isNonEmpty(set)) {
		return undefined
	}
	return {
		table,
		with: { recursive: true, ctes: [closure, sized, ranked, stepped, started, ...folded] },
		core: drawn,
		match: keyMatch(keyed),
		set,
		reads: cellsOf(table, [
			...carried,
			...(holds(added, family.index) ? [] : [columnOf(family.index)]),
			...foldReads(installation, member, folds)
		])
	}
}

/** The names a tree's parent derivation gives what it computes (parentDerivation), none a field's. */
const levelsName = "__levels"
const rolesName = "__roles"
const headsName = "__heads"

/**
 * A tree's parent drawn anew over its kept intervals (deploy/diff/declared.ts sameSequence): each row's parent is the
 * start of the row of its own root value whose interval holds its own most tightly, and a row no row of its root holds
 * is its tree's root, its own parent. A row's interval runs from its start to its end, one past its last descendant's
 * start (T5, T6), so pre-order intervals nest: the rows holding a row are its ancestors, one at each depth above its
 * own, and its parent is the one at the depth just above it. It is drawn over each root value's rows sorted, never by a
 * probe per row:
 *
 * - `__levels`: each row's level, its depth plus one: over each root value's starts (+1) and ends (−1) in position
 *   order, an end before a start at one position, the running sum at its own start, which counts itself and every row
 *   that starts before it and has not ended by its start, its ancestors.
 * - `__roles`: each row twice, a child at its own level and a candidate parent at the level below it, and over each
 *   level of a root value in start order, `__run`, how many candidates start at or before each: a candidate and the
 *   children after it, up to the next candidate, share one run.
 * - `__heads`: each child's parent, the start of its run's candidate, the run's least start: between a row and its
 *   parent in pre-order lie only the parent's descendants, so its parent is the last row of the level above it to start
 *   before it. A child of run 0 has no row of the level above it before it, the root alone at level 1: its own start.
 *
 * Each window's frame is its default, RANGE, so rows tied at a position count together and every value is a function
 * of the stored rows, whatever order PostgreSQL gives peers. Intervals that make no tree under the new root values, two
 * trees merged under one or one split across two, are drawn anyway, and VALIDATE refuses them by the tree's laws and its
 * relation's key: no parents make a tree of intervals that do not nest, and over nesting intervals of distinct starts
 * each row's parent drawn here is the row holding it most tightly.
 */
const parentDerivation = (
	input: BackfillInput,
	family: Family,
	shape: TreeShape,
	table: ObjectName,
	added: ReadonlySet<string>
): Derivation => {
	const keyed = memberKey(input, family, relationOf(input.installation, family.member.name), added)
	const key = mapNonEmpty(keyed, (k) => k.column)
	const start = shape.start.column
	const end = shape.end.column
	const root = mapNonEmpty(shape.root, (r) => r.column)
	const carried = dedupeNonEmpty([...key, ...root, start])
	const carry = (alias: string): ReadonlyArray<Target> =>
		carried.map((c) => targetAs(col(alias, c), c))
	const rootOf = (alias: string): ReadonlyArray<Expr> => root.map((r) => col(alias, r))
	const int = (value: bigint): Expr => lit.int(value, types.integer)
	const bound = (at: string, step: bigint): SetCore =>
		provedCore(
			"keyed",
			[...carry("t"), targetAs(col("t", at), "__at"), targetAs(int(step), "__step")],
			[{ kind: "table", table, alias: "t" }],
			undefined
		)
	const levels = cte(
		levelsName,
		[],
		select(
			provedCore(
				"keyed",
				[
					...carry("e"),
					targetAs(col("e", "__step"), "__step"),
					targetAs(
						over(
							"sum",
							[col("e", "__step")],
							window(rootOf("e"), [col("e", "__at"), col("e", "__step")], false)
						),
						"__level"
					)
				],
				[
					derived(select(unionAll("disjoint", [bound(start, 1n), bound(end, -1n)])), "e", [], false)
				],
				undefined
			)
		)
	)
	const role = (level: Expr, candidate: bigint): SetCore =>
		provedCore(
			"keyed",
			[...carry("l"), targetAs(level, "__level"), targetAs(int(candidate), "__candidate")],
			[cteRefAs(levelsName, "l")],
			eq(col("l", "__step"), int(1n))
		)
	const roles = cte(
		rolesName,
		[],
		select(
			provedCore(
				"keyed",
				[
					...carry("d"),
					targetAs(col("d", "__level"), "__level"),
					targetAs(col("d", "__candidate"), "__candidate"),
					targetAs(
						over(
							"sum",
							[col("d", "__candidate")],
							window([...rootOf("d"), col("d", "__level")], [col("d", start)], false)
						),
						"__run"
					)
				],
				[
					derived(
						select(
							unionAll("disjoint", [
								role(col("l", "__level"), 0n),
								role(binary("+", col("l", "__level"), int(1n)), 1n)
							])
						),
						"d",
						[],
						false
					)
				],
				undefined
			)
		)
	)
	const heads = cte(
		headsName,
		[],
		select(
			provedCore(
				"keyed",
				[
					...key.map((k) => targetAs(col("r", k), k)),
					targetAs(col("r", "__candidate"), "__candidate"),
					targetAs(
						cast(
							{
								kind: "case",
								operand: undefined,
								whens: [{ when: eq(col("r", "__run"), int(0n)), result: col("r", start) }],
								else: over(
									"min",
									[col("r", start)],
									window([...rootOf("r"), col("r", "__level"), col("r", "__run")], [], false)
								)
							},
							types.bigint
						),
						"__parent"
					)
				],
				[cteRefAs(rolesName, "r")],
				undefined
			)
		)
	)
	return {
		table,
		with: { recursive: false, ctes: [levels, roles, heads] },
		core: provedCore(
			"keyed",
			[...key.map((k) => targetAs(col("h", k), k)), targetAs(col("h", "__parent"), "__parent")],
			[cteRefAs(headsName, "h")],
			eq(col("h", "__candidate"), int(0n))
		),
		match: keyMatch(keyed),
		set: [{ column: shape.parent.column, value: "__parent" }],
		reads: cellsOf(table, [...carried, end])
	}
}

/** A tree's fold ends this migration adds: each row's end its last child's after, read off the drawn rows; a leaf
 * keeps its placeholder, the identity, which an empty family's end is. */
const treeEndDerivation = (
	names: OperatorNames,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>
): Derivation | undefined => {
	const planes = family.folds.flatMap((fold) =>
		fold.planes.filter((plane) => added.has(plane.end.column))
	)
	const set = planes.map((plane) => ({ column: plane.end.column, value: columnOf(plane.after) }))
	if (!isNonEmpty(set)) {
		return undefined
	}
	return {
		table,
		with: undefined,
		core: readOff(
			table,
			"c",
			[...mapNonEmpty(family.group, (g) => g.member.column), ...set.map((d) => d.value)],
			[],
			and(appendNonEmpty(nonRoot(names, family, "c"), lastOf(family, "c")))
		),
		match: groupMatch(names, family, "owner", "member"),
		set,
		reads: cellsOf(table, [
			...family.group.flatMap((g) => [g.member.column, g.owner.column]),
			columnOf(family.index),
			family.copy,
			...planes.map((plane) => columnOf(plane.after))
		])
	}
}

/**
 * The columns the target's families draw beside their copies, each on its table (cellKey): on a member its index, copy
 * and folds' planes, and a tree's parent and interval; on an owner its count and folds' ends. A pair of any axis whose
 * `from` is one of them is no copy: its family draws that column, and the pair's foreign key proves it the target's
 * value (Instance's `children`, its tree's count, which its document's family's owner axis holds to the document's
 * `sites`).
 */
const familyCells = (installation: Installation): ReadonlySet<string> =>
	new Set(
		installation.laws.families.flatMap((family) =>
			[
				...cellsOf(tableOf(installation, family.member.name), [
					columnOf(family.index),
					family.copy,
					...family.folds.flatMap((fold) =>
						fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after)])
					),
					...(family.members.kind === "tree"
						? [family.members.parent.column, family.members.start.column, family.members.end.column]
						: [])
				]),
				...cellsOf(tableOf(installation, family.owner.name), [
					family.count.column,
					...family.folds.flatMap((fold) => fold.planes.map((p) => p.end.column))
				])
			].map(cellKey)
		)
	)

/**
 * A copy a family's axis carries: a column the host fills on the axis's source row, `from`,
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

/** The copies a family's axes carry beside the columns every family draws (`families`, familyCells), in axis order. */
const copiesOf = (
	installation: Installation,
	family: Family,
	families: ReadonlySet<string>
): ReadonlyArray<Copy> => {
	const member = tableOf(installation, family.member.name)
	const owner = tableOf(installation, family.owner.name)
	return (["owner", "predecessor", "last"] as const).flatMap((axis) =>
		family.axes[axis].flatMap((pair): ReadonlyArray<Copy> =>
			hostFilled(pair.from) &&
			!families.has(
				cellKey({ table: axis === "last" ? owner : member, column: columnOf(pair.from) })
			)
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
const nonRoot = (names: OperatorNames, family: Family, alias: string): ReadonlyArray<Expr> =>
	family.members.kind === "tree"
		? [
				not(
					and(
						mapNonEmpty(family.group, (g) =>
							typedEq(g.owner.type, col(alias, g.member.column), col(alias, g.owner.column), names)
						)
					)
				)
			]
		: []

/** The name a copy's rows give the value they copy (copyDerivation), none a field's. */
const copiedName = "__copied"

/** The columns a migration adds to `table` under their placeholders, where it may hold rows. */
const addedOn = (input: BackfillInput, table: ObjectName): ReadonlySet<string> =>
	new Set(input.mayHoldRows(table) ? (input.added.get(nameKey(table))?.columns ?? []) : [])

/**
 * A copy's derivation: its column on every source row, `to` on the row its axis names; a source row whose axis names
 * none keeps its base. A member's copy meets its row at the member's key, its axis joined inside its rows, since the
 * columns an axis names a member's target by, a tree's parent and an ordered index, may be drawn in the same backfill:
 * along the owner axis its owner, at the owner's key its group names; along the predecessor axis the member of its group
 * at the slot before its own, a tree's root never one, whose slot is none's after (the root pin holds it at slot 0). An
 * owner's copy along the last axis meets its row at the owner's key, the last member of its family met at its group.
 */
const copyDerivation = (input: BackfillInput, copy: Copy): Derivation => {
	const names = input.installation.names
	const { family, from, to } = copy
	const index = columnOf(family.index)
	const value = columnOf(to)
	const members = mapNonEmpty(family.group, (g) => g.member.column)
	const owners = family.group.map((g) => g.owner.column)
	const rooted = family.members.kind === "tree" ? [...members, ...owners] : []
	const set: NonEmptyReadonlyArray<Drawn> = [{ column: columnOf(from), value: copiedName }]
	if (copy.axis === "last") {
		return {
			table: copy.source,
			with: undefined,
			core: readOff(
				copy.target,
				"a",
				members,
				[{ name: copiedName, expr: col("a", value) }],
				and(appendNonEmpty(nonRoot(names, family, "a"), lastOf(family, "a")))
			),
			match: groupMatch(names, family, "owner", "member"),
			set,
			reads: [
				...cellsOf(copy.source, owners),
				...cellsOf(copy.target, [...members, index, family.copy, ...rooted, value])
			]
		}
	}
	const keyed = memberKey(
		input,
		family,
		relationOf(input.installation, family.member.name),
		addedOn(input, copy.source)
	)
	const key = mapNonEmpty(keyed, (k) => k.column)
	const meets: NonEmptyReadonlyArray<Expr> =
		copy.axis === "owner"
			? mapNonEmpty(family.group, (g) =>
					compareAt(
						"=",
						operatorSchemaOf(names, g.owner.type),
						col("s", g.member.column),
						col("a", g.owner.column)
					)
				)
			: [
					...mapNonEmpty(family.group, (g) =>
						compareAt(
							"=",
							operatorSchemaOf(names, g.owner.type),
							col("s", g.member.column),
							col("a", g.member.column)
						)
					),
					eq(col("s", index), binary("+", col("a", index), lit.int(1n, types.bigint))),
					...nonRoot(names, family, "a")
				]
	return {
		table: copy.source,
		with: undefined,
		core: provedCore(
			"keyed",
			[...key.map((k) => targetAs(col("s", k), k)), targetAs(col("a", value), copiedName)],
			[
				join(
					{ kind: "table", table: copy.source, alias: "s" },
					{ kind: "table", table: copy.target, alias: "a" },
					and(meets)
				)
			],
			undefined
		),
		match: keyMatch(keyed),
		set,
		reads: [
			...cellsOf(copy.source, [...key, ...members, ...(copy.axis === "owner" ? [] : [index])]),
			...cellsOf(copy.target, [
				...(copy.axis === "owner" ? owners : [...members, index, ...rooted]),
				value
			])
		]
	}
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

/** The member columns `folds` read: each value step's field and each selection's columns. */
const foldReads = (
	installation: Installation,
	member: RelationInfo,
	folds: ReadonlyArray<FoldAt>
): ReadonlySet<string> =>
	new Set(
		folds.flatMap(({ fold }) => [
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

/** A column of a table the backfill draws or reads. */
interface Cell {
	readonly table: ObjectName
	readonly column: string
}

/** The cells of `columns` on `table`. */
const cellsOf = (table: ObjectName, columns: ReadonlyArray<string>): ReadonlyArray<Cell> =>
	columns.map((column) => ({ table, column }))

/** A cell's key: its table's (nameKey) and its column. */
const cellKey = (c: Cell): string => `${nameKey(c.table)}\u0000${c.column}`

/** A cell as a refusal names it, by its table's name and its column. */
const cellName = (c: Cell): string => `${c.table.name}.${c.column}`

/** The columns a derivation draws: those it sets. */
const drawsOf = (d: Derivation): ReadonlyArray<Cell> =>
	cellsOf(
		d.table,
		d.set.map((x) => x.column)
	)

/** A derivation with the family whose columns it draws, which a refusal names. */
interface Planned {
	readonly family: Family
	readonly derivation: Derivation
}

/** A derivation the walk of `ordered` is placing, and the column it reads that the derivation above it draws. */
interface Placing {
	readonly at: Planned
	readonly reading: Cell
}

/**
 * The backfill's derivations in an order that places each after every derivation drawing a column it reads, otherwise
 * as drafted: a depth-first walk that places, before each derivation, the derivations drawing what it reads. A
 * derivation reading a column it draws itself is a copy of itself along its axis (a tree's column copied from its
 * parent's, a member's from its predecessor's), which holds its base on every row, its placeholder: it reads itself as
 * it stands. A derivation the walk reaches while placing what it reads closes a cycle, each derivation of which reads a
 * column the next draws: no order draws them, and the cycle is refused, each derivation named by the columns it draws
 * and the one it reads.
 */
const ordered = (planned: ReadonlyArray<Planned>): ReadonlyArray<Derivation> => {
	const drawer = new Map<string, Planned>()
	for (const p of planned) {
		for (const c of drawsOf(p.derivation)) {
			if (drawer.has(cellKey(c))) {
				throw defect(`one backfill derivation draws ${cellName(c)}`)
			}
			drawer.set(cellKey(c), p)
		}
	}
	const placed = new Set<Planned>()
	const out: Array<Derivation> = []
	const walk: Array<Placing> = []
	const place = (p: Planned): void => {
		if (placed.has(p)) {
			return
		}
		for (const reading of p.derivation.reads) {
			const by = drawer.get(cellKey(reading))
			if (by === undefined || by === p || placed.has(by)) {
				continue
			}
			const open = walk.findIndex((w) => w.at === by)
			if (open !== -1) {
				const cycle = [...walk.slice(open), { at: p, reading }]
				return refuseBackfill(
					by.family,
					`no order draws its columns, each derivation of a cycle reading a column the next draws: ${cycle
						.map(
							(w) =>
								`${drawsOf(w.at.derivation).map(cellName).join(", ")} drawn reading ${cellName(w.reading)}`
						)
						.join("; ")}`
				)
			}
			walk.push({ at: p, reading })
			place(by)
			walk.pop()
		}
		placed.add(p)
		out.push(p.derivation)
	}
	for (const p of planned) {
		place(p)
	}
	return out
}

/** The names the passes give each derivation's CTE, by its place in `ordered`'s order, each view of a table one of
 * them reads, and the mark of a derivation's rows, none a field's. */
const drawingName = (n: number): string => `__drawing_${n}`
const viewName = (n: number): string => `__view_${n}`
const hitName = "__hit"

/** A derivation with the name of its CTE. */
interface Named {
	readonly name: string
	readonly derivation: Derivation
}

/**
 * The rows of `table`, one per row it stores, each of `columns` under its own name: the value it stores, but a column a
 * derivation draws (`drawer`), which is that derivation's value on the row it meets the table's at (Derivation `match`,
 * a key the table stores), and the value it stores, its placeholder, where it meets none. Each derivation it reads is a
 * LEFT JOIN at its key, so it is one join of sets of rows. With `onlyMet`, the rows some derivation it reads meets.
 */
const staged = (
	table: ObjectName,
	columns: NonEmptyReadonlyArray<string>,
	drawer: (column: string) => Named | undefined,
	onlyMet: boolean
): Select => {
	const drawers = [...new Set(columns.flatMap((c) => drawer(c) ?? []))]
	const aliasOf = (n: Named): string => `d${drawers.indexOf(n) + 1}`
	const first: FromSource = { kind: "table", table, alias: "k" }
	const steps = drawers.map((n): JoinStep => ({
		kind: "left",
		source: cteRefAs(n.name, aliasOf(n)),
		on: and(
			mapNonEmpty(n.derivation.match, (m) =>
				compareAt("=", m.operators, col("k", m.target), col(aliasOf(n), m.source))
			)
		)
	}))
	const valueOf = (column: string): Expr => {
		const by = drawer(column)
		if (by === undefined) {
			return col("k", column)
		}
		const drawn = defined(
			by.derivation.set.find((d) => d.column === column),
			"the drawer of a column sets it"
		)
		return {
			kind: "case",
			operand: undefined,
			whens: [{ when: col(aliasOf(by), hitName), result: col(aliasOf(by), drawn.value) }],
			else: col("k", column)
		}
	}
	return select(
		provedCore(
			"keyed",
			dedupeNonEmpty(columns).map((c) => targetAs(valueOf(c), c)),
			[isNonEmpty(steps) ? { kind: "joins", first, steps } : first],
			onlyMet && isNonEmpty(drawers)
				? or(mapNonEmpty(drawers, (n) => ({ kind: "isTrue", expr: col(aliasOf(n), hitName) })))
				: undefined
		)
	)
}

/**
 * A derivation's CTE: its rows, each marked `__hit`, under its own WITH, where each table its FROM reads a column of that
 * another derivation draws is read staged (a view of that WITH, staged), so every column it reads holds its drawn value;
 * every other table it reads as stored. The derivations it reads are its CTE's dependencies.
 */
const derivationCte = (
	n: Named,
	drawerOf: (cell: Cell) => Named | undefined
): { readonly cte: Cte; readonly reads: ReadonlyArray<Named> } => {
	const { derivation } = n
	const other = (cell: Cell): Named | undefined => {
		const by = drawerOf(cell)
		return by === n ? undefined : by
	}
	const columnsOn = new Map<string, Array<string>>()
	for (const cell of derivation.reads) {
		const key = nameKey(cell.table)
		columnsOn.set(key, [...(columnsOn.get(key) ?? []), cell.column])
	}
	const views: Array<Cte> = []
	const viewOf = new Map<string, string>()
	const read = transformSelect(
		{
			...select({
				...derivation.core,
				targets: [...derivation.core.targets, targetAs(lit.bool(true), hitName)]
			}),
			with: derivation.with
		},
		{
			...identityHooks,
			replaceSource: (source) => {
				if (source.kind !== "table" || typeof source.table === "string") {
					return undefined
				}
				const { table } = source
				const key = nameKey(table)
				const columns = columnsOn.get(key) ?? []
				if (
					!isNonEmpty(columns) ||
					!columns.some((column) => other({ table, column }) !== undefined)
				) {
					return undefined
				}
				const known = viewOf.get(key)
				if (known !== undefined) {
					return cteRefAs(known, source.alias)
				}
				const name = viewName(views.length + 1)
				viewOf.set(key, name)
				views.push(
					cte(
						name,
						[],
						staged(table, columns, (column) => other({ table, column }), false)
					)
				)
				return cteRefAs(name, source.alias)
			}
		}
	)
	const ctes = [...views, ...(read.with?.ctes ?? [])]
	return {
		cte: cte(n.name, [], {
			...read,
			with: isNonEmpty(ctes) ? { recursive: read.with?.recursive ?? false, ctes } : undefined
		}),
		reads: [...new Set(derivation.reads.flatMap((cell) => other(cell) ?? []))]
	}
}

/**
 * The backfill's UPDATEs: one of each table a derivation draws on, in the order its first derivation is placed, writing
 * every column the backfill draws on it in one write of each row some derivation meets:
 * `WITH <derivations> UPDATE <table> AS "t" SET <column> = "b"."<column>", … FROM <the table staged> AS "b" WHERE
 * "t"."<key>" = "b"."<key>"`. Its WITH holds the CTE of every derivation it reads, its own and every derivation one of
 * them reads, transitively, each after those it reads (`ordered`), and no UPDATE reads a column another writes: what one
 * reads of another table's drawn columns it draws itself, by the same derivations. Each table's rows are written once,
 * so a migration writes one new version of each row it backfills, however many of its families' columns it draws.
 */
const passes = (derivations: ReadonlyArray<Derivation>): ReadonlyArray<Update> => {
	const named = derivations.map((derivation, i): Named => ({
		name: drawingName(i + 1),
		derivation
	}))
	const drawer = new Map<string, Named>()
	for (const n of named) {
		for (const c of drawsOf(n.derivation)) {
			drawer.set(cellKey(c), n)
		}
	}
	const built = new Map(
		named.map((n) => [n, derivationCte(n, (cell) => drawer.get(cellKey(cell)))] as const)
	)
	const builtOf = (n: Named) => defined(built.get(n), "every derivation is built")
	const tables = new Map<string, NonEmptyReadonlyArray<Named>>()
	for (const n of named) {
		const key = nameKey(n.derivation.table)
		tables.set(key, appendNonEmpty(tables.get(key) ?? [], n))
	}
	return [...tables.values()].map((own): Update => {
		const needed = new Set<Named>()
		const need = (n: Named): void => {
			if (!needed.has(n)) {
				needed.add(n)
				builtOf(n).reads.forEach(need)
			}
		}
		own.forEach(need)
		const [{ derivation: first }] = own
		const { table, match: key } = first
		const [keyFirst, ...keyRest] = key
		const columns = flatMapNonEmpty(own, (n) => mapNonEmpty(n.derivation.set, (d) => d.column))
		const ownerOf = (column: string): Named | undefined =>
			own.find((n) => n.derivation.set.some((d) => d.column === column))
		const ctes = named.filter((n) => needed.has(n)).map((n) => builtOf(n).cte)
		if (!isNonEmpty(ctes)) {
			throw defect("a table's UPDATE reads its own derivations")
		}
		return {
			kind: "update",
			with: { recursive: false, ctes },
			table,
			alias: "t",
			set: mapNonEmpty(columns, (column) => ({ column, value: col("b", column) })),
			from: [
				derived(
					staged(
						table,
						[keyFirst.target, ...keyRest.map((m) => m.target), ...columns],
						ownerOf,
						true
					),
					"b",
					[],
					false
				)
			],
			where: and(
				mapNonEmpty(key, (m) => compareAt("=", m.operators, col("t", m.target), col("b", m.target)))
			),
			returning: []
		}
	})
}

/** A key of a table and the target's law that holds it unique. */
interface Key {
	readonly law: Identifier<"law">
	readonly table: ObjectName
	readonly columns: NonEmptyReadonlyArray<string>
}

/** The primary key of a stored relation of the target, by the law that holds it. */
const primaryKeyOf = (installation: Installation, name: string): Key => {
	const relation = relationOf(installation, name)
	const pk = installation.laws.theory.primaryKeys.find((k) => k.relation.name === name)
	if (pk === undefined) {
		throw defect(`the theory states the primary key of ${name}`)
	}
	return {
		law: pk.law.id,
		table: tableOf(installation, name),
		columns: mapNonEmpty(relation.primaryFields, (f) => f.column)
	}
}

/**
 * The keys a family's derivations rely on being unique over the stored rows, so that each meets a row of its table at
 * most once: its member's primary key, which its rows are met at (memberKey); its owner's primary key, which its group
 * names its owner at (an owner axis's copy joins its owner there, a tree's rows meet their parent there); and its slot
 * key, its group and its index, at which its last member and each member's predecessor are met.
 */
const familyKeys = (input: BackfillInput, family: Family): ReadonlyArray<Key> => {
	const { installation } = input
	const member = primaryKeyOf(installation, family.member.name)
	const index = columnOf(family.index)
	return [
		member,
		primaryKeyOf(installation, family.owner.name),
		{
			law: family.law,
			table: member.table,
			columns: appendNonEmpty(
				family.group.map((g) => g.member.column),
				index
			)
		}
	]
}

/**
 * The checks the backfill runs before any derivation (KeyCheck): of each key a planned family relies on (familyKeys)
 * whose law the previous snapshot does not record, so no constraint holds it while the backfill runs, and whose
 * columns no derivation draws, so the stored rows already hold its values, the rows sharing a value of it: each
 * derivation meets a row of its table at most once exactly when there are none, and its law refuses them, as the index
 * or VALIDATE that follows would, before any derivation computes over them. A key with a drawn column is unique by how
 * its columns are drawn, from keys checked here.
 */
const keyChecks = (
	input: BackfillInput,
	planned: ReadonlyArray<Planned>
): ReadonlyArray<KeyCheck> => {
	const drawn = new Set(planned.flatMap((p) => drawsOf(p.derivation).map(cellKey)))
	const checked = new Map<string, KeyCheck>()
	for (const family of new Set(planned.map((p) => p.family))) {
		for (const key of familyKeys(input, family)) {
			if (
				checked.has(key.law) ||
				input.previous.laws[key.law] !== undefined ||
				key.columns.some((column) => drawn.has(cellKey({ table: key.table, column })))
			) {
				continue
			}
			const columns = key.columns.map((column) => col("k", column))
			checked.set(key.law, {
				law: key.law,
				query: select({
					...provedCore(
						"grouped",
						columns.map((c, i) => targetAs(c, `__k${i}`)),
						[{ kind: "table", table: key.table, alias: "k" }],
						undefined
					),
					groupBy: columns,
					having: binary(">", countStar(), lit.int(1n, types.bigint))
				})
			})
		}
	}
	return [...checked.values()]
}

/**
 * The backfill of every family of the target whose columns this migration adds to a table that may hold rows
 * (Backfill): each family's member part and its owner's derivation, which reads the member's drawn rows (a tree's parent
 * drawn anew, its tree, then its fold ends), and every copy this migration adds, each placed after every derivation
 * drawing a column it reads (ordered), and one UPDATE of each table they draw on (passes). A column two axes carry is
 * drawn by the first in the law model's order, the owner axis's before the predecessor's and the last's; the other's
 * foreign key, which VALIDATE proves, holds it to the same value. A family whose columns are all new to tables that hold
 * no row needs none: its placeholders are the values an empty family holds.
 */
export const backfillOf = (input: BackfillInput): Backfill => {
	const { installation } = input
	const planned: Array<Planned> = []
	const plan = (family: Family, derivation: Derivation | undefined): void => {
		if (derivation !== undefined) {
			planned.push({ family, derivation })
		}
	}
	for (const family of installation.laws.families) {
		const memberTable = tableOf(installation, family.member.name)
		const ownerTable = tableOf(installation, family.owner.name)
		const onMember = addedOn(input, memberTable)
		const onOwner = addedOn(input, ownerTable)
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
				shape.end.column,
				...family.folds.flatMap((fold) =>
					fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after), p.end.column])
				)
			]
			const intervals = [shape.start.column, shape.end.column].filter((c) => onMember.has(c))
			if (isNonEmpty(intervals)) {
				return refuseBackfill(
					family,
					`its rows' pre-order intervals, ${intervals.join(", ")}, drawn anew: the stored rows alone determine a tree only by an installed tree's intervals the migration keeps`
				)
			}
			if (onMember.has(shape.parent.column)) {
				plan(family, parentDerivation(input, family, shape, memberTable, onMember))
			}
			if (!columns.some((c) => onMember.has(c))) {
				continue
			}
			plan(family, treeDerivation(input, family, shape, memberTable, onMember))
			plan(family, treeEndDerivation(input.installation.names, family, memberTable, onMember))
			continue
		}
		plan(family, memberDerivation(input, family, memberTable, mine))
		plan(family, ownerDerivation(input, family, ownerTable, memberTable, theirs))
	}
	const families = familyCells(installation)
	const copied = new Set<string>()
	for (const family of installation.laws.families) {
		for (const c of copiesOf(installation, family, families)) {
			const cell = cellKey({ table: c.source, column: columnOf(c.from) })
			if (!copied.has(cell) && addedOn(input, c.source).has(columnOf(c.from))) {
				copied.add(cell)
				plan(family, copyDerivation(input, c))
			}
		}
	}
	const checks = keyChecks(input, planned)
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
	return { checks, updates: passes(ordered(planned)), dropDefaults }
}
