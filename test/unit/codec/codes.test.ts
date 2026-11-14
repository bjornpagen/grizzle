/**
 * The closed-id and set codecs (codec/scalar.ts over values/identity.ts and values/convert.ts) under an installation's
 * codes, against a naive positional model.
 *
 * - The model: a roster of five codes, each live or a hole, a live code c held by the handle `h<c>`; a closed id is
 *   written as its code's decimal digits, and a set is stored as eight characters, five codes rounded up to whole hex
 *   digits, the character at position c 1 exactly when the set holds code c's handle, so a hole's and every padding
 *   position's is 0, and written as X and the two hex digits of that text (test/support/closed/bit-text.ts).
 * - Universal oracles: convert ∘ encode is the identity on every value, a cell's one text is the value's written text,
 *   and the order of two closed ids is their codes'.
 * - Named invalid variants, each refused with its fault: a removed handle (a hole's), a handle of another roster, a
 *   value that is no Set, and a Set holding a member that is no string.
 *
 * The box, exhausted: every hole pattern of a five-code roster that leaves a handle live, every subset of its live
 * handles, under every variant the pattern admits.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): codes-set-first-code-lost (a set's text read from its second code on).
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import { Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import { compareValues } from "#compiler/scalar/values/identity.ts"
import { assert, faulted, nonEmpty, succeeded } from "#test/support/assert.ts"
import { hexOfText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import { caseHang } from "#test/support/limits.ts"
import { echoed, outputText, paramText } from "#test/support/wire.ts"

/** The codes a roster of the box has minted, holes included. */
const size = 5

const closed = succeeded(parseDeclaredName("Kind"))

/** The handle that holds, or held, code `code`. */
const handleOf = (code: number): string => `h${code}`

/** What a case writes: a set of the live handles, or one of the named invalid values. */
type Variant =
	| "valid"
	| "a removed handle"
	| "another roster's handle"
	| "no Set"
	| "a member that is no string"

/** One case: which codes are live (a bit mask), which live codes the set holds (a bit mask), and what it writes. */
interface Pattern {
	readonly live: number
	readonly held: number
	readonly variant: Variant
}

const variants: ReadonlyArray<Variant> = [
	"valid",
	"a removed handle",
	"another roster's handle",
	"no Set",
	"a member that is no string"
]

const isSet = (mask: number, code: number): boolean => ((mask >> code) & 1) === 1

/** The masks below 2^size that `within` covers, ascending: a mask's subsets. */
const submasks = (within: number): ReadonlyArray<number> =>
	Arr.filter(
		Array.from({ length: 2 ** size }, (_, mask) => mask),
		(mask) => (mask & ~within) === 0
	)

/**
 * Every hole pattern that leaves a handle live, every subset of its live codes, and every variant: a removed handle
 * only where the pattern has a hole.
 */
const patterns: Gen<Pattern> = (s) => {
	const live = s.draw(int(1, 2 ** size - 1))
	const subsets = submasks(live)
	const held = subsets[s.draw(int(0, subsets.length - 1))] ?? 0
	const admitted = Arr.filter(variants, (v) => v !== "a removed handle" || live !== 2 ** size - 1)
	const variant = admitted[s.draw(int(0, admitted.length - 1))] ?? "valid"
	return { live, held, variant }
}

/** The roster, its codes and the codebook a pattern installs. */
const installed = (live: number) => {
	const codes = Array.from({ length: size }, (_, code): CodeSlot =>
		isSet(live, code) ? { kind: "live", handle: handleOf(code) } : { kind: "hole" }
	)
	const roster = Roster.of(
		closed,
		nonEmpty(
			Arr.map(
				Arr.filter(
					Arr.map(codes, (_, code) => code),
					(code) => isSet(live, code)
				),
				handleOf
			)
		)
	)
	const book: Codebook = { rosters: new Map([[closed, rosterCodec(closed, codes)]]) }
	const code: ScalarType = {
		carrier: "code",
		caps: capabilitiesOf("code"),
		contract: undefined,
		roster
	}
	const bits: ScalarType = { carrier: "bits", caps: capabilitiesOf("bits"), roster }
	return { roster, book, code, bits }
}

/** The model's stored text of a set, as bit_out writes it: position c is 1 exactly when the set holds code c. */
const storedText = (held: number): string =>
	setText(
		size,
		Arr.filter(
			Array.from({ length: size }, (_, code) => code),
			(code) => isSet(held, code)
		)
	)

/** The model's written text of a set: X, then the hex digits of its stored text. */
const writtenText = (held: number): ParamText => paramText(`X${hexOfText(storedText(held))}`)

/**
 * Every live handle encodes as its code's digits and converts back, the order of two is their codes', and a hole's
 * handle and another roster's are refused; every set encodes as the model's text, holes 0, and converts back, and each
 * named invalid set is refused with its fault.
 */
const roundTrips = ({ live, held, variant }: Pattern, c: Case<Variant | "a hole">) =>
	Effect.sync(() => {
		const { roster, book, code, bits } = installed(live)
		const ids = scalarCodec(code, book)
		const sets = scalarCodec(bits, book)
		const idsRead = scalarReader(code, book)
		const setsRead = scalarReader(bits, book)
		for (let k = 0; k < size; k += 1) {
			const handle = handleOf(k)
			if (!isSet(live, k)) {
				faulted(ids.encode(handle), "codeHandle", `${handle} was removed`)
				c.note("a hole")
				continue
			}
			const text = succeeded(ids.encode(handle))
			assert.equal(text, paramText(`${k}`), `${handle} is written as its code`)
			assert.equal(idsRead.convert(echoed(code, text)), handle, `code ${k} reads as ${handle}`)
			assert.equal(idsRead.cellText(echoed(code, text)), text, "a code's cell is its own one text")
			assert.equal(ids.text(handle), text, "an admitted handle's text is its encoding")
			for (const other of roster.handles) {
				const otherCode = Number(Str.slice(1)(other))
				assert.equal(
					compareValues(ids.spec, handle, other),
					k < otherCode ? -1 : k > otherCode ? 1 : 0,
					`${handle} against ${other} is code order`
				)
			}
		}
		faulted(ids.encode("elsewhere"), "codeHandle", "a handle of another roster")
		const members = Arr.filter(roster.handles, (h) => isSet(held, Number(Str.slice(1)(h))))
		const fault = ((): { readonly value: unknown; readonly fault: CodecFault } | undefined => {
			switch (variant) {
				case "valid":
					return undefined
				case "a removed handle": {
					const hole = Option.getOrElse(
						Arr.findFirst(
							Array.from({ length: size }, (_, k) => k),
							(k) => !isSet(live, k)
						),
						() => 0
					)
					return { value: new Set([...members, handleOf(hole)]), fault: "bitsMember" }
				}
				case "another roster's handle":
					return { value: new Set([...members, "elsewhere"]), fault: "bitsMember" }
				case "no Set":
					return { value: members, fault: "bitsType" }
				case "a member that is no string":
					return { value: new Set<unknown>([...members, 0]), fault: "bitsType" }
			}
		})()
		c.note(variant)
		if (fault !== undefined) {
			faulted(sets.encode(fault.value), fault.fault, variant)
			return
		}
		const text = succeeded(sets.encode(new Set(members)))
		assert.equal(
			text,
			writtenText(held),
			"a set is written as X and the hex digits of one bit per code, position c code c, holes and padding 0"
		)
		assert.equal(
			text.length,
			1 + wholeDigits(size) / 4,
			"a set's text has a hex digit per four codes, rounded up"
		)
		const stored = storedText(held)
		const read = setsRead.convert(outputText(stored))
		if (!(read instanceof Set)) {
			return assert.fail("a set reads as a Set")
		}
		assert.deepEqual(
			Arr.sort(Arr.map([...read], String), Order.String),
			Arr.sort(members, Order.String),
			"a set reads back as its handles"
		)
		assert.equal(
			setsRead.cellText(outputText(stored)),
			text,
			"a set's stored cell's one text is its written text"
		)
	})

describe("the closed-id and set codecs", () => {
	it.effect(
		"write a code and a set by the installation's codes, read them back, and refuse every named invalid value",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/codec/codes",
						generator: patterns,
						literal: Formatter.format,
						coverage: requiredInSpace<Variant | "a hole">([
							"valid",
							"a removed handle",
							"another roster's handle",
							"no Set",
							"a member that is no string",
							"a hole"
						]),
						caseHang,
						box: "every hole pattern of five codes, every subset of its live handles, every variant",
						oracle: {
							kind: "second-implementation",
							name: "a naive positional model of the codes"
						},
						concurrency: 1
					},
					roundTrips
				)
			)
	)
})
