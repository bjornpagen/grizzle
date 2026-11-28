import { Logic } from "#compiler/public/compute.ts"
import { contract, mintOf, int8 } from "#compiler/public/fields.ts"

/**
 * The contracts several fixture schemas declare alike: an amount of cents, never negative, and an epoch instant, each
 * with its key, which the fixtures that mint its values in the database hold.
 */
export const centsKey = Symbol("Cents")
export const Cents = contract<typeof centsKey>()("Cents", int8, (x) => Logic.ge(x, 0n))
export const toCents = mintOf(centsKey)
export const instantKey = Symbol("Instant")
export const Instant = contract<typeof instantKey>()("Instant", int8)
export const toInstant = mintOf(instantKey)
