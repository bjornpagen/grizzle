/**
 * The SQL of a family write's statements (fin.md §4.5, §4.5a, rows-first.md §2), each reading its rows from the
 * columnar arrays its placeholders carry, $n the array of the n-th column of its rows' layout (write/family/order.ts
 * textsOf, draw.ts), each array of its column's base type:
 *
 * - a member relation's rows (`rowStatement`), whole in its row layout (`rowLayout`), whichever families it is a member
 *   of: `DELETE … WHERE key = r.key`, `UPDATE … SET <every settable column> … WHERE key = r.key`, and
 *   `INSERT INTO F (<every column>) SELECT …`;
 * - a tree deleted whole (`treeDelete`): `DELETE FROM T WHERE T.r = r`;
 * - a family's owners' counts (`countStatement`): `UPDATE O SET n = n, e… = e… … WHERE O.k… = k…`, each owner's one
 *   count and its ends, which the owner axis cascades into every member's ‹n›;
 * - a family's read (`suffixReadSql`, rows-first.md §2): its touched groups' owners and stored suffixes, one SELECT.
 *
 * Every write is a SELECT over the data-modifying CTE that writes, as every write statement is
 * (write/insert/statement.ts), and returns the facts it wrote or removed, every field of its relation key first, as
 * text: an insert's and a delete's as an insertion's and a deletion's rows, an update's and a count statement's each
 * fact after and before it, as a put's update's. So the outcome and the deltas read a family's rows as they read any
 * write's.
 */
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Family } from "#compiler/ir/family.ts"
import {
	type FamilyId,
	fieldNames,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type RelationInfo
} from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { completeClass } from "#compiler/ir/write.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import type {
	Assignment,
	CteBody,
	EmittedSql,
	Expr,
	FromSource,
	SqlStatement,
	Target
} from "#compiler/sql/ast.ts"
import {
	and,
	arrays,
	cast,
	col,
	columnDefinition,
	core,
	cte,
	cteRef,
	eq,
	positionalValue,
	sameTypeRef,
	select,
	simpleSelect,
	targetAs
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { type ColumnKey, columnKey, familyColumnType } from "#compiler/write/family/fold.ts"
import {
	type DeleteResult,
	type InsertResult,
	keyFirst,
	type ResultColumn,
	resultText,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

/** A column of a member relation's row layout: its native column, its key, its type, and whether an update sets it. */
export interface RowColumn {
	readonly column: NativeColumn
	readonly key: ColumnKey
	readonly type: ScalarType
	/** An update in place leaves the key, every group field and every copy of an owner's count: a move between groups
	 * is a delete and an insert, and the owner axes cascade the counts. */
	readonly settable: boolean
}

/**
 * A member relation's rows as every family statement writes them (draw.ts Row): its key fields, in key order; then
 * every other column the host writes, its caller's, serial, drawn and accumulated fields in its field order, and then,
 * for each family it is a member of, in the law model's order, its drawn law columns: a counted index ‹i›, ‹n›, a
 * tree's ‹ps›, and each fold's hidden accumulators, by fold and plane, the before then the after. A generated field is
 * PostgreSQL's, so none is listed.
 */
export interface RowLayout {
	readonly relation: string
	readonly key: NonEmptyReadonlyArray<RowColumn>
	readonly columns: ReadonlyArray<RowColumn>
}

const unbuildable = (relation: string, what: string): CompileError =>
	unsupported(SourceLoc("ChangeSet", [relation]), what)

/** The families `relation` is a member of, in the law model's order. */
export const memberFamilies = (
	relation: string,
	families: ReadonlyArray<Family>
): ReadonlyArray<Family> => families.filter((f) => f.member.name === relation)

/** The row layout of `relation` over the law model's `families` (`RowLayout`). */
export const rowLayout = (
	relation: LawRelation,
	families: ReadonlyArray<Family>
): Result.Result<RowLayout, CompileError> => {
	const primary = relation.keyNames.find((k) => k.primary)
	if (primary === undefined) {
		return Result.err(unbuildable(relation.name, "a primary key"))
	}
	const mine = memberFamilies(relation.name, families)
	const fixed = new Set<string>([
		...mine.flatMap((f) => f.group.map((g) => `field:${g.member.name}`)),
		...mine.map((f) => `law:${f.copy}`)
	])
	const of = (column: NativeColumn, type: ScalarType): RowColumn => {
		const key = columnKey(column)
		return { column, key, type, settable: !fixed.has(key) }
	}
	const keyNames = new Set(primary.fields.map((f) => f.name))
	const fields = relation.fields.flatMap((f) =>
		f.writing.kind === "generated" || keyNames.has(f.name)
			? []
			: [of({ kind: "field", field: f }, f.type)]
	)
	const law: Array<RowColumn> = []
	for (const f of mine) {
		const drawn: Array<NativeColumn> = [
			...(f.index.kind === "law" ? [f.index] : []),
			{ kind: "law", column: f.copy },
			...(f.members.kind === "tree"
				? [{ kind: "law" as const, column: f.members.parentStart }]
				: []),
			...f.folds.flatMap((fold) =>
				fold.planes.flatMap((plane) => [plane.before, plane.after].filter((c) => c.kind === "law"))
			)
		]
		for (const c of drawn) {
			const type = familyColumnType(f, c)
			if (type === undefined) {
				return Result.err(unbuildable(relation.name, `a type for the law column ${columnKey(c)}`))
			}
			law.push(of(c, type))
		}
	}
	const keyColumns = mapNonEmpty(primary.fields, (f) => ({
		column: { kind: "field", field: f } as const,
		key: columnKey({ kind: "field", field: f }),
		type: f.type,
		settable: false
	}))
	return Result.ok(
		Object.freeze({ relation: relation.name, key: keyColumns, columns: [...fields, ...law] })
	)
}

/**
 * The owner's end fields a count statement sets (draw.ts Recount ends): every accumulated field of the owner its
 * family's last axis carries, a fold's ends among them, in the order the axis carries them.
 */
export const endColumns = (family: Family): ReadonlyArray<LawField> => {
	const out: Array<LawField> = []
	for (const pair of family.axes.last) {
		const from = pair.from
		if (
			from.kind === "field" &&
			from.field.writing.kind === "accumulated" &&
			!out.some((f) => f.name === from.field.name)
		) {
			out.push(from.field)
		}
	}
	return out
}

/** An update's result: each fact after and before it, as a put's update's. */
type UpdateResult = Extract<PutResult, { readonly kind: "update" }>

/**
 * A family statement over one relation: its AST and its text, whose placeholders are its rows' arrays, $n the array of
 * the n-th column of its rows' layout (order.ts textsOf), `arrays` of them; the relation it writes, and the family whose
 * owners a count statement counts; and what its rows mean: the facts an insert placed, those a delete removed, each
 * fact an update or a count statement changed, after and before.
 */
export type FamilySql = {
	readonly ast: SqlStatement
	readonly sql: EmittedSql
	readonly arrays: number
	readonly relation: string
} & (
	| { readonly kind: "delete" | "deleteTree"; readonly result: DeleteResult }
	| { readonly kind: "update"; readonly result: UpdateResult }
	| { readonly kind: "count"; readonly family: FamilyId; readonly result: UpdateResult }
	| { readonly kind: "insert"; readonly result: InsertResult }
)

/** A column a statement's arrays carry: its native column on the written relation, and its type. */
interface Carried {
	readonly column: NativeColumn
	readonly type: ScalarType
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The installed name of a column of `relation`. */
const installed = (w: WriteContext, relation: string, column: NativeColumn): string =>
	column.kind === "field" ? w.names.column(relation, column.field.name) : column.column

/** A statement's input: its arrays FROM item, and each carried column read raw or cast into its column's type. */
interface Input {
	readonly from: FromSource
	readonly alias: string
	readonly raw: (i: number) => Expr
	readonly value: (i: number) => Expr
}

/**
 * The arrays FROM item over `carried`, $1 … $n in order, each of its column's base type, under a fresh alias; each
 * column's value under it raw, as a comparison reads it, or cast into its column's type where that is a domain, as an
 * insert or an update writes it.
 */
const arraysOf = (
	w: WriteContext,
	supply: NameSupply,
	carried: NonEmptyReadonlyArray<Carried>
): Input => {
	const alias = supply.relation(internal("family rows"))
	const named = mapNonEmpty(carried, (c) => ({
		carried: c,
		name: supply.column(internal("family column"))
	}))
	const columns = mapNonEmpty(named, (n, i) => ({
		definition: columnDefinition(n.name, w.cx.baseTypeRef(n.carried.type)),
		array: positionalValue(i + 1)
	}))
	const at = (i: number) => defined(named[i], `column ${i} of a family statement's ${named.length}`)
	const raw = (i: number): Expr => col(alias, at(i).name)
	return {
		from: arrays({ kind: "columns", columns }, alias),
		alias,
		raw,
		value: (i) => {
			const type = at(i).carried.type
			const target = w.cx.typeRef(type, "family write")
			return sameTypeRef(target, w.cx.baseTypeRef(type)) ? raw(i) : cast(raw(i), target)
		}
	}
}

/** The fact columns a statement returns: every field, key first. */
const factColumns = (relation: RelationInfo): ReadonlyArray<ResultColumn> =>
	keyFirst(relation).map((f) => ({ name: f.name, type: rowType(f) }))

/** A field a statement returns: its handle, its fresh column name and its row type. */
interface Returned {
	readonly field: LawField
	readonly column: string
	readonly type: ScalarType
}

/** Each fact field of `relation` key first, returned under a fresh column name. */
const returnedFields = (supply: NameSupply, relation: RelationInfo): ReadonlyArray<Returned> =>
	keyFirst(relation).map((field) => ({
		field,
		column: supply.column(internal("returned field")),
		type: rowType(field)
	}))

/** The data-modifying CTE `name` and the SELECT of its returned columns as text, as every write statement returns rows. */
const returningSelect = (
	name: string,
	body: CteBody,
	returned: ReadonlyArray<Returned>
): SqlStatement => ({
	...select(
		core(
			returned.map((r) => targetAs(resultText(col(name, r.column), r.type), r.column)),
			[cteRef(name)],
			undefined
		)
	),
	with: { recursive: false, ctes: [cte(name, [], body)] }
})

/** The deleted facts' result. */
const deleted = (relation: RelationInfo): DeleteResult => ({
	kind: "delete",
	relation: relation.name,
	mode: "exact",
	columns: factColumns(relation),
	fields: fieldNames(keyFirst(relation)),
	key: relation.primaryKey
})

/** The updated facts' result: each after and before. */
const updated = (relation: RelationInfo): UpdateResult => {
	const all = keyFirst(relation)
	return {
		kind: "update",
		relation: relation.name,
		columns: [...factColumns(relation), ...factColumns(relation)],
		fields: fieldNames(all),
		key: relation.primaryKey,
		old: all.length
	}
}

/** The RETURNING of an update's new and old facts. */
const newAndOld = (
	w: WriteContext,
	relation: RelationInfo,
	fresh: ReadonlyArray<Returned>,
	old: ReadonlyArray<Returned>
): ReadonlyArray<Target> => [
	...fresh.map((p) =>
		targetAs(
			{ kind: "returning", side: "new", column: w.names.column(relation.name, p.field.name) },
			p.column
		)
	),
	...old.map((p) =>
		targetAs(
			{ kind: "returning", side: "old", column: w.names.column(relation.name, p.field.name) },
			p.column
		)
	)
]

/** Begins a statement of its own, its names from r0 and c1. */
const begun = (w: WriteContext): NameSupply => {
	const supply = new NameSupply({ relationStart: 0, columnStart: 1 })
	w.cx.beginWriteStatement(supply, new WriteParams())
	return supply
}

const carriedOf = (c: RowColumn): Carried => ({ column: c.column, type: c.type })

/**
 * A member relation's statement of kind `kind` over its row layout: a delete by key, an update in place by key of
 * every settable column, or an insert of every column. One per relation and kind, whatever rows it carries.
 */
export const rowStatement = (
	relation: RelationInfo,
	layout: RowLayout,
	kind: "delete" | "update" | "insert",
	w: WriteContext
): Result.Result<FamilySql, CompileError> => {
	const supply = begun(w)
	const sql = (ast: SqlStatement): EmittedSql => emitText(ast, supply.map())
	const keyCarried = mapNonEmpty(layout.key, carriedOf)
	const all: NonEmptyReadonlyArray<Carried> = [...keyCarried, ...layout.columns.map(carriedOf)]
	const r = supply.relation(internal(`family ${kind}`))
	const target = supply.relation(internal("family row"))
	const stored = (c: NativeColumn): Expr => col(target, installed(w, relation.name, c))
	switch (kind) {
		case "delete": {
			const input = arraysOf(w, supply, keyCarried)
			const returned = returnedFields(supply, relation)
			const ast = returningSelect(
				r,
				{
					kind: "delete",
					with: undefined,
					table: w.names.relation(relation.name),
					alias: target,
					using: [input.from],
					where: and(mapNonEmpty(layout.key, (c, i) => eq(stored(c.column), input.raw(i)))),
					returning: returned.map((f) =>
						targetAs(stored({ kind: "field", field: f.field }), f.column)
					)
				},
				returned
			)
			return Result.ok({
				kind,
				relation: relation.name,
				ast,
				sql: sql(ast),
				arrays: keyCarried.length,
				result: deleted(relation)
			})
		}
		case "update": {
			const input = arraysOf(w, supply, all)
			const k = layout.key.length
			const sets = layout.columns.flatMap((c, i) =>
				c.settable
					? [
							{
								column: installed(w, relation.name, c.column),
								value: input.value(k + i)
							} satisfies Assignment
						]
					: []
			)
			if (!isNonEmpty(sets)) {
				return Result.err(
					unbuildable(relation.name, "an update in place of a row with a settable column")
				)
			}
			const fresh = returnedFields(supply, relation)
			const old = returnedFields(supply, relation)
			const ast = returningSelect(
				r,
				{
					kind: "update",
					with: undefined,
					table: w.names.relation(relation.name),
					alias: target,
					set: sets,
					from: [input.from],
					where: and(mapNonEmpty(layout.key, (c, i) => eq(stored(c.column), input.raw(i)))),
					returning: newAndOld(w, relation, fresh, old)
				},
				[...fresh, ...old]
			)
			return Result.ok({
				kind,
				relation: relation.name,
				ast,
				sql: sql(ast),
				arrays: all.length,
				result: updated(relation)
			})
		}
		case "insert": {
			const input = arraysOf(w, supply, all)
			const returned = returnedFields(supply, relation)
			const ast = returningSelect(
				r,
				{
					kind: "insert",
					with: undefined,
					table: w.names.relation(relation.name),
					alias: undefined,
					overriding: undefined,
					onConflict: undefined,
					columns: all.map((c) => installed(w, relation.name, c.column)),
					source: {
						kind: "query",
						query: simpleSelect(
							all.map((_, i) =>
								targetAs(input.value(i), supply.column(internal("inserted column")))
							),
							[input.from],
							undefined
						)
					},
					returning: returned.map((f) =>
						targetAs(
							{
								kind: "column",
								table: undefined,
								column: w.names.column(relation.name, f.field.name)
							},
							f.column
						)
					)
				},
				returned
			)
			return Result.ok({
				kind,
				relation: relation.name,
				ast,
				sql: sql(ast),
				arrays: all.length,
				result: {
					kind: "insert",
					relation: relation.name,
					variant: "family",
					serial: completeClass,
					of: "insert",
					columns: factColumns(relation),
					fields: fieldNames(keyFirst(relation)),
					key: relation.primaryKey
				}
			})
		}
	}
}

/** A tree's delete of every row of each tree it names by its root field. */
export const treeDelete = (
	family: Family,
	w: WriteContext,
	relations: ReadonlyMap<string, RelationInfo>
): Result.Result<FamilySql, CompileError> => {
	const member = relations.get(family.member.name)
	if (member === undefined || family.members.kind !== "tree") {
		return Result.err(unbuildable(family.member.name, "a tree relation of the schema"))
	}
	const root = family.members.root
	const supply = begun(w)
	const r = supply.relation(internal("tree delete"))
	const target = supply.relation(internal("tree row"))
	const input = arraysOf(w, supply, [{ column: { kind: "field", field: root }, type: root.type }])
	const returned = returnedFields(supply, member)
	const stored = (f: LawField): Expr => col(target, w.names.column(member.name, f.name))
	const ast = returningSelect(
		r,
		{
			kind: "delete",
			with: undefined,
			table: w.names.relation(member.name),
			alias: target,
			using: [input.from],
			where: eq(stored(root), input.raw(0)),
			returning: returned.map((f) => targetAs(stored(f.field), f.column))
		},
		returned
	)
	return Result.ok({
		kind: "deleteTree",
		relation: member.name,
		ast,
		sql: emitText(ast, supply.map()),
		arrays: 1,
		result: deleted(member)
	})
}

/** A family's count statement: each owner's count and ends, by its key, returning its fact after and before. */
export const countStatement = (
	family: Family,
	w: WriteContext,
	relations: ReadonlyMap<string, RelationInfo>
): Result.Result<FamilySql, CompileError> => {
	const owner = relations.get(family.owner.name)
	if (owner === undefined) {
		return Result.err(unbuildable(family.owner.name, "an owner relation of the schema"))
	}
	const supply = begun(w)
	const keys = mapNonEmpty(family.group, (g): Carried => ({
		column: { kind: "field", field: g.owner },
		type: g.owner.type
	}))
	const set: NonEmptyReadonlyArray<LawField> = [family.count, ...endColumns(family)]
	const carried: NonEmptyReadonlyArray<Carried> = [
		...keys,
		...mapNonEmpty(set, (f): Carried => ({ column: { kind: "field", field: f }, type: f.type }))
	]
	const r = supply.relation(internal("family count"))
	const target = supply.relation(internal("family owner"))
	const input = arraysOf(w, supply, carried)
	const fresh = returnedFields(supply, owner)
	const old = returnedFields(supply, owner)
	const column = (f: LawField): string => w.names.column(owner.name, f.name)
	const k = keys.length
	const ast = returningSelect(
		r,
		{
			kind: "update",
			with: undefined,
			table: w.names.relation(owner.name),
			alias: target,
			set: mapNonEmpty(set, (f, i): Assignment => ({
				column: column(f),
				value: input.value(k + i)
			})),
			from: [input.from],
			where: and(
				mapNonEmpty(family.group, (g, i) => eq(col(target, column(g.owner)), input.raw(i)))
			),
			returning: newAndOld(w, owner, fresh, old)
		},
		[...fresh, ...old]
	)
	return Result.ok({
		kind: "count",
		family: family.id,
		relation: owner.name,
		ast,
		sql: emitText(ast, supply.map()),
		arrays: carried.length,
		result: updated(owner)
	})
}
