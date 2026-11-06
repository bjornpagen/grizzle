import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"

/**
 * closed.relation takes four arguments, as the type checker reads it. Typechecked only.
 *
 * The oracle is the type checker. A closed relation's migration states every constant as one hex literal, so no
 * argument chooses a form: a fifth argument, the options record a relation once declared its form by among them, is
 * typed never.
 */
const Kind = closed("Kind", ["k0", "k1"])
const Flag = closed("Flag", ["f0", "f1"])
const fields = { kind: closedId(Kind), flag: closedId(Flag) } as const
const rows = [{ kind: "k0", flag: "f1" }] as const

const Plain = closed.relation("Plain", fields, ["kind", "flag"], rows)
export const Packs = schema("Packs", { Kind, Flag, Plain }, [])

const hex = { pack: "hex" } as const

// @ts-expect-error -- TS2345: a closed relation takes four arguments, a fifth typed never
export const fifth = closed.relation("Other", fields, ["kind", "flag"], rows, hex)
