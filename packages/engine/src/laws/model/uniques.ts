import { appendAll, sameOrder } from "#compiler/core/array.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, LawId, NodeId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	appendNonEmpty,
	dedupeNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	isSpanField,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type NativeOf,
	plainFields,
	type RelationInfo,
	type RowGuard,
	type SpanField
} from "#compiler/ir/law.ts"
import type { KeyedRelation, NamedNative, NamedPrimaryKey } from "#compiler/laws/model/model.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/** The installed constraint or unique index name of a unique object, and the law its violation reports, with its
 * description. */
interface Named {
	readonly name: ConstraintName
	readonly law: LawId
	readonly described: Law
}

/** A unique object: the handles of the fields two facts must share to conflict, in the object's order, and for a
 * UNIQUE over law columns (`guarded`) the guards both facts must meet, its columns' guards' conjuncts, for a span object
 * the span two facts' values must overlap at, its compared fields of key types as btree_gist compares them, and the
 * guards both facts must meet, none for a key over every fact. */
export type UniqueObject = Named &
	(
		| { readonly kind: "key"; readonly equal: NonEmptyReadonlyArray<LawField> }
		| {
				readonly kind: "guarded"
				readonly equal: NonEmptyReadonlyArray<LawField>
				readonly within: NonEmptyReadonlyArray<RowGuard>
		  }
		| {
				readonly kind: "span"
				readonly equal: ReadonlyArray<LawField>
				readonly span: SpanField
				readonly within: ReadonlyArray<RowGuard>
		  }
	)

/** A declared key's object: a PRIMARY KEY or UNIQUE constraint, or one WITHOUT OVERLAPS when it holds a span field, over
 * the key's own handles. */
export type PrimaryKeyObject = Named &
	(
		| { readonly kind: "key"; readonly equal: NonEmptyReadonlyArray<LawField> }
		| {
				readonly kind: "span"
				readonly equal: ReadonlyArray<LawField>
				readonly span: SpanField
				/** A declared key holds every fact apart: no guard. */
				readonly within: readonly []
		  }
	)

export interface UniqueObjects {
	readonly primary: PrimaryKeyObject
	/** Every other unique object of the relation, in law order. */
	readonly others: ReadonlyArray<UniqueObject>
	/** The relation's declared keys, the primary key first, then each other key in law order: the objects a PRIMARY
	 * KEY, UNIQUE or WITHOUT OVERLAPS constraint of a key law realizes, each with the law its violation reports. */
	readonly keys: NonEmptyReadonlyArray<PrimaryKeyObject>
}

/** The fields of an object a conflict at it names: the compared fields, then the span. */
export const witnessFields = (u: UniqueObject): ReadonlyArray<LawField> =>
	u.kind === "span" ? [...u.equal, u.span] : u.equal

/** The fields of a declared key a conflict at it names: its compared fields, then its span. */
export const keyWitness = (k: PrimaryKeyObject): NonEmptyReadonlyArray<LawField> =>
	k.kind === "span" ? appendNonEmpty(k.equal, k.span) : k.equal

/** Every field a unique object reads: those it compares and, for a guarded one, those its guards read, since a row's
 * value there moves it into or out of the object. None of these objects is ever deferrable (`NativeObject`). */
export const readFields = (u: UniqueObject): ReadonlyArray<LawField> => {
	switch (u.kind) {
		case "key":
			return u.equal
		case "guarded":
			return [...u.equal, ...u.within.flatMap((g) => g.reads)]
		case "span":
			return [...u.equal, u.span, ...u.within.flatMap((g) => g.reads)]
	}
}

/** The unique object a named native is, with its relation's handle, as a declared candidate key or another of its
 * objects; none for a primary key, which its relation's laws hold (`RelationLaws`), or any other kind. */
type Placed =
	| { readonly relation: LawRelation; readonly role: "key"; readonly object: PrimaryKeyObject }
	| { readonly relation: LawRelation; readonly role: "other"; readonly object: UniqueObject }

/** Each law column of the law model's natives by its relation's name and identifier. */
type LawColumns = ReadonlyMap<string, ReadonlyMap<ColumnIdent, NativeOf<"LawColumn">>>

/**
 * The compared fields and guards of columns over law columns (law/model/plan.ts sideColumns): two rows agree at them
 * where both meet every column's guard, so that no column is null, and agree at each column's term. A column's term
 * reads at most one field of its own row, injective where defined, so two rows agree at it where they agree at the
 * field it reads, which is read off the term itself, never off the field that types the column (a constant column's is
 * its target's, which no row of this relation holds): its compared fields are the fields its columns' terms read, none
 * for a constant, and its guards their guards' distinct conjuncts, one expression each (laws/model/model.ts
 * ColumnLowering). Undefined for columns holding a drawn law column or reading one, which the host draws apart and no
 * field determines: only a family's planner writes those rows.
 */
const compared = (
	relation: LawRelation,
	columns: NonEmptyReadonlyArray<NativeColumn>,
	lawColumns: LawColumns
):
	| { readonly equal: NonEmptyReadonlyArray<LawField>; readonly within: ReadonlyArray<RowGuard> }
	| undefined => {
	const guards = new Map<ScalarExpr, RowGuard>()
	const equal: Array<LawField> = []
	for (const c of columns) {
		if (c.kind === "field") {
			equal.push(c.field)
			continue
		}
		const native =
			lawColumns.get(relation.name)?.get(c.column) ??
			missing(relation, `the native of the law column ${c.column}`)
		if (native.value.kind === "drawn") {
			return undefined
		}
		const reads = columnReads(native.value.term)
		const fields = readsOf(relation, native.value.term)
		if (fields.length !== new Set(reads.map((r) => r.name)).size) {
			return undefined
		}
		for (const g of native.value.guard) {
			if (!guards.has(g)) {
				guards.set(g, { predicate: g, reads: readsOf(relation, g) })
			}
		}
		appendAll(equal, fields)
	}
	const [first, ...rest] = equal
	return first === undefined
		? missing(relation, "a unique object's columns, at least one")
		: { equal: dedupeNonEmpty([first, ...rest]), within: [...guards.values()] }
}

/** The unique object a UNIQUE over law columns is (`compared`): a key over its fields when its columns are total, else
 * guarded by its columns' guards. */
const projected = (
	relation: LawRelation,
	columns: NonEmptyReadonlyArray<NativeColumn>,
	lawColumns: LawColumns,
	named: Named
): UniqueObject | undefined => {
	const c = compared(relation, columns, lawColumns)
	if (c === undefined) {
		return undefined
	}
	const [first, ...rest] = c.within
	return first === undefined
		? { ...named, kind: "key", equal: c.equal }
		: { ...named, kind: "guarded", equal: c.equal, within: [first, ...rest] }
}

/** The span object a WITHOUT OVERLAPS is: its scalar columns' fields compared, its span column's field overlapped,
 * under its columns' guards. Undefined for one over a drawn law column. */
const spanObject = (
	relation: LawRelation,
	scalars: ReadonlyArray<NativeColumn>,
	span: NativeColumn,
	lawColumns: LawColumns,
	named: Named
): UniqueObject | undefined => {
	const c = compared(relation, [span, ...scalars], lawColumns)
	if (c === undefined) {
		return undefined
	}
	const [spanField, ...equal] = c.equal
	if (!isSpanField(spanField) || equal.includes(spanField)) {
		return missing(relation, "a span key's span column, a span field's values")
	}
	return { ...named, kind: "span", equal, span: spanField, within: c.within }
}

/** The fields of `relation` a row predicate reads, in declared field order. */
const readsOf = (relation: LawRelation, predicate: ScalarExpr): ReadonlyArray<LawField> => {
	const names = new Set(columnReads(predicate).map((c) => c.name))
	return relation.fields.filter((f) => names.has(f.name))
}

/** Every column a row expression reads, each a node and a column name, in the order the expression reads them. */
export const columnReads = (
	e: ScalarExpr
): ReadonlyArray<{ readonly node: NodeId; readonly name: string }> => {
	const out: Array<{ readonly node: NodeId; readonly name: string }> = []
	const visit = (x: ScalarExpr): void => {
		if (x.kind === "column") {
			out.push(x.column)
		}
		for (const a of x.args) {
			visit(a)
		}
	}
	visit(e)
	return out
}

/** A law column the law model planned on its relation is always known to it. */
const missing = (relation: LawRelation, what: string): never => {
	throw defect(`${what} of ${relation.name}, which the law model planned`)
}

const uniqueOf = (n: NamedNative, lawColumns: LawColumns): ReadonlyArray<Placed> => {
	if (n.namespace !== "constraint") {
		return []
	}
	const o = n.object
	const named = { name: identifierOf(n.named), law: o.lawIds[0], described: n.described }
	switch (o.kind) {
		case "PrimaryKey":
			return []
		case "Unique": {
			const fields = plainFields(o.columns)
			if (fields === undefined) {
				const object = projected(o.relation, o.columns, lawColumns, named)
				return object === undefined ? [] : [{ relation: o.relation, role: "other", object }]
			}
			/** A UNIQUE over a declared candidate key's fields in its order is that key's; any other is generated. */
			const declared = o.relation.keyNames.find(
				(k) => !k.primary && sameOrder<LawField>(k.fields, fields)
			)
			return declared === undefined
				? [
						{
							relation: o.relation,
							role: "other",
							object: { ...named, kind: "key", equal: fields }
						}
					]
				: [
						{
							relation: o.relation,
							role: "key",
							object: { ...named, kind: "key", equal: declared.fields }
						}
					]
		}
		case "WithoutOverlaps": {
			if (o.key.kind === "primary") {
				return []
			}
			const object = spanObject(o.relation, o.key.scalars, o.span, lawColumns, named)
			if (object?.kind !== "span") {
				return []
			}
			/** A declared span key is a key of its relation; one over a projected side holds apart only its side's rows. */
			const declared = o.relation.keyNames.some((k) => k.named === o.named)
			return declared && object.within.length === 0
				? [{ relation: o.relation, role: "key", object: { ...object, within: [] } }]
				: [{ relation: o.relation, role: "other", object }]
		}
		case "TableCheck":
		case "ClosedCheck":
		case "ForeignKey":
		case "PeriodForeignKey":
			return []
	}
}

/**
 * An ordinary relation with the unique objects the law model installs on it: every native object PostgreSQL checks as
 * a row enters its index, holding apart two facts it cannot both hold.
 *
 * - key: a PRIMARY KEY or UNIQUE constraint, two facts equal at its fields;
 * - guarded: a UNIQUE NULLS DISTINCT over law columns, two facts equal at its fields and both meeting its guards (a
 *   key over a selected side or a pred term, or the UNIQUE a reference into one needs);
 * - span: a constraint WITHOUT OVERLAPS, two facts equal at its scalar fields whose spans overlap (a span key, the
 *   primary key's among them, and the temporal unique of a PERIOD reference's selected target).
 *
 * Each relation has its primary key, a key or a span key, and its other unique objects in law order. Every reader of
 * unique objects (the put targets, the insert protocol's probes, the write's abort rules) takes them from here.
 */
export interface RelationLaws {
	readonly relation: RelationInfo
	/** Its primary key's native object, the one the law model seeds per ordinary relation. */
	readonly primaryKey: NamedPrimaryKey
	readonly uniques: UniqueObjects
}

/** A primary key as a unique object: a PRIMARY KEY's fields, or a primary key WITHOUT OVERLAPS's scalar fields and
 * span, with the law its violation reports. */
const primaryObject = (pk: NamedPrimaryKey): PrimaryKeyObject => {
	const o = pk.object
	const named = { name: identifierOf(pk.named), law: o.lawIds[0], described: pk.described }
	if (o.kind === "PrimaryKey") {
		return { ...named, kind: "key", equal: o.columns }
	}
	const fields = plainFields(o.key.scalars)
	const span = o.span.kind === "field" ? o.span.field : undefined
	if (fields === undefined || span === undefined || !isSpanField(span)) {
		return missing(o.relation, "a primary key's columns, each a field, its span a span field")
	}
	return { ...named, kind: "span", equal: fields, span, within: [] }
}

/** Each ordinary relation of `keyed` by name with its primary key and its unique objects, from a law model's natives:
 * computed once, as the model is built (LawModel.relations). A relation's natives name its handle, the one the theory
 * read. */
export const relationLaws = (
	keyed: ReadonlyArray<KeyedRelation>,
	natives: ReadonlyArray<NamedNative>
): ReadonlyMap<string, RelationLaws> => {
	const lawColumns = new Map<string, Map<ColumnIdent, NativeOf<"LawColumn">>>()
	for (const n of natives) {
		if (n.namespace !== "column") {
			continue
		}
		const own =
			lawColumns.get(n.object.relation.name) ?? new Map<ColumnIdent, NativeOf<"LawColumn">>()
		own.set(n.object.column, n.object)
		lawColumns.set(n.object.relation.name, own)
	}
	const placed = natives.flatMap((n) => uniqueOf(n, lawColumns))
	return new Map(
		keyed.map(({ relation, primaryKey }) => {
			const own = placed.filter((p) => p.relation === relation)
			const primary = primaryObject(primaryKey)
			const keys: NonEmptyReadonlyArray<PrimaryKeyObject> = [
				primary,
				...own.flatMap((o) => (o.role === "key" ? [o.object] : []))
			]
			const uniques: UniqueObjects = Object.freeze({
				primary,
				others: Object.freeze(own.map((o) => o.object)),
				keys: Object.freeze(keys)
			})
			return [relation.name, Object.freeze({ relation, primaryKey, uniques })] as const
		})
	)
}
