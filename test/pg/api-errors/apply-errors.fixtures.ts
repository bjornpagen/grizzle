/** What the properties of apply-errors.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import {
	boolean,
	characterOf,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted,
	constant
} from "@bjornpagen/testing/gen"
import { type Wild, wild, WILD_KINDS, type WildKind } from "@bjornpagen/testing/lsw"
import { wildOf } from "@bjornpagen/testing/lsw"
import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { pg, query, relation, schema, span, str, v } from "#index.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id } from "#test/support/ids.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"

/** The label's pattern: the one field of Typed whose type refines its base, a text, by a pattern. */
const labelPattern = "^[a-z]{0,8}$"

export const Typed = relation(
	"Typed",
	{
		id: Id,
		n: pg.integer,
		b: pg.bigint,
		flag: pg.boolean,
		label: str.regex(labelPattern),
		during: span(pg.bigint)
	},
	["id"]
)

const Seed = relation("Seed", { id: Id }, ["id"])

export const Fixture = schema("ApiErrors", [Typed, Seed], [])

const seed = "00000000-0000-4000-8000-000000000001"

const fresh = "00000000-0000-4000-8000-000000000003"

/**
 * A JavaScript caller's parameter argument, holding a value of any type, which the types refuse and the member's
 * boundary judges: the test's own data.
 */
export const callersParams = (params: Readonly<Record<string, unknown>>): ParamMap =>
	trusted<ParamMap>(params)

/**
 * The described member's parameters, every field but the key, which it reads from Seed, and a live value of each. A
 * parameters argument names exactly these: one with a key that names no parameter is refused as that key, naming the
 * member (undeclaredCaseGen).
 */
export const liveParams = {
	n: 1,
	b: 1n,
	flag: true,
	label: "ab",
	during: { start: 0n, end: 1n }
} as const

type Param = keyof typeof liveParams

const paramFields: Arr.NonEmptyReadonlyArray<Param> = ["n", "b", "flag", "label", "during"]

/** The fields a value is drawn into, and a live value of each: the key and the described member's parameters. */
export const live = { id: fresh, ...liveParams } as const

type Field = keyof typeof live

const fields: Arr.NonEmptyReadonlyArray<Field> = ["id", ...paramFields]

/** `inserted` placed at a drawn position of `text`. */
const insertedIn = (text: string, at: number, inserted: string): string =>
	`${Str.slice(0, at)(text)}${inserted}${Str.slice(at)(text)}`

/** How far past a type's range an out-of-range integer is drawn. */
const beyond = int(0, 2 ** 20)

/**
 * The members the cases call, built over the fixture, which they run against under its installed name (a level is its
 * content): an insert of an array's facts, and the described member, every field but the key a scalar parameter of its
 * type. The installation's login serves them, so it installs every type their parameters are cast to, `label`'s own
 * pattern domain among them.
 */
export const programs = Object.freeze({
	array: changeSetOver.empty(Fixture).insert(Typed, []),
	parameter: changeSetOver.empty(Fixture).insert(
		Typed,
		query(Fixture).rule((r) => {
			const { id } = v(Seed, "seed")
			return r.match(Seed, { id }).find({
				id,
				n: r.param("n", Typed.fields.n),
				b: r.param("b", Typed.fields.b),
				flag: r.param("flag", Typed.fields.flag),
				label: r.param("label", Typed.fields.label),
				during: r.param("during", Typed.fields.during)
			})
		})
	)
})

/**
 * Each field's invalid class, constructed, never filtered: a string holding a letter no uuid's hexadecimal holds; an
 * integer past int4's range, either side; a bigint past int8's; a value of no boolean type; a text of the label's
 * letters holding NUL; a span of bigint endpoints whose end is not past its start.
 */
const refusedValues: { readonly [F in Field]: Gen<unknown> } = {
	id: (source) => {
		const hex = source.draw(
			string(characterOf(Str.split("0123456789abcdef-", "")), { min: 0, max: 36 })
		)
		return insertedIn(hex, source.draw(int(0, hex.length)), "g")
	},
	n: (source) =>
		source.draw(boolean) ? 2 ** 31 + source.draw(beyond) : -(2 ** 31) - 1 - source.draw(beyond),
	b: (source) => {
		const past = BigInt(source.draw(beyond))
		return source.draw(boolean) ? 2n ** 63n + past : -(2n ** 63n) - 1n - past
	},
	flag: oneOf<unknown>([string(codePoint(0x61, 0x7a), { min: 0, max: 5 }), int(-2, 2)]),
	label: (source) => {
		const text = source.draw(string(codePoint(0x61, 0x7a), { min: 0, max: 7 }))
		return insertedIn(text, source.draw(int(0, text.length)), "\u0000")
	},
	during: (source) => {
		const start = BigInt(source.draw(int(-(2 ** 40), 2 ** 40)))
		return { start, end: start - BigInt(source.draw(beyond)) }
	}
}

/**
 * Whether a case binds the described member's label parameter to a text outside the label's pattern, which PostgreSQL
 * refuses as it binds it, `paramRejected` at the parameter (README, "Contracts and patterns"): the encoder checks only
 * the base type, so a value the text codec admits, a string with no NUL and no lone surrogate, is the pattern's to
 * judge, and the pattern is restated here over the value passed. A fact of the array member outside the pattern is
 * the label's law's, which answers the write.
 */
export const outsideLabelPattern = (c: EncodingCase, value: unknown): boolean =>
	c.form === "parameter" &&
	c.field === "label" &&
	typeof value === "string" &&
	!Str.includes("\u0000")(value) &&
	value.isWellFormed() &&
	!regex(labelPattern, "u").test(value)

/** The fault the codecs' vocabulary names for each field's invalid class (scalar/values/fault.ts): the oracle. */
export const classFault: { readonly [F in Field]: ValueFault } = {
	id: "uuidSyntax",
	n: "integerRange",
	b: "integerRange",
	flag: "boolType",
	label: "textNul",
	during: "spanOrder"
}

/** The form a fact is planted in: a call's fact of an array member, or a parameter of the described member. */
type Form = "array" | "parameter"

const forms: Arr.NonEmptyReadonlyArray<Form> = ["array", "parameter"]

/** A field's value: one of its invalid class, or a Wild value. */
type Drawn =
	| { readonly kind: "refused"; readonly value: unknown }
	| { readonly kind: "wild"; readonly wild: Wild }

/** A field and the form it is planted in: any field of a member's fact, or a parameter of the described member. */
type Pair =
	| { readonly field: Field; readonly form: "array" }
	| { readonly field: Param; readonly form: "parameter" }

type EncodingCase = Pair & { readonly value: Drawn }

export type EncodingFeature =
	| `refused ${Field} as ${Form}`
	| `wild ${WildKind} refused`
	| "wild admitted"
	| "wild outside the label's pattern refused at bind"

/** The field and form pairs a case draws: every field of a call's fact, and every parameter. */
export const plantedPairs: Arr.NonEmptyReadonlyArray<Pair> = [
	...Arr.map(fields, (field): Pair => ({ field, form: "array" })),
	...Arr.map(paramFields, (field): Pair => ({ field, form: "parameter" }))
]

/**
 * One of the field and form pairs, each equally often, with a value `value` draws for its field. A parameter of the
 * described member carries every field but the key, which the member reads from Seed.
 */
const pairCase =
	(value: (field: Field) => Gen<Drawn>): Gen<EncodingCase> =>
	(source) => {
		const pair = source.draw(element(nonEmptyList(plantedPairs, "the field and form pairs")))
		return { ...pair, value: source.draw(value(pair.field)) }
	}

/** A value of a field's invalid class. */
const refusedOf = (field: Field): Gen<Drawn> =>
	map(refusedValues[field], (value): Drawn => ({ kind: "refused", value }))

/** A wild value of any kind. */
const anyWild: Gen<Drawn> = map(wild(WILD_KINDS), (drawn): Drawn => ({ kind: "wild", wild: drawn }))

/**
 * A wild value the integer's codec admits, in any form: -0, or a number in its range where a bigint boundary expects a
 * bigint. A wild value of a pair lands on one in about one case in eighty (the integer's pairs are three of seventeen,
 * its admitted kinds two of fourteen), which the suite's cases cannot count on.
 */
const admittedCase: Gen<EncodingCase> = (source) => ({
	field: "n",
	form: source.draw(element(forms)),
	value: {
		kind: "wild",
		wild: source.draw(wild(["negative-zero", "number-for-bigint"]))
	}
})

/** A case: half a pair's invalid class, and the rest a pair's wild value, but one in sixteen an admitted wild value. */
export const encodingCaseGen: Gen<EncodingCase> = weighted([
	[8, pairCase(refusedOf)],
	[7, pairCase(() => anyWild)],
	[1, admittedCase]
])

/**
 * A key a call's params may hold that names none of its member's parameters, with a value a caller would pass under it:
 * a parameter another member of the workload takes (metis's by-grade assign, whose params, built once for both its
 * gates, held the held gate's `titles` when it called the bypassing one, which declares none); one of the described
 * member's parameters misspelt; and the field the described member reads from Seed, a field of the written relation
 * and no parameter of either member.
 */
const undeclaredKeys = {
	titles: [],
	lable: "ab",
	id: fresh
} as const satisfies Readonly<Record<string, unknown>>

export type UndeclaredKey = keyof typeof undeclaredKeys

/** A call of a member whose params hold one key more than the member declares, under a live value. */
export interface UndeclaredCase {
	readonly form: Form
	readonly key: UndeclaredKey
}

export type UndeclaredFeature =
	| "the described member's params, one key more"
	| "an array member's params, which it declares none of"

export const undeclaredCaseGen: Gen<UndeclaredCase> = (source) => ({
	form: source.draw(element(forms)),
	key: source.draw(element(["titles", "lable", "id"] as const))
})

/** The params a case's call passes: its member's own, the described member's live values, and the undeclared key. */
export const undeclaredParams = (c: UndeclaredCase): ParamMap =>
	callersParams({
		...(c.form === "parameter" ? liveParams : {}),
		[c.key]: undeclaredKeys[c.key]
	})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const applyInstall = Object.freeze({ label: "real", programs })

/** The seed row every case's calls reference, loaded into the case's clone. */
export const seedFacts = Object.freeze({ Seed: [{ id: seed }] })

/** Fixture installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const applyTemplate = fixtureTemplate(import.meta, Fixture, applyInstall)

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const encodingCases: ReadonlyArray<{
	readonly why: string
	readonly value: EncodingCase
	readonly reaches: ReadonlyArray<EncodingFeature>
}> = [
	{
		why: "a number for an integer",
		value: {
			field: "n",
			form: "array",
			value: { kind: "wild", wild: wildOf("number-for-bigint") }
		},
		reaches: ["wild admitted"]
	},
	{
		why: "null for an integer",
		value: { field: "n", form: "array", value: { kind: "wild", wild: wildOf("null") } },
		reaches: ["wild null refused"]
	},
	{
		why: "a proxy for a refined text parameter",
		value: { field: "label", form: "parameter", value: { kind: "wild", wild: wildOf("proxy") } },
		reaches: ["wild proxy refused"]
	},
	{
		why: "a lone surrogate for a refined text",
		value: {
			field: "label",
			form: "array",
			value: { kind: "wild", wild: wildOf("lone-surrogate") }
		},
		reaches: ["wild lone-surrogate refused"]
	},
	{
		why: "a text the codec admits outside the label's pattern, for its parameter",
		value: {
			field: "label",
			form: "parameter",
			value: { kind: "wild", wild: { kind: "anything", value: " " } }
		},
		reaches: ["wild outside the label's pattern refused at bind"]
	}
]

/** The property's aims (the encoding search): each kept case's value at every situation it reaches. */
export const encodingAims: ReadonlyArray<readonly [Reached<EncodingFeature>, Gen<EncodingCase>]> =
	Arr.flatMap(encodingCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
