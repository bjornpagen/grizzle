/**
 * A stratum's deletes of whole units as one statement. A delete of a relation that is a tree, or that owns a family and
 * is no family's member, names units: a tree by its root fields, an owner by its facts. Each unit is the named rows and
 * every row nested under them through the families: each member of a removed row's group, transitively, a tree's node
 * taking its whole tree. A unit goes whole, so no count, index, fold end or tree interval describes a partial group.
 *
 * The statement reads every doomed key first, top-down over the families, each a materialized keyset of one snapshot
 * (write/family/keyset.ts): a unit root's from its stated rows at its primary key, or a tree's at its root; a member's
 * as one keyed join per family that reaches it, from that family's owner's doomed keys into the member's rows at their
 * group, then, for a tree's relation, into the whole tree of each node reached at its root, the joins one UNION:
 *
 *   WITH "r1"("c1") AS (<the stated rows>),
 *   "r2"("c2") AS MATERIALIZED (SELECT DISTINCT "r4"."id" FROM "r1" AS "r3" JOIN "s"."doc" AS "r4"
 *                               ON "r4"."id" = "r3"."c1"),
 *   "r5"("c3", "c4") AS MATERIALIZED (SELECT DISTINCT "r7"."doc", "r7"."name" FROM "r2" AS "r6"
 *                                     JOIN "s"."tag" AS "r7" ON "r7"."doc" = "r6"."c2"),
 *
 * so no read of a stored table is a condition over every row of it, which PostgreSQL plans as a sequential scan, a
 * member of two families included: an OR of an EXISTS per family can drive no index. Every other read of a stored
 * table, of the kept rows and of the groups and trees they are judged by, is a keyed read too, at a key, a group or a
 * root the statement binds.
 *
 * It then reads which of them the stratum keeps, and deletes each relation's doomed rows it does not keep, its removed
 * keys, by key, each DELETE a data-modifying CTE returning the facts it removed:
 *
 *   "r8" AS (DELETE FROM "s"."tag" AS "r9" USING <tag's removed keys> WHERE <the key> RETURNING ...),
 *   "r10" AS (DELETE FROM "s"."doc" AS "r11" USING <doc's removed keys> WHERE <the key> RETURNING ...)
 *   SELECT <each deletion's facts behind its tag>
 *
 * A doomed row is kept, its row never written, where the stratum adds it again unchanged and what it references stays:
 * - it is equal to a row the stratum adds of its relation at every column the addition states (`AddedRows`): a nested
 *   write's rows at every column its walk draws, hidden counts, indexes and accumulators among them; an insert's facts at
 *   every field they carry, an owner's counts and ends among them;
 * - every owner of it in the unit is kept, and for a member of a counted family, its group is the stratum's whole: every
 *   stored member of it is added again, and every added member of it is stored, so its hidden slots are one valid
 *   placement of the same set;
 * - for a sequence's member, every member before it in its group is kept, and for a tree's node, every node on its path
 *   from its root and every node before one of those among its siblings, since the predecessor and owner axes are
 *   immediate between this statement and the inserts after it.
 * The stratum's inserts then meet each kept row as an exact repeat, which writes nothing, so a unit added again
 * identically is never written, and a changed one is written only from its first changed row on.
 *
 * Each rule is one set computation over the relation's rows, linear in them, never a read per row of its group, its
 * earlier members, its path or its siblings: the stored rows added again unchanged are found from the added rows, at
 * their keys; a group a kept row cannot be in, of an owner removed, a stored member changed or an added member stored
 * nowhere, is a keyset of owner keys whose members a keyed hop reaches; the base of kept rows, the doomed rows added
 * again outside every such group, and the removed rows are each one GROUP BY over keysets (write/family/keyset.ts
 * keysetWhere); and a sequence's or a tree's prefix is a window over the rows of the groups or trees concerned, each
 * flagged where it is in the base (`orderedKept`, `treeKept`). A relation the stratum adds nothing of keeps nothing.
 *
 * Every SELECT reads the snapshot the statement starts from, so a removed owner still finds its members, and PostgreSQL
 * checks every immediate foreign key at the statement's end, when no member of a removed group remains. The stratum's
 * schedule runs it before every other statement of its stratum (write/frontend/schedule.ts), so it reads the state
 * before the stratum, as every member does, and an insert of the stratum at a removed key meets no stored row there.
 * The outcome nets its removals against the stratum's additions by fact (runtime/write/net.ts), so the counts are the
 * difference of the two states.
 *
 * The chain of doomed keys over generic edges, a member's columns equal to an owner's key, is the shape of a retirement's
 * deletion of a sealed group's bodies.
 */
import { defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { rowEq, typedEq } from "#compiler/ir/compare.ts"
import { type Family, isSequence, type TreeShape } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import { type ColumnKey, fieldKey } from "#compiler/runtime/write/fill.ts"
import type { Cte, Expr, Select } from "#compiler/sql/ast.ts"
import {
	asc,
	call,
	col,
	conjunction,
	cte,
	cteRefAs,
	derived,
	le,
	not,
	notExists,
	provedCore,
	select,
	target,
	targetAs,
	windowOf
} from "#compiler/sql/build.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import { nestedRowsCte } from "#compiler/write/family/additions.ts"
import {
	type Access,
	atKeyset,
	type Flagged,
	flaggedKeys,
	type Hop,
	type KeyArm,
	keyedAt,
	type Keyset,
	keysetColumn,
	keysetOf,
	keysetWhere,
	reachedRows,
	reachFrom,
	storedKey
} from "#compiler/write/family/keyset.ts"
import type { Shaped } from "#compiler/write/family/scan.ts"
import type { RowLayout } from "#compiler/write/family/statements.ts"
import {
	columnAt,
	deletedResult,
	type FamilyReturning,
	type FamilyWriteSql,
	installed,
	internal,
	slotReader,
	taggedRows
} from "#compiler/write/family/written.ts"
import type { MemberSlot } from "#compiler/write/frontend/compile.ts"
import { readInput, type RelationInput, unproved } from "#compiler/write/insert/input.ts"
import {
	keyFirst,
	returnedColumn,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"

/** Where a unit delete's rows come from: an enumerated slot's facts, or a described source of the write DAG. */
export type UnitSource =
	| { readonly kind: "slot"; readonly input: RelationInput }
	| { readonly kind: "described"; readonly node: RelNode }

/**
 * How a unit delete's rows name its root relation's rows: a tree's by its root fields (`tree`, its family, whose shape
 * its relation's primary key leads with), an owner's by its facts, every field they state, its primary key among them.
 */
export type UnitMatch =
	| { readonly kind: "tree"; readonly tree: Family; readonly shape: TreeShape }
	| { readonly kind: "facts"; readonly fields: NonEmptyReadonlyArray<LawField> }

/**
 * A relation below a unit's root: its rows go where they are members of a removed row of the owner of one of
 * `families`, each family's owner above it in the unit; a tree's relation (`tree`, its own tree) with the whole tree of
 * each such node.
 */
export interface UnitMember {
	readonly relation: RelationInfo
	readonly families: NonEmptyReadonlyArray<Family>
	readonly tree: Family | undefined
}

/** A delete of one relation's units in a stratum: its rows by `match` from `source`. The relations below every unit
 * root of a stratum are its unit removal's, judged together. */
export interface UnitDelete {
	readonly relation: RelationInfo
	readonly match: UnitMatch
	readonly source: UnitSource
}

/**
 * Rows the stratum adds of a unit's relation, which a doomed row equal to one of them at every column it states is kept
 * as (see the header): a member slot's facts at every field of its heading, or the rows a nested write's walk fills
 * (runtime/write/nesting.ts sentLayout) at every column of the layout it sends.
 */
export type AddedRows =
	| { readonly kind: "slot"; readonly slot: MemberSlot }
	| { readonly kind: "nestedRows"; readonly stratum: StratumAt; readonly layout: RowLayout }

/** The fields a unit delete's rows state: a tree's root fields, or an owner's compared fields. */
const matchFields = (match: UnitMatch): NonEmptyReadonlyArray<LawField> =>
	match.kind === "tree" ? match.shape.root : match.fields

/** A relation's doomed keys, and the doomed keys the stratum removes, those it does not keep: each a keyset of its primary
 * key. */
interface Doomed {
	readonly doomed: Keyset
	readonly removed: Keyset
}

/** One source of the rows the stratum adds of a relation, read: its CTE and each column it states, by its key, with the
 * stored column and type it is compared at. */
interface AddedRead {
	readonly shape: Shaped
	readonly columns: NonEmptyReadonlyArray<{
		readonly key: ColumnKey
		readonly column: string
		readonly type: ScalarType
	}>
}

/** A tree's prefix the kept rows of its relation need unchanged: its family and the shape its nodes are drawn by. */
interface TreeOf {
	readonly tree: Family
	readonly shape: TreeShape
}

/** The shape of a tree's family, which its member's tree is: its root fields, its drawn parent, start and end. */
const treeOf = (tree: Family | undefined): TreeOf | undefined =>
	tree?.members.kind === "tree" ? { tree, shape: tree.members } : undefined

/** The statement of a stratum's unit deletes (see the header): `added` gives each relation's rows the stratum adds. */
export const unitSql = (
	w: WriteContext,
	units: NonEmptyReadonlyArray<UnitDelete>,
	below: ReadonlyArray<UnitMember>,
	added: (relation: RelationInfo) => ReadonlyArray<AddedRows>
): FamilyWriteSql => {
	const supply = new NameSupply(w.start)
	const params = new WriteParams()
	w.cx.beginWriteStatement(supply, params)
	const ctes: Array<Cte> = []
	const slots = slotReader(w, supply, ctes)
	const doomed = new Map<string, Doomed>()
	const stored = (alias: string, relation: RelationInfo, field: LawField): Expr =>
		col(alias, w.names.column(relation.name, field.name))
	/** The keyset of `arms` at `access`, materialized: each is one read of the snapshot the statement starts from. */
	const keysetFrom = (access: Access, arms: NonEmptyReadonlyArray<KeyArm>): Keyset =>
		keysetOf(w, supply, ctes, access, arms, "MATERIALIZED")
	/** Each relation's added rows, read once. */
	const reads = new Map<string, ReadonlyArray<AddedRead>>()
	const addedReads = (relation: RelationInfo): ReadonlyArray<AddedRead> => {
		const known = reads.get(relation.name)
		if (known !== undefined) {
			return known
		}
		const read = added(relation).flatMap((rows): ReadonlyArray<AddedRead> => {
			if (rows.kind === "slot") {
				const shape = slots(relation.name, rows.slot)
				const columns = rows.slot.heading.map((c) => ({
					key: fieldKey(c.name),
					column: w.names.column(relation.name, c.name),
					type: c.type
				}))
				return isNonEmpty(columns) ? [{ shape, columns }] : []
			}
			const shape = nestedRowsCte(w, supply, ctes, relation, rows)
			const columns = [...rows.layout.key, ...rows.layout.columns].map((c) => ({
				key: c.key,
				column: installed(w, relation.name, c.column),
				type: c.type
			}))
			return isNonEmpty(columns) ? [{ shape, columns }] : []
		})
		reads.set(relation.name, read)
		return read
	}
	/** The stored row of `relation` under alias `m` at the key of the added row of `read` under alias `n`. */
	const atAdded = (relation: RelationInfo, read: AddedRead, n: string, m: string): Hop => ({
		kind: "key",
		relation,
		alias: m,
		at: (f) => col(n, columnAt(read.shape, fieldKey(f.name)))
	})
	/** Whether the stored row under alias `m` equals the added row of `read` under alias `n` at every column the read states
	 * beside the key, which the hop to it binds. */
	const sameAsAdded = (
		relation: RelationInfo,
		read: AddedRead,
		n: string,
		m: string
	): ReadonlyArray<Expr> => {
		const key = new Set(relation.primaryFields.map((f) => fieldKey(f.name)))
		return read.columns
			.filter((c) => !key.has(c.key))
			.map((c) => typedEq(c.type, col(m, c.column), col(n, columnAt(read.shape, c.key)), w.names))
	}
	/** The keys of `relation`'s stored rows the stratum adds again unchanged: each added row's stored row at its key, equal
	 * to it at every column its read states. */
	const againOf = (relation: RelationInfo, adds: NonEmptyReadonlyArray<AddedRead>): Keyset =>
		keysetFrom(
			{ kind: "key", relation },
			mapNonEmpty(adds, (read): KeyArm => {
				const n = supply.relation(internal(`added row of ${relation.name}`))
				const m = supply.relation(internal(`stored again of ${relation.name}`))
				return {
					held: { cte: read.shape.name, alias: n },
					hops: [atAdded(relation, read, n, m)],
					where: conjunction(sameAsAdded(relation, read, n, m)),
					key: storedKey(w, { kind: "key", relation }, m)
				}
			})
		)
	/** The member field of `family` that names the owner's primary field `field`. */
	const memberOf = (family: Family, field: LawField): LawField =>
		defined(
			family.group.find((g) => g.owner.name === field.name),
			`the member field of ${family.member.name} naming ${family.owner.name}.${field.name}`
		).member
	/** The owner key each row of `family`'s member under alias `alias` names, its group fields read through `at`. */
	const ownerKeyOf = (family: Family, at: (field: LawField) => Expr): NonEmptyReadonlyArray<Expr> =>
		mapNonEmpty(family.owner.primaryFields, (f) => at(memberOf(family, f)))
	/** The groups of `family` the rows of `keys`, rows of its member `relation`, are in: a keyset at the owner's key. */
	const groupsOf = (relation: RelationInfo, family: Family, keys: Keyset): Keyset => {
		const k = supply.relation(internal(`grouped keys of ${relation.name}`))
		const s = supply.relation(internal(`grouped row of ${relation.name}`))
		return keysetFrom({ kind: "key", relation: family.owner }, [
			{
				held: { cte: keys.name, alias: k },
				hops: [atKeyset(k, keys, s)],
				where: undefined,
				key: ownerKeyOf(family, (f) => stored(s, relation, f))
			}
		])
	}
	/** The arm of the stored members of `family`, rows of `relation`, in each group `groups` holds, at their key. */
	const membersOf = (relation: RelationInfo, family: Family, groups: Keyset): KeyArm => {
		const k = supply.relation(internal(`member group of ${relation.name}`))
		const m = supply.relation(internal(`group member of ${relation.name}`))
		return {
			held: { cte: groups.name, alias: k },
			hops: [{ kind: "group", family, alias: m, at: (g) => col(k, keysetColumn(groups, g.owner)) }],
			where: undefined,
			key: storedKey(w, { kind: "key", relation }, m)
		}
	}
	/**
	 * The groups of `family`, a family whose member is `relation`, none of whose rows the stratum keeps (see the header):
	 * each owner the unit removes; and, for a counted family, each group of a doomed row a stored member of which is not
	 * added again unchanged, and each group an added member of which is stored nowhere unchanged. A keyset at the owner's
	 * key.
	 */
	const excludedGroups = (
		relation: RelationInfo,
		family: Family,
		doomedKeys: Keyset,
		again: Keyset,
		adds: NonEmptyReadonlyArray<AddedRead>
	): Keyset => {
		const owner = doomedOf(doomed, family.owner.name)
		if (isSequence(family)) {
			return owner.removed
		}
		const members = keysetFrom({ kind: "key", relation }, [
			membersOf(relation, family, groupsOf(relation, family, doomedKeys))
		])
		const changed = keysetWhere(supply, ctes, { all: [members], none: [again] }, "MATERIALIZED")
		const r = supply.relation(internal(`removed owner ${family.owner.name}`))
		const c = supply.relation(internal(`changed member of ${relation.name}`))
		const s = supply.relation(internal(`changed row of ${relation.name}`))
		return keysetFrom({ kind: "key", relation: family.owner }, [
			{
				held: { cte: owner.removed.name, alias: r },
				hops: [],
				where: undefined,
				key: mapNonEmpty(owner.removed.columns, (column) => col(r, column))
			},
			{
				held: { cte: changed.name, alias: c },
				hops: [atKeyset(c, changed, s)],
				where: undefined,
				key: ownerKeyOf(family, (f) => stored(s, relation, f))
			},
			...mapNonEmpty(adds, (read): KeyArm => {
				const n = supply.relation(internal(`added member of ${relation.name}`))
				const m = supply.relation(internal(`stored added of ${relation.name}`))
				return {
					held: { cte: read.shape.name, alias: n },
					hops: [],
					where: notExists(
						reachedRows(w, atAdded(relation, read, n, m), sameAsAdded(relation, read, n, m))
					),
					key: ownerKeyOf(family, (f) => col(n, columnAt(read.shape, fieldKey(f.name))))
				}
			})
		])
	}
	/** A keyset of `relation`'s keys selected by `query`, whose targets are its primary fields in order, materialized. */
	const keysetSelected = (
		relation: RelationInfo,
		columns: NonEmptyReadonlyArray<string>,
		query: Select
	): Keyset => {
		const name = supply.relation(internal(`kept ${relation.name}`))
		ctes.push({ ...cte(name, [...columns], query), materialized: "MATERIALIZED" })
		return { name, access: { kind: "key", relation }, columns }
	}
	/**
	 * The keys of the rows of `flagged`, rows of `relation` each flagged where it is in the stratum's base of rows it
	 * would keep, at which `broken`, a window over them read with their stored rows (`s`), is false: `SELECT <key> FROM
	 * (SELECT <key>, <broken> FROM <flagged> AS f JOIN <relation> AS s ON <key>) AS o WHERE NOT o.<broken>`.
	 */
	const unbroken = (
		relation: RelationInfo,
		flagged: Flagged,
		broken: (inBase: Expr, s: string) => Expr
	): Keyset => {
		const f = supply.relation(internal(`flagged row of ${relation.name}`))
		const s = supply.relation(internal(`judged row of ${relation.name}`))
		const o = supply.relation(internal(`broken row of ${relation.name}`))
		const keys = mapNonEmpty(relation.primaryFields, () => supply.column(internal("kept key")))
		const at = supply.column(internal("broken"))
		const inner = select(
			provedCore(
				"keyed",
				[
					...mapNonEmpty(storedKey(w, { kind: "key", relation }, s), (e, i) =>
						targetAs(e, defined(keys[i], "a kept key"))
					),
					targetAs(broken(col(f, flagged.flag), s), at)
				],
				[reachFrom(w, { held: { cte: flagged.name, alias: f }, hops: [atKeyset(f, flagged, s)] })],
				undefined
			)
		)
		return keysetSelected(
			relation,
			mapNonEmpty(keys, () => supply.column(internal("kept key"))),
			select(
				provedCore(
					"keyed",
					keys.map((c) => target(col(o, c))),
					[derived(inner, o, [...keys, at], false)],
					not(col(o, at))
				)
			)
		)
	}
	/** `<aggregate>(<value>) OVER (PARTITION BY <partition> ORDER BY <order>)`, its default frame the rows up to the
	 * current one and its peers. */
	const over = (
		aggregate: "bool_or" | "max",
		value: Expr,
		partition: ReadonlyArray<Expr>,
		order: ReadonlyArray<Expr>
	): Expr => ({ ...call(aggregate, [value]), over: windowOf(partition, order.map(asc)) })
	/**
	 * The rows of `base` each member before which in its group of the ordered `family` is in `base` too: a window over
	 * the members of their groups in index order, a member broken where it or one before it is not in `base`.
	 */
	const orderedKept = (
		relation: RelationInfo,
		family: Family,
		index: LawField,
		base: Keyset
	): Keyset => {
		const touched = keysetFrom({ kind: "key", relation }, [
			membersOf(relation, family, groupsOf(relation, family, base))
		])
		return unbroken(relation, flaggedKeys(supply, ctes, touched, base), (inBase, s) =>
			over(
				"bool_or",
				not(inBase),
				family.group.map((g) => stored(s, relation, g.member)),
				[stored(s, relation, index)]
			)
		)
	}
	/**
	 * The nodes of `base`, doomed nodes of the trees `doomedKeys` holds whole, each node on whose path from its root, and
	 * each node before one of those among its siblings, is in `base` too. Two windows over the doomed nodes: a node is
	 * locally broken where it or a sibling before it (by index, then start) is not in `base`; a node is broken where it
	 * lies in the interval [start, end) of a locally broken node, an ancestor or itself, which the running maximum, in
	 * pre-order, of each node's end where it is locally broken and its start elsewhere finds past the node's start. The
	 * root's parent is its own start, 0, as its first child's is, and orders before that child by start, so a changed
	 * first child breaks no root.
	 */
	const treeKept = (
		relation: RelationInfo,
		{ tree, shape }: TreeOf,
		doomedKeys: Keyset,
		base: Keyset
	): Keyset => {
		const index = tree.index.kind === "field" ? tree.index.field : undefined
		const flagged = flaggedKeys(supply, ctes, doomedKeys, base)
		const f = supply.relation(internal(`flagged node of ${relation.name}`))
		const x = supply.relation(internal(`judged node of ${relation.name}`))
		const n = supply.relation(internal(`locally broken node of ${relation.name}`))
		const o = supply.relation(internal(`broken node of ${relation.name}`))
		const keys = mapNonEmpty(relation.primaryFields, () => supply.column(internal("kept key")))
		const roots = mapNonEmpty(shape.root, () => supply.column(internal("kept root")))
		const start = supply.column(internal("kept start"))
		const end = supply.column(internal("kept end"))
		const local = supply.column(internal("locally broken"))
		const reach = supply.column(internal("broken reach"))
		const inBase = col(f, flagged.flag)
		const rootOf = (alias: string) => shape.root.map((r) => stored(alias, relation, r))
		const locally = select(
			provedCore(
				"keyed",
				[
					...mapNonEmpty(storedKey(w, { kind: "key", relation }, x), (e, i) =>
						targetAs(e, defined(keys[i], "a kept key"))
					),
					...mapNonEmpty(shape.root, (r, i) =>
						targetAs(stored(x, relation, r), defined(roots[i], "a kept root"))
					),
					targetAs(stored(x, relation, shape.start), start),
					targetAs(stored(x, relation, shape.end), end),
					targetAs(
						index === undefined
							? not(inBase)
							: over(
									"bool_or",
									not(inBase),
									[...rootOf(x), stored(x, relation, shape.parent)],
									[stored(x, relation, index), stored(x, relation, shape.start)]
								),
						local
					)
				],
				[reachFrom(w, { held: { cte: flagged.name, alias: f }, hops: [atKeyset(f, flagged, x)] })],
				undefined
			)
		)
		const reached = select(
			provedCore(
				"keyed",
				[
					...keys.map((c) => targetAs(col(n, c), c)),
					targetAs(col(n, start), start),
					targetAs(
						over(
							"max",
							{
								kind: "case",
								operand: undefined,
								whens: [{ when: col(n, local), result: col(n, end) }],
								else: col(n, start)
							},
							roots.map((c) => col(n, c)),
							[col(n, start)]
						),
						reach
					)
				],
				[derived(locally, n, [...keys, ...roots, start, end, local], false)],
				undefined
			)
		)
		return keysetSelected(
			relation,
			mapNonEmpty(keys, () => supply.column(internal("kept key"))),
			select(
				provedCore(
					"keyed",
					keys.map((c) => target(col(o, c))),
					[derived(reached, o, [...keys, start, reach], false)],
					le(col(o, reach), col(o, start))
				)
			)
		)
	}
	/**
	 * The doomed keys of `relation`, the rows its arms reach (`reached`); and of them the ones the stratum removes, those
	 * it does not keep (see the header), each a materialized keyset. The kept rows are the doomed rows added again
	 * unchanged outside every excluded group of a family whose member `relation` is (`excludedGroups`), less, for a tree's
	 * relation or an ordered family's member, those behind a row not so kept (`treeKept`, `orderedKept`), each set relation
	 * one GROUP BY over keysets and never a join of two (keyset.ts keysetWhere).
	 */
	const doom = (
		relation: RelationInfo,
		tree: TreeOf | undefined,
		families: ReadonlyArray<Family>,
		reached: NonEmptyReadonlyArray<KeyArm>
	): void => {
		const doomedKeys = keysetFrom({ kind: "key", relation }, reached)
		const adds = addedReads(relation)
		if (!isNonEmpty(adds)) {
			doomed.set(relation.name, { doomed: doomedKeys, removed: doomedKeys })
			return
		}
		const again = againOf(relation, adds)
		const excluded = families.map((family) =>
			membersOf(relation, family, excludedGroups(relation, family, doomedKeys, again, adds))
		)
		const base = keysetWhere(
			supply,
			ctes,
			{
				all: [doomedKeys, again],
				none: isNonEmpty(excluded) ? [keysetFrom({ kind: "key", relation }, excluded)] : []
			},
			"MATERIALIZED"
		)
		const sequence = families.find(isSequence)
		const index = sequence?.index
		const kept =
			tree !== undefined
				? treeKept(relation, tree, doomedKeys, base)
				: sequence !== undefined && index?.kind === "field"
					? orderedKept(relation, sequence, index.field, base)
					: base
		doomed.set(relation.name, {
			doomed: doomedKeys,
			removed: keysetWhere(supply, ctes, { all: [doomedKeys], none: [kept] }, "MATERIALIZED")
		})
	}
	for (const unit of units) {
		const fields = matchFields(unit.match)
		const scan = supply.relation(internal("unit source scan"))
		const sourceKeys = fieldColumns(fields, () => supply.column(internal("unit source column")))
		const read = readInput(
			w,
			unit.source.kind === "slot"
				? unit.source.input
				: { kind: "described", node: unit.source.node, proof: unproved },
			{ kind: "input", fields, alias: scan, keys: sourceKeys, into: { as: "compare" } },
			`delete ${unit.relation.name}`
		)
		const source = supply.relation(internal("unit source"))
		ctes.push(cte(source, sourceKeys.columns, read.select))
		const s = supply.relation(internal("unit source row"))
		const t = supply.relation(internal(`doomed ${unit.relation.name}`))
		const at = (f: LawField): Expr => col(s, sourceKeys.of(f))
		const held = { cte: source, alias: s }
		const key = storedKey(w, { kind: "key", relation: unit.relation }, t)
		const match = unit.match
		switch (match.kind) {
			case "tree":
				doom(
					unit.relation,
					match,
					[],
					[
						{
							held,
							hops: [{ kind: "root", relation: unit.relation, tree: match.shape, alias: t, at }],
							where: undefined,
							key
						}
					]
				)
				break
			case "facts": {
				const rest = match.fields.filter((f) => !unit.relation.primaryFields.includes(f))
				doom(
					unit.relation,
					undefined,
					[],
					[
						{
							held,
							hops: [{ kind: "key", relation: unit.relation, alias: t, at }],
							where: isNonEmpty(rest)
								? rowEq(
										{
											fields: rest,
											typeOf: rowType,
											left: (f) => stored(t, unit.relation, f),
											right: at
										},
										w.names
									)
								: undefined,
							key
						}
					]
				)
				break
			}
		}
	}
	for (const member of below) {
		const tree = treeOf(member.tree)
		const reached = mapNonEmpty(member.families, (family): KeyArm => {
			const owner = doomedOf(doomed, family.owner.name).doomed
			const k = supply.relation(internal(`doomed owner ${family.owner.name}`))
			const m = supply.relation(internal(`doomed member of ${member.relation.name}`))
			return {
				held: { cte: owner.name, alias: k },
				hops: [
					{ kind: "group", family, alias: m, at: (g) => col(k, keysetColumn(owner, g.owner)) }
				],
				where: undefined,
				key: storedKey(
					w,
					tree === undefined
						? { kind: "key", relation: member.relation }
						: { kind: "root", relation: member.relation, tree: tree.shape },
					m
				)
			}
		})
		if (tree === undefined) {
			doom(member.relation, undefined, member.families, reached)
		} else {
			const roots = keysetFrom(
				{ kind: "root", relation: member.relation, tree: tree.shape },
				reached
			)
			const r = supply.relation(internal(`doomed root of ${member.relation.name}`))
			const t = supply.relation(internal(`doomed tree of ${member.relation.name}`))
			doom(member.relation, tree, member.families, [
				{
					held: { cte: roots.name, alias: r },
					hops: [atKeyset(r, roots, t)],
					where: undefined,
					key: storedKey(w, { kind: "key", relation: member.relation }, t)
				}
			])
		}
	}
	const returnings = mapNonEmpty(unitRelations(units, below), (relation): FamilyReturning => {
		const found = doomedOf(doomed, relation.name)
		const t = supply.relation(internal(`unit delete ${relation.name}`))
		const k = supply.relation(internal("unit delete key"))
		const returned = keyFirst(relation).map((field) => ({
			field,
			alias: supply.column(internal("unit deleted returned"))
		}))
		const del = supply.relation(internal("unit delete"))
		ctes.push(
			cte(del, [], {
				kind: "delete",
				with: undefined,
				table: w.names.relation(relation.name),
				alias: t,
				using: [cteRefAs(found.removed.name, k)],
				where: keyedAt(w, k, found.removed, t),
				returning: returned.map((x) => targetAs(stored(t, relation, x.field), x.alias))
			})
		)
		return {
			cte: del,
			columns: returned.map((x) => returnedColumn(col(del, x.alias), rowType(x.field), x.alias)),
			relation: relation.name,
			result: deletedResult(relation),
			rows: "facts"
		}
	})
	return taggedRows(supply, ctes, returnings, params, [])
}

/** Every relation a stratum's unit deletes remove rows of: each root, then the relations below them, in order. */
export const unitRelations = (
	units: NonEmptyReadonlyArray<UnitDelete>,
	below: ReadonlyArray<UnitMember>
): NonEmptyReadonlyArray<RelationInfo> => {
	const [first, ...rest] = units
	return [first.relation, ...rest.map((u) => u.relation), ...below.map((m) => m.relation)]
}

/** The doomed keys a relation above a member pushed, which the unit's order put first. */
const doomedOf = (doomed: ReadonlyMap<string, Doomed>, relation: string): Doomed =>
	defined(
		doomed.get(relation),
		`the doomed keys of ${relation}, an owner above its members in the unit`
	)
