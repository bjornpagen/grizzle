/** What the property of call-numeric.test.ts reads: its schema, its programs, its space and its model. */

import { constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn, Num } from "#compiler/public/compute.ts"
import { Numeric, int4, numeric } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A declared function of PostgreSQL's numeric of no typmod, `numeric`, passes its value as it is, through a query's
 * read and through a write, as a stored `numeric` field does: a value is never rounded to a scale nothing stated.
 * The schema holds Source(id, text), a decimal's text, Held(id, value), a `numeric` a caller writes, and
 * Written(id, value), a `numeric` a ChangeSet writes from a call. `decimalOf(t text) returns numeric` is `t::numeric`,
 * and `negated(x numeric) returns numeric` is `-x`, a numeric argument and result both. The programs: `hold`, Held's
 * insertion from its facts; `record`, Written's insertion of each Source's decimalOf; `fromText`, each Source's
 * decimalOf read; `held`, each Held's value and its negated; `written`, Written's rows; and `doubled`, each Held's value
 * added to itself, arithmetic over a `numeric`, which PostgreSQL holds to numeric's own limit.
 */

/** Any text. */
const Text = str.regex("^.*$", "su")

const Source = relation("Source", { id: int4, text: Text }, ["id"])

const Held = relation("Held", { id: int4, value: numeric }, ["id"])

const Written = relation("Written", { id: int4, value: numeric }, ["id"])

/** A decimal's text read as numeric: its value exactly, at no typmod, as QTI's round-to returns one. */
const decimalOf = fn("decimalOf", {
	calls: [],
	args: { t: Text },
	returns: numeric,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT t::numeric`
})

/** A numeric negated: a numeric argument and a numeric result. */
const negated = fn("negated", {
	calls: [],
	args: { x: numeric },
	returns: numeric,
	volatility: "immutable",
	nullInput: "called",
	language: "plpgsql",
	body: fn.body`\nBEGIN\n  RETURN -x;\nEND\n`
})

/** The schema of a case under `name`. */
const numericSchema = (name: string) =>
	schema(name, [Source, Held, Written, decimalOf, negated], [])

/** The programs of a schema of `name`. */
export const programsOf = (name: string) => {
	const s = numericSchema(name)
	return {
		hold: ChangeSet.empty(s).insert(Held, []),
		record: ChangeSet.empty(s).insert(
			Written,
			query(s).rule((r) => {
				const { id, text } = v(Source, "source")
				return r.match(Source, { id, text }).find({ id, value: Fn.call(decimalOf, { t: text }) })
			})
		),
		fromText: query(s).rule((r) => {
			const { id, text } = v(Source, "source")
			return r.match(Source, { id, text }).find({ id, of: Fn.call(decimalOf, { t: text }) })
		}),
		held: query(s).rule((r) => {
			const { id, value } = v(Held, "held")
			return r
				.match(Held, { id, value })
				.find({ id, value, negated: Fn.call(negated, { x: value }) })
		}),
		written: query(s).rule((r) => {
			const { id, value } = v(Written, "written")
			return r.match(Written, { id, value }).find({ id, value })
		}),
		doubled: query(s).rule((r) => {
			const { id, value } = v(Held, "held")
			return r.match(Held, { id, value }).find({ id, twice: Num.add(value, value) })
		})
	}
}

/** The installation of the case's schema as a template, which every case clones. */
export const numericTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "call_numeric",
	content: { programs: ["hold", "record", "fromText", "held", "written", "doubled"] },
	build: (name) => {
		const s = numericSchema(name)
		return { schema: s, logins: [fullWorld(s, programsOf(name), []).server] }
	},
	ambient: ordinarySession
})

/** The served world of a case over its installation's declared name. */
export const worldOf = (declared: string) =>
	fullWorld(numericSchema(declared), programsOf(declared), [])

/** What a drawn decimal is, by its feature. */
export type NumericFeature =
	| "a fraction a scale-0 typmod would round away (7/40 as 0.17)"
	| "a value past 1e300"
	| "a value below 1e-300"
	| "numeric's widest integer, whose double PostgreSQL refuses with 22003"
	| "numeric's finest fraction"
	| "NaN"
	| "an infinity"
	| "an ordinary decimal"

/** A drawn decimal: its text, its feature. */
export interface Drawn {
	readonly text: string
	readonly feature: NumericFeature
}

const digit: Gen<string> = element(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const)

/** `n` drawn digits, the first of them nonzero where `lead` asks it. */
const digitsOf =
	(n: number, lead: boolean): Gen<string> =>
	(source) =>
		Arr.join(
			Array.from({ length: n }, (_, i) =>
				i === 0 && lead ? source.draw(element(["1", "5", "9"] as const)) : source.draw(digit)
			),
			""
		)

const sign: Gen<string> = element(["", "-"] as const)

/** A decimal of `whole` integer digits and `fraction` fraction digits, its first and last digits nonzero. */
const numericText =
	(whole: number, fraction: number): Gen<string> =>
	(source) => {
		const integer = whole === 0 ? "0" : source.draw(digitsOf(whole, true))
		const tail =
			fraction === 0
				? ""
				: `.${source.draw(digitsOf(fraction - 1, false))}${source.draw(element(["1", "7"] as const))}`
		return `${source.draw(sign)}${integer}${tail}`
	}

/** Every drawn decimal's kind, weighted toward the values a typmod-less numeric is for. */
const drawnGen: Gen<Drawn> = weighted([
	[
		2,
		constant<Drawn>({
			text: "0.17",
			feature: "a fraction a scale-0 typmod would round away (7/40 as 0.17)"
		})
	],
	[
		2,
		(source) => ({
			text: source.draw(numericText(source.draw(int(301, 320)), source.draw(int(0, 3)))),
			feature: "a value past 1e300"
		})
	],
	[
		2,
		(source) => {
			const zeros = source.draw(int(300, 320))
			return {
				text: `${source.draw(sign)}0.${Str.repeat(zeros)("0")}${source.draw(digitsOf(source.draw(int(1, 4)), true))}`,
				feature: "a value below 1e-300"
			}
		}
	],
	[
		1,
		constant<Drawn>({
			text: Str.repeat(numericMaxIntegerDigits)("9"),
			feature: "numeric's widest integer, whose double PostgreSQL refuses with 22003"
		})
	],
	[
		1,
		(source) => ({
			text: `${source.draw(sign)}0.${Str.repeat(numericMaxFractionDigits - 1)("0")}${source.draw(element(["1", "3"] as const))}`,
			feature: "numeric's finest fraction"
		})
	],
	[1, constant<Drawn>({ text: "NaN", feature: "NaN" })],
	[
		1,
		(source) => ({
			text: source.draw(element(["Infinity", "-Infinity"] as const)),
			feature: "an infinity"
		})
	],
	[
		2,
		(source) => ({
			text: source.draw(numericText(source.draw(int(0, 6)), source.draw(int(0, 6)))),
			feature: "an ordinary decimal"
		})
	]
])

/** A case: the decimals it draws, each a Source row's text and a Held row's value, its id its position. */
export interface NumericCase {
	readonly drawn: ReadonlyArray<Drawn>
}

export const caseGen: Gen<NumericCase> = (source) => ({
	drawn: Array.from({ length: source.draw(int(1, 5)) }, () => source.draw(drawnGen))
})

/** The model of a drawn text: its Numeric, as the host parses it. */
export const modelOf = (text: string): Numeric =>
	succeeded(Numeric.fromString(text), `the host parses ${Str.slice(0, 40)(text)}`)

/** A case's facts, as the owner loads them: each drawn text a Source row; Held and Written empty. */
export const factsOf = (c: NumericCase) => ({
	Source: Arr.map(c.drawn, (d, id) => ({ id, text: d.text })),
	Held: [],
	Written: []
})

/** Held's facts as `hold` writes them: each drawn value as its Numeric. */
export const heldFacts = (c: NumericCase) =>
	Arr.map(c.drawn, (d, id) => ({ id, value: modelOf(d.text) }))

/** The model of a value negated, numeric.c's numeric_uminus. */
export const negatedModel = (d: Numeric): Numeric => succeeded(N.neg(d), "a numeric negated")

/** The model of a value doubled, numeric.c's numeric_add: none past numeric's format, where PostgreSQL raises 22003. */
export const doubledModel = (d: Numeric): Option.Option<Numeric> => {
	const sum = N.add(d, d)
	return sum.ok ? Option.some(sum.value) : Option.none()
}
