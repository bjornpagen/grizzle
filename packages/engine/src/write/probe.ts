/**
 * A write statement's reads of stored relations, each driven by rows the statement holds: a probe of a key or a group
 * (sql/ast.ts FromSource `probe`), or the row an arbitration met (`met`). These are the only reads of a stored table a
 * write statement holds, so none reads a relation whole: PostgreSQL plans each apart, once per driving row, and a
 * driver of no row reads nothing (sql/ast.ts). A described member's query is its application's read, which the query
 * lowering builds, never one of these. A family write's removals and a unit delete reach stored rows through keyed
 * reads instead (write/family/keyset.ts): joins from the rows they hold, each at an access path an index serves.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	concatNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { factFieldEq, operatorSchemaOf, typedEq } from "#compiler/ir/compare.ts"
import { columnReads } from "#compiler/ir/expr.ts"
import type { LawField, NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { UniqueObject } from "#compiler/laws/model/uniques.ts"
import {
	type ColumnMap,
	type Env,
	envOf,
	type LowerContext
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type {
	DrivenColumn,
	Expr,
	FromSource,
	MetColumn,
	MetKey,
	ProbeColumn
} from "#compiler/sql/ast.ts"
import {
	binary,
	col,
	conjunction,
	cteRefAs,
	distinctCore,
	exists,
	lit,
	select,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"
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
export interface ProbeAccess {
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
				const env: Env = envOf(columnReads([g.predicate]).map((c) => [c.node, columns] as const))
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
	schema: operatorSchemaOf(w.names, rowType(f))
})

/** `fields` of `relation` bound to their values (`bound`), with no further condition. */
export const atFields = (
	w: WriteContext,
	relation: string,
	fields: NonEmptyReadonlyArray<LawField>,
	value: (f: LawField) => Expr
): ProbeAccess => ({
	key: mapNonEmpty(fields, (f) => bound(w, relation, f, value(f))),
	filter: () => [],
	placed: mapNonEmpty(fields, (f) => w.names.column(relation, f.name))
})

/** The installed name of a native column of `relation`. */
const nativeName = (w: WriteContext, relation: string, column: NativeColumn): string =>
	column.kind === "field" ? w.names.column(relation, column.field.name) : column.column

/**
 * Where a row of `relation` given by `value` conflicts at the unique object `u`: at a guarded object its UNIQUE's own
 * columns reach (uniques.ts GuardedReach `index`), each bound to the value of the field it holds, which binds its
 * guards too, so the UNIQUE's index serves the probe; at any other, its compared fields bound, and over the probed row
 * u's guards and, at a span object, its span overlapping the given one.
 */
export const atObject = (
	w: WriteContext,
	relation: string,
	u: UniqueObject,
	value: (f: LawField) => Expr
): ProbeAccess =>
	u.kind === "guarded" && u.reach.kind === "index"
		? {
				key: mapNonEmpty(u.reach.columns, (c) => ({
					column: nativeName(w, relation, c.column),
					value: value(c.field),
					schema: operatorSchemaOf(w.names, rowType(c.field))
				})),
				filter: () => [],
				placed: placedBy(w, relation, u)
			}
		: {
				key: u.equal.map((f) => bound(w, relation, f, value(f))),
				filter: (inner) => {
					const stored = (f: LawField): Expr => col(inner, w.names.column(relation, f.name))
					const guards = withinRow(w.cx, u, stored)
					return u.kind === "span"
						? [...guards, binary("&&", stored(u.span), value(u.span))]
						: guards
				},
				placed: placedBy(w, relation, u)
			}

/** The row of stored `relation` at a key of a driving row, at most one (FromSource `probe` by key). */
export const probeKey = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: ProbeAccess,
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

/**
 * A column of the one row a key probe reaches, the value it must equal there, and the type it is compared at, as one
 * fact's field (ir/compare.ts factFieldEq), a float's zero of its sign, since every check of one is a stored row's
 * repeat of a fact at its key: checked over that row once the probe's key has reached it, outside the probe, so the key and the probe's own conditions alone
 * choose the index PostgreSQL reaches the row by. Bound inside, beside the key, a column an index leads with makes that
 * index a candidate as good as the key's to a planner holding no statistics, and one a row's siblings share reads every
 * sibling per probe.
 */
export interface Equal {
	readonly column: string
	readonly value: Expr
	readonly type: ScalarType
}

/**
 * Whether a probe that delivers its columns through `at`, from the row its key reaches, holds `equal` there: `SELECT 1
 * FROM <probe> WHERE <each delivered column equal to its value>`, for an EXISTS over it.
 */
const checked = (
	w: WriteContext,
	source: FromSource,
	at: (column: string) => Expr,
	equal: ReadonlyArray<Equal>
): Expr =>
	exists(
		simpleSelect(
			[target(lit.int(1, types.integer))],
			[source],
			conjunction(equal.map((e) => factFieldEq(e.type, at(e.column), e.value, w.names)))
		)
	)

/** The columns a probe delivers to check `equal` beside `placed`, each once. */
const checkedColumns = (
	placed: NonEmptyReadonlyArray<string>,
	equal: ReadonlyArray<Equal>
): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = placed
	return [
		first,
		...[...rest, ...equal.map((e) => e.column)].filter(
			(c, i, all) => c !== first && all.indexOf(c) === i
		)
	]
}

/**
 * A row of `relation` at its primary key, given by `value`, and equal to `value` at every other field of `fields`: the
 * key bound by the probe (`atFields`), the other fields checked over the row it reaches (`Equal`).
 */
export const atRow = (
	w: WriteContext,
	relation: Pick<RelationInfo, "name" | "primaryFields">,
	fields: ReadonlyArray<LawField>,
	value: (f: LawField) => Expr
): { readonly access: ProbeAccess; readonly equal: ReadonlyArray<Equal> } => ({
	access: atFields(w, relation.name, relation.primaryFields, value),
	equal: fields
		.filter((f) => !relation.primaryFields.some((k) => k.name === f.name))
		.map((f) => ({
			column: w.names.column(relation.name, f.name),
			value: value(f),
			type: rowType(f)
		}))
})

/** Whether stored `relation` holds a row where `access` reaches it from the evaluating row, equal there at `equal`:
 * EXISTS over its probe. */
export const storedAt = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: ProbeAccess,
	equal: ReadonlyArray<Equal>
): Expr => {
	const probe = probeKey(w, supply, relation, access, checkedColumns(access.placed, equal))
	return checked(w, probe.source, probe.at, equal)
}

/** Where a met row of the `metRows` source `rows` reaches a relation's rows: each column bound to a column of `rows`,
 * and the conditions over the stored row, read under the alias `inner` names, and over the met row, that narrow it
 * further. */
export interface MetAccess {
	readonly rows: string
	readonly key: ReadonlyArray<MetKey>
	readonly filter: (inner: string) => ReadonlyArray<Expr>
	readonly placed: NonEmptyReadonlyArray<string>
}

/**
 * Where a met row of `rows`, each field of `relation` its column `column(f)`, conflicts at the unique object `u`: u's
 * compared fields bound to its columns, over the stored row u's guards and, at a span object, its span overlapping the
 * met row's, and u's guards over the met row itself. Two rows conflict at u only where both meet its guards: a met row
 * outside them is held by no row of u, so it met none there, whatever stored row of u agrees with it at u's fields.
 */
export const metAtObject = (
	w: WriteContext,
	relation: string,
	u: UniqueObject,
	rows: string,
	column: (f: LawField) => string
): MetAccess =>
	metNarrowed(
		u.kind === "guarded" && u.reach.kind === "index"
			? {
					rows,
					placed: placedBy(w, relation, u),
					key: u.reach.columns.map((c) => ({
						column: nativeName(w, relation, c.column),
						from: column(c.field),
						schema: operatorSchemaOf(w.names, rowType(c.field))
					})),
					filter: () => []
				}
			: metAtFields(w, relation, u, rows, column),
		() => withinRow(w.cx, u, (f) => col(rows, column(f)))
	)

/** A met row's access at the unique object `u` through its compared fields, its guards and its span over the stored
 * row (metAtObject). */
const metAtFields = (
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
		schema: operatorSchemaOf(w.names, rowType(f))
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
 * The stored row of `relation` the arbitration met where `access` reaches it from the evaluating met row, delivering
 * its columns `read` (FromSource `met`), which only the SERIALIZABLE lowering states (sql/ast.ts).
 */
export const metRow = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: MetAccess,
	read: NonEmptyReadonlyArray<string>
): Driven => {
	const inner = supply.relation(internal(`met ${relation}`))
	const alias = supply.relation(internal(`met ${relation} row`))
	const out = delivered(supply, alias, read)
	return {
		source: {
			kind: "met",
			table: w.names.relation(relation),
			inner,
			rows: access.rows,
			key: access.key,
			filter: access.filter(inner),
			columns: out.columns,
			alias
		},
		at: out.at
	}
}

/** Whether the arbitration met a stored row of `relation` where `access` reaches it from the evaluating met row, equal
 * there at `equal` (`Equal`): EXISTS over the row it met (`metRow`). */
export const metFound = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	access: MetAccess,
	equal: ReadonlyArray<Equal>
): Expr => {
	const met = metRow(w, supply, relation, access, checkedColumns(access.placed, equal))
	return checked(w, met.source, met.at, equal)
}

/**
 * The met rows of the INSERT `insert`, which proposes the CTE `proposed` alone (FromSource `metRows`): `proposed`'s
 * `columns`, each paired with the INSERT's RETURNING of it, and each key field `key` paired with its column there and
 * the INSERT's RETURNING of it.
 */
export const metRowsOf = (
	w: WriteContext,
	supply: NameSupply,
	spec: {
		readonly insert: string
		readonly proposed: string
		readonly columns: NonEmptyReadonlyArray<MetColumn>
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
				schema: operatorSchemaOf(w.names, rowType(k.field))
			})),
			columns: spec.columns,
			scan: supply.relation(internal("proposed row")),
			returned: supply.relation(internal("returned row")),
			sides: supply.relation(internal("met sides")),
			marker: supply.column(internal("met marker")),
			marked: supply.relation(internal("marked met")),
			hit: supply.column(internal("met hit")),
			alias
		}
	}
}

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

/** One field of a stored relation's key a write statement joins to rows it holds: the field, and the held rows' column
 * of its value, in the CTE `held` names. */
export interface HeldKey {
	readonly field: LawField
	readonly column: string
}

/**
 * The conjuncts of the stored rows of `relation`, read as `alias`, at the keys of the rows the CTE `held` holds, read as
 * `at`: each of `keys` equal to the held row's value, at its type, and, beside that equality, among the held rows' values of it
 * (`keyedAmong`), a fact the first implies, stated, so PostgreSQL reaches the stored rows by their key's index. A
 * write's UPDATE, DELETE and keyed joins of a stored relation reach it so; an index-led probe (`probeKey`) reaches one
 * row per driving row instead.
 */
export const joinedAtKey = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	alias: string,
	held: { readonly name: string; readonly at: string },
	keys: NonEmptyReadonlyArray<HeldKey>
): NonEmptyReadonlyArray<Expr> => {
	const stored = (f: LawField): Expr => col(alias, w.names.column(relation, f.name))
	return concatNonEmpty(
		mapNonEmpty(keys, (k) =>
			typedEq(rowType(k.field), stored(k.field), col(held.at, k.column), w.names)
		),
		keyedAmong(w, supply, relation, alias, held.name, keys)
	)
}

/**
 * The stored rows a write statement joins, `stored` read of each, among the values the rows of its CTE `held` give,
 * `value` reading a held row under the alias it is given: `stored = ANY (ARRAY(SELECT DISTINCT <value> FROM <held>))`,
 * at the operator of `schema` (none for a row's tid). One condition an index on `stored`'s column serves, a TID scan
 * where it is a row's tid, its array read once, so PostgreSQL reaches the stored rows by it however many rows it
 * estimates the held CTE at, a never-analyzed carrier's ten pages among them, and never reads the relation whole, which
 * under SERIALIZABLE takes a relation-level SIRead lock. Every restriction of a write's stored joins to its rows is this
 * one (`keyedAmong`, family/keyset.ts heldAmong and rowsAmong), stated beside the join's own equalities, which imply it.
 */
export const amongHeld = (
	supply: NameSupply,
	stored: Expr,
	held: string,
	value: (h: string) => Expr,
	schema: string | undefined
): Expr => {
	const h = supply.relation(internal("held key"))
	return {
		kind: "equalsAny",
		expr: stored,
		array: {
			kind: "array",
			query: select(distinctCore([target(value(h))], [cteRefAs(held, h)], undefined))
		},
		schema
	}
}

/**
 * The stored rows of `relation`, read as `alias`, among the keys the rows of the CTE `held` hold: each of `keys` among
 * the held rows' values of it (`amongHeld`). A statement whose own conditions already equate each key field with a held
 * row's, a row comparison over more fields among them, states these beside them (`joinedAtKey` is both).
 */
export const keyedAmong = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	alias: string,
	held: string,
	keys: NonEmptyReadonlyArray<HeldKey>
): NonEmptyReadonlyArray<Expr> =>
	mapNonEmpty(keys, (k) =>
		amongHeld(
			supply,
			col(alias, w.names.column(relation, k.field.name)),
			held,
			(h) => col(h, k.column),
			operatorSchemaOf(w.names, rowType(k.field))
		)
	)
