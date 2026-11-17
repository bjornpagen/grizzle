/** What the properties of forged.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import { nonEmpty } from "#test/support/assert.ts"
import { type CarrierName, carriers } from "#test/support/forged.ts"

/** The forged carriers whose arrays PostgreSQL reads without an extension: numeric at two typmods, and money. */
export const judged = nonEmpty(
	Arr.filter(carriers, (c) => c.host !== "vector"),
	"the carriers PostgreSQL judges"
)

/** Each judged carrier's SQL: the element type its array is read as, and the column type its values are compared at. */
export const sqlOf: {
	readonly [C in Exclude<CarrierName, "vector(3)">]: { readonly type: string }
} = {
	numeric: { type: "numeric" },
	"numeric(5,2)": { type: "numeric(5,2)" },
	money: { type: "money" }
}

export type BatchFeature = "a batch holding one value twice" | "two values" | "every input refused"
