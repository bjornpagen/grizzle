import { assert, defined } from "@bjornpagen/testing/assert"
/**
 * Compute.lowerAscii on PostgreSQL 19: ASCII's case fold, which PostgreSQL computes as lower under the C collation,
 * collated back to pg_c_utf8 (scalar/compute/registry.ts textLowerAscii), one SQL node in a query, a CHECK and a
 * generated field alike.
 *
 * - Over a batch of texts of every class of byte UTF-8 begins a character with, ASCII, lead bytes of two, three and four
 *   bytes and every continuation byte, the lead bytes that hold a capital's bits among them, beside letters Unicode
 *   lowers and the fold keeps, empty texts and long ones, in one round trip: the fold's SQL, lowered in a query and in a
 *   check, over text whose type bounds no bytes, is translate's by the ASCII capitals and their small letters and the
 *   host's fold, code point by code point, all three one text; and the fold is collated pg_c_utf8, as every text grizzle
 *   stores is, though its operand is collated as the database is: so an equation of a pg_c_utf8 key with the fold is
 *   served by the key's B-tree, whatever the database's own collation.
 * - Over a text past translateMaxBytes, a drawn text repeated on the server: the fold's SQL, a query's and a check's,
 *   folds it whole, equal to its unit's fold repeated, where translate refuses it with 54000.
 * - The repro, installed as `grizzle generate` drafts it: Folded a query that folds Attr's text, whose type bounds no
 *   bytes, against a tag, and a rule holding every Tag fact in Folded. A query reads every attribute's fold, long ones
 *   among them, as the host folds it; a write of tags is accepted exactly where each is its attribute's text folded by
 *   the host, and is refused naming the rule where one is written as it stands, as Unicode lowers it, or with no
 *   attribute; and Folded, read by a query, is every tag accepted.
 *
 * Oracle: the host's fold over code points (lower-ascii.fixtures.ts asciiFolded), translate by the capitals, and the
 * rule restated over the rows.
 *
 * Features: each byte class, letter and length the searches name, and each way a tag stands to its attribute's text.
 */
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { translateMaxBytes } from "#compiler/scalar/compute/typing.ts"
import {
	asciiCapitals,
	asciiFolded,
	asciiSmalls,
	type FoldCase,
	type FoldFeature,
	foldCase,
	foldFeatures,
	foldFeaturesOf,
	foldSql,
	foldTemplate,
	pastCase,
	type ReproFeature,
	reproCase,
	reproFeatures,
	textBatch
} from "#test/pg/text/lower-ascii.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Compute.lowerAscii's one SQL, in a query and in a check, is translate's by the ASCII capitals and the host's ASCII case fold over every byte class, long texts included, and is collated pg_c_utf8. */
export const lowerAsciisOneSqlInAQueryAndInACheckIsTranslatesByTheAsciiCapitalsAndTheHostsAsciiCaseFoldOverEveryByteClassLongTextsIncludedAndIsCollatedPgCUtf8 =
	property.explore(textBatch, {
		needs: { tx: Substrate.transaction },
		situations: foldFeatures,
		check:
			({ tx }, k: Case<FoldFeature>) =>
			(texts) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const read = foldSql("query")
					const stored = foldSql("check")
					const rows = yield* db.values(
						`SELECT (${read})::text, (${stored})::text, pg_catalog.translate(r0.v, $2::text, $3::text), pg_catalog.pg_collation_for(${stored}), pg_catalog.pg_collation_for(r0.v) FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`,
						[
							jsonText(Arr.map(texts, (value, ord) => ({ ord, v: value }))),
							asciiCapitals,
							asciiSmalls
						]
					)
					assert.equal(rows.length, texts.length, "a row per text")
					for (const [i, row] of rows.entries()) {
						const text = defined(texts[i], `text ${i}`)
						const shown = Formatter.format(text.length > 64 ? `${Str.slice(0, 64)(text)}…` : text)
						const [inQuery, inCheck, translated, collation, operand] = row
						assert.equal(inQuery, asciiFolded(text), `the query's fold of ${shown}`)
						assert.equal(inCheck, asciiFolded(text), `the check's fold of ${shown}`)
						assert.equal(translated, asciiFolded(text), `translate by the capitals of ${shown}`)
						assert.equal(
							operand,
							'"default"',
							`the operand ${shown} is collated as the database is, so no collation of the fold's is its own`
						)
						assert.equal(collation, "pg_c_utf8", `the collation of the fold of ${shown}`)
						k.noteAll(foldFeaturesOf(text))
					}
					yield* db.values(
						"CREATE TEMPORARY TABLE probe_fold (k text COLLATE pg_catalog.pg_c_utf8 PRIMARY KEY)",
						[]
					)
					yield* db.values(
						"INSERT INTO pg_temp.probe_fold SELECT g::text FROM pg_catalog.generate_series(1, 4096) AS g",
						[]
					)
					yield* db.values("ANALYZE pg_temp.probe_fold", [])
					const plan = yield* db.values(
						`EXPLAIN SELECT p.k FROM (SELECT $1::text AS v) AS r0 JOIN pg_temp.probe_fold AS p ON p.k = (${read})`,
						[defined(texts[0], "a first text")]
					)
					assert.ok(
						Arr.some(
							plan,
							([line]) =>
								typeof line === "string" &&
								(Str.includes("Index Scan using probe_fold_pkey")(line) ||
									Str.includes("Index Only Scan using probe_fold_pkey")(line))
						),
						`an equation of a pg_c_utf8 key with the query's fold is served by the key's index: ${Formatter.format(plan)}`
					)
				}),
		oracle: { kind: "second-implementation", name: "the host's ASCII case fold over code points" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `(\${wrap(expr(e.expr), "collate")} COLLATE \${inCatalog("C")})`,
				replacement: `(\${wrap(expr(e.expr), "collate")} COLLATE \${printObjectName(cUtf8Collation)})`,
				why: "A query folds under pg_c_utf8, whose lower is Unicode's, so it lowers É, Σ and the Kelvin sign, which ASCII's fold keeps."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: ` COLLATE \${inCatalog("C")}) COLLATE \${printObjectName(cUtf8Collation)}\`,`,
				replacement: ` COLLATE \${inCatalog("C")})\`,`,
				why: "A query's fold keeps lower's collation, \"C\", so an equation with it is no pg_c_utf8 index's and its regex classes are C's."
			}
		]
	})

/** Compute.lowerAscii's one SQL, in a query and in a check, folds a text past every operand translate reads, whole, where translate refuses it. */
export const lowerAsciisOneSqlInAQueryAndInACheckFoldsATextPastEveryOperandTranslateReadsWholeWhereTranslateRefusesIt =
	property.explore(pastCase, {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Each case allocates about a gigabyte on its backend: the text, its fold, its fold's own repeat and lower's copy. */
		budget: { runs: 4, steered: 0 },
		check:
			({ tx }) =>
			({ unit, extra }) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const unitBytes = new TextEncoder().encode(unit).length
					const count = Math.floor(translateMaxBytes / unitBytes) + extra
					const [row] = yield* db.values(
						`SELECT (${foldSql("query")}) = pg_catalog.repeat($2::text, $3::int4), (${foldSql("check")}) = pg_catalog.repeat($2::text, $3::int4), pg_catalog.octet_length(r0.v) FROM (SELECT pg_catalog.repeat($1::text, $3::int4) AS v) AS r0`,
						[unit, asciiFolded(unit), count]
					)
					const [equal, stored, bytes] = defined(row, "one row")
					assert.ok(
						Number(bytes) > translateMaxBytes,
						`a text of ${Formatter.format(bytes)} bytes is past translate's`
					)
					assert.equal(
						equal,
						true,
						`the query folds ${Formatter.format(unit)} repeated ${count} times whole`
					)
					assert.equal(
						stored,
						true,
						`a check folds ${Formatter.format(unit)} repeated ${count} times whole`
					)
					const refused = yield* Effect.flip(
						db.values(
							"SELECT pg_catalog.octet_length(pg_catalog.translate(r0.v, $3::text, $4::text)) FROM (SELECT pg_catalog.repeat($1::text, $2::int4) AS v) AS r0",
							[unit, count, asciiCapitals, asciiSmalls]
						)
					)
					assert.ok(
						refused.reason._tag === "ServerError" && refused.reason.fields.code === "54000",
						`translate refuses ${Formatter.format(bytes)} bytes with 54000, not ${Formatter.format(refused.reason)}`
					)
				}),
		oracle: {
			kind: "postgresql",
			name: "translate's refusal past translateMaxBytes, and the host's fold of the unit repeated"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\tconst op = this.overload("lowerAscii", [x.actual], at)\n\t\tconst node = this.native(op, [x], wildcardText, undefined, at, "Compute.lowerAscii")\n',
				replacement:
					'\t\tconst f = this.literal("ABCDEFGHIJKLMNOPQRSTUVWXYZ", wildcardText, childLoc(at, 1))\n\t\tconst t = this.literal("abcdefghijklmnopqrstuvwxyz", wildcardText, childLoc(at, 2))\n\t\tconst node = this.native(this.overload("translate", [x.actual, f.actual, t.actual], at), [x, f, t], wildcardText, undefined, at, "Compute.translate")\n',
				why: "Every fold is translate, which refuses a text past translateMaxBytes with 54000: a read fails on a value."
			}
		]
	})

/** The repro compiles and holds: a query folds each attribute's unbounded text as the host does, and the rule over Folded accepts exactly the tags the host folds from their attributes. */
export const theReproCompilesAndHoldsAQueryFoldsEachAttributesUnboundedTextAsTheHostDoesAndTheRuleOverFoldedAcceptsExactlyTheTagsTheHostFoldsFromTheirAttributes =
	property.explore(foldCase, {
		needs: { seat: Substrate.seat(foldTemplate) },
		situations: reproFeatures,
		check: (resources, c: Case<ReproFeature>) => (k: FoldCase) => reproCase(resources)(k, c),
		oracle: {
			kind: "specification",
			name: "the host's fold of each attribute's text, and the rule restated over the rows"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: '? { kind: "lowerAscii", expr: first }',
				replacement: "? first",
				why: "A query's fold leaves its text as it is, so Folded holds only the tags written as their attributes stand, and a query reads an attribute's capitals back unfolded."
			}
		]
	})
