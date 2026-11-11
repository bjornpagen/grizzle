import { Array as Arr, Option, Schema } from "effect"
import {
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	type Weighted,
	weighted
} from "#gen.ts"
import { bigint, type Json, json } from "#values.ts"

/** The kinds of wild value, the simplest first: anything JavaScript can pass that a boundary's types refuse. */
export const WILD_KINDS = [
	"null",
	"undefined",
	"negative-zero",
	"nan",
	"infinity",
	"bigint-for-number",
	"number-for-bigint",
	"lone-surrogate",
	"nul-character",
	"symbol",
	"function",
	"proxy",
	"throwing-getter",
	"anything"
] as const

export type WildKind = (typeof WILD_KINDS)[number]

/**
 * A wild value as data: its kind and what was drawn for it, never the hostile value itself, which `passed` makes only
 * as it hands the value to the boundary. A report, a printed case or a kept literal reads the data, so a proxy that
 * refuses every operation never reaches anything but the code under test, and a kept case states the exact value.
 */
export type Wild =
	| Readonly<{ kind: "null" }>
	| Readonly<{ kind: "undefined" }>
	| Readonly<{ kind: "negative-zero" }>
	| Readonly<{ kind: "nan" }>
	| Readonly<{ kind: "infinity"; negative: boolean }>
	| Readonly<{ kind: "bigint-for-number"; value: bigint }>
	| Readonly<{ kind: "number-for-bigint"; value: number }>
	| Readonly<{ kind: "lone-surrogate"; before: string; unit: number; after: string }>
	| Readonly<{ kind: "nul-character"; before: string; after: string }>
	| Readonly<{ kind: "symbol"; description: string }>
	| Readonly<{ kind: "function" }>
	| Readonly<{ kind: "proxy" }>
	| Readonly<{ kind: "throwing-getter"; key: string }>
	| Readonly<{ kind: "anything"; value: Json }>

type WildOf<K extends WildKind> = Extract<Wild, Readonly<{ kind: K }>>

const text = (max: number) => string(codePoint(0x20, 0x7e), { min: 0, max })

const WILD = {
	null: constant({ kind: "null" }),
	undefined: constant({ kind: "undefined" }),
	"negative-zero": constant({ kind: "negative-zero" }),
	nan: constant({ kind: "nan" }),
	infinity: map(boolean, (negative) => ({ kind: "infinity", negative })),
	"bigint-for-number": map(bigint(-(2n ** 70n), 2n ** 70n), (value) => ({
		kind: "bigint-for-number",
		value
	})),
	"number-for-bigint": map(int(-(2 ** 31), 2 ** 31 - 1), (value) => ({
		kind: "number-for-bigint",
		value
	})),
	"lone-surrogate": (source) => ({
		kind: "lone-surrogate",
		before: source.draw(text(4)),
		unit: source.draw(int(0xd8_00, 0xdf_ff)),
		after: source.draw(text(4))
	}),
	"nul-character": (source) => ({
		kind: "nul-character",
		before: source.draw(text(4)),
		after: source.draw(text(4))
	}),
	symbol: map(text(4), (description) => ({ kind: "symbol", description })),
	function: constant({ kind: "function" }),
	proxy: constant({ kind: "proxy" }),
	"throwing-getter": map(string(codePoint(0x61, 0x7a), { min: 1, max: 8 }), (key) => ({
		kind: "throwing-getter",
		key
	})),
	anything: map(json(2), (value) => ({ kind: "anything", value }))
} as const satisfies { readonly [K in WildKind]: Gen<WildOf<K>> }

const SIMPLEST = {
	null: { kind: "null" },
	undefined: { kind: "undefined" },
	"negative-zero": { kind: "negative-zero" },
	nan: { kind: "nan" },
	infinity: { kind: "infinity", negative: false },
	"bigint-for-number": { kind: "bigint-for-number", value: 0n },
	"number-for-bigint": { kind: "number-for-bigint", value: 0 },
	"lone-surrogate": { kind: "lone-surrogate", before: "", unit: 0xd8_00, after: "" },
	"nul-character": { kind: "nul-character", before: "", after: "" },
	symbol: { kind: "symbol", description: "" },
	function: { kind: "function" },
	proxy: { kind: "proxy" },
	"throwing-getter": { kind: "throwing-getter", key: "a" },
	anything: { kind: "anything", value: null }
} as const satisfies { readonly [K in WildKind]: WildOf<K> }

const wilds: Readonly<Record<WildKind, Gen<Wild>>> = WILD

const simplest: Readonly<Record<WildKind, Wild>> = SIMPLEST

/** The simplest wild value of a kind, for a kept case. */
export const wildOf = (kind: WildKind): Wild => simplest[kind]

/** One wild value of the given kinds, shrinking toward the first kind and its simplest value: list the simplest first. */
export const wild =
	(kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Wild> =>
	(source) =>
		source.draw(wilds[source.draw(element(kinds))])

/**
 * Whether a wild value of each kind is data: a value whose every property, at any depth, is a data property, read
 * without running the caller's code. A proxy that refuses every operation and an object whose property is a getter are
 * not, and a boundary that reads its argument as data before it judges any part of it refuses them wherever in the
 * argument they sit.
 */
export const WILD_IS_DATA: Readonly<Record<WildKind, boolean>> = {
	null: true,
	undefined: true,
	"negative-zero": true,
	nan: true,
	infinity: true,
	"bigint-for-number": true,
	"number-for-bigint": true,
	"lone-surrogate": true,
	"nul-character": true,
	symbol: true,
	function: true,
	proxy: false,
	"throwing-getter": false,
	anything: true
}

/** What a hostile value throws when anything touches it. */
export class WildTouched extends Schema.TaggedError<
	WildTouched,
	{ readonly brand: unique symbol }
>()("WildTouched", { kind: Schema.Literals(["proxy", "throwing-getter"]) }) {}

/** A proxy that refuses every operation: reading, writing, enumerating, inspecting or calling it throws. */
const hostileProxy = (): object => {
	const refuse = (): never => {
		throw WildTouched.make({ kind: "proxy" })
	}
	return new Proxy(
		{},
		{
			get: refuse,
			set: refuse,
			has: refuse,
			deleteProperty: refuse,
			ownKeys: refuse,
			getOwnPropertyDescriptor: refuse,
			defineProperty: refuse,
			getPrototypeOf: refuse,
			setPrototypeOf: refuse,
			isExtensible: refuse,
			preventExtensions: refuse,
			apply: refuse,
			construct: refuse
		}
	)
}

/** The hostile value a wild value stands for, made fresh on every call. */
const hostile = (drawn: Wild): unknown => {
	switch (drawn.kind) {
		case "null":
			return null
		case "undefined":
			return undefined
		case "negative-zero":
			return -0
		case "nan":
			return Number.NaN
		case "infinity":
			return drawn.negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
		case "bigint-for-number":
		case "number-for-bigint":
			return drawn.value
		case "lone-surrogate":
			return `${drawn.before}${String.fromCharCode(drawn.unit)}${drawn.after}`
		case "nul-character":
			return `${drawn.before}\u0000${drawn.after}`
		case "symbol":
			return Symbol(drawn.description)
		case "function":
			return () => undefined
		case "proxy":
			return hostileProxy()
		case "throwing-getter":
			return Object.defineProperty({}, drawn.key, {
				enumerable: true,
				get: () => {
					throw WildTouched.make({ kind: "throwing-getter" })
				}
			})
		case "anything":
			return drawn.value
	}
}

/** A value from an earlier state, with where it comes from: "closed scope", "former generation", "another Db". */
export type Stale<T, From extends string> = Readonly<{ value: T; from: From }>

/**
 * A value a public boundary may be handed:
 * - live: a valid value of the boundary's own type, built valid by its generator, never filtered out of noise;
 * - stale: a value that was live once but belongs to another state (an earlier scope, a closed handle, a former
 *   generation of the schema, another query), naming where;
 * - wild: anything JavaScript can pass that the types refuse.
 *
 * The boundary answers a live value by its contract, and a stale or wild one by a typed refusal from its vocabulary:
 * never a defect, a hang, a leak or a message sent.
 */
export type Drawn<T, From extends string> =
	| Readonly<{ kind: "live"; value: T }>
	| Readonly<{ kind: "stale"; value: T; from: From }>
	| Readonly<{ kind: "wild"; wild: Wild }>

/**
 * Where a boundary's values come from: its live generator, its stale values when it has earlier states (a boundary
 * with none draws live and wild values only), and the wild kinds it is handed, simplest first.
 */
export type Arms<T, From extends string> = Readonly<{
	live: Gen<T>
	stale: Option.Option<Gen<Stale<T, From>>>
	wild: Arr.NonEmptyReadonlyArray<WildKind>
}>

/**
 * A live, stale or wild value, equally often, live first, so a failing case shrinks toward a live value and a wild one
 * toward the simplest wild kind. Every drawn kind is a feature (`drawnFeature`), so a suite can require that each was
 * drawn and refused. Arms with no stale values name no source of staleness.
 */
export const lsw = <T, From extends string = never>(arms: Arms<T, From>): Gen<Drawn<T, From>> => {
	const live: Weighted<Drawn<T, From>> = [1, map(arms.live, (value) => ({ kind: "live", value }))]
	const wildArm: Weighted<Drawn<T, From>> = [
		1,
		map(wild(arms.wild), (drawn) => ({ kind: "wild", wild: drawn }))
	]
	return Option.match(arms.stale, {
		onNone: () => weighted([live, wildArm]),
		onSome: (stale) =>
			weighted([
				live,
				[1, map(stale, ({ value, from }) => ({ kind: "stale", value, from }))],
				wildArm
			])
	})
}

/** The feature a drawn value names: its kind, where a stale value came from, and which wild kind it is. */
export type DrawnFeature<From extends string> = "live" | `stale ${From}` | `wild ${WildKind}`

/** The feature of a drawn value. */
export const drawnFeature = <T, From extends string>(drawn: Drawn<T, From>): DrawnFeature<From> => {
	switch (drawn.kind) {
		case "live":
			return "live"
		case "stale":
			return `stale ${drawn.from}`
		case "wild":
			return `wild ${drawn.wild.kind}`
	}
}

/** The value a drawn value hands the boundary: the only place a wild value's hostile form is made. */
export const passed = <T, From extends string>(drawn: Drawn<T, From>): unknown =>
	drawn.kind === "wild" ? hostile(drawn.wild) : drawn.value

/**
 * One site where a corruption broke its rule: the artifact as the boundary receives it, which is no longer of the live
 * type, the refusal the boundary must answer with, and the site by what it is (a node kind, a field), never by an
 * identifier.
 */
export type Broken<R> = Readonly<{ value: unknown; refusal: R; at: string }>

/**
 * A named way to break a rule of a valid artifact: every site of a live artifact where the rule can be broken, with
 * the refusal each must meet. A live artifact with no such site gives none.
 */
export type Corruption<T, R, Rule extends string> = Readonly<{
	rule: Rule
	from: "stale" | "wild"
	sites: (live: T) => ReadonlyArray<Broken<R>>
}>

/** A live artifact, or one broken at one site with the refusal it must meet. */
export type Corrupted<T, R, Rule extends string> =
	| Readonly<{ kind: "live"; value: T }>
	| Readonly<{
			kind: "stale" | "wild"
			rule: Rule
			at: string
			value: unknown
			refusal: R
	  }>

/**
 * A live artifact, or the artifact with one rule broken at one site: the live artifact one draw in six, and otherwise a
 * rule among the corruptions that have a site in it, and a site of that rule. A boundary that checks a whole artifact
 * (a validator, a decoder, a checker) must accept the live artifact and refuse each corrupted one with exactly its
 * refusal. The live case is the first choice, so a failure shrinks to the live artifact when the boundary refuses it,
 * and otherwise to the first rule and site that still fail. An artifact no corruption has a site in is drawn live.
 */
export const corrupted = <T, R, Rule extends string>(
	live: T,
	corruptions: Arr.NonEmptyReadonlyArray<Corruption<T, R, Rule>>
): Gen<Corrupted<T, R, Rule>> => {
	const unbroken: Corrupted<T, R, Rule> = { kind: "live", value: live }
	const applicable = Arr.flatMap(corruptions, (corruption) => {
		const sites = corruption.sites(live)
		return Arr.isReadonlyArrayNonEmpty(sites) ? [{ corruption, sites }] : []
	})
	if (!Arr.isReadonlyArrayNonEmpty(applicable)) {
		return constant(unbroken)
	}
	return weighted<Corrupted<T, R, Rule>>([
		[1, constant(unbroken)],
		[
			5,
			(source) => {
				const { corruption, sites } = source.draw(element(applicable))
				const broken = source.draw(element(sites))
				return {
					kind: corruption.from,
					rule: corruption.rule,
					at: broken.at,
					value: broken.value,
					refusal: broken.refusal
				}
			}
		]
	])
}

/** The feature a corrupted case names: live, or the kind and the rule it broke. */
export type CorruptedFeature<Rule extends string> = "live" | `${"stale" | "wild"} ${Rule}`

/** The feature of a corrupted case. */
export const corruptedFeature = <T, R, Rule extends string>(
	drawn: Corrupted<T, R, Rule>
): CorruptedFeature<Rule> => (drawn.kind === "live" ? "live" : `${drawn.kind} ${drawn.rule}`)
