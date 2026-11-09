import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	unicodeScalar,
	uniqueArray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import {
	arrayText,
	type Canonicalizable,
	type CanonicalToken,
	canonicalEquals,
	canonicalSortKeyed,
	canonicalTag,
	canonicalTokens,
	compareCanonicalTokens,
	decode,
	encode,
	encodeOver,
	everyProperty,
	fromJson,
	type Json,
	noRevivers,
	omitSourceLocs,
	type Revivers,
	toJson,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	artifactRefusal,
	assert,
	defined,
	nonEmpty,
	refusalLoc,
	refused,
	succeeded
} from "#test/support/assert.ts"
import { isList } from "#test/support/list.ts"

import { regex } from "arkregex"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import { caseHang } from "#test/support/limits.ts"
/**
 * The canonical serializer (core/canonical.ts): one text per value, the JSON Canonicalization Scheme (RFC 8785) over
 * the value's JSON form, and a refusal, at the offending value's path, of everything outside the value model.
 *
 * The values are drawn: JSON without null plus bigints, their keys and strings from a dictionary of the spellings where
 * JavaScript's own key order, a code-point order, a naive tagging scheme or the prototype accessor goes wrong. The
 * oracle is the format's specification, written here apart from the serializer (the module header): the JSON form holds
 * a bigint as "~n:<integer>" and a plain string beginning with "~" with that "~" doubled, and the text is RFC 8785 over
 * it, keys ordered by UTF-16 code units and every number and string written as JSON.stringify writes it (ECMAScript's
 * shortest round trip, -0 as 0; well-formed escaping).
 *
 * Keys: drawn text, and the spellings where an order goes wrong: integer-like keys, which JavaScript lists first;
 * "__proto__", which assignment would take for the prototype; a key above ASCII; and a BMP key beyond the surrogates
 * beside a supplementary one, which UTF-16 code units order the other way round from code points.
 */
const key = oneOf([
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 }),
	element([
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
	])
])

/** A value carried by the Canonicalizable protocol, under one of a few extension tags the revivers below restore. */
class Exact implements Canonicalizable {
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

const revivers: Revivers = Rec.fromEntries(
	Arr.map(exactTags, (tag) => [tag, (payload: string) => Result.ok(new Exact(tag, payload))])
)

const leaf = oneOf<unknown>([
	string(unicodeScalar, { min: 0, max: 8 }),
	(source) =>
		new Exact(
			source.draw(element(exactTags)),
			source.draw(string(unicodeScalar, { min: 0, max: 6 }))
		),
	element(["~", "~~", "~n:5", "~d:1.50", "n1"]),
	boolean,
	int(-(2 ** 31), 2 ** 31 - 1),
	double(-Number.MAX_VALUE, Number.MAX_VALUE),
	element([-0, 1e21, 1e-7, 2 ** 53]),
	bigint(-(2n ** 64n), 2n ** 64n)
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
	return oneOf<unknown>([
		leaf,
		array(inner, { min: 0, max: 5 }),
		map(
			uniqueArray(
				(source): readonly [string, unknown] => [source.draw(key), source.draw(inner)],
				([k]) => k,
				{ min: 0, max: 6 },
				20
			),
			build
		)
	])
}

const value: Gen<unknown> = valueAt(3)

/** An object of these entries, "__proto__" an own key as any other. */
function build(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
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
const permute = (v: unknown, draws: ReadonlyArray<number>): unknown => {
	let i = 0
	const next = (): number => defined(draws[i++ % draws.length], "a drawn position")
	const walk = (x: unknown): unknown => {
		if (isList(x)) {
			return Arr.map(x, walk)
		}
		if (x instanceof Exact || !isRecord(x)) {
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

/**
 * The JSON form the module header specifies: a Canonicalizable value as "~<tag>:<payload>", -0 as 0, and an undefined
 * object member left out (undefined is refused only in an array or at the root).
 */
const jsonForm = (v: unknown): Json => {
	if (v instanceof Exact) {
		return `~${v.tag}:${v.payload}`
	}
	if (typeof v === "bigint") {
		return `~n:${v}`
	}
	if (typeof v === "string") {
		return Str.startsWith("~")(v) ? `~${v}` : v
	}
	if (typeof v === "number") {
		return Object.is(v, -0) ? 0 : v
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
const rfc8785 = (j: Json): string => {
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

const specified = (v: unknown): string => rfc8785(jsonForm(v))

/** What a drawn value holds of the spellings the format must get right. */
type SpellingFeature =
	| "a bigint"
	| "a Canonicalizable value"
	| "a string beginning with ~"
	| "an integer-like key"
	| "a __proto__ key"
	| "keys code points order otherwise"
	| "negative zero"
	| "an exponent-form number"

/** A string's code points, read through its iterator. */
const codePointsOf = (s: string): ReadonlyArray<number> =>
	Arr.map(Arr.fromIterable(s), (c) =>
		Option.getOrThrowWith(Str.codePointAt(c, 0), () => new Error("a code point"))
	)

/** Strings by their code points, a prefix first. */
const codePoints: Order.Order<string> = Order.mapInput(Arr.makeOrder(Order.Number), codePointsOf)

const spellingsOf = (v: unknown, note: (f: SpellingFeature) => void): void => {
	if (v instanceof Exact) {
		note("a Canonicalizable value")
	} else if (typeof v === "bigint") {
		note("a bigint")
	} else if (typeof v === "string" && Str.startsWith("~")(v)) {
		note("a string beginning with ~")
	} else if (typeof v === "number") {
		if (Object.is(v, -0)) {
			note("negative zero")
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

describe("the canonical text", () => {
	it.effect("is RFC 8785 over the specified JSON form, whatever the key insertion order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/core/canonical-text",
					draw: drawn(
						(source) =>
							[
								source.draw(value),
								source.draw(array(int(0, 2 ** 31 - 1), { min: 1, max: 32 }))
							] as const
					),
					literal: Formatter.format,
					coverage: required<SpellingFeature>(
						[
							"a bigint",
							"a Canonicalizable value",
							"a string beginning with ~",
							"an integer-like key",
							"a __proto__ key",
							"keys code points order otherwise",
							"negative zero",
							"an exponent-form number"
						],
						{ cases: 1000, sense: notesOnly }
					),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([v, draws], c) =>
					Effect.sync(() => {
						spellingsOf(v, c.note)
						const permuted = permute(v, draws)
						const form = jsonForm(v)
						assert.deepEqual(succeeded(toJson(permuted, everyProperty)), form)
						assert.equal(succeeded(encode(permuted, everyProperty)), rfc8785(form))
						assert.equal(succeeded(writeCanonicalJson(form)), rfc8785(form))
						if (isList(permuted)) {
							assert.equal(
								arrayText(Arr.map(permuted, (item) => succeeded(encode(item, everyProperty)))),
								rfc8785(form),
								"the text of the list written from its items' own"
							)
						}
						if (isRecord(permuted) && !(permuted instanceof Exact) && !isList(permuted)) {
							const texts = new Map(
								Arr.map(
									Rec.toEntries(permuted),
									([k, child]) => [k, succeeded(encode(child, everyProperty))] as const
								)
							)
							for (const [k, text] of texts) {
								assert.equal(
									succeeded(encodeOver(permuted, everyProperty, new Map([[k, text]]))),
									rfc8785(form),
									`the text with member ${k} written from its own`
								)
							}
							assert.equal(
								succeeded(encodeOver(permuted, everyProperty, texts)),
								rfc8785(form),
								"the text with every member written from its own"
							)
						}
					})
			)
		)
	)

	it.effect(
		"round-trips the JSON form and the text, bigints, tagged values and tilde strings included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/core/canonical-2",
						draw: drawn(value),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(v) =>
						Effect.sync(() => {
							const json = succeeded(toJson(v, everyProperty))
							const parsed = trustedJson<unknown>(jsonText(json))
							const viaJson = succeeded(fromJson(parsed, revivers))
							const viaText = succeeded(decode(succeeded(encode(v, everyProperty)), revivers))
							assert.equal(succeeded(encode(viaJson, everyProperty)), specified(v))
							assert.equal(succeeded(encode(viaText, everyProperty)), specified(v))
							assert.deepEqual(viaText, normalizeZero(v))
						})
				)
			)
	)
})

/**
 * A value outside the model, planted at a drawn path of an otherwise canonical value, in the direction it can arise:
 * a host value the encoder is handed, or a JSON text the decoder parses. Each names where the refusal is located, the
 * planted value's path or, for a key, the path through it.
 */
type Outside =
	| "null"
	| "undefined in an array"
	| "NaN"
	| "an infinity"
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
	| "a tag of no letter"
	| "a payload of a lone surrogate"
	| "decoded null"
	| "a decoded lone surrogate"
	| "a decoded lone surrogate key"
	| "a non-canonical bigint"
	| "a tag only the prototype holds"
	| "a tag no reviver holds"

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

const planted: { readonly [K in Outside]: Planted } = {
	null: { direction: "encode", at: () => null, extra: [] },
	"undefined in an array": { direction: "encode", at: () => [undefined], extra: [0] },
	NaN: { direction: "encode", at: () => Number.NaN, extra: [] },
	"an infinity": { direction: "encode", at: () => Number.NEGATIVE_INFINITY, extra: [] },
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
	"a tag only the prototype holds": { direction: "decode", at: () => "~constructor:x", extra: [] },
	"a tag no reviver holds": { direction: "decode", at: () => "~q:1", extra: [] }
}

const outsides = nonEmpty(
	Arr.filter(Rec.keys(planted), (k): k is Outside => Rec.has(planted, k)),
	"the kinds outside the model"
)

/** A path into a value: object keys and array indices. */
const pathGen = array(oneOf<string | number>([element(["a", "b", "k"]), int(0, 2)]), {
	min: 0,
	max: 4
})

/**
 * The value with `inner` at `path`, every other member a drawn filler. The root is read lazily, so a cycle can reach it.
 */
const placed = (
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
const nestedText = (depth: number, container: Container): string =>
	container === "array"
		? `${Str.repeat(depth)("[")}1${Str.repeat(depth)("]")}`
		: `${Str.repeat(depth)('{"a":')}1${Str.repeat(depth)("}")}`

/** `length` containers, each holding the next, the last holding the one `back` below the root: the root. */
const cycle = (length: number, back: number, container: Container): unknown => {
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

describe("a value outside the model", () => {
	it.effect(
		"is refused at its path, in the direction it arises, and never thrown: the caller's value as MalformedDescription, canonical text read back as MalformedArtifact",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/core/canonical-outside",
						draw: drawn(
							(source) =>
								[source.draw(element(outsides)), source.draw(pathGen), source.draw(leaf)] as const
						),
						literal: Formatter.format,
						coverage: required<Outside>(outsides, { cases: 600, sense: notesOnly }),
						kept: [],
						/**
						 * Twenty-three kinds of value at paths of up to four steps: six hundred cases place each kind tens of times.
						 */
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([kind, path, filler], c) =>
						Effect.sync(() => {
							const plant = planted[kind]
							const v = placed(path, plant.at, filler)
							const result =
								plant.direction === "encode"
									? encode(v, everyProperty)
									: decode(
											jsonText(trusted<Json>(placed(path, plant.at, jsonForm(filler)))),
											revivers
										)
							if (plant.direction === "encode") {
								assert.deepEqual(refusalLoc(refused(result, "MalformedDescription")).path, [
									...path,
									...plant.extra
								])
								assert.equal(canonicalEquals(v, v, everyProperty), false)
							} else {
								const malformed = artifactRefusal(refused(result, "MalformedArtifact"))
								assert.deepEqual(
									[malformed.artifact, malformed.at],
									["canonical", [...path, ...plant.extra]]
								)
							}
							c.note(kind)
						})
				)
			)
	)

	it.effect(
		"is read and written nested to any depth in every direction, the call stack no deeper for it, and the same text comes back",
		(ctx) =>
			Effect.gen(function* () {
				/** The leaf 1 inside `depth` containers. */
				const nest = (depth: number, container: Container): unknown => {
					let v: unknown = 1
					for (let i = 0; i < depth; i++) {
						v = container === "array" ? [v] : { a: v }
					}
					return v
				}
				/** The canonical text of each direction's answer, read back by the serializer, which keeps its stack on the heap too. */
				const textOf = (
					direction: Direction,
					depth: number,
					container: Container
				): Result.Result<string, CompileError> => {
					switch (direction) {
						case "encode":
							return encode(nest(depth, container), everyProperty)
						case "toJson":
							return Result.flatMap(
								toJson(nest(depth, container), everyProperty),
								writeCanonicalJson
							)
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
				yield* searched(
					ctx,
					exhaust(
						{
							box: { kind: "unstated" },
							oracle: { kind: "unstated" },
							suite: "unit/core/canonical-nesting",
							/** No container, one, and a nesting a recursion would overflow the small stack at, each container and direction. */
							generator: (source) =>
								[
									source.draw(element([0, 1, 100_000])),
									source.draw(element<Container>(["array", "object"])),
									source.draw(element<Direction>(directions))
								] as const,
							literal: Formatter.format,
							limit: 24,
							coverage: noCoverage,
							caseHang
						},
						([depth, container, direction]) =>
							Effect.sync(() => {
								assert.equal(
									succeeded(textOf(direction, depth, container)),
									nestedText(depth, container)
								)
							})
					)
				)
			})
	)

	it.effect(
		"is refused as a cycle where it meets itself when it holds itself, however long the cycle, never as a depth",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/core/canonical-cycle",
						/** A cycle through one container, two, and one a recursion would overflow the small stack on, back to its first or last. */
						generator: (source) => {
							const length = source.draw(element([1, 2, 100_000]))
							return [
								length,
								source.draw(element([0, length - 1])),
								source.draw(element<Container>(["array", "object"])),
								source.draw(element(["encode", "toJson", "fromJson"] as const))
							] as const
						},
						literal: Formatter.format,
						limit: 36,
						coverage: noCoverage,
						caseHang
					},
					([length, back, container, direction]) =>
						Effect.sync(() => {
							const root = cycle(length, back, container)
							/** Where the walk meets the container it is already inside: one segment per container on the way. */
							const where = Arr.map(indices(length), () => (container === "array" ? 0 : "a"))
							switch (direction) {
								case "encode":
									assert.deepEqual(
										refusalLoc(refused(encode(root, everyProperty), "MalformedDescription")).path,
										where
									)
									return
								case "toJson":
									assert.deepEqual(
										refusalLoc(refused(toJson(root, everyProperty), "MalformedDescription")).path,
										where
									)
									return
								case "fromJson": {
									const malformed = artifactRefusal(
										refused(fromJson(root, noRevivers), "MalformedArtifact")
									)
									assert.deepEqual([malformed.artifact, malformed.at], ["canonical", where])
								}
							}
						})
				)
			)
	)
})

type OmittedFeature = "an undefined property" | "a SourceLoc under loc" | "another value under loc"

/** A SourceLoc's members as the serializer reads them: a path, a label, and a call site or none. */
type DrawnLoc = Readonly<{
	path: ReadonlyArray<string | number>
	label: string
	site: Readonly<{ file: string; line: number; column: number }> | undefined
}>

const sourceLocGen: Gen<DrawnLoc> = (source) => ({
	path: source.draw(
		array(
			oneOf<string | number>([
				string(codePoint(0x20, 0x7e), { min: 0, max: 4 }),
				int(0, 2 ** 31 - 1)
			]),
			{
				min: 0,
				max: 3
			}
		)
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

describe("the omitted members", () => {
	it.effect(
		"leave out an undefined property, and under omitSourceLocs exactly a SourceLoc under loc",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/core/canonical-omitted",
						draw: drawn(
							(source) =>
								[
									source.draw(
										uniqueArray(
											(source): readonly [string, unknown] => [
												source.draw(filter(key, (k) => k !== "loc", 100)),
												source.draw(value)
											],
											([k]) => k,
											{ min: 0, max: 5 },
											20
										)
									),
									source.draw(
										oneOf<Member>([
											constant({ kind: "undefined" }),
											map(sourceLocGen, (loc) => ({ kind: "loc", loc })),
											map(leaf, (other) => ({ kind: "other", other }))
										])
									)
								] as const
						),
						literal: Formatter.format,
						coverage: required<OmittedFeature>(
							["an undefined property", "a SourceLoc under loc", "another value under loc"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([entries, member], c) =>
						Effect.sync(() => {
							const bare = build(entries)
							switch (member.kind) {
								case "undefined": {
									const v = build([...entries, ["loc", undefined]])
									assert.equal(succeeded(encode(v, everyProperty)), specified(bare))
									c.note("an undefined property")
									return
								}
								case "loc": {
									const v = build([...entries, ["loc", member.loc]])
									assert.equal(succeeded(encode(v, { omit: omitSourceLocs })), specified(bare))
									assert.equal(succeeded(encode(v, everyProperty)), specified(v))
									c.note("a SourceLoc under loc")
									return
								}
								case "other": {
									const v = build([...entries, ["loc", member.other]])
									assert.equal(succeeded(encode(v, { omit: omitSourceLocs })), specified(v))
									c.note("another value under loc")
									return
								}
							}
						})
				)
			)
	)

	it.effect(
		"read a value as it is now: a changed value is written as changed, a frozen one as it stays",
		(ctx) =>
			Effect.gen(function* () {
				type Freezing =
					| "unfrozen"
					| "frozen at the top"
					| "frozen with a mutable loc"
					| "deeply frozen"
				const deepFreeze = (v: unknown): unknown => {
					if (isList(v) || isRecord(v)) {
						for (const child of isList(v) ? v : Rec.values(v)) {
							deepFreeze(child)
						}
						Object.freeze(v)
					}
					return v
				}
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/core/canonical-memo",
							draw: drawn(
								(source) =>
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
							),
							literal: Formatter.format,
							coverage: required<Freezing>(
								["unfrozen", "frozen at the top", "frozen with a mutable loc", "deeply frozen"],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([freezing, v, replacement], c) =>
							Effect.sync(() => {
								c.note(freezing)
								switch (freezing) {
									case "unfrozen":
									case "frozen at the top": {
										const inner: Record<string, unknown> = { k: v }
										const holder = freezing === "unfrozen" ? { inner } : Object.freeze({ inner })
										assert.equal(succeeded(encode(holder, everyProperty)), specified(holder))
										inner["k"] = replacement
										assert.equal(succeeded(encode(holder, everyProperty)), specified(holder))
										return
									}
									case "frozen with a mutable loc": {
										/**
										 * The omission reads the member, so the text of a frozen value with a mutable omitted member is not
										 * remembered: once the loc is no SourceLoc, it is written.
										 */
										const loc: Record<string, unknown> = { label: "relation Task", path: ["Work"] }
										const located = Object.freeze({ v, loc })
										assert.equal(
											succeeded(encode(located, { omit: omitSourceLocs })),
											specified({ v })
										)
										loc["extra"] = replacement
										assert.equal(
											succeeded(encode(located, { omit: omitSourceLocs })),
											specified(located)
										)
										return
									}
									case "deeply frozen": {
										const frozen = deepFreeze({ v })
										assert.equal(succeeded(encode(frozen, everyProperty)), specified(frozen))
										assert.equal(succeeded(encode(frozen, everyProperty)), specified(frozen))
										assert.equal(canonicalEquals(frozen, frozen, everyProperty), true)
										return
									}
								}
							})
					)
				)
			})
	)
})

describe("canonical comparison", () => {
	it.effect(
		"is equality of specified text, and sorts a set by it, refusing a member outside the model at its place",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/core/canonical-compare",
						/**
						 * Planted: two equal arrays that are distinct objects, which the drawn members repeat a few times a run.
						 */
						draw: drawn(
							(source) =>
								[
									source.draw(array(value, { min: 1, max: 4 })),
									source.draw(array(int(0, 2 ** 31 - 1), { min: 0, max: 6 })),
									source.draw(int(0, 2 ** 31 - 1))
								] as const
						),
						literal: Formatter.format,
						coverage: required<"a repeated member" | "two distinct members">(
							["a repeated member", "two distinct members"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [
							{
								note: "[1] beside another [1]",
								sketch: [[[1], [1]], [], 0],
								draws: "",
								reaches: ["a repeated member"]
							}
						],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([distinct, picks, at], c) =>
						Effect.sync(() => {
							const items = [
								...distinct,
								...Arr.map(picks, (p) => defined(distinct[p % distinct.length], "a member"))
							]
							for (const a of items) {
								for (const b of items) {
									const same = specified(a) === specified(b)
									assert.equal(canonicalEquals(a, b, everyProperty), same)
									c.note(same && a !== b ? "a repeated member" : "two distinct members")
								}
							}
							const sorted = succeeded(canonicalSortKeyed(items, everyProperty))
							assert.deepEqual(
								Arr.map(sorted, (k) => specified(k.item)),
								Arr.sort(Arr.map(items, specified), Order.String)
							)
							const place = at % (items.length + 1)
							const withOutside = [...items.slice(0, place), null, ...items.slice(place)]
							assert.deepEqual(
								refusalLoc(
									refused(canonicalSortKeyed(withOutside, everyProperty), "MalformedDescription")
								).path,
								[place]
							)
						})
				)
			)
	)
})

/**
 * A leaf two drawn values often share: strings that JSON escapes or that a tag reads, strings one of which begins
 * another, numbers whose texts begin one another, booleans and bigints.
 */
const nearLeaf = oneOf<unknown>([
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
	]),
	element([0, 1, 12, 10, -1, 1.5, 1e21, 2 ** 53]),
	boolean,
	element([0n, 1n, -12n])
])

/** A value of few small parts nested at most `depth` deep, so two drawn values often share a prefix or are equal. */
const nearValueAt = (depth: number): Gen<unknown> => {
	if (depth === 0) {
		return nearLeaf
	}
	const inner = nearValueAt(depth - 1)
	return oneOf<unknown>([
		nearLeaf,
		array(inner, { min: 0, max: 3 }),
		map(
			uniqueArray(
				(source): readonly [string, unknown] => [
					source.draw(element(["", "a", "b", "~", "1"])),
					source.draw(inner)
				],
				([k]) => k,
				{ min: 0, max: 3 },
				20
			),
			build
		)
	])
}

/** A token's text, as the format's specification spells it: a punctuation token its own, any other JSON's. */
const tokenText = (token: CanonicalToken): string =>
	typeof token === "symbol"
		? defined(token.description, "a punctuation token's text")
		: jsonText(token)

/** Where two token lists first differ, by what stands there. */
type TokenFeature =
	| "equal texts"
	| "two strings"
	| "two numbers"
	| "two numbers, one's text beginning the other's"
	| "a string and another token"
	| "two other tokens"

/** What stands where two token lists first differ. */
const firstDifference = (
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
		return Str.startsWith(ys)(xs) || Str.startsWith(xs)(ys)
			? "two numbers, one's text beginning the other's"
			: "two numbers"
	}
	return typeof x === "string" || typeof y === "string"
		? "a string and another token"
		: "two other tokens"
}

describe("canonical tokens", () => {
	it.effect(
		"spell the canonical text, are one list exactly when the texts are one, and order as the texts do by code unit",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the specified canonical text (RFC 8785 over the JSON form), its spelling, its equality and its UTF-16 code unit order"
						},
						suite: "unit/core/canonical-tokens",
						draw: drawn(
							(source) => [source.draw(nearValueAt(2)), source.draw(nearValueAt(2))] as const
						),
						literal: Formatter.format,
						coverage: required<TokenFeature>(
							[
								"equal texts",
								"two strings",
								"two numbers",
								"two numbers, one's text beginning the other's",
								"a string and another token",
								"two other tokens"
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([a, b], c) =>
						Effect.sync(() => {
							const ta = succeeded(canonicalTokens(a, everyProperty))
							const tb = succeeded(canonicalTokens(b, everyProperty))
							const sa = specified(a)
							const sb = specified(b)
							c.note(firstDifference(ta, tb))
							assert.equal(Arr.join(Arr.map(ta, tokenText), ""), sa, "the tokens spell the text")
							assert.equal(
								new TupleMap<ReadonlyArray<CanonicalToken>, true>().set(ta, true).has(tb),
								sa === sb,
								"two token lists are one exactly when their texts are"
							)
							assert.equal(
								Math.sign(compareCanonicalTokens(ta, tb)),
								Math.sign(Order.String(sa, sb)),
								"the tokens order as their texts by code unit"
							)
						})
				)
			)
	)
})

function normalizeZero(v: unknown): unknown {
	if (Object.is(v, -0)) {
		return 0
	}
	if (isList(v)) {
		return Arr.map(v, normalizeZero)
	}
	if (v instanceof Exact || !isRecord(v)) {
		return v
	}
	return build(Arr.map(Rec.toEntries(v), ([k, child]) => [k, normalizeZero(child)]))
}
