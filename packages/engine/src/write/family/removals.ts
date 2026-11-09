/**
 * A stratum's family removals as one statement: every member its edits remove or update in place, each group they
 * touch redrawn from its least changed slot, and every owner whose count or ends they change and no later statement
 * recounts, computed by PostgreSQL from the groups as the statement finds them, so the write reads nothing back to the
 * host and goes in the call's one flight. The stratum's appends follow in its additions (write/family/additions.ts).
 *
 * For each member relation the stratum edits by puts and deletes, its stored rows at their facts' keys are:
 *
 * - removed: a delete's, and a put's that names another group in some family of the relation, which the additions
 *   insert again in its new groups: it leaves every family it is a member of;
 * - updated in place: any other put's, its caller fields the put's; its families' values are drawn again from its slot
 *   where the put changes a field one of their values reads.
 *
 * Each family draws its touched groups again from their least changed slot `s`, as the host's fill once drew them:
 *
 * - counted: the kept count is the stored count less the group's removals; each slot a removal frees below it takes
 *   the highest kept member at or above it, the freed slots ascending and those members by slot descending, and every
 *   other kept member keeps its slot; `s` is the least freed slot or slot of a changed member;
 * - ordered: the kept members from `s`, the least removed or changed slot, take the slots from `s` on in their order,
 *   re-placed, deleted and inserted again, since the family's predecessor axis is immediate.
 *
 * The drawn rows are each group's members from `s` at their final slots, each copying the group's stored count, which
 * a recount in this statement cascades into every member at its end; the seed is the member at `s − 1`; and the scan
 * (write/family/scan.ts) draws them in slot order. A group whose stratum appends to it, or whose owner the stratum puts
 * or deletes, is recounted by the additions, after the put that writes its owner, or not at all: between the two its
 * owner's count is the stored one, above every kept slot, and its closure and last axis wait for commit. Every other
 * touched group's mutable owner is recounted here: its count the kept count, each end its last member's.
 *
 * The statement deletes the removed and re-placed rows first; every insert and update reads the deletion's count, so
 * PostgreSQL finishes it before any slot it freed is taken again. Immediate foreign keys and the owner axis's cascade
 * act at the statement's end.
 */
import { readsOf, withGenerationInputs } from "#compiler/analysis/theory/fill.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { baseLiteral, type Family, isSequence } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
import type { LawField, NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import { typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Assignment, Cte, Expr, OperandSelect, SetArm } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	col,
	countStar,
	cte,
	cteRefAs,
	distinctCore,
	eq,
	exists,
	ge,
	join,
	lit,
	lt,
	not,
	notExists,
	or,
	provedCore,
	select,
	simpleSelect,
	target,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { type ColumnKey, columnKey, fieldKey } from "#compiler/write/family/fold.ts"
import { type PerGroup, type Scanned, type ScanRows, scanOf, type Shaped } from "#compiler/write/family/scan.ts"
import { endColumns, type RowLayout } from "#compiler/write/family/statements.ts"
import {
	columnAt,
	deletedResult,
	type FamilyWriteSql,
	insertedResult,
	installed,
	internal,
	one,
	recountFields,
	type Returning,
	rowNumber,
	sameGroupExprs,
	shapedCte,
	type SlotReader,
	slotReader,
	tableAs,
	taggedRows,
	updatedResult,
	updateReturning,
	written
} from "#compiler/write/family/written.ts"
import type { MemberSlot } from "#compiler/write/frontend/compile.ts"
import { returnedColumn, rowType, type WriteContext } from "#compiler/write/insert/statement.ts"

/** A member relation a stratum puts or deletes, with what draws its families again. */
export interface EditedMember {
	readonly relation: RelationInfo
	/** Every column its rows are written with (statements.ts rowLayout). */
	readonly layout: RowLayout
	readonly puts: MemberSlot | undefined
	readonly deletes: MemberSlot | undefined
	/** Its families, each with the columns its fill layout draws at the member's position in the family, in fill order,
	 * and the member's fields those values read, a put of which draws the family again from the member's slot. */
	readonly families: NonEmptyReadonlyArray<{
		readonly family: Family
		readonly drawn: ReadonlyArray<FillColumn>
		readonly inputs: ReadonlyArray<LawField>
	}>
}

/**
 * A slot of the stratum that leaves a group's recount to its additions: a member relation's inserts, each fact no stored
 * row repeats exactly, and its puts, each fact at no key a row stores in the same groups, which append to the groups
 * their group fields name; or an owner's puts and deletes, whose groups the additions recount after the put or none
 * recounts.
 */
export interface Deferring {
	readonly relation: string
	readonly slot: MemberSlot
	readonly as: "inserts" | "puts" | "owners"
}

/**
 * The member fields a family's drawn values read: its folds' step values and selections, every member column its
 * predecessor and last axes carry, and every field a generated one among them reads (analysis/theory/fill.ts
 * withGenerationInputs): a put that changes one draws the family again from the member's slot.
 */
export const familyInputs = (family: Family, relation: RelationInfo): ReadonlyArray<LawField> => {
	const named = new Set<string>()
	for (const fold of family.folds) {
		if (fold.step.kind === "value") {
			named.add(fold.step.field.name)
		}
		for (const w of fold.where) {
			for (const name of readsOf(w)) {
				named.add(name)
			}
		}
	}
	for (const pair of [...family.axes.predecessor, ...family.axes.last]) {
		if (pair.to.kind === "field") {
			named.add(pair.to.field.name)
		}
	}
	return withGenerationInputs(
		relation,
		relation.fields.filter((f) => named.has(f.name))
	).filter((f) => f.writing.kind !== "generated")
}

/** One member relation's edit, read: its puts and deletes, its stored rows at their keys, and what the edit does to them. */
interface Read {
	readonly member: EditedMember
	/** Every stored row the edit removes, with every column it holds. */
	readonly removed: Shaped
	/** Every stored row a put updates in place, with every column as the put leaves it. */
	readonly updated: Shaped
}

/** A family's redrawn groups: the touched groups with their counts and least changed slots, and its scan. */
interface Redrawn {
	readonly family: Family
	readonly member: EditedMember
	readonly groups: PerGroup & { readonly stored: string; readonly kept: string; readonly first: string }
	readonly scan: Scanned
}

/** Every column of a member relation's rows, its key first, by key. */
const layoutKeys = (layout: RowLayout): ReadonlyArray<ColumnKey> => [
	...layout.key.map((c) => c.key),
	...layout.columns.map((c) => c.key)
]

/**
 * The family removals of a stratum (see the header): its edited members' deletions, re-placements and updates in place,
 * and the recounts of its touched groups' mutable owners no later statement recounts, as one statement of the write's
 * flight.
 */
export const removalsSql = (
	w: WriteContext,
	members: NonEmptyReadonlyArray<EditedMember>,
	deferring: ReadonlyArray<Deferring>,
	relations: ReadonlyMap<string, RelationInfo>
): FamilyWriteSql => {
	const supply = new NameSupply(w.start)
	const params = new WriteParams()
	w.cx.beginWriteStatement(supply, params)
	const ctes: Array<Cte> = []
	const slots = slotReader(w, supply, ctes)
	const deferred = deferring.map((d) => ({ ...d, facts: slots(d.relation, d.slot) }))
	const reads = members.map((member) => readEdit(w, supply, ctes, member, slots))
	const redrawn = reads.flatMap((read) =>
		read.member.families.map((f) => redraw(w, supply, ctes, read, f.family, f.drawn, f.inputs))
	)
	const returnings: Array<Returning> = []
	/** The deletions every insert and update of the statement waits on. */
	const deletions: Array<string> = []
	for (const read of reads) {
		const del = deleteOf(w, supply, ctes, read, redrawn)
		deletions.push(del.cte)
		returnings.push(del)
	}
	const barrier = barrierOf(supply, ctes, deletions)
	for (const read of reads) {
		returnings.push(...writesOf(w, supply, ctes, read, redrawn, barrier))
	}
	const owners = new Map<string, Array<Redrawn>>()
	for (const r of redrawn) {
		if (!r.family.owner.mutable || isTree(r.family)) {
			continue
		}
		const list = owners.get(r.family.owner.name) ?? []
		list.push(r)
		owners.set(r.family.owner.name, list)
	}
	for (const [ownerName, list] of owners) {
		const [first, ...rest] = list
		if (first !== undefined) {
			const owner = defined(relations.get(ownerName), `the owner relation ${ownerName}`)
			returnings.push(recountOf(w, supply, ctes, owner, [first, ...rest], deferred, barrier))
		}
	}
	const [firstReturning, ...restReturnings] = returnings
	if (firstReturning === undefined) {
		throw defect("a family write that removes returns its deletions")
	}
	return taggedRows(supply, ctes, [firstReturning, ...restReturnings], params)
}

const isTree = (family: Family): boolean => family.members.kind === "tree"

/** Whether a row's group fields of every family name the stored row's groups. */
const sameGroups = (
	member: EditedMember,
	fact: (field: string) => Expr,
	stored: (field: string) => Expr
): Expr | undefined => {
	const pairs = member.families.flatMap((f) => f.family.group.map((g) => g.member.name))
	const [first, ...rest] = [...new Set(pairs)]
	return first === undefined
		? undefined
		: and(mapNonEmpty([first, ...rest], (field) => eq(fact(field), stored(field))))
}

/**
 * A member relation's edit read (see the header): its put and delete facts, its stored rows the edit removes, and its
 * stored rows its puts update in place with every column as the put leaves it.
 */
const readEdit = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: EditedMember,
	slots: SlotReader
): Read => {
	const relation = member.relation
	const name = relation.name
	const keys = layoutKeys(member.layout)
	const columnOf = (key: ColumnKey): NativeColumn =>
		defined(
			[...member.layout.key, ...member.layout.columns].find((c) => c.key === key),
			`the column ${key} of ${name}`
		).column
	const puts = member.puts === undefined ? undefined : slots(name, member.puts)
	const deletes = member.deletes === undefined ? undefined : slots(name, member.deletes)
	const keyFields = relation.primaryFields
	const at = (alias: string, facts: Shaped, s: string): Expr =>
		and(
			mapNonEmpty(keyFields, (f) =>
				eq(col(s, w.names.column(name, f.name)), col(alias, columnAt(facts, fieldKey(f.name))))
			)
		)
	const s = supply.relation(internal("edited stored row"))
	const p = supply.relation(internal("edited put"))
	const d = supply.relation(internal("edited delete"))
	const putAt = (moved: boolean): Expr | undefined => {
		if (puts === undefined) {
			return undefined
		}
		const groups = sameGroups(
			member,
			(field) => col(p, columnAt(puts, fieldKey(field))),
			(field) => col(s, w.names.column(name, field))
		)
		const where = and([at(p, puts, s), ...(groups === undefined ? [] : [moved ? not(groups) : groups])])
		return exists(simpleSelect([target(one)], [cteRefAs(puts.name, p)], where))
	}
	const moved = putAt(true)
	const removing = [
		...(deletes === undefined
			? []
			: [exists(simpleSelect([target(one)], [cteRefAs(deletes.name, d)], at(d, deletes, s)))]),
		...(moved === undefined ? [] : [moved])
	]
	const removed = shapedCte(supply, "removed member", keys)
	const storedColumns = keys.map((k) => targetAs(col(s, installed(w, name, columnOf(k))), columnAt(removed, k)))
	ctes.push(
		cte(
			removed.name,
			[...removed.columns.values()],
			select(
				provedCore(
					"keyed",
					storedColumns,
					[tableAs(w, name, s)],
					isNonEmpty(removing) ? or(removing) : lit.bool(false)
				)
			)
		)
	)
	/** The rows a put updates in place, every caller field the put's and every other column as stored. */
	const updated = shapedCte(supply, "updated member", keys)
	const s2 = supply.relation(internal("updated stored row"))
	const p2 = supply.relation(internal("updated put"))
	if (puts === undefined) {
		ctes.push(
			cte(
				updated.name,
				[...updated.columns.values()],
				select(
					provedCore(
						"keyed",
						keys.map((k) => targetAs(col(s2, installed(w, name, columnOf(k))), columnAt(updated, k))),
						[tableAs(w, name, s2)],
						lit.bool(false)
					)
				)
			)
		)
	} else {
		const groups = sameGroups(
			member,
			(field) => col(p2, columnAt(puts, fieldKey(field))),
			(field) => col(s2, w.names.column(name, field))
		)
		ctes.push(
			cte(
				updated.name,
				[...updated.columns.values()],
				select(
					provedCore(
						"keyed",
						keys.map((k) => {
							const fromPut = puts.columns.get(k)
							return targetAs(
								fromPut === undefined ? col(s2, installed(w, name, columnOf(k))) : col(p2, fromPut),
								columnAt(updated, k)
							)
						}),
						[
							join(
								tableAs(w, name, s2),
								cteRefAs(puts.name, p2),
								and([at(p2, puts, s2), ...(groups === undefined ? [] : [groups])])
							)
						],
						undefined
					)
				)
			)
		)
	}
	return { member, removed, updated }
}

/**
 * A family's touched groups drawn again (see the header): its removed and changed members' groups with their stored and
 * kept counts and least changed slots, the members from that slot at their final slots, each group's seed, and the
 * scan, each a CTE pushed onto `ctes`.
 */
const redraw = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	read: Read,
	family: Family,
	drawnColumns: ReadonlyArray<FillColumn>,
	inputs: ReadonlyArray<LawField>
): Redrawn => {
	const member = read.member
	const name = member.relation.name
	const bigint = types.bigint
	const index = installed(w, name, family.index)
	const owner = family.owner
	const keys = layoutKeys(member.layout)
	const groupOf = (alias: string, shape: Shaped): ReadonlyArray<Expr> =>
		family.group.map((g) => col(alias, columnAt(shape, fieldKey(g.member.name))))

	const indexKey = columnKey(family.index)
	const slotOf = (alias: string, shape: Shaped): Expr => col(alias, columnAt(shape, indexKey))
	/** Each removed or changed member's group and stored slot. */
	const touched = {
		name: supply.relation(internal("touched slot")),
		group: mapNonEmpty(family.group, () => supply.column(internal("touched group key"))),
		slot: supply.column(internal("touched slot")),
		removed: supply.column(internal("touched removed"))
	}
	const r0 = supply.relation(internal("removed row"))
	const u0 = supply.relation(internal("updated row"))
	const s0 = supply.relation(internal("updated stored"))
	const changes = inputs.flatMap((f) => {
		const key = fieldKey(f.name)
		const column = read.updated.columns.get(key)
		return column === undefined
			? []
			: [not(typedEq(f.type, col(u0, column), col(s0, w.names.column(name, f.name)), w.names.vectorSchema))]
	})
	const memberKeyOf = (alias: string, shape: Shaped): NonEmptyReadonlyArray<Expr> =>
		mapNonEmpty(member.relation.primaryFields, (f) => col(alias, columnAt(shape, fieldKey(f.name))))
	const storedAtKey = (stored: string, keyExprs: NonEmptyReadonlyArray<Expr>): Expr =>
		and(
			mapNonEmpty(member.relation.primaryFields, (f, i) =>
				eq(col(stored, w.names.column(name, f.name)), defined(keyExprs[i], "a key column"))
			)
		)
	ctes.push(
		cte(
			touched.name,
			[...touched.group, touched.slot, touched.removed],
			select(
				unionAll("disjoint", [
					provedCore(
						"keyed",
						[
							...mapNonEmpty(touched.group, (c, i) => targetAs(defined(groupOf(r0, read.removed)[i], "a group key"), c)),
							targetAs(slotOf(r0, read.removed), touched.slot),
							targetAs(lit.bool(true), touched.removed)
						],
						[cteRefAs(read.removed.name, r0)],
						undefined
					),
					provedCore(
						"keyed",
						[
							...mapNonEmpty(touched.group, (c, i) => targetAs(defined(groupOf(u0, read.updated)[i], "a group key"), c)),
							targetAs(slotOf(u0, read.updated), touched.slot),
							targetAs(lit.bool(false), touched.removed)
						],
						[join(cteRefAs(read.updated.name, u0), tableAs(w, name, s0), storedAtKey(s0, memberKeyOf(u0, read.updated)))],
						isNonEmpty(changes) ? or(changes) : lit.bool(false)
					)
				])
			)
		)
	)
	/** The touched groups: each one's stored count, kept count and least changed slot. */
	const groups = {
		name: supply.relation(internal("touched group")),
		group: mapNonEmpty(family.group, () => supply.column(internal("touched group column"))),
		stored: supply.column(internal("stored count")),
		kept: supply.column(internal("kept count")),
		first: supply.column(internal("first changed slot")),
		columns: new Map<ColumnKey, string>()
	}
	const t0 = supply.relation(internal("touched row"))
	const t1 = supply.relation(internal("touched in group"))
	const o0 = supply.relation(internal("touched owner"))
	const tGroup = touched.group.map((c) => col(t0, c))
	const inGroup = sameGroupExprs(tGroup, t1, touched.group)
	const removals = (where: Expr | undefined): OperandSelect =>
		simpleSelect(
			[target(countStar())],
			[cteRefAs(touched.name, t1)],
			and([inGroup, col(t1, touched.removed), ...(where === undefined ? [] : [where])])
		)
	const storedCount = col(o0, w.names.column(owner.name, family.count.name))
	const keptCount = binary("-", storedCount, { kind: "subquery", query: removals(undefined) })
	const leastOf = (where: Expr): Expr => ({
		kind: "subquery",
		query: simpleSelect([target(call("min", [col(t1, touched.slot)]))], [cteRefAs(touched.name, t1)], and([inGroup, where]))
	})
	const counted = !isSequence(family)
	const first: Expr = counted
		? {
				kind: "least",
				args: [
					leastOf(and([col(t1, touched.removed), lt(col(t1, touched.slot), keptCount)])),
					leastOf(not(col(t1, touched.removed)))
				]
			}
		: leastOf(lit.bool(true))
	ctes.push(
		cte(
			groups.name,
			[...groups.group, groups.stored, groups.kept, groups.first],
			select(
				distinctCore(
					[
						...mapNonEmpty(groups.group, (c, i) => targetAs(defined(tGroup[i], "a group key"), c)),
						targetAs(cast(storedCount, bigint), groups.stored),
						targetAs(cast(keptCount, bigint), groups.kept),
						targetAs(cast(first, bigint), groups.first)
					],
					[
						join(
							cteRefAs(touched.name, t0),
							tableAs(w, owner.name, o0),
							and(
								mapNonEmpty(family.group, (g, i) =>
									eq(col(o0, w.names.column(owner.name, g.owner.name)), defined(tGroup[i], "a group key"))
								)
							)
						)
					],
					undefined
				)
			)
		)
	)
	/** The members from each group's least changed slot at their final slots, every column as the edit leaves it. */
	const ownerReads = new Map(
		drawnColumns.flatMap((c) => (c.rule.kind === "ownerCopy" ? [[columnKey(c.rule.to), c.rule.to] as const] : []))
	)
	const rows: ScanRows = {
		name: supply.relation(internal("redrawn rows")),
		group: mapNonEmpty(family.group, () => supply.column(internal("redrawn group key"))),
		slot: supply.column(internal("redrawn slot")),
		first: supply.column(internal("redrawn first slot")),
		count: supply.column(internal("redrawn count")),
		columns: new Map(keys.map((k) => [k, supply.column(internal("redrawn column"))] as const)),
		owner: new Map([...ownerReads.keys()].map((k) => [k, supply.column(internal("redrawn owner column"))] as const))
	}
	/** A member's value of each column as the edit leaves it: the put's where it updates the member, else stored. */
	const memberColumn = (m: string, k: ColumnKey): Expr => {
		const stored = col(
			m,
			installed(
				w,
				name,
				defined([...member.layout.key, ...member.layout.columns].find((c) => c.key === k), `the column ${k}`).column
			)
		)
		const u = supply.relation(internal("put overlay"))
		const uAt = and(
			mapNonEmpty(member.relation.primaryFields, (f) =>
				eq(col(u, columnAt(read.updated, fieldKey(f.name))), col(m, w.names.column(name, f.name)))
			)
		)
		return {
			kind: "case",
			operand: undefined,
			whens: [
				{
					when: exists(simpleSelect([target(one)], [cteRefAs(read.updated.name, u)], uAt)),
					result: {
						kind: "subquery",
						query: simpleSelect([target(col(u, columnAt(read.updated, k)))], [cteRefAs(read.updated.name, u)], uAt)
					}
				}
			],
			else: stored
		}
	}
	const ownerColumn = (g: string, to: NativeColumn): Expr => {
		const o = supply.relation(internal("redrawn owner"))
		return {
			kind: "subquery",
			query: simpleSelect(
				[target(col(o, installed(w, owner.name, to)))],
				[tableAs(w, owner.name, o)],
				and(
					mapNonEmpty(family.group, (gr, i) =>
						eq(col(o, w.names.column(owner.name, gr.owner.name)), col(g, defined(groups.group[i], "a group column")))
					)
				)
			)
		}
	}
	const notRemoved = (m: string): Expr => {
		const x = supply.relation(internal("not removed"))
		return notExists(
			simpleSelect(
				[target(one)],
				[cteRefAs(read.removed.name, x)],
				and(
					mapNonEmpty(member.relation.primaryFields, (f) =>
						eq(col(x, columnAt(read.removed, fieldKey(f.name))), col(m, w.names.column(name, f.name)))
					)
				)
			)
		)
	}
	const rowTargets = (m: string, g: string, slot: Expr): ReadonlyArray<ReturnType<typeof targetAs>> => [
		...mapNonEmpty(rows.group, (c, i) => targetAs(col(g, defined(groups.group[i], "a group column")), c)),
		targetAs(cast(slot, bigint), rows.slot),
		targetAs(col(g, groups.first), rows.first),
		targetAs(col(g, groups.stored), rows.count),
		...keys.map((k) => targetAs(memberColumn(m, k), columnAt(rows, k))),
		...[...ownerReads].map(([k, to]) => targetAs(ownerColumn(g, to), defined(rows.owner.get(k), "an owner column")))
	]
	const m1 = supply.relation(internal("kept member"))
	const g1 = supply.relation(internal("kept group"))
	const memberInGroup = (m: string, g: string): Expr =>
		and(
			mapNonEmpty(family.group, (gr, i) =>
				eq(col(m, w.names.column(name, gr.member.name)), col(g, defined(groups.group[i], "a group column")))
			)
		)
	const arms: Array<SetArm> = []
	if (counted) {
		/** Every kept member at its own slot from the least changed one below the kept count. */
		arms.push(
			provedCore(
				"keyed",
				rowTargets(m1, g1, col(m1, index)),
				[join(cteRefAs(groups.name, g1), tableAs(w, name, m1), memberInGroup(m1, g1))],
				and([
					ge(col(m1, index), col(g1, groups.first)),
					lt(col(m1, index), col(g1, groups.kept)),
					notRemoved(m1)
				])
			)
		)
		/** Each kept member at or above the kept count, moved into a freed slot below it: the highest into the least. */
		const movers = {
			name: supply.relation(internal("mover")),
			group: mapNonEmpty(family.group, () => supply.column(internal("mover group key"))),
			slot: supply.column(internal("mover slot")),
			rank: supply.column(internal("mover rank")),
			key: mapNonEmpty(member.relation.primaryFields, () => supply.column(internal("mover key")))
		}
		const m2 = supply.relation(internal("moving member"))
		const g2 = supply.relation(internal("moving group"))
		const mGroup = family.group.map((gr) => col(m2, w.names.column(name, gr.member.name)))
		ctes.push(
			cte(
				movers.name,
				[...movers.group, movers.slot, movers.rank, ...movers.key],
				select(
					provedCore(
						"keyed",
						[
							...mapNonEmpty(movers.group, (c, i) => targetAs(defined(mGroup[i], "a group key"), c)),
							targetAs(col(m2, index), movers.slot),
							targetAs(rowNumber(mGroup, [binary("-", lit.int(0, bigint), col(m2, index))]), movers.rank),
							...mapNonEmpty(movers.key, (c, i) =>
								targetAs(col(m2, w.names.column(name, defined(member.relation.primaryFields[i], "a key field").name)), c)
							)
						],
						[join(cteRefAs(groups.name, g2), tableAs(w, name, m2), memberInGroup(m2, g2))],
						and([ge(col(m2, index), col(g2, groups.kept)), notRemoved(m2)])
					)
				)
			)
		)
		const freed = {
			name: supply.relation(internal("freed slot")),
			group: mapNonEmpty(family.group, () => supply.column(internal("freed group key"))),
			slot: supply.column(internal("freed slot")),
			rank: supply.column(internal("freed rank"))
		}
		const t2 = supply.relation(internal("freed touched"))
		const g3 = supply.relation(internal("freed group"))
		const fGroup = touched.group.map((c) => col(t2, c))
		ctes.push(
			cte(
				freed.name,
				[...freed.group, freed.slot, freed.rank],
				select(
					provedCore(
						"keyed",
						[
							...mapNonEmpty(freed.group, (c, i) => targetAs(defined(fGroup[i], "a group key"), c)),
							targetAs(col(t2, touched.slot), freed.slot),
							targetAs(rowNumber(fGroup, [col(t2, touched.slot)]), freed.rank)
						],
						[join(cteRefAs(touched.name, t2), cteRefAs(groups.name, g3), sameGroupExprs(fGroup, g3, groups.group))],
						and([col(t2, touched.removed), lt(col(t2, touched.slot), col(g3, groups.kept))])
					)
				)
			)
		)
		const mv = supply.relation(internal("moved"))
		const fr = supply.relation(internal("freed"))
		const g4 = supply.relation(internal("moved group"))
		const m3 = supply.relation(internal("moved member"))
		arms.push(
			provedCore(
				"keyed",
				rowTargets(m3, g4, col(fr, freed.slot)),
				[
					{
						kind: "joins",
						first: cteRefAs(movers.name, mv),
						steps: [
							{
								kind: "on",
								source: cteRefAs(freed.name, fr),
								on: and([
									sameGroupExprs(movers.group.map((c) => col(mv, c)), fr, freed.group),
									eq(col(mv, movers.rank), col(fr, freed.rank))
								])
							},
							{
								kind: "on",
								source: cteRefAs(groups.name, g4),
								on: sameGroupExprs(movers.group.map((c) => col(mv, c)), g4, groups.group)
							},
							{
								kind: "on",
								source: tableAs(w, name, m3),
								on: and(
									mapNonEmpty(member.relation.primaryFields, (f, i) =>
										eq(col(m3, w.names.column(name, f.name)), col(mv, defined(movers.key[i], "a mover key")))
									)
								)
							}
						]
					}
				],
				undefined
			)
		)
	} else {
		/** Every kept member from the least changed slot, renumbered from it in its order. */
		const mGroup = family.group.map((gr) => col(m1, w.names.column(name, gr.member.name)))
		arms.push(
			provedCore(
				"keyed",
				rowTargets(
					m1,
					g1,
					binary("-", binary("+", col(g1, groups.first), rowNumber(mGroup, [col(m1, index)])), lit.int(1, bigint))
				),
				[join(cteRefAs(groups.name, g1), tableAs(w, name, m1), memberInGroup(m1, g1))],
				and([ge(col(m1, index), col(g1, groups.first)), notRemoved(m1)])
			)
		)
	}
	const [firstArm, ...restArms] = arms
	if (firstArm === undefined) {
		throw defect("a redraw of no rows")
	}
	ctes.push(
		cte(
			rows.name,
			[...rows.group, rows.slot, rows.first, rows.count, ...rows.columns.values(), ...rows.owner.values()],
			select(unionAll("disjoint", [firstArm, ...restArms]))
		)
	)
	/** Each group's seed: its member at the slot before its least changed one, with every column a predecessor reads. */
	const seedReads = new Map<ColumnKey, NativeColumn>(
		drawnColumns.flatMap((c) => (c.rule.kind === "predecessor" ? [[columnKey(c.rule.to), c.rule.to] as const] : []))
	)
	const seed: PerGroup = {
		name: supply.relation(internal("redraw seed")),
		group: mapNonEmpty(family.group, () => supply.column(internal("redraw seed group"))),
		columns: new Map([...seedReads.keys()].map((k) => [k, supply.column(internal("redraw seed column"))] as const))
	}
	const g5 = supply.relation(internal("seeded group"))
	const m5 = supply.relation(internal("seed member"))
	ctes.push(
		cte(
			seed.name,
			[...seed.group, ...seed.columns.values()],
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(seed.group, (c, i) => targetAs(col(g5, defined(groups.group[i], "a group column")), c)),
						...[...seedReads].map(([k, column]) => targetAs(col(m5, installed(w, name, column)), columnAt(seed, k)))
					],
					[
						join(
							cteRefAs(groups.name, g5),
							tableAs(w, name, m5),
							and([
								memberInGroup(m5, g5),
								eq(col(m5, index), binary("-", col(g5, groups.first), lit.int(1, bigint)))
							])
						)
					],
					undefined
				)
			)
		)
	)
	const scan = scanOf(w, supply, { family, member: member.relation, drawn: drawnColumns, rows, seed })
	ctes.push(scan.cte)
	return { family, member, groups, scan: scan.rows }
}

/** The deletion of a member relation's removed rows and its re-placed ones, the redrawn members of its ordered family. */
const deleteOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	read: Read,
	redrawn: ReadonlyArray<Redrawn>
): Returning => {
	const relation = read.member.relation
	const name = relation.name
	const t = supply.relation(internal("deleted row"))
	const keyAt = (alias: string, shape: Shaped): Expr =>
		and(
			mapNonEmpty(relation.primaryFields, (f) =>
				eq(col(t, w.names.column(name, f.name)), col(alias, columnAt(shape, fieldKey(f.name))))
			)
		)
	const r = supply.relation(internal("deleted removed"))
	const replaced = redrawn.filter((x) => x.member === read.member && isSequence(x.family))
	const conditions: NonEmptyReadonlyArray<Expr> = [
		exists(simpleSelect([target(one)], [cteRefAs(read.removed.name, r)], keyAt(r, read.removed))),
		...replaced.map((x) => {
			const s = supply.relation(internal("deleted re-placed"))
			return exists(simpleSelect([target(one)], [cteRefAs(x.scan.name, s)], keyAt(s, x.scan)))
		})
	]
	const fields = [...relation.primaryFields, ...relation.heading.filter((f) => !relation.primaryFields.includes(f))]
	const returned = fields.map((field) => ({ field, alias: supply.column(internal("deleted returned")) }))
	const del = supply.relation(internal("family delete"))
	ctes.push(
		cte(del, [], {
			kind: "delete",
			with: undefined,
			table: w.names.relation(name),
			alias: t,
			using: [],
			where: or(conditions),
			returning: returned.map((x) => targetAs(col(t, w.names.column(name, x.field.name)), x.alias))
		})
	)
	return {
		cte: del,
		columns: returned.map((x) => returnedColumn(col(del, x.alias), rowType(x.field), x.alias)),
		relation: name,
		result: deletedResult(relation),
		rows: "facts"
	}
}

/** One row of the deletions' total count, which every insert and update of the statement joins, so PostgreSQL finishes
 * every deletion before any of them writes a row. */
const barrierOf = (supply: NameSupply, ctes: Array<Cte>, deletions: ReadonlyArray<string>): string => {
	const name = supply.relation(internal("deletions finished"))
	const column = supply.column(internal("deletions"))
	const [first, ...rest] = deletions.map((d): Expr => ({
		kind: "subquery",
		query: simpleSelect([target(countStar())], [cteRefAs(d, d)], undefined)
	}))
	if (first === undefined) {
		throw defect("a removals statement deletes")
	}
	const total = rest.reduce((a, b) => binary("+", a, b), first)
	ctes.push(cte(name, [column], select(provedCore("oneRow", [targetAs(total, column)], [], undefined))))
	return name
}

/**
 * A member relation's inserts and updates after its deletions: each re-placed row of its ordered family inserted again,
 * and each other redrawn or put-updated row updated in place where any column changes, every column from the family
 * that draws it, else the put, else stored.
 */
const writesOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	read: Read,
	redrawn: ReadonlyArray<Redrawn>,
	barrier: string
): ReadonlyArray<Returning> => {
	const member = read.member
	const relation = member.relation
	const name = relation.name
	const own = redrawn.filter((x) => x.member === member)
	const sequence = own.find((x) => isSequence(x.family))
	const keys = layoutKeys(member.layout)
	const columns = [...member.layout.key, ...member.layout.columns]
	const keyOf = (alias: string, shape: Shaped): NonEmptyReadonlyArray<Expr> =>
		mapNonEmpty(relation.primaryFields, (f) => col(alias, columnAt(shape, fieldKey(f.name))))
	/** The rows written: every redrawn member and every put-updated one, each key once. */
	const written_ = shapedCte(supply, "written member", keys)
	const sources: ReadonlyArray<Shaped> = [...own.map((x) => x.scan), read.updated]
	const keyed = sources.map((src, i) => {
		const a = supply.relation(internal("written source"))
		const earlier = sources.slice(0, i).map((e) => {
			const b = supply.relation(internal("written earlier"))
			return notExists(
				simpleSelect(
					[target(one)],
					[cteRefAs(e.name, b)],
					and(mapNonEmpty(keyOf(b, e), (x, j) => eq(x, defined(keyOf(a, src)[j], "a key"))))
				)
			)
		})
		return provedCore(
			"keyed",
			keys.map((k) => targetAs(col(a, columnAt(src, k)), columnAt(written_, k))),
			[cteRefAs(src.name, a)],
			isNonEmpty(earlier) ? and(earlier) : undefined
		)
	})
	const [firstKeyed, ...restKeyed] = keyed
	if (firstKeyed === undefined) {
		throw defect("a member's writes read its updates")
	}
	ctes.push(cte(written_.name, [...written_.columns.values()], select(unionAll("disjoint", [firstKeyed, ...restKeyed]))))
	/** A written row's final value of a column: the scan of the family that draws it where it redrew the row, else the
	 * row's own as the edit leaves it. */
	const finalOf = (a: string, key: ColumnKey): Expr => {
		const drawer = own.find((x) => {
			const family = defined(member.families.find((f) => f.family === x.family), "a redrawn family")
			return family.drawn.some((c) => columnKey(c.column) === key)
		})
		const ownValue = col(a, columnAt(written_, key))
		if (drawer === undefined) {
			return ownValue
		}
		const s = supply.relation(internal("final drawn"))
		const at = and(mapNonEmpty(keyOf(s, drawer.scan), (x, j) => eq(x, defined(keyOf(a, written_)[j], "a key"))))
		return {
			kind: "case",
			operand: undefined,
			whens: [
				{
					when: exists(simpleSelect([target(one)], [cteRefAs(drawer.scan.name, s)], at)),
					result: { kind: "subquery", query: simpleSelect([target(col(s, columnAt(drawer.scan, key)))], [cteRefAs(drawer.scan.name, s)], at) }
				}
			],
			else: ownValue
		}
	}
	const out: Array<Returning> = []
	const isReplaced = (a: string): Expr => {
		if (sequence === undefined) {
			return lit.bool(false)
		}
		const s = supply.relation(internal("re-placed"))
		return exists(
			simpleSelect(
				[target(one)],
				[cteRefAs(sequence.scan.name, s)],
				and(mapNonEmpty(keyOf(s, sequence.scan), (x, j) => eq(x, defined(keyOf(a, written_)[j], "a key"))))
			)
		)
	}
	const b = supply.relation(internal("after deletions"))
	if (sequence !== undefined) {
		const a = supply.relation(internal("re-inserted row"))
		const fields = [...relation.primaryFields, ...relation.heading.filter((f) => !relation.primaryFields.includes(f))]
		const returned = fields.map((field) => ({ field, alias: supply.column(internal("re-inserted returned")) }))
		const into = supply.relation(internal("re-inserted table"))
		const insert = supply.relation(internal("family re-insert"))
		ctes.push(
			cte(insert, [], {
				kind: "insert",
				with: undefined,
				table: w.names.relation(name),
				alias: into,
				overriding: undefined,
				onConflict: undefined,
				columns: columns.map((c) => installed(w, name, c.column)),
				source: {
					kind: "query",
					query: select(
						provedCore(
							"keyed",
							columns.map((c) => targetAs(written(w, finalOf(a, c.key), c.type), supply.column(internal("re-inserted column")))),
							[{ kind: "joins", first: cteRefAs(written_.name, a), steps: [{ kind: "cross", source: cteRefAs(barrier, b) }] }],
							isReplaced(a)
						)
					)
				},
				returning: returned.map((x) => targetAs(col(into, w.names.column(name, x.field.name)), x.alias))
			})
		)
		out.push({
			cte: insert,
			columns: returned.map((x) => returnedColumn(col(insert, x.alias), rowType(x.field), x.alias)),
			relation: name,
			result: insertedResult(relation),
			rows: "facts"
		})
	}
	const settable = member.layout.columns.filter((c) => c.settable || c.copy)
	const [firstSettable, ...restSettable] = settable
	if (firstSettable !== undefined) {
		const t = supply.relation(internal("updated table"))
		const a = supply.relation(internal("updated row"))
		const set = mapNonEmpty([firstSettable, ...restSettable], (c): Assignment => ({
			column: installed(w, name, c.column),
			value: written(w, finalOf(a, c.key), c.type)
		}))
		const changed = mapNonEmpty([firstSettable, ...restSettable], (c) =>
			not(typedEq(c.type, col(t, installed(w, name, c.column)), written(w, finalOf(a, c.key), c.type), w.names.vectorSchema))
		)
		const fields = [...relation.primaryFields, ...relation.heading.filter((f) => !relation.primaryFields.includes(f))]
		const [firstField, ...restFields] = fields
		if (firstField === undefined) {
			throw defect(`the fields of ${name}`)
		}
		const update = supply.relation(internal("family update"))
		const returning = updateReturning(w, supply, relation, [firstField, ...restFields], update)
		ctes.push(
			cte(update, [], {
				kind: "update",
				with: undefined,
				table: w.names.relation(name),
				alias: t,
				set,
				from: [{ kind: "joins", first: cteRefAs(written_.name, a), steps: [{ kind: "cross", source: cteRefAs(barrier, b) }] }],
				where: and([
					...mapNonEmpty(relation.primaryFields, (f) =>
						eq(col(t, w.names.column(name, f.name)), col(a, columnAt(written_, fieldKey(f.name))))
					),
					not(isReplaced(a)),
					or(changed)
				]),
				returning: returning.returning
			})
		)
		out.push({
			cte: update,
			columns: returning.columns,
			relation: name,
			result: updatedResult(relation, [firstField, ...restFields]),
			rows: "facts"
		})
	}
	return out
}

/**
 * The recount of a mutable owner relation's touched groups no later statement recounts (see the header): each
 * family's count, the kept count, and each end, its last member's column at the kept count less one, the scan's where
 * it redrew that slot, else the stored member's, else the end's start for an empty family; one UPDATE of the owner rows
 * whose count or an end changes.
 */
const recountOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	owner: RelationInfo,
	list: NonEmptyReadonlyArray<Redrawn>,
	deferred: ReadonlyArray<Deferring & { readonly facts: Shaped }>,
	barrier: string
): Returning => {
	const name = owner.name
	const bigint = types.bigint
	const lasts = mapNonEmpty(list, (r) => {
		const family = r.family
		const memberName = r.member.relation.name
		const ends = family.axes.last.filter((p) => p.from.kind === "field" && p.from.field.writing.kind === "accumulated")
		const last = {
			name: supply.relation(internal("recount last")),
			group: mapNonEmpty(family.group, () => supply.column(internal("recount group"))),
			count: supply.column(internal("recount count")),
			columns: new Map(ends.map((p) => [columnKey(p.from), supply.column(internal("recount end"))] as const))
		}
		const g = supply.relation(internal("recount group row"))
		const groupTargets = (alias: string) =>
			mapNonEmpty(last.group, (c, i) => targetAs(col(alias, defined(r.groups.group[i], "a group column")), c))
		/** Whether the stratum leaves this group's recount to its additions. */
		const deferredHere = deferred.flatMap((d) => {
			const x = supply.relation(internal("deferring fact"))
			const y = supply.relation(internal("deferring stored"))
			const memberKeyAt = and(
				mapNonEmpty(r.member.relation.primaryFields, (f) =>
					eq(col(y, w.names.column(memberName, f.name)), col(x, columnAt(d.facts, fieldKey(f.name))))
				)
			)
			const appending = (fields: ReadonlyArray<string>): Expr => {
				const [first, ...rest] = fields
				return first === undefined
					? notExists(simpleSelect([target(one)], [tableAs(w, memberName, y)], memberKeyAt))
					: notExists(
							simpleSelect(
								[target(one)],
								[tableAs(w, memberName, y)],
								and([
									memberKeyAt,
									...mapNonEmpty([first, ...rest], (field) =>
										eq(col(y, w.names.column(memberName, field)), col(x, columnAt(d.facts, fieldKey(field))))
									)
								])
							)
						)
			}
			const groupFields = [
				...new Set(r.member.families.flatMap((f) => f.family.group.map((gr) => gr.member.name)))
			]
			switch (d.as) {
				case "inserts":
				case "puts": {
					if (d.relation !== memberName) {
						return []
					}
					const keys = family.group.map((gr) => col(x, columnAt(d.facts, fieldKey(gr.member.name))))
					return [
						exists(
							simpleSelect(
								[target(one)],
								[cteRefAs(d.facts.name, x)],
								and([
									sameGroupExprs(keys, g, r.groups.group),
									appending(
										d.as === "inserts" ? d.slot.heading.map((c) => c.name) : groupFields
									)
								])
							)
						)
					]
				}
				case "owners": {
					if (d.relation !== owner.name) {
						return []
					}
					const keys = family.group.map((gr) => col(x, columnAt(d.facts, fieldKey(gr.owner.name))))
					return [
						exists(simpleSelect([target(one)], [cteRefAs(d.facts.name, x)], sameGroupExprs(keys, g, r.groups.group)))
					]
				}
			}
		})
		const here = isNonEmpty(deferredHere) ? not(or(deferredHere)) : lit.bool(true)
		const s = supply.relation(internal("recount scanned"))
		const m = supply.relation(internal("recount stored last"))
		const memberInGroup = and(
			mapNonEmpty(family.group, (gr, i) =>
				eq(col(m, w.names.column(memberName, gr.member.name)), col(g, defined(r.groups.group[i], "a group column")))
			)
		)
		const indexColumn = installed(w, memberName, family.index)
		const arms: NonEmptyReadonlyArray<SetArm> = [
			provedCore(
				"keyed",
				[
					...groupTargets(g),
					targetAs(col(g, r.groups.kept), last.count),
					...ends.map((p) => targetAs(col(s, columnAt(r.scan, columnKey(p.to))), columnAt(last, columnKey(p.from))))
				],
				[
					join(
						cteRefAs(r.groups.name, g),
						cteRefAs(r.scan.name, s),
						and([
							sameGroupExprs(r.scan.group.map((c) => col(s, c)), g, r.groups.group),
							eq(col(s, r.scan.slot), binary("-", col(g, r.groups.kept), lit.int(1, bigint)))
						])
					)
				],
				here
			),
			provedCore(
				"keyed",
				[
					...groupTargets(g),
					targetAs(col(g, r.groups.kept), last.count),
					...ends.map((p) => targetAs(col(m, installed(w, memberName, p.to)), columnAt(last, columnKey(p.from))))
				],
				[
					join(
						cteRefAs(r.groups.name, g),
						tableAs(w, memberName, m),
						and([memberInGroup, eq(col(m, indexColumn), binary("-", col(g, r.groups.kept), lit.int(1, bigint)))])
					)
				],
				and([
					here,
					not({
						kind: "isTrue",
						expr: ge(binary("-", col(g, r.groups.kept), lit.int(1, bigint)), col(g, r.groups.first))
					})
				])
			),
			provedCore(
				"keyed",
				[
					...groupTargets(g),
					targetAs(col(g, r.groups.kept), last.count),
					...ends.map((p) => {
						const base = defined(baseLiteral(family, p.from), `the start of ${name}'s end ${columnKey(p.from)}`)
						const type = defined(
							endColumns(family).find((f) => columnKey({ kind: "field", field: f }) === columnKey(p.from)),
							"an end field"
						).type
						return targetAs(lowerLiteral(w.names, base, type), columnAt(last, columnKey(p.from)))
					})
				],
				[cteRefAs(r.groups.name, g)],
				and([here, eq(col(g, r.groups.kept), lit.int(0, bigint))])
			)
		]
		ctes.push(cte(last.name, [...last.group, last.count, ...last.columns.values()], select(unionAll("disjoint", arms))))
		return { family, last }
	})
	const o = supply.relation(internal("recounted owner"))
	const l = supply.relation(internal("recount source"))
	const ownerKey = (family: Family): ReadonlyArray<Expr> =>
		family.group.map((gr) => col(o, w.names.column(name, gr.owner.name)))
	const at = (family: Family, last: PerGroup) => sameGroupExprs(ownerKey(family), l, last.group)
	const hasGroup = (family: Family, last: PerGroup): Expr =>
		exists(simpleSelect([target(one)], [cteRefAs(last.name, l)], at(family, last)))
	const recounted = (family: Family, last: PerGroup, column: string, stored: Expr): Expr => ({
		kind: "case",
		operand: undefined,
		whens: [
			{
				when: hasGroup(family, last),
				result: { kind: "subquery", query: simpleSelect([target(col(l, column))], [cteRefAs(last.name, l)], at(family, last)) }
			}
		],
		else: stored
	})
	const sets: Array<Assignment> = []
	const changed: Array<Expr> = []
	for (const { family, last } of lasts) {
		const assign = (field: LawField, column: string): void => {
			const installedColumn = w.names.column(name, field.name)
			const value = written(w, recounted(family, last, column, col(o, installedColumn)), field.type)
			sets.push({ column: installedColumn, value })
			changed.push(not(typedEq(field.type, col(o, installedColumn), value, w.names.vectorSchema)))
		}
		assign(family.count, last.count)
		for (const [key, column] of last.columns) {
			assign(defined(endColumns(family).find((f) => fieldKey(f.name) === key), `the end ${key} of ${name}`), column)
		}
	}
	const [firstSet, ...restSets] = sets
	const [firstChange, ...restChanges] = changed
	if (firstSet === undefined || firstChange === undefined) {
		throw defect(`a recount of ${name} sets its counts`)
	}
	const fields = recountFields(
		owner,
		list.map((r) => r.family)
	)
	const update = supply.relation(internal("family recount"))
	const returning = updateReturning(w, supply, owner, fields, update)
	const b = supply.relation(internal("recount after deletions"))
	ctes.push(
		cte(update, [], {
			kind: "update",
			with: undefined,
			table: w.names.relation(name),
			alias: o,
			set: [firstSet, ...restSets],
			from: [cteRefAs(barrier, b)],
			where: and([
				or(mapNonEmpty(lasts, (x) => hasGroup(x.family, x.last))),
				restChanges.length === 0 ? firstChange : or([firstChange, ...restChanges])
			]),
			returning: returning.returning
		})
	)
	return {
		cte: update,
		columns: returning.columns,
		relation: name,
		result: updatedResult(owner, fields),
		rows: "counts"
	}
}
