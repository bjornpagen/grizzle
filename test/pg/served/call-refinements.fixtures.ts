/** What the property of call-refinements.test.ts reads: its schema, its programs, its space and its oracle. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type FunctionBody, fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A declared function's result typed by two refined texts, Code (alpha or beta) and Word (gamma or delta), read by a
 * served program. The function's row type holds each at its base, `text`, since its body returns text; each read casts
 * the call's value to the field's domain, the one check PostgreSQL makes of what the body returned. A true body returns
 * a code and a word; a rotated one returns them permuted, each field a value outside its own refinement and inside the
 * other's, which no type can see before the cast.
 */

const Code = str.regex("^(alpha|beta)$", "u")
const Word = str.regex("^(gamma|delta)$", "u")

const Item = relation("Item", { item: pg.integer }, ["item"])

/** A stored field of each refinement, where the case places one: the control, which compiled before. */
const Coded = relation("Coded", { item: pg.integer, code: Code, word: Word }, ["item"])

const Judged = rows({ code: Code, word: Word })

/** Whether a body returns each field a value of its own refinement, or the two permuted. */
const bodies = ["true", "rotated"] as const
export type Body = (typeof bodies)[number]

/** Where the refinements are named: by the function's result alone, or by a stored field too. */
const places = ["a function's result alone", "a stored field too"] as const
export type Place = (typeof places)[number]

/** The rows judge returns at an item, its fields in code point order of their names, code then word. */
const rowsBodies: { readonly [B in Body]: FunctionBody } = {
	true: fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END, CASE WHEN item % 2 = 0 THEN 'gamma' ELSE 'delta' END`,
	rotated: fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'gamma' ELSE 'delta' END, CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END`
}

const rowBodies: { readonly [B in Body]: FunctionBody } = {
	true: fn.body`SELECT ARRAY[ROW(CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END, CASE WHEN item % 2 = 0 THEN 'gamma' ELSE 'delta' END)::${Judged}]`,
	rotated: fn.body`SELECT ARRAY[ROW(CASE WHEN item % 2 = 0 THEN 'gamma' ELSE 'delta' END, CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END)::${Judged}]`
}

const valueBodies: { readonly [B in Body]: FunctionBody } = {
	true: fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END`,
	rotated: fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'gamma' ELSE 'delta' END`
}

const functionsOf = (body: Body) => ({
	judge: fn("judge", {
		calls: [],
		args: { item: pg.integer },
		returns: Judged,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: rowsBodies[body]
	}),
	judgeRow: fn("judgerow", {
		calls: [],
		args: { item: pg.integer },
		returns: row(rows({ pairs: Judged })),
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: rowBodies[body]
	}),
	judgeOne: fn("judgeone", {
		calls: [],
		args: { item: pg.integer },
		returns: Code,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: valueBodies[body]
	})
})

/** The schema of a template under `name`. */
const refinementsSchema = (place: Place, body: Body) => (name: string) => {
	const { judge, judgeRow, judgeOne } = functionsOf(body)
	return schema(
		name,
		[Item, ...(place === "a stored field too" ? [Coded] : []), judge, judgeRow, judgeOne],
		[]
	)
}

/**
 * How the served program reads the function's result: its rows, a field of rows of its one row, its value, or how many
 * rows it returns, a read that delivers no refined value, so the call's own cast is the one check of the body's values.
 */
const reads = ["rows", "a field of its row", "its value", "a count of its rows"] as const
export type Read = (typeof reads)[number]

/** The programs of a template's schema: one read of each kind, at the item a parameter names. */
export const programsOf = (place: Place, body: Body, name: string) => {
	const s = refinementsSchema(place, body)(name)
	const { judge, judgeRow, judgeOne } = functionsOf(body)
	return {
		rows: query(s).rule((r) => {
			const run = Fn.rows(judge, { item: r.param("item", pg.integer) })
			const { code, word } = v(run, "run")
			return r.match(run, { code, word }).find({ code, word })
		}),
		row: query(s).rule((r) => {
			const read = Fn.row(judgeRow, { item: r.param("item", pg.integer) }).pairs
			const { code, word } = v(read, "read")
			return r.match(read, { code, word }).find({ code, word })
		}),
		value: query(s).rule((r) => {
			const { item } = v(Item, "item")
			return r
				.match(Item, { item })
				.where(r.eq(item, r.param("item", pg.integer)))
				.find({ code: Fn.call(judgeOne, { item }) })
		}),
		count: query(s).rule((r) => {
			const run = Fn.rows(judge, { item: r.param("item", pg.integer) })
			const { code, word } = v(run, "run")
			return r.match(run, { code, word }).find({ rows: r.count() })
		})
	}
}

/** The program of a read. */
export const programOf = (read: Read): "rows" | "row" | "value" | "count" => {
	switch (read) {
		case "rows":
			return "rows"
		case "a field of its row":
			return "row"
		case "its value":
			return "value"
		case "a count of its rows":
			return "count"
	}
}

const templateOf = (place: Place, body: Body): SubstrateTemplate<Generated> =>
	generatedTemplate({
		declaredIn: import.meta,
		name: `call_refinements_${place === "a stored field too" ? "stored" : "alone"}_${body}`,
		content: { place, body, programs: ["rows", "row", "value", "count"] },
		build: (name) => {
			const s = refinementsSchema(place, body)(name)
			return { schema: s, logins: [fullWorld(s, programsOf(place, body, name), []).server] }
		},
		ambient: ordinarySession
	})

/** Each template by its place and body (templateKey), a case of that place and body cloning it. */
export const refinementsTemplates = {
	"alone true": templateOf("a function's result alone", "true"),
	"alone rotated": templateOf("a function's result alone", "rotated"),
	"stored true": templateOf("a stored field too", "true"),
	"stored rotated": templateOf("a stored field too", "rotated")
} as const satisfies Readonly<Record<string, SubstrateTemplate<Generated>>>

/** The key of a case's template among refinementsTemplates. */
export const templateKey = (place: Place, body: Body): keyof typeof refinementsTemplates =>
	place === "a stored field too"
		? body === "true"
			? "stored true"
			: "stored rotated"
		: body === "true"
			? "alone true"
			: "alone rotated"

/** The served world of a case over its installation's declared name. */
export const worldOf = (place: Place, body: Body, declared: string) =>
	fullWorld(refinementsSchema(place, body)(declared), programsOf(place, body, declared), [])

export interface RefinementsCase {
	readonly place: Place
	readonly body: Body
	readonly read: Read
	readonly items: ReadonlyArray<number>
	readonly at: number
}

export const caseGen: Gen<RefinementsCase> = (source) => {
	const items = Arr.dedupe(Arr.makeBy(3, () => source.draw(int(1, 6))))
	return {
		place: source.draw(element(places)),
		body: source.draw(element(bodies)),
		read: source.draw(element(reads)),
		items,
		at: source.draw(element(items))
	}
}

/** A case's facts, as the installation loads them. */
export const factsOf = (c: RefinementsCase) => ({
	Item: Arr.map(c.items, (item) => ({ item }))
})

/** One answered row, in one text: its code, its word and its count of rows, where the read gives each. */
export const rowText = (row: unknown): string => {
	if (!isRecord(row)) {
		return "not a row"
	}
	const cell = (key: string) => {
		const value = row[key]
		return typeof value === "string"
			? value
			: typeof value === "number" || typeof value === "bigint"
				? String(value)
				: value === undefined
					? "-"
					: `?${typeof value}`
	}
	return `${cell("code")}|${cell("word")}|${cell("rows")}`
}

export const sortedTexts = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(texts, Order.String)

/**
 * PostgreSQL's own rows of the case's read, the oracle: the owner's direct call of the function at the case's item, as
 * plain SQL over the installation's functions, its row type's text columns read as they are.
 */
export const oracleRows = (admin: PgConnection, schemaName: string, c: RefinementsCase) =>
	Effect.gen(function* () {
		const s = quoteIdent(schemaName)
		switch (c.read) {
			case "rows":
				return (yield* admin.query(
					`SELECT DISTINCT r."code" AS "code", r."word" AS "word" FROM ${s}."judge"($1) AS r`,
					[c.at]
				)).rows
			case "a field of its row":
				return (yield* admin.query(
					`SELECT DISTINCT p."code" AS "code", p."word" AS "word" FROM ${s}."judgerow"($1) AS r, LATERAL pg_catalog.unnest(r."pairs") AS p`,
					[c.at]
				)).rows
			case "its value":
				return (yield* admin.query(`SELECT ${s}."judgeone"($1) AS "code"`, [c.at])).rows
			case "a count of its rows":
				return (yield* admin.query(
					`SELECT pg_catalog.count(*) AS "rows" FROM (SELECT DISTINCT r."code", r."word" FROM ${s}."judge"($1) AS r) AS d`,
					[c.at]
				)).rows
		}
	})

/**
 * The type each value field of the function's row types is installed at, by its name: every attribute named code or
 * word of a composite type of the installation's schema, no table's, which the function returns at its base, `text`.
 */
export const rowTypeColumns = (admin: PgConnection, schemaName: string) =>
	Effect.map(
		admin.query(
			`SELECT a.attname AS "name", pg_catalog.format_type(a.atttypid, NULL) AS "type" FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace JOIN pg_catalog.pg_class AS k ON k.oid = t.typrelid JOIN pg_catalog.pg_attribute AS a ON a.attrelid = t.typrelid WHERE n.nspname = $1 AND k.relkind = 'c' AND a.attname IN ('code', 'word') AND NOT a.attisdropped`,
			[schemaName]
		),
		(r) => r.rows
	)
