/**
 * A SHA-256 digest on the host (scalar/values/sha256.ts Sha256): its hex, the one text it has where something renders
 * it as an outside name, a queue message's key among them, and the comparison of two digests, which are arrays.
 *
 * - Hex: toHex writes a digest's bytes as two lowercase hex digits a byte, and fromHex reads exactly that text back into
 *   a fresh array of the same bytes, so each digest has one hex and each hex one digest; any other text, an uppercase
 *   digit, another length or a character no hex digit, is sha256Syntax. Oracle: a second implementation, the bytes
 *   written one by one.
 * - Equality: equals holds of two digests exactly where their bytes are one, whatever arrays hold them. Oracle: the
 *   bytes, each written as hex one by one.
 * - Evaluation: the host evaluator (program/evaluate.ts) admits a row holding two digests and judges their equality by
 *   their bytes, as PostgreSQL's bytea equality does, never by the arrays holding them. Oracle: the bytes.
 *
 * Features: each form of a text fromHex reads; one digest in two arrays and two messages' digests.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { Sha256 } from "#compiler/public/fields.ts"
import { hexOf } from "#test/support/unit/values/support.ts"
import {
	type DigestPair,
	digestPairs,
	type HexCase,
	type HexForm,
	hexCases,
	hexForms,
	Pair,
	type PairForm,
	Pairs,
	pairForms
} from "#test/unit/values/sha256.fixtures.ts"

/**
 * A digest's hex is its bytes, two lowercase hex digits a byte, and fromHex reads back exactly the text toHex writes.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDigestsHexIsItsBytesInLowercaseAndFromHexReadsBackExactlyWhatToHexWrites =
	property.explore(hexCases, {
		needs: {},
		situations: hexForms satisfies ReadonlyArray<Reached<HexForm>>,
		check: (_, c: Case<HexForm>) => (k: HexCase) =>
			Effect.sync(() => {
				c.note(k.form)
				const read = Sha256.fromHex(k.text)
				if (k.form !== "a digest's hex") {
					assert.ok(
						!read.ok && read.error === "sha256Syntax",
						`${k.form}, ${Formatter.format(k.text)}, is sha256Syntax: ${Formatter.format(read)}`
					)
					return
				}
				assert.equal(
					Sha256.toHex(k.digest),
					k.text,
					"toHex writes the digest's bytes as lowercase hex"
				)
				if (!read.ok) {
					return assert.fail(`fromHex refuses a digest's hex ${k.text}: ${read.error}`)
				}
				assert.equal(hexOf(read.value), k.text, "fromHex reads the bytes the hex writes")
				assert.ok(read.value !== k.digest, "fromHex's digest is an array of its own")
				assert.equal(Sha256.toHex(read.value), k.text, "toHex of what fromHex read is the hex read")
			}),
		oracle: {
			kind: "second-implementation",
			name: "a digest's bytes written as hex one by one"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/digest.ts",
				original: "(code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66)",
				replacement:
					"(code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46)",
				why: "fromHex admits an uppercase digit, so a digest has two hexes and a key read back from one names no key the other wrote."
			},
			{
				file: "packages/engine/src/core/digest.ts",
				original: "if (text.length !== digestHexLength) {",
				replacement: "if (text.length === 0) {",
				why: "fromHex admits a hex of another length, a digest of other than 32 bytes the digest domain refuses, or throws on an odd one."
			},
			{
				file: "packages/engine/src/core/digest.ts",
				original: "if (!isLowerHexDigit(text.charCodeAt(position))) {",
				replacement: "if (Number.isNaN(text.charCodeAt(position))) {",
				why: "fromHex reads a text holding a character no hex digit, and throws where it should refuse."
			},
			{
				file: "packages/engine/src/scalar/values/sha256.ts",
				original: "const toHex = (digest: Sha256): string => digestHex(digest)",
				replacement: "const toHex = (digest: Sha256): string => digestHex(digest).toUpperCase()",
				why: "toHex writes uppercase, which no digest's hex is and fromHex refuses: no digest survives its round trip."
			}
		]
	})

/**
 * Two digests are equal exactly where their bytes are one, whatever arrays hold them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const twoDigestsAreEqualExactlyWhereTheirBytesAreOne = property.explore(digestPairs, {
	needs: {},
	situations: pairForms satisfies ReadonlyArray<Reached<PairForm>>,
	check: (_, c: Case<PairForm>) => (pair: DigestPair) =>
		Effect.sync(() => {
			c.note(pair.form)
			const one = hexOf(pair.first) === hexOf(pair.second)
			assert.equal(
				one,
				pair.form === "one digest in two arrays",
				"a pair's digests are one by its form"
			)
			assert.equal(
				Sha256.equals(pair.first, pair.second),
				one,
				"equals holds exactly where the bytes are one"
			)
			assert.equal(Sha256.equals(pair.second, pair.first), one, "equals is symmetric")
			assert.ok(Sha256.equals(pair.first, pair.first), "equals is reflexive")
		}),
	oracle: {
		kind: "second-implementation",
		name: "the digests' bytes written as hex one by one"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/values/sha256.ts",
			original: "const equals = (a: Sha256, b: Sha256): boolean => sameBytes(a, b)",
			replacement: "const equals = (a: Sha256, b: Sha256): boolean => a === b",
			why: "equals compares the arrays holding two digests, so one digest read twice is two digests and a dedupe keeps both."
		}
	]
})

/** The evaluator every case evaluates through, the schema compiled once. */
const evaluate = Result.getOrThrow(rowEvaluator(Pairs))

/**
 * The host evaluator admits a row of two digests and judges them equal exactly where their bytes are one.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theHostEvaluatorAdmitsDigestsAndHoldsTwoEqualExactlyWhereTheirBytesAreOne =
	property.explore(digestPairs, {
		needs: {},
		situations: pairForms satisfies ReadonlyArray<Reached<PairForm>>,
		check: (_, c: Case<PairForm>) => (pair: DigestPair) =>
			Effect.sync(() => {
				c.note(pair.form)
				const admitted = evaluate.admit(Pair, { id: 0, first: pair.first, second: pair.second })
				if (Result.isFailure(admitted)) {
					return assert.fail(
						`a row of two digests is refused: ${Formatter.format(admitted.failure)}`
					)
				}
				const verdict = evaluate(Pair, admitted.success).checks.Same
				assert.deepEqual(
					Result.isSuccess(verdict) ? verdict.success : `no verdict: ${verdict.failure.why}`,
					hexOf(pair.first) === hexOf(pair.second) ? "holds" : "breaks",
					"the check that two digests are one holds exactly where their bytes are one"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the digests' bytes written as hex one by one"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original:
					'carrier === "bytes" && value instanceof Uint8Array ? new AdmittedBytes(value) : value',
				replacement: "value instanceof Uint8Array ? new AdmittedBytes(value) : value",
				why: "The evaluator holds a digest as a bytes value with its digest, no digest's host value, and throws at the first read of a row holding one."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tsha256: false,",
				replacement: "\tsha256: true,",
				why: "The evaluator compares two digests by the arrays holding them, so one digest in two arrays is two digests and the check breaks."
			}
		]
	})
