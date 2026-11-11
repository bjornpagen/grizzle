/**
 * A write statement's reads of stored relations, each driven by rows the statement holds: a probe of a key or a group
 * (sql/ast.ts FromSource `probe`), or the row an arbitration met (`met`). These are the only reads of a stored table a
 * write statement holds, so none reads a relation whole: PostgreSQL plans each apart, once per driving row, and a
 * driver of no row reads nothing (sql/ast.ts). A described member's query is its application's read, which the query
 * lowering builds, never one of these.
 */
import { defined } from "#compiler/core/invariant.ts"
import { appendNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { columnReads, type UniqueObject } from "#compiler/laws/model/uniques.ts"
import type { ColumnMap, Env, LowerContext } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { isVectorType } from "#compiler/lower/conservative/vector/equality.ts"
import type { DrivenColumn, Expr, FromSource, MetKey, ProbeColumn } from "#compiler/sql/ast.ts"
import { binary, col, exists, lit, simpleSelect, target, types } from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { rowType, type WriteContext } from "#compiler/write/insert/statement.ts"

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** A driven read: its FROM source, and each column it delivers read by its installed name under the source's alias. */
export interface Driven {
	readonly source: FromSource
	readonly at: (column: string) => Expr
}

/** What a driven read delivers and narrows to: its columns, at least one, and its conditions over the probed row, read
 * under the alias `inner` names. */
export interface DrivenRead {
	readonly read: NonEmptyReadonlyArray<string>
	readonly filter: (inner: string) => ReadonlyArray<Expr>
}

/** Where a driven read reaches a relation's rows: each column bound to a value of the driving row, none at a span key
 * of no scalar, the conditions over the probed row, read under the alias `inner` names, that narrow it further, its
 * span's overlap among them there, and the columns that place it, which an existence read delivers. */
export interface Access {
	readonly key: ReadonlyArray<ProbeColumn>
	readonly filter: (inner: string) => ReadonlyArray<Expr>
	readonly placed: NonEmptyReadonlyArray<string>
}

/**
 * The guards a row, its fields read through `of`, meets to be held by a unique object: each of a `guarded` object's
 * guards, a conjunct of its law columns' guards, lowered over the row; none for an object over fields alone, which
 * holds every row.
 */
export const withinRow = (
	cx: LowerContext,
	u: UniqueObject,
	of: (f: LawField) => Expr
): ReadonlyArray<Expr> =>
	u.kind === "guarded"
		? u.within.map((g) => {
				const columns: ColumnMap = new Map(g.reads.map((f) => [f.name, of(f)] as const))
				const env: Env = new Map(columnReads(g.predicate).map((c) => [c.node, columns] as const))
				return lowerExpr(cx, g.predicate, env)
			})
		: []

/**
 * The columns a driven read delivers, each stored column of `read` under a generated name of the statement's own, and
 * each stored column read under its source's alias by that name.
 */
const delivered = (
	supply: NameSupply,
	alias: string,
	read: NonEmptyReadonlyArray<string>
): {
	readonly columns: NonEmptyReadonlyArray<DrivenColumn>
	readonly at: (column: string) => Expr
} => {
	const columns = mapNonEmpty(read, (column) => ({
		read: column,
		as: supply.column(internal("driven column"))
	}))
	return {
		columns,
		at: (column) =>
			col(
				alias,
				defined(
					columns.find((c) => c.read === column),
					`the driven column ${column}`
				).as
			)
	}
}

/** A field of `relation` bound to `value`, compared at its type: through the extension's operator over a vector. */
export const bound = (
	w: WriteContext,
	relation: string,
	f: LawField,
	value: Expr
): ProbeColumn => ({
	column: w.names.column(relation, f.name),
	value,
	schema: isVectorType(rowType(f)) ? w.names.vectorSchema : undefined
})

/** `fields` of `relation` bound to their values (`bound`), with no further condition. */
export const atFields = (
	w: WriteContext,
	relation: string,
	fields: NonEmptyReadonlyArray<LawField>,
	value: (f: LawField) => Expr
): Access => ({
	key: mapNonEmpty(fields, (f) => bound(w, relation, f, value(f))),
	filter: () => [],
	placed: mapNonEmpty(fields, (f) => w.names.column(relation, f.name))
})

/**
 * Where a row of `relation` given by `value` conflicts at the unique object `u`: its compared fields bound, and over the
 * probed row u's guards and, at a span object, its span overlapping the given one.
 */
export const atObject = (
	w: WriteContext,
	relation: string,
	u: UniqueObject,
	value: (f: LawField) => Expr
): Access => ({
	key: u.equal.map((f) => bound(w, relation, f, value(f))),
	filter: (inner) => {
		const stored = (f: LawField): Expr => col(inner, w.names.column(relation, f.name))
		const guards = withinRow(w.cx, u, stored)
		return u.kind === "span" ? [...guards, binary("&&", stored(u.span), value(u.span))] : guards
	},
	placed: placedBy(w, relation, u)
})

/** The row of stored `relation` at a key of a driving row, at most one (FromSource `probe` by key). */
export const probeKey = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: Access,
	read: NonEmptyReadonlyArray<string>
): Driven => {
	const inner = supply.relation(internal(`probed ${relation}`))
	const alias = supply.relation(internal(`probed ${relation} row`))
	const out = delivered(supply, alias, read)
	return {
		source: {
			kind: "probe",
			table: w.names.relation(relation),
			inner,
			by: { kind: "key", columns: access.key },
			filter: access.filter(inner),
			columns: out.columns,
			alias
		},
		at: out.at
	}
}

/** The rows of stored `relation` in a group of a driving row in `order` (FromSource `probe` by group), or only the last
 * of them (`last`). */
export const probeGroup = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	how: "group" | "last",
	group: NonEmptyReadonlyArray<ProbeColumn>,
	order: NonEmptyReadonlyArray<string>,
	read: DrivenRead
): Driven => {
	const inner = supply.relation(internal(`probed ${relation} group`))
	const alias = supply.relation(internal(`probed ${relation} member`))
	const out = delivered(supply, alias, read.read)
	return {
		source: {
			kind: "probe",
			table: w.names.relation(relation),
			inner,
			by: { kind: how, columns: group, order },
			filter: read.filter(inner),
			columns: out.columns,
			alias
		},
		at: out.at
	}
}

/** Whether stored `relation` holds a row where `access` reaches it from the evaluating row: EXISTS over its probe. */
export const storedAt = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: Access
): Expr =>
	exists(
		simpleSelect(
			[target(lit.int(1, types.integer))],
			[probeKey(w, supply, relation, access, access.placed).source],
			undefined
		)
	)

/** Where a met row of the `metRows` source `rows` reaches a relation's rows: each column bound to a column of `rows`,
 * and the conditions over the stored row, read under the alias `inner` names, that narrow it further. */
export interface MetAccess {
	readonly rows: string
	readonly key: ReadonlyArray<MetKey>
	readonly filter: (inner: string) => ReadonlyArray<Expr>
	readonly placed: NonEmptyReadonlyArray<string>
}

/**
 * Where a met row of `rows`, each field of `relation` its column `column(f)`, conflicts at the unique object `u`: u's
 * compared fields bound to its columns, and over the stored row u's guards and, at a span object, its span overlapping
 * the met row's.
 */
export const metAtObject = (
	w: WriteContext,
	relation: string,
	u: UniqueObject,
	rows: string,
	column: (f: LawField) => string
): MetAccess => ({
	rows,
	placed: placedBy(w, relation, u),
	key: u.equal.map((f) => ({
		column: w.names.column(relation, f.name),
		from: column(f),
		schema: isVectorType(rowType(f)) ? w.names.vectorSchema : undefined
	})),
	filter: (inner) => {
		const stored = (f: LawField): Expr => col(inner, w.names.column(relation, f.name))
		const guards = withinRow(w.cx, u, stored)
		return u.kind === "span"
			? [...guards, binary("&&", stored(u.span), col(rows, column(u.span)))]
			: guards
	}
})

/** `access` narrowed further by `more`, conditions over the stored row read under the alias `inner` names. */
export const metNarrowed = (
	access: MetAccess,
	more: (inner: string) => ReadonlyArray<Expr>
): MetAccess => ({ ...access, filter: (inner) => [...access.filter(inner), ...more(inner)] })

/**
 * Whether the arbitration met a stored row of `relation` where `access` reaches it from the evaluating met row: EXISTS
 * over the row it met (FromSource `met`), which only the SERIALIZABLE lowering states (sql/ast.ts).
 */
export const metFound = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: MetAccess
): Expr => {
	const inner = supply.relation(internal(`met ${relation}`))
	const alias = supply.relation(internal(`met ${relation} row`))
	return exists(
		simpleSelect(
			[target(lit.int(1, types.integer))],
			[
				{
					kind: "met",
					table: w.names.relation(relation),
					inner,
					rows: access.rows,
					key: access.key,
					filter: access.filter(inner),
					columns: delivered(supply, alias, access.placed).columns,
					alias
				}
			],
			undefined
		)
	)
}

/**
 * The met rows of the INSERT `insert`, which proposes the CTE `proposed` alone (FromSource `metRows`): `proposed`'s
 * `columns`, each key field `key` paired with its column there and the INSERT's RETURNING of it.
 */
export const metRowsOf = (
	w: WriteContext,
	supply: NameSupply,
	spec: {
		readonly insert: string
		readonly proposed: string
		readonly columns: NonEmptyReadonlyArray<string>
		readonly key: NonEmptyReadonlyArray<{
			readonly field: LawField
			readonly column: string
			readonly returned: string
		}>
	}
): { readonly source: FromSource; readonly alias: string } => {
	const alias = supply.relation(internal("met rows"))
	return {
		alias,
		source: {
			kind: "metRows",
			insert: spec.insert,
			proposed: spec.proposed,
			key: mapNonEmpty(spec.key, (k) => ({
				column: k.column,
				from: k.returned,
				schema: isVectorType(rowType(k.field)) ? w.names.vectorSchema : undefined
			})),
			columns: spec.columns,
			scan: supply.relation(internal("proposed row")),
			returned: supply.relation(internal("returned row")),
			alias
		}
	}
}

/** `access` narrowed further by `more`, conditions over the probed row read under the alias `inner` names. */
export const narrowed = (access: Access, more: (inner: string) => ReadonlyArray<Expr>): Access => ({
	...access,
	filter: (inner) => [...access.filter(inner), ...more(inner)]
})

/** The columns that place a row at the unique object `u`: its compared fields', then its span's at a span object. */
const placedBy = (
	w: WriteContext,
	relation: string,
	u: UniqueObject
): NonEmptyReadonlyArray<string> => {
	const column = (f: LawField): string => w.names.column(relation, f.name)
	return u.kind === "span"
		? appendNonEmpty(u.equal.map(column), column(u.span))
		: mapNonEmpty(u.equal, column)
}
