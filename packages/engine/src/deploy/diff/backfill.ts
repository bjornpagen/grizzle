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
 *   sorted stream of the intervals' bounds (parentUpdate), and a migration that draws a tree's start or end anew on a
 *   table that may hold rows is refused, naming the tree.
 *
 * - **Tree folds:** over each row's siblings in slot order, their order by start, the root alone at slot 0, its before
 *   the identity; each row's end its last child's after. A fold added to a tree that holds rows, or changed on one, is
 *   drawn over its stored slots alone.
 * - **Copies:** each copy an axis carries is its target's value, joined to the row its axis names; a row its axis names
 *   no row for keeps the copy's base.
 *
 * Every statement runs after each statement that draws a column it reads (ordered): a copy after the column it copies
 * and the axis it rides, a fold after every copy its step or selection reads, an end after its afters. Along a tree each
 * row's copy reads its parent's column, its fold's step its own copies and its end its children's afters, so drawing
 * each column whole in that order draws every row after every row it reads. A column that reads itself through the
 * columns it is drawn from has no such order, and is refused, naming the cycle.
 *
 * Every statement is a join of the table it updates with rows computed apart from it, each table row meeting its row at
 * a key (Drawing, MemberPart): nothing it holds reads the row it updates but that key, so none is a probe run once per
 * row, which before any index of the table exists (structure.backfill runs before them) would read the whole table for
 * each of its rows.
 *
 * Window functions and the one recursive CTE are admitted here: a migration is reviewed text, and grizzle's limits on
 * them are limits on its run-time queries.
 */
import { Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
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
	Expr,
	FromItem,
	FromSource,
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
	conjunction,
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
	types,
	unionAll
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

/** A family's member UPDATE: every column of its member the migration adds, drawn over the member's stored rows. */
const memberPart = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>
): MemberPart | undefined => {
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
	const rows = layered({ kind: "table", table, alias: "m" }, carried, [
		steps,
		...planeLayers(installation, folds, partition, inOrder)
	])
	return {
		table,
		rows,
		key: keyed,
		set: assignments,
		reads: new Set([
			...carried,
			...(drawIndex ? [] : [index]),
			...foldReads(installation, member, folds)
		])
	}
}

/** A column a member's backfill draws, and the name of the column of its rows that holds it. */
interface Drawn {
	readonly column: string
	readonly value: string
}

/**
 * A family's member backfill before it is drafted (memberPart): its rows, one per member of `table`, each with its key
 * and every value it draws; the member key its rows meet the table's on; the columns it draws, each by the column of
 * its rows holding it; and the member columns it reads, its key, group, stored index and fold reads.
 */
interface MemberPart {
	readonly table: ObjectName
	readonly rows: Select
	readonly key: NonEmptyReadonlyArray<KeyColumn>
	readonly set: NonEmptyReadonlyArray<Drawn>
	readonly reads: ReadonlySet<string>
}

/** The name a member part's rows take in its table's UPDATE: the first's `b`, as one part's always was, then b2, b3. */
const partAlias = (i: number): string => (i === 0 ? "b" : `b${i + 1}`)

/**
 * One UPDATE of a table drawing the columns of each member part it holds: every part's rows hold one row per member, so
 * each row of the table meets exactly one row of each part at its key, and the inner join of them all names every
 * member once, as each part's UPDATE alone did.
 */
const memberUpdate = (parts: NonEmptyReadonlyArray<MemberPart>): Update => {
	const [{ table }] = parts
	return {
		kind: "update",
		with: undefined,
		table,
		alias: "t",
		set: flatMapNonEmpty(parts, (p, i) =>
			mapNonEmpty(p.set, (d) => ({ column: d.column, value: col(partAlias(i), d.value) }))
		),
		from: parts.map((p, i) => derived(p.rows, partAlias(i), [], false)),
		where: and(
			flatMapNonEmpty(parts, (p, i) =>
				mapNonEmpty(p.key, (k) =>
					compareAt("=", k.operators, col("t", k.column), col(partAlias(i), k.column))
				)
			)
		),
		returning: []
	}
}

/**
 * A column a drawing meets each row of its table by: the table's `target` holds the value the row of its rows holds in
 * `source`, compared at `operators` (ir/compare.ts operatorSchemaOf).
 */
interface Match {
	readonly target: string
	readonly source: string
	readonly operators: TypeSchema | undefined
}

/** The rows a drawing draws from: a stored table read whole, or a query. Neither is LATERAL, so neither reads a row of
 * the table the drawing updates. */
type Rows =
	| { readonly kind: "table"; readonly table: ObjectName }
	| { readonly kind: "query"; readonly query: Select }

/**
 * A backfill UPDATE besides the member parts (MemberPart): `[WITH …] UPDATE <table> AS "t" SET <column> = "b"."<value>",
 * … FROM <rows> AS "b" WHERE "t"."<target>" = "b"."<source>" AND …`. Every value it draws is a column of the row of
 * `rows` a row of the table meets at `match`, and nothing it holds reads a row of the table but `match`: its WITH and
 * its rows are computed apart from the table's rows, so it is one join of two sets of rows, never a probe run once per
 * row of the table it updates.
 */
interface Drawing {
	readonly table: ObjectName
	readonly with: With | undefined
	readonly rows: Rows
	readonly match: NonEmptyReadonlyArray<Match>
	readonly set: NonEmptyReadonlyArray<Drawn>
}

/** The name a drawing's rows take in its UPDATE. */
const drawnAlias = "b"

/** A drawing's UPDATE (Drawing). */
const drawingUpdate = (d: Drawing): Update => ({
	kind: "update",
	with: d.with,
	table: d.table,
	alias: "t",
	set: mapNonEmpty(d.set, (x) => ({ column: x.column, value: col(drawnAlias, x.value) })),
	from: [
		d.rows.kind === "table"
			? { kind: "table", table: d.rows.table, alias: drawnAlias }
			: derived(d.rows.query, drawnAlias, [], false)
	],
	where: and(
		mapNonEmpty(d.match, (m) =>
			compareAt("=", m.operators, col("t", m.target), col(drawnAlias, m.source))
		)
	),
	returning: []
})

/** The rows of a drawing read off `table` under `alias`: each of `columns` once, by its own name, and each of `computed`
 * by its name, of the rows `where` keeps. */
const readOff = (
	table: ObjectName,
	alias: string,
	columns: NonEmptyReadonlyArray<string>,
	computed: ReadonlyArray<{ readonly name: string; readonly expr: Expr }>,
	where: Expr | undefined
): Rows => ({
	kind: "query",
	query: select(
		provedCore(
			"keyed",
			[
				...dedupeNonEmpty(columns).map((c) => targetAs(col(alias, c), c)),
				...computed.map((c) => targetAs(c.expr, c.name))
			],
			[{ kind: "table", table, alias }],
			where
		)
	)
})

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

/** A family's owner UPDATE: every column of its owner the migration adds, its last member's (its count's copy, each
 * plane's after), read off the member's backfilled rows; an owner with no member keeps its placeholder, which is the
 * value it holds (0, the identity). */
const ownerUpdate = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	memberTable: ObjectName,
	added: ReadonlySet<string>
): DraftedDrawing | undefined => {
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
		kind: "drawing",
		drawing: {
			table,
			with: undefined,
			rows: readOff(
				memberTable,
				"m",
				[...group, ...set.map((d) => d.value)],
				[],
				lastOf(family, "m")
			),
			match: groupMatch(input.installation.names, family, "owner", "member"),
			set
		},
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
 * A tree's UPDATE: each row's drawn columns over the stored rows, under one WITH RECURSIVE.
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
 * end is a row's last child's after (treeEndUpdate). It sets the columns `added` holds alone, none where it holds none
 * of them.
 */
const treeUpdate = (
	input: BackfillInput,
	family: Family,
	shape: TreeShape,
	table: ObjectName,
	added: ReadonlySet<string>
): DraftedDrawing | undefined => {
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
		kind: "drawing",
		drawing: {
			table,
			with: { recursive: true, ctes: [closure, sized, ranked, stepped, started, ...folded] },
			rows: { kind: "query", query: drawn },
			match: keyMatch(keyed),
			set
		},
		reads: cellsOf(table, [
			...carried,
			...(holds(added, family.index) ? [] : [columnOf(family.index)]),
			...foldReads(installation, member, folds)
		])
	}
}

/** The names a tree's parent drawing gives what it computes (parentUpdate), none a field's. */
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
const parentUpdate = (
	input: BackfillInput,
	family: Family,
	shape: TreeShape,
	table: ObjectName,
	added: ReadonlySet<string>
): DraftedDrawing => {
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
		kind: "drawing",
		drawing: {
			table,
			with: { recursive: false, ctes: [levels, roles, heads] },
			rows: {
				kind: "query",
				query: select(
					provedCore(
						"keyed",
						[
							...key.map((k) => targetAs(col("h", k), k)),
							targetAs(col("h", "__parent"), "__parent")
						],
						[cteRefAs(headsName, "h")],
						eq(col("h", "__candidate"), int(0n))
					)
				)
			},
			match: keyMatch(keyed),
			set: [{ column: shape.parent.column, value: "__parent" }]
		},
		reads: cellsOf(table, [...carried, end])
	}
}

/** A tree's fold ends this migration adds: each row's end its last child's after, read off the backfilled rows; a
 * leaf keeps its placeholder, the identity, which an empty family's end is. */
const treeEndUpdate = (
	names: OperatorNames,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>
): DraftedDrawing | undefined => {
	const planes = family.folds.flatMap((fold) =>
		fold.planes.filter((plane) => added.has(plane.end.column))
	)
	const set = planes.map((plane) => ({ column: plane.end.column, value: columnOf(plane.after) }))
	if (!isNonEmpty(set)) {
		return undefined
	}
	return {
		kind: "drawing",
		drawing: {
			table,
			with: undefined,
			rows: readOff(
				table,
				"c",
				[...mapNonEmpty(family.group, (g) => g.member.column), ...set.map((d) => d.value)],
				[],
				and(appendNonEmpty(nonRoot(names, family, "c"), lastOf(family, "c")))
			),
			match: groupMatch(names, family, "owner", "member"),
			set
		},
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

/** The name a predecessor copy's rows give the slot after each member's (copyUpdate), none a field's. */
const nextName = "__next"

/**
 * A copy's UPDATE: its column set, on every source row, to `to` on the row its axis names, read as the table stood
 * before the statement; a source row whose axis names none keeps its base. Its rows are the axis's targets, each met at
 * the key the axis names it by: an owner at its key; a member at its group and the slot after its own, a tree's root
 * never one, whose slot is none's after (the root pin holds it at slot 0); a member last of its family at its group. It
 * reads its axis's columns on both rows, and `to` on the target's.
 */
const copyUpdate = (names: OperatorNames, copy: Copy): DraftedDrawing => {
	const { family, from, to } = copy
	const index = columnOf(family.index)
	const value = columnOf(to)
	const members = mapNonEmpty(family.group, (g) => g.member.column)
	const owners = family.group.map((g) => g.owner.column)
	const rooted = family.members.kind === "tree" ? [...members, ...owners] : []
	const axis = ((): {
		readonly rows: Rows
		readonly match: NonEmptyReadonlyArray<Match>
		readonly source: ReadonlyArray<string>
		readonly target: ReadonlyArray<string>
	} => {
		switch (copy.axis) {
			case "owner":
				return {
					rows: { kind: "table", table: copy.target },
					match: groupMatch(names, family, "member", "owner"),
					source: members,
					target: owners
				}
			case "predecessor":
				return {
					rows: readOff(
						copy.target,
						"a",
						[...members, value],
						[{ name: nextName, expr: binary("+", col("a", index), lit.int(1n, types.bigint)) }],
						conjunction(nonRoot(names, family, "a"))
					),
					match: [
						...groupMatch(names, family, "member", "member"),
						{ target: index, source: nextName, operators: undefined }
					],
					source: [...members, index],
					target: [...members, index, ...rooted]
				}
			case "last":
				return {
					rows: readOff(
						copy.target,
						"a",
						[...members, value],
						[],
						and(appendNonEmpty(nonRoot(names, family, "a"), lastOf(family, "a")))
					),
					match: groupMatch(names, family, "owner", "member"),
					source: owners,
					target: [...members, index, family.copy, ...rooted]
				}
		}
	})()
	return {
		kind: "drawing",
		drawing: {
			table: copy.source,
			with: undefined,
			rows: axis.rows,
			match: axis.match,
			set: [{ column: columnOf(from), value }]
		},
		reads: [...cellsOf(copy.source, axis.source), ...cellsOf(copy.target, [...axis.target, value])]
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

/** A backfill statement as drafted: a family's member part, which the table's member UPDATE takes (merged), or any other
 * UPDATE, with the columns it reads (a member part's are its own table's, MemberPart reads). */
type Drafted =
	| { readonly kind: "member"; readonly part: MemberPart }
	| { readonly kind: "drawing"; readonly drawing: Drawing; readonly reads: ReadonlyArray<Cell> }

/** A backfill drawing as drafted, with the columns it reads. */
type DraftedDrawing = Extract<Drafted, { readonly kind: "drawing" }>

/** The columns a drafted statement draws: those it sets. */
const drawsOf = (d: Drafted): ReadonlyArray<Cell> =>
	d.kind === "member"
		? cellsOf(
				d.part.table,
				d.part.set.map((x) => x.column)
			)
		: cellsOf(
				d.drawing.table,
				d.drawing.set.map((a) => a.column)
			)

/** The columns a drafted statement reads. */
const readsOf = (d: Drafted): ReadonlyArray<Cell> =>
	d.kind === "member" ? cellsOf(d.part.table, [...d.part.reads]) : d.reads

/** A drafted statement with the family whose columns it draws, which a refusal names. */
interface Planned {
	readonly family: Family
	readonly drafted: Drafted
}

/** A statement the walk of `ordered` is placing, and the column it reads that the statement above it draws. */
interface Placing {
	readonly at: Planned
	readonly reading: Cell
}

/**
 * The backfill's statements in an order that runs each after every statement drawing a column it reads, otherwise as
 * drafted: a depth-first walk that places, before each statement, the statements drawing what it reads. A statement
 * reading a column it draws itself is a copy of itself along its axis (a tree's column copied from its parent's, a
 * member's from its predecessor's), which holds its base on every row, its placeholder: it reads itself as it stands.
 * A statement the walk reaches while placing what it reads closes a cycle, each statement of which reads a column the
 * next draws: no order draws them, and the cycle is refused, each statement named by the columns it draws and the one it
 * reads.
 */
const ordered = (planned: ReadonlyArray<Planned>): ReadonlyArray<Drafted> => {
	const drawer = new Map<string, Planned>()
	for (const p of planned) {
		for (const c of drawsOf(p.drafted)) {
			if (drawer.has(cellKey(c))) {
				throw defect(`one backfill statement draws ${cellName(c)}`)
			}
			drawer.set(cellKey(c), p)
		}
	}
	const placed = new Set<Planned>()
	const out: Array<Drafted> = []
	const walk: Array<Placing> = []
	const place = (p: Planned): void => {
		if (placed.has(p)) {
			return
		}
		for (const reading of readsOf(p.drafted)) {
			const by = drawer.get(cellKey(reading))
			if (by === undefined || by === p || placed.has(by)) {
				continue
			}
			const open = walk.findIndex((w) => w.at === by)
			if (open !== -1) {
				const cycle = [...walk.slice(open), { at: p, reading }]
				return refuseBackfill(
					by.family,
					`no order draws its columns, each statement of a cycle reading a column the next draws: ${cycle
						.map(
							(w) =>
								`${drawsOf(w.at.drafted).map(cellName).join(", ")} drawn reading ${cellName(w.reading)}`
						)
						.join("; ")}`
				)
			}
			walk.push({ at: p, reading })
			place(by)
			walk.pop()
		}
		placed.add(p)
		out.push(p.drafted)
	}
	for (const p of planned) {
		place(p)
	}
	return out
}

/** A backfill statement as merged: a table's member UPDATE of the parts it takes so far, or a drawing. */
type Merged =
	| { readonly kind: "members"; readonly first: MemberPart; readonly rest: Array<MemberPart> }
	| { readonly kind: "drawing"; readonly drawing: Drawing }

/** The columns of `table` a merged statement draws. */
const drawsOn = (m: Merged, table: ObjectName): ReadonlyArray<string> => {
	switch (m.kind) {
		case "members":
			return nameKey(m.first.table) === nameKey(table)
				? [m.first, ...m.rest].flatMap((p) => p.set.map((d) => d.column))
				: []
		case "drawing":
			return nameKey(m.drawing.table) === nameKey(table) ? m.drawing.set.map((a) => a.column) : []
	}
}

/**
 * The backfill's statements, at most one member UPDATE of a table at each of its places: every UPDATE writes a new
 * version of each row it names, which holds its space until the migration's transaction ends, so a table's member parts
 * share one UPDATE wherever their reads allow. A member part reads its own table alone (memberPart), so it joins the
 * table's latest member UPDATE when no statement from that one on draws a column it reads: run beside them, it reads
 * every column as it read it after them, and what reads its columns still runs after it. Otherwise it opens its table's
 * next member UPDATE where it stands. Every other UPDATE stands where drafted: an owner's, a tree's and a copy's name
 * only some rows of their tables, which an inner join cannot keep beside another's.
 */
const merged = (drafted: ReadonlyArray<Drafted>): ReadonlyArray<Update> => {
	const out: Array<Merged> = []
	const open = new Map<string, Extract<Merged, { readonly kind: "members" }>>()
	for (const d of drafted) {
		if (d.kind === "drawing") {
			out.push({ kind: "drawing", drawing: d.drawing })
			continue
		}
		const key = nameKey(d.part.table)
		const latest = open.get(key)
		const since = latest === undefined ? -1 : out.indexOf(latest)
		if (
			latest !== undefined &&
			out.slice(since).every((m) => drawsOn(m, d.part.table).every((c) => !d.part.reads.has(c)))
		) {
			latest.rest.push(d.part)
			continue
		}
		const opened: Extract<Merged, { readonly kind: "members" }> = {
			kind: "members",
			first: d.part,
			rest: []
		}
		open.set(key, opened)
		out.push(opened)
	}
	return out.map((m) =>
		m.kind === "drawing" ? drawingUpdate(m.drawing) : memberUpdate([m.first, ...m.rest])
	)
}

/**
 * The backfill of every family of the target whose columns this migration adds to a table that may hold rows
 * (Backfill): each family's member part and its owner's UPDATE, which reads the member's backfilled rows (a tree's parent
 * drawn anew, its one UPDATE, then its fold ends), and every copy this migration adds, in an order that runs each after
 * every statement drawing a column it reads (ordered); each table's member parts sharing one UPDATE where their reads
 * allow (merged). A column two axes carry is drawn by the first in the law model's order, the owner axis's before the
 * predecessor's and the last's; the other's foreign key, which VALIDATE proves, holds it to the same value. A family whose columns are all new to tables that hold no row needs none: its placeholders are the
 * values an empty family holds.
 */
export const backfillOf = (input: BackfillInput): Backfill => {
	const { installation } = input
	const planned: Array<Planned> = []
	const plan = (family: Family, drafted: Drafted | undefined): void => {
		if (drafted !== undefined) {
			planned.push({ family, drafted })
		}
	}
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
				plan(family, parentUpdate(input, family, shape, memberTable, onMember))
			}
			if (!columns.some((c) => onMember.has(c))) {
				continue
			}
			plan(family, treeUpdate(input, family, shape, memberTable, onMember))
			plan(family, treeEndUpdate(input.installation.names, family, memberTable, onMember))
			continue
		}
		const m = memberPart(input, family, memberTable, mine)
		plan(family, m === undefined ? undefined : { kind: "member", part: m })
		plan(family, ownerUpdate(input, family, ownerTable, memberTable, theirs))
	}
	const families = familyCells(installation)
	const copied = new Set<string>()
	for (const family of installation.laws.families) {
		for (const c of copiesOf(installation, family, families)) {
			const cell = cellKey({ table: c.source, column: columnOf(c.from) })
			if (
				!copied.has(cell) &&
				input.mayHoldRows(c.source) &&
				(input.added.get(nameKey(c.source))?.columns ?? []).includes(columnOf(c.from))
			) {
				copied.add(cell)
				plan(family, copyUpdate(installation.names, c))
			}
		}
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
	return { updates: merged(ordered(planned)), dropDefaults }
}
