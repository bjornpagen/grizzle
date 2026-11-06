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
	binary,
	call,
	cast,
	col,
	columnDefinition,
	core,
	cte,
	cteRef,
	cteRefAs,
	eq,
	ge,
	join,
	lit,
	notExists,
	positionalValue,
	provedCore,
	provedSelect,
	sameTypeRef,
	select,
	setOperation,
	simpleSelect,
	table,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { type ColumnKey, columnKey } from "#compiler/write/family/fold.ts"
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

/**
 * The row layout of `relation` over the law model's `families` (`RowLayout`): its primary key's fields, its other
 * written fields, and each law column its families draw on it, each of the type its family gives it: a counted index
 * and ‹n› the count's, a tree's ‹ps› its start's, a hidden accumulator its plane's end's.
 */
export const rowLayout = (relation: RelationInfo, families: ReadonlyArray<Family>): RowLayout => {
	const mine = memberFamilies(relation.name, families)
	const fixed = new Set<string>([
		...mine.flatMap((f) => f.group.map((g) => `field:${g.member.name}`)),
		...mine.map((f) => `law:${f.copy}`)
	])
	const of = (column: NativeColumn, type: ScalarType): RowColumn => {
		const key = columnKey(column)
		return { column, key, type, settable: !fixed.has(key) }
	}
	const keyNames = new Set(relation.primaryFields.map((f) => f.name))
	const fields = relation.fields.flatMap((f) =>
		f.writing.kind === "generated" || keyNames.has(f.name)
			? []
			: [of({ kind: "field", field: f }, f.type)]
	)
	const law = mine.flatMap((f): ReadonlyArray<RowColumn> => [
		...(f.index.kind === "law" ? [of(f.index, f.count.type)] : []),
		of({ kind: "law", column: f.copy }, f.count.type),
		...(f.members.kind === "tree"
			? [of({ kind: "law", column: f.members.parentStart }, f.members.start.type)]
			: []),
		...f.folds.flatMap((fold) =>
			fold.planes.flatMap((plane) =>
				[plane.before, plane.after].flatMap((c) =>
					c.kind === "law" ? [of(c, plane.end.type)] : []
				)
			)
		)
	])
	const keyColumns = mapNonEmpty(relation.primaryFields, (f) => ({
		column: { kind: "field", field: f } as const,
		key: columnKey({ kind: "field", field: f }),
		type: f.type,
		settable: false
	}))
	return Object.freeze({ relation: relation.name, key: keyColumns, columns: [...fields, ...law] })
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

/** Each of `fields`, returned under a fresh column name. */
const returnedFields = (
	supply: NameSupply,
	fields: ReadonlyArray<LawField>
): ReadonlyArray<Returned> =>
	fields.map((field) => ({
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
		provedCore(
			"keyed",
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

/** The updated rows' result at `fields`, the key's first: each row's values there after the update and before. */
const updated = (relation: RelationInfo, fields: ReadonlyArray<LawField>): UpdateResult => {
	const columns = fields.map((f) => ({ name: f.name, type: rowType(f) }))
	return {
		kind: "update",
		relation: relation.name,
		columns: [...columns, ...columns],
		fields: fieldNames(fields),
		key: relation.primaryKey,
		old: fields.length
	}
}

/**
 * The owner fields a family's count statement returns: the owner's key, its count and its ends (`endColumns`), the
 * columns it sets. A member's writer holds SELECT on no other column of its owner, so the count statement's RETURNING
 * reads none, and an owner's change from a member write is its key, its count and its ends.
 */
const countReturned = (owner: RelationInfo, family: Family): NonEmptyReadonlyArray<LawField> => {
	const out: [LawField, ...Array<LawField>] = [...owner.primaryFields]
	for (const f of [family.count, ...endColumns(family)]) {
		if (!out.some((g) => g.name === f.name)) {
			out.push(f)
		}
	}
	return out
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
			const returned = returnedFields(supply, keyFirst(relation))
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
			const fresh = returnedFields(supply, keyFirst(relation))
			const old = returnedFields(supply, keyFirst(relation))
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
				result: updated(relation, keyFirst(relation))
			})
		}
		case "insert": {
			const input = arraysOf(w, supply, all)
			const returned = returnedFields(supply, keyFirst(relation))
			const ast = returningSelect(
				r,
				{
					kind: "insert",
					with: undefined,
					table: w.names.relation(relation.name),
					alias: target,
					overriding: undefined,
					onConflict: undefined,
					columns: all.map((c) => installed(w, relation.name, c.column)),
					source: {
						kind: "query",
						query: provedSelect(
							"input",
							all.map((_, i) =>
								targetAs(input.value(i), supply.column(internal("inserted column")))
							),
							[input.from],
							undefined
						)
					},
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
				arrays: all.length,
				result: {
					kind: "insert",
					relation: relation.name,
					variant: "family",
					serial: completeClass,
					of: "insert",
					proposes: "every",
					columns: factColumns(relation),
					fields: fieldNames(keyFirst(relation)),
					key: relation.primaryKey
				}
			})
		}
	}
}

/** A family's count statement: each owner's count and ends, by its key, returning them after and before with its key
 * (`countReturned`). */
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
	const returned = countReturned(owner, family)
	const fresh = returnedFields(supply, returned)
	const old = returnedFields(supply, returned)
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
		result: updated(owner, returned)
	})
}

/**
 * The owner columns a family's read returns of each touched group's owner, after its key: its count, its ends
 * (`endColumns`), and every column its owner axis carries into its members, which an appended or refilled member
 * copies.
 */
export const ownerReadColumns = (family: Family): ReadonlyArray<LawField> => {
	const out: Array<LawField> = [family.count]
	const add = (f: LawField): void => {
		if (!out.some((g) => g.name === f.name)) {
			out.push(f)
		}
	}
	for (const f of endColumns(family)) {
		add(f)
	}
	for (const pair of family.axes.owner) {
		if (pair.to.kind === "field") {
			add(pair.to.field)
		}
	}
	return out
}

/**
 * The columns of a family read's rows, tag first: an owner row's are its group's key texts and its `ownerReadColumns`;
 * a member row's are its key's texts and its row layout's columns. A row of the shorter kind is padded with empty
 * texts to `width` columns after the tag.
 */
export interface ReadShape {
	readonly owner: { readonly key: number; readonly columns: ReadonlyArray<LawField> }
	readonly member: { readonly key: number; readonly columns: number }
	readonly width: number
}

/** A family's read statement and the shape of its rows. */
export interface ReadSql {
	readonly ast: SqlStatement
	readonly sql: EmittedSql
	readonly arrays: number
	readonly shape: ReadShape
}

/** The arrays FROM item over `carried`, placeholders from `$first` on, under a fresh alias, each read raw. */
const arraysAt = (
	w: WriteContext,
	supply: NameSupply,
	carried: NonEmptyReadonlyArray<Carried>,
	first: number
): { readonly from: FromSource; readonly raw: (i: number) => Expr } => {
	const alias = supply.relation(internal("read keys"))
	const named = mapNonEmpty(carried, (c) => ({
		carried: c,
		name: supply.column(internal("read key"))
	}))
	const columns = mapNonEmpty(named, (n, i) => ({
		definition: columnDefinition(n.name, w.cx.baseTypeRef(n.carried.type)),
		array: positionalValue(first + i)
	}))
	return {
		from: arrays({ kind: "columns", columns }, alias),
		raw: (i) => col(alias, defined(named[i], `read key ${i}`).name)
	}
}

/**
 * A family's read (rows-first.md §2), one SELECT. $1 … $k are the touched members' keys, one array per key field, and
 * the next ones the touched groups' keys, one array per group field. A touched group is the stored group of a member a
 * key names, or a group the arrays name whose owner is stored. It returns, tag `o`, each touched group's owner, its key
 * and its `ownerReadColumns`; and, tag `m`, each member of a touched group from one slot before the least slot a key
 * names in it, or from its last member when no key names one, to its end, by its key and its row layout's columns.
 * Every column is text:
 *
 *   WITH h(g…, s) AS (SELECT m.g…, min(m.i) FROM F m JOIN keys k ON m.key = k.key GROUP BY m.g…),
 *        t(g…, s) AS (SELECT h.g…, h.s FROM h
 *                     UNION SELECT o.k…, o.n FROM O o JOIN groups g ON o.k = g.g
 *                           WHERE NOT EXISTS (SELECT FROM h WHERE h.g = o.k))
 *   SELECT 'o', o.k…, o.n, o.e…, '' … FROM O o JOIN t ON o.k = t.g
 *   UNION ALL SELECT 'm', m.key…, m.c… FROM F m JOIN t ON m.g = t.g WHERE m.i >= t.s - 1
 */
export const suffixReadSql = (
	family: Family,
	layout: RowLayout,
	w: WriteContext,
	relations: ReadonlyMap<string, RelationInfo>
): Result.Result<ReadSql, CompileError> => {
	const member = relations.get(family.member.name)
	const owner = relations.get(family.owner.name)
	if (member === undefined || owner === undefined) {
		return Result.err(
			unbuildable(family.member.name, "its owner and member, stored relations of the schema")
		)
	}
	const supply = begun(w)
	const keyCarried = mapNonEmpty(layout.key, carriedOf)
	const groupCarried = mapNonEmpty(family.group, (g): Carried => ({
		column: { kind: "field", field: g.owner },
		type: g.owner.type
	}))
	const ownerColumns = ownerReadColumns(family)
	const width = Math.max(
		family.group.length + ownerColumns.length,
		layout.key.length + layout.columns.length
	)
	const memberTable = w.names.relation(member.name)
	const ownerTable = w.names.relation(owner.name)
	const mCol = (alias: string, c: NativeColumn): Expr => col(alias, installed(w, member.name, c))
	const oCol = (alias: string, f: LawField): Expr => col(alias, w.names.column(owner.name, f.name))
	const groupNames = family.group.map(() => supply.column(internal("read group")))
	const g = (i: number): string => defined(groupNames[i], `read group ${i}`)
	const slotName = supply.column(internal("read slot"))
	const keys = arraysAt(w, supply, keyCarried, 1)
	const groups = arraysAt(w, supply, groupCarried, 1 + keyCarried.length)
	const h = supply.relation(internal("touched slots"))
	const hm = supply.relation(internal("touched member"))
	const hBody = select({
		...provedCore(
			"grouped",
			[
				...family.group.map((pair, i) =>
					targetAs(mCol(hm, { kind: "field", field: pair.member }), g(i))
				),
				targetAs(call("min", [mCol(hm, family.index)]), slotName)
			],
			[
				join(
					table(memberTable.schema, memberTable.name, hm),
					keys.from,
					and(mapNonEmpty(layout.key, (c, i) => eq(mCol(hm, c.column), keys.raw(i))))
				)
			],
			undefined
		),
		groupBy: family.group.map((pair) => mCol(hm, { kind: "field", field: pair.member }))
	})
	const t = supply.relation(internal("touched groups"))
	const th = supply.relation(internal("touched by key"))
	const to = supply.relation(internal("touched owner"))
	const tx = supply.relation(internal("touched before"))
	const tBody = select(
		setOperation("UNION", [
			core(
				[
					...family.group.map((_, i) => targetAs(col(th, g(i)), g(i))),
					targetAs(col(th, slotName), slotName)
				],
				[cteRefAs(h, th)],
				undefined
			),
			core(
				[
					...family.group.map((pair, i) => targetAs(oCol(to, pair.owner), g(i))),
					targetAs(oCol(to, family.count), slotName)
				],
				[
					join(
						table(ownerTable.schema, ownerTable.name, to),
						groups.from,
						and(mapNonEmpty(family.group, (pair, i) => eq(oCol(to, pair.owner), groups.raw(i))))
					)
				],
				notExists(
					simpleSelect(
						[targetAs(lit.int(1, types.integer), supply.column(internal("touched")))],
						[cteRefAs(h, tx)],
						and(mapNonEmpty(family.group, (pair, i) => eq(col(tx, g(i)), oCol(to, pair.owner))))
					)
				)
			)
		])
	)
	const tag = supply.column(internal("read tag"))
	const out = Array.from({ length: width }, () => supply.column(internal("read column")))
	const at = (i: number): string => defined(out[i], `read column ${i}`)
	const pad = (from: number): ReadonlyArray<Target> =>
		Array.from({ length: width - from }, (_, j) => targetAs(lit.text("", types.text), at(from + j)))
	const o = supply.relation(internal("read owner"))
	const ot = supply.relation(internal("read owner group"))
	const ownerTexts: ReadonlyArray<Expr> = [
		...family.group.map((pair) => resultText(oCol(o, pair.owner), pair.owner.type)),
		...ownerColumns.map((f) => resultText(oCol(o, f), f.type))
	]
	const ownerArm = provedCore(
		"keyed",
		[
			targetAs(lit.text("o", types.text), tag),
			...ownerTexts.map((e, i) => targetAs(e, at(i))),
			...pad(ownerTexts.length)
		],
		[
			join(
				table(ownerTable.schema, ownerTable.name, o),
				cteRefAs(t, ot),
				and(mapNonEmpty(family.group, (pair, i) => eq(oCol(o, pair.owner), col(ot, g(i)))))
			)
		],
		undefined
	)
	const m = supply.relation(internal("read member"))
	const mt = supply.relation(internal("read member group"))
	const memberTexts: ReadonlyArray<Expr> = [
		...layout.key.map((c) => resultText(mCol(m, c.column), c.type)),
		...layout.columns.map((c) => resultText(mCol(m, c.column), c.type))
	]
	const memberArm = provedCore(
		"keyed",
		[
			targetAs(lit.text("m", types.text), tag),
			...memberTexts.map((e, i) => targetAs(e, at(i))),
			...pad(memberTexts.length)
		],
		[
			join(
				table(memberTable.schema, memberTable.name, m),
				cteRefAs(t, mt),
				and(
					mapNonEmpty(family.group, (pair, i) =>
						eq(mCol(m, { kind: "field", field: pair.member }), col(mt, g(i)))
					)
				)
			)
		],
		ge(mCol(m, family.index), binary("-", col(mt, slotName), lit.int(1, types.bigint)))
	)
	const ast: SqlStatement = {
		...select(unionAll("disjoint", [ownerArm, memberArm])),
		with: {
			recursive: false,
			ctes: [cte(h, [...groupNames, slotName], hBody), cte(t, [...groupNames, slotName], tBody)]
		}
	}
	return Result.ok({
		ast,
		sql: emitText(ast, supply.map()),
		arrays: keyCarried.length + groupCarried.length,
		shape: {
			owner: { key: family.group.length, columns: ownerColumns },
			member: { key: layout.key.length, columns: layout.columns.length },
			width
		}
	})
}
