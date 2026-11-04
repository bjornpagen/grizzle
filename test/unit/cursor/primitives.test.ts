import { Buffer } from "node:buffer"
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import {
	array,
	bytes,
	element,
	int,
	map,
	oneOf,
	string,
	unicodeScalar,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, String as Str } from "effect"
import {
	base64urlDecode,
	base64urlEncode,
	base64urlLength
} from "#compiler/codec/cursor/base64url.ts"

import {
	ByteReader,
	ByteWriter,
	utf8ByteLength,
	utf8Bytes,
	utf8Text,
	varintLength,
	varintMax
} from "#compiler/codec/cursor/bytes.ts"
import { assert } from "#test/support/assert.ts"

describe("base64url (RFC 4648 section 5)", () => {
	it.effect("agrees with Node's unpadded base64url and round-trips every byte string", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cursor/primitives-16",
					draw: drawn(bytes({ min: 0, max: 300 })),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(bytes) =>
					Effect.sync(() => {
						const token = base64urlEncode(bytes)
						assert.equal(token, Buffer.from(bytes).toString("base64url"))
						assert.equal(token.length, base64urlLength(bytes.length))
						assert.deepEqual(base64urlDecode(token), bytes)
					})
			)
		)
	)

	it.effect("decodes only canonical tokens: every decoded string re-encodes to itself", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cursor/primitives-17",
					draw: drawn(
						string(
							element(
								Str.split(
									"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/ ",
									""
								)
							),
							{ min: 0, max: 10 }
						)
					),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 5000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(text) =>
					Effect.sync(() => {
						const bytes = base64urlDecode(text)
						if (bytes !== undefined) {
							assert.equal(base64urlEncode(bytes), text)
						}
					})
			)
		)
	)
})

/**
 * The textbook minimal unsigned LEB128 encoding: seven bits per byte, low first, the high bit set on every byte but
 * the last.
 */
const minimal = (n: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	let rest = n
	do {
		const low = rest % 128
		rest = Math.floor(rest / 128)
		out.push(rest > 0 ? low + 128 : low)
	} while (rest > 0)
	return out
}

describe("varints (unsigned LEB128, minimal form)", () => {
	it.effect("round-trips every admitted value in its minimal length", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cursor/primitives-18",
					draw: drawn(int(0, varintMax)),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(n) =>
					Effect.sync(() => {
						const bytes = new ByteWriter().varint(n).finish()
						assert.equal(bytes.length, varintLength(n))
						const r = new ByteReader(bytes)
						assert.equal(r.varint(), n)
						assert.equal(r.done, true)
					})
			)
		)
	)

	/**
	 * What a varint reader must answer for bytes: the value whose minimal encoding of at most four bytes they start with,
	 * if one does. Encodings are prefix-free, so at most one does.
	 */
	const expectedVarint = (
		bytes: ReadonlyArray<number>
	): { readonly value: number; readonly length: number } | undefined => {
		let value = 0
		for (let i = 0; i < Math.min(bytes.length, 4); i++) {
			const b = bytes[i] ?? 0
			value += (b % 128) * 128 ** i
			if (b < 128) {
				const encoding = minimal(value)
				return encoding.length === i + 1 && Arr.every(encoding, (e, j) => e === bytes[j])
					? { value, length: i + 1 }
					: undefined
			}
		}
		return undefined
	}
	const short = array(int(0, 255), { min: 0, max: 2 })

	it.effect(
		"reads exactly the minimal encodings of at most four bytes, over every string of up to two bytes and longer generated ones",
		(ctx) =>
			Effect.gen(function* () {
				const check = (bytes: ReadonlyArray<number>): void => {
					const expected = expectedVarint(bytes)
					const reader = new ByteReader(Uint8Array.from(bytes))
					assert.equal(
						reader.varint(),
						expected?.value,
						Arr.join(
							Arr.map(bytes, (b) => String(b)),
							" "
						)
					)
					if (expected !== undefined) {
						assert.equal(reader.remaining, bytes.length - expected.length)
					}
				}
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/cursor/varint-short",
							generator: short,
							literal: Formatter.format,
							limit: 70_000,
							coverage: noCoverage,
							caseHang: Duration.minutes(2)
						},
						(bytes) => Effect.sync(() => check(bytes))
					)
				)
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/cursor/varint-long",
							draw: drawn(
								array(oneOf([int(0, 255), element([0x80, 0xff, 0x00, 0x7f])]), { min: 3, max: 6 })
							),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 5000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(bytes) => Effect.sync(() => check(bytes))
					)
				)
			})
	)

	it.effect("writes the minimal encoding of every admitted value", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cursor/varint-write",
					draw: drawn(int(0, varintMax)),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(n) =>
					Effect.sync(() => {
						const written: ReadonlyArray<number> = [...new ByteWriter().varint(n).finish()]
						assert.deepEqual(written, minimal(n))
					})
			)
		)
	)

	it.effect(
		"reads a length-prefixed field exactly when its length is within the bound and the remaining bytes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cursor/varint-field",
						draw: drawn(
							(source) =>
								[
									source.draw(bytes({ min: 0, max: 8 })),
									source.draw(int(0, 10)),
									source.draw(int(-2, 2))
								] as const
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([body, bound, cut]) =>
						Effect.sync(() => {
							const written = new ByteWriter().field(body).finish()
							const bytes =
								cut < 0
									? written.slice(0, Math.max(0, written.length + cut))
									: Uint8Array.from([...written, ...new Uint8Array(cut)])
							const read = new ByteReader(bytes).field(bound)
							const fits = body.length <= bound && bytes.length >= written.length
							assert.deepEqual(read, fits ? body : undefined)
						})
				)
			)
	)
})

describe("strict UTF-8 (Unicode scalars, beyond the BMP included)", () => {
	/** Any Unicode scalar, never a lone surrogate. */
	const wellFormed = string(unicodeScalar, { min: 0, max: 40 })

	it.effect("encodes as Node does and decodes its own output", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cursor/primitives-19",
					draw: drawn(wellFormed),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(text) =>
					Effect.sync(() => {
						const bytes = utf8Bytes(text)
						assert.equal(Buffer.from(bytes).equals(Buffer.from(text, "utf8")), true)
						assert.equal(utf8ByteLength(text), bytes.length)
						assert.equal(utf8Text(bytes), text)
					})
			)
		)
	)

	it.effect("agrees with a fatal TextDecoder on arbitrary bytes", (ctx) =>
		Effect.gen(function* () {
			const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/cursor/primitives-20",
						/**
						 * Overlong forms, surrogate code points, values above U+10FFFF and truncations are planted beside the
						 * drawn bytes, which reach them too seldom.
						 */
						draw: drawn(
							weighted([
								[4, bytes({ min: 0, max: 24 })],
								[
									1,
									map(
										element([
											[0xc0, 0x80],
											[0xc1, 0xbf],
											[0xe0, 0x80, 0x80],
											[0xed, 0xa0, 0x80],
											[0xed, 0xbf, 0xbf],
											[0xf0, 0x80, 0x80, 0x80],
											[0xf4, 0x90, 0x80, 0x80],
											[0xf5, 0x80, 0x80, 0x80],
											[0xe2, 0x82],
											[0x80],
											[0xff]
										]),
										(bad) => Uint8Array.from(bad)
									)
								]
							])
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 5000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(bytes) =>
						Effect.sync(() => {
							/** The fatal decoder's text, or none where it throws on malformed UTF-8. */
							const expected = Result.getOrUndefined(Result.try(() => fatal.decode(bytes)))
							assert.equal(utf8Text(bytes), expected)
						})
				)
			)
		})
	)
})
