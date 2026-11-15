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
 * It then reads which of them the stratum keeps (`kept`), and deletes each relation's doomed rows it does not keep, by
 * key, each DELETE a data-modifying CTE returning the facts it removed:
 *
 *   "r8" AS (DELETE FROM "s"."tag" AS "r9" USING "r5" WHERE <the key> AND NOT EXISTS (<kept>) RETURNING ...),
 *   "r10" AS (DELETE FROM "s"."doc" AS "r11" USING "r2" WHERE <the key> AND NOT EXISTS (<kept>) RETURNING ...)
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
import type { Cte, Expr } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	conjunction,
	cte,
	cteRefAs,
	exists,
	lit,
	lt,
	not,
	notExists,
	or,
	simpleSelect,
	target,
	targetAs
} from "#compiler/sql/build.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import { nestedRowsCte } from "#compiler/write/family/additions.ts"
import {
	type Access,
	atKeyset,
	type Hop,
	type KeyArm,
	keyedAt,
	type Keyset,
	keysetColumn,
	keysetOf,
	reachedRows,
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
	one,
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

/** A relation's doomed keys, and the doomed keys the stratum keeps: each a keyset of its primary key. */
interface Doomed {
	readonly doomed: Keyset
	readonly kept: Keyset
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
	const equalAt = (field: LawField, a: string, b: string, relation: RelationInfo): Expr =>
		typedEq(rowType(field), stored(a, relation, field), stored(b, relation, field), w.names)
	/** The keyset of `arms` at `access`, materialized: each is one read of the snapshot the statement starts from. */
	const keysetFrom = (access: Access, arms: NonEmptyReadonlyArray<KeyArm>): Keyset =>
		keysetOf(w, supply, ctes, access, arms, "MATERIALIZED")
	/** The arm of the stored rows at alias `t` at the keys of `keys`, narrowed by `where` over them, at their key. */
	const atKeys = (keys: Keyset, t: string, where: ReadonlyArray<Expr>): KeyArm => {
		const k = supply.relation(internal(`keys of ${keys.access.relation.name}`))
		return {
			held: { cte: keys.name, alias: k },
			hops: [atKeyset(k, keys, t)],
			where: conjunction(where),
			key: storedKey(w, { kind: "key", relation: keys.access.relation }, t)
		}
	}
	/** Whether the row under `alias` is among the keys of `keys`. */
	const among = (alias: string, keys: Keyset): Expr => {
		const k = supply.relation(internal(`among ${keys.name}`))
		return exists(simpleSelect([target(one)], [cteRefAs(keys.name, k)], keyedAt(w, k, keys, alias)))
	}
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
	/** Whether the stored row of `relation` under `alias` is equal to an added row of `read` at its every column. */
	const matches = (alias: string, read: AddedRead): Expr => {
		const n = supply.relation(internal("added row"))
		return exists(
			simpleSelect(
				[target(one)],
				[cteRefAs(read.shape.name, n)],
				and(
					mapNonEmpty(read.columns, (c) =>
						typedEq(c.type, col(alias, c.column), col(n, columnAt(read.shape, c.key)), w.names)
					)
				)
			)
		)
	}
	/** Whether the stored row of `relation` under `alias` is added again unchanged by some added rows. */
	const addedAgain = (relation: RelationInfo, alias: string): Expr | undefined => {
		const read = addedReads(relation)
		return isNonEmpty(read) ? or(mapNonEmpty(read, (r) => matches(alias, r))) : undefined
	}
	/**
	 * Whether every owner, in the unit, of the stored row of `relation` under `alias` through `family` is kept, and, for
	 * a counted family, whether its group is the stratum's whole: every stored member of it added again, every added member
	 * of it stored.
	 */
	const ownedKept = (relation: RelationInfo, alias: string, family: Family): Expr => {
		const owner = doomedOf(doomed, family.owner.name)
		const d = supply.relation(internal(`doomed owner ${family.owner.name}`))
		const kk = supply.relation(internal(`kept owner ${family.owner.name}`))
		const ownerKept = notExists(
			simpleSelect(
				[target(one)],
				[cteRefAs(owner.doomed.name, d)],
				and([
					...mapNonEmpty(family.group, (g) =>
						typedEq(
							rowType(g.owner),
							stored(alias, relation, g.member),
							col(d, keysetColumn(owner.doomed, g.owner)),
							w.names
						)
					),
					notExists(
						simpleSelect(
							[target(one)],
							[cteRefAs(owner.kept.name, kk)],
							and(
								mapNonEmpty(family.group, (g) =>
									typedEq(
										rowType(g.owner),
										col(kk, keysetColumn(owner.kept, g.owner)),
										col(d, keysetColumn(owner.doomed, g.owner)),
										w.names
									)
								)
							)
						)
					)
				])
			)
		)
		if (isSequence(family)) {
			return ownerKept
		}
		const s = supply.relation(internal(`counted group of ${relation.name}`))
		const storedChanged = notExists(
			reachedRows(
				w,
				{ kind: "group", family, alias: s, at: (g) => stored(alias, relation, g.member) },
				[not(addedAgain(relation, s) ?? lit.bool(false))]
			)
		)
		const addedUnstored = addedReads(relation).map((read) => {
			const n = supply.relation(internal(`added group of ${relation.name}`))
			const m = supply.relation(internal(`stored added of ${relation.name}`))
			const key = new Set(relation.primaryFields.map((f) => fieldKey(f.name)))
			return notExists(
				simpleSelect(
					[target(one)],
					[cteRefAs(read.shape.name, n)],
					and([
						...mapNonEmpty(family.group, (g) =>
							typedEq(
								rowType(g.member),
								stored(alias, relation, g.member),
								col(n, columnAt(read.shape, fieldKey(g.member.name))),
								w.names
							)
						),
						notExists(
							reachedRows(
								w,
								{
									kind: "key",
									relation,
									alias: m,
									at: (f) => col(n, columnAt(read.shape, fieldKey(f.name)))
								},
								read.columns
									.filter((c) => !key.has(c.key))
									.map((c) =>
										typedEq(c.type, col(m, c.column), col(n, columnAt(read.shape, c.key)), w.names)
									)
							)
						)
					])
				)
			)
		})
		return and([ownerKept, storedChanged, ...addedUnstored])
	}
	/**
	 * The doomed keys of `relation`, the rows its arms reach (`reached`); and of them the kept ones (see the header), each
	 * a materialized keyset.
	 */
	const doom = (
		relation: RelationInfo,
		tree: TreeOf | undefined,
		families: ReadonlyArray<Family>,
		reached: NonEmptyReadonlyArray<KeyArm>
	): void => {
		const doomedKeys = keysetFrom({ kind: "key", relation }, reached)
		const b = supply.relation(internal(`kept ${relation.name}`))
		const base = keysetFrom({ kind: "key", relation }, [
			atKeys(doomedKeys, b, [
				addedAgain(relation, b) ?? lit.bool(false),
				...families.map((f) => ownedKept(relation, b, f))
			])
		])
		const k = supply.relation(internal(`kept prefix of ${relation.name}`))
		const unchanged = (alias: string): Expr => among(alias, base)
		const sequence = families.find(isSequence)
		const index = sequence?.index
		const prefix: ReadonlyArray<Expr> =
			tree !== undefined
				? [treePrefix(relation, tree, k, unchanged)]
				: sequence !== undefined && index?.kind === "field"
					? [orderedPrefix(relation, sequence, index.field, k, unchanged)]
					: []
		const kept = keysetFrom({ kind: "key", relation }, [atKeys(base, k, prefix)])
		doomed.set(relation.name, { doomed: doomedKeys, kept })
	}
	/** Whether every member before the row under `alias` in its group of the ordered `family` is unchanged. */
	const orderedPrefix = (
		relation: RelationInfo,
		family: Family,
		index: LawField,
		alias: string,
		unchanged: (alias: string) => Expr
	): Expr => {
		const y = supply.relation(internal(`earlier member of ${relation.name}`))
		return notExists(
			reachedRows(
				w,
				{ kind: "group", family, alias: y, at: (g) => stored(alias, relation, g.member) },
				[lt(stored(y, relation, index), stored(alias, relation, index)), not(unchanged(y))]
			)
		)
	}
	/** The nodes of the tree of the node of `relation` under `alias`, reached at its root, under `node`. */
	const sameTree = (
		relation: RelationInfo,
		shape: TreeShape,
		alias: string,
		node: string
	): Hop => ({
		kind: "root",
		relation,
		tree: shape,
		alias: node,
		at: (f) => stored(alias, relation, f)
	})
	/**
	 * Whether every node on the path from its root to the node under `alias`, and every node before one of those among
	 * its siblings, is unchanged.
	 */
	const treePrefix = (
		relation: RelationInfo,
		{ tree, shape }: TreeOf,
		alias: string,
		unchanged: (alias: string) => Expr
	): Expr => {
		const x = supply.relation(internal(`path node of ${relation.name}`))
		const y = supply.relation(internal(`earlier sibling of ${relation.name}`))
		const index = tree.index.kind === "field" ? tree.index.field : undefined
		const earlier: ReadonlyArray<Expr> =
			index === undefined
				? []
				: [
						exists(
							reachedRows(w, sameTree(relation, shape, x, y), [
								equalAt(shape.parent, y, x, relation),
								lt(stored(y, relation, index), stored(x, relation, index)),
								not(unchanged(y))
							])
						)
					]
		return notExists(
			reachedRows(w, sameTree(relation, shape, alias, x), [
				not(lt(stored(alias, relation, shape.start), stored(x, relation, shape.start))),
				lt(stored(alias, relation, shape.start), stored(x, relation, shape.end)),
				or([not(unchanged(x)), ...earlier])
			])
		)
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
				using: [cteRefAs(found.doomed.name, k)],
				where: and([keyedAt(w, k, found.doomed, t), not(among(t, found.kept))]),
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
