import type { FieldDesc } from "#compiler/ir/desc.ts"
import { contract, type Marked, mintOf, uuid } from "#compiler/public/fields.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import { describedDesc } from "#compiler/schema/protocol.ts"

/** The tests' id contract's name, its domain's. */
export const idName = "Id"

/**
 * The key of the tests' ids, the capability every mint of an Id's value takes: `toId` on the host, and Type.cast,
 * drawn and accumulated into Id in the database. Every test holds it, as every test mints ids.
 */
export const idKey = Symbol(idName)

/** The key's type, which a program states an Id's value by and which mints nothing. */
export type IdKey = typeof idKey

/** An Id's value: a uuid under the tests' id key, which `toId(uuid)` makes. */
export type IdValue = Marked<Uuid, IdKey>

/**
 * A test's entity id: no column is a bare uuid (README "Identity: natural keys"), so a test relation keyed by a uuid
 * names it by this contract, one type every such test relation shares, its values `toId(uuid)`.
 */
export const Id = contract<typeof idKey>()(idName, uuid)

/** The mint of an Id's value from its uuid. */
export const toId: (uuid: Uuid) => IdValue = mintOf(idKey)

/** Id's FieldDesc, as a description reads a field of it. */
export const idDesc: FieldDesc = describedDesc(Id, idName)
