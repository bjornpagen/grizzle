/**
 * What every family write statement shares (write/family/additions.ts, write/family/removals.ts): the parts its rows
 * are read as, each part's rows behind its tag; the facts a member slot carries, read from its arrays; and the small
 * builders of the SQL the two write in common.
 */
import { maxOf } from "#compiler/core/array.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { completeClass } from "#compiler/ir/write.ts"
import {
	arraysSource,
	relationColumns,
	type WriteParams
} from "#compiler/lower/conservative/context.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { type ColumnKey, fieldKey } from "#compiler/runtime/write/fill.ts"
import type {
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
	call,
	cast,
	col,
	core,
	countStar,
	cte,
	cteRef,
	eq,
	lit,
	operandSelect,
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
import type { NameSupply } from "#compiler/sql/naming.ts"
import type { Shaped } from "#compiler/write/family/scan.ts"
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

/** A family write as one statement: its AST and text, its placeholders, and its rows' parts, in tag order. */
export interface FamilyWriteSql {
	readonly ast: Select
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly parts: NonEmptyReadonlyArray<FamilyPart>
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
	cast(value, w.cx.typeRef(type, "family write"))

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

/** Whether `keys` name the group `alias`'s group columns hold. */
export const sameGroupExprs = (
	keys: ReadonlyArray<Expr>,
	alias: string,
	group: NonEmptyReadonlyArray<string>
): Expr => and(mapNonEmpty(group, (c, i) => eq(defined(keys[i], "a group key"), col(alias, c))))

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
	serial: completeClass,
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
export const recountFields = (
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
				(t) => w.cx.baseTypeRef(t)
			),
		`a family write of ${relation}`
	)
	const raw = supply.relation(origin)
	const arrayColumn = new Map(slots[0].columns.map((c) => [c.name, c.definition.name] as const))
	const facts = shapedCte(
		supply,
		"slot fact",
		heading.map((c) => fieldKey(c.name))
	)
	ctes.push(
		cte(
			facts.name,
			[...facts.columns.values()],
			select(
				provedCore(
					"input",
					heading.map((c) =>
						targetAs(
							written(w, col(raw, defined(arrayColumn.get(c.name), "a slot's array")), c.type),
							columnAt(facts, fieldKey(c.name))
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
	params: WriteParams
): FamilyWriteSql => {
	const width = maxOf(
		returnings.map((r) => r.columns.length),
		0
	)
	const arms = mapNonEmpty(returnings, (r, tag): SetArm => {
		const rows = returnedRows("keyed", r.columns, [cteRef(r.cte)], undefined)
		const partName = supply.relation(internal("family write part"))
		const partColumns = r.columns.map(() => supply.column(internal("family write part column")))
		ctes.push(cte(partName, partColumns, rows))
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
			undefined
		)
	})
	const [firstCte, ...restCtes] = ctes
	if (firstCte === undefined) {
		throw defect("a family write of no CTE")
	}
	const ast: Select = {
		...select(unionAll("disjoint", arms)),
		with: { recursive: true, ctes: [firstCte, ...restCtes] }
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
		}))
	}
}
