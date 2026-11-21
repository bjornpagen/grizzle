import type { FieldDesc } from "#compiler/ir/desc.ts"
import { contract, uuid } from "#compiler/public/fields.ts"
import { describedDesc } from "#compiler/schema/protocol.ts"

/** The tests' id contract's name, its domain's. */
export const idName = "Id"

/**
 * A test's entity id: no column is a bare uuid (README "Identity: natural keys"), so a test relation keyed by a uuid
 * names it by this contract, one type every such test relation shares, its values `Id(uuid)`.
 */
export const Id = contract(idName, uuid)

/** An Id's value: a uuid branded as the test's id, which `Id(uuid)` makes. */
export type IdValue = ReturnType<typeof Id>

/** Id's FieldDesc, as a description reads a field of it. */
export const idDesc: FieldDesc = describedDesc(Id, idName)
