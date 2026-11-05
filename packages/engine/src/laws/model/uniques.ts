import { sameOrder } from "#compiler/core/array.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, RaisedLawId } from "#compiler/core/ids.ts"
import { appendNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	FieldSelector,
	LawField,
	LawRelation,
	RelationInfo,
	SpanField
} from "#compiler/ir/law.ts"
import type { KeyedRelation, NamedNative, NamedPrimaryKey } from "#compiler/laws/model/model.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/** The installed constraint or unique index name of a unique object, and the law its violation reports, with its
 * description. */
interface Named {
	readonly name: ConstraintName
	readonly law: RaisedLawId
	readonly described: Law
}

/** A unique object: the handles of the fields two facts must share to conflict, in the object's order, and for a unique
 * index the selectors of the rows it holds, for a span object the span two facts' values must overlap at, its compared
 * fields of key types as btree_gist compares them. */
export type UniqueObject = Named &
	(
		| { readonly kind: "key"; readonly equal: NonEmptyReadonlyArray<LawField> }
		| {
				readonly kind: "index"
				readonly equal: NonEmptyReadonlyArray<LawField>
				readonly where: ReadonlyArray<FieldSelector>
		  }
		| { readonly kind: "span"; readonly equal: ReadonlyArray<LawField>; readonly span: SpanField }
	)

/** A declared key's object: a PRIMARY KEY or UNIQUE constraint, or one WITHOUT OVERLAPS when it holds a span field, over
 * the key's own handles. */
export type PrimaryKeyObject = Named &
	(
		| { readonly kind: "key"; readonly equal: NonEmptyReadonlyArray<LawField> }
		| { readonly kind: "span"; readonly equal: ReadonlyArray<LawField>; readonly span: SpanField }
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

/** Every field a unique object reads: those it compares and, for a unique index, those its predicate reads, since a
 * row's value there moves it into or out of the index. None of these objects is ever deferrable (`NativeObject`). */
export const readFields = (u: UniqueObject): ReadonlyArray<LawField> => {
	switch (u.kind) {
		case "key":
			return u.equal
		case "index":
			return [...u.equal, ...u.where.map((w) => w.field)]
		case "span":
			return [...u.equal, u.span]
	}
}

/** The unique object a named native is, with its relation's handle, as a declared candidate key or another of its
 * objects; none for a primary key, which its relation's laws hold (`RelationLaws`), or any other kind. */
type Placed =
	| { readonly relation: LawRelation; readonly role: "key"; readonly object: PrimaryKeyObject }
	| { readonly relation: LawRelation; readonly role: "other"; readonly object: UniqueObject }

const uniqueOf = (n: NamedNative): ReadonlyArray<Placed> => {
	if (n.namespace !== "constraint" && n.namespace !== "index") {
		return []
	}
	const o = n.object
	const named = { name: identifierOf(n.named), law: o.lawIds[0], described: n.described }
	switch (o.kind) {
		case "PrimaryKey":
			return []
		case "Unique": {
			/** A UNIQUE over a declared candidate key's fields in its order is that key's; any other is generated. */
			const declared = o.relation.keyNames.find(
				(k) => !k.primary && sameOrder<LawField>(k.fields, o.columns)
			)
			return declared === undefined
				? [
						{
							relation: o.relation,
							role: "other",
							object: { ...named, kind: "key", equal: o.columns }
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
		case "PartialUnique":
			return [
				{
					relation: o.relation,
					role: "other",
					object: { ...named, kind: "index", equal: o.columns, where: o.where }
				}
			]
		case "ArmUnique": {
			/** The key and the discriminator its arm tag is computed from: two facts equal at them are equal at the tag, and
			 * two it holds apart share the key, which holds them apart too. */
			const equal = appendNonEmpty(o.columns, o.discriminator)
			return [{ relation: o.relation, role: "other", object: { ...named, kind: "key", equal } }]
		}
		case "WithoutOverlaps":
			return o.key.kind === "primary"
				? []
				: [
						{
							relation: o.relation,
							role: "key",
							object: { ...named, kind: "span", equal: o.key.scalars, span: o.span }
						}
					]
		case "TemporalUnique":
			return [
				{
					relation: o.relation,
					role: "other",
					object: { ...named, kind: "span", equal: o.columns, span: o.span }
				}
			]
		case "TableCheck":
		case "FiniteCheck":
		case "ForeignKey":
		case "TaggedForeignKey":
		case "ArmForeignKey":
		case "PeriodForeignKey":
		case "TaggedPeriodForeignKey":
			return []
	}
}

/**
 * An ordinary relation with the unique objects the law model installs on it: every native object PostgreSQL checks as
 * a row enters its index, holding apart two facts it cannot both hold.
 *
 * - key: a PRIMARY KEY or UNIQUE constraint, two facts equal at its fields;
 * - index: a unique index, two facts equal at its fields and both within its predicate (the partial unique index of an
 *   at-most-one capacity, with no predicate when the capacity selects nothing);
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
	return o.kind === "PrimaryKey"
		? { ...named, kind: "key", equal: o.columns }
		: { ...named, kind: "span", equal: o.key.scalars, span: o.span }
}

/** Each ordinary relation of `keyed` by name with its primary key and its unique objects, from a law model's natives:
 * computed once, as the model is built (LawModel.relations). A relation's natives name its handle, the one the theory
 * read. */
export const relationLaws = (
	keyed: ReadonlyArray<KeyedRelation>,
	natives: ReadonlyArray<NamedNative>
): ReadonlyMap<string, RelationLaws> => {
	const placed = natives.flatMap(uniqueOf)
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
