/**
 * The backfill of the families a migration adds to relations that may hold rows: grizzle draws every
 * value a family holds (each index, count, copy and accumulator), so a family new to stored rows takes its values from
 * SQL over those rows, in the migration that adds it, never from the reviewer.
 *
 * Each column the backfill writes is added with a placeholder DEFAULT (AlterTableAction addColumnDefault): the value it
 * holds where its family is empty, 0 for a count or an index and the fold's identity for an accumulator or an end, which
 * the backfill overwrites on every row that has a member before the DROP DEFAULT; or it is a column the previous
 * installation's families drew that the migration draws again (deploy/diff/diff.ts FieldChange redrawn), its filler or
 * what its fill reads changed, kept in place with its values, which the backfill presents at its placeholder where no
 * derivation meets a row, as a fresh column holds it (Presented). The backfill runs after every column's ADD COLUMN and
 * before every constraint that reads one (slots structure.backfill, structure.constraints), and VALIDATE then proves
 * it: a value it drew wrongly is a violation of the family's own natives, never a silent state.
 *
 * - **Members:** each family's member columns, its index, its copy of the count and its folds' accumulators, are drawn by
 *   the family's served scan (write/family/scan.ts scanOf), run over the stored rows from slot 0, every group whole from
 *   the family's base: the one window lowering of the fill rules (ir/fill.ts) a write draws by, so a migration draws a
 *   value exactly as the write that later maintains it does. Each row's slot is ‹i› = row_number() OVER (PARTITION BY g
 *   ORDER BY the member key) − 1, its count its group's; the member key is a key of the stored rows, so the order is
 *   total and no two members tie, and an index new to the stored rows carries no order of the caller's. A stored index
 *   whose family only changes its group is kept (deploy/diff/declared.ts sameSequence) and is each row's slot: the
 *   caller's order. The owner's end is its last member's after, the identity for an empty group (the placeholder
 *   default).
 * - **Trees:** each row's sibling index by its key, its count, the rows naming it their parent, and its parent's
 *   count, each a window over the tree's rows, no closure of the parent relation: nothing drawn reads a row's ancestors
 *   past its parent. A tree whose index the migration keeps keeps its caller's sibling order: every column drawn anew
 *   reads the stored index, and only the columns the migration adds are written. The stored start and end are its rows'
 *   pre-order, kept as its index is (deploy/diff/declared.ts sameSequence): a parent drawn anew is drawn from them first,
 *   each row's parent the start of the row of its root value whose interval holds its own most tightly, read off one
 *   sorted stream of the intervals' bounds (parentDerivation), and a migration that draws a tree's start or end anew on a
 *   table that may hold rows is refused, naming the tree.
 *
 * - **Tree folds:** the tree's scan over each row's siblings in slot order, their order by start, and over its roots,
 *   each alone at slot 0, its before the identity; each row's end its last child's after. A fold added to a tree that
 *   holds rows, or changed on one, is drawn over its stored slots alone.
 * - **Copies:** each copy the owner or last axis carries is its target's value, joined to the row its axis names; a row
 *   its axis names no row for keeps the copy's base, a tree's root among them. Each predecessor copy is drawn by its
 *   family's scan, with the members' other columns, as a write draws it: its target on the member before, the base at
 *   slot 0, and a chain's, a copy of a column that reads the copy back through its row, by the scan's recursion
 *   (write/family/scan.ts chainLayer).
 * - **Tree chains:** a tree's copy of its parent's column that reads the copy back through its row has its source's
 *   value over the parent's row as its own copies leave that row, drawn by a recursion down the tree from its roots,
 *   which hold its base (treeChainDerivation).
 * - **Places:** a place ordered by a field that a migration adds to stored rows (ir/instant.ts PlaceOrder) numbers each
 *   group's rows from 0 in that field's order, ‹n› = row_number() OVER (PARTITION BY its group ORDER BY `by`) − 1, total
 *   by the key the classifier demands within the group and `by`, and the inserts after it stamp on from the group's
 *   greatest; an unordered one is no derivation's, each stored row at 0 (deploy/diff/diff.ts stampedColumn).
 * - **Carried:** a column a migration adds to stored rows that a containment of the target carries from another table
 *   (Carry, deploy/diff/diff.ts carryOf) takes, on each row, the value of the row the previous installation's
 *   containment named, read off one sorted stream of both tables at that containment's columns, as a copy is; then its
 *   NOT NULL is set. A re-key that moves a child's reference from one key of its parent to another keeps every row
 *   at the parent row it named.
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
 * once, each derivation a CTE of its WITH, a column an earlier UPDATE wrote read as stored and never drawn again: a
 * migration writes one new version of each row whose drawn values change, however many of its families' columns it
 * draws, and none of a row that already holds them. Every UPDATE is a join of
 * sets of rows, each derivation met at a key by a LEFT JOIN, so none is a probe run once per row, which before any index
 * of the table exists (structure.backfill runs before them) would read the whole table for each of its rows.
 *
 * Window functions are admitted here: a migration is reviewed text, and grizzle's limits on them are limits on its
 * run-time queries. No derivation but a chain's recurs: each is sorts and windows over its table's rows, so its cost is
 * its rows' sort, whatever the depth of a tree or the length of a family; a chain's costs a round for each slot of its
 * longest family, or each level of its deepest tree.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	dedupeNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { installed } from "#compiler/deploy/snapshot/objects.ts"
import type { RecordedObject } from "#compiler/deploy/snapshot/recorded.ts"
import type { SnapshotTheory } from "#compiler/deploy/snapshot/types.ts"
import { type OperatorNames, typedEq } from "#compiler/ir/compare.ts"
import { closedRelationsRead, fieldReads, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { AxisKind, Family, FamilyFold, FoldPlane, TreeShape } from "#compiler/ir/family.ts"
import {
	type FillAt,
	type FillColumn,
	type FillLayout,
	type FillRule,
	filledFrom,
	layoutKey
} from "#compiler/ir/fill.ts"
import type { PlaceHead } from "#compiler/ir/instant.ts"
import type { LawField, NativeColumn, RelationInfo, TableRelation } from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { migrationGenerations } from "#compiler/laws/model/generation.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type { ClosedNames } from "#compiler/physical/ddl/constants.ts"
import { lowerPersistent } from "#compiler/physical/ddl/expr.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type Cte,
	type Expr,
	type FromSource,
	type JoinStep,
	type ObjectName,
	type Select,
	type SetCore,
	type SqlStatement,
	type Target,
	type TypeRef,
	type Update,
	type WindowSpec,
	type With,
	nameKey,
	type NameKey,
	storedColumnKey,
	type StoredColumnKey
} from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	binary,
	call,
	cast,
	col,
	conjunction,
	countStar,
	cte,
	cteRefAs,
	cUtf8Collation,
	derived,
	desc,
	eq,
	join,
	lit,
	not,
	objectName,
	provedCore,
	select,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { assignments, type TableGeneration } from "#compiler/sql/generation.ts"
import { freshNames, namedBody, NameSupply } from "#compiler/sql/naming.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import {
	rowColumns,
	type Scan,
	scannedColumn,
	type ScanLowering,
	type ScanRows,
	scanOf
} from "#compiler/write/family/scan.ts"

/** A column a family draws: the value it holds where its family is empty, the placeholder DEFAULT a migration adds it
 * under to a table that may hold rows, a literal of its base type; and that base type, the type its values are compared
 * in, byte for byte, where the backfill writes only the rows whose drawn values differ from those they store (passes). */
export interface DrawnColumn {
	readonly placeholder: Expr
	readonly base: TypeRef
}

/** The columns of each table the target's families draw, by table key (nameKey), then column (DrawnColumn). */
export type DrawnColumns = ReadonlyMap<NameKey, ReadonlyMap<string, DrawnColumn>>

/**
 * The columns the backfill draws on a table that may hold rows: those this migration adds under their placeholder
 * defaults, in the order it adds them, which every stored row holds until the backfill draws it and whose default it
 * then drops; and those it draws again in place (deploy/diff/diff.ts FieldChange redrawn), whose column, values and
 * what is built over them stand as the previous installation left them.
 */
export interface BackfilledTable {
	readonly table: ObjectName
	readonly added: ReadonlyArray<string>
	readonly redrawn: ReadonlyArray<string>
}

/** Each table's columns the backfill draws, by table key (nameKey). */
export type Backfilled = ReadonlyMap<NameKey, BackfilledTable>

/**
 * A column a migration adds to stored rows that a containment of the target carries into another table's column
 * (deploy/diff/diff.ts carryOf): `column` of `table`, of base type `base`, added with no NOT NULL and no default, which
 * each stored row takes from `value` of the row of `source` the previous installation's containment named, the row
 * met where `targetKey` on `table` equals `sourceKey` on `source`, pair for pair, a key of `source`'s stored rows; then
 * its NOT NULL is set. Every stored row is met, since the previous containment held of every row it read from.
 */
export interface Carry {
	readonly table: ObjectName
	readonly column: string
	readonly base: TypeRef
	readonly source: ObjectName
	readonly value: string
	readonly targetKey: NonEmptyReadonlyArray<string>
	readonly sourceKey: NonEmptyReadonlyArray<string>
}

/** What the backfill of a migration reads besides its target: the previous snapshot's theory, which names the key the
 * stored rows of a relation are distinct by; whether a table of the target holds rows before the migration; the
 * columns it draws, added under their placeholder defaults or drawn again in place (BackfilledTable); and the columns a
 * containment carries into stored rows (Carry). */
export interface BackfillInput {
	readonly installation: Installation
	readonly previous: SnapshotTheory
	readonly mayHoldRows: (table: ObjectName) => boolean
	readonly drawn: Backfilled
	readonly carried: ReadonlyArray<Carry>
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
 * a placeholder and the SET NOT NULL of every column a containment carries (Carry). */
export interface Backfill {
	readonly checks: ReadonlyArray<KeyCheck>
	readonly updates: ReadonlyArray<SqlStatement>
	readonly dropDefaults: ReadonlyArray<SqlStatement>
	readonly notNulls: ReadonlyArray<SqlStatement>
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
const tableOf = (installation: Installation, name: string): ObjectName => {
	const table = installation.names.relation(name)
	return objectName(table.schema, table.name)
}

/** The installed column of a family's native column: a field's, or a law column's own identifier. */
const columnOf = (c: NativeColumn): string => (c.kind === "field" ? c.field.column : c.column)

/** A literal of `type`, typed by its base, never cast to a domain (lowerLiteral). */
const literalOf = (installation: Installation, value: TypedLiteral, type: ScalarType): Expr =>
	lowerLiteral(installation.names, value, type)

/** A drawn column of `type` whose family's emptiness holds `value` (DrawnColumn). */
const drawnOf = (
	installation: Installation,
	value: TypedLiteral,
	type: ScalarType
): DrawnColumn => ({
	placeholder: literalOf(installation, value, type),
	base: baseTypeRef(installation.names, type)
})

const zero: TypedLiteral = { kind: "int", value: 0n }

/** The place of a group's first row, 0, as a literal of the place's type: an unordered place's value on every stored row
 * of a table a migration adds it to (deploy/diff/diff.ts stampedColumn). */
export const placeStart = (installation: Installation, place: PlaceHead): Expr =>
	drawnOf(installation, zero, place.field.type).placeholder

/** A family's counts and indices, 0 where it is empty, typed by its count's base. */
const zeroOf = (installation: Installation, family: Family): DrawnColumn =>
	drawnOf(installation, zero, family.count.type)

/** A fold plane's accumulators and end, typed by its end's base: its identity at the first slot, and an empty family's
 * end. */
const identityOf = (installation: Installation, plane: FoldPlane): DrawnColumn =>
	drawnOf(installation, plane.identity, plane.end.type)

/**
 * The columns the target's families draw (DrawnColumns): on a member, the counted index ‹i› or the ordered index, the
 * copy ‹n›, each fold plane's before and after; on an owner, the count and each fold plane's end; a tree's parent and
 * interval among them; and every copy an axis carries (Copy) on its source. Each holds 0 where its family is
 * empty, but an accumulator or an end, which holds its plane's identity, and a copy, which holds its base. Each place
 * ordered by a field (ir/instant.ts PlaceOrder) is drawn too, at 0 before its derivation numbers its stored rows
 * (placeDerivation); an unordered one is stamped (deploy/diff/diff.ts stampedColumn).
 */
export const drawnColumns = (installation: Installation): DrawnColumns => {
	const out = new Map<NameKey, Map<string, DrawnColumn>>()
	const families = familyCells(installation)
	const put = (relation: string, column: string, value: DrawnColumn): void => {
		const key = nameKey(tableOf(installation, relation))
		const of = out.getOrInsertComputed(key, () => new Map<string, DrawnColumn>())
		of.set(column, value)
	}
	for (const family of installation.laws.families) {
		const member = family.member.name
		const owner = family.owner.name
		const nothing = zeroOf(installation, family)
		put(member, columnOf(family.shape.index), nothing)
		put(member, family.copy, nothing)
		put(owner, family.count.column, nothing)
		if (family.shape.kind === "tree") {
			put(member, family.shape.parent.column, nothing)
			put(member, family.shape.start.column, nothing)
			put(member, family.shape.end.column, nothing)
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
	for (const place of installation.laws.theory.instants.places.values()) {
		if (place.order.kind === "by") {
			put(place.relation, place.field.column, drawnOf(installation, zero, place.field.type))
		}
	}
	return out
}

declare const closedNodeBrand: unique symbol

/** A closed relation as a node of the fill read graph (FillReads): its declared name, past a U+0001 no column key starts
 * with. */
export type ClosedNode = string & { readonly [closedNodeBrand]: true }

const mintClosedNode = nominal<string, ClosedNode>()

/** The fill read graph's node of the closed relation `relation`. */
const closedNode = (relation: string): ClosedNode => mintClosedNode(`\u0001${relation}`)

/** A node of the fill read graph: a stored column, by its key (sql/ast.ts storedColumnKey), or a closed relation, whose
 * rows reach the database only as its constants (physical/ddl/constants.ts NamedClosed). */
export type FillNode = StoredColumnKey | ClosedNode

/**
 * The target's fill read graph (ir/fill.ts FillOrder): each column a write fills on a row a family reaches, by its key
 * (sql/ast.ts storedColumnKey), with every node it reads: the columns of its own row its rule reads (FillColumn reads),
 * the column its rule takes off another row, a copy's target along its axis and a member's group field's owner column,
 * and each closed relation its rule's expressions read, a fold's selection or a generated value's expression
 * (closedRelationsRead). A column the fill draws holds its rule's value over what it reads, so a migration that
 * changes the values of a column it reads, or replaces the constants of a closed relation it reads (replacedClosed),
 * draws it again (`changedOver`).
 */
export type FillReads = ReadonlyMap<StoredColumnKey, ReadonlyArray<FillNode>>

export const fillReadsOf = (installation: Installation): FillReads => {
	const schema = installation.names.schema
	const at = (relation: RelationInfo | TableRelation, c: NativeColumn): StoredColumnKey =>
		storedColumnKey(nameKey(objectName(schema, relation.ident)), columnOf(c))
	/** The column a rule takes off another row, by its node: none for a rule that reads its own row alone. */
	const across = (layout: FillLayout, rule: FillRule): ReadonlyArray<StoredColumnKey> => {
		switch (rule.kind) {
			case "ownerCopy":
				return [at(rule.family.owner, rule.to)]
			case "predecessor":
			case "last":
				return [at(rule.family.member, rule.to)]
			case "owner":
				return layout.position.kind === "member" ? [at(layout.position.family.owner, rule.to)] : []
			case "given":
			case "self":
			case "base":
			case "index":
			case "copy":
			case "count":
			case "start":
			case "end":
			case "after":
			case "generated":
				return []
		}
	}
	/** The closed relations a rule's expressions read: a fold's selection's, a generated value's expression's. */
	const closedOf = (rule: FillRule): ReadonlyArray<ClosedNode> =>
		closedRelationsRead(
			rule.kind === "after" ? rule.fold.where : rule.kind === "generated" ? [rule.expr] : []
		).map(closedNode)
	const out = new Map<StoredColumnKey, Array<FillNode>>()
	for (const layout of installation.laws.theory.fill.layouts.values()) {
		for (const c of layout.columns) {
			const node = at(layout.relation, c.column)
			const reads = out.get(node) ?? []
			for (const r of c.reads) {
				reads.push(at(layout.relation, r))
			}
			for (const r of across(layout, c.rule)) {
				reads.push(r)
			}
			for (const r of closedOf(c.rule)) {
				reads.push(r)
			}
			out.set(node, reads)
		}
	}
	return out
}

/**
 * The node of each closed relation of the target whose constants the previous manifest does not hold, each of them
 * named by its content (physical/ddl/constants.ts NamedClosed functions): its rows changed, so every fill that reads it
 * draws again (changedOver), as one that reads a column whose values change does.
 */
export const replacedClosed = (
	previous: ReadonlyArray<RecordedObject>,
	closed: ClosedNames
): ReadonlyArray<ClosedNode> => {
	const held = new Set(
		previous.flatMap((o) => {
			const v = installed(o)
			return v.kind === "constant" ? [v.create.name.name] : []
		})
	)
	return [...closed].flatMap(([relation, c]) =>
		c.functions.every((f) => held.has(f)) ? [] : [closedNode(relation)]
	)
}

/**
 * Every node whose values change with `seeds`' (FillReads): each seed, and each column that reads a changed one,
 * transitively, each reached once along its readers.
 */
export const changedOver = (reads: FillReads, seeds: Iterable<FillNode>): ReadonlySet<FillNode> => {
	const readers = new Map<FillNode, Array<StoredColumnKey>>()
	for (const [node, of] of reads) {
		for (const read of of) {
			const by = readers.getOrInsertComputed(read, () => [])
			by.push(node)
		}
	}
	const changed = new Set<FillNode>()
	const pending: Array<FillNode> = [...seeds]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (!changed.has(node)) {
			changed.add(node)
			for (const reader of readers.get(node) ?? []) {
				pending.push(reader)
			}
		}
	}
	return changed
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
	fn: "row_number" | "sum" | "min" | "first_value",
	args: ReadonlyArray<Expr>,
	spec: WindowSpec
): Expr => ({
	...call(fn, args),
	over: spec
})

/** A query core of the backfill: one SELECT's targets over its FROM, never DISTINCT. */
type Core = Extract<SetCore, { readonly distinct: false }>

/** Whether `columns` holds the column of a native column. */
const holds = (columns: ReadonlySet<string>, c: NativeColumn): boolean => columns.has(columnOf(c))

/**
 * The columns the backfill orders a family's stored members by: the member's primary key, a key of its stored rows;
 * or, when the migration adds a field of that key (an ordered family's index is often one), the key the previous
 * snapshot records, which the stored rows are distinct by. Each column orders at the type it holds while the backfill
 * runs: a field the member keeps at its type in the target, which the migration's Structure converted it to before the
 * backfill, and a field the migration drops at the type the previous snapshot records, the column standing until the
 * migration's removals at its end.
 */
const memberKey = (
	input: BackfillInput,
	family: Family,
	member: RelationInfo,
	added: ReadonlySet<string>
): NonEmptyReadonlyArray<string> => {
	const own = mapNonEmpty(member.primaryFields, (f) => f.column)
	if (!own.some((c) => added.has(c))) {
		return own
	}
	const was = input.previous.relations[member.name]
	if (was?.kind !== "relation") {
		return refuseBackfill(family, `${member.name}'s stored rows have no key the snapshot records`)
	}
	const columns = was.primaryKey.map((name): string => {
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

/** A fold plane's columns the backfill writes on its member, by `added`. */
const planesAdded = (fold: FamilyFold, added: ReadonlySet<string>): boolean =>
	fold.planes.some((p) => holds(added, p.before) || holds(added, p.after))

/**
 * How the backfill lowers the scans it draws a family's members by (write/family/scan.ts ScanLowering): the
 * installation's names, its persistent expressions, each column it reads the row's value there, and its types' bases,
 * as its CHECKs and generated columns are (physical/ddl/expr.ts).
 */
const backfillLowering = (installation: Installation): ScanLowering => ({
	names: installation.names,
	expression: (expr, field) =>
		lowerPersistent(installation.names, expr, {
			reads: { kind: "row", column: (ref) => field(ref.name) },
			loc: backfillLoc
		}),
	baseType: (type) => baseTypeRef(installation.names, type)
})

/** The names the rows a backfill scans give what the scan reads of them beside the member's own columns, and what its
 * derivation draws, none a field's, since no declared name starts with an underscore, nor a law column's. */
const groupName = (k: number): string => `__group_${k}`
const slotName = "__slot"
const firstName = "__first"
const countName = "__count"
const drawnName = (n: number): string => `__drawn_${n}`

/**
 * The columns of a family's member the backfill draws by its scan, by their installed names: its index where the
 * migration draws it anew, its copy of the count where it adds it, both columns of every plane of each fold it adds a
 * column of, whose before is its predecessor's after, and each of the family's predecessor copies it adds (`copies`,
 * backfillOf's `scanned`).
 */
const drawnNamesOf = (
	family: Family,
	added: ReadonlySet<string>,
	folds: ReadonlyArray<FamilyFold>,
	copies: ReadonlySet<string>
): ReadonlySet<string> =>
	new Set([
		...(holds(added, family.shape.index) ? [columnOf(family.shape.index)] : []),
		...(added.has(family.copy) ? [family.copy] : []),
		...folds.flatMap((fold) => fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after)])),
		...[...copies].filter((c) => added.has(c))
	])

/**
 * The columns `names` names a family's member holds at `position`, a member's or a tree's root's, each with the rule its
 * fill layout states for it (ir/fill.ts), in fill order: what the backfill's scan draws there.
 */
const drawnAt = (
	installation: Installation,
	family: Family,
	position: FillAt,
	names: ReadonlySet<string>
): ReadonlyArray<FillColumn> =>
	defined(
		installation.laws.theory.fill.layouts.get(layoutKey(family.member.name, position)),
		`the fill layout of ${family.member.name} as a ${position.kind} of ${family.id.owner}.${family.id.count}`
	).columns.filter((c) => names.has(columnOf(c.column)))

/**
 * The columns of the member a scan of `drawn` reads and does not draw, each as the table stores it: what each drawn
 * column's rule reads of the member's row (ir/fill.ts FillColumn.reads, the fill analysis's one reading of a rule, a
 * fold's befores, its step value and the fields its selection reads), and a predecessor copy's column, which it reads
 * on the member before; a generated field by the columns its generation reads, which the scan generates it from, as a
 * write's does, so no stored generation an earlier column's draw leaves stale is read.
 */
const scanReads = (
	member: RelationInfo,
	drawn: ReadonlyArray<FillColumn>
): ReadonlyArray<NativeColumn> => {
	const drawnNames = new Set(drawn.map((c) => columnOf(c.column)))
	const out = new Map<string, NativeColumn>()
	const read = (c: NativeColumn): void => {
		const name = columnOf(c)
		if (drawnNames.has(name) || out.has(name)) {
			return
		}
		if (c.kind === "field" && c.field.writing.kind === "generated") {
			for (const input of fieldReads([c.field.writing.expr])) {
				read({
					kind: "field",
					field: defined(
						member.fields.find((f) => f.name === input),
						`the field ${input} of ${member.name}`
					)
				})
			}
			return
		}
		out.set(name, c)
	}
	for (const c of drawn) {
		for (const r of filledFrom(c.rule, c.reads)) {
			read(r)
		}
	}
	return [...out.values()]
}

/** Where a scan's rows stand: each row's group, its slot and its group's count, over the rows' source. */
interface Slots {
	readonly group: NonEmptyReadonlyArray<Expr>
	readonly slot: Expr
	readonly count: Expr
}

/**
 * The served scan of a family (write/family/scan.ts scanOf), run over stored rows from slot 0: the rows CTE `name`, each
 * row of `source` (alias `alias`) that `where` keeps with its group, slot, its group's first drawn slot, 0, and count
 * (`slots`), the columns `through` names, which the scan passes on, and every column `reads` holds by its table
 * column's name; and the scan of `drawn` over them, every group drawn whole from the family's base, as a write's scan
 * draws a group its owner inserts.
 */
const scanOver = (
	installation: Installation,
	supply: NameSupply,
	family: Family,
	name: string,
	source: { readonly from: FromSource; readonly alias: string; readonly where: Expr | undefined },
	slots: Slots,
	through: ReadonlyArray<string>,
	drawn: ReadonlyArray<FillColumn>,
	reads: ReadonlyArray<NativeColumn>
): { readonly rows: Cte; readonly scan: Scan } => {
	const columns = rowColumns(reads, columnOf)
	const rows: ScanRows = {
		name,
		group: mapNonEmpty(slots.group, (_, k) => groupName(k)),
		slot: slotName,
		first: firstName,
		count: countName,
		columns,
		owner: new Map(),
		through
	}
	return {
		rows: cte(
			name,
			select(
				provedCore(
					"keyed",
					[
						...through.map((c) => targetAs(col(source.alias, c), c)),
						...mapNonEmpty(slots.group, (g, k) => targetAs(g, groupName(k))),
						targetAs(slots.slot, slotName),
						targetAs(lit.int(0n, types.bigint), firstName),
						targetAs(slots.count, countName),
						...[...columns.values()].map((c) => targetAs(col(source.alias, c), c))
					],
					[source.from],
					source.where
				)
			)
		),
		scan: scanOf(backfillLowering(installation), supply, {
			family,
			member: family.member,
			drawn,
			rows,
			group: { kind: "base" }
		})
	}
}

/** The drawn columns of `assigned` a derivation sets, each named by its place (drawnName), and the scanned column of
 * `scan` that holds it. */
const assignedOf = (
	scan: Scan,
	assigned: NonEmptyReadonlyArray<FillColumn>
): NonEmptyReadonlyArray<Drawn & { readonly scanned: string }> =>
	mapNonEmpty(assigned, (c, n) => ({
		column: columnOf(c.column),
		value: drawnName(n),
		scanned: defined(scannedColumn(scan.rows, c.column), `the scanned ${c.name}`)
	}))

/**
 * A counted or ordered family's member derivation: every column of its member the migration adds, drawn by the family's
 * scan over the member's stored rows from slot 0 (scanOver), each row's slot its stored index where the migration keeps
 * it, the caller's order, else row_number() by the member's key in its group, less one, and its count its group's.
 */
const memberDerivation = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>,
	copies: ReadonlySet<string>
): Derivation | undefined => {
	const { installation } = input
	const member = relationOf(installation, family.member.name)
	const index = columnOf(family.shape.index)
	const drawIndex = added.has(index)
	const folds = family.folds.filter((fold) => planesAdded(fold, added))
	if (drawIndex && folds.length < family.folds.length) {
		return refuseBackfill(
			family,
			"its index is drawn anew while a fold keeps its stored accumulators"
		)
	}
	const drawn = drawnAt(
		installation,
		family,
		{ kind: "member", family },
		drawnNamesOf(family, added, folds, copies)
	)
	const assigned = drawn.filter((c) => holds(added, c.column))
	if (!isNonEmpty(assigned)) {
		return undefined
	}
	const key = memberKey(input, family, member, added)
	const group = mapNonEmpty(family.group, (g) => g.member.column)
	const partition = group.map((g) => col("m", g))
	const reads = scanReads(member, drawn)
	const { rows, scan } = scanOver(
		installation,
		new NameSupply(freshNames),
		family,
		"__rows",
		{ from: { kind: "table", table, alias: "m" }, alias: "m", where: undefined },
		{
			group: mapNonEmpty(group, (g) => col("m", g)),
			slot: drawIndex
				? binary(
						"-",
						over(
							"row_number",
							[],
							window(
								partition,
								key.map((k) => col("m", k)),
								false
							)
						),
						lit.int(1n, types.bigint)
					)
				: col("m", index),
			count: { ...countStar(), over: window(partition, [], false) }
		},
		[rowColumn],
		drawn,
		reads
	)
	const set = assignedOf(scan, assigned)
	return {
		table,
		with: { recursive: false, ctes: [rows, scan.cte] },
		core: provedCore(
			"keyed",
			[
				targetAs(col("s", rowColumn), rowColumn),
				...set.map((d) => targetAs(col("s", d.scanned), d.value))
			],
			[cteRefAs(scan.cte.name, "s")],
			undefined
		),
		set: mapNonEmpty(set, ({ column, value }) => ({ column, value })),
		reads: cellsOf(table, [...key, ...group, ...(drawIndex ? [] : [index]), ...reads.map(columnOf)])
	}
}

/** A column a derivation draws, and the name of the column of its rows that holds it. */
interface Drawn {
	readonly column: string
	readonly value: string
}

/**
 * One body of the backfill, a family's member part, owner, tree parent, tree, tree end or copy: rows computed apart from
 * the table whose columns it draws, `core` under its own WITH, each holding the tid of the row of `table` it meets, its
 * `ctid` (rowColumn), and every value it draws (`set`); and every column it reads, on any table (`reads`). A row of the
 * table is met by at most one of its rows, at the row's own tid, so every meeting of a derivation and its table is a
 * join on one column, which PostgreSQL hashes or merges whole, and a row a derivation draws from rows of another (an
 * owner's from its last member, a copy from its axis's target) is read off one sorted stream of both (streamed), never a
 * join of them. Nothing it holds reads a row of the table but through its own FROM, so it is sorts and joins of sets of
 * rows, never a probe run once per row (passes).
 */
interface Derivation {
	readonly table: ObjectName
	readonly with: With | undefined
	readonly core: Core
	readonly set: NonEmptyReadonlyArray<Drawn>
	readonly reads: ReadonlyArray<Cell>
}

/**
 * The column every derivation's rows name the row of its table they meet by: that row's tid, PostgreSQL's system
 * column, which a staged view of the table carries as a column of its own.
 *
 * A tid is the address of one version of a row, and every UPDATE of the row, HOT or not, writes a new version at a new
 * tid. It is sound to meet at one because every tid the backfill meets at is read in the statement that meets at it:
 *
 * - Each table's UPDATE (passes) holds in its own WITH every derivation it reads, transitively, each a CTE of that one
 *   statement, and its staged view `b` and its target `t` are read in that statement too. No tid is stored, returned or
 *   handed from one statement to another: the next table's UPDATE derives every row it reads again, from the table as
 *   it then stands.
 * - A statement's CTEs and its main query all read under the statement's one snapshot, and its UPDATE's own changes
 *   are invisible to them: the only write of the statement is that UPDATE, and its derivations are SELECTs. So the tid
 *   a derivation reads from the table (or from a staged view of it, which reads the table) is the tid of the version
 *   the UPDATE's scan of `t` meets, for every row, in the same statement.
 * - Every earlier statement of the migration's transaction (Structure's ALTER TABLEs, the reviewer's data step after
 *   structure.immediate, the key checks, an earlier table's UPDATE, which writes no row of this table) may have moved
 *   rows: each runs to its end before this statement begins, and this statement reads the tids its writes left.
 *
 * test/pg/migrate/backfill-cost.test.ts runs the keyed tree's backfill over rows its data step has just moved, every
 * tid new, and judges every drawn value against the reference.
 */
const rowColumn = "ctid"

/** The names a stream gives what it computes, none a field's. */
const sourceName = "__source"
const metName = "__met"
const streamKeyName = (k: number): string => `__key_${k}`

/** A value a stream carries from its source rows to its table's: the source's expression, the column of the table it
 * sets, which holds its place on the table's rows at the same type, and its name among the stream's columns. */
interface Carried {
	readonly name: string
	readonly value: Expr
	readonly column: string
}

/**
 * The rows of `table` each met by a row of `source` at an equal key, read off one sorted stream of both, never a join:
 * the table's rows (alias `t`, those `targetWhere` keeps) at `targetKey`, the source's (alias `s`, those `sourceWhere`
 * keeps) at `sourceKey`, each key one partition, its source rows first and then by tid. A row of the table takes each
 * value of its partition's first row, which is a source row's where the partition holds one, and is kept only then
 * (`__met`). The stream is a sort of the two sets of rows, whatever keys they meet at and however many rows share one.
 */
const streamed = (spec: {
	readonly table: ObjectName
	readonly targetKey: NonEmptyReadonlyArray<Expr>
	readonly targetWhere: Expr | undefined
	readonly source: ObjectName
	readonly sourceKey: NonEmptyReadonlyArray<Expr>
	readonly sourceWhere: Expr | undefined
	readonly values: NonEmptyReadonlyArray<Carried>
}): Core => {
	const arm = (
		alias: string,
		table: ObjectName,
		key: NonEmptyReadonlyArray<Expr>,
		source: boolean,
		value: (c: Carried) => Expr,
		where: Expr | undefined
	): SetCore =>
		provedCore(
			"keyed",
			[
				targetAs(col(alias, rowColumn), rowColumn),
				targetAs(lit.bool(source), sourceName),
				...key.map((k, i) => targetAs(k, streamKeyName(i))),
				...spec.values.map((c) => targetAs(value(c), c.name))
			],
			[{ kind: "table", table, alias }],
			where
		)
	const stream = derived(
		select(
			unionAll("disjoint", [
				arm("t", spec.table, spec.targetKey, false, (c) => col("t", c.column), spec.targetWhere),
				arm("s", spec.source, spec.sourceKey, true, (c) => c.value, spec.sourceWhere)
			])
		),
		"u",
		false
	)
	const sourcesFirst: WindowSpec = {
		partitionBy: spec.targetKey.map((_, i) => col("u", streamKeyName(i))),
		orderBy: [desc(col("u", sourceName)), asc(col("u", rowColumn))],
		frame: undefined
	}
	const firstOf = (column: string): Expr => over("first_value", [col("u", column)], sourcesFirst)
	const partitioned = derived(
		select(
			provedCore(
				"keyed",
				[
					targetAs(col("u", rowColumn), rowColumn),
					targetAs(col("u", sourceName), sourceName),
					targetAs(firstOf(sourceName), metName),
					...spec.values.map((c) => targetAs(firstOf(c.name), c.name))
				],
				[stream],
				undefined
			)
		),
		"w",
		false
	)
	return provedCore(
		"keyed",
		[
			targetAs(col("w", rowColumn), rowColumn),
			...spec.values.map((c) => targetAs(col("w", c.name), c.name))
		],
		[partitioned],
		and([col("w", metName), not(col("w", sourceName))])
	)
}

/** The name a stream's derivation gives the value it carries for the `n`th column it sets. */
const carriedName = (n: number): string => `__carried_${n}`

/** The values a stream carries for `set`, each named by its place (carriedName), read off its source at `value`. */
const carriedOf = (
	set: NonEmptyReadonlyArray<{ readonly column: string; readonly value: Expr }>
): {
	readonly values: NonEmptyReadonlyArray<Carried>
	readonly drawn: NonEmptyReadonlyArray<Drawn>
} => ({
	values: mapNonEmpty(set, (d, n) => ({ name: carriedName(n), value: d.value, column: d.column })),
	drawn: mapNonEmpty(set, (d, n) => ({ column: d.column, value: carriedName(n) }))
})

/** Each group field of a family at `alias`, its owner's side or its member's. */
const groupAt = (
	family: Family,
	side: "owner" | "member",
	alias: string
): NonEmptyReadonlyArray<Expr> => mapNonEmpty(family.group, (g) => col(alias, g[side].column))

/** Whether a family's member at `alias` is its last: its index one less than its copy of the count. */
const lastOf = (family: Family, alias: string): Expr =>
	eq(
		col(alias, columnOf(family.shape.index)),
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
	const carried = carriedOf(
		mapNonEmpty(set, (d) => ({ column: d.column, value: col("s", d.value) }))
	)
	return {
		table,
		with: undefined,
		core: streamed({
			table,
			targetKey: groupAt(family, "owner", "t"),
			targetWhere: undefined,
			source: memberTable,
			sourceKey: groupAt(family, "member", "s"),
			sourceWhere: lastOf(family, "s"),
			values: carried.values
		}),
		set: carried.drawn,
		reads: [
			...cellsOf(table, [...family.group.map((g) => g.owner.column), ...set.map((d) => d.column)]),
			...cellsOf(memberTable, [
				...family.group.map((g) => g.member.column),
				columnOf(family.shape.index),
				family.copy,
				...afters
			])
		]
	}
}

/** The names a tree's derivation gives what it computes, none a field's. */
const rankedName = "__ranked"
const childrenName = "__children"
const rootName = "__root"

/**
 * A tree's derivation: each row's drawn columns over its rows, each a window over them, never a closure of the parent
 * relation. A tree's intervals are never drawn over stored rows (a migration that draws them is refused, backfillOf), so
 * nothing a tree's backfill draws reads a row's ancestors past its parent: its count reads its children, its index and
 * its copy of the count its siblings, and each fold and predecessor copy its siblings in slot order.
 *
 * - `w`: each row twice, as itself (`__child` 0) at its own key and, but a root, as a child (`__child` 1) at its
 *   parent's, and over each key `__children`, the children met there.
 * - `__ranked`, each row as itself: its sibling index, its stored one where the migration keeps the index, the caller's
 *   order, else row_number() by its key among the rows of its parent, the root alone at 0; and its copy of the count,
 *   its siblings' count, a root's its own count, as the root pin reads it.
 * - the tree's scan over its members, each parent's children a group in slot order, and over its roots, each alone at
 *   slot 0, outside its members as the fill order places it (scanOver): the root's before the identity, as its
 *   first-slot pin holds it, and its after its own step's, the one state the tree's pins admit a root; a root's
 *   predecessor copy its base, as a first sibling's.
 *
 * A row under stored parents that make no tree is drawn anyway, and VALIDATE refuses it by the tree's laws. Each fold's
 * end is a row's last child's after (treeEndDerivation). It sets the columns `added` holds alone, none where it holds
 * none of them.
 */
const treeDerivation = (
	input: BackfillInput,
	family: Family,
	table: ObjectName,
	added: ReadonlySet<string>,
	copies: ReadonlySet<string>
): Derivation | undefined => {
	const { installation } = input
	const member = relationOf(installation, family.member.name)
	const owner = mapNonEmpty(family.group, (g) => g.owner.column)
	const parent = mapNonEmpty(family.group, (g) => g.member.column)
	const key = memberKey(input, family, member, added)
	const folds = family.folds.filter((fold) => planesAdded(fold, added))
	const drawIndex = holds(added, family.shape.index)
	const index = columnOf(family.shape.index)
	const keys = drawnNamesOf(family, added, folds, copies)
	const members = drawnAt(installation, family, { kind: "member", family }, keys)
	const roots = drawnAt(installation, family, { kind: "root", family }, keys)
	const assigned = members.filter((c) => holds(added, c.column))
	const counted = added.has(family.count.column)
	if (!isNonEmpty(assigned) && !counted) {
		return undefined
	}
	const reads = scanReads(member, [...members, ...roots])
	const isRoot = and(
		mapNonEmpty(family.group, (g) =>
			typedEq(g.owner.type, col("t", g.member.column), col("t", g.owner.column), installation.names)
		)
	)
	const int = (value: bigint): Expr => lit.int(value, types.integer)
	const carried = dedupeNonEmpty([
		rowColumn,
		...key,
		...owner,
		...parent,
		...(drawIndex ? [] : [index]),
		...reads.map(columnOf)
	])
	const at = (k: number): string => `__k_${k}`
	/** One arm of `w`'s rows: each row of the table, met at `meets`, as itself (`__self`) or as a child (`__child`). */
	const arm = (
		meets: NonEmptyReadonlyArray<string>,
		child: bigint,
		where: Expr | undefined
	): SetCore =>
		provedCore(
			"keyed",
			[
				...carried.map((c) => targetAs(col("t", c), c)),
				targetAs(isRoot, rootName),
				...meets.map((c, k) => targetAs(col("t", c), at(k))),
				targetAs(int(child), "__child"),
				targetAs(lit.bool(child === 0n), "__self")
			],
			[{ kind: "table", table, alias: "t" }],
			where
		)
	const roles = derived(
		select(unionAll("disjoint", [arm(owner, 0n, undefined), arm(parent, 1n, not(isRoot))])),
		"e",
		false
	)
	const passed = [...carried, rootName, "__child", "__self"]
	const met = derived(
		select(
			provedCore(
				"keyed",
				[
					...passed.map((c) => targetAs(col("e", c), c)),
					targetAs(
						over(
							"sum",
							[col("e", "__child")],
							window(
								owner.map((_, k) => col("e", at(k))),
								[],
								false
							)
						),
						childrenName
					)
				],
				[roles],
				undefined
			)
		),
		"w",
		false
	)
	const siblings = [...parent.map((p) => col("w", p)), col("w", rootName)]
	const ranked = cte(
		rankedName,
		select(
			provedCore(
				"keyed",
				[
					...carried.map((c) => targetAs(col("w", c), c)),
					targetAs(col("w", rootName), rootName),
					targetAs(col("w", childrenName), childrenName),
					targetAs(
						drawIndex
							? {
									kind: "case",
									operand: undefined,
									whens: [{ when: col("w", rootName), result: lit.int(0n, types.bigint) }],
									else: binary(
										"-",
										over(
											"row_number",
											[],
											window(
												siblings,
												key.map((k) => col("w", k)),
												false
											)
										),
										lit.int(1n, types.bigint)
									)
								}
							: col("w", index),
						slotName
					),
					targetAs(
						{
							kind: "case",
							operand: undefined,
							whens: [{ when: col("w", rootName), result: col("w", childrenName) }],
							else: { ...countStar(), over: window(siblings, [], false) }
						},
						countName
					)
				],
				[met],
				col("w", "__self")
			)
		)
	)
	const supply = new NameSupply(freshNames)
	/** The tree's scan over its rows `where` keeps, at `position`'s rules. */
	const part = (name: string, where: Expr, drawn: ReadonlyArray<FillColumn>) =>
		scanOver(
			installation,
			supply,
			family,
			name,
			{ from: cteRefAs(rankedName, "r"), alias: "r", where },
			{
				group: mapNonEmpty(parent, (p) => col("r", p)),
				slot: col("r", slotName),
				count: col("r", countName)
			},
			[rowColumn, childrenName],
			drawn,
			reads
		)
	const parts = [
		part("__members", not(col("r", rootName)), members),
		part("__roots", col("r", rootName), roots)
	] as const
	/** The columns the scans draw that the derivation sets, each named by its place, and the count of each row's
	 * children. */
	const drawnSet = assigned.map((c, n) => ({ c, value: drawnName(n) }))
	const drawnCte = cte(
		"__drawn",
		select(
			unionAll(
				"disjoint",
				mapNonEmpty(parts, ({ scan }) =>
					provedCore(
						"keyed",
						[
							targetAs(col("s", rowColumn), rowColumn),
							targetAs(col("s", childrenName), childrenName),
							...drawnSet.map(({ c, value }) =>
								targetAs(
									col("s", defined(scannedColumn(scan.rows, c.column), `the scanned ${c.name}`)),
									value
								)
							)
						],
						[cteRefAs(scan.cte.name, "s")],
						undefined
					)
				)
			)
		)
	)
	const set: ReadonlyArray<Drawn> = [
		...(counted ? [{ column: family.count.column, value: childrenName }] : []),
		...drawnSet.map(({ c, value }) => ({ column: columnOf(c.column), value }))
	]
	if (!isNonEmpty(set)) {
		throw defect("a tree's derivation sets its count or a drawn column")
	}
	return {
		table,
		with: {
			recursive: false,
			ctes: [ranked, ...parts.flatMap(({ rows, scan }) => [rows, scan.cte]), drawnCte]
		},
		core: provedCore(
			"keyed",
			[
				targetAs(col("d", rowColumn), rowColumn),
				...set.map((d) => targetAs(col("d", d.value), d.value))
			],
			[cteRefAs("__drawn", "d")],
			undefined
		),
		set,
		reads: cellsOf(table, [
			...key,
			...owner,
			...parent,
			...(drawIndex ? [] : [index]),
			...reads.map(columnOf)
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
	const key = memberKey(input, family, relationOf(input.installation, family.member.name), added)
	const start = shape.start.column
	const end = shape.end.column
	const root = mapNonEmpty(shape.root, (r) => r.column)
	const carried = dedupeNonEmpty([rowColumn, ...key, ...root, start])
	const carry = (alias: string): ReadonlyArray<Target> =>
		carried.map((c) => targetAs(col(alias, c), c))
	const rootOf = (alias: string): ReadonlyArray<Expr> => root.map((r) => col(alias, r))
	const int = (value: bigint): Expr => lit.int(value, types.integer)
	const bound = (at: string, step: bigint): SetCore =>
		provedCore(
			"keyed",
			[
				...carry("t"),
				targetAs(col("t", at), "__at"),
				targetAs(int(step), "__step"),
				targetAs(lit.bool(step > 0n), "__opens")
			],
			[{ kind: "table", table, alias: "t" }],
			undefined
		)
	const levels = cte(
		levelsName,
		select(
			provedCore(
				"keyed",
				[
					...carry("e"),
					targetAs(col("e", "__step"), "__step"),
					targetAs(col("e", "__opens"), "__opens"),
					targetAs(
						over(
							"sum",
							[col("e", "__step")],
							window(rootOf("e"), [col("e", "__at"), col("e", "__step")], false)
						),
						"__level"
					)
				],
				[derived(select(unionAll("disjoint", [bound(start, 1n), bound(end, -1n)])), "e", false)],
				undefined
			)
		)
	)
	const role = (level: Expr, candidate: bigint): SetCore =>
		provedCore(
			"keyed",
			[
				...carry("l"),
				targetAs(level, "__level"),
				targetAs(int(candidate), "__candidate"),
				targetAs(lit.bool(candidate === 0n), "__child")
			],
			[cteRefAs(levelsName, "l")],
			col("l", "__opens")
		)
	const roles = cte(
		rolesName,
		select(
			provedCore(
				"keyed",
				[
					...carry("d"),
					targetAs(col("d", "__level"), "__level"),
					targetAs(col("d", "__candidate"), "__candidate"),
					targetAs(col("d", "__child"), "__child"),
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
						false
					)
				],
				undefined
			)
		)
	)
	const heads = cte(
		headsName,
		select(
			provedCore(
				"keyed",
				[
					targetAs(col("r", rowColumn), rowColumn),
					targetAs(col("r", "__child"), "__child"),
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
			[targetAs(col("h", rowColumn), rowColumn), targetAs(col("h", "__parent"), "__parent")],
			[cteRefAs(headsName, "h")],
			col("h", "__child")
		),
		set: [{ column: shape.parent.column, value: "__parent" }],
		reads: cellsOf(table, [...key, ...root, start, end])
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
	const set = planes.map((plane) => ({
		column: plane.end.column,
		value: col("s", columnOf(plane.after))
	}))
	if (!isNonEmpty(set)) {
		return undefined
	}
	const carried = carriedOf(set)
	return {
		table,
		with: undefined,
		core: streamed({
			table,
			targetKey: groupAt(family, "owner", "t"),
			targetWhere: undefined,
			source: table,
			sourceKey: groupAt(family, "member", "s"),
			sourceWhere: and(appendNonEmpty(nonRoot(names, family, "s"), lastOf(family, "s"))),
			values: carried.values
		}),
		set: carried.drawn,
		reads: cellsOf(table, [
			...family.group.flatMap((g) => [g.member.column, g.owner.column]),
			...set.map((d) => d.column),
			columnOf(family.shape.index),
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
const familyCells = (installation: Installation): ReadonlySet<StoredColumnKey> =>
	new Set(
		installation.laws.families.flatMap((family) =>
			[
				...cellsOf(tableOf(installation, family.member.name), [
					columnOf(family.shape.index),
					family.copy,
					...family.folds.flatMap((fold) =>
						fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after)])
					),
					...(family.shape.kind === "tree"
						? [family.shape.parent.column, family.shape.start.column, family.shape.end.column]
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
 * with the value of `to` on the row the axis names, its target. The owner axis names each member's owner and a tree's
 * row its parent, the root none, which holds the copy's base; the predecessor axis names the member at the slot before,
 * and the first slot holds the base; the last axis names an owner's last member, and an empty family holds the base.
 * The base is an accumulated field's declared start: the placeholder the copy is added under, which the backfill leaves
 * wherever the axis names no row.
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

/** A copy a stream of its two tables draws (copyDerivation): one along the owner or the last axis. A predecessor copy is
 * its family's scan's (backfillOf's `scanned`). */
type Streamed = Copy & { readonly axis: Exclude<AxisKind, "predecessor"> }

/** Whether the host fills a column: a law column, or a drawn or accumulated field. */
const hostFilled = (c: NativeColumn): boolean =>
	c.kind === "law" || c.field.writing.kind === "drawn" || c.field.writing.kind === "accumulated"

/** The copies a family's axes carry beside the columns every family draws (`families`, familyCells), in axis order. */
const copiesOf = (
	installation: Installation,
	family: Family,
	families: ReadonlySet<StoredColumnKey>
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
const baseOf = (installation: Installation, c: NativeColumn): DrawnColumn | undefined =>
	c.kind === "field" && c.field.writing.kind === "accumulated"
		? drawnOf(installation, c.field.writing.start, c.field.type)
		: undefined

/** Whether every member of a tree but its root is the row a column reference names: a tree's family leaves the root
 * out, so its last axis never names it, nor its owner axis a parent of it. */
const nonRoot = (names: OperatorNames, family: Family, alias: string): ReadonlyArray<Expr> =>
	family.shape.kind === "tree"
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

/** The columns the backfill draws on `table`, where it may hold rows: those a migration adds under their placeholders
 * and those it draws again in place (BackfilledTable). */
const drawnOn = (input: BackfillInput, table: ObjectName): ReadonlySet<string> => {
	const of = input.drawn.get(nameKey(table))
	return new Set(input.mayHoldRows(table) && of !== undefined ? [...of.added, ...of.redrawn] : [])
}

/**
 * The copies of one family the backfill draws, in the layers one derivation draws each (copyDerivation): the copies
 * along one axis that read no copy among them, then those that read only copies of a layer before them, and so on, so
 * K copies of one axis cost one drawing of its rows, the one sorted stream of both tables its derivation reads, where
 * each cost one, and a chain of copies one drawing a link. A layer's copies read no column another of its copies draws,
 * so each reads what it reads as one derivation of its own did; a copy that reads itself, a copy of itself along its
 * axis, reads itself as it stands before the backfill as it did (ordered). Copies that read each other round a cycle
 * fall in no layer and are each drawn alone, which `ordered` refuses, naming the cycle.
 */
const copyLayers = (
	copies: ReadonlyArray<Streamed>
): ReadonlyArray<NonEmptyReadonlyArray<Streamed>> => {
	const axes = new Map<Streamed["axis"], Array<Streamed>>()
	for (const c of copies) {
		axes.getOrInsertComputed(c.axis, () => []).push(c)
	}
	return [...axes.values()].flatMap((along) => {
		const layers: Array<NonEmptyReadonlyArray<Streamed>> = []
		for (let left = along; isNonEmpty(left);) {
			const drawnHere = new Set(
				left.map((c) => cellKey({ table: c.source, column: columnOf(c.from) }))
			)
			const free = left.filter((c) => {
				const reads = cellKey({ table: c.target, column: columnOf(c.to) })
				return (
					!drawnHere.has(reads) || reads === cellKey({ table: c.source, column: columnOf(c.from) })
				)
			})
			if (!isNonEmpty(free)) {
				return [...layers, ...left.map((c): NonEmptyReadonlyArray<Streamed> => [c])]
			}
			layers.push(free)
			left = left.filter((c) => !free.includes(c))
		}
		return layers
	})
}

/**
 * A layer of copies' derivation (copyLayers), one family's along the owner or the last axis: each copy's column on every
 * source row, its `to` on the row their axis names, every copy carried by the one stream of both tables; a source row
 * whose axis names none keeps its base. A member's copy along the owner axis meets its owner at the owner's key its
 * group names, a tree's parent among them, which may be drawn in the same backfill; an owner's copy along the last axis
 * meets its row at the owner's key, the last member of its family met at its group.
 */
const copyDerivation = (
	input: BackfillInput,
	layer: NonEmptyReadonlyArray<Streamed>
): Derivation => {
	const names = input.installation.names
	const [copy] = layer
	const { family } = copy
	const index = columnOf(family.shape.index)
	const values = layer.map((c) => columnOf(c.to))
	const copied = layer.map((c) => columnOf(c.from))
	const members = mapNonEmpty(family.group, (g) => g.member.column)
	const owners = family.group.map((g) => g.owner.column)
	const rooted = family.shape.kind === "tree" ? [...members, ...owners] : []
	const carried = carriedOf(
		mapNonEmpty(layer, (c) => ({ column: columnOf(c.from), value: col("s", columnOf(c.to)) }))
	)
	const along = ((): {
		readonly targetKey: NonEmptyReadonlyArray<Expr>
		readonly targetWhere: Expr | undefined
		readonly sourceKey: NonEmptyReadonlyArray<Expr>
		readonly sourceWhere: Expr | undefined
		readonly reads: ReadonlyArray<Cell>
	} => {
		switch (copy.axis) {
			case "last":
				return {
					targetKey: groupAt(family, "owner", "t"),
					targetWhere: undefined,
					sourceKey: groupAt(family, "member", "s"),
					sourceWhere: and(appendNonEmpty(nonRoot(names, family, "s"), lastOf(family, "s"))),
					reads: [
						...cellsOf(copy.source, [...owners, ...copied]),
						...cellsOf(copy.target, [...members, index, family.copy, ...rooted, ...values])
					]
				}
			case "owner":
				return {
					targetKey: groupAt(family, "member", "t"),
					targetWhere: conjunction(nonRoot(names, family, "t")),
					sourceKey: groupAt(family, "owner", "s"),
					sourceWhere: undefined,
					reads: [
						...cellsOf(copy.source, [...members, ...rooted, ...copied]),
						...cellsOf(copy.target, [...owners, ...values])
					]
				}
		}
	})()
	return {
		table: copy.source,
		with: undefined,
		core: streamed({
			table: copy.source,
			targetKey: along.targetKey,
			targetWhere: along.targetWhere,
			source: copy.target,
			sourceKey: along.sourceKey,
			sourceWhere: along.sourceWhere,
			values: carried.values
		}),
		set: carried.drawn,
		reads: along.reads
	}
}

/**
 * The copies among `copies`, a tree's along its owner axis, that its depth chains: each whose target column, read
 * through the generated fields of the parent's row, reads itself back, through the copies of the tree's it reads there
 * in turn, so each node's value is its source's over its parent's row as its own copies leave it, which no stream of the
 * stored rows draws (copyDerivation); a copy that reads another copy only on the way to the caller's columns is a layer
 * after it (copyLayers). None for any other family's.
 */
const treeChainOf = (
	installation: Installation,
	family: Family,
	copies: ReadonlyArray<Copy>
): ReadonlyArray<Copy> => {
	if (family.shape.kind !== "tree") {
		return []
	}
	const member = relationOf(installation, family.member.name)
	const along = copies.filter((c) => c.axis === "owner")
	const byColumn = new Map(along.map((c) => [columnOf(c.from), c] as const))
	/** The tree's copies a column of its row reads, through its generated fields. */
	const copiesRead = (column: string, seen: ReadonlySet<string>): ReadonlyArray<Copy> => {
		const copy = byColumn.get(column)
		if (copy !== undefined) {
			return [copy]
		}
		const field = member.fields.find((f) => f.column === column)
		return field?.writing.kind === "generated" && !seen.has(column)
			? fieldReads([field.writing.expr]).flatMap((name) =>
					copiesRead(
						defined(
							member.fields.find((f) => f.name === name),
							`the field ${name} of ${member.name}`
						).column,
						new Set([...seen, column])
					)
				)
			: []
	}
	/** Whether `copy` reads itself back through the copies its target reads. */
	const chained = (copy: Copy): boolean => {
		const seen = new Set<Copy>()
		const pending = [...copiesRead(columnOf(copy.to), new Set())]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			if (at === copy) {
				return true
			}
			if (!seen.has(at)) {
				seen.add(at)
				for (const next of copiesRead(columnOf(at.to), new Set())) {
					pending.push(next)
				}
			}
		}
		return false
	}
	return along.filter(chained)
}

/**
 * The derivation of a tree's chained copies along its owner axis (`treeChainOf`): a recursive CTE down the tree, each
 * root holding every copy's base, its start, and each child each copy's target over its parent's row, a generated
 * field by its generation over that row, the parent's chained copies as the recursion drew them and its other columns
 * as the table stores them (each a column the derivation reads, so a derivation drawing it is placed before this one).
 * A depth of the tree is a round of the recursion, each a join of the nodes it reached with their children; every copy
 * is cast to its base, and a text collated as every stored text is, so the two terms agree.
 */
const treeChainDerivation = (
	input: BackfillInput,
	family: Family,
	chain: NonEmptyReadonlyArray<Copy>
): Derivation => {
	const { installation } = input
	const names = installation.names
	const [{ source: table }] = chain
	const member = relationOf(installation, family.member.name)
	const lowering = backfillLowering(installation)
	const chained = new Map(chain.map((c, n) => [columnOf(c.from), chainName(n)] as const))
	/** The stored columns the copies' targets read over the parent's row, through its generated fields. */
	const inputs = new Set<string>()
	const gather = (column: string): void => {
		if (chained.has(column) || inputs.has(column)) {
			return
		}
		const field = member.fields.find((f) => f.column === column)
		if (field?.writing.kind === "generated") {
			for (const name of fieldReads([field.writing.expr])) {
				gather(
					defined(
						member.fields.find((f) => f.name === name),
						`the field ${name}`
					).column
				)
			}
			return
		}
		inputs.add(column)
	}
	for (const c of chain) {
		gather(columnOf(c.to))
	}
	const members = mapNonEmpty(family.group, (g) => g.member.column)
	const owners = mapNonEmpty(family.group, (g) => g.owner.column)
	const carried = dedupeNonEmpty([rowColumn, ...members, ...owners, ...inputs])
	/** A column of the parent's row at `alias`, a generated field generated over the row as the recursion holds it. */
	const parentColumn =
		(alias: string) =>
		(column: string): Expr => {
			const drawn = chained.get(column)
			if (drawn !== undefined) {
				return col(alias, drawn)
			}
			const field = member.fields.find((f) => f.column === column)
			return field?.writing.kind === "generated"
				? lowering.expression(field.writing.expr, (name) =>
						parentColumn(alias)(
							defined(
								member.fields.find((f) => f.name === name),
								`the field ${name}`
							).column
						)
					)
				: col(alias, column)
		}
	const typed = (c: Copy, expr: Expr): Expr => {
		const type = c.from.kind === "field" ? c.from.field.type : undefined
		if (type === undefined) {
			throw defect(`a tree's chained copy ${columnOf(c.from)}, an accumulated field`)
		}
		const base = baseTypeRef(names, type)
		const cast_ = cast(expr, base)
		return base.kind === "builtin" && base.name === "text"
			? { kind: "collate", expr: cast_, collation: cUtf8Collation }
			: cast_
	}
	const isRoot = (alias: string): Expr =>
		and(
			mapNonEmpty(family.group, (g) =>
				typedEq(g.owner.type, col(alias, g.member.column), col(alias, g.owner.column), names)
			)
		)
	const rows = (alias: string): ReadonlyArray<Target> =>
		carried.map((c) => targetAs(col(alias, c), c))
	const roots = provedCore(
		"keyed",
		[
			...rows("t"),
			...chain.map((c, n) => {
				const base = baseOf(installation, c.from)
				if (base === undefined) {
					throw defect(`the start of ${columnOf(c.from)}, a copy along a tree's owner axis`)
				}
				return targetAs(typed(c, base.placeholder), chainName(n))
			})
		],
		[{ kind: "table", table, alias: "t" }],
		isRoot("t")
	)
	const children = provedCore(
		"keyed",
		[
			...rows("t"),
			...chain.map((c, n) => targetAs(typed(c, parentColumn("p")(columnOf(c.to))), chainName(n)))
		],
		[
			join(
				cteRefAs(chainTable, "p"),
				{ kind: "table", table, alias: "t" },
				and([
					...mapNonEmpty(family.group, (g) =>
						typedEq(g.owner.type, col("t", g.member.column), col("p", g.owner.column), names)
					),
					not(isRoot("t"))
				])
			)
		],
		undefined
	)
	const set = mapNonEmpty(chain, (c, n) => ({ column: columnOf(c.from), value: chainName(n) }))
	return {
		table,
		with: {
			recursive: true,
			ctes: [
				cte(
					chainTable,
					namedBody(select(unionAll("disjoint", [roots, children])), [
						...carried,
						...chain.map((_, n) => chainName(n))
					])
				)
			]
		},
		core: provedCore(
			"keyed",
			[
				targetAs(col("d", rowColumn), rowColumn),
				...set.map((d) => targetAs(col("d", d.value), d.value))
			],
			[cteRefAs(chainTable, "d")],
			undefined
		),
		set,
		reads: cellsOf(table, [...members, ...owners, ...inputs])
	}
}

/** The recursive CTE of a tree's chained copies (treeChainDerivation), and the name of its `n`th copy's column. */
const chainTable = "__chain"
const chainName = (n: number): string => `__chained_${n}`

/**
 * A place's derivation (ir/instant.ts PlaceHead), ordered `by` a field: each stored row's place, `row_number() OVER
 * (PARTITION BY <group> ORDER BY <by>) - 1`, every group's rows numbered from 0 in its `by`'s order, which a key of the
 * relation within the group and `by` makes total (analysis/theory/instants.ts), and which each later insert stamps past,
 * one place a call.
 */
const placeDerivation = (place: PlaceHead, by: LawField, table: ObjectName): Derivation => {
	const value = drawnName(1)
	const group = mapNonEmpty(place.child, (f) => f.column)
	return {
		table,
		with: undefined,
		core: provedCore(
			"keyed",
			[
				targetAs(col("k", rowColumn), rowColumn),
				targetAs(
					binary(
						"-",
						over(
							"row_number",
							[],
							window(
								group.map((g) => col("k", g)),
								[col("k", by.column)],
								false
							)
						),
						lit.int(1n, types.bigint)
					),
					value
				)
			],
			[{ kind: "table", table, alias: "k" }],
			undefined
		),
		set: [{ column: place.field.column, value }],
		reads: cellsOf(table, [...group, by.column])
	}
}

/**
 * A carried column's derivation (Carry): each stored row of its table takes the value of the row of its source the
 * previous containment named, read off one sorted stream of both tables met at the previous containment's columns
 * (streamed), as a copy along an axis is.
 */
const carriedDerivation = (carry: Carry): Derivation => {
	const carried = carriedOf([{ column: carry.column, value: col("s", carry.value) }])
	return {
		table: carry.table,
		with: undefined,
		core: streamed({
			table: carry.table,
			targetKey: mapNonEmpty(carry.targetKey, (c) => col("t", c)),
			targetWhere: undefined,
			source: carry.source,
			sourceKey: mapNonEmpty(carry.sourceKey, (c) => col("s", c)),
			sourceWhere: undefined,
			values: carried.values
		}),
		set: carried.drawn,
		reads: [
			...cellsOf(carry.table, [...carry.targetKey, carry.column]),
			...cellsOf(carry.source, [...carry.sourceKey, carry.value])
		]
	}
}

/** A column of a table the backfill draws or reads. */
interface Cell {
	readonly table: ObjectName
	readonly column: string
}

/** The cells of `columns` on `table`. */
const cellsOf = (table: ObjectName, columns: ReadonlyArray<string>): ReadonlyArray<Cell> =>
	columns.map((column) => ({ table, column }))

/** A cell's key: its table's (nameKey) and its column. */
const cellKey = (c: Cell): StoredColumnKey => storedColumnKey(nameKey(c.table), c.column)

/** A cell as a refusal names it, by its table's name and its column. */
const cellName = (c: Cell): string => `${c.table.name}.${c.column}`

/** The columns a derivation draws: those it sets. */
const drawsOf = (d: Derivation): ReadonlyArray<Cell> =>
	cellsOf(
		d.table,
		d.set.map((x) => x.column)
	)

/** What a derivation draws the columns of, which a refusal names: a family, a place (ir/instant.ts PlaceHead), or a
 * column a containment carries (Carry). */
type Drawer =
	| { readonly kind: "family"; readonly family: Family }
	| { readonly kind: "place"; readonly place: PlaceHead }
	| { readonly kind: "carried"; readonly carry: Carry }

/** A derivation with what it draws the columns of (Drawer). */
interface Planned {
	readonly drawer: Drawer
	readonly derivation: Derivation
}

/** The refusal of a backfill of `drawer`'s columns, for `what`. */
const refuseDrawer = (drawer: Drawer, what: string): never => {
	switch (drawer.kind) {
		case "family":
			return refuseBackfill(drawer.family, what)
		case "place":
			throw new Refusal(
				unsupported(
					backfillLoc,
					`backfilling the place ${drawer.place.relation}.${drawer.place.field.name} added to a relation that may hold rows: ${what}`
				)
			)
		case "carried":
			throw new Refusal(
				unsupported(
					backfillLoc,
					`backfilling ${drawer.carry.table.name}.${drawer.carry.column}, which a containment carries from ${drawer.carry.source.name}.${drawer.carry.value}, added to a table that may hold rows: ${what}`
				)
			)
	}
}

/** A derivation the walk of `ordered` is placing, and the column it reads that the derivation above it draws. */
interface Placing {
	readonly at: Planned
	readonly reading: Cell
}

/**
 * The backfill's derivations in an order that places each after every derivation drawing a column it reads, otherwise
 * as drafted: a depth-first walk that places, before each derivation, the derivations drawing what it reads. A
 * derivation reading a column it draws itself is a copy of itself along its axis, which holds its base on every row, its
 * placeholder: it reads itself as it stands before the backfill (Presented). A derivation the walk reaches while
 * placing what it reads closes a cycle, each derivation of which reads a column the next draws: no order draws them,
 * and the cycle is refused, each derivation named by the columns it draws and the one it reads.
 */
const ordered = (planned: ReadonlyArray<Planned>): ReadonlyArray<Derivation> => {
	const drawer = new Map<StoredColumnKey, Planned>()
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
				return refuseDrawer(
					by.drawer,
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
 * How the backfill presents a column of a table to what reads it, a derivation or its table's UPDATE, which is how the
 * column would stand had the migration added it under its placeholder: as stored, a column no derivation draws; at a
 * row a derivation drawing it meets, as that one draws it (`drawn`); at every other row, as it stands before the
 * backfill (`before`), its placeholder. A column the migration adds holds its placeholder on every stored row, so it
 * stands before the backfill as stored; one the backfill draws again in place holds what its earlier filler drew, so
 * it stands before the backfill at its placeholder, and no stale value of it reaches a row or a reader: an owner whose
 * family is now empty reads its count's 0 and its end's identity, as a fresh column holds them. A derivation reads a
 * column it draws itself as it stands before the backfill (`ordered`).
 */
type Presented =
	| { readonly kind: "stored" }
	| { readonly kind: "before"; readonly value: Expr }
	| { readonly kind: "drawn"; readonly by: Named; readonly before: Expr }

const stored: Presented = { kind: "stored" }

/** Which rows of a table its staging holds: every row, a view a derivation reads (derivationCte); or only those whose
 * presented values differ from those they store, byte for byte in each column's base type, its UPDATE's (passes). */
type StagedRows =
	| { readonly kind: "every" }
	| { readonly kind: "changed"; readonly base: (column: string) => TypeRef }

/**
 * The rows of `table`, its tid (rowColumn) and each of `columns` under its own name, as presented (Presented). Each
 * derivation it reads is a LEFT JOIN at the row's tid, one column, so it is one join of sets of rows, hashed or merged on
 * its whole key. Its `rows` (StagedRows): every row, or those whose presented row differs from the row it stores,
 * `record_image_ne(ROW(<presented>::<base>, …), ROW(<stored>::<base>, …))`: every value it presents in its column's base
 * type, which an UPDATE assigning it writes, beside the stored one in the same, compared as PostgreSQL stores them,
 * NULL equal to NULL, so a row is held exactly when writing it would change a byte of what it stores: two numerics of
 * one value but another scale, or 0 and -0, differ, as `IS DISTINCT FROM` would not tell them.
 */
const staged = (
	table: ObjectName,
	columns: NonEmptyReadonlyArray<string>,
	presented: (column: string) => Presented,
	rows: StagedRows
): Select => {
	const drawers = [
		...new Set(
			columns.flatMap((c) => {
				const p = presented(c)
				return p.kind === "drawn" ? [p.by] : []
			})
		)
	]
	const aliasOf = (n: Named): string => `d${drawers.indexOf(n) + 1}`
	const first: FromSource = { kind: "table", table, alias: "k" }
	const steps = drawers.map((n): JoinStep => ({
		kind: "left",
		source: cteRefAs(n.name, aliasOf(n)),
		on: eq(col("k", rowColumn), col(aliasOf(n), rowColumn))
	}))
	const valueOf = (column: string): Expr => {
		const p = presented(column)
		switch (p.kind) {
			case "stored":
				return col("k", column)
			case "before":
				return p.value
			case "drawn": {
				const drawn = defined(
					p.by.derivation.set.find((d) => d.column === column),
					"the drawer of a column sets it"
				)
				return {
					kind: "case",
					operand: undefined,
					whens: [{ when: col(aliasOf(p.by), hitName), result: col(aliasOf(p.by), drawn.value) }],
					else: p.before
				}
			}
		}
	}
	const unique = dedupeNonEmpty(columns)
	const where = ((): Expr | undefined => {
		switch (rows.kind) {
			case "every":
				return undefined
			case "changed": {
				const image = (value: (column: string) => Expr): Expr => ({
					kind: "row",
					items: mapNonEmpty(unique, (c) => cast(value(c), rows.base(c)))
				})
				return call("record_image_ne", [image(valueOf), image((c) => col("k", c))])
			}
		}
	})()
	return select(
		provedCore(
			"keyed",
			[targetAs(col("k", rowColumn), rowColumn), ...unique.map((c) => targetAs(valueOf(c), c))],
			[isNonEmpty(steps) ? { kind: "joins", first, steps } : first],
			where
		)
	)
}

/**
 * A derivation's CTE: its rows, each marked `__hit`, under its own WITH, where each table its FROM reads a column of
 * that is presented other than as stored (`presented`, Presented) is read staged (a view of that WITH, staged), so every
 * column it reads holds the value the backfill presents it at: another derivation's drawn value, or its value before the
 * backfill; every other table it reads as stored. The derivations it reads are its CTE's dependencies.
 */
const derivationCte = (
	n: Named,
	presented: (cell: Cell) => Presented
): { readonly cte: Cte; readonly reads: ReadonlyArray<Named> } => {
	const { derivation } = n
	const columnsOn = new Map<NameKey, Array<string>>()
	for (const cell of derivation.reads) {
		const key = nameKey(cell.table)
		columnsOn.getOrInsertComputed(key, () => []).push(cell.column)
	}
	const views: Array<Cte> = []
	const viewOf = new Map<NameKey, string>()
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
					columns.every((column) => presented({ table, column }).kind === "stored")
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
						staged(table, columns, (column) => presented({ table, column }), { kind: "every" })
					)
				)
				return cteRefAs(name, source.alias)
			}
		}
	)
	const ctes = [...views, ...(read.with?.ctes ?? [])]
	return {
		cte: cte(n.name, {
			...read,
			with: isNonEmpty(ctes) ? { recursive: read.with?.recursive ?? false, ctes } : undefined
		}),
		reads: [
			...new Set(
				derivation.reads.flatMap((cell) => {
					const p = presented(cell)
					return p.kind === "drawn" ? [p.by] : []
				})
			)
		]
	}
}

/**
 * The backfill's UPDATEs: one of each table a derivation draws on, in the order its first derivation is placed, writing
 * every column the backfill draws on it in one write of each row whose values change:
 * `WITH <derivations> UPDATE <table> AS "t" SET <column> = "b"."<column>", … FROM <the table's changed rows staged> AS
 * "b" WHERE "t"."ctid" = "b"."ctid"`, each row met at its own tid, which PostgreSQL reads by a TID scan, a hash or a
 * merge. Its WITH holds the CTE of every derivation it reads, its own and every derivation one of them reads,
 * transitively, each after those it reads (`ordered`), but for a column an earlier UPDATE of the backfill wrote: that
 * one it reads as stored, since the earlier statement left it holding at every row what its derivation presents, and no
 * derivation behind it is drawn again. A column a later UPDATE writes it never reads as stored: it draws it itself, by
 * the same derivations. So in the order the UPDATEs run, each reads a column another writes only after that one has
 * written it, and where no table's UPDATE reads a column a later table's writes, as a chain of tables each carrying
 * what the one before it holds does, every derivation is drawn by one statement of the migration alone. Each table's
 * rows are written once, so a migration writes one new version of each row it backfills, however many of its
 * families' columns it draws.
 *
 * The UPDATE compares and writes exactly the rows whose facts change: `b` holds the rows whose drawn values differ from
 * those they store, byte for byte (staged, StagedRows changed), its comparison over the drawn columns alone and never
 * the anchor `assignments` adds to the SET list, which assigns a row its own value. Every other row already holds what
 * the UPDATE would write, so the table ends as an UPDATE of every row would leave it: a row no derivation meets of a
 * column the migration adds holds its placeholder, and a derivation that draws a row's values as it stores them, as a
 * re-draw of a definition that moves no value does on every row, leaves it as it is. What the backfill costs then is
 * its read, the derivations and their comparison, where an UPDATE of every row wrote each row's new version, its WAL
 * and an entry in every index of its table. A row the UPDATE leaves fires none of the triggers grizzle installs, which
 * is what an UPDATE of it would have fired them to: a capture logs no row whose image an UPDATE leaves as it was
 * (physical/ddl/rules.ts captured), and a foreign key's check of a row whose columns it compares are unchanged finds
 * what it found when the row was written.
 */
const passes = (
	derivations: ReadonlyArray<Derivation>,
	generationOf: (table: ObjectName) => TableGeneration,
	columns: DrawnColumns,
	carried: ReadonlyArray<Carry>,
	redrawn: ReadonlySet<StoredColumnKey>
): ReadonlyArray<Update> => {
	/** The base type of each column the backfill writes: a family's or a place's drawn column's, or a carried one's. */
	const bases = new Map<StoredColumnKey, TypeRef>([
		...[...columns].flatMap(([table, of]) =>
			[...of].map(([column, d]) => [storedColumnKey(table, column), d.base] as const)
		),
		...carried.map((c) => [cellKey({ table: c.table, column: c.column }), c.base] as const)
	])
	const named = derivations.map((derivation, i): Named => ({
		name: drawingName(i + 1),
		derivation
	}))
	const drawer = new Map<StoredColumnKey, Named>()
	for (const n of named) {
		for (const c of drawsOf(n.derivation)) {
			drawer.set(cellKey(c), n)
		}
	}
	const columnAtCell = (cell: Cell): DrawnColumn =>
		defined(
			columns.get(nameKey(cell.table))?.get(cell.column),
			`the backfill draws ${cellName(cell)}, a column a family draws`
		)
	/** `cell` as it stands before the backfill: as stored, the migration's own column, or at its placeholder, one it
	 * draws again in place. */
	const before = (cell: Cell): Expr =>
		redrawn.has(cellKey(cell)) ? columnAtCell(cell).placeholder : col("k", cell.column)
	/**
	 * `cell` as `reader` reads it (Presented), a derivation or none, the UPDATE of its table, in an UPDATE that runs after
	 * the UPDATEs of the `ran` tables: as stored where an earlier UPDATE wrote it, which left it holding what its
	 * derivation presents, at every row; otherwise as it stands, its own drawing's, or as the derivation drawing it draws.
	 */
	const presentedTo =
		(ran: ReadonlySet<NameKey>, reader: Named | undefined) =>
		(cell: Cell): Presented => {
			const by = drawer.get(cellKey(cell))
			if (by === undefined || ran.has(nameKey(by.derivation.table))) {
				return stored
			}
			if (by === reader) {
				return redrawn.has(cellKey(cell)) ? { kind: "before", value: before(cell) } : stored
			}
			return { kind: "drawn", by, before: before(cell) }
		}
	const tables = new Map<NameKey, NonEmptyReadonlyArray<Named>>()
	for (const n of named) {
		const key = nameKey(n.derivation.table)
		tables.set(key, appendNonEmpty(tables.get(key) ?? [], n))
	}
	/** The tables whose UPDATE an earlier statement of the backfill ran, whose drawn columns now stand as stored. */
	const updated = new Set<NameKey>()
	return [...tables].map(([key, own]): Update => {
		/** The tables whose UPDATE ran before this one's, as it begins. */
		const ran: ReadonlySet<NameKey> = new Set(updated)
		updated.add(key)
		const built = new Map(named.map((n) => [n, derivationCte(n, presentedTo(ran, n))] as const))
		const builtOf = (n: Named) => defined(built.get(n), "every derivation is built")
		const needed = new Set<Named>()
		const need = (n: Named): void => {
			if (!needed.has(n)) {
				needed.add(n)
				builtOf(n).reads.forEach(need)
			}
		}
		own.forEach(need)
		const [{ derivation: first }] = own
		const { table } = first
		const written = flatMapNonEmpty(own, (n) => mapNonEmpty(n.derivation.set, (d) => d.column))
		const ctes = named.filter((n) => needed.has(n)).map((n) => builtOf(n).cte)
		if (!isNonEmpty(ctes)) {
			throw defect("a table's UPDATE reads its own derivations")
		}
		const presented = presentedTo(ran, undefined)
		return {
			kind: "update",
			with: { recursive: false, ctes },
			table,
			alias: "t",
			set: assignments(
				generationOf(table),
				"t",
				mapNonEmpty(written, (column) => ({ column, value: col("b", column) }))
			),
			from: [
				derived(
					staged(table, written, (column) => presented({ table, column }), {
						kind: "changed",
						base: (column) =>
							defined(
								bases.get(cellKey({ table, column })),
								`the backfill writes ${table.name}.${column}, a column it draws`
							)
					}),
					"b",
					false
				)
			],
			where: eq(col("t", rowColumn), col("b", rowColumn)),
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
 * key, its group and its index, at which its last member is met and in whose order its scan reads each member after the
 * one before it.
 */
const familyKeys = (input: BackfillInput, family: Family): ReadonlyArray<Key> => {
	const { installation } = input
	const member = primaryKeyOf(installation, family.member.name)
	const index = columnOf(family.shape.index)
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
	const families = new Set(
		planned.flatMap((p) => (p.drawer.kind === "family" ? [p.drawer.family] : []))
	)
	for (const family of families) {
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
 * drawing a column it reads (ordered), and one UPDATE of each table they draw on (passes). A column the predecessor axis
 * carries is its family's scan's, as its fill rule is the predecessor's, whatever other axis carries it too; a column
 * the owner and last axes carry, or two families' axes, is drawn by the first in the law model's order, the owner
 * axis's before the last's; the other's foreign key, which VALIDATE proves, holds it to the same value. A family whose
 * columns are all new to tables that hold no row needs none: its placeholders are the values an empty family holds.
 */
export const backfillOf = (input: BackfillInput): Backfill => {
	const { installation } = input
	const planned: Array<Planned> = []
	const plan = (family: Family, derivation: Derivation | undefined): void => {
		if (derivation !== undefined) {
			planned.push({ drawer: { kind: "family", family }, derivation })
		}
	}
	const families = familyCells(installation)
	/** The cells of the copies the backfill draws, each by one derivation: its family's scan, or its stream. */
	const copied = new Set<StoredColumnKey>()
	/** Each family's predecessor copies, by their columns on its member: its scan's, but one an earlier family's draws. */
	const scanned = new Map<Family, ReadonlySet<string>>()
	for (const family of installation.laws.families) {
		const copies = new Set<string>()
		for (const c of copiesOf(installation, family, families)) {
			const cell = cellKey({ table: c.source, column: columnOf(c.from) })
			if (c.axis === "predecessor" && !copied.has(cell)) {
				copied.add(cell)
				copies.add(columnOf(c.from))
			}
		}
		scanned.set(family, copies)
	}
	for (const family of installation.laws.families) {
		const memberTable = tableOf(installation, family.member.name)
		const ownerTable = tableOf(installation, family.owner.name)
		const onMember = drawnOn(input, memberTable)
		const onOwner = drawnOn(input, ownerTable)
		const copies = defined(scanned.get(family), "a family's scanned copies")
		const memberColumns = new Set<string>([
			columnOf(family.shape.index),
			family.copy,
			...family.folds.flatMap((fold) =>
				fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after)])
			),
			...copies
		])
		const ownerColumns = new Set<string>([
			family.count.column,
			...family.folds.flatMap((fold) => fold.planes.map((p) => p.end.column))
		])
		const mine = new Set([...onMember].filter((c) => memberColumns.has(c)))
		const theirs = new Set([...onOwner].filter((c) => ownerColumns.has(c)))
		if (family.shape.kind === "tree") {
			const shape = family.shape
			const columns = [
				columnOf(family.shape.index),
				family.count.column,
				family.copy,
				...family.folds.flatMap((fold) =>
					fold.planes.flatMap((p) => [columnOf(p.before), columnOf(p.after), p.end.column])
				),
				...copies
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
			plan(family, treeDerivation(input, family, memberTable, onMember, copies))
			plan(family, treeEndDerivation(input.installation.names, family, memberTable, onMember))
			continue
		}
		plan(family, memberDerivation(input, family, memberTable, mine, copies))
		plan(family, ownerDerivation(input, family, ownerTable, memberTable, theirs))
	}
	for (const family of installation.laws.families) {
		const drawn = copiesOf(installation, family, families).flatMap((c): ReadonlyArray<Streamed> => {
			const cell = cellKey({ table: c.source, column: columnOf(c.from) })
			if (
				c.axis === "predecessor" ||
				copied.has(cell) ||
				!drawnOn(input, c.source).has(columnOf(c.from))
			) {
				return []
			}
			copied.add(cell)
			return [{ ...c, axis: c.axis }]
		})
		const chain = treeChainOf(installation, family, drawn)
		if (isNonEmpty(chain)) {
			plan(family, treeChainDerivation(input, family, chain))
		}
		for (const layer of copyLayers(drawn.filter((c) => !chain.includes(c)))) {
			plan(family, copyDerivation(input, layer))
		}
	}
	for (const place of installation.laws.theory.instants.places.values()) {
		const table = tableOf(installation, place.relation)
		if (place.order.kind === "by" && drawnOn(input, table).has(place.field.column)) {
			planned.push({
				drawer: { kind: "place", place },
				derivation: placeDerivation(place, place.order.field, table)
			})
		}
	}
	for (const carry of input.carried) {
		planned.push({ drawer: { kind: "carried", carry }, derivation: carriedDerivation(carry) })
	}
	const checks = keyChecks(input, planned)
	const dropDefaults = [...input.drawn.values()].flatMap(
		({ table, added }): ReadonlyArray<SqlStatement> => {
			const [first, ...rest] = added
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
	const generationOf = migrationGenerations(installation.laws, (r) => tableOf(installation, r))
	const redrawn = new Set(
		[...input.drawn.values()].flatMap(({ table, redrawn: columns }) =>
			cellsOf(table, columns).map(cellKey)
		)
	)
	const notNulls = [...Map.groupBy(input.carried, (c) => nameKey(c.table)).values()].flatMap(
		(carries): ReadonlyArray<SqlStatement> => {
			const [first, ...rest] = carries
			return first === undefined
				? []
				: [
						{
							kind: "alterTable",
							table: first.table,
							actions: mapNonEmpty([first, ...rest], (c) => ({
								kind: "setNotNull",
								column: c.column
							}))
						}
					]
		}
	)
	return {
		checks,
		updates: passes(
			ordered(planned),
			generationOf,
			drawnColumns(installation),
			input.carried,
			redrawn
		),
		dropDefaults,
		notNulls
	}
}
