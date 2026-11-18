/** What the property of codec-text.test.ts reads: the carriers a value's text is of, a batch, and PostgreSQL's reading of it. */
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { type SqlNames, wireSql } from "#test/pg/codec/support.ts"
import { orderCases, orderedBy, wireText } from "#test/pg/values/order.fixtures.ts"
import { nonEmpty } from "#test/support/assert.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"

/**
 * The carriers a value's text is of (public/text.ts codecText): every case of order.fixtures.ts but bytea, a bytes value
 * being stored only, with no text.
 */
export const textCases = nonEmpty(Arr.filter(orderCases, (c) => c.type.carrier !== "bytes"))

/** A carrier, by its case's label, and a batch of its values as a caller writes them. */
interface TextBatch {
	readonly label: string
	readonly values: ReadonlyArray<unknown>
}

/** A case and a batch of up to 100 of its values, so equal values and every carrier's edges meet in one batch. */
export const textBatchGen: Gen<TextBatch> = (source) => {
	const c = source.draw(element(textCases))
	return { label: c.label, values: source.draw(array(c.values, { min: 1, max: 100 })) }
}

/** A carrier whose values a case gave a text, by its label. */
export type TextFeature = `texts ${string}`

/**
 * Whether PostgreSQL's input function of a type reads a value's text under no installation as the value: every
 * carrier's but a closed id's and a set's, whose texts are a fresh installation's codes, which the cases' installation,
 * a roster with holes among them, does not hold.
 */
export const readsBack = (type: ScalarType): boolean =>
	type.carrier !== "code" && type.carrier !== "bits"

/** The positions of a batch's values, grouped by equal text, each group in order, the groups by their first position. */
export const textClasses = (texts: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<number>> => {
	const byText = new Map<string, Array<number>>()
	for (const [ord, text] of texts.entries()) {
		const group = byText.get(text) ?? []
		group.push(ord)
		byText.set(text, group)
	}
	return [...byText.values()]
}

/**
 * PostgreSQL's classes of a batch under its type's equality: the positions of its values sent through jsonb_to_recordset
 * at their wire type (codec/support.ts wireSql), grouped by their rank under ORDER BY of the value, a text under
 * pg_c_utf8, whose peers are the values its B-tree equality holds equal: the type's default operator class, which an
 * extension's type such as pgvector's has off the search path, where `=` is not found. Each group is in order, the
 * groups by their first position.
 */
export const postgresClasses = (
	db: CaseSession,
	names: SqlNames,
	type: ScalarType,
	values: ReadonlyArray<unknown>
) =>
	Effect.map(
		db.values(
			`SELECT string_agg(c.ord::text, ',' ORDER BY c.ord) FROM (SELECT r.ord, dense_rank() OVER (ORDER BY ${orderedBy(type, "r.v")}) AS k FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wireSql(type, names)})) AS c GROUP BY c.k ORDER BY min(c.ord)`,
			[jsonText(Arr.map(values, (v, ord) => ({ ord, v: wireText(type, v) })))]
		),
		(rows): ReadonlyArray<ReadonlyArray<number>> =>
			Arr.map(rows, (r) => Arr.map(Str.split(String(r[0]), ","), Number))
	)

/**
 * The positions of a batch whose text PostgreSQL's input function of the type does not read as the value: each value
 * at its wire type, and its text read at that type, ranked together under ORDER BY of the value (`postgresClasses`), a
 * position whose two rank apart, NaN being equal to NaN there.
 */
export const postgresUnread = (
	db: CaseSession,
	names: SqlNames,
	type: ScalarType,
	texted: ReadonlyArray<{ readonly value: unknown; readonly text: string }>
) => {
	const wire = wireSql(type, names)
	return Effect.map(
		db.values(
			`WITH r AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wire}, t text)), both_sides AS (SELECT r.ord, r.v AS x FROM r UNION ALL SELECT r.ord, CAST(r.t AS ${wire}) FROM r), ranked AS (SELECT b.ord, dense_rank() OVER (ORDER BY ${orderedBy(type, "b.x")}) AS k FROM both_sides AS b) SELECT ranked.ord::text FROM ranked GROUP BY ranked.ord HAVING min(ranked.k) <> max(ranked.k) ORDER BY ranked.ord`,
			[
				jsonText(
					Arr.map(texted, ({ value, text }, ord) => ({ ord, v: wireText(type, value), t: text }))
				)
			]
		),
		(rows): ReadonlyArray<number> => Arr.map(rows, (r) => Number(r[0]))
	)
}
