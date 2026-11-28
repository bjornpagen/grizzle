/** What the property of calls.test.ts reads: its schema, its programs, its space and its oracle. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { Fn } from "#compiler/public/compute.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, type FunctionBody, fn, relation, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A served program that calls declared functions (schema/function.ts fn) returns the rows PostgreSQL computes calling
 * them itself. The schema holds Item(item, pos, txt), the program's lines, and Seed(item, shift), the calls to make;
 * `explode`, a function of rows argument `program`, a heading of (pos, txt), and value argument `shift`, returning rows
 * (out, pos), each line's text upper-cased, NULL where the text is empty, and the half of its pos plus the shift
 * (integer division, so two lines may give one row), its body returning them in its heading's order, code point order
 * of the names; `scale`, an SQL function of two integers, their product; and `moodOf`, of a closed id of Mood, which
 * returns it. The program matches each seed, then explode's rows at the seed's item's lines and the seed's shift, a
 * call reading two variables of the match before it, and finds each with scale(pos, 3), a call term, and moodOf of the
 * seed's mood.
 */

/** Any text. */
const Text = str.regex("^.*$", "su")

const Item = relation("Item", { item: int4, pos: int4, txt: Text }, ["item", "pos"])

/** The mood a seed is called in, a closed id a call passes and returns. */
const Mood = closed.ordered("Mood", ["calm", "keen"])

const moods = ["calm", "keen"] as const

const Seed = relation("Seed", { item: int4, shift: int4, mood: closedId(Mood) }, ["item"])

const Line = rows({ pos: int4, txt: Text })

const Exploded = rows({ out: Text, pos: int4 })

/** The languages explode's body is drawn in. */
const languages = ["plpgsql", "sql"] as const

type Language = (typeof languages)[number]

const explodeBodies: { readonly [L in Language]: FunctionBody } = {
	plpgsql: fn.body`\nBEGIN\n  RETURN QUERY SELECT CASE WHEN p.txt = '' THEN NULL ELSE upper(p.txt) END, (p.pos / 2) + shift FROM unnest(program) AS p;\nEND\n`,
	sql: fn.body`SELECT CASE WHEN p.txt = '' THEN NULL ELSE upper(p.txt) END, (p.pos / 2) + shift FROM unnest(program) AS p`
}

const explodeOf = (language: Language) =>
	fn("explode", {
		calls: [],
		args: { program: Line, shift: int4 },
		returns: Exploded,
		volatility: "immutable",
		nullInput: "called",
		language,
		body: explodeBodies[language]
	})

/** A seed's mood as it was passed: a closed id in and out, its code under its roster's domain where it is read. */
const moodOf = fn("moodOf", {
	calls: [],
	args: { m: closedId(Mood) },
	returns: closedId(Mood),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT m`
})

const scale = fn("scale", {
	calls: [],
	args: { k: int4, x: int4 },
	returns: int4,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT x * k`
})

/** The schema of a case under `name`: its relations and its two functions, explode in the case's language. */
const callsSchema = (language: Language) => (name: string) =>
	schema(name, [Mood, Item, Seed, explodeOf(language), scale, moodOf], [])

/** The program of a case's schema `s`: every seed's exploded lines, each with its pos scaled by 3. */
export const programsOf = (language: Language) => {
	const s = callsSchema(language)("Calls")
	const explode = explodeOf(language)
	const linesOf = query(s).rule((r) => {
		const { pos, txt } = v(Item, "line")
		return r.match(Item, { item: r.param("item", int4), pos, txt }).find({ pos, txt })
	})
	return {
		run: query(s).rule((r) => {
			const { item, shift, mood } = v(Seed, "seed")
			const run = Fn.rows(explode, { program: linesOf.bind({ item }), shift })
			const { pos, out } = v(run, "run")
			return r
				.match(Seed, { item, shift, mood })
				.match(run, { pos, out })
				.find({
					item,
					pos,
					out,
					scaled: Fn.call(scale, { x: pos, k: 3 }),
					mood: Fn.call(moodOf, { m: mood })
				})
		})
	}
}

/** The installation of each language as a template, which a case of that language clones. */
export const callsTemplates: { readonly [L in Language]: SubstrateTemplate<Generated> } = {
	plpgsql: templateOf("plpgsql"),
	sql: templateOf("sql")
}

function templateOf(language: Language): SubstrateTemplate<Generated> {
	return generatedTemplate({
		declaredIn: import.meta,
		name: `calls_${language}`,
		content: { language, programs: ["run"] },
		build: (name) => {
			const s = callsSchema(language)(name)
			return { schema: s, logins: [fullWorld(s, programsOf(language), []).server] }
		},
		ambient: ordinarySession
	})
}

/** The served world of a case of `language` over its installation's declared name. */
export const worldOf = (language: Language, declared: string) =>
	fullWorld(callsSchema(language)(declared), programsOf(language), [])

interface LineFact {
	readonly item: number
	readonly pos: number
	readonly txt: string
}

interface SeedRow {
	readonly item: number
	readonly shift: number
	readonly mood: (typeof moods)[number]
}

export interface CallsCase {
	readonly language: Language
	readonly lines: ReadonlyArray<LineFact>
	readonly seeds: ReadonlyArray<SeedRow>
}

const items = [1, 2, 3] as const

export const caseGen: Gen<CallsCase> = (source) => {
	const language = source.draw(element(languages))
	const lines = Arr.flatMap(items, (item) =>
		Arr.map(Arr.dedupe(source.draw(array(int(0, 5), { min: 0, max: 4 }))), (pos) => ({
			item,
			pos,
			txt: source.draw(element(["a", "b", "ab", ""] as const))
		}))
	)
	const seeds = Arr.flatMap(items, (item) =>
		source.draw(element([true, false] as const))
			? [{ item, shift: source.draw(int(-2, 2)), mood: source.draw(element(moods)) }]
			: []
	)
	return { language, lines, seeds }
}

export type CallsFeature =
	| "a PL/pgSQL body"
	| "an SQL body"
	| "no seed"
	| "a seed of no line, an empty rows argument"
	| "two lines giving one row"
	| "a row holding NULL, refused"
	| "rows answered"

/** The features a case reaches by its draw, beside the outcome its check notes. */
export const drawnFeatures = (c: CallsCase): ReadonlyArray<CallsFeature> => {
	const seeded = (l: LineFact) => Arr.some(c.seeds, (s) => s.item === l.item)
	return [
		c.language === "plpgsql" ? "a PL/pgSQL body" : "an SQL body",
		...(c.seeds.length === 0 ? (["no seed"] as const) : []),
		...(Arr.some(c.seeds, (s) => !Arr.some(c.lines, (l) => l.item === s.item))
			? (["a seed of no line, an empty rows argument"] as const)
			: []),
		...(Arr.some(c.lines, (l) =>
			Arr.some(
				c.lines,
				(m) =>
					seeded(l) &&
					m.item === l.item &&
					m.pos !== l.pos &&
					Math.trunc(m.pos / 2) === Math.trunc(l.pos / 2) &&
					m.txt === l.txt
			)
		)
			? (["two lines giving one row"] as const)
			: [])
	]
}

/** A case's facts, as the installation loads them. */
export const factsOf = (c: CallsCase) => ({
	Item: Arr.map(c.lines, (l) => ({ item: l.item, pos: l.pos, txt: l.txt })),
	Seed: Arr.map(c.seeds, (s) => ({ item: s.item, shift: s.shift, mood: s.mood }))
})

/** One answered row, as both sides read it, in one text per row. */
export const rowText = (row: unknown): string => {
	if (!isRecord(row)) {
		return "not a row"
	}
	const cell = (key: string) => {
		const value = row[key]
		return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
			? String(value)
			: value === null
				? "NULL"
				: `?${typeof value}`
	}
	return Arr.join(Arr.map(["item", "pos", "out", "scaled", "mood"], cell), "|")
}

/** A list of row texts in code-unit order, the order two sets of rows compare in. */
export const sortedTexts = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(texts, Order.String)

/**
 * PostgreSQL's own rows for the program, the oracle: each seed's call of explode at the array of its item's lines and
 * its shift, each row with scale(pos, 3), every repeat one row, as the owner reads the installation's tables and calls
 * its functions directly, the row type named by explode's own argument type.
 */
export const oracleRows = (admin: PgConnection, schemaName: string) =>
	Effect.gen(function* () {
		const s = quoteIdent(schemaName)
		const typed = yield* admin.query(
			"SELECT pg_catalog.format_type(p.proargtypes[0], NULL) AS t FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'explode'",
			[schemaName]
		)
		const arrayType = String(typed.rows[0]?.["t"])
		const rowType = Str.endsWith("[]")(arrayType) ? Str.slice(0, -2)(arrayType) : arrayType
		const answered = yield* admin.query(
			`SELECT DISTINCT s."item" AS "item", r."pos" AS "pos", r."out" AS "out", ${s}."scale"(3, r."pos") AS "scaled" FROM ${s}."seed" AS s CROSS JOIN LATERAL ${s}."explode"(ARRAY(SELECT ROW(i."pos", i."txt")::${rowType} FROM ${s}."item" AS i WHERE i."item" = s."item"), s."shift") AS r`,
			[]
		)
		return answered.rows
	})

/** An oracle row with its seed's mood, the handle the case drew for its item, which the call must return as it is. */
export const withMood = (c: CallsCase, row: Readonly<Record<string, unknown>>) => ({
	...row,
	mood: Option.getOrThrowWith(
		Arr.findFirst(c.seeds, (s) => s.item === Number(row["item"])),
		() => new Error("the seed of an oracle row's item, which the oracle joins")
	).mood
})
