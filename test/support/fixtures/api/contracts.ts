import { Logic } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"

/** The contracts several fixture schemas declare alike: an amount of cents, never negative, and an epoch instant. */
export const Cents = contract("Cents", pg.bigint, (x) => Logic.ge(x, 0n))
export const Instant = contract("Instant", pg.bigint)
