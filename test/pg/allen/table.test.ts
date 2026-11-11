/**
 * The Allen table on PostgreSQL 19: the host's model of ranges (test/support/oracle/allen.ts) against PostgreSQL's own.
 *
 * - Canonicalization: for every range type, every literal of a survey (every bound form over a pair of endpoints
 *   around the window, the type's limit spellings that overflow or empty, and the stored universe's spellings) reads in
 *   PostgreSQL as the host's canonicalization says: the same canonical span, an empty range, or the same refusal's
 *   SQLSTATE. Features: a span, an empty range and a refusal, for each type.
 * - Masks and literals: for every range type, over every ordered pair of the stored universe, each of the 8,191 masks'
 *   emitted predicate (test/support/oracle/allen-sql.ts maskSql) holds exactly when the host classifier's relation of
 *   the pair is in the mask, and each atom literal and its negation, PostgreSQL's operator, holds exactly where the
 *   host's transcription of it does.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): allen-canonical-upper-inclusive.patch (the host canonicalization
 * leaving an inclusive upper bound where it is), allen-atom-before-strict.patch (the `<<` atom's relations read as
 * strictly before, without meets).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { atomLiterals, literalNegated } from "#compiler/allen/atoms.ts"
import { AllenMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { formulaSql, maskSql } from "#test/support/oracle/allen-sql.ts"
import {
	type Canonical,
	canonicalizationSurvey,
	canonicalize,
	type RangeType,
	rangeTypes,
	spanText,
	spellingText,
	universe,
	universePairs,
	universeSpellings
} from "#test/support/oracle/allen.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** What a survey's literal came to in PostgreSQL, for a range type: a stored span, an empty range, or a refusal. */
type Outcome = "a span" | "an empty range" | "a refusal"
const outcomes: Arr.NonEmptyReadonlyArray<Outcome> = ["a span", "an empty range", "a refusal"]

type CanonicalFeature = `${RangeType}: ${Outcome}`

/** The outcome a canonical text names. */
const outcomeOf = (text: string): Outcome =>
	Str.startsWith("error:")(text) ? "a refusal" : text === "empty" ? "an empty range" : "a span"

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
			exhaust(
				{
					suite: "pg/allen/canonicalization",
					generator: element(rangeTypes),
					literal: Formatter.format,
					limit: rangeTypes.length,
					coverage: requiredInSpace<CanonicalFeature>(
						Arr.flatMap(rangeTypes, (type) =>
							Arr.map(outcomes, (outcome): CanonicalFeature => `${type}: ${outcome}`)
						)
					),
					box: "every range type, by every bound form over a pair of endpoints around the window, the type's limit spellings and the stored universe's spellings",
					oracle: {
						kind: "postgresql",
						name: "each literal cast to the range type in PostgreSQL, against the host canonicalization"
					},
					caseHang
				},
				(type, c) =>
					Effect.gen(function* () {
						const s = yield* Substrate
						const allenSchema = yield* s.schema({ ...freshSchema, label: "allen" })
						const schema = quoteIdent(allenSchema)
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
						for (const row of rows) {
							c.note(`${type}: ${outcomeOf(String(row[1]))}`)
						}
					})
			)
		)
	)

	it.effect(
		"gives 0 mismatches for every mask and every literal over every ordered pair of the stored universe of every range type",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "pg/allen/masks",
						generator: element(rangeTypes),
						literal: Formatter.format,
						limit: rangeTypes.length,
						coverage: requiredInSpace<RangeType>(rangeTypes),
						box: "every range type, by every Allen mask and every atom literal, over every ordered pair of the stored universe",
						oracle: {
							kind: "postgresql",
							name: "PostgreSQL's range operators under each mask's formula, against the host classifier's relation"
						},
						caseHang
					},
					(type, c) =>
						Effect.gen(function* () {
							c.note(type)
							const s = yield* Substrate
							const allenSchema = yield* s.schema({ ...freshSchema, label: "allen" })
							const schema = quoteIdent(allenSchema)
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
								[
									jsonText(
										Arr.map(spellings, (spelling, id) => ({ id, t: spellingText(spelling) }))
									)
								]
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

							/**
							 * Every ordered pair of stored values, with the host classifier's relation bit and the host's transcription of
							 * PostgreSQL's operators, each atom's truth as its bit.
							 */
							const pairs = universePairs(spans)
							yield* db.query(
								`CREATE TABLE ${schema}.p (a ${type} NOT NULL, b ${type} NOT NULL, rel int4 NOT NULL, atoms int4 NOT NULL)`,
								[]
							)
							yield* db.query(
								`INSERT INTO ${schema}.p (a, b, rel, atoms)
SELECT x.v, y.v, j.rel, j.atoms
FROM (SELECT DISTINCT v FROM ${schema}.u) AS x
CROSS JOIN (SELECT DISTINCT v FROM ${schema}.u) AS y
JOIN jsonb_to_recordset($1::text::jsonb) AS j(a text, b text, rel int4, atoms int4) ON j.a = x.v::text AND j.b = y.v::text`,
								[
									jsonText(
										Arr.map(pairs, (p) => ({
											a: spanText(p.a),
											b: spanText(p.b),
											rel: p.relationBit,
											atoms: p.atoms
										}))
									)
								]
							)
							const counted = yield* db.values(`SELECT count(*)::text FROM ${schema}.p`, [])
							assert.equal(Number(counted[0]?.[0]), spans.length ** 2)

							/**
							 * Every other mask: the emitted predicate must hold exactly when the pair's relation is in the mask.
							 */
							const failures: Array<{ readonly mask: number; readonly mismatches: number }> = []
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
							}
							assert.deepEqual(failures, [])

							/**
							 * Every literal, each atom and its negation: PostgreSQL's operator must hold exactly where the host's
							 * transcription of it holds, which the unit suite holds to each atom's relation set.
							 */
							const literals = Arr.flatten(atomLiterals)
							const [literalRow] = yield* db.values(
								`SELECT ${Arr.join(
									Arr.map(
										literals,
										(literal) =>
											`count(*) FILTER (WHERE (${formulaSql([[literal]], "r1.a", "r1.b")}) <> (((r1.atoms >> ${literal >> 1}) & 1) = ${literalNegated(literal) ? 0 : 1}))::text`
									),
									", "
								)} FROM ${schema}.p AS r1`,
								[]
							)
							assert.deepEqual(
								Arr.flatMap(literals, (literal, i) =>
									Number(literalRow?.[i]) === 0
										? []
										: [{ literal, mismatches: Number(literalRow?.[i]) }]
								),
								[]
							)
						})
				)
			)
	)
})
