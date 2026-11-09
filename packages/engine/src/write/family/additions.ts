/**
 * A stratum's family additions as one statement: every member its edits append, inserted with the values its families
 * draw, and every owner those appends recount, computed by PostgreSQL from the groups as the statement finds them, so
 * the write reads nothing back to the host and goes in the call's one flight.
 *
 * For each member relation the stratum appends to, its appended rows are the facts of its insert slot no stored row
 * repeats exactly (rule 0: no change), and each of its families draws them:
 *
 * - the groups they join, each with its kept count, the slots past its stored members, `max(index) + 1`, which the
 *   group's (group, index) key reads in one probe: a group's members hold its slots 0 … n − 1 at every statement of a
 *   write, its removals' statement (write/family/removals.ts) leaving them dense again;
 * - each group's seed, its stored member at the kept count's slot less one, which the first appended member's
 *   predecessor copies and accumulators continue;
 * - the appended members at the kept count's slots on, in key order (a counted family's order is hidden), each with
 *   its group's new count and its owner's columns, an owner no row stores copied at the copy's base, so its insert
 *   meets the family's owner axis at the statement's end, as a member naming no owner does;
 * - its scan (write/family/scan.ts), which draws each appended member's index, copy of the count, owner copies,
 *   predecessor copies and fold planes in slot order.
 *
 * The appended rows are inserted whole, each with every family's columns. Each mutable owner they join is recounted by
 * one UPDATE of its relation, where its count or an end changes: each family's count, and each end from its last
 * member, which the owner axis cascades into its stored members at the statement's end. An owner the stratum inserts
 * carries its counts and ends in its own insert, which its appends meet (write/program/bind.ts), and an immutable
 * owner's family is fixed when it is inserted, so no role holds UPDATE on it and this statement writes none.
 * Immediate foreign keys are checked at the statement's end, so a member and its owner's new count are judged together.
 *
 * The statement returns the facts it inserted and each recounted owner's count and ends after and before, each part's
 * rows behind its tag, which the outcome reads as a family statement's.
 */
import { defect, defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { baseLiteral, type Family } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
import type { LawField, NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import { typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Assignment, Cte, Expr, FromItem, JoinStep, SetArm } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	col,
	cte,
	cteRefAs,
	distinctCore,
	eq,
	exists,
	join,
	lit,
	notExists,
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
import { type PerGroup, readAt, type Scanned, type ScanRows, scanOf, type Shaped } from "#compiler/write/family/scan.ts"
import { endColumns, type RowLayout } from "#compiler/write/family/statements.ts"
import {
	columnAt,
	countOver,
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
import { returnedColumn, rowType, startOf, type WriteContext } from "#compiler/write/insert/statement.ts"

/** A member relation a stratum appends to by its insert slot, with what draws its rows. */
export interface AppendedMember {
	readonly relation: RelationInfo
	/** Every column its rows are written with (statements.ts rowLayout). */
	readonly layout: RowLayout
	/** Its insert slot, whose facts no stored row repeats exactly are appended. */
	readonly inserts: MemberSlot | undefined
	/** Its put slot, whose facts at no key a row stores are appended: a new member, or one the stratum's removals
	 * deleted from its old groups (write/family/removals.ts). */
	readonly puts: MemberSlot | undefined
	/** Its families, each drawing its appended rows by the columns its fill layout gives it at the member's position in
	 * the family, in fill order (ir/fill.ts FillLayout). */
	readonly families: NonEmptyReadonlyArray<{
		readonly family: Family
		readonly drawn: ReadonlyArray<FillColumn>
	}>
}

/** An owner relation the stratum puts, whose groups of `families`, each a family of a member the stratum edits, its
 * additions recount after the put, as the removals leave them (write/family/removals.ts). */
export interface PutOwner {
	readonly owner: RelationInfo
	readonly slot: MemberSlot
	readonly families: NonEmptyReadonlyArray<Family>
}

/** One member relation's appends, drawn: its appended rows' CTE and each family's scan of them. */
interface Drawn {
	readonly member: AppendedMember
	readonly appended: Shaped
	readonly scans: ReadonlyArray<{ readonly family: Family; readonly scan: Scanned }>
}

/**
 * The family additions of a stratum (see the header): its appended members' inserts and its mutable owners' recounts,
 * as one statement of the write's flight.
 */
export const additionsSql = (
	w: WriteContext,
	members: NonEmptyReadonlyArray<AppendedMember>,
	putOwners: ReadonlyArray<PutOwner>,
	relations: ReadonlyMap<string, RelationInfo>
): FamilyWriteSql => {
	const supply = new NameSupply(w.start)
	const params = new WriteParams()
	w.cx.beginWriteStatement(supply, params)
	const ctes: Array<Cte> = []
	const slots = slotReader(w, supply, ctes)
	const drawn = members.map((member): Drawn => {
		const appended = appendedOf(w, supply, ctes, member, slots)
		return {
			member,
			appended,
			scans: member.families.map(({ family, drawn: columns }) => ({
				family,
				scan: appendScan(w, supply, ctes, member, family, columns, appended)
			}))
		}
	})
	const returnings: Array<Returning> = drawn.map((d) => insertOf(w, supply, ctes, d))
	/** Each mutable owner relation's recounted families, each with its appends' scan and the facts of its put, by owner
	 * name. */
	const owners = new Map<string, Map<Family, Recounted>>()
	const recountedOf = (family: Family): Recounted => {
		const byFamily = owners.get(family.owner.name) ?? new Map<Family, Recounted>()
		owners.set(family.owner.name, byFamily)
		const known = byFamily.get(family)
		if (known !== undefined) {
			return known
		}
		const fresh: Recounted = { family, scans: [], puts: [] }
		byFamily.set(family, fresh)
		return fresh
	}
	for (const d of drawn) {
		for (const s of d.scans) {
			if (s.family.owner.mutable) {
				recountedOf(s.family).scans.push(s.scan)
			}
		}
	}
	for (const put of putOwners) {
		const facts = slots(put.owner.name, put.slot)
		for (const family of put.families) {
			recountedOf(family).puts.push(facts)
		}
	}
	for (const [ownerName, byFamily] of owners) {
		const [first, ...rest] = [...byFamily.values()]
		if (first !== undefined) {
			const owner = defined(relations.get(ownerName), `the owner relation ${ownerName}`)
			returnings.push(recountOf(w, supply, ctes, owner, [first, ...rest]))
		}
	}
	const [firstReturning, ...restReturnings] = returnings
	if (firstReturning === undefined) {
		throw defect("a family write that appends returns its inserts")
	}
	return taggedRows(supply, ctes, [firstReturning, ...restReturnings], params)
}

/**
 * A member relation's appended rows: its insert slot's facts no stored row repeats exactly, every field its fact carries
 * equal (rule 0 makes such an insert no change), and its put slot's facts at no key a row stores.
 */
const appendedOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	slots: SlotReader
): Shaped => {
	const name = member.relation.name
	const sources = [
		...(member.inserts === undefined ? [] : [{ kind: "inserts" as const, slot: member.inserts }]),
		...(member.puts === undefined ? [] : [{ kind: "puts" as const, slot: member.puts }])
	]
	const [firstSource] = sources
	if (firstSource === undefined) {
		throw defect(`an appended member ${name} with no insert or put slot`)
	}
	const keys = firstSource.slot.heading.map((c) => fieldKey(c.name))
	const appended = shapedCte(supply, "appended member", keys)
	const arms = sources.map((source) => {
		const facts = slots(name, source.slot)
		const a = supply.relation(internal("appended fact"))
		const s = supply.relation(internal("stored at key"))
		const compared = source.kind === "inserts" ? source.slot.heading : member.relation.primaryFields
		const [first, ...rest] = compared
		if (first === undefined) {
			throw defect(`the fields of ${name}'s slot, which holds its key`)
		}
		const stored = and(
			mapNonEmpty([first, ...rest], (c) =>
				typedEq(
					c.type,
					col(s, w.names.column(name, c.name)),
					col(a, columnAt(facts, fieldKey(c.name))),
					w.names.vectorSchema
				)
			)
		)
		return provedCore(
			"input",
			keys.map((k) => targetAs(col(a, columnAt(facts, k)), columnAt(appended, k))),
			[cteRefAs(facts.name, a)],
			notExists(simpleSelect([target(one)], [tableAs(w, name, s)], stored))
		)
	})
	const [firstArm, ...restArms] = arms
	if (firstArm === undefined) {
		throw defect(`an appended member ${name} with no slot`)
	}
	ctes.push(cte(appended.name, [...appended.columns.values()], select(unionAll("disjoint", [firstArm, ...restArms]))))
	return appended
}

/**
 * The scan of `family` over a member relation's `appended` rows (see the header): the groups they join with their
 * kept counts, their seeds, the appended rows at their slots with their owners' columns, and the scan itself, each a
 * CTE pushed onto `ctes`.
 */
const appendScan = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	family: Family,
	drawnColumns: ReadonlyArray<FillColumn>,
	appended: Shaped
): Scanned => {
	const bigint = types.bigint
	const name = member.relation.name
	const owner = family.owner
	const groupKeys = family.group.map((g) => fieldKey(g.member.name))
	const memberGroup = (alias: string, shape: Shaped): ReadonlyArray<Expr> =>
		groupKeys.map((k) => col(alias, columnAt(shape, k)))
	const index = installed(w, name, family.index)
	const storedGroup = (alias: string, keys: ReadonlyArray<Expr>): Expr =>
		and(
			mapNonEmpty(family.group, (g, i) =>
				eq(col(alias, w.names.column(name, g.member.name)), defined(keys[i], "a group key"))
			)
		)
	/** The groups the appends join, each with its kept count. */
	const groups = {
		name: supply.relation(internal("appended group")),
		group: mapNonEmpty(family.group, () => supply.column(internal("appended group key"))),
		kept: supply.column(internal("kept count"))
	}
	const g0 = supply.relation(internal("appended group row"))
	const m0 = supply.relation(internal("stored last member"))
	const g0Keys = memberGroup(g0, appended)
	ctes.push(
		cte(
			groups.name,
			[...groups.group, groups.kept],
			select(
				distinctCore(
					[
						...mapNonEmpty(groups.group, (c, i) => targetAs(defined(g0Keys[i], "a group key"), c)),
						targetAs(
							cast(
								{
									kind: "greatest",
									args: [
										lit.int(0, bigint),
										{
											kind: "subquery",
											query: simpleSelect(
												[target(binary("+", call("max", [col(m0, index)]), lit.int(1, bigint)))],
												[tableAs(w, name, m0)],
												storedGroup(m0, g0Keys)
											)
										}
									]
								},
								bigint
							),
							groups.kept
						)
					],
					[cteRefAs(appended.name, g0)],
					undefined
				)
			)
		)
	)
	/** Each group's seed: its stored member at the kept count less one, with every column a predecessor rule reads. */
	const seedReads = new Map<ColumnKey, NativeColumn>(
		drawnColumns.flatMap((c) =>
			c.rule.kind === "predecessor" ? [[columnKey(c.rule.to), c.rule.to] as const] : []
		)
	)
	const seed: PerGroup = {
		name: supply.relation(internal("seed")),
		group: mapNonEmpty(family.group, () => supply.column(internal("seed group key"))),
		columns: new Map([...seedReads.keys()].map((k) => [k, supply.column(internal("seed column"))] as const))
	}
	const g1 = supply.relation(internal("seeded group"))
	const m1 = supply.relation(internal("seed member"))
	ctes.push(
		cte(
			seed.name,
			[...seed.group, ...seed.columns.values()],
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(seed.group, (c, i) =>
							targetAs(col(g1, defined(groups.group[i], "a group column")), c)
						),
						...[...seedReads].map(([k, column]) =>
							targetAs(col(m1, installed(w, name, column)), columnAt(seed, k))
						)
					],
					[
						join(
							cteRefAs(groups.name, g1),
							tableAs(w, name, m1),
							and([
								storedGroup(
									m1,
									groups.group.map((c) => col(g1, c))
								),
								eq(col(m1, index), binary("-", col(g1, groups.kept), lit.int(1, bigint)))
							])
						)
					],
					undefined
				)
			)
		)
	)
	/** The appended rows at their slots, each with its group's first drawn slot, its new count and its owner's columns. */
	const ownerReads = new Map(
		drawnColumns.flatMap((c) =>
			c.rule.kind === "ownerCopy"
				? [[columnKey(c.rule.to), { to: c.rule.to, from: c.column, type: c.type }] as const]
				: []
		)
	)
	const rows: ScanRows = {
		name: supply.relation(internal("appended rows")),
		group: mapNonEmpty(family.group, () => supply.column(internal("row group key"))),
		slot: supply.column(internal("row slot")),
		first: supply.column(internal("row first slot")),
		count: supply.column(internal("row count")),
		columns: new Map(
			[...appended.columns.keys()].map((k) => [k, supply.column(internal("row column"))] as const)
		),
		owner: new Map(
			[...ownerReads.keys()].map((k) => [k, supply.column(internal("row owner column"))] as const)
		)
	}
	const a = supply.relation(internal("appended row"))
	const g2 = supply.relation(internal("row group"))
	const aGroup = memberGroup(a, appended)
	const aKey = member.relation.primaryFields.map((f) => col(a, columnAt(appended, fieldKey(f.name))))
	const o = supply.relation(internal("row owner"))
	const ownerAt = and(
		mapNonEmpty(family.group, (g, i) =>
			eq(col(o, w.names.column(owner.name, g.owner.name)), defined(aGroup[i], "a group key"))
		)
	)
	const ownerValue = (read: {
		readonly to: NativeColumn
		readonly from: NativeColumn
		readonly type: LawField["type"]
	}): Expr => {
		const base = defined(
			baseLiteral(family, read.from),
			`the base of ${name}'s owner copy ${columnKey(read.from)}, an accumulated column`
		)
		return {
			kind: "case",
			operand: undefined,
			whens: [
				{
					when: exists(simpleSelect([target(one)], [tableAs(w, owner.name, o)], ownerAt)),
					result: {
						kind: "subquery",
						query: simpleSelect(
							[target(cast(col(o, installed(w, owner.name, read.to)), w.cx.baseTypeRef(read.type)))],
							[tableAs(w, owner.name, o)],
							ownerAt
						)
					}
				}
			],
			else: lowerLiteral(w.names, base, read.type)
		}
	}
	const kept = col(g2, groups.kept)
	ctes.push(
		cte(
			rows.name,
			[
				...rows.group,
				rows.slot,
				rows.first,
				rows.count,
				...rows.columns.values(),
				...rows.owner.values()
			],
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(rows.group, (c, i) => targetAs(defined(aGroup[i], "a group key"), c)),
						targetAs(
							cast(
								binary("-", binary("+", kept, rowNumber(aGroup, aKey)), lit.int(1, bigint)),
								bigint
							),
							rows.slot
						),
						targetAs(kept, rows.first),
						targetAs(cast(binary("+", kept, countOver(aGroup)), bigint), rows.count),
						...[...appended.columns].map(([k, c]) => targetAs(col(a, c), columnAt(rows, k))),
						...[...ownerReads].map(([k, read]) =>
							targetAs(ownerValue(read), defined(rows.owner.get(k), "an owner column"))
						)
					],
					[
						join(
							cteRefAs(appended.name, a),
							cteRefAs(groups.name, g2),
							sameGroupExprs(aGroup, g2, groups.group)
						)
					],
					undefined
				)
			)
		)
	)
	const scan = scanOf(w, supply, { family, member: member.relation, drawn: drawnColumns, rows, seed })
	ctes.push(scan.cte)
	return scan.rows
}

/** Every field of a relation, key first, as its facts are returned. */
const keyFirstFields = (relation: RelationInfo): ReadonlyArray<LawField> => [
	...relation.primaryFields,
	...relation.heading.filter((f) => !relation.primaryFields.includes(f))
]

/**
 * The insert of a member relation's appended rows, whole: each column its families draw from their scans, each field
 * its facts carry from them, and each count and end of a family the member owns at its start, the family empty.
 */
const insertOf = (w: WriteContext, supply: NameSupply, ctes: Array<Cte>, d: Drawn): Returning => {
	const relation = d.member.relation
	const name = relation.name
	const a = supply.relation(internal("inserted fact"))
	const scans = d.scans.map((s) => ({ ...s, alias: supply.relation(internal("inserted scan")) }))
	const appendedKey = relation.primaryFields.map((f) => col(a, columnAt(d.appended, fieldKey(f.name))))
	const steps = scans.map(
		(s): JoinStep => ({
			kind: "on",
			source: cteRefAs(s.scan.name, s.alias),
			on: and(
				mapNonEmpty(relation.primaryFields, (f, i) =>
					eq(
						col(s.alias, columnAt(s.scan, fieldKey(f.name))),
						defined(appendedKey[i], "a key column")
					)
				)
			)
		})
	)
	const from: FromItem = isNonEmpty(steps)
		? { kind: "joins", first: cteRefAs(d.appended.name, a), steps }
		: cteRefAs(d.appended.name, a)
	/** The families' drawn columns, each from the scan of the family that draws it. */
	const drawnBy = new Map<ColumnKey, Expr>()
	for (const s of scans) {
		const family = defined(
			d.member.families.find((f) => f.family === s.family),
			"a scanned family"
		)
		for (const c of family.drawn) {
			drawnBy.set(columnKey(c.column), col(s.alias, columnAt(s.scan, columnKey(c.column))))
		}
	}
	const valueOf = (key: ColumnKey, field: LawField | undefined): Expr => {
		const drawnValue = drawnBy.get(key)
		if (drawnValue !== undefined) {
			return drawnValue
		}
		const own = readAt(a, d.appended)(key)
		if (own !== undefined) {
			return own
		}
		const start = field === undefined ? undefined : startOf(w.names, field)
		if (start === undefined) {
			throw defect(`the column ${key} of ${name}, which an appended row is inserted with`)
		}
		return start
	}
	const columns = [...d.member.layout.key, ...d.member.layout.columns]
	const returned = keyFirstFields(relation).map((field) => ({
		field,
		alias: supply.column(internal("inserted returned"))
	}))
	const into = supply.relation(internal("inserted table"))
	const insert = supply.relation(internal("family insert"))
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
						columns.map((c) =>
							targetAs(
								written(w, valueOf(c.key, c.column.kind === "field" ? c.column.field : undefined), c.type),
								supply.column(internal("inserted column"))
							)
						),
						[from],
						undefined
					)
				)
			},
			returning: returned.map((r) => targetAs(col(into, w.names.column(name, r.field.name)), r.alias))
		})
	)
	return {
		cte: insert,
		columns: returned.map((r) => returnedColumn(col(insert, r.alias), rowType(r.field), r.alias)),
		relation: name,
		result: insertedResult(relation),
		rows: "facts"
	}
}

/** A recounted family of an owner relation: the scans of its appends, and the facts of the owner's put. */
interface Recounted {
	readonly family: Family
	readonly scans: Array<Scanned>
	readonly puts: Array<Shaped>
}

/**
 * The recount of a mutable owner relation's groups its families' appends join, or its put names: each family's count,
 * and each end, its last member's column: an appended group's from its scan, its new count and its last appended member;
 * a put owner's other group's as the removals leave it, its kept count `max(index) + 1` and its stored last member, or
 * the end's start where it has none. One UPDATE of the relation's rows whose count or end changes, every family keeping
 * its stored values where it recounts no group of the row.
 */
const recountOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	owner: RelationInfo,
	recounted: NonEmptyReadonlyArray<Recounted>
): Returning => {
	const name = owner.name
	const bigint = types.bigint
	const lasts = mapNonEmpty(recounted, ({ family, scans, puts }) => {
		const memberName = family.member.name
		const ends = family.axes.last.filter(
			(p) => p.from.kind === "field" && p.from.field.writing.kind === "accumulated"
		)
		const last = {
			name: supply.relation(internal("last member")),
			group: mapNonEmpty(family.group, () => supply.column(internal("last group key"))),
			count: supply.column(internal("last count")),
			columns: new Map(ends.map((p) => [columnKey(p.from), supply.column(internal("last column"))] as const))
		}
		const index = installed(w, memberName, family.index)
		const arms: Array<SetArm> = scans.map((scan) => {
			const sc = supply.relation(internal("last scanned"))
			return provedCore(
				"keyed",
				[
					...mapNonEmpty(last.group, (c, i) =>
						targetAs(col(sc, defined(scan.group[i], "a scan group column")), c)
					),
					targetAs(col(sc, scan.count), last.count),
					...ends.map((p) =>
						targetAs(col(sc, columnAt(scan, columnKey(p.to))), columnAt(last, columnKey(p.from)))
					)
				],
				[cteRefAs(scan.name, sc)],
				eq(col(sc, scan.slot), binary("-", col(sc, scan.count), lit.int(1, bigint)))
			)
		})
		for (const facts of puts) {
			const p = supply.relation(internal("put owner"))
			const putKey = family.group.map((g) => col(p, columnAt(facts, fieldKey(g.owner.name))))
			const appended = scans.map((scan) => {
				const sc = supply.relation(internal("appended to"))
				return notExists(
					simpleSelect([target(one)], [cteRefAs(scan.name, sc)], sameGroupExprs(putKey, sc, scan.group))
				)
			})
			const m = supply.relation(internal("put owner's member"))
			const inGroup = (alias: string): Expr =>
				and(
					mapNonEmpty(family.group, (g, i) =>
						eq(col(alias, w.names.column(memberName, g.member.name)), defined(putKey[i], "a group key"))
					)
				)
			const m2 = supply.relation(internal("put owner's last"))
			const lastIndex: Expr = {
				kind: "subquery",
				query: simpleSelect([target(call("max", [col(m2, index)]))], [tableAs(w, memberName, m2)], inGroup(m2))
			}
			arms.push(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(last.group, (c, i) => targetAs(defined(putKey[i], "a group key"), c)),
						targetAs(cast(binary("+", col(m, index), lit.int(1, bigint)), bigint), last.count),
						...ends.map((e) =>
							targetAs(col(m, installed(w, memberName, e.to)), columnAt(last, columnKey(e.from)))
						)
					],
					[join(cteRefAs(facts.name, p), tableAs(w, memberName, m), and([inGroup(m), eq(col(m, index), lastIndex)]))],
					isNonEmpty(appended) ? and(appended) : undefined
				)
			)
			const m3 = supply.relation(internal("put owner's any member"))
			arms.push(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(last.group, (c, i) => targetAs(defined(putKey[i], "a group key"), c)),
						targetAs(lit.int(0, bigint), last.count),
						...ends.map((e) => {
							const type = defined(
								endColumns(family).find((f) => columnKey({ kind: "field", field: f }) === columnKey(e.from)),
								"an end field"
							).type
							return targetAs(
								lowerLiteral(
									w.names,
									defined(baseLiteral(family, e.from), `the start of ${name}'s end ${columnKey(e.from)}`),
									type
								),
								columnAt(last, columnKey(e.from))
							)
						})
					],
					[cteRefAs(facts.name, p)],
					and([
						notExists(simpleSelect([target(one)], [tableAs(w, memberName, m3)], inGroup(m3))),
						...appended
					])
				)
			)
		}
		const [firstArm, ...restArms] = arms
		if (firstArm === undefined) {
			throw defect(`a recount of ${name}'s family ${family.id.count} with nothing to recount`)
		}
		ctes.push(
			cte(
				last.name,
				[...last.group, last.count, ...last.columns.values()],
				select(unionAll("disjoint", [firstArm, ...restArms]))
			)
		)
		return { family, last }
	})
	const o = supply.relation(internal("recounted owner"))
	const l = supply.relation(internal("recount source"))
	const ownerKey = (family: Family): ReadonlyArray<Expr> =>
		family.group.map((g) => col(o, w.names.column(name, g.owner.name)))
	const at = (family: Family, last: PerGroup) => sameGroupExprs(ownerKey(family), l, last.group)
	const hasGroup = (family: Family, last: PerGroup): Expr =>
		exists(simpleSelect([target(one)], [cteRefAs(last.name, l)], at(family, last)))
	/** A family's recounted value of an owner column, its stored one where it recounts no group of the row. */
	const valueAt = (family: Family, last: PerGroup, column: string, stored: Expr): Expr => ({
		kind: "case",
		operand: undefined,
		whens: [
			{
				when: hasGroup(family, last),
				result: {
					kind: "subquery",
					query: simpleSelect([target(col(l, column))], [cteRefAs(last.name, l)], at(family, last))
				}
			}
		],
		else: stored
	})
	const sets: Array<Assignment> = []
	const changed: Array<Expr> = []
	for (const { family, last } of lasts) {
		const assign = (field: LawField, column: string): void => {
			const installedColumn = w.names.column(name, field.name)
			const value = written(w, valueAt(family, last, column, col(o, installedColumn)), field.type)
			sets.push({ column: installedColumn, value })
			changed.push({
				kind: "not",
				expr: typedEq(field.type, col(o, installedColumn), value, w.names.vectorSchema)
			})
		}
		assign(family.count, last.count)
		for (const [key, column] of last.columns) {
			assign(
				defined(
					endColumns(family).find((f) => fieldKey(f.name) === key),
					`the end ${key} of ${name}`
				),
				column
			)
		}
	}
	const [firstSet, ...restSets] = sets
	const [firstChange, ...restChanges] = changed
	if (firstSet === undefined || firstChange === undefined) {
		throw defect(`a recount of ${name} sets its counts`)
	}
	const fields = recountFields(
		owner,
		recounted.map((r) => r.family)
	)
	const update = supply.relation(internal("family recount"))
	const returning = updateReturning(w, supply, owner, fields, update)
	const [firstLast, ...restLasts] = lasts
	ctes.push(
		cte(update, [], {
			kind: "update",
			with: undefined,
			table: w.names.relation(name),
			alias: o,
			set: [firstSet, ...restSets],
			from: [],
			where: and([
				restLasts.length === 0
					? hasGroup(firstLast.family, firstLast.last)
					: { kind: "or", args: mapNonEmpty(lasts, (x) => hasGroup(x.family, x.last)) },
				restChanges.length === 0 ? firstChange : { kind: "or", args: [firstChange, ...restChanges] }
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
