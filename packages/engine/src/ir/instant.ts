import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { LawId, StoredRelationName } from "#compiler/core/ids.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
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
 * (transaction_timestamp()) and h the latest instant the child holds, or none: one value for every row of the call at
 * that child, and later than every instant the child held before it. Under SERIALIZABLE, two calls that stamp one
 * child each read the other's head or are refused, so a child's instants increase in the order its calls commit,
 * whatever the clock reads (README "Instants").
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
	readonly relation: StoredRelationName
	readonly field: LawField
	readonly child: NonEmptyReadonlyArray<LawField>
}

/**
 * What stamps an instant a write leaves out: the clock `clock`, at the child the stamped row's fields `child` hold,
 * position for position with the clock's own child fields. A clock's stamp is itself at its own child.
 */
export interface StampSource {
	readonly clock: Clock
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

/** An instant field an insert's rows leave out, and what stamps it (StampSource). */
export interface Stamped {
	readonly field: LawField
	readonly stamp: StampSource
}

/** The schema's instants, each by its relation's name and its field's (InstantRole). */
export interface Instants {
	readonly roles: ReadonlyMap<StoredRelationName, ReadonlyMap<string, InstantRole>>
}

/** Whether two stamps are one: the same clock, at the same fields of the stamped row. */
export const sameStamp = (a: StampSource, b: StampSource): boolean =>
	a.clock.relation === b.clock.relation &&
	a.clock.field.name === b.clock.field.name &&
	a.child.length === b.child.length &&
	a.child.every((f, i) => b.child[i]?.name === f.name)
