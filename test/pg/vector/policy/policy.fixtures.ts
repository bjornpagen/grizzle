/** What the properties of policy.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Record as Rec } from "effect"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { accountA, accountB, accountC, sizes } from "#test/pg/vector/ann/support.ts"
import { nonEmpty } from "#test/support/assert.ts"

export const policySettings = Object.freeze(
	Arr.map(searchPolicySettings, (s) => `${s.parameter}=${s.value}`)
)

/** The candidates the read requests (ann/support.ts candidates). */
export const candidatesTake = 20

/** An account of the fixture, by the letter its size is listed under. */
export type AccountLabel = keyof typeof sizes

export const accountOf: { readonly [L in AccountLabel]: Uuid } = {
	A: accountA,
	B: accountB,
	C: accountC
}

export const labels = nonEmpty(Rec.keys(sizes), "the fixture's accounts")
