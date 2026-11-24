/**
 * What every family write statement shares (write/family/additions.ts, write/family/removals.ts): the parts its rows
 * are read as, each part's rows behind its tag; the facts a member slot carries, read from its arrays; and the small
 * builders of the SQL the two write in common.
 */
import { maxOf } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { factFieldEq, type OperatorNames, typedEq } from "#compiler/ir/compare.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
import {
	type LawField,
	type NativeColumn,
	type RelationInfo,
	type ColumnKey,
	columnKey,
	columnKeyOf
} from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	arraysSource,
	relationColumns,
	unchecked,
	type WriteParams
} from "#compiler/lower/conservative/context.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import type {
	Assignment,
	Cte,
	EmittedSql,
	Expr,
	FromItem,
	FromSource,
	Select,
	SetArm
} from "#compiler/sql/ast.ts"
import {
	and,
	arrays,
	asc,
	binary,
	call,
	cast,
	col,
	conjunction,
	core,
	countStar,
	cte,
	cteRef,
	cteRefAs,
	lit,
	not,
	operandSelect,
	or,
	provedCore,
	select,
	table,
	target,
	targetAs,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { assignments } from "#compiler/sql/generation.ts"
import { namedBody, type NameSupply } from "#compiler/sql/naming.ts"
import {
	type GroupState,
	type PerGroup,
	type ScanRows,
	type Scanned,
	scanOf,
	type Shaped,
	writeLowering
} from "#compiler/write/family/scan.ts"
import { endColumns } from "#compiler/write/family/statements.ts"
import type { MemberSlot } from "#compiler/write/frontend/compile.ts"
import {
	type DeleteResult,
	type InsertResult,
	keyFirst,
	type ReturnedColumn,
	returnedColumn,
	returnedRows,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"
import { bound, probeKey } from "#compiler/write/probe.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

/** An update's rows: each fact after the update and before, a put's update's result. */
export type UpdateResult = Extract<PutResult, { readonly kind: "update" }>

/** One part of a family write's rows: the relation its rows are facts of, what they mean, and how many columns they hold
 * behind their tag. */
export interface FamilyPart {
	readonly relation: StoredRelationName
	readonly result: InsertResult | DeleteResult | UpdateResult
	/** Whether its rows are facts of its relation, or owners' keys, counts and ends alone, a recount's. */
	readonly rows: "facts" | "counts"
	readonly width: number
}

/** A family write as one statement: its AST and text, its placeholders, its rows' parts, in tag order, and the
 * data-modifying CTE each part's rows are read from, a read-back riding the statement reads its delta from
 * (write/program/compile.ts ridingFamily), and the width every arm is padded to. */
export interface FamilyWriteSql {
	readonly ast: Select
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly parts: NonEmptyReadonlyArray<FamilyPart>
	readonly returnings: NonEmptyReadonlyArray<FamilyReturning>
	readonly width: number
	/** Its AST's CTEs and arms, which a riding read-back's parts follow. */
	readonly ctes: NonEmptyReadonlyArray<Cte>
	readonly arms: NonEmptyReadonlyArray<SetArm>
}

/** A data-modifying CTE's returned columns and the part they are. */
export interface FamilyReturning {
	readonly cte: string
	readonly columns: ReadonlyArray<ReturnedColumn>
	readonly relation: StoredRelationName
	readonly result: FamilyPart["result"]
	readonly rows: FamilyPart["rows"]
}

export const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

export const one = lit.int(1, types.integer)

/** The installed name of a native column of `relation`. */
export const installed = (w: WriteContext, relation: string, column: NativeColumn): string =>
	column.kind === "field" ? w.names.column(relation, column.field.name) : column.column

/** A stored relation's table under an alias. */
export const tableAs = (w: WriteContext, relation: string, alias: string): FromSource => {
	const name = w.names.relation(relation)
	return table(name.schema, name.name, alias)
}

/** `value` cast into a column of `type`, as a write stores it. */
export const written = (w: WriteContext, value: Expr, type: ScalarType): Expr =>
	cast(value, w.cx.typeRef(type))

/** `row_number() OVER (PARTITION BY ... ORDER BY ...)`. */
export const rowNumber = (partition: ReadonlyArray<Expr>, order: ReadonlyArray<Expr>): Expr => ({
	...call("row_number", []),
	over: windowOf(partition, order.map(asc))
})

/**
 * The scalar subquery of one aggregate `value` over one group: grouped by `group`, columns its WHERE holds at the group's
 * key, so an empty group yields no row rather than one row of NULL, and the subquery reads NULL there either way.
 */
export const groupAggregate = (
	value: Expr,
	from: ReadonlyArray<FromItem>,
	where: Expr,
	group: NonEmptyReadonlyArray<Expr>
): Expr => ({
	kind: "subquery",
	query: operandSelect({ ...core([target(value)], from, where), groupBy: group })
})

/** `count(*) OVER (PARTITION BY ...)`. */
export const countOver = (partition: ReadonlyArray<Expr>): Expr => ({
	...countStar(),
	over: windowOf(partition, [])
})

/** Whether `keys` name the group of `family` that `alias`'s group columns hold, each at its group field's type. */
export const sameGroupExprs = (
	names: OperatorNames,
	family: Family,
	keys: ReadonlyArray<Expr>,
	alias: string,
	group: NonEmptyReadonlyArray<string>
): Expr =>
	and(
		mapNonEmpty(group, (c, i) =>
			typedEq(
				defined(family.group[i], "a group field").owner.type,
				defined(keys[i], "a group key"),
				col(alias, c),
				names
			)
		)
	)

/** A CTE's name and one fresh column name per key. */
export const shapedCte = (
	supply: NameSupply,
	purpose: string,
	keys: ReadonlyArray<ColumnKey>
): Shaped => ({
	name: supply.relation(internal(purpose)),
	columns: new Map(keys.map((k) => [k, supply.column(internal(purpose))] as const))
})

/** The column a shape holds `key` under. */
export const columnAt = (shape: Shaped, key: ColumnKey): string =>
	defined(shape.columns.get(key), `the column ${key} of ${shape.name}`)

/** The fact columns a family write returns of `relation`: every field, key first. */
const factColumns = (relation: RelationInfo) =>
	keyFirst(relation).map((f) => ({ name: f.name, type: rowType(f) }))

/** An inserted facts' result, as a family statement's inserts are read. */
export const insertedResult = (relation: RelationInfo): InsertResult => ({
	kind: "insert",
	relation: relation.name,
	variant: "family",
	of: "insert",
	proposes: "every",
	columns: factColumns(relation),
	fields: keyFirst(relation).map((f) => f.name),
	key: relation.primaryKey
})

/** A deletion's result: the facts it removed, every field, key first. */
export const deletedResult = (relation: RelationInfo): DeleteResult => ({
	kind: "delete",
	relation: relation.name,
	mode: "exact",
	columns: factColumns(relation),
	fields: keyFirst(relation).map((f) => f.name),
	key: relation.primaryKey
})

/** An update's result at `fields`, the key's first: each row's values there after the update and before. */
export const updatedResult = (
	relation: RelationInfo,
	fields: NonEmptyReadonlyArray<LawField>
): UpdateResult => {
	const columns = fields.map((f) => ({ name: f.name, type: rowType(f) }))
	return {
		kind: "update",
		relation: relation.name,
		columns: [...columns, ...columns],
		fields: fields.map((f) => f.name),
		key: relation.primaryKey,
		old: fields.length
	}
}

/**
 * The owner fields a recount returns: the owner's key, then each recounted family's count and ends, each once, the
 * columns it sets: a member's writer holds SELECT on no other column of its owner.
 */
const recountFields = (
	owner: RelationInfo,
	families: ReadonlyArray<Family>
): NonEmptyReadonlyArray<LawField> => {
	const out: [LawField, ...Array<LawField>] = [...owner.primaryFields]
	for (const family of families) {
		for (const f of [family.count, ...endColumns(family)]) {
			if (!out.some((g) => g.name === f.name)) {
				out.push(f)
			}
		}
	}
	return out
}

/** The RETURNING of an update's rows at `fields`, after and before, and the columns the statement returns them as. */
export const updateReturning = (
	w: WriteContext,
	supply: NameSupply,
	relation: RelationInfo,
	fields: NonEmptyReadonlyArray<LawField>,
	cteName: string
): {
	readonly returning: ReadonlyArray<ReturnType<typeof targetAs>>
	readonly columns: ReadonlyArray<ReturnedColumn>
} => {
	const fresh = fields.map((f) => ({ field: f, alias: supply.column(internal("updated new")) }))
	const old = fields.map((f) => ({ field: f, alias: supply.column(internal("updated old")) }))
	return {
		returning: [
			...fresh.map((p) =>
				targetAs(
					{ kind: "returning", side: "new", column: w.names.column(relation.name, p.field.name) },
					p.alias
				)
			),
			...old.map((p) =>
				targetAs(
					{ kind: "returning", side: "old", column: w.names.column(relation.name, p.field.name) },
					p.alias
				)
			)
		],
		columns: [...fresh, ...old].map((p) =>
			returnedColumn(col(cteName, p.alias), rowType(p.field), p.alias)
		)
	}
}

/** A statement's reader of member slots' facts: each slot's CTE, pushed onto the statement's CTEs at its first read and
 * shared by every later one (`slotFacts`). */
export type SlotReader = (relation: string, slot: MemberSlot) => Shaped

/** A reader of the member slots of the statement whose CTEs are `ctes`, each slot's facts read once. */
export const slotReader = (w: WriteContext, supply: NameSupply, ctes: Array<Cte>): SlotReader => {
	const read = new Map<MemberSlot["slot"], Shaped>()
	return (relation, slot) => {
		const known = read.get(slot.slot)
		if (known !== undefined) {
			return known
		}
		const facts = slotFacts(w, supply, ctes, relation, slot)
		read.set(slot.slot, facts)
		return facts
	}
}

/**
 * The facts of a member slot as a CTE: each field of its heading, read from the slot's arrays and cast into its column's
 * type as a write stores it, by key.
 */
const slotFacts = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	relation: string,
	slot: MemberSlot
): Shaped => {
	const heading = slot.heading
	const origin = { kind: "param", param: slot.slot } as const
	const slots = w.cx.member(
		slot.slot,
		relation,
		() =>
			relationColumns(
				heading,
				() => supply.column(origin),
				(t) => w.cx.baseTypeRef(t),
				unchecked
			),
		`a family write of ${relation}`
	)
	const raw = supply.relation(origin)
	const arrayColumn = new Map(slots[0].columns.map((c) => [c.name, c.definition.name] as const))
	const facts = shapedCte(
		supply,
		"slot fact",
		heading.map((c) => columnKeyOf(c.name))
	)
	ctes.push(
		cte(
			facts.name,
			select(
				provedCore(
					"input",
					heading.map((c) =>
						targetAs(
							written(w, col(raw, defined(arrayColumn.get(c.name), "a slot's array")), c.type),
							columnAt(facts, columnKeyOf(c.name))
						)
					),
					[arrays(arraysSource(slots), raw)],
					undefined
				)
			)
		)
	)
	return facts
}

/**
 * The statement of `ctes` whose rows are each returning's rows behind its tag, its position among them, padded with
 * empty texts to the widest (program/single.ts), so the outcome reads each part's rows as a family statement's.
 */
export const taggedRows = (
	supply: NameSupply,
	ctes: Array<Cte>,
	returnings: NonEmptyReadonlyArray<FamilyReturning>,
	params: WriteParams,
	refusals: ReadonlyArray<Expr>
): FamilyWriteSql => {
	const width = maxOf(
		returnings.map((r) => r.columns.length),
		0
	)
	const arms = mapNonEmpty(returnings, (r, tag): SetArm => {
		const rows = returnedRows("keyed", r.columns, [cteRef(r.cte)], undefined)
		const partName = supply.relation(internal("family write part"))
		const partColumns = r.columns.map(() => supply.column(internal("family write part column")))
		ctes.push(cte(partName, namedBody(rows, partColumns)))
		return provedCore(
			"keyed",
			[
				target(lit.int(tag, types.integer)),
				...partColumns.map((c) => target(col(partName, c))),
				...Array.from({ length: width - partColumns.length }, () =>
					target(lit.text("", types.text))
				)
			],
			[cteRef(partName)],
			conjunction(refusals)
		)
	})
	const [firstCte, ...restCtes] = ctes
	if (firstCte === undefined) {
		throw defect("a family write of no CTE")
	}
	const ast: Select = {
		...select(unionAll("disjoint", arms)),
		with: { recursive: false, ctes: [firstCte, ...restCtes] }
	}
	return {
		ast,
		sql: emitText(ast, supply.map()),
		params: Object.freeze([...params.slots]),
		parts: mapNonEmpty(returnings, (r) => ({
			relation: r.relation,
			result: r.result,
			rows: r.rows,
			width: r.columns.length
		})),
		returnings,
		width,
		ctes: [firstCte, ...restCtes],
		arms
	}
}

/** A recounted family's last member as its owner's recount reads it: the column of its count, and the column of each
 * end the family's last axis carries, by the owner's field's key. */
export interface RecountedLast {
	readonly family: Family
	readonly last: { readonly count: string; readonly columns: ReadonlyMap<ColumnKey, string> }
}

/**
 * The UPDATE of a mutable owner relation's rows a recount changes, as both recounts write it (write/family/additions.ts
 * and removals.ts recountOf): for each recounted family, its count and each end its last member carries set to `value`
 * of the last member's column over the owner's stored one, written at its field's type, on the owner rows `reach`
 * joins under the alias `o` where any of them changes; returning the owner's key, counts and ends (recountFields), a part
 * of the family write's rows of `counts`. `reach` names its sources after the UPDATE and its RETURNING are named.
 */
export const recountUpdate = <L extends RecountedLast>(
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	owner: RelationInfo,
	o: string,
	lasts: NonEmptyReadonlyArray<L>,
	value: (last: L, column: string, stored: Expr) => Expr,
	reach: () => { readonly from: ReadonlyArray<FromItem>; readonly at: Expr }
): FamilyReturning => {
	const name = owner.name
	const sets: Array<Assignment> = []
	const changed: Array<Expr> = []
	for (const x of lasts) {
		const assign = (field: LawField, column: string): void => {
			const installedColumn = w.names.column(name, field.name)
			/** The column's recounted value, built apart for the SET and for the WHERE that tests it changed. */
			const recounted = (): Expr =>
				written(w, value(x, column, col(o, installedColumn)), field.type)
			sets.push({ column: installedColumn, value: recounted() })
			changed.push(not(factFieldEq(field.type, col(o, installedColumn), recounted(), w.names)))
		}
		assign(x.family.count, x.last.count)
		for (const [key, column] of x.last.columns) {
			assign(
				defined(
					endColumns(x.family).find((f) => columnKeyOf(f.name) === key),
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
		lasts.map((x) => x.family)
	)
	const update = supply.relation(internal("family recount"))
	const returning = updateReturning(w, supply, owner, fields, update)
	const reached = reach()
	ctes.push(
		cte(update, {
			kind: "update",
			with: undefined,
			table: w.names.relation(name),
			alias: o,
			set: assignments(w.generation(name), o, [firstSet, ...restSets]),
			from: reached.from,
			where: and([reached.at, or([firstChange, ...restChanges])]),
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

/** The owner columns a family's owner copies read, by the owner column's key: the owner's column, the member's copy and
 * the copy's type. */
export type OwnerReads = ReadonlyMap<
	ColumnKey,
	{ readonly to: NativeColumn; readonly from: NativeColumn; readonly type: ScalarType }
>

/** The owner reads of a family's `drawn` columns (`OwnerReads`), each owner copy's. */
export const ownerReadsOf = (drawn: ReadonlyArray<FillColumn>): OwnerReads =>
	new Map(
		drawn.flatMap((c) =>
			c.rule.kind === "ownerCopy"
				? [[columnKey(c.rule.to), { to: c.rule.to, from: c.column, type: c.type }] as const]
				: []
		)
	)

/**
 * Where a family write's draw starts each group it draws (scan.ts GroupState):
 * - `base`: at slot 0 and the family's base, reading no stored member (an arbitrated append's, write/family/additions.ts);
 * - `stored`: at each group's first drawn slot, which the CTE `groups` holds beside the group's key, each group drawn
 *   from past slot 0 continuing its seed, its stored member at the slot before.
 */
export type DrawStart =
	| { readonly kind: "base" }
	| {
			readonly kind: "stored"
			readonly groups: {
				readonly name: string
				readonly group: NonEmptyReadonlyArray<string>
				readonly first: string
			}
	  }

/**
 * A family write's draw of the members of its groups, the additions' appends and the removals' redraws alike: the family
 * and its member relation, the columns its fill layout draws at the member's position, in fill order, where each group
 * starts (`DrawStart`), the owner columns its owner copies read (`OwnerReads`), the member columns the rows carry, by key,
 * and the rows themselves at their final slots, in the shape `rows` gives them (scan.ts ScanRows).
 */
export interface FamilyDraw {
	readonly family: Family
	readonly member: RelationInfo
	readonly drawn: ReadonlyArray<FillColumn>
	readonly start: DrawStart
	readonly owner: OwnerReads
	readonly columns: ReadonlyArray<ColumnKey>
	readonly rows: (rows: ScanRows) => Select
}

/**
 * The scan of a family write's draw (`FamilyDraw`), each a CTE pushed onto `ctes`: each group's seed where it starts
 * stored, the rows, and the scan of the family's rules over them (scan.ts scanOf). A group's seed is its stored member at
 * the slot before its first drawn one, with every column a predecessor copy reads, read by the probe of the member at
 * that slot of its group (write/probe.ts probeKey), once per group, index-led at the member's (group, index) key,
 * whatever PostgreSQL estimates of the groups; a group that starts at slot 0 has none, and reads the family's base.
 */
export const drawnScan = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	draw: FamilyDraw
): Scanned => {
	const { family, member } = draw
	const group: GroupState =
		draw.start.kind === "base"
			? { kind: "base" }
			: { kind: "stored", seed: seedOf(w, supply, ctes, draw, draw.start.groups) }
	const rows: ScanRows = {
		name: supply.relation(internal("drawn rows")),
		group: mapNonEmpty(family.group, () => supply.column(internal("drawn row group key"))),
		slot: supply.column(internal("drawn row slot")),
		first: supply.column(internal("drawn row first slot")),
		count: supply.column(internal("drawn row count")),
		columns: new Map(
			draw.columns.map((k) => [k, supply.column(internal("drawn row column"))] as const)
		),
		owner: new Map(
			[...draw.owner.keys()].map(
				(k) => [k, supply.column(internal("drawn row owner column"))] as const
			)
		),
		through: []
	}
	ctes.push(cte(rows.name, draw.rows(rows)))
	const scan = scanOf(writeLowering(w), supply, {
		family,
		member,
		drawn: draw.drawn,
		rows,
		group
	})
	ctes.push(scan.cte)
	return scan.rows
}

/** Each group's seed of a draw that starts stored (`drawnScan`), over the CTE of its groups. */
const seedOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	draw: FamilyDraw,
	groups: Extract<DrawStart, { readonly kind: "stored" }>["groups"]
): PerGroup => {
	const { family } = draw
	const name = draw.member.name
	const index = installed(w, name, family.shape.index)
	const reads = new Map<ColumnKey, NativeColumn>(
		draw.drawn.flatMap((c) =>
			c.rule.kind === "predecessor" ? [[columnKey(c.rule.to), c.rule.to] as const] : []
		)
	)
	const seed: PerGroup = {
		name: supply.relation(internal("seed")),
		group: mapNonEmpty(family.group, () => supply.column(internal("seed group key"))),
		columns: new Map(
			[...reads.keys()].map((k) => [k, supply.column(internal("seed column"))] as const)
		)
	}
	const g = supply.relation(internal("seeded group"))
	const member = probeKey(
		w,
		supply,
		name,
		{
			key: appendNonEmpty(
				mapNonEmpty(family.group, (f, i) =>
					bound(w, name, f.member, col(g, defined(groups.group[i], "a group column")))
				),
				{
					column: index,
					value: binary("-", col(g, groups.first), lit.int(1, types.bigint)),
					schema: undefined
				}
			),
			filter: () => [],
			placed: appendNonEmpty(
				mapNonEmpty(family.group, (f) => w.names.column(name, f.member.name)),
				index
			)
		},
		[index, ...[...reads.values()].map((column) => installed(w, name, column))]
	)
	ctes.push(
		cte(
			seed.name,
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(seed.group, (c, i) =>
							targetAs(col(g, defined(groups.group[i], "a group column")), c)
						),
						...[...reads].map(([k, column]) =>
							targetAs(member.at(installed(w, name, column)), columnAt(seed, k))
						)
					],
					[cteRefAs(groups.name, g), member.source],
					undefined
				)
			)
		)
	)
	return seed
}
