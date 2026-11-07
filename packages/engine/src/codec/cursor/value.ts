/**
 * A cursor value's boundary text read back as its host value, a hot path: every request with a cursor reads its
 * values here, so the readers are native string code with no per-character allocation.
 */
import type { ScalarCodec } from "#compiler/codec/scalar.ts"
import {
	bitInputPrefix,
	digitHolds,
	digitValue,
	hexDigitBits,
	hexDigitsFor
} from "#compiler/core/hex.ts"
import * as Result from "#compiler/core/result.ts"
import type { RosterCodec } from "#compiler/ir/codes.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	admitValue,
	type CarrierHost,
	type CarrierSpec,
	type SpecOf
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"

/** Whether `text` is an optional minus sign and decimal digits, so BigInt reads it without throwing. */
const isIntegerText = (text: string): boolean => {
	const start = text.charCodeAt(0) === 0x2d ? 1 : 0
	if (text.length === start) {
		return false
	}
	for (let i = start; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x30 || code > 0x39) {
			return false
		}
	}
	return true
}

const bigintOf = (text: string): unknown => (isIntegerText(text) ? BigInt(text) : undefined)

const decimalOf = (text: string): unknown => {
	const parsed = Decimal.fromString(text)
	return parsed.ok ? parsed.value : undefined
}

const moneyOf = (text: string): unknown => {
	const parsed = Decimal.fromString(text)
	if (!parsed.ok) {
		return undefined
	}
	const money = Money.fromDecimal(parsed.value)
	return money.ok ? money.value : undefined
}

/** "[start,end)", its endpoints read by `endpoint`; any other text reads endpoints admission refuses. */
const spanOf =
	(endpoint: (text: string) => unknown) =>
	(text: string): unknown => {
		const comma = text.indexOf(",")
		return { start: endpoint(text.slice(1, comma)), end: endpoint(text.slice(comma + 1, -1)) }
	}

/** "[c1,...,cn]", each component's shortest round-trip text read by Number, which names its binary32 value exactly. */
const vectorOf =
	(dimensions: number) =>
	(text: string): unknown => {
		const components = text.slice(1, -1).split(",")
		const buffer = new Float32Array(dimensions)
		for (const [i, component] of components.entries()) {
			if (i < dimensions) {
				buffer[i] = Number(component)
			}
		}
		return buffer
	}

const itself = (text: string): unknown => text

/** A code's decimal digits, read as the handle it names; a hole, a code past the roster or other text reads none. */
const handleOf =
	(roster: RosterCodec) =>
	(text: string): unknown => {
		if (text.length === 0 || text.length > String(roster.size).length) {
			return undefined
		}
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i)
			if (code < 0x30 || code > 0x39) {
				return undefined
			}
		}
		const name = roster.names[Number(text)]
		return name === undefined || name === "" ? undefined : name
	}

/**
 * A set's text, `X` then the whole hex digits of its roster's width (ir/codes.ts handlesText), read as the Set of
 * handles of its 1 bits; any other text, and one with a 1 at a hole or past the roster's codes, reads none.
 */
const handlesOf =
	(roster: RosterCodec) =>
	(text: string): unknown => {
		if (text.length !== 1 + hexDigitsFor(roster.width) || !text.startsWith(bitInputPrefix)) {
			return undefined
		}
		const handles = new Set<string>()
		for (let at = 1; at < text.length; at++) {
			const value = digitValue(text.charCodeAt(at))
			if (value === undefined) {
				return undefined
			}
			for (let bit = 0; bit < hexDigitBits; bit++) {
				if (!digitHolds(value, bit)) {
					continue
				}
				const name = roster.names[(at - 1) * hexDigitBits + bit]
				if (name === undefined || name === "") {
					return undefined
				}
				handles.add(name)
			}
		}
		return handles
	}

const candidates: { readonly [C in Carrier]: (spec: SpecOf<C>) => (text: string) => unknown } = {
	int2: () => Number,
	int4: () => Number,
	int8: () => bigintOf,
	numeric: () => decimalOf,
	float4: () => Number,
	float8: () => Number,
	money: () => moneyOf,
	bool: () => (text) => text === "true",
	uuid: () => itself,
	date: () => itself,
	text: () => itself,
	code: (spec) => handleOf(spec.roster),
	bits: (spec) => handlesOf(spec.roster),
	range4: () => spanOf(Number),
	range8: () => spanOf(bigintOf),
	rangeDate: () => spanOf(itself),
	vector: (spec) => vectorOf(spec.dimensions),
	exactInteger: () => bigintOf,
	exactMoney: () => moneyOf
}

const candidateOf = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec
): ((text: string) => unknown) => {
	const own: SpecOf<C> = spec
	const of: (spec: SpecOf<C>) => (text: string) => unknown = candidates[own.carrier]
	return of(own)
}

/**
 * A boundary value read back from a caller's cursor token.
 *
 * A token is a caller's input, never PostgreSQL's output, so its value texts are parsed, never trusted: each text is
 * read into a candidate host value by its carrier's reading below, which is total over any string and never throws,
 * and the candidate is admitted through its carrier exactly as an encoder admits a value (values/identity.ts
 * admitValue). The boundary is the admitted value, bound as the codec's canonical text of it (codec.ts decode).
 *
 * The reader of one comparator's boundary values: the admitted value a token's text reads as, or a failure for a text
 * whose reading admission refuses.
 */
export const boundaryValue = (
	codec: ScalarCodec
): ((text: string) => Result.Result<CarrierHost[Carrier], void>) => {
	const candidate = candidateOf(codec.spec)
	return (text) => {
		const admitted = admitValue(codec.spec, candidate(text))
		return admitted.ok ? Result.ok(admitted.value) : Result.err(undefined)
	}
}
