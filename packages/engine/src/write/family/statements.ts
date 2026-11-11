/**
 * The SQL of a family write's statements, each reading its rows from the
 * columnar arrays its placeholders carry, $n the array of the n-th column of its rows' layout (write/family/order.ts
 * textsOf, draw.ts), each array of its column's base type:
 *
 * - a member relation's rows (`rowStatement`), whole in its row layout (`rowLayout`), whichever families it is a member
 *   of: `DELETE … WHERE key = r.key`, `UPDATE … SET <every settable column> … WHERE key = r.key`, and
 *   `INSERT INTO F (<every column>) SELECT …`;
 * - a family's owners' counts (`countStatement`): `UPDATE O SET n = n, e… = e… … WHERE O.k… = k…`, each owner's one
 *   count and its ends, which the owner axis cascades into every member's ‹n›;
 * - a family's read (`suffixReadSql`): its touched groups' owners and stored suffixes, one SELECT.
 *
 * Every write is a SELECT over the data-modifying CTE that writes, as every write statement is
 * (write/insert/statement.ts), and returns the facts it wrote or removed, every field of its relation key first, as
 * text: an insert's and a delete's as an insertion's and a deletion's rows, an update's and a count statement's each
 * fact after and before it, as a put's update's. So the outcome and the deltas read a family's rows as they read any
 * write's.
 */
import { withGenerationInputs } from "#compiler/analysis/theory/fill.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { typedEq } from "#compiler/ir/compare.ts"
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
import {
	deliveredColumn,
	deliveredWidth,
	type TaggedArm,
	taggedArm
} from "#compiler/lower/delivery.ts"
import { type ColumnKey, columnKey } from "#compiler/runtime/write/fill.ts"
import type { LaidColumn, LaidLayout } from "#compiler/runtime/write/nesting.ts"
import type {
	Assignment,
	Cte,
	CteBody,
	EmittedSql,
	Expr,
	FromItem,
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
	distinctCore,
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
import {
	type GroupsOf,
	type RefillRead,
	type RowsOf,
	rowsRelation
} from "#compiler/write/family/chain.ts"
import {
	type DeleteResult,
	type InsertResult,
	keyFirst,
	type ResultColumn,
	returnedColumn,
	returnedRows,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

/**
 * A column of a member relation's row layout: its native column, its key, its type, whether an update sets it, and
 * whether it is a copy of an owner's count, which only a refill sets.
 */
export interface RowColumn {
	readonly column: NativeColumn
	readonly key: ColumnKey
	readonly type: ScalarType
	/** An update in place leaves the key, every group field and every copy of an owner's count: a move between groups
	 * is a delete and an insert, and the owner axes cascade the counts. */
	readonly settable: boolean
	readonly copy: boolean
}

/**
 * A member relation's rows as every family statement writes them (draw.ts Row): its key fields, in key order; then
 * every other column the host writes, its caller's, serial, drawn and accumulated fields in its field order, and then,
 * for each family it is a member of, in the law model's order, its drawn law columns: a counted index ‹i›, ‹n›, a
 * tree's ‹ps›, and each fold's hidden accumulators, by fold and plane, the before then the after. A generated field is
 * PostgreSQL's, so none is listed.
 */
export interface RowLayout {
	readonly relation: StoredRelationName
	readonly key: NonEmptyReadonlyArray<RowColumn>
	readonly columns: ReadonlyArray<RowColumn>
}

/** A row layout as a binding holds it (`LaidLayout`), each column projected to what binding reads of it. */
export const laidLayout = (layout: LaidLayout): LaidLayout => {
	const laid = (c: LaidColumn): LaidColumn => ({
		key: c.key,
		type: c.type,
		column:
			c.column.kind === "field"
				? { kind: "field", field: { name: c.column.field.name } }
				: { kind: "law", column: c.column.column }
	})
	return {
		relation: layout.relation,
		key: mapNonEmpty(layout.key, laid),
		columns: layout.columns.map(laid)
	}
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
	const groups = new Set<string>(mine.flatMap((f) => f.group.map((g) => `field:${g.member.name}`)))
	const copies = new Set<string>(mine.map((f) => `law:${f.copy}`))
	const of = (column: NativeColumn, type: ScalarType): RowColumn => {
		const key = columnKey(column)
		const copy = copies.has(key)
		return { column, key, type, settable: !groups.has(key) && !copy, copy }
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
		settable: false,
		copy: false
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
	| { readonly kind: "delete"; readonly result: DeleteResult }
	| { readonly kind: "update" | "refill"; readonly result: UpdateResult }
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
		from: arrays({ kind: "columns", columns, ordinal: undefined }, alias),
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

/**
 * The data-modifying CTE `name` and the SELECT of its returned columns' texts, as every write statement returns rows
 * (write/insert/statement.ts returnedRows).
 */
const returningSelect = (
	name: string,
	body: CteBody,
	returned: ReadonlyArray<Returned>
): SqlStatement => ({
	...returnedRows(
		"keyed",
		returned.map((r) => returnedColumn(col(name, r.column), r.type, r.column)),
		[cteRef(name)],
		undefined
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
 * A member relation's statement of kind `kind` over its row layout: a delete by key; an update in place by key of every
 * settable column; a refill, an update in place by key of every column but its key and its groups, its copies of its
 * owners' counts among them, since a refill writes a row with the new values of the owners it is drawn ahead of
 * (analysis/theory/refill.ts); or an insert of every column. One per relation and kind, whatever rows it carries.
 */
export const rowStatement = (
	relation: RelationInfo,
	layout: RowLayout,
	kind: "delete" | "refill" | "update" | "insert",
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
					where: and(
						mapNonEmpty(layout.key, (c, i) =>
							typedEq(c.type, stored(c.column), input.raw(i), w.names)
						)
					),
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
		case "refill":
		case "update": {
			const input = arraysOf(w, supply, all)
			const k = layout.key.length
			const sets = layout.columns.flatMap((c, i) =>
				c.settable || (kind === "refill" && c.copy)
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
					where: and(
						mapNonEmpty(layout.key, (c, i) =>
							typedEq(c.type, stored(c.column), input.raw(i), w.names)
						)
					),
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
				mapNonEmpty(family.group, (g, i) =>
					typedEq(g.owner.type, col(target, column(g.owner)), input.raw(i), w.names)
				)
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
 * (`endColumns`), every column its owner axis carries into its members, which an appended or refilled member copies,
 * and every field a generated one among them is computed from (withGenerationInputs): the host evaluates a generated
 * field again over the owner's row once its count or ends change (edit.ts overlaid), so the row holds what it reads.
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
	return withGenerationInputs(family.owner, out)
}

/**
 * The columns of a family read's rows, tag first: an owner row's are its group's key fields and its
 * `ownerReadColumns`; a member row's are its key's and its row layout's other columns. Each kind's rows travel as its
 * columns' delivery (lower/delivery.ts taggedArm), a row of the shorter padded with empty texts after it.
 */
export interface ReadShape {
	readonly owner: { readonly key: number; readonly columns: ReadonlyArray<LawField> }
	readonly member: { readonly key: number; readonly columns: number }
}

/** The shape of a family's read's rows over its member's row layout (`ReadShape`). */
export const readShape = (family: Family, layout: RowLayout): ReadShape => ({
	owner: { key: family.group.length, columns: ownerReadColumns(family) },
	member: { key: layout.key.length, columns: layout.columns.length }
})

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
		from: arrays({ kind: "columns", columns, ordinal: undefined }, alias),
		raw: (i) => col(alias, defined(named[i], `read key ${i}`).name)
	}
}

/**
 * A family's read, one SELECT. $1 … $k are the touched members' keys, one array per key field, and
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
	const shape = readShape(family, layout)
	const ownerColumns = shape.owner.columns
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
					and(
						mapNonEmpty(layout.key, (c, i) =>
							typedEq(c.type, mCol(hm, c.column), keys.raw(i), w.names)
						)
					)
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
						and(
							mapNonEmpty(family.group, (pair, i) =>
								typedEq(pair.owner.type, oCol(to, pair.owner), groups.raw(i), w.names)
							)
						)
					)
				],
				notExists(
					simpleSelect(
						[targetAs(lit.int(1, types.integer), supply.column(internal("touched")))],
						[cteRefAs(h, tx)],
						and(
							mapNonEmpty(family.group, (pair, i) =>
								typedEq(pair.owner.type, col(tx, g(i)), oCol(to, pair.owner), w.names)
							)
						)
					)
				)
			)
		])
	)
	const ownerFields: ReadonlyArray<LawField> = [
		...family.group.map((pair) => pair.owner),
		...ownerColumns
	]
	const memberColumns = [...layout.key, ...layout.columns]
	const width = Math.max(
		deliveredWidth(ownerFields.map((f) => deliveredColumn(f.type))),
		deliveredWidth(memberColumns.map((c) => deliveredColumn(c.type)))
	)
	const tag = supply.column(internal("read tag"))
	const out = Array.from({ length: width }, () => supply.column(internal("read column")))
	const at = (i: number): string => defined(out[i], `read column ${i}`)
	const o = supply.relation(internal("read owner"))
	const ot = supply.relation(internal("read owner group"))
	const ownerArm = taggedArm(
		{
			tag: "o",
			columns: ownerFields.map((f) => ({ expr: oCol(o, f), delivered: deliveredColumn(f.type) })),
			from: [
				join(
					table(ownerTable.schema, ownerTable.name, o),
					cteRefAs(t, ot),
					and(
						mapNonEmpty(family.group, (pair, i) =>
							typedEq(pair.owner.type, oCol(o, pair.owner), col(ot, g(i)), w.names)
						)
					)
				)
			],
			where: undefined
		},
		tag,
		at,
		width,
		supply,
		bytesChunkLength.value
	)
	const m = supply.relation(internal("read member"))
	const mt = supply.relation(internal("read member group"))
	const memberArm = taggedArm(
		{
			tag: "m",
			columns: memberColumns.map((c) => ({
				expr: mCol(m, c.column),
				delivered: deliveredColumn(c.type)
			})),
			from: [
				join(
					table(memberTable.schema, memberTable.name, m),
					cteRefAs(t, mt),
					and(
						mapNonEmpty(family.group, (pair, i) =>
							typedEq(
								pair.member.type,
								mCol(m, { kind: "field", field: pair.member }),
								col(mt, g(i)),
								w.names
							)
						)
					)
				)
			],
			where: ge(mCol(m, family.index), binary("-", col(mt, slotName), lit.int(1, types.bigint)))
		},
		tag,
		at,
		width,
		supply,
		bytesChunkLength.value
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
		shape
	})
}

/**
 * Where a chain's rows begin, as its read's placeholders carry them: a put's keys, one array per key field of its
 * relation, $1 on; or the members and groups an edit of `family` touches, as the family's own read carries them
 * (`suffixReadSql`), its members' keys from $1 and its groups' keys after them.
 */
export type ChainRoot =
	| { readonly kind: "put"; readonly relation: RelationInfo; readonly slot: ParamId }
	| { readonly kind: "touched"; readonly family: Family }

/**
 * The shape of a chain read's rows: each row set its chain passes, by its tag, its relation and its row layout, every
 * row by its key's texts and its layout's columns; and what it reads at its end: a refilled family's suffixes as a
 * family's read returns them (`o` and `m` rows), a refilled tree's whole (`t` rows, in its relation's layout), or no
 * more than its row sets. Each kind's rows travel as its columns' delivery (lower/delivery.ts taggedArm), a row of a
 * shorter kind padded with empty texts after it.
 */
export interface ChainShape {
	readonly rows: ReadonlyArray<{
		readonly tag: string
		readonly relation: RelationInfo
		readonly layout: RowLayout
	}>
	readonly end:
		| {
				readonly kind: "suffix"
				readonly family: Family
				readonly shape: ReadShape
				readonly layout: RowLayout
		  }
		| { readonly kind: "tree"; readonly family: Family; readonly layout: RowLayout }
		| { readonly kind: "rows" }
}

/** A chain's read statement: its AST and text, where its rows begin, and the shape of its rows. */
export interface ChainSql {
	readonly ast: SqlStatement
	readonly sql: EmittedSql
	readonly root: ChainRoot
	readonly shape: ChainShape
}

/**
 * A chain's read (write/family/chain.ts), one SELECT. Each row set and group set the chain passes is a CTE over the one
 * before it: a put's keys from its arrays, an edit's touched groups (its keyed members' groups and its group keys), an
 * owner's members by their groups (a cascade), a member's groups with the least slot it stands at, a group's owners or
 * its members from that slot, a tree's every row. It returns every row each row set holds, tag `r<i>` for the i-th, and
 * at its end a refilled family's owners (`o`) and members from one slot before each group's least (`m`), or a refilled
 * tree's every row (`t`). Every column is text:
 *
 *   WITH c0(k…) AS (SELECT DISTINCT a.k… FROM unnest($1 …) a),
 *        c1(k…) AS (SELECT DISTINCT m.k… FROM M m JOIN c0 ON m.g… = c0.k…),
 *        c2(g…, s) AS (SELECT m.g…, min(m.i) FROM L m JOIN c1 ON m.k… = c1.k… GROUP BY m.g…)
 *   SELECT 'r0', a.k…, a.c… FROM A a JOIN c0 …
 *   UNION ALL SELECT 'r1', m.k…, m.c… FROM M m JOIN c1 …
 *   UNION ALL SELECT 'o', o.k…, o.n, o.e…, … FROM O o JOIN c2 ON o.k… = c2.g…
 *   UNION ALL SELECT 'm', m.k…, m.c… FROM L m JOIN c2 ON m.g… = c2.g… WHERE m.i >= c2.s - 1
 */
export const chainReadSql = (
	read: RefillRead,
	w: WriteContext,
	layoutOf: (relation: RelationInfo) => RowLayout
): ChainSql => {
	const supply = begun(w)
	const ctes: Array<Cte> = []
	const arms: Array<TaggedArm> = []
	const sets: Array<ChainShape["rows"][number]> = []
	const roots: Array<ChainRoot> = []
	const columnOf = (alias: string, relation: RelationInfo, c: NativeColumn): Expr =>
		col(alias, installed(w, relation.name, c))
	const fieldOf = (alias: string, relation: RelationInfo, f: LawField): Expr =>
		columnOf(alias, relation, { kind: "field", field: f })
	const tableOf = (relation: RelationInfo, alias: string): FromSource => {
		const name = w.names.relation(relation.name)
		return table(name.schema, name.name, alias)
	}
	const fieldCarried = (f: LawField): Carried => ({
		column: { kind: "field", field: f },
		type: f.type
	})
	/** A row of `relation` under `alias` as a chain returns it: its key's columns, then its layout's other columns. */
	const rowTexts = (
		alias: string,
		relation: RelationInfo,
		layout: RowLayout
	): TaggedArm["columns"] =>
		[...layout.key, ...layout.columns].map((c) => ({
			expr: columnOf(alias, relation, c.column),
			delivered: deliveredColumn(c.type)
		}))
	/** The key fields of `relation` under `alias` equal to `keys` of the CTE `at`, field by field in key order. */
	const keyed = (
		alias: string,
		relation: RelationInfo,
		at: string,
		keys: NonEmptyReadonlyArray<string>
	) =>
		and(
			mapNonEmpty(relation.primaryFields, (f, i) =>
				typedEq(f.type, fieldOf(alias, relation, f), col(at, defined(keys[i], `key ${i}`)), w.names)
			)
		)
	/** The owner's key field a group field of `family` pairs with, as a position among the owner's key fields. */
	const ownerPosition = (family: Family, owner: LawField): number =>
		family.owner.primaryFields.findIndex((f) => f.name === owner.name)
	/** The fields a set of `family`'s groups holds: its group fields, or a tree's root field. */
	const groupFields = (family: Family): NonEmptyReadonlyArray<LawField> =>
		family.members.kind === "tree"
			? [family.members.root]
			: mapNonEmpty(family.group, (g) => g.member)
	interface RowsCte {
		readonly name: string
		readonly keys: NonEmptyReadonlyArray<string>
	}
	interface GroupsCte {
		readonly name: string
		readonly groups: NonEmptyReadonlyArray<string>
		readonly slot: string
	}
	const groupsCte = (groups: GroupsOf): GroupsCte => {
		const family = groups.family
		const name = supply.relation(internal("chain groups"))
		const names = mapNonEmpty(groupFields(family), () => supply.column(internal("chain group")))
		const slot = supply.column(internal("chain slot"))
		const m = supply.relation(internal("chain member"))
		const zero = lit.int(0, types.bigint)
		switch (groups.kind) {
			case "touched": {
				roots.push({ kind: "touched", family })
				const layout = layoutOf(family.member)
				const keys = arraysAt(w, supply, mapNonEmpty(layout.key, carriedOf), 1)
				const touched = arraysAt(
					w,
					supply,
					mapNonEmpty(family.group, (g) => fieldCarried(g.owner)),
					1 + layout.key.length
				)
				ctes.push(
					cte(
						name,
						[...names, slot],
						select(
							setOperation("UNION", [
								core(
									[
										...family.group.map((g, i) =>
											targetAs(
												fieldOf(m, family.member, g.member),
												defined(names[i], "a group column")
											)
										),
										targetAs(zero, slot)
									],
									[
										join(
											tableOf(family.member, m),
											keys.from,
											and(
												mapNonEmpty(layout.key, (c, i) =>
													typedEq(
														c.type,
														columnOf(m, family.member, c.column),
														keys.raw(i),
														w.names
													)
												)
											)
										)
									],
									undefined
								),
								core(
									[
										...family.group.map((_, i) =>
											targetAs(touched.raw(i), defined(names[i], "a group column"))
										),
										targetAs(zero, slot)
									],
									[touched.from],
									undefined
								)
							])
						)
					)
				)
				return { name, groups: names, slot }
			}
			case "groups": {
				const from = rowsCte(groups.from)
				const fields = groupFields(family)
				const least =
					family.members.kind === "tree"
						? zero
						: call("min", [columnOf(m, family.member, family.index)])
				ctes.push(
					cte(
						name,
						[...names, slot],
						select({
							...provedCore(
								"grouped",
								[
									...fields.map((f, i) =>
										targetAs(fieldOf(m, family.member, f), defined(names[i], "a group column"))
									),
									targetAs(least, slot)
								],
								[
									join(
										tableOf(family.member, m),
										cteRef(from.name),
										keyed(m, family.member, from.name, from.keys)
									)
								],
								undefined
							),
							groupBy: fields.map((f) => fieldOf(m, family.member, f))
						})
					)
				)
				return { name, groups: names, slot }
			}
		}
	}
	const rowsCte = (rows: RowsOf): RowsCte => {
		const relation = rowsRelation(rows)
		const name = supply.relation(internal("chain rows"))
		const keys = mapNonEmpty(relation.primaryFields, () => supply.column(internal("chain key")))
		const t = supply.relation(internal("chain row"))
		const own = mapNonEmpty(relation.primaryFields, (f) => fieldOf(t, relation, f))
		const distinct = (from: FromItem, where: Expr | undefined) =>
			select(
				distinctCore(
					mapNonEmpty(own, (e, i) => targetAs(e, defined(keys[i], `key ${i}`))),
					[from],
					where
				)
			)
		const body = ((): CteBody => {
			switch (rows.kind) {
				case "put": {
					roots.push({ kind: "put", relation, slot: rows.slot })
					const input = arraysAt(w, supply, mapNonEmpty(relation.primaryFields, fieldCarried), 1)
					return select(
						distinctCore(
							mapNonEmpty(relation.primaryFields, (_, i) =>
								targetAs(input.raw(i), defined(keys[i], `key ${i}`))
							),
							[input.from],
							undefined
						)
					)
				}
				case "cascade": {
					const from = rowsCte(rows.from)
					const family = rows.family
					return distinct(
						join(
							tableOf(relation, t),
							cteRef(from.name),
							and(
								mapNonEmpty(family.group, (g) =>
									typedEq(
										g.member.type,
										fieldOf(t, relation, g.member),
										col(
											from.name,
											defined(from.keys[ownerPosition(family, g.owner)], "an owner key")
										),
										w.names
									)
								)
							)
						),
						undefined
					)
				}
				case "owners":
				case "members": {
					const from = groupsCte(rows.from)
					const family = rows.family
					const on = and(
						mapNonEmpty(groupFields(family), (f, i) => {
							const field =
								rows.kind === "owners" && family.members.kind !== "tree"
									? defined(family.group[i], "a group field").owner
									: f
							return typedEq(
								field.type,
								fieldOf(t, relation, field),
								col(from.name, defined(from.groups[i], "a group column")),
								w.names
							)
						})
					)
					const where =
						rows.kind === "members" && family.members.kind !== "tree"
							? ge(columnOf(t, relation, family.index), col(from.name, from.slot))
							: undefined
					return distinct(join(tableOf(relation, t), cteRef(from.name), on), where)
				}
			}
		})()
		ctes.push(cte(name, keys, body))
		const r = supply.relation(internal("chain read row"))
		const layout = layoutOf(relation)
		const tag = `r${sets.length}`
		sets.push({ tag, relation, layout })
		arms.push({
			tag,
			columns: rowTexts(r, relation, layout),
			from: [join(tableOf(relation, r), cteRef(name), keyed(r, relation, name, keys))],
			where: undefined
		})
		return { name, keys }
	}
	const end = ((): ChainShape["end"] => {
		if (read.kind === "rows") {
			rowsCte(read.rows)
			return { kind: "rows" }
		}
		const family = read.groups.family
		const g = groupsCte(read.groups)
		const member = family.member
		const layout = layoutOf(member)
		const m = supply.relation(internal("chain end member"))
		const onGroups = and(
			mapNonEmpty(groupFields(family), (f, i) =>
				typedEq(
					f.type,
					fieldOf(m, member, f),
					col(g.name, defined(g.groups[i], "a group column")),
					w.names
				)
			)
		)
		if (family.members.kind === "tree") {
			arms.push({
				tag: "t",
				columns: rowTexts(m, member, layout),
				from: [join(tableOf(member, m), cteRef(g.name), onGroups)],
				where: undefined
			})
			return { kind: "tree", family, layout }
		}
		const o = supply.relation(internal("chain end owner"))
		const owner = family.owner
		const shape = readShape(family, layout)
		const ownerColumns = shape.owner.columns
		arms.push({
			tag: "o",
			columns: [...family.group.map((pair) => pair.owner), ...ownerColumns].map((f) => ({
				expr: fieldOf(o, owner, f),
				delivered: deliveredColumn(f.type)
			})),
			from: [
				join(
					tableOf(owner, o),
					cteRef(g.name),
					and(
						mapNonEmpty(family.group, (pair, i) =>
							typedEq(
								pair.owner.type,
								fieldOf(o, owner, pair.owner),
								col(g.name, defined(g.groups[i], "a group column")),
								w.names
							)
						)
					)
				)
			],
			where: undefined
		})
		arms.push({
			tag: "m",
			columns: rowTexts(m, member, layout),
			from: [join(tableOf(member, m), cteRef(g.name), onGroups)],
			where: ge(
				columnOf(m, member, family.index),
				binary("-", col(g.name, g.slot), lit.int(1, types.bigint))
			)
		})
		return { kind: "suffix", family, shape, layout }
	})()
	const width = arms.reduce(
		(most, arm) => Math.max(most, deliveredWidth(arm.columns.map((c) => c.delivered))),
		0
	)
	const tagColumn = supply.column(internal("chain tag"))
	const out = Array.from({ length: width }, () => supply.column(internal("chain column")))
	const at = (i: number): string => defined(out[i], `chain column ${i}`)
	const built = arms.map((arm) =>
		taggedArm(arm, tagColumn, at, width, supply, bytesChunkLength.value)
	)
	const root = defined(roots[0], "a chain begins at a put or an edit")
	const [first, ...rest] = built
	const [firstCte, ...restCtes] = ctes
	const ast: SqlStatement = {
		...select(unionAll("disjoint", [defined(first, "a chain reads a row set"), ...rest])),
		with: {
			recursive: false,
			ctes: [defined(firstCte, "a chain's rows are a CTE"), ...restCtes]
		}
	}
	return {
		ast,
		sql: emitText(ast, supply.map()),
		root,
		shape: { rows: sets, end }
	}
}
