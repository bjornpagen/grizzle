/**
 * A paged member's window, read at the boundary before any SQL (packages/grizzle/src/adapter/page/window.ts windowCall).
 *
 * A window is exactly `{ anchor, size }`, its size a safe integer of at least 1 with no upper bound, its anchor exactly
 * `{ kind: "start" }`, `{ kind: "end" }`, `{ kind: "after", key }` or `{ kind: "before", key }`, whose key is a list of
 * one value per comparator of the page's completed order, each admitted by its comparator's codec. A window of any other
 * own members is refused as CallInputRefused `window`, a size the rule refuses as `size`, and every other anchor as
 * `anchor`, judged in that order; an inherited member is no member, and a symbol key is an own member. An admitted window
 * is the call of its template: start the first, after the after, end the last and before the before template, its size,
 * and an anchored one's boundary, each comparator's canonical text of the key's value at its position. The rule is
 * restated here as the oracle, over comparators drawn from int4, int8, bool, uuid and text and windows drawn over every
 * member's presence, own or inherited, and every size, kind, key length and key value, each comparator's edge values and
 * the other carriers' among them.
 *
 * Features: each admitted kind, each refusal, an inherited member, a key of another length, and each comparator's key
 * value admitted and refused.
 *
 * Plants: window-size-zero-admitted (a size of 0 admitted), window-key-length-unchecked (a key longer than the
 * comparators admitted), window-inherited-kind-read (an inherited kind read as the anchor's).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { CallInputRefused, type CallInputFault } from "#adapter/errors/failures.ts"
import type { PageCall } from "#adapter/page/execute.ts"
import { windowCall } from "#adapter/page/window.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { ParamText } from "#compiler/plan/common.ts"
import { scalarCodec } from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { bool, int4, int8, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import { paramText } from "#test/support/wire.ts"

/** The carriers a comparator is drawn from: each one's admission and canonical text restated below. */
type Comparator = "int4" | "int8" | "bool" | "uuid" | "text"
const comparatorNames: Arr.NonEmptyReadonlyArray<Comparator> = [
	"int4",
	"int8",
	"bool",
	"uuid",
	"text"
]

const comparatorTypes: { readonly [C in Comparator]: ScalarType } = {
	int4,
	int8,
	bool,
	uuid: scalarOfSpec({ carrier: "uuid" }),
	text: scalarOfSpec({ carrier: "text" })
}

const uuidSyntax = regex(
	"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

/**
 * Each comparator's codec, restated: the canonical text of a value it admits, none for a value it refuses. An int4 is
 * an integer number of 32 bits, -0 its one zero; an int8 a bigint of 64 bits; a bool a boolean; a uuid 32 hex digits
 * hyphenated 8-4-4-4-12, either case, written lowercase; a text a well-formed string with no NUL.
 */
const admittedText: { readonly [C in Comparator]: (value: unknown) => Option.Option<string> } = {
	int4: (value) =>
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= -(2 ** 31) &&
		value <= 2 ** 31 - 1
			? Option.some(String(value === 0 ? 0 : value))
			: Option.none(),
	int8: (value) =>
		typeof value === "bigint" && value >= -(2n ** 63n) && value <= 2n ** 63n - 1n
			? Option.some(String(value))
			: Option.none(),
	bool: (value) =>
		typeof value === "boolean" ? Option.some(value ? "true" : "false") : Option.none(),
	uuid: (value) =>
		typeof value === "string" && uuidSyntax.test(value)
			? Option.some(Str.toLowerCase(value))
			: Option.none(),
	text: (value) =>
		typeof value === "string" && !Str.includes("\u0000")(value) && value.isWellFormed()
			? Option.some(value)
			: Option.none()
}

/** The values the codecs branch on: every comparator's edges, its neighbours past them, and other carriers' values. */
const valueDictionary: Arr.NonEmptyReadonlyArray<unknown> = [
	0,
	-0,
	1,
	-1,
	1.5,
	2 ** 31 - 1,
	2 ** 31,
	-(2 ** 31),
	-(2 ** 31) - 1,
	Number.MAX_SAFE_INTEGER,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	0n,
	-1n,
	2n ** 63n - 1n,
	2n ** 63n,
	-(2n ** 63n),
	-(2n ** 63n) - 1n,
	true,
	false,
	"",
	"0",
	"true",
	"\u{1D518}nicode",
	"a\u0000b",
	"\uD800",
	"00000000-0000-4000-8000-00000000000a",
	"00000000-0000-4000-8000-00000000000A",
	"00000000-0000-4000-8000-00000000000g",
	"00000000000040008000-0000-00000000000a",
	"00000000-0000-4000-8000-00000000000",
	null,
	undefined,
	{},
	[]
]

const hexDigit = element([
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"a",
	"b",
	"c",
	"d",
	"e",
	"f",
	"A",
	"B",
	"C",
	"D",
	"E",
	"F"
])

/** A uuid's text in either case: 32 hex digits hyphenated 8-4-4-4-12. */
const uuidGen: Gen<string> = (source) =>
	Arr.join(
		Arr.map([8, 4, 4, 4, 12], (n) => source.draw(string(hexDigit, { min: n, max: n }))),
		"-"
	)

/** Each comparator's own values: what a key of a row of its column holds. */
const liveValue: { readonly [C in Comparator]: Gen<unknown> } = {
	int4: int(-(2 ** 31), 2 ** 31 - 1),
	int8: map(int(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), BigInt),
	bool: boolean,
	uuid: uuidGen,
	text: string(codePoint(0, 0x10_ffff), { min: 0, max: 4 })
}

/** A key value at a comparator: mostly its own, else one of the dictionary's. */
const keyValueGen = (comparator: Comparator): Gen<unknown> =>
	weighted([
		[4, liveValue[comparator]],
		[1, element(valueDictionary)]
	])

/** A member's presence: absent, own, or inherited from the prototype. */
type Presence = "absent" | "own" | "inherited"

const presenceGen: Gen<Presence> = weighted<Presence>([
	[1, constant("absent")],
	[4, constant("own")],
	[1, constant("inherited")]
])

/** A member besides the record's own: none, a string key or a symbol key. */
type Extra = "none" | "a string key" | "a symbol key"

const extraGen: Gen<Extra> = weighted<Extra>([
	[4, constant("none")],
	[1, constant("a string key")],
	[1, constant("a symbol key")]
])

const sizeGen: Gen<unknown> = weighted([
	[4, int(1, 7)],
	[1, int(1, Number.MAX_SAFE_INTEGER)],
	[
		2,
		element<unknown>([
			Number.MAX_SAFE_INTEGER,
			0,
			-0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			1n,
			"3",
			null,
			undefined
		])
	]
])

/** Values that are no record: what a window or an anchor drawn as no object is. */
const notRecordGen: Gen<unknown> = element<unknown>([null, undefined, 3, "start", ["start"]])

const kindGen: Gen<unknown> = weighted([
	[4, element<unknown>(["start", "after", "end", "before"])],
	[1, element<unknown>(["first", "last", "Start", 0, null])]
])

/** An anchor's key: a list one shorter than, as long as or one longer than the comparators, or no list. */
type KeyShape =
	| { readonly kind: "a list"; readonly delta: -1 | 0 | 1; readonly values: ReadonlyArray<unknown> }
	| { readonly kind: "no list"; readonly value: unknown }

interface AnchorCase {
	readonly shape: "an object" | "no object"
	readonly notObject: unknown
	readonly kind: { readonly presence: Presence; readonly value: unknown }
	readonly key: { readonly presence: Presence; readonly value: KeyShape }
	readonly extra: Extra
}

interface WindowCase {
	readonly comparators: Arr.NonEmptyReadonlyArray<Comparator>
	readonly shape: "an object" | "no object"
	readonly notObject: unknown
	readonly size: { readonly presence: Presence; readonly value: unknown }
	readonly anchor: { readonly presence: Presence; readonly value: AnchorCase }
	readonly extra: Extra
}

const keyShapeGen =
	(comparators: ReadonlyArray<Comparator>): Gen<KeyShape> =>
	(source) =>
		source.draw(
			weighted<KeyShape>([
				[
					6,
					(inner) => ({
						kind: "a list",
						delta: inner.draw(
							weighted<-1 | 0 | 1>([
								[1, constant(-1)],
								[6, constant(0)],
								[1, constant(1)]
							])
						),
						values: [
							...Arr.map(comparators, (c) => inner.draw(keyValueGen(c))),
							inner.draw(element(valueDictionary))
						]
					})
				],
				[1, (inner) => ({ kind: "no list", value: inner.draw(element(valueDictionary)) })]
			])
		)

const anchorCaseGen =
	(comparators: ReadonlyArray<Comparator>): Gen<AnchorCase> =>
	(source) => ({
		shape: source.draw(
			weighted<AnchorCase["shape"]>([
				[6, constant("an object")],
				[1, constant("no object")]
			])
		),
		notObject: source.draw(notRecordGen),
		kind: { presence: source.draw(presenceGen), value: source.draw(kindGen) },
		key: { presence: source.draw(presenceGen), value: source.draw(keyShapeGen(comparators)) },
		extra: source.draw(extraGen)
	})

const windowCaseGen: Gen<WindowCase> = (source) => {
	const comparators: Arr.NonEmptyReadonlyArray<Comparator> = [
		source.draw(element(comparatorNames)),
		...source.draw(array(element(comparatorNames), { min: 0, max: 2 }))
	]
	return {
		comparators,
		shape: source.draw(
			weighted<WindowCase["shape"]>([
				[6, constant("an object")],
				[1, constant("no object")]
			])
		),
		notObject: source.draw(notRecordGen),
		size: { presence: source.draw(presenceGen), value: source.draw(sizeGen) },
		anchor: { presence: source.draw(presenceGen), value: source.draw(anchorCaseGen(comparators)) },
		extra: source.draw(extraGen)
	}
}

/** The values of a key list: its comparators' count, shifted by its delta. */
const keyValues = (
	shape: Extract<KeyShape, { readonly kind: "a list" }>,
	comparators: ReadonlyArray<Comparator>
): ReadonlyArray<unknown> => shape.values.slice(0, comparators.length + shape.delta)

/**
 * A record of `members`, each own or inherited by its presence, an absent one left out, with the extra member drawn:
 * own members on the record, inherited ones on its prototype.
 */
const recordOf = (
	members: ReadonlyArray<readonly [string, Presence, unknown]>,
	extra: Extra
): unknown => {
	const proto: Record<string, unknown> = {}
	const own: Record<string | symbol, unknown> = {}
	for (const [name, presence, value] of members) {
		if (presence === "own") {
			own[name] = value
		}
		if (presence === "inherited") {
			proto[name] = value
		}
	}
	if (extra === "a string key") {
		own["total"] = true
	}
	if (extra === "a symbol key") {
		own[Symbol("x")] = 1
	}
	return Object.assign(Object.create(proto), own)
}

const keyOf = (c: WindowCase): unknown => {
	const key = c.anchor.value.key.value
	return key.kind === "a list" ? keyValues(key, c.comparators) : key.value
}

const anchorOf = (c: WindowCase): unknown => {
	const a = c.anchor.value
	return a.shape === "no object"
		? a.notObject
		: recordOf(
				[
					["kind", a.kind.presence, a.kind.value],
					["key", a.key.presence, keyOf(c)]
				],
				a.extra
			)
}

/** The window a case builds. */
const windowOf = (c: WindowCase): unknown =>
	c.shape === "no object"
		? c.notObject
		: recordOf(
				[
					["anchor", c.anchor.presence, anchorOf(c)],
					["size", c.size.presence, c.size.value]
				],
				c.extra
			)

type WindowFeature =
	| "start"
	| "after"
	| "end"
	| "before"
	| CallInputFault
	| "an inherited member"
	| "a key of another length"
	| `an admitted ${Comparator} value`
	| `a refused ${Comparator} value`

/** What the rule answers: the call, or the refusal with its fault, with what the case reached on the way. */
type Expected =
	| {
			readonly kind: "admitted"
			readonly call: PageCall
			readonly reached: ReadonlyArray<WindowFeature>
	  }
	| {
			readonly kind: "refused"
			readonly fault: CallInputFault
			readonly reached: ReadonlyArray<WindowFeature>
	  }

const refusedFor = (fault: CallInputFault, reached: ReadonlyArray<WindowFeature>): Expected => ({
	kind: "refused",
	fault,
	reached: [fault, ...reached]
})

/** Whether the members of a drawn record are exactly `names`, each own, with no extra. */
const exactly = (
	extra: Extra,
	members: ReadonlyArray<readonly [string, Presence]>,
	names: ReadonlyArray<string>
): boolean =>
	extra === "none" &&
	Arr.every(members, ([name, presence]) => (presence === "own") === names.includes(name))

const templates = { start: "first", after: "after", end: "last", before: "before" } as const

const isKind = (value: unknown): value is keyof typeof templates =>
	value === "start" || value === "after" || value === "end" || value === "before"

/**
 * The rule, restated (see the header): the window's own members, then its size, then its anchor's kind, own members and
 * key, each key value by its comparator's codec in order.
 */
const expectedOf = (c: WindowCase): Expected => {
	if (
		c.shape === "no object" ||
		!exactly(
			c.extra,
			[
				["anchor", c.anchor.presence],
				["size", c.size.presence]
			],
			["anchor", "size"]
		)
	) {
		return refusedFor("window", [])
	}
	const size = c.size.value
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
		return refusedFor("size", [])
	}
	const a = c.anchor.value
	if (a.shape === "no object" || a.kind.presence !== "own" || !isKind(a.kind.value)) {
		return refusedFor("anchor", [])
	}
	const kind = a.kind.value
	const keyed = kind === "after" || kind === "before"
	const members: ReadonlyArray<readonly [string, Presence]> = [
		["kind", a.kind.presence],
		["key", a.key.presence]
	]
	if (!exactly(a.extra, members, keyed ? ["kind", "key"] : ["kind"])) {
		return refusedFor("anchor", [])
	}
	if (kind === "start" || kind === "end") {
		return { kind: "admitted", call: { variant: templates[kind], size }, reached: [kind] }
	}
	const key = a.key.value
	if (key.kind === "no list") {
		return refusedFor("anchor", [])
	}
	if (key.delta !== 0) {
		return refusedFor("anchor", ["a key of another length"])
	}
	const boundary: Array<ParamText> = []
	const admitted: Array<WindowFeature> = []
	for (const [at, comparator] of c.comparators.entries()) {
		const text = admittedText[comparator](key.values[at])
		if (Option.isNone(text)) {
			return refusedFor("anchor", [`a refused ${comparator} value`])
		}
		boundary.push(paramText(text.value))
		admitted.push(`an admitted ${comparator} value`)
	}
	return {
		kind: "admitted",
		call: { variant: templates[kind], size, boundary },
		reached: [kind, ...admitted]
	}
}

const presences = (c: WindowCase): ReadonlyArray<Presence> => [
	c.size.presence,
	c.anchor.presence,
	c.anchor.value.kind.presence,
	c.anchor.value.key.presence
]

describe("a window", () => {
	it.effect(
		"admits exactly an anchor and a size as its template's call, and refuses every other window by its members, its size or its anchor",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the window rule restated (expectedOf)" },
						suite: "unit/page/window",
						draw: drawn(windowCaseGen),
						literal: Formatter.format,
						coverage: required<WindowFeature>(
							[
								"start",
								"after",
								"end",
								"before",
								"window",
								"size",
								"anchor",
								"an inherited member",
								"a key of another length",
								...Arr.flatMap(comparatorNames, (comparator): ReadonlyArray<WindowFeature> => [
									`an admitted ${comparator} value`,
									`a refused ${comparator} value`
								])
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, note) =>
						Effect.sync(() => {
							if (Arr.some(presences(c), (p) => p === "inherited")) {
								note.note("an inherited member")
							}
							const expected = expectedOf(c)
							note.noteAll(expected.reached)
							const codecs = Arr.map(c.comparators, (comparator) =>
								scalarCodec(comparatorTypes[comparator], emptyCodebook)
							)
							assert.deepEqual(
								windowCall(windowOf(c), codecs),
								expected.kind === "admitted"
									? Result.succeed(expected.call)
									: Result.fail(new CallInputRefused({ fault: expected.fault }))
							)
						})
				)
			)
	)
})
