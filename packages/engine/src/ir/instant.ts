import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
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
 *   **child** is the key's fields before it: a write stamps it, never a caller.
 *
 * Every clock is ordered in a **scope** (ClockScope), the writes one lock serializes: the unit its relation sits under,
 * whose exclusive borrow every write of every relation of the unit holds at the unit's key, or, for a clock no unit
 * holds, its own child. A scope stamps from one head (ClockHead), the last instant ever stamped in the scope at each
 * value of its key, every clock of the scope alike. A write stamps an instant it leaves out with the call's instant of
 * the clock that fills it (ClockStamp): a clock's own, or for a reference the clock its containments reach, at the child
 * the containments carry its row to. The call's instant at a key of a scope is `greatest(c, h + 1)`, c the call's
 * reading of the database's clock in microseconds (transaction_timestamp()) and h the key's head, none for a key never
 * stamped: one value for every row of the call at that key, of every clock of the scope, and later than every instant
 * the scope held there before it. The head is a row of its own, the key's row of the scope's head table, which only the
 * stamp advances, locking it until its call ends (physical/ddl/stamps.ts), so two calls that stamp one key take turns at
 * every level, and a scope's instants increase in the order its calls commit, across every clock it holds, whatever the
 * clock reads (docs/reads-and-writes.md "Instants", scopeOrder).
 */

/**
 * The name of the database's clock's type: the builtin contract `instant` over int8, natural's definition, so its
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

/**
 * The scope a clock's instants are ordered in (see the module's header): the writes one lock serializes, whose every
 * stamp counts on from one head at each value of the scope's key (ClockHead):
 * - `unit`: the unit its relation sits under (schema/own.ts UnitMember), by name, whose borrow every write of every
 *   relation under it holds exclusively at the unit's key, so every clock of the unit's relations is of this one scope,
 *   keyed by the unit's heading, and orders their instants together at no lock the writes did not already take;
 * - `child`: the clock's own child, for a clock no unit holds, by its relation and field: nothing serializes its writes
 *   with another clock's, so it orders its own child's rows alone.
 */
export type ClockScope =
	| { readonly kind: "unit"; readonly unit: string }
	| { readonly kind: "child"; readonly relation: StoredRelationName; readonly field: string }

/**
 * A scope's head (ClockScope): the last instant ever stamped in the scope at each value of its key, the key's row of the
 * head's table, which only the scope's stamp function advances (physical/ddl/stamps.ts). `key` is its key's fields as
 * the first of its clocks by relation name holds them, the unit's heading or the clock's child, which every clock of the
 * scope holds first in its child, by name and type; `type` is its instants' type, instant's, every clock's.
 */
export interface ClockHead {
	readonly kind: "clock"
	readonly scope: ClockScope
	readonly key: NonEmptyReadonlyArray<LawField>
	readonly type: ScalarType
}

/**
 * A clock: an instant no containment carries, by its relation, its field, its child, its primary key's fields before
 * it, in key order, and the head of the scope it is ordered in, whose key the first of its child hold.
 */
export interface Clock {
	readonly kind: "clock"
	readonly relation: StoredRelationName
	readonly field: LawField
	readonly child: NonEmptyReadonlyArray<LawField>
	readonly head: ClockHead
}

/** A clock's spelling, in a refusal: its relation and field. */
const clockText = (clock: Clock): string => `${clock.relation}.${clock.field.name}`

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

/** What a stamp counts on from: a scope's head (ClockHead), or a place's, each the last value stamped at a value of its
 * key, which the key's row of the head's table holds (physical/ddl/stamps.ts). */
export type Head = ClockHead | PlaceHead

/** A head's key: a scope's key, or a place's group. */
export const headKey = (head: Head): NonEmptyReadonlyArray<LawField> =>
	head.kind === "clock" ? head.key : head.child

/** Every clock of the schema (Instants), each once, by relation name and then field in declared order. */
export const clocksOf = (instants: Instants): ReadonlyArray<Clock> =>
	[...instants.roles.values()].flatMap((roles) =>
		[...roles.values()].flatMap((role) => (role.kind === "clock" ? [role.stamp.clock] : []))
	)

/** Every head of the schema (Instants): each scope's, once, as its first clock meets it, and each place's. A
 * reference has no head of its own: it is stamped from its clock's. */
export const headsOf = (instants: Instants): ReadonlyArray<Head> => {
	const scopes = new Map<string, ClockHead>()
	for (const clock of clocksOf(instants)) {
		scopes.getOrInsert(headText(clock.head), clock.head)
	}
	return [...scopes.values(), ...instants.places.values()]
}

/** The clocks a scope's head stamps, in clocksOf's order: every clock of its scope. */
export const clocksUnder = (instants: Instants, head: ClockHead): ReadonlyArray<Clock> =>
	clocksOf(instants).filter((c) => sameHead(c.head, head))

/**
 * What stamps an instant a write leaves out: the clock `clock`, at the child the stamped row's fields `child` hold,
 * position for position with the clock's own child fields, its call's instant of the clock's scope at the first of them
 * (stampAt). A clock's own stamp is itself at its own child.
 */
export interface ClockStamp {
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
	| { readonly kind: "clock"; readonly stamp: ClockStamp }
	| {
			readonly kind: "reference"
			readonly laws: NonEmptyReadonlyArray<LawId>
			readonly stamp: ClockStamp | undefined
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

/** What fills a field, as a write keys the statements that must fill it together: a clock's or a place's spelling
 * (clockText, headText), or a computed record's key, each filled once in its stratum. A clock's own rows and its references'
 * share its spelling; two clocks of one scope do not, since each stamps rows of its own relation, which no other
 * clock's stamp meets at its key. */
export const stampText = (stamp: Stamp): string => {
	switch (stamp.kind) {
		case "clock":
			return clockText(stamp.clock)
		case "place":
			return headText(stamp.place)
		case "call":
			return `computed ${stamp.computed.key}`
	}
}

/**
 * What fills a field an insert's rows leave out:
 * - `clock`: an instant's clock at the row's child (ClockStamp), its call's instant of the clock's scope there;
 * - `place`: a place at the row's group, `child` the row's fields position for position with the place's group, read
 *   from the greatest place the group holds;
 * - `call`: a value of the call, the field `from` of the insert's computed record (Computed), one value for every row
 *   of the call: the computed field itself in its own relation's rows, and in a member's the owner's computed field its
 *   group field pairs with (write/family/nesting.ts carriedStamps).
 */
export type Stamp =
	| ({ readonly kind: "clock" } & ClockStamp)
	| {
			readonly kind: "place"
			readonly place: PlaceHead
			readonly child: NonEmptyReadonlyArray<LawField>
	  }
	| { readonly kind: "call"; readonly computed: Computed; readonly from: string }

/** A head's stamp (Stamp `clock` or `place`). */
export type HeadStamp = Exclude<Stamp, { readonly kind: "call" }>

/** The fields of a clock stamp's row that hold its scope's key: the first of the row's child, position for position
 * with the scope's key, which the first of the clock's child hold. */
const scopeKeyOf = (stamp: ClockStamp): NonEmptyReadonlyArray<LawField> =>
	mapNonEmpty(stamp.clock.head.key, (_, i) =>
		defined(stamp.child[i], "a stamped row's field at each field of its scope's key")
	)

/**
 * Where a head's stamp reads its head: the head, and the stamped row's fields that hold its key, position for position
 * with the head's key (headKey): a clock's, its scope's head at the first of the row's child fields, which the scope's
 * key is the first of in the clock's child; a place's, itself at the row's group.
 */
export const stampAt = (
	stamp: HeadStamp
): { readonly head: Head; readonly key: NonEmptyReadonlyArray<LawField> } => {
	switch (stamp.kind) {
		case "clock":
			return { head: stamp.clock.head, key: scopeKeyOf(stamp) }
		case "place":
			return { head: stamp.place, key: stamp.child }
	}
}

/** A field an insert's rows leave out, an instant, a place or a computed field, and what fills it (Stamp). */
export interface Stamped {
	readonly field: LawField
	readonly stamp: Stamp
}

/** A field a head stamps (Stamp `clock` or `place`). */
export interface HeadStamped {
	readonly field: LawField
	readonly stamp: HeadStamp
}

/** The fields of `stamps` a head stamps, the call's values aside: the ones whose head a stamping write reads, which
 * serialize their calls and which one statement of one stratum stamps (write/frontend/instants.ts). */
export const headStamped = (stamps: ReadonlyArray<Stamped>): ReadonlyArray<HeadStamped> =>
	stamps.flatMap((s) => (s.stamp.kind === "call" ? [] : [{ field: s.field, stamp: s.stamp }]))

/** The schema's instants, each by its relation's name and its field's (InstantRole), and its places, each by its
 * relation's name, which holds one at most, last in its primary key. */
export interface Instants {
	readonly roles: ReadonlyMap<StoredRelationName, ReadonlyMap<string, InstantRole>>
	readonly places: ReadonlyMap<StoredRelationName, PlaceHead>
}

/**
 * What names a head's objects (physical/ddl/names.ts headIdentities): a unit's scope its unit, whichever level of the
 * unit stamps it; a place, or a clock no unit holds, its relation and field.
 */
export type HeadName =
	| { readonly kind: "unit"; readonly unit: string }
	| { readonly kind: "field"; readonly relation: string; readonly field: string }

/** The name of a head's objects (HeadName). */
export const headNameOf = (head: Head): HeadName => {
	switch (head.kind) {
		case "clock":
			return head.scope.kind === "unit"
				? { kind: "unit", unit: head.scope.unit }
				: { kind: "field", relation: head.scope.relation, field: head.scope.field }
		case "place":
			return { kind: "field", relation: head.relation, field: head.field.name }
	}
}

/** A head's spelling, which tells heads apart: a unit's scope by its unit, a child's by its clock, a place by itself. */
export const headText = (head: Head): string => {
	const named = headNameOf(head)
	return named.kind === "unit" ? `unit ${named.unit}` : `${named.relation}.${named.field}`
}

/** Whether two heads are one: one scope's, or one place's. */
export const sameHead = (a: Head, b: Head): boolean => headText(a) === headText(b)

/** Whether two head stamps are one: the same head, at the same fields of the stamped row (stampAt). */
export const sameStamp = (a: HeadStamp, b: HeadStamp): boolean => {
	const [x, y] = [stampAt(a), stampAt(b)]
	return (
		sameHead(x.head, y.head) &&
		x.key.length === y.key.length &&
		x.key.every((f, i) => y.key[i]?.name === f.name)
	)
}

/** Whether two clock stamps are one: the same clock, at the same fields of the stamped row. */
export const sameClockStamp = (a: ClockStamp, b: ClockStamp): boolean =>
	clockText(a.clock) === clockText(b.clock) &&
	a.child.length === b.child.length &&
	a.child.every((f, i) => b.child[i]?.name === f.name)

/**
 * The scope's order, the fact the clock gives every prover (docs/reads-and-writes.md "Instants"): a scope's instants are commit-ordered
 * across the clocks it holds. For two clocks of one head (sameHead), a row `a` of the one and a row `b` of the other
 * whose fields holding the head's key (`key` below) agree:
 *
 * - a stamped by a call that committed before b's call stamped holds a.at < b.at;
 * - a and b stamped by one call hold a.at = b.at, the call's one instant at the key;
 * - no call stamps at the key between b's call's stamp and its end: a call that stamps there while b's holds the key's
 *   head waits for it to end (READ COMMITTED) or is refused with 40001 (a transaction snapshot that cannot see it).
 *
 * So an insertion that stamps b reads every row a of the scope at b's key, stored or its call's own, at a.at <= b.at,
 * at its statements and at its COMMIT's judge alike, and every one a call before it stored at a.at < b.at: a law that
 * compares a clock's instant with another's of its scope at one key, `a.at <= b.at` judged at b's insertion, holds of
 * every row it reads there. It holds of clocks only, the instants writes stamp: a reference holds a stored instant of
 * the clock its containments reach, a stored instant (`instant.stored`) whatever its writer read.
 *
 * The scope of the clock field `relation`.`field`, its head and the fields of its relation that hold the head's key,
 * the first of its child; none for a field that is no clock.
 */
export const scopeOrder = (
	instants: Instants,
	relation: StoredRelationName,
	field: string
): { readonly head: ClockHead; readonly key: NonEmptyReadonlyArray<LawField> } | undefined => {
	const role = instants.roles.get(relation)?.get(field)
	return role?.kind === "clock"
		? { head: role.stamp.clock.head, key: scopeKeyOf(role.stamp) }
		: undefined
}
