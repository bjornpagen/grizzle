/** What the properties of payload.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { String as Str } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { parseLiveSecret, sealNonce } from "#compiler/live/notify.ts"
import { succeeded } from "#test/support/assert.ts"

export const BYTE_ORDER_MARK = "\uFEFF"

/** The scalars a drawn value is made of. */
const palette = [BYTE_ORDER_MARK, "a", "é", "€", "😀", "\uFFFD"] as const

/** A byte no UTF-8 sequence holds (Unicode 3.9, table 3-7). */
export const notUtf8 = 0xff

/** A case: each notification's value as its scalars, and whether one byte of the batch is made no UTF-8, at which. */
interface PayloadCase {
	readonly values: ReadonlyArray<ReadonlyArray<string>>
	readonly fault: boolean
	readonly at: number
}

export const caseGen: Gen<PayloadCase> = (source) => ({
	values: source.draw(array(array(element(palette), { min: 1, max: 4 }), { min: 1, max: 3 })),
	fault: source.draw(boolean),
	at: source.draw(int(0, 64))
})

export type PayloadFeature =
	| "a batch opened"
	| "an authenticated batch that is no UTF-8 a defect"
	| "a value that begins with U+FEFF"
	| "a batch of several notifications"

/** The installation's live secret and one payload's nonce: any of their lengths seals and opens alike. */
export const secret = succeeded(
	parseLiveSecret(Str.repeat(32)("0f")),
	"a secret of 32 bytes in hex"
)

export const nonce = succeeded(sealNonce(new Uint8Array(12)), "a nonce of 12 bytes")

export const table = admittedIdentifier<"table">("item")

export const column = admittedIdentifier<"column">("tag")
