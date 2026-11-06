import { bits, closedId, drawn, generated, natural, pg, slot } from "#compiler/public/fields.ts"
import { closed, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import type { Equals, Expect } from "#test/types/schema/support.ts"

/**
 * A closed relation keyed by slots, slot(closedId(R), fin(O, "n")), as the type checker reads it. Typechecked only.
 *
 * The oracle is the type checker. A slot field is a closed id of its roster, so the key lists it by name, its rows hold
 * its roster's handles, and C.row over a prefix that leaves a slot open is a set over that roster. fin over a closed
 * relation names one of its natural fields, a slot reads a closed relation's fin only, and a family's fin is an
 * ordinary relation's.
 */
const Version = closed("Version", ["v0", "v1"])
const Kind = closed("Kind", ["k0", "k1"])
const Position = closed("Position", ["p0", "p1", "p2"])
const Model = closed.relation(
	"Model",
	{ version: closedId(Version), parent: closedId(Kind), positions: natural, label: closedId(Kind) },
	["version", "parent"],
	[{ version: "v0", parent: "k0", positions: 2n, label: "k1" }]
)
const position = slot(closedId(Position), fin(Model, "positions"))
const Follow = closed.relation(
	"Follow",
	{ version: closedId(Version), parent: closedId(Kind), from: position, to: position },
	["version", "parent", "from", "to"],
	[{ version: "v0", parent: "k0", from: "p0", to: "p1" }]
)
/** A prefix that leaves a slot open completes it with a set over the slot's roster, which a set field of it holds. */
const Step = relation.generated(
	"Step",
	{ id: pg.integer, version: closedId(Version), parent: closedId(Kind), from: closedId(Position) },
	["id"],
	(r) => ({ next: generated(bits(Position), Follow.row(r.version, r.parent, r.from)) })
)
export const Slotted = schema("Slotted", { Version, Kind, Position, Model, Follow, Step }, [])

/** The key lists the slot fields by name, in key order. */
export type KeyOfFollow = Expect<
	Equals<(typeof Follow)["key"], readonly ["version", "parent", "from", "to"]>
>

// @ts-expect-error -- TS2345: fin over a closed relation names a natural field, and label is a closed id
export const labelled = fin(Model, "label")

const Owner = relation("Owner", { id: pg.integer, n: drawn(natural) }, ["id"])

// @ts-expect-error -- TS2345: a slot reads a closed relation's fin, and Owner is an ordinary relation
export const overOrdinary = slot(closedId(Position), fin(Owner, "n"))

// @ts-expect-error -- TS2741: a slot is a closed id, and pg.integer lacks a closed id's roster
export const notClosed = slot(pg.integer, fin(Model, "positions"))

const Member = relation(
	"Member",
	{ version: closedId(Version), parent: closedId(Kind), at: drawn(natural) },
	["version", "parent", "at"]
)

// @ts-expect-error -- TS2345 refusal: an ordered family's side is its owner's key, then its drawn index
export const familyOverClosed = ordered(
	on(Member, "version", "parent", "at"),
	fin(Model, "positions")
)
