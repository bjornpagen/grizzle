/** What the properties of contract.test.ts read: its spaces, models and helpers. */

import {
	aimed,
	array,
	codePoint,
	element,
	type Gen,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import {
	type Drawn,
	lsw,
	WILD_KINDS,
	type Wild,
	type WildKind,
	wild
} from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import { type Json, json } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { contract, natural, range, variant } from "#compiler/public/fields.ts"
import { param, query } from "#compiler/public/query.ts"
import { closed, fn, row, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { clocked } from "#compiler/public/workload.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { int4, int8, money, numeric } from "#compiler/scalar/pg.ts"
import { accumulatedField, drawnField } from "#compiler/schema/relation.ts"

type BaseName = "integer" | "bigint" | "numeric(p,s)" | "money" | "pattern" | "span"

export const baseNames: Arr.NonEmptyReadonlyArray<BaseName> = [
	"integer",
	"bigint",
	"numeric(p,s)",
	"money",
	"pattern",
	"span"
]

const Lower = str.regex("^[a-z]+$", "u")

const IntSpan = range(int4)

export const baseOfName = (name: BaseName, precision: number): unknown => {
	switch (name) {
		case "integer":
			return int4
		case "bigint":
			return int8
		case "numeric(p,s)":
			return numeric(precision, Math.floor(precision / 2))
		case "money":
			return money
		case "pattern":
			return Lower
		case "span":
			return IntSpan
	}
}

/** A predicate the base's value admits: a comparison of an integer-like value, or none. */
export const predicateFor = (
	name: BaseName,
	wanted: boolean
): ((v: ScalarTerm) => { readonly expr: unknown }) | undefined =>
	wanted && (name === "integer" || name === "bigint")
		? (v: ScalarTerm) => computeCore.ge(v, name === "integer" ? 0 : 0n)
		: undefined

export type IdentityFeature =
	| `${BaseName} ${"with" | "without"} a predicate`
	| "a minted base refused"
	| "no predicate built"

/**
 * What contract()(name, base) admits from a JavaScript caller: no value at its first call, whose one argument is the
 * host's key, a type, then a declared name (core/identity.ts parseDeclaredName, the naming door's one rule), a
 * descriptor a builder made, and no argument past the predicate. A live name is drawn near
 * the rule's edges, a name of the rule's characters led by any of them or a printable ASCII string, and a name the wild
 * arm draws is judged by what it is ("anything" may draw a declared name); a wild base is never a descriptor.
 * Everything else is MalformedDescription.
 */
export type AdmissionFeature =
	| "live"
	| "a string name the declared-name rule refuses"
	| `wild ${"name" | "base"} ${WildKind}`
	| "extra argument"
	| "a value at the first call"

export const isDeclaredName = (name: unknown): name is string =>
	typeof name === "string" && parseDeclaredName(name).ok

/** A call of contract()(name, base): its first call's arguments, its name, its base, and the arguments past the predicate. */
type AdmissionCase = Readonly<{
	first: ReadonlyArray<Json>
	name: Drawn<string, never>
	base: Drawn<unknown, never>
	extra: ReadonlyArray<Json>
}>

/**
 * A contract's name: a live one of the rule's characters or a printable ASCII string, or a wild value of one of
 * `kinds`.
 */
const admissionName = (kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Drawn<string, never>> =>
	lsw({
		live: weighted([
			[1, matching(regex("^[A-Za-z0-9_]{1,12}$"))],
			[1, string(codePoint(0x20, 0x7e), { min: 1, max: 12 })]
		]),
		stale: Option.none(),
		wild: kinds
	})

/** A contract's base: a live descriptor a builder made, or a wild value of one of `kinds`. */
const admissionBase = (kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Drawn<unknown, never>> =>
	lsw<unknown>({
		live: element<unknown>([int8, int4, numeric(9, 2), str.regex("^a$", "u")]),
		stale: Option.none(),
		wild: kinds
	})

/** A wild value of `kind` alone. */
const wildOnly = <T>(kind: WildKind): Gen<Drawn<T, never>> =>
	map(wild([kind]), (drawn): Drawn<T, never> => ({ kind: "wild", wild: drawn }))

/**
 * A call of contract()(name, base) whose name and base `name` and `base` draw, up to one value at its first call, and up
 * to one argument past the predicate.
 */
const admissionCaseOf =
	(name: Gen<Drawn<string, never>>, base: Gen<Drawn<unknown, never>>): Gen<AdmissionCase> =>
	(source) => ({
		first: source.draw(array(json(2), { min: 0, max: 1 })),
		name: source.draw(name),
		base: source.draw(base),
		extra: source.draw(array(json(2), { min: 0, max: 1 }))
	})

/**
 * Calls of contract()(name, base) over live names near the rule's edges, live descriptors, and every wild kind as name and
 * as base, aimed at each wild kind still pending: a name or a base of that kind alone.
 */
export const admissionSpace = aimed<AdmissionCase, AdmissionFeature>(
	admissionCaseOf(admissionName(WILD_KINDS), admissionBase(WILD_KINDS)),
	Arr.flatMap(
		WILD_KINDS,
		(kind): ReadonlyArray<readonly [AdmissionFeature, Gen<AdmissionCase>]> => [
			[`wild name ${kind}`, admissionCaseOf(wildOnly(kind), admissionBase(WILD_KINDS))],
			[`wild base ${kind}`, admissionCaseOf(admissionName(WILD_KINDS), wildOnly(kind))]
		]
	)
)

/**
 * A key as a JavaScript caller hands mintOf one: a symbol of its module's own, made of a name, a registered one, which
 * Symbol.for gives any module by that name, or a wild value of any kind, a symbol among them.
 */
export type KeyCase =
	| Readonly<{ kind: "own"; name: string }>
	| Readonly<{ kind: "registered"; name: string }>
	| Readonly<{ kind: "wild"; wild: Wild }>

export type KeyFeature = "an own key" | "a registered key" | `a wild key ${WildKind}`

/** A key's name: a few letters. */
const keyName = matching(regex("^[A-Za-z]{1,8}$"))

/** Keys of every kind: a module's own, a registered one, and a wild value of each kind. */
export const keySpace: Gen<KeyCase> = weighted<KeyCase>([
	[2, (s) => ({ kind: "own", name: s.draw(keyName) })],
	[1, (s) => ({ kind: "registered", name: s.draw(keyName) })],
	[2, (s) => ({ kind: "wild", wild: s.draw(wild(WILD_KINDS)) })]
])

/** Where the database makes a value from values of other types (scalar/contract.ts admitMintKey). */
export type MintPosition = "a cast" | "a drawn field" | "an accumulated field"

/** What a mint or a held position makes: a consumer's contract, or natural or bigint, which no consumer owns. */
export type MintTarget = "a consumer's contract" | "natural" | "bigint"

/** A mint as a JavaScript caller makes one: its position, its target, and the keys it hands after its own arguments. */
export type MintCase = Readonly<{
	position: MintPosition
	target: MintTarget
	keys: ReadonlyArray<KeyCase>
}>

export type MintFeature = `${MintPosition} into ${MintTarget}` | "no key" | "one key" | "two keys"

/** The positions of a mint. */
export const mintPositions = ["a cast", "a drawn field", "an accumulated field"] as const

/** The targets of a position: drawn draws natural and a contract over an integer alone, no bigint. */
export const mintTargetsOf = (position: MintPosition): Arr.NonEmptyReadonlyArray<MintTarget> =>
	position === "a drawn field"
		? ["a consumer's contract", "natural"]
		: ["a consumer's contract", "natural", "bigint"]

/** Mints at every position into every target it makes, handed none, one or two keys of every kind. */
export const mintSpace: Gen<MintCase> = (source) => {
	const position = source.draw(element(mintPositions))
	return {
		position,
		target: source.draw(element(mintTargetsOf(position))),
		keys: source.draw(array(keySpace, { min: 0, max: 2 }))
	}
}

const amountKey = Symbol("Amount")
/** A consumer's contract over bigint, the one a mint into a consumer's contract makes. */
const Amount = contract<typeof amountKey>()("Amount", int8)

/** Each target's descriptor. */
const mintTargets: { readonly [T in MintTarget]: unknown } = {
	"a consumer's contract": Amount,
	natural,
	bigint: int8
}

/** What a mint's call answers, by the rule: it is made, or refused for the reason of its tag. */
export type MintVerdict = "made" | "MalformedDescription" | "Refused"

/**
 * The rule restated: a mint into a consumer's contract is made under one key, a symbol no registry holds, refused by the
 * rule the types name under a registered one, and malformed under no key, two, or a value that is no symbol; a mint into
 * any other target is made under no key and malformed under any.
 */
export const mintVerdictOf = (c: MintCase, keys: ReadonlyArray<unknown>): MintVerdict => {
	if (c.target !== "a consumer's contract") {
		return keys.length === 0 ? "made" : "MalformedDescription"
	}
	const [key] = keys
	if (keys.length !== 1 || typeof key !== "symbol") {
		return "MalformedDescription"
	}
	return Symbol.keyFor(key) === undefined ? "made" : "Refused"
}

/** `call` made as a JavaScript caller makes it, `keys` after its own arguments, each in a position of its own. */
const withKeys = (
	keys: ReadonlyArray<unknown>,
	call: (...keys: ReadonlyArray<unknown>) => unknown
): unknown => {
	const [first, second] = keys
	return keys.length === 0 ? call() : keys.length === 1 ? call(first) : call(first, second)
}

/**
 * The mint a case's call makes, as a JavaScript caller makes it, its arguments then `keys`: a cast by the scalar core
 * (scalar/compute/builders.ts computeCore), and a drawn and an accumulated field by their builders' core
 * (schema/relation.ts), each the one the public builder calls.
 */
export const mintMade = (c: MintCase, keys: ReadonlyArray<unknown>): unknown => {
	const target = mintTargets[c.target]
	switch (c.position) {
		case "a cast":
			return withKeys(keys, (...k) => computeCore.cast(param("n", int8), target, ...k))
		case "a drawn field":
			return Reflect.apply(drawnField, undefined, [target, keys])
		case "an accumulated field":
			return Reflect.apply(accumulatedField, undefined, [target, 0n, keys])
	}
}

/** A declared function's result shape. */
export type ResultShape = "a value" | "rows" | "one row" | "rows of rows" | "a variant"

/** What a clock's parameter or a declared function's result is of: a mint's targets, and a contract over a consumer's. */
export type HeldTarget = MintTarget | "a contract over a consumer's"

/** What a clocked member or a declared function is handed after its binding or its definition. */
export type HeldKeys =
	| "none"
	| "its keys"
	| "one too few"
	| "one too many"
	| "a registered key"
	| "a value that is no record"

/**
 * A clock bound to a parameter of a target's type, judged at compile (check/clock.ts clockParams); the keys a clocked
 * member is handed, judged where it is built (program/workload/value.ts clockedMember); or a declared function whose
 * result holds a target in a shape, handed mints (schema/function.ts admitMints).
 */
export type HeldCase =
	| Readonly<{ kind: "clock"; target: HeldTarget }>
	| Readonly<{ kind: "clock keys"; keys: HeldKeys }>
	| Readonly<{ kind: "result"; shape: ResultShape; target: HeldTarget; mints: HeldKeys }>

export type HeldFeature =
	| `a clock of ${HeldTarget}`
	| `clock keys ${HeldKeys}`
	| `${ResultShape} of ${HeldTarget}`
	| `mints ${HeldKeys}`

/** The targets a clock's parameter or a result is of. */
export const heldTargets = [
	"a consumer's contract",
	"a contract over a consumer's",
	"natural",
	"bigint"
] as const

/** The shapes of a result. */
export const resultShapes = ["a value", "rows", "one row", "rows of rows", "a variant"] as const

/** What a member or a function is handed. */
export const heldKeys = [
	"none",
	"its keys",
	"one too few",
	"one too many",
	"a registered key",
	"a value that is no record"
] as const

/** Clocks of every target, keys of every kind, and results of every target in every shape under every mints. */
export const heldSpace: Gen<HeldCase> = weighted<HeldCase>([
	[1, (s) => ({ kind: "clock", target: s.draw(element(heldTargets)) })],
	[1, (s) => ({ kind: "clock keys", keys: s.draw(element(heldKeys)) })],
	[
		4,
		(s) => ({
			kind: "result",
			shape: s.draw(element(resultShapes)),
			target: s.draw(element(heldTargets)),
			mints: s.draw(element(heldKeys))
		})
	]
])

const outerKey = Symbol("Outer")
/** A consumer's contract over a consumer's contract, Amount, under a key of its own. */
const Outer = contract<typeof outerKey>()("Outer", Amount)

/** Each held target's descriptor. */
const heldDescriptors: { readonly [T in HeldTarget]: unknown } = {
	...mintTargets,
	"a contract over a consumer's": Outer
}

/** The descriptor of a target. */
export const heldTarget = (target: HeldTarget): unknown => heldDescriptors[target]

/** The names of the consumers' contracts a target holds a value of, in code point order, and their keys. */
const ownedOf: { readonly [T in HeldTarget]: ReadonlyArray<readonly [string, symbol]> } = {
	"a consumer's contract": [["Amount", amountKey]],
	"a contract over a consumer's": [
		["Amount", amountKey],
		["Outer", outerKey]
	],
	natural: [],
	bigint: []
}

/**
 * What `keys` hands after a builder's own arguments for `owned`, as a JavaScript caller does: nothing, or one value, a
 * record of keys by name or a value in its place.
 */
const handed = (
	owned: ReadonlyArray<readonly [string, symbol]>,
	keys: HeldKeys,
	other: string
): ReadonlyArray<unknown> => {
	switch (keys) {
		case "none":
			return []
		case "its keys":
			return [Rec.fromEntries(owned)]
		case "one too few":
			return [Rec.fromEntries(owned.slice(1))]
		case "one too many":
			return [Rec.fromEntries([...owned, [other, Symbol(other)] as const])]
		case "a registered key":
			return [
				Rec.fromEntries([...owned.slice(1), [owned[0]?.[0] ?? other, Symbol.for(other)] as const])
			]
		case "a value that is no record":
			return [[...owned.values()]]
	}
}

/** The roster a result's variant is over: two arms, `a` holding the target, `b` nothing. */
const Arm = closed.unordered("HeldArm", ["a", "b"])

/** A result's type in its shape over the target, as a JavaScript caller builds it. */
const resultOf = (shape: ResultShape, target: unknown): unknown => {
	switch (shape) {
		case "a value":
			return target
		case "rows":
			return Reflect.apply(rows, undefined, [{ x: target }])
		case "one row": {
			const heading: unknown = Reflect.apply(rows, undefined, [{ x: target }])
			return Reflect.apply(row, undefined, [heading])
		}
		case "rows of rows": {
			const inner: unknown = Reflect.apply(rows, undefined, [{ x: target }])
			return Reflect.apply(rows, undefined, [{ inner }])
		}
		case "a variant":
			return Reflect.apply(variant, undefined, ["HeldVariant", Arm, { a: { x: target }, b: {} }])
	}
}

/** The verdict of a declared function's mints, or a clocked member's keys, by the rule restated. */
export type HeldVerdict = "made" | "MalformedDescription" | "Refused"

/**
 * The rule of a function's mints restated: where its result holds a consumer's contract, a record of exactly those
 * contracts' keys by their names, each a symbol no registry holds, the registered one refused by the rule the types name;
 * where it holds none, nothing; anything else malformed.
 */
export const mintsVerdict = (target: HeldTarget, mints: HeldKeys): HeldVerdict => {
	if (ownedOf[target].length === 0) {
		return mints === "none" ? "made" : "MalformedDescription"
	}
	switch (mints) {
		case "its keys":
			return "made"
		case "a registered key":
			return "Refused"
		case "none":
		case "one too few":
		case "one too many":
		case "a value that is no record":
			return "MalformedDescription"
	}
}

/** A declared function returning a result's type in its shape over its target, handed its mints. */
export const resultFunction = (c: Extract<HeldCase, { readonly kind: "result" }>): unknown => {
	const definition = {
		calls: [],
		args: {},
		returns: resultOf(c.shape, heldDescriptors[c.target]),
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT NULL`
	}
	const given = handed(ownedOf[c.target], c.mints, "Other")
	const [mints] = given
	return given.length === 0
		? Reflect.apply(fn, undefined, ["held", definition])
		: Reflect.apply(fn, undefined, ["held", definition, mints])
}

/** A program of one parameter, `now`, a bigint, which a clocked member binds. */
const clockedProgram = query(schema.empty).rule((r) => r.find({ now: r.param("now", int8) }))

/**
 * The rule of a clocked member's keys restated, as the member is built, which knows no parameter's type: nothing, or a
 * record of keys by the names its binding binds, each a symbol no registry holds, the registered one refused by the
 * rule the types name; anything else malformed.
 */
export const clockKeysVerdict = (keys: HeldKeys): HeldVerdict => {
	switch (keys) {
		case "none":
		case "its keys":
		case "one too few":
			return "made"
		case "a registered key":
			return "Refused"
		case "one too many":
		case "a value that is no record":
			return "MalformedDescription"
	}
}

/** A clocked member of the one-parameter program, `now` bound in millis, handed `keys` for `now`. */
export const clockedMade = (keys: HeldKeys): unknown => {
	const given = handed([["now", amountKey]], keys, "later")
	const [held] = given
	return given.length === 0
		? Reflect.apply(clocked, undefined, [clockedProgram, { now: "millis" }])
		: Reflect.apply(clocked, undefined, [clockedProgram, { now: "millis" }, held])
}

/** Whether a clock binds a parameter of a target's type, by the rule: every one but a contract over a consumer's. */
export const clockBinds = (target: HeldTarget): boolean => ownedOf[target].length <= 1
