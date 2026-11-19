/**
 * A sealed batch of the fan-out opens to exactly the notifications the leader sealed (live/notify.ts openPayload): its
 * plaintext is read as the UTF-8 it is (grizzle-text utf8.ts), every value byte for byte, a leading U+FEFF among them. Only a
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

import { utf8 } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Formatter } from "effect"
import { seal } from "#compiler/core/seal.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { batchesOf, type Notification, openPayload, sealBatch } from "#compiler/live/notify.ts"
import {
	BYTE_ORDER_MARK,
	caseGen,
	column,
	nonce,
	notUtf8,
	type PayloadFeature,
	secret,
	table
} from "#test/unit/live/payload.fixtures.ts"

/**
 * A sealed batch of the fan-out opens to exactly its notifications, every value byte for byte, and an authenticated
 * batch that is no UTF-8 is a defect.
 *
 * Budget: its suite's count before the conversion (unit/live/payload: 200 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aSealedBatchOfTheFanOutOpensToExactlyItsNotificationsEveryValueByteForByteAndAnAuthenticatedBatchThatIsNoUTF8IsADefect =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a batch opened",
			"an authenticated batch that is no UTF-8 a defect",
			"a value that begins with U+FEFF",
			"a batch of several notifications"
		] satisfies ReadonlyArray<Reached<PayloadFeature>>,
		check: (_, c: Case<PayloadFeature>) => (k) =>
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
				const faulted = Uint8Array.from(utf8(wellFormed(batch)))
				faulted[k.at % faulted.length] = notUtf8
				const opened = yield* Effect.exit(
					Effect.sync(() => openPayload(secret, seal(secret, nonce, faulted).toBase64()))
				)
				c.note("an authenticated batch that is no UTF-8 a defect")
				assert.ok(
					Exit.hasDies(opened),
					`an authenticated batch of ${Formatter.format(k.values)} that is no UTF-8 opened as ${Formatter.format(opened)}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the sealed notifications themselves, and 0xFF, which no well-formed UTF-8 holds"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/notify.ts",
				original: "\t\t\tutf8Text(opened),",
				replacement: "\t\t\tnew TextDecoder().decode(opened),",
				why: "openPayload reads a batch through a TextDecoder of its own, not fatal, as it did, so an authenticated batch that is no UTF-8 opens with U+FFFD in place of its fault."
			}
		]
	})
