import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, pipe, Schema, String as Str } from "effect"
import { ALLEN, AllenMask, allenRelations, fullAllenMask } from "#compiler/allen/mask.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { jsonText } from "#test/support/json.ts"
import { formulaSql, maskSql } from "#test/support/oracle/allen-sql.ts"
import {
	type Canonical,
	canonicalizationSurvey,
	canonicalize,
	type RangeType,
	spanText,
	spellingText,
	universe,
	universePairs,
	universeSpellings
} from "#test/support/oracle/allen.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/** One row of one text column, as PostgreSQL answers a count read as text. */
const oneText = Schema.Tuple([Schema.Tuple([Schema.String])])

const types = ["int4range", "int8range"] as const satisfies ReadonlyArray<RangeType>

/** Every range type, each case noting its own: an exhaustion over the types, each case in a schema of its own. */
const everyType = <E, R>(suite: string, property: (type: RangeType) => Effect.Effect<void, E, R>) =>
	exhaust(
		{
			suite,
			generator: element<RangeType>(types),
			literal: Formatter.format,
			limit: types.length,
			coverage: requiredInSpace<RangeType>(types),
			caseHang: Duration.minutes(5)
		},
		(type, c) => Effect.tap(property(type), () => Effect.sync(() => c.note(type)))
	)
const batchSize = 256

const canonicalText = (c: Canonical): string =>
	c.kind === "span" ? spanText(c.span) : c.kind === "empty" ? "empty" : `error:${c.sqlstate}`

/**
 * The predicate of a mask over the pair table's columns: its table formula (test/support/oracle/allen-sql.ts), the
 * constant true for the full mask.
 */
const predicate = (mask: number): string => maskSql(AllenMask(mask), "r1.a", "r1.b")

layer(Substrate.layer)("the Allen table on PostgreSQL 19", (it) => {
	it.effect("reads range literals as the host canonicalization does, for every range type", (ctx) =>
		searched(
			ctx,
			everyType("pg/allen/canonicalization", (type) =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = quoteIdent(yield* s.schema({ ...freshSchema, label: "allen" }))
					const db = yield* s.session(ownerSession())
					yield* db.query(
						`CREATE FUNCTION ${schema}.canon_${type}(t text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
	RETURN CASE WHEN isempty(t::${type}) THEN 'empty' ELSE t::${type}::text END;
EXCEPTION WHEN others THEN
	RETURN 'error:' || SQLSTATE;
END
$f$`,
						[]
					)
					const survey = [...canonicalizationSurvey(type), ...universeSpellings(type)]
					const rows = yield* db.values(
						`SELECT j.ord::text, ${schema}.canon_${type}(j.t) FROM jsonb_to_recordset($1::text::jsonb) AS j(ord int4, t text) ORDER BY j.ord`,
						[jsonText(Arr.map(survey, (spelling, ord) => ({ ord, t: spellingText(spelling) })))]
					)
					assert.equal(rows.length, survey.length)
					const disagreements = Arr.flatMap(survey, (spelling, i) => {
						const host = canonicalText(canonicalize(type, spelling))
						const pg = String(rows[i]?.[1])
						return host === pg ? [] : [{ spelling: spellingText(spelling), host, pg }]
					})
					assert.deepEqual(disagreements, [])
					/** The survey reaches every outcome: stored spans, empty ranges, and both refusals. */
					const outcomes = new Set(
						Arr.map(rows, (row) =>
							pipe(Str.split(String(row[1]), ":")[0], Str.replace(regex("^\\[.*$"), "span"))
						)
					)
					assert.deepEqual(outcomes, new Set(["span", "empty", "error"]))
					const errors = new Set(
						Arr.filter(
							Arr.map(rows, (row) => String(row[1])),
							(t) => Str.startsWith("error:")(t)
						)
					)
					assert.deepEqual(errors, new Set(["error:22000", "error:22003"]))
				})
			)
		)
	)

	it.effect(
		"gives 0 mismatches for every mask over every ordered pair of the stored universe of every range type",
		(ctx) =>
			searched(
				ctx,
				everyType("pg/allen/masks", (type) =>
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = quoteIdent(yield* s.schema({ ...freshSchema, label: "allen" }))
						const db = yield* s.session(ownerSession())
						yield* db.query(
							`CREATE TABLE ${schema}.u (
	id int4 PRIMARY KEY,
	v ${type} NOT NULL,
	CHECK ((NOT isempty(v) AND NOT lower_inf(v) AND NOT upper_inf(v) AND lower_inc(v) AND NOT upper_inc(v)) IS TRUE)
)`,
							[]
						)
						const spellings = universeSpellings(type)
						yield* db.query(
							`INSERT INTO ${schema}.u (id, v) SELECT j.id, j.t::${type} FROM jsonb_to_recordset($1::text::jsonb) AS j(id int4, t text)`,
							[jsonText(Arr.map(spellings, (spelling, id) => ({ id, t: spellingText(spelling) })))]
						)
						const spans = universe(type)
						const stored = yield* db.values(
							`SELECT DISTINCT v::text FROM ${schema}.u ORDER BY 1`,
							[]
						)
						assert.deepEqual(
							new Set(Arr.map(stored, ([v]) => String(v))),
							new Set(Arr.map(spans, spanText))
						)

						/** Every ordered pair of stored values, with the host classifier's relation bit. */
						const pairs = universePairs(spans)
						yield* db.query(
							`CREATE TABLE ${schema}.p (a ${type} NOT NULL, b ${type} NOT NULL, rel int4 NOT NULL)`,
							[]
						)
						yield* db.query(
							`INSERT INTO ${schema}.p (a, b, rel)
SELECT x.v, y.v, j.rel
FROM (SELECT DISTINCT v FROM ${schema}.u) AS x
CROSS JOIN (SELECT DISTINCT v FROM ${schema}.u) AS y
JOIN jsonb_to_recordset($1::text::jsonb) AS j(a text, b text, rel int4) ON j.a = x.v::text AND j.b = y.v::text`,
							[
								jsonText(
									Arr.map(pairs, (p) => ({
										a: spanText(p.a),
										b: spanText(p.b),
										rel: p.relationBit
									}))
								)
							]
						)
						const [[count]] = yield* Schema.decodeUnknownEffect(oneText)(
							yield* db.values(`SELECT count(*)::text FROM ${schema}.p`, [])
						)
						assert.equal(Number(count), spans.length ** 2)

						/**
						 * Every other mask: the emitted predicate must hold exactly when the pair's relation is in the mask.
						 */
						const failures: Array<{ readonly mask: number; readonly mismatches: number }> = []
						let checked = 0
						for (let first = 1; first <= fullAllenMask; first += batchSize) {
							const masks = Arr.map(
								indices(Math.min(batchSize, fullAllenMask - first + 1)),
								(i) => first + i
							)
							const columns = Arr.map(
								masks,
								(mask) =>
									`count(*) FILTER (WHERE (${predicate(mask)}) <> (((${mask} >> r1.rel) & 1) = 1))::text`
							)
							const [row] = yield* db.values(
								`SELECT ${Arr.join(columns, ", ")} FROM ${schema}.p AS r1`,
								[]
							)
							for (const [i, mask] of masks.entries()) {
								const mismatches = Number(row?.[i])
								if (mismatches !== 0) {
									failures.push({ mask, mismatches })
								}
							}
							checked += masks.length
						}
						assert.deepEqual(failures, [])
						assert.equal(checked, fullAllenMask)

						/**
						 * The same query catches a wrong formula: the hand overlaps derivation without NOT A @> B admits
						 * finishedBy, on PostgreSQL as on the host.
						 */
						const hand = formulaSql([[0, 10, 13]], "r1.a", "r1.b")
						const wrong = yield* db.values(
							`SELECT DISTINCT r1.rel::text FROM ${schema}.p AS r1 WHERE (${hand}) <> (((${ALLEN.overlaps} >> r1.rel) & 1) = 1)`,
							[]
						)
						assert.deepEqual(
							Arr.map(wrong, ([rel]) => allenRelations[Number(rel)]),
							["finishedBy"]
						)
					})
				)
			),
		600_000
	)
})
