/**
 * What the property of codec-text.test.ts reads: the carriers a value's text is of, a batch, the installations it is
 * stored under, and PostgreSQL's reading of it there.
 */
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type Codebook, declaredOrder, firstCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { type SqlNames, textOut, wireSql } from "#test/pg/codec/support.ts"
import { orderCases, orderCodes, orderedBy } from "#test/pg/values/order.fixtures.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { codecOf } from "#test/unit/codec/support.ts"

/**
 * The carriers a value's text is of (program/text.ts codecText): every case of order.fixtures.ts but bytea, a bytes
 * value being stored only, with no text.
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
 * The installations a batch is stored under, by their codes: a fresh one's, each handle coded by its position in its
 * roster's order (ir/codes.ts firstCodebook), and one migrated twice, its rosters' codes with holes (order.fixtures.ts
 * orderCodes), so a closed id's stored code is no function of its handle alone.
 */
export const installationsOf = (type: ScalarType): readonly [Codebook, Codebook] => [
	firstCodebook(type.carrier === "code" || type.carrier === "bits" ? [type.roster] : []),
	orderCodes
]

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

/** A value's text as the recordset sends it under an installation's codes: its codec's parameter text there. */
const wireText = (codes: Codebook, type: ScalarType, value: unknown): string =>
	succeeded(codecOf(type, codes).encode(value), "a drawn value encodes")

/** The recordset of a batch sent at the values' wire type under an installation's codes, each row its position. */
const recordsetOf = (codes: Codebook, type: ScalarType, values: ReadonlyArray<unknown>): string =>
	jsonText(Arr.map(values, (v, ord) => ({ ord, v: wireText(codes, type, v) })))

/**
 * PostgreSQL's classes of a batch under its type's equality, stored under an installation's codes: the positions of its
 * values sent through jsonb_to_recordset at their wire type (codec/support.ts wireSql), grouped by their rank under ORDER
 * BY of the value, a text under pg_c_utf8, whose peers are the values its B-tree equality holds equal: the type's
 * default operator class, which an extension's type such as pgvector's has off the search path, where `=` is not found.
 * Each group is in order, the groups by their first position.
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
			[recordsetOf(names.codes, type, values)]
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
					Arr.map(texted, ({ value, text }, ord) => ({
						ord,
						v: wireText(names.codes, type, value),
						t: text
					}))
				)
			]
		),
		(rows): ReadonlyArray<number> => Arr.map(rows, (r) => Number(r[0]))
	)
}

/**
 * What an installation's names spell of a batch of closed ids or sets stored under its codes: each value as PostgreSQL
 * stores it, its output text read back through the installation's codec, which names each stored code by the handle it
 * holds there (codec/read.ts), a closed id's handle and a set's handles in its roster's declared order as a JSON array,
 * in the batch's order.
 */
export const postgresSpelled = (
	db: CaseSession,
	names: SqlNames,
	type: Extract<ScalarType, { readonly carrier: "code" | "bits" }>,
	values: ReadonlyArray<unknown>
) => {
	const codec = codecOf(type, names.codes)
	const rank = declaredOrder(type.roster).rank
	return Effect.map(
		db.values(
			`SELECT ${textOut(type, "r.v")} FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wireSql(type, names)}) ORDER BY r.ord`,
			[recordsetOf(names.codes, type, values)]
		),
		(rows): ReadonlyArray<string> =>
			Arr.map(rows, (r) => {
				const stored = succeeded(codec.read(String(r[0])), "a stored value reads back")
				if (typeof stored === "string") {
					return stored
				}
				if (!(stored instanceof Set)) {
					return assert.fail("a closed id reads back as its handle and a set as its handles")
				}
				const rankOf = (handle: unknown): number =>
					defined(
						typeof handle === "string" ? rank.get(handle) : undefined,
						"a stored handle's rank"
					)
				return jsonText(Arr.sort([...stored], Order.mapInput(Order.Number, rankOf)))
			})
	)
}
