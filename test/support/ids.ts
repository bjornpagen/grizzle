import { contract, uuid } from "#compiler/public/fields.ts"

/**
 * A test's entity id: no column is a bare uuid (README "Identity: natural keys"), so a test relation keyed by a uuid
 * names it by this contract, one type every such test relation shares, its values `Id(uuid)`.
 */
export const Id = contract("Id", uuid)

/** An Id's value: a uuid branded as the test's id, which `Id(uuid)` makes. */
export type IdValue = ReturnType<typeof Id>
