/**
 * A sealed batch of the fan-out opens to exactly the notifications the leader sealed (live/notify.ts openPayload): its
 * plaintext is read as the UTF-8 it is (core/utf8.ts), every value byte for byte, a leading U+FEFF among them. Only a
 * holder of the live secret seals a batch, and the leader seals a batch's text, so an authenticated plaintext that is
 * no UTF-8 is a defect, never text patched with U+FFFD that routes a key no row holds.
 *
 * - Property: over drawn batches of keyed notifications, their values of a palette of scalars (U+FEFF at the start of
 *   one, U+FFFD itself, an astral scalar), each batch sealed under one secret: opened, it is exactly the notifications,
 *   in order; with one byte of its plaintext made a byte no UTF-8 holds and sealed again under the secret, opening it
 *   is a defect. Oracle: the notifications themselves, and the Unicode Standard's well-formed byte sequences (3.9,
 *   table 3-7), which 0xFF is in none of.
 *
 * Features: a batch opened, an authenticated batch that is no UTF-8 a defect, a value that begins with U+FEFF, a batch
 * of several notifications.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Formatter, String as Str } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { seal } from "#compiler/core/seal.ts"
import { utf8 } from "#compiler/core/sha256.ts"
import {
	batchesOf,
	type Notification,
	openPayload,
	parseLiveSecret,
	sealBatch,
	sealNonce
} from "#compiler/live/notify.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const BYTE_ORDER_MARK = "\uFEFF"

/** The scalars a drawn value is made of. */
const palette = [BYTE_ORDER_MARK, "a", "é", "€", "😀", "\uFFFD"] as const

/** A byte no UTF-8 sequence holds (Unicode 3.9, table 3-7). */
const notUtf8 = 0xff

/** A case: each notification's value as its scalars, and whether one byte of the batch is made no UTF-8, at which. */
interface PayloadCase {
	readonly values: ReadonlyArray<ReadonlyArray<string>>
	readonly fault: boolean
	readonly at: number
}

const caseGen: Gen<PayloadCase> = (source) => ({
	values: source.draw(array(array(element(palette), { min: 1, max: 4 }), { min: 1, max: 3 })),
	fault: source.draw(boolean),
	at: source.draw(int(0, 64))
})

type PayloadFeature =
	| "a batch opened"
	| "an authenticated batch that is no UTF-8 a defect"
	| "a value that begins with U+FEFF"
	| "a batch of several notifications"

/** The installation's live secret and one payload's nonce: any of their lengths seals and opens alike. */
const secret = succeeded(parseLiveSecret(Str.repeat(32)("0f")), "a secret of 32 bytes in hex")
const nonce = succeeded(sealNonce(new Uint8Array(12)), "a nonce of 12 bytes")

const table = admittedIdentifier<"table">("item")
const column = admittedIdentifier<"column">("tag")

describe("a sealed batch of the fan-out", () => {
	it.effect(
		"opens to exactly its notifications, every value byte for byte, and an authenticated batch that is no UTF-8 is a defect",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/live/payload",
						oracle: {
							kind: "specification",
							name: "the sealed notifications themselves, and 0xFF, which no well-formed UTF-8 holds"
						},
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<PayloadFeature>(
							[
								"a batch opened",
								"an authenticated batch that is no UTF-8 a defect",
								"a value that begins with U+FEFF",
								"a batch of several notifications"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.gen(function* () {
							const notifications = Arr.map(
								Arr.dedupe(Arr.map(k.values, (scalars) => Arr.join(scalars, ""))),
								(value): Notification => ({ kind: "keyed", table, column, value })
							)
							if (Arr.some(k.values, (scalars) => scalars[0] === BYTE_ORDER_MARK)) {
								c.note("a value that begins with U+FEFF")
							}
							if (notifications.length > 1) {
								c.note("a batch of several notifications")
							}
							const batches = batchesOf(notifications)
							assert.equal(batches.length, 1, "a few short keys are one batch")
							const batch = defined(batches[0], "the one batch")
							if (!k.fault) {
								c.note("a batch opened")
								assert.deepEqual(
									openPayload(secret, sealBatch(secret, nonce, batch)),
									{ ok: true, value: notifications },
									`the batch of ${Formatter.format(k.values)}`
								)
								return
							}
							const faulted = Uint8Array.from(utf8(batch))
							faulted[k.at % faulted.length] = notUtf8
							const opened = yield* Effect.exit(
								Effect.sync(() => openPayload(secret, seal(secret, nonce, faulted).toBase64()))
							)
							c.note("an authenticated batch that is no UTF-8 a defect")
							assert.ok(
								Exit.hasDies(opened),
								`an authenticated batch of ${Formatter.format(k.values)} that is no UTF-8 opened as ${Formatter.format(opened)}`
							)
						})
				)
			)
	)
})
