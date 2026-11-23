import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	dedupeNonEmpty,
	isNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, LawId } from "#compiler/core/ids.ts"
import { fieldReads, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	declaredKeyOf,
	isSpanField,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type NativeOf,
	plainFields,
	type RelationInfo,
	type RowGuard,
	scalarKeySet,
	type SpanField
} from "#compiler/ir/law.ts"
import type { KeyedRelation, NamedNative, NamedPrimaryKey } from "#compiler/laws/model/model.ts"
import type { RecordedLaw } from "#compiler/types/changeset/changeset.ts"

/** The installed constraint or unique index name of a unique object, and the law its violation reports, with its
 * description. */
interface Named {
	readonly name: ConstraintName
	readonly law: LawId
	readonly described: RecordedLaw
}

/**
 * A unique object's guard: a row guard of `relation`, by which two objects' guards compare (`sameGuard`), with its
 * predicate under the label the law model's DAG gives it there.
 */
export interface UniqueGuard extends RowGuard {
	readonly relation: string
}

/**
 * Whether two guards are one: guards of one relation whose predicates carry one label. Every guard is lowered by the
 * law model's extension builder, which gives each expression it builds a label of its own (ir/builder.ts
 * DagBuilder.expr), and merging the extension into the theory's DAG gives each label one fresh label past the theory's
 * (ir/dag.ts renamedPast), so one label names one predicate in a model: two guards are one exactly when their labels
 * are, the comparison of their predicates' canonical texts, which spell their labels, that it replaces.
 */
const sameGuard = (a: UniqueGuard, b: UniqueGuard): boolean =>
	a.relation === b.relation && a.predicate.id === b.predicate.id

/**
 * A column of a guarded object's UNIQUE paired with the field it holds: the field itself, or a law column holding the
 * field's own value wherever the object's guards hold and NULL elsewhere, so that two rows agree at the column exactly
 * where both meet the guards and agree at the field.
 */
export interface HeldColumn {
	readonly field: LawField
	readonly column: NativeColumn
}

/**
 * How a probe reaches a guarded object's rows: at the UNIQUE's own columns (`index`), each bound to the value of the
 * field it holds, which binds the guards too, since a row outside them holds NULL there and equals no value, so its
 * index serves the probe; or, where some column holds another term of its field, at the compared fields, the guards
 * over the probed row (`fields`), which no index of the UNIQUE serves.
 */
export type GuardedReach =
	| { readonly kind: "index"; readonly columns: NonEmptyReadonlyArray<HeldColumn> }
	| { readonly kind: "fields" }

/** A unique object: the handles of the fields two facts must share to conflict, in the object's order, and for a
 * UNIQUE over law columns (`guarded`) the guards both facts must meet, its columns' guards' conjuncts, and how a probe
 * reaches its rows, for a span object the span two facts' values must overlap at, its compared fields of key types as
 * btree_gist compares them, and the guards both facts must meet, none for a key over every fact. */
export type UniqueObject = Named &
	(
		| { readonly kind: "key"; readonly equal: NonEmptyReadonlyArray<LawField> }
		| {
				readonly kind: "guarded"
				readonly equal: NonEmptyReadonlyArray<LawField>
				readonly within: NonEmptyReadonlyArray<UniqueGuard>
				readonly reach: GuardedReach
		  }
		| {
				readonly kind: "span"
				readonly equal: ReadonlyArray<LawField>
				readonly span: SpanField
				readonly within: ReadonlyArray<UniqueGuard>
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
 * The compared fields and guards of columns over law columns (laws/model/plan.ts sideColumns): two rows agree at them
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
	| {
			readonly equal: NonEmptyReadonlyArray<LawField>
			readonly within: ReadonlyArray<UniqueGuard>
			readonly reach: GuardedReach
	  }
	| undefined => {
	const guards = new Map<ScalarExpr, UniqueGuard>()
	const equal: Array<LawField> = []
	const held: Array<HeldColumn | "another term"> = []
	for (const c of columns) {
		if (c.kind === "field") {
			equal.push(c.field)
			held.push({ field: c.field, column: c })
			continue
		}
		const native = defined(
			lawColumns.get(relation.name)?.get(c.column),
			`the native of the law column ${c.column} of ${relation.name}, which the law model planned`
		)
		if (native.value.kind === "drawn") {
			return undefined
		}
		const fields = readsOf(relation, native.value.term)
		if (fields.length !== fieldReads([native.value.term]).length) {
			return undefined
		}
		for (const g of native.value.guard) {
			guards.getOrInsertComputed(g, () => ({
				predicate: g,
				reads: readsOf(relation, g),
				relation: relation.name
			}))
		}
		appendAll(equal, fields)
		const [only, ...others] = fields
		held.push(
			native.value.term.kind === "column" && only !== undefined && !isNonEmpty(others)
				? { field: only, column: c }
				: "another term"
		)
	}
	const [first, ...rest] = equal
	const index = held.flatMap((h) => (h === "another term" ? [] : [h]))
	const [heldFirst, ...heldRest] = index
	if (first === undefined) {
		throw defect(
			`a unique object's columns, at least one, of ${relation.name}, which the law model planned`
		)
	}
	return {
		equal: dedupeNonEmpty([first, ...rest]),
		within: [...guards.values()],
		reach:
			heldFirst !== undefined && index.length === held.length
				? { kind: "index", columns: [heldFirst, ...heldRest] }
				: { kind: "fields" }
	}
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
		: { ...named, kind: "guarded", equal: c.equal, within: [first, ...rest], reach: c.reach }
}

/** The span object a WITHOUT OVERLAPS is: its scalar columns' fields compared, its span column's field overlapped,
 * under its columns' guards. Undefined for one over a drawn law column. */
const spanObject = (
	relation: LawRelation,
	scalars: ReadonlyArray<NativeColumn>,
	span: NativeColumn,
	lawColumns: LawColumns,
	named: Named
): Extract<UniqueObject, { readonly kind: "span" }> | undefined => {
	const c = compared(relation, [span, ...scalars], lawColumns)
	if (c === undefined) {
		return undefined
	}
	const [spanField, ...equal] = c.equal
	if (!isSpanField(spanField) || equal.includes(spanField)) {
		throw defect(
			`a span key's span column, a span field's values, of ${relation.name}, which the law model planned`
		)
	}
	return { ...named, kind: "span", equal, span: spanField, within: c.within }
}

/** The fields of `relation` a row predicate reads, in declared field order. */
const readsOf = (relation: LawRelation, predicate: ScalarExpr): ReadonlyArray<LawField> => {
	const names = new Set(fieldReads([predicate]))
	return relation.fields.filter((f) => names.has(f.name))
}

/** A law column the law model planned on its relation is always known to it. */
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
			if (o.relation.kind === "stored") {
				return []
			}
			const fields = plainFields(o.columns)
			if (fields === undefined) {
				const object = projected(o.relation, o.columns, lawColumns, named)
				return object === undefined ? [] : [{ relation: o.relation, role: "other", object }]
			}
			/** A UNIQUE over a declared candidate key's set is that key's (model.ts nativeIdentity); any other is
			 * generated. */
			const declared = declaredKeyOf(o.relation, scalarKeySet(o.relation.name, o.columns))
			return declared === undefined || declared.primary
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
			if (object === undefined) {
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
	/**
	 * The unique objects an addition meets beyond its primary key (`beyondPrimary`), decided once as the law model is
	 * built: what a write's probes and a role's probe functions read.
	 */
	readonly beyond: ReadonlyArray<UniqueObject>
	/**
	 * Whether every native unique and exclusion object of the relation is a unique object here (`uniques`): none over a
	 * drawn law column, such as a family's slot, whose conflicts no compared field names.
	 */
	readonly named: boolean
}

/**
 * Whether the object `w` holds apart every two facts `u` holds apart: neither is a span object, `u` compares every
 * field `w` compares, and holds every fact `w` holds, its guards among `u`'s (`sameGuard`).
 * Two facts `u` holds equal are then equal where `w` compares, and both meet `w`'s guards, so `u` holds no two facts
 * apart that `w` does not.
 */
const subsumes = (w: UniqueObject | PrimaryKeyObject, u: UniqueObject): boolean =>
	w.kind !== "span" &&
	u.kind !== "span" &&
	w.equal.every((f) => u.equal.includes(f)) &&
	(w.kind === "key" ||
		w.within.every((g) => (u.kind === "guarded" ? u.within.some((h) => sameGuard(h, g)) : false)))

/**
 * The unique objects of a relation an addition meets beyond its primary key: every other object, but one another
 * object subsumes (`subsumes`), the primary key or one before it, which holds no two facts apart that the other does
 * not: a family's superkeys on its owner, which compare its primary key, and the targets of its predecessor and last
 * axes on its members, which compare its family key. The law model decides it once per relation (RelationLaws.beyond).
 */
const beyondPrimary = (uniques: UniqueObjects): ReadonlyArray<UniqueObject> =>
	uniques.others.filter(
		(u, i) =>
			!subsumes(uniques.primary, u) &&
			!uniques.others.some((w, j) => j !== i && subsumes(w, u) && (j < i || !subsumes(u, w)))
	)

/** A primary key as a unique object: a PRIMARY KEY's fields, or a primary key WITHOUT OVERLAPS's scalar fields and
 * span, with the law its violation reports. */
const primaryObject = (pk: NamedPrimaryKey): PrimaryKeyObject => {
	const o = pk.object
	const named = { name: identifierOf(pk.named), law: o.lawIds[0], described: pk.described }
	if (o.kind === "PrimaryKey") {
		return { ...named, kind: "key", equal: o.columns }
	}
	return {
		...named,
		kind: "span",
		equal: o.key.scalars.map((c) => c.field),
		span: o.span.field,
		within: []
	}
}

/** Each ordinary relation of `keyed` by name with its primary key and its unique objects, from a law model's natives on
 * it: computed once, as the model is built (LawModel.relations). A relation's natives name its handle, the one the
 * theory read. The model holds every native of a keyed relation, and of any other only those a read relies on, so no
 * other relation's natives are read here. */
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
	const keyedNames = new Set(keyed.map((k) => k.relation.name))
	const unnamed = new Set<string>()
	const placed = Map.groupBy(
		natives.flatMap((n) => {
			if (n.namespace !== "constraint" || !keyedNames.has(n.object.relation.name)) {
				return []
			}
			const own = uniqueOf(n, lawColumns)
			const o = n.object
			if (
				own.length === 0 &&
				(o.kind === "Unique" || (o.kind === "WithoutOverlaps" && o.key.kind !== "primary"))
			) {
				unnamed.add(o.relation.name)
			}
			return own
		}),
		(p) => p.relation
	)
	return new Map(
		keyed.map(({ relation, primaryKey }) => {
			const own = placed.get(relation) ?? []
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
			const beyond = Object.freeze(beyondPrimary(uniques))
			const guardedSpan = own.find(
				(o) => o.object.kind === "span" && o.object.equal.length === 0 && o.object.within.length > 0
			)
			if (guardedSpan !== undefined) {
				throw new Refusal(
					unsupported(
						relation.loc,
						`a span-alone key over a selected side of ${relation.name} (${guardedSpan.object.name}), whose selection a write's probe and pair check do not read`
					)
				)
			}
			return [
				relation.name,
				Object.freeze({ relation, primaryKey, uniques, beyond, named: !unnamed.has(relation.name) })
			] as const
		})
	)
}
