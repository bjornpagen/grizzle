import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { LawId, StoredRelationName } from "#compiler/core/ids.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * The schema's instants: every field of the type `instant` (instantName), microseconds since the Unix epoch on the
 * database's clock, written as its relation's laws make it (ir/law.ts FieldWriting "instant", analysis/theory/instants.ts
 * instantRoles).
 *
 * An instant is a clock or a reference, nothing else:
 * - a **reference** is an instant a containment carries, from every row of its relation, into an instant field of an
 *   ordinary relation: each of its values is a stored instant there, which the containment proves;
 * - a **clock** is every other instant. It stands in its relation's primary key after at least one field, and its
 *   **child** is the key's fields before it: the clock orders each child's rows, and a write stamps it, never a caller.
 *
 * A write stamps an instant it leaves out with the call's instant of the clock that fills it (StampSource): a clock's
 * own, or for a reference the clock its containments reach, at the child the containments carry its row to. The call's
 * instant of a clock at a child is `greatest(c, h + 1)`, c the call's reading of the database's clock in microseconds
 * (transaction_timestamp()) and h the child's head, the last instant ever stamped at it, none for a child never
 * stamped: one value for every row of the call at that child, and later than every instant the child held before it.
 * The head is a row of its own, the child's row of the clock's head table, which only the stamp advances, locking it
 * until its call ends (physical/ddl/stamps.ts), so two calls that stamp one child take turns at every level, and a
 * child's instants increase in the order its calls commit, whatever the clock reads (README "Instants").
 */

/**
 * The name of the database's clock's type: the builtin contract `instant` over pg.bigint, natural's definition, so its
 * columns are installed as natural's domain (scalar/instant.ts). No other contract may take it (public/fields.ts
 * contract), and no parameter, literal, cast, contract base, span endpoint or context field is of it
 * (analysis/schema.ts), so a term of its type is a stored instant: a variable of an instant field, or a min, max, least,
 * greatest or choice of them.
 */
export const instantName = "instant"

/**
 * The refusal of an instant as a value a query or a schema states, `what`: a parameter, a relation parameter's column, a
 * literal, a typed constant, a cast's target. An instant is the database's alone, so a term of its type is a stored
 * one, and no value a caller holds is one.
 */
export const instantInputText = (what: string): string =>
	`a ${what} of a caller's type; an instant is the database's alone, stamped by the insert that adds its row or read from a stored one, never a value a caller states`

/** Whether a descriptor is instant's, by its contract's name, which no other contract takes. */
export const isInstantDesc = (desc: FieldDesc): boolean =>
	desc.kind === "contract" && desc.name === instantName

/** Whether a type is instant's, by its contract's name, which no other contract takes. */
export const isInstantType = (t: ScalarType): boolean => t.contract?.name === instantName

/** A clock: an instant no containment carries, by its relation, its field and its child, its primary key's fields
 * before it, in key order. */
export interface Clock {
	readonly kind: "clock"
	readonly relation: StoredRelationName
	readonly field: LawField
	readonly child: NonEmptyReadonlyArray<LawField>
}

/**
 * A place (ir/desc.ts Writing place): a natural last in its relation's primary key, after at least one field, its child
 * the key's fields before it, its group, which the insert that adds a row stamps `coalesce(h + 1, 0)`, h the group's
 * head, the greatest place it holds, none where it holds none: one place for every row of the call in the group, so a group's
 * places run gapless from 0 in the order its rows' calls commit, and its relation admits no put and no delete, which
 * would state a place or leave a gap. `order` is how a migration that adds the place to a table holding rows numbers
 * them (PlaceOrder), the one thing a place reads beyond its group.
 */
export interface PlaceHead {
	readonly kind: "place"
	readonly relation: StoredRelationName
	readonly field: LawField
	readonly child: NonEmptyReadonlyArray<LawField>
	readonly order: PlaceOrder
}

/**
 * How a migration that adds a place to a table holding rows numbers them (deploy/diff/backfill.ts, deploy/diff/diff.ts
 * placedColumn), the only reader of a place's order: `unordered`, no order, so every stored row takes place 0, which
 * keeps them apart at the new primary key exactly where its group holds the old one, and the migration is refused
 * anywhere else; or `by`, each group's stored rows numbered from 0 in `field`'s order, `row_number() OVER (PARTITION BY
 * <group> ORDER BY <field>) - 1`, which a key of the relation within the group and `field` makes total
 * (analysis/theory/instants.ts).
 */
export type PlaceOrder =
	| { readonly kind: "unordered" }
	| { readonly kind: "by"; readonly field: LawField }

/** What a stamp counts on from: the head of a clock or a place, the last value stamped at its child, which the child's
 * row of the head's table holds (physical/ddl/stamps.ts). */
export type Head = Clock | PlaceHead

/** Every head of the schema (Instants): each clock, which its own stamp source names, and each place, each once. A
 * reference has no head of its own: it is stamped from its clock's. */
export const headsOf = (instants: Instants): ReadonlyArray<Head> => [
	...[...instants.roles.values()].flatMap((roles) =>
		[...roles.values()].flatMap((role) =>
			role.kind === "clock" && role.stamp.head.kind === "clock" ? [role.stamp.head] : []
		)
	),
	...instants.places.values()
]

/**
 * What stamps a field a write leaves out: the head `head`, at the child the stamped row's fields `child` hold,
 * position for position with the head's own child fields. A clock's or a place's stamp is itself at its own child.
 */
export interface StampSource {
	readonly head: Head
	readonly child: NonEmptyReadonlyArray<LawField>
}

/**
 * An instant field's role (see the module's header): a clock, stamped by its own source; or a reference, carried by the
 * containments `laws`, stamped by the one clock they all reach at a child they all carry its row to, and by none where
 * they reach no clock, two, or a clock at a child they do not carry: such a reference is only ever written from a
 * stored instant.
 */
export type InstantRole =
	| { readonly kind: "clock"; readonly stamp: StampSource }
	| {
			readonly kind: "reference"
			readonly laws: NonEmptyReadonlyArray<LawId>
			readonly stamp: StampSource | undefined
	  }

/**
 * An insert's computed fields (ChangeSet.insert's third argument, write/frontend/compile.ts): each field its host rows
 * leave out, with its value, an expression over the call's scalar parameters and its clock reading alone, checked as a
 * query member's head writing that field (check/member.ts), so one value for every row of the call. The statement that
 * writes the rows evaluates the record once, one MATERIALIZED CTE of a row (write/insert/stamp.ts callValuesCte), which
 * every row that carries one of its fields joins. A record is one object, and its CTE is keyed by it.
 */
export interface Computed {
	/** Its identity among its write's records: its stratum's position and its relation's name, one record each. */
	readonly key: string
	readonly fields: NonEmptyReadonlyArray<{ readonly field: LawField; readonly expr: ScalarExpr }>
}

/** What fills a field, as a write keys the statements that must fill it together: a head's spelling (headText), or a
 * computed record's key, each filled once in its stratum. */
export const stampText = (stamp: Stamp): string =>
	stamp.kind === "head" ? headText(stamp.head) : `computed ${stamp.computed.key}`

/**
 * What fills a field an insert's rows leave out:
 * - `head`: a head's stamp at the row's child (StampSource): an instant's clock or a place, read from the greatest value
 *   the child holds;
 * - `call`: a value of the call, the field `from` of the insert's computed record (Computed), one value for every row
 *   of the call: the computed field itself in its own relation's rows, and in a member's the owner's computed field its
 *   group field pairs with (write/family/nesting.ts carriedStamps).
 */
export type Stamp =
	| ({ readonly kind: "head" } & StampSource)
	| { readonly kind: "call"; readonly computed: Computed; readonly from: string }

/** A head's stamp (Stamp `head`). */
export type HeadStamp = Extract<Stamp, { readonly kind: "head" }>

/** A field an insert's rows leave out, an instant, a place or a computed field, and what fills it (Stamp). */
export interface Stamped {
	readonly field: LawField
	readonly stamp: Stamp
}

/** A field a head stamps (Stamp `head`). */
export interface HeadStamped {
	readonly field: LawField
	readonly stamp: HeadStamp
}

/** The fields of `stamps` a head stamps, the call's values aside: the ones whose head a stamping write reads, which
 * serialize their calls and which one statement of one stratum stamps (write/frontend/instants.ts). */
export const headStamped = (stamps: ReadonlyArray<Stamped>): ReadonlyArray<HeadStamped> =>
	stamps.flatMap((s) => (s.stamp.kind === "head" ? [{ field: s.field, stamp: s.stamp }] : []))

/** The schema's instants, each by its relation's name and its field's (InstantRole), and its places, each by its
 * relation's name, which holds one at most, last in its primary key. */
export interface Instants {
	readonly roles: ReadonlyMap<StoredRelationName, ReadonlyMap<string, InstantRole>>
	readonly places: ReadonlyMap<StoredRelationName, PlaceHead>
}

/** A head's spelling, in a refusal: its relation and field. */
export const headText = (head: Head): string => `${head.relation}.${head.field.name}`

/** Whether two stamps are one: the same head, at the same fields of the stamped row. */
export const sameStamp = (a: StampSource, b: StampSource): boolean =>
	a.head.relation === b.head.relation &&
	a.head.field.name === b.head.field.name &&
	a.child.length === b.child.length &&
	a.child.every((f, i) => b.child[i]?.name === f.name)
