import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import type { Equals, Expect } from "#test/types/schema/support.ts"

/**
 * A closed relation's declared pack, closed.relation(name, fields, key, rows, { pack }), as the type checker reads it.
 * Typechecked only.
 *
 * The oracle is the type checker. The options are one optional property, `pack`, of "rows" or "hex"; no options, or
 * options without it, declare rows; the value states its pack as one of the two, and no other property or form is an
 * option.
 */
const Kind = closed("Kind", ["k0", "k1"])
const Flag = closed("Flag", ["f0", "f1"])
const fields = { kind: closedId(Kind), flag: closedId(Flag) } as const
const rows = [{ kind: "k0", flag: "f1" }] as const

const Machine = closed.relation("Machine", fields, ["kind", "flag"], rows, { pack: "hex" })
const Reviewed = closed.relation("Reviewed", fields, ["kind", "flag"], rows, { pack: "rows" })
const Plain = closed.relation("Plain", fields, ["kind", "flag"], rows)
const Empty = closed.relation("Empty", fields, ["kind", "flag"], rows, {})
export const Packs = schema("Packs", { Kind, Flag, Machine, Reviewed, Plain, Empty }, [])

/** A closed relation's value states its pack as one of the two forms. */
export type PackOfMachine = Expect<Equals<(typeof Machine)["pack"], "rows" | "hex">>

const binary = { pack: "binary" } as const
const ordered = { order: "key" } as const
const hex = { pack: "hex" } as const

// @ts-expect-error -- TS2345: a pack is "rows" or "hex", and "binary" is neither
export const otherForm = closed.relation("Other", fields, ["kind", "flag"], rows, binary)

// @ts-expect-error -- TS2345: the options hold pack alone, and order is none of them
export const otherOption = closed.relation("Other", fields, ["kind", "flag"], rows, ordered)

// @ts-expect-error -- TS2345: a closed relation takes at most five arguments, a sixth typed never
export const sixth = closed.relation("Other", fields, ["kind", "flag"], rows, hex, {})
