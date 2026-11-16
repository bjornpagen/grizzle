/** What the properties of canonical.test.ts read: its spaces, models and helpers. */

import {
	type Aimed,
	aimed,
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	string,
	unicodeScalar,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { bigint, double, float } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, DateTime, Option, Order, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import {
	type Canonicalizable,
	type CanonicalToken,
	canonicalTag,
	decode,
	encode,
	everyProperty,
	fromJson,
	type Json,
	noRevivers,
	type Revivers,
	toJson,
	vectorTag,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { isList } from "#test/support/list.ts"

/** The spellings where a key order, a tagging scheme or the prototype accessor goes wrong. */
const keyDictionary = [
	"0",
	"1",
	"2",
	"10",
	"__proto__",
	"~",
	"~n:1",
	"a",
	"b",
	"Z",
	"é",
	"loc",
	"～",
	"\u{1f600}"
] as const

/** A key: drawn printable text, or a spelling of the dictionary. */
const key: Gen<string> = weighted([
	[1, string(codePoint(0x20, 0x7e), { min: 0, max: 6 })],
	[1, element(keyDictionary)]
])

/** A key that is not "loc": the dictionary without it, and drawn text, which spells "loc" as "loc~". */
const keyBesideLoc: Gen<string> = weighted([
	[1, map(string(codePoint(0x20, 0x7e), { min: 0, max: 6 }), (k) => (k === "loc" ? "loc~" : k))],
	[
		1,
		element(
			nonEmpty(
				Arr.filter(keyDictionary, (k) => k !== "loc"),
				"the keys beside loc"
			)
		)
	]
])

/** A value carried by the Canonicalizable protocol, under one of a few extension tags the revivers below restore. */
export class Exact implements Canonicalizable {
	readonly tag: string
	readonly payload: string
	constructor(tag: string, payload: string) {
		this.tag = tag
		this.payload = payload
	}
	[canonicalTag]() {
		return { tag: this.tag, payload: this.payload }
	}
}

const exactTags = ["d", "m2", "v"] as const

export const revivers: Revivers = Rec.fromEntries(
	Arr.map(exactTags, (tag) => [tag, (payload: string) => Result.ok(new Exact(tag, payload))])
)

/** The largest finite 32-bit float. */
const float32Max = 3.4028234663852886e38

/**
 * A vector: as many 32-bit floats as a string leaf holds characters, of every scale, the subnormals among them, and -0
 * as often as any other.
 */
const vector: Gen<Float32Array> = map(
	array(
		weighted<number>([
			[1, float(-float32Max, float32Max)],
			[1, constant(-0)]
		]),
		{ min: 0, max: 8 }
	),
	(xs) => Float32Array.from(xs)
)

const leaf = weighted<unknown>([
	[1, vector],
	[1, string(unicodeScalar, { min: 0, max: 8 })],
	[
		1,
		(source) =>
			new Exact(
				source.draw(element(exactTags)),
				source.draw(string(unicodeScalar, { min: 0, max: 6 }))
			)
	],
	[1, element(["~", "~~", "~n:5", "~d:1.50", "n1"])],
	[1, boolean],
	[1, int(-(2 ** 31), 2 ** 31 - 1)],
	[1, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([-0, 1e21, 1e-7, 2 ** 53])],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])],
	[1, bigint(-(2n ** 64n), 2n ** 64n)]
])

/**
 * A value nested at most `depth` arrays or objects deep: a leaf, an array of up to five values, or an object of up to
 * six entries whose keys differ.
 */
const valueAt = (depth: number): Gen<unknown> => {
	if (depth === 0) {
		return leaf
	}
	const inner = valueAt(depth - 1)
	return weighted<unknown>([
		[1, leaf],
		[1, array(inner, { min: 0, max: 5 })],
		[
			1,
			map(
				uniqueArray(
					key,
					(k) =>
						(source): readonly [string, unknown] => [k, source.draw(inner)],
					{ min: 0, max: 6 }
				),
				build
			)
		]
	])
}

export const value: Gen<unknown> = valueAt(3)

/** An object of these entries, "__proto__" an own key as any other. */
export function build(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of entries) {
		Object.defineProperty(out, k, {
			value: v,
			enumerable: true,
			writable: true,
			configurable: true
		})
	}
	return out
}

/** The same value with every object's keys inserted in the order `draws` picks. */
export const permute = (v: unknown, draws: ReadonlyArray<number>): unknown => {
	let i = 0
	const next = (): number => defined(draws[i++ % draws.length], "a drawn position")
	const walk = (x: unknown): unknown => {
		if (isList(x)) {
			return Arr.map(x, walk)
		}
		if (x instanceof Exact || x instanceof Float32Array || !isRecord(x)) {
			return x
		}
		const entries: Array<readonly [string, unknown]> = Arr.map(Rec.toEntries(x), ([k, child]) => [
			k,
			walk(child)
		])
		for (let j = entries.length - 1; j > 0; j--) {
			const swap = next() % (j + 1)
			const a = defined(entries[j], "an entry")
			entries[j] = defined(entries[swap], "an entry")
			entries[swap] = a
		}
		return build(entries)
	}
	return walk(v)
}

/** A vector's payload as the module header specifies it: its components bracketed, each as JSON.stringify writes it. */
const vectorPayload = (v: Float32Array): string =>
	`[${Arr.join(Arr.map(Array.from(v), jsonText), ",")}]`

/**
 * The JSON form the module header specifies: a Canonicalizable value as "~<tag>:<payload>", a vector as "~v:<payload>",
 * a number that is not finite as "~f:" and its text, -0 as 0, and an undefined object member left out (undefined is
 * refused only in an array or at the root).
 */
export const jsonForm = (v: unknown): Json => {
	if (v instanceof Exact) {
		return `~${v.tag}:${v.payload}`
	}
	if (v instanceof Float32Array) {
		return `~${vectorTag}:${vectorPayload(v)}`
	}
	if (typeof v === "bigint") {
		return `~n:${v}`
	}
	if (typeof v === "string") {
		return Str.startsWith("~")(v) ? `~${v}` : v
	}
	if (typeof v === "number") {
		return !Number.isFinite(v) ? `~f:${String(v)}` : Object.is(v, -0) ? 0 : v
	}
	if (typeof v === "boolean") {
		return v
	}
	if (isList(v)) {
		return Arr.map(v, jsonForm)
	}
	if (isRecord(v)) {
		const out: { [key: string]: Json } = {}
		for (const [k, child] of Rec.toEntries(v)) {
			if (child !== undefined) {
				Object.defineProperty(out, k, {
					value: jsonForm(child),
					enumerable: true,
					writable: true,
					configurable: true
				})
			}
		}
		return out
	}
	throw new Error(`the value generator drew ${typeof v}, outside the value model`)
}

const isJsonList = (j: Json): j is ReadonlyArray<Json> => Arr.isArray(j)

/**
 * RFC 8785 over a JSON form: object keys ordered by UTF-16 code units (JavaScript's string order), every number and
 * string as JSON.stringify writes it.
 */
export const rfc8785 = (j: Json): string => {
	if (typeof j === "string" || typeof j === "number" || typeof j === "boolean") {
		return jsonText(j)
	}
	if (isJsonList(j)) {
		return `[${Arr.join(Arr.map(j, rfc8785), ",")}]`
	}
	const members = Arr.sort(
		Rec.toEntries(j),
		Order.mapInput(Order.String, ([key]: readonly [string, Json]) => key)
	)
	return `{${Arr.join(
		Arr.map(members, ([k, child]) => `${jsonText(k)}:${rfc8785(child)}`),
		","
	)}}`
}

export const specified = (v: unknown): string => rfc8785(jsonForm(v))

/** What a drawn value holds of the spellings the format must get right. */
export type SpellingFeature =
	| "a bigint"
	| "a vector"
	| "a vector component of -0"
	| "a Canonicalizable value"
	| "a string beginning with ~"
	| "an integer-like key"
	| "a __proto__ key"
	| "keys code points order otherwise"
	| "negative zero"
	| "an exponent-form number"
	| "a number that is not finite"

/** A string's code points, read through its iterator. */
const codePointsOf = (s: string): ReadonlyArray<number> =>
	Arr.map(Arr.fromIterable(s), (c) =>
		Option.getOrThrowWith(Str.codePointAt(c, 0), () => new Error("a code point"))
	)

/** Strings by their code points, a prefix first. */
const codePoints: Order.Order<string> = Order.mapInput(Arr.makeOrder(Order.Number), codePointsOf)

export const spellingsOf = (v: unknown, note: (f: SpellingFeature) => void): void => {
	if (v instanceof Exact) {
		note("a Canonicalizable value")
	} else if (v instanceof Float32Array) {
		note("a vector")
		if (Arr.some(Array.from(v), (x) => Object.is(x, -0))) {
			note("a vector component of -0")
		}
	} else if (typeof v === "bigint") {
		note("a bigint")
	} else if (typeof v === "string" && Str.startsWith("~")(v)) {
		note("a string beginning with ~")
	} else if (typeof v === "number") {
		if (Object.is(v, -0)) {
			note("negative zero")
		}
		if (!Number.isFinite(v)) {
			note("a number that is not finite")
		}
		if (Str.includes("e")(jsonText(v))) {
			note("an exponent-form number")
		}
	} else if (isList(v)) {
		for (const x of v) {
			spellingsOf(x, note)
		}
	} else if (isRecord(v)) {
		const keys = Rec.keys(v)
		if (Arr.some(keys, (k) => regex("^(0|[1-9][0-9]*)$").test(k))) {
			note("an integer-like key")
		}
		if (keys.includes("__proto__")) {
			note("a __proto__ key")
		}
		const utf16 = Arr.sort([...keys], Order.String)
		const points = Arr.sort(keys, codePoints)
		if (Arr.some(utf16, (k, i) => k !== points[i])) {
			note("keys code points order otherwise")
		}
		for (const x of Rec.values(v)) {
			spellingsOf(x, note)
		}
	}
}

/**
 * A value outside the model, planted at a drawn path of an otherwise canonical value, in the direction it can arise:
 * a host value the encoder is handed, or a JSON text the decoder parses. Each names where the refusal is located, the
 * planted value's path or, for a key, the path through it.
 */
export type OutsideKind =
	| "null"
	| "undefined in an array"
	| "a lone surrogate"
	| "a lone surrogate key"
	| "a function"
	| "a symbol"
	| "a Map"
	| "a Date"
	| "a class instance"
	| "a symbol key"
	| "a cycle"
	| "a hole"
	| "the reserved tag n"
	| "the reserved tag f"
	| "a tag of no letter"
	| "a payload of a lone surrogate"
	| "decoded null"
	| "a decoded lone surrogate"
	| "a decoded lone surrogate key"
	| "a non-canonical bigint"
	| "a float named by no word"
	| "a tag only the prototype holds"
	| "a tag no reviver holds"
	| "a vector component that is not finite"

class Instance {
	readonly n = 1
}

/** An array of three whose middle element is a hole. */
const holey = (): ReadonlyArray<number> => {
	const out: Array<number> = [1]
	out[2] = 3
	return out
}

/** The tagged host value a Canonicalizable returns. */
const tagged = (tag: string, payload: string): Canonicalizable => ({
	[canonicalTag]: () => ({ tag, payload })
})

/** A host value at the end of a path, and the extra path segment its refusal names (a key's own, a hole's index). */
interface Planted {
	readonly direction: "encode" | "decode"
	readonly at: (root: () => unknown) => unknown
	readonly extra: ReadonlyArray<string | number>
}

export const planted: { readonly [K in OutsideKind]: Planted } = {
	null: { direction: "encode", at: () => null, extra: [] },
	"undefined in an array": { direction: "encode", at: () => [undefined], extra: [0] },
	"a lone surrogate": { direction: "encode", at: () => "x\ud800", extra: [] },
	"a lone surrogate key": {
		direction: "encode",
		at: () => build([["k\udfff", 1]]),
		extra: ["k\udfff"]
	},
	"a function": { direction: "encode", at: () => () => 1, extra: [] },
	"a symbol": { direction: "encode", at: () => Symbol("s"), extra: [] },
	"a Map": { direction: "encode", at: () => new Map(), extra: [] },
	"a Date": {
		direction: "encode",
		at: () => DateTime.toDateUtc(DateTime.makeUnsafe(0)),
		extra: []
	},
	"a class instance": { direction: "encode", at: () => new Instance(), extra: [] },
	"a symbol key": { direction: "encode", at: () => ({ [Symbol("k")]: 1 }), extra: [] },
	/** An object whose member reads back the root it lies in. */
	"a cycle": {
		direction: "encode",
		at: (root) => Object.defineProperty({}, "back", { enumerable: true, get: root }),
		extra: ["back"]
	},
	"a hole": { direction: "encode", at: () => holey(), extra: [1] },
	"the reserved tag n": { direction: "encode", at: () => tagged("n", "1"), extra: [] },
	"the reserved tag f": { direction: "encode", at: () => tagged("f", "NaN"), extra: [] },
	"a tag of no letter": { direction: "encode", at: () => tagged("D!", "1"), extra: [] },
	"a payload of a lone surrogate": {
		direction: "encode",
		at: () => tagged("d", "\ud800"),
		extra: []
	},
	"decoded null": { direction: "decode", at: () => null, extra: [] },
	"a decoded lone surrogate": { direction: "decode", at: () => "\ud800", extra: [] },
	"a decoded lone surrogate key": {
		direction: "decode",
		at: () => build([["\udc00", 1]]),
		extra: ["\udc00"]
	},
	"a non-canonical bigint": { direction: "decode", at: () => "~n:01", extra: [] },
	"a float named by no word": { direction: "decode", at: () => "~f:nan", extra: [] },
	"a tag only the prototype holds": { direction: "decode", at: () => "~constructor:x", extra: [] },
	"a tag no reviver holds": { direction: "decode", at: () => "~q:1", extra: [] },
	"a vector component that is not finite": {
		direction: "encode",
		at: () => Float32Array.of(1, Number.NaN),
		extra: []
	}
}

export const outsides = nonEmpty(
	Arr.filter(Rec.keys(planted), (k): k is OutsideKind => Rec.has(planted, k)),
	"the kinds outside the model"
)

/** A path segment: a member's key or an array's index, equally often. */
const pathSegmentOf = (member: Gen<string>, index: Gen<number>): Gen<string | number> =>
	weighted<string | number>([
		[1, member],
		[1, index]
	])

/** A path into a value: object keys and array indices. */
const pathGen = array(pathSegmentOf(element(["a", "b", "k"]), int(0, 2)), {
	min: 0,
	max: 4
})

/**
 * The value with `inner` at `path`, every other member a drawn filler. The root is read lazily, so a cycle can reach it.
 */
export const placed = (
	path: ReadonlyArray<string | number>,
	inner: (root: () => unknown) => unknown,
	filler: unknown
) => {
	const at = (i: number): unknown => {
		const segment = path[i]
		if (segment === undefined) {
			return inner(() => root)
		}
		if (typeof segment === "number") {
			return Arr.map(indices(segment + 1), (j) => (j === segment ? at(i + 1) : filler))
		}
		return build([
			["z", filler],
			[segment, at(i + 1)]
		])
	}
	const root = at(0)
	return root
}

type Direction = "encode" | "toJson" | "fromJson" | "decode"
const directions: Arr.NonEmptyReadonlyArray<Direction> = ["encode", "toJson", "fromJson", "decode"]
type Container = "array" | "object"

/**
 * The canonical text of the leaf 1 inside `depth` containers, written out directly: JSON.stringify recurses, so it
 * cannot print a nesting deep enough to exhaust the stack.
 */
export const nestedText = (depth: number, container: Container): string =>
	container === "array"
		? `${Str.repeat(depth)("[")}1${Str.repeat(depth)("]")}`
		: `${Str.repeat(depth)('{"a":')}1${Str.repeat(depth)("}")}`

/** The items a parting shows on each side of the index where two sequences first differ. */
const partingContext = 4

/**
 * Two sequences, a text or a path of 100,000 segments, held equal at the cost of reading them once: their lengths, and
 * where they part, nowhere or the first index at which they differ with partingContext items on each side of it in
 * both. A deep equality of two such sequences that differ builds a diff superlinear in their lengths, so a red would
 * run for minutes and tens of gigabytes; this one stays linear, and its message short.
 */
export const sameSequence = <A>(
	actual: ArrayLike<A>,
	expected: ArrayLike<A>,
	why: string
): void => {
	const shorter = Math.min(actual.length, expected.length)
	let at = 0
	while (at < shorter && actual[at] === expected[at]) {
		at += 1
	}
	const from = Math.max(0, at - partingContext)
	const around = (items: ArrayLike<A>): ReadonlyArray<A | undefined> =>
		Arr.map(
			indices(Math.max(0, Math.min(items.length, at + partingContext + 1) - from)),
			(i) => items[from + i]
		)
	const parted =
		at === actual.length && at === expected.length
			? "nowhere"
			: { at, actual: around(actual), expected: around(expected) }
	assert.deepEqual(
		{ length: actual.length, parted },
		{ length: expected.length, parted: "nowhere" },
		why
	)
}

/** `length` containers, each holding the next, the last holding the one `back` below the root: the root. */
export const cycle = (length: number, back: number, container: Container): unknown => {
	if (container === "array") {
		const items = Arr.map(indices(length), (): Array<unknown> => [])
		for (const [i, item] of items.entries()) {
			item.push(items[i + 1] ?? items[back])
		}
		return items[0]
	}
	const members = Arr.map(indices(length), (): Record<string, unknown> => ({}))
	for (const [i, member] of members.entries()) {
		member["a"] = members[i + 1] ?? members[back]
	}
	return members[0]
}

export type OmittedFeature =
	| "an undefined property"
	| "a SourceLoc under loc"
	| "another value under loc"

/** A SourceLoc's members as the serializer reads them: a path, a label, and a call site or none. */
type DrawnLoc = Readonly<{
	path: ReadonlyArray<string | number>
	label: string
	site: Readonly<{ file: string; line: number; column: number }> | undefined
}>

const sourceLocGen: Gen<DrawnLoc> = (source) => ({
	path: source.draw(
		array(pathSegmentOf(string(codePoint(0x20, 0x7e), { min: 0, max: 4 }), int(0, 2 ** 31 - 1)), {
			min: 0,
			max: 3
		})
	),
	label: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 })),
	site: source.draw(
		map(
			option((source) => ({
				file: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 })),
				line: source.draw(int(0, 2 ** 31 - 1)),
				column: source.draw(int(0, 2 ** 31 - 1))
			})),
			Option.getOrUndefined
		)
	)
})

/** The member a case places under loc: none, a SourceLoc, or another value. */
type Member =
	| Readonly<{ kind: "undefined" }>
	| Readonly<{ kind: "loc"; loc: DrawnLoc }>
	| Readonly<{ kind: "other"; other: unknown }>

/**
 * A leaf two drawn values often share: strings that JSON escapes or that a tag reads, strings one of which begins
 * another, numbers whose texts begin one another, booleans and bigints.
 */
const nearLeaf = weighted<unknown>([
	[
		1,
		element([
			"",
			"a",
			"ab",
			'"',
			"\\",
			"\n",
			"\u0001",
			"~",
			"~n:1",
			"1",
			" ",
			"!",
			"\u{e000}",
			"\u{1f600}"
		])
	],
	[1, element([0, 1, 12, 10, -1, 1.5, 1e21, 2 ** 53])],
	[1, boolean],
	[1, element([0n, 1n, -12n])]
])

/** A value of few small parts nested at most `depth` deep, so two drawn values often share a prefix or are equal. */
const nearValueAt = (depth: number): Gen<unknown> => {
	if (depth === 0) {
		return nearLeaf
	}
	const inner = nearValueAt(depth - 1)
	return weighted<unknown>([
		[1, nearLeaf],
		[1, array(inner, { min: 0, max: 3 })],
		[
			1,
			map(
				uniqueArray(
					element(["", "a", "b", "~", "1"]),
					(k) =>
						(source): readonly [string, unknown] => [k, source.draw(inner)],
					{ min: 0, max: 3 }
				),
				build
			)
		]
	])
}

/**
 * Two values alike but for one leaf each: the leaves alone, or the same items before and after them in an array, or the
 * same member beside them in a record, so two leaves meet where the token lists first differ with what their container
 * writes after them: nothing, a comma, a closing bracket or a closing brace.
 */
const pairAtOneLeaf: Gen<readonly [unknown, unknown]> = (source) => {
	const x = source.draw(nearLeaf)
	const y = source.draw(nearLeaf)
	const after = source.draw(array(nearValueAt(1), { min: 0, max: 1 }))
	switch (source.draw(element(["alone", "array", "record"] as const))) {
		case "alone":
			return [x, y]
		case "array": {
			const before = source.draw(array(nearValueAt(1), { min: 0, max: 2 }))
			return [
				[...before, x, ...after],
				[...before, y, ...after]
			]
		}
		case "record": {
			const beside = Rec.fromEntries(Arr.map(after, (v) => ["c", v] as const))
			return [
				{ b: x, ...beside },
				{ b: y, ...beside }
			]
		}
	}
}

/** A token's text, as the format's specification spells it: a punctuation token its own, any other JSON's. */
export const tokenText = (token: CanonicalToken): string =>
	typeof token === "symbol"
		? defined(token.description, "a punctuation token's text")
		: jsonText(token)

/** Where two token lists first differ, by what stands there. */
export type TokenFeature =
	| "equal texts"
	| "two strings"
	| "two numbers"
	| "two numbers, one's text beginning the other's, nothing after it"
	| "two numbers, one's text beginning the other's, a comma after it"
	| "two numbers, one's text beginning the other's, a closing bracket after it"
	| "a string and another token"
	| "two other tokens"

/**
 * Two numbers, one's text beginning the other's, by the token after the shorter one, which decides their order: the end
 * of its list and a comma come before any unit that continues a number's text, and a closing bracket or brace after
 * every digit and the point.
 */
const prefixFeature = (after: CanonicalToken | undefined): TokenFeature =>
	after === undefined
		? "two numbers, one's text beginning the other's, nothing after it"
		: tokenText(after) === ","
			? "two numbers, one's text beginning the other's, a comma after it"
			: "two numbers, one's text beginning the other's, a closing bracket after it"

/** What stands where two token lists first differ. */
export const firstDifference = (
	a: ReadonlyArray<CanonicalToken>,
	b: ReadonlyArray<CanonicalToken>
): TokenFeature => {
	const at = Arr.findFirstIndex(a, (x, i) => x !== b[i])
	const i = Option.getOrElse(at, () => a.length)
	const x = a[i]
	const y = b[i]
	if (x === undefined || y === undefined) {
		return "equal texts"
	}
	if (typeof x === "string" && typeof y === "string") {
		return "two strings"
	}
	if (typeof x === "number" && typeof y === "number") {
		const xs = jsonText(x)
		const ys = jsonText(y)
		return Str.startsWith(xs)(ys)
			? prefixFeature(a[i + 1])
			: Str.startsWith(ys)(xs)
				? prefixFeature(b[i + 1])
				: "two numbers"
	}
	return typeof x === "string" || typeof y === "string"
		? "a string and another token"
		: "two other tokens"
}

/**
 * The value `v`'s canonical text decodes to under `revivers`: -0 as 0, NaN and the infinities as themselves, and a
 * vector as the Exact value its tag and payload revive to, since a vector's text and a protocol value's of its tag are
 * one.
 */
export function decodedForm(v: unknown): unknown {
	if (Object.is(v, -0)) {
		return 0
	}
	if (v instanceof Float32Array) {
		return new Exact(vectorTag, vectorPayload(v))
	}
	if (isList(v)) {
		return Arr.map(v, decodedForm)
	}
	if (v instanceof Exact || !isRecord(v)) {
		return v
	}
	return build(Arr.map(Rec.toEntries(v), ([k, child]) => [k, decodedForm(child)]))
}

/** A value and the positions its objects' keys are inserted in. */
export const textGen: Gen<readonly [unknown, ReadonlyArray<number>]> = (source) =>
	[source.draw(value), source.draw(array(int(0, 2 ** 31 - 1), { min: 1, max: 32 }))] as const

/** A kind outside the model, the path it is planted at, and the filler of every other member. */
export const outsideGen: Gen<readonly [OutsideKind, ReadonlyArray<string | number>, unknown]> = (
	source
) => [source.draw(element(outsides)), source.draw(pathGen), source.draw(leaf)] as const

/** The leaf 1 inside `depth` containers. */
const nest = (depth: number, container: Container): unknown => {
	let v: unknown = 1
	for (let i = 0; i < depth; i++) {
		v = container === "array" ? [v] : { a: v }
	}
	return v
}

/** The canonical text of each direction's answer, read back by the serializer, which keeps its stack on the heap too. */
export const textOf = (
	direction: Direction,
	depth: number,
	container: Container
): Result.Result<string, CompileError> => {
	switch (direction) {
		case "encode":
			return encode(nest(depth, container), everyProperty)
		case "toJson":
			return Result.flatMap(toJson(nest(depth, container), everyProperty), writeCanonicalJson)
		case "fromJson":
			return Result.flatMap(fromJson(nest(depth, container), noRevivers), (v) =>
				encode(v, everyProperty)
			)
		case "decode":
			return Result.flatMap(decode(nestedText(depth, container), noRevivers), (v) =>
				encode(v, everyProperty)
			)
	}
}

/** No container, one, and a nesting a recursion would overflow the small stack at, each container and direction. */
export const nestingGen: Gen<readonly [number, Container, Direction]> = (source) =>
	[
		source.draw(element([0, 1, 100_000])),
		source.draw(element<Container>(["array", "object"])),
		source.draw(element<Direction>(directions))
	] as const

/** A cycle through one container, two, and one a recursion would overflow the small stack on, back to its first or last. */
export const cycleGen: Gen<
	readonly [number, number, Container, "encode" | "toJson" | "fromJson"]
> = (source) => {
	const length = source.draw(element([1, 2, 100_000]))
	return [
		length,
		source.draw(element([0, length - 1])),
		source.draw(element<Container>(["array", "object"])),
		source.draw(element(["encode", "toJson", "fromJson"] as const))
	] as const
}

/** Entries of keys beside loc, and the member placed under loc. */
export const omittedGen: Gen<readonly [ReadonlyArray<readonly [string, unknown]>, Member]> = (
	source
) =>
	[
		source.draw(
			uniqueArray(
				keyBesideLoc,
				(k) =>
					(source): readonly [string, unknown] => [k, source.draw(value)],
				{ min: 0, max: 5 }
			)
		),
		source.draw(
			weighted<Member>([
				[1, constant({ kind: "undefined" })],
				[1, map(sourceLocGen, (loc) => ({ kind: "loc", loc }))],
				[1, map(leaf, (other) => ({ kind: "other", other }))]
			])
		)
	] as const

/** How a value is frozen when it is written. */
export type Freezing =
	| "unfrozen"
	| "frozen at the top"
	| "frozen with a mutable loc"
	| "deeply frozen"

/** `v` frozen throughout but at its vectors, a typed array's elements being no property a freeze holds. */
export const freezeDeeply = (v: unknown): unknown => {
	if (!(v instanceof Float32Array) && (isList(v) || isRecord(v))) {
		for (const child of isList(v) ? v : Rec.values(v)) {
			freezeDeeply(child)
		}
		Object.freeze(v)
	}
	return v
}

/** A freezing, a value, and the leaf a member is changed to. */
export const memoGen: Gen<readonly [Freezing, unknown, unknown]> = (source) =>
	[
		source.draw(
			element<Freezing>([
				"unfrozen",
				"frozen at the top",
				"frozen with a mutable loc",
				"deeply frozen"
			])
		),
		source.draw(value),
		source.draw(leaf)
	] as const

/** Members, picks that repeat them, and the place a member outside the model is put: two equal arrays that are distinct objects, which the drawn members repeat a few times a run. */
export const compareGen: Gen<readonly [ReadonlyArray<unknown>, ReadonlyArray<number>, number]> = (
	source
) =>
	[
		source.draw(array(value, { min: 1, max: 4 })),
		source.draw(array(int(0, 2 ** 31 - 1), { min: 0, max: 6 })),
		source.draw(int(0, 2 ** 31 - 1))
	] as const

/** Two values drawn apart, or alike but for one leaf. */
const tokensGen: Gen<readonly [unknown, unknown]> = weighted<readonly [unknown, unknown]>([
	[1, (source) => [source.draw(nearValueAt(2)), source.draw(nearValueAt(2))] as const],
	[1, pairAtOneLeaf]
])

/**
 * Two numbers, the second's text the first's continued: by a fraction's digits, or for a number other than zero by
 * another digit of its whole part, so the first's text begins the second's.
 */
const continuedNumbers: Gen<readonly [number, number]> = (source) => {
	const shorter = source.draw(int(-99, 99))
	const digit = source.draw(int(1, 9))
	const longer =
		shorter !== 0 && source.draw(boolean)
			? shorter * 10 + Math.sign(shorter) * digit
			: Number(`${jsonText(shorter)}.${digit}`)
	return [shorter, longer]
}

/** Two numbers whose texts begin one another, in either order, alone: nothing stands after the shorter one. */
const continuedAlone: Gen<readonly [unknown, unknown]> = (source) => {
	const [shorter, longer] = source.draw(continuedNumbers)
	return source.draw(boolean) ? [shorter, longer] : [longer, shorter]
}

/** Two numbers whose texts begin one another, in either order, at one place of two arrays alike but for them, an item after them, so a comma stands after the shorter one. */
const continuedBeforeComma: Gen<readonly [unknown, unknown]> = (source) => {
	const [x, y] = source.draw(continuedAlone)
	const before = source.draw(array(nearValueAt(1), { min: 0, max: 2 }))
	const after = source.draw(array(nearValueAt(1), { min: 1, max: 2 }))
	return [
		[...before, x, ...after],
		[...before, y, ...after]
	]
}

/** Two numbers whose texts begin one another, in either order, last in two arrays or two records alike but for them, so a closing bracket or brace stands after the shorter one. */
const continuedBeforeClose: Gen<readonly [unknown, unknown]> = (source) => {
	const [x, y] = source.draw(continuedAlone)
	if (source.draw(boolean)) {
		return [{ b: x }, { b: y }]
	}
	const before = source.draw(array(nearValueAt(1), { min: 0, max: 2 }))
	return [
		[...before, x],
		[...before, y]
	]
}

/** Two values drawn apart, or alike but for one leaf, aimed at two numbers whose texts begin one another. */
export const tokensSpace: Aimed<readonly [unknown, unknown], TokenFeature> = aimed(tokensGen, [
	["two numbers, one's text beginning the other's, nothing after it", continuedAlone],
	["two numbers, one's text beginning the other's, a comma after it", continuedBeforeComma],
	[
		"two numbers, one's text beginning the other's, a closing bracket after it",
		continuedBeforeClose
	]
])
