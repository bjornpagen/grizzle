import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, generated, pg, uuid } from "#compiler/public/fields.ts"
import {
	closed,
	type Fact,
	key,
	on,
	relation,
	type Schema,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import type { Bits as BitsOf } from "#compiler/types/fields/field.ts"
import type { Equals, Expect } from "#test/types/schema/support.ts"

/**
 * relation.generated, closed.relation and sets over a roster, as the public barrels bind them. Typechecked only; every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires.
 *
 * A generated field's term reads the row of the written fields alone: PostgreSQL's generation expression reads no
 * generated column, and the callback's row has none to read.
 */
export const Kind = closed("Kind", ["element", "text", "comment"])
export const Flag = closed("Flag", ["on", "off"])

export const Node = relation.generated(
	"Node",
	{ id: uuid, kind: closedId(Kind), depth: pg.integer },
	["id"],
	(r) => ({ next: generated(pg.integer, Compute.cast(Compute.add(r.depth, 1), pg.integer)) })
)

/** The written fields are the row's; the generated field is not. */
export const readsGenerated = relation.generated(
	"Reads",
	{ id: uuid, depth: pg.integer },
	["id"],
	(r) => ({
		next: generated(pg.integer, Compute.cast(Compute.add(r.depth, 1), pg.integer)),
		// @ts-expect-error -- TS2339: the row holds the written fields only, so no generated field reads another
		twice: generated(pg.integer, Compute.add(r.next, 1))
	})
)

/** A generated field's term is of its declared type exactly: no implicit cast. */
export const wrongType = relation.generated(
	"Wrong",
	{ id: uuid, depth: pg.integer },
	["id"],
	(r) => ({
		// @ts-expect-error -- TS2345: a generated field's term is of its declared type exactly, at its own position
		label: generated(pg.bigint, r.depth)
	})
)

/** A generated field is named apart from the written fields. */
export const twiceNamed = relation.generated(
	"Twice",
	{ id: uuid, depth: pg.integer },
	["id"],
	// @ts-expect-error -- TS2322 refusal: a generated field is named apart from the relation's written fields
	(r) => ({ depth: generated(pg.integer, r.depth) })
)

/** The primary key is over the written fields. */
export const generatedKey = relation.generated(
	"GeneratedKey",
	{ id: uuid, depth: pg.integer },
	// @ts-expect-error -- TS2322: the primary key names written fields
	["next"],
	(r) => ({ next: generated(pg.integer, Compute.cast(Compute.add(r.depth, 1), pg.integer)) })
)

/**
 * A closed relation: its key of closed ids, its rows facts of its fields. C.at reads a payload field at a key of the
 * key fields' types; C.row reads a key prefix's completions as a set over the last key field's roster.
 */
export const Allowed = closed.relation(
	"Allowed",
	{ kind: closedId(Kind), flag: closedId(Flag), weight: pg.integer },
	["kind", "flag"],
	[
		{ kind: "element", flag: "on", weight: 1 },
		{ kind: "text", flag: "off", weight: 2 }
	]
)

export const Weighted = relation.generated(
	"Weighted",
	{ id: uuid, kind: closedId(Kind), flag: closedId(Flag) },
	["id"],
	(r) => ({
		weight: generated(pg.integer, Allowed.at("weight", r.kind, r.flag)),
		flags: generated(bits(Flag), Allowed.row(r.kind))
	})
)

export type WeightedFlags = Expect<Equals<Fact<typeof Weighted>["flags"], BitsOf<typeof Flag>>>

/** C.at reads a payload field, at one key value per key field, each of its field's type. */
export const atKey = () =>
	// @ts-expect-error -- TS2345: C.at reads a payload field, never a key field
	Allowed.at("kind", "element", "on")
export const atWrongHandle = () =>
	// @ts-expect-error -- TS2345: a key value is a handle of its field's roster
	Allowed.at("weight", "element", "maybe")
/** C.row leaves exactly the last key field open. */
export const rowWhole = () =>
	// @ts-expect-error -- TS2554: C.row takes every key field but the last
	Allowed.row("element", "on")

/** A closed relation's key lists closed-id fields; a set over a roster lists each handle once. */
export const BadClosed = closed.relation(
	"BadClosed",
	{ kind: closedId(Kind), weight: pg.integer },
	// @ts-expect-error -- TS2322: a closed relation's key fields are closed ids
	["weight"],
	[]
)
export const onSet: BitsOf<typeof Flag> = Bits.of(Flag, ["on"])
// @ts-expect-error -- TS2345 refusal: a set lists each of its handles once
export const twiceSet = Bits.of(Flag, ["on", "on"])
/** A set over one roster is never a set over another. */
// @ts-expect-error -- TS2322: Bits<Flag> is not Bits<Kind>
export const crossSet: BitsOf<typeof Kind> = Bits.of(Flag, ["on"])
// @ts-expect-error -- TS2345 refusal: a roster lists each handle once
export const TwiceRoster = closed("TwiceRoster", ["a", "a"])

/**
 * A relation every field of which its caller writes is inserted, put and deleted by its whole facts: no field kind
 * leaves its additions, and no family nests at any of its fields.
 */
export const Item = relation("Item", { id: pg.bigint, v: pg.integer }, ["id"])
export const Items = schema("Items", { Item }, [])
export const itemWrites = ChangeSet.empty(Items)
	.insert(Item, [{ id: 1n, v: 2 }])
	.put(Item, [{ id: 1n, v: 3 }])
	.delete(Item, [{ id: 1n, v: 3 }])

/** So is a schema's whose statement list is generic: a relation with no drawn field owns no family and is no member. */
export const genericWrites = <St extends ReadonlyArray<Statement>>(
	s: Schema<string, { readonly Item: typeof Item }, St>
) => ChangeSet.empty(s).insert(Item, [{ id: 1n, v: 2 }])

/**
 * A key lists no set: a set's bit string, at most a roster's every code, is wider than an index entry holds, so the
 * types refuse what ownership refuses as unrepresentable.
 */
export const SetKeyed = relation(
	"SetKeyed",
	{ id: uuid, flags: bits(Flag) },
	// @ts-expect-error -- TS2322: a primary key lists no set
	["flags"]
)
export const Flagged = relation("Flagged", { id: uuid, flags: bits(Flag) }, ["id"])
// @ts-expect-error -- TS2345 refusal: a key lists no set: a set's bit string is too wide for an index entry
export const setKey = key(on(Flagged, "flags"))

/**
 * A ChangeSet's facts of one relation are a set: two facts written out with one key are refused, whatever else they
 * hold, and facts of distinct keys are admitted. An array whose key values no literal types is the run time's to
 * judge.
 */
export const distinctItems = ChangeSet.empty(Items).insert(Item, [
	{ id: 1n, v: 2 },
	{ id: 2n, v: 2 }
])
export const twiceItem = ChangeSet.empty(Items).insert(
	Item,
	// @ts-expect-error -- TS2345 refusal: a ChangeSet's facts of one relation are a set: two of these facts share a key
	[
		{ id: 1n, v: 2 },
		{ id: 1n, v: 3 }
	]
)
export const twiceDeleted = ChangeSet.empty(Items).delete(
	Item,
	// @ts-expect-error -- TS2345 refusal: a ChangeSet's facts of one relation are a set: two of these facts share a key
	[
		{ id: 1n, v: 2 },
		{ id: 1n, v: 2 }
	]
)
declare const someItems: ReadonlyArray<{ readonly id: bigint; readonly v: number }>
export const widenedItems = ChangeSet.empty(Items).put(Item, someItems)
