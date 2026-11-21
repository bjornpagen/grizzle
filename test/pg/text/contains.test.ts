/**
 * Text.contains on PostgreSQL 19: whether a haystack holds a needle, its characters together, which PostgreSQL computes
 * as `strpos(haystack, needle) > 0` (scalar/compute/registry.ts textContains), one SQL node in a query, a CHECK and a
 * generated field alike. No pattern: the needle is read as its characters, so LIKE's `%`, `_` and `\` are characters
 * like any other.
 *
 * - Over a batch of pairs of a haystack and a needle, in one round trip: ASCII letters of both cases, LIKE's special
 *   characters, characters of two, three and four UTF-8 bytes, two sharing a UTF-16 high surrogate and two sharing a
 *   continuation byte, the empty needle, a needle longer than its haystack, a run of the haystack's characters and a
 *   text drawn apart; PostgreSQL's verdict of the SQL a query and a check lower contains to is the host evaluator's
 *   (scalar/compute/evaluate.ts, JavaScript's includes) and the reference evaluator's (its code point search) for each
 *   pair.
 * - A staff search installed as `grizzle generate` drafts it, metis's ADM-USR-2 in small: Staff's names, whose type
 *   bounds no bytes, read by two queries whose term is a query parameter, one folding ASCII's case on both sides with
 *   Text.lowerAscii and one reading the term as it stands. Each answer is the members the reference's search finds in
 *   their names.
 *
 * Oracle: the host evaluator and the reference evaluator for the SQL; the reference's code point search over the names,
 * folded by the host's ASCII case fold of lower-ascii.fixtures.ts, for the search.
 *
 * Features: each kind of needle the searches name, and each way a term finds its members.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	containsLowered,
	type PairFeature,
	pairBatch,
	pairFeatures,
	pairFeaturesOf,
	type SearchCase,
	type SearchFeature,
	searchCase,
	searchCaseRun,
	searchFeatures,
	staffTemplate
} from "#test/pg/text/contains.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { values } from "#test/unit/compute/text.fixtures.ts"

/** The SQL a query and a check lower Text.contains to is the host's verdict and the reference's over every kind of needle, the empty one, a longer one and LIKE's special characters among them. */
export const textContainsSqlInAQueryAndInACheckIsTheHostsVerdictAndTheReferencesOverEveryKindOfNeedleTheEmptyOneALongerOneAndLikesSpecialCharactersAmongThem =
	property.explore(pairBatch, {
		needs: { tx: Substrate.transaction },
		situations: pairFeatures,
		check:
			({ tx }, k: Case<PairFeature>) =>
			(pairs) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const read = containsLowered("query")
					const stored = containsLowered("check")
					const rows = yield* db.values(
						`SELECT ${read.sql}, ${stored.sql} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text, w text) ORDER BY r0.ord`,
						[jsonText(Arr.map(pairs, (p, ord) => ({ ord, v: p.haystack, w: p.needle })))]
					)
					assert.equal(rows.length, pairs.length, "a row per pair")
					for (const [i, row] of rows.entries()) {
						const p = defined(pairs[i], `pair ${i}`)
						const shown = Formatter.format(p)
						const [inQuery, inCheck] = row
						const { host, reference } = values(
							stored.expr,
							new Map([
								["v", p.haystack],
								["w", p.needle]
							])
						)
						assert.equal<unknown>(
							host,
							reference,
							`the host's verdict and the reference's over ${shown}`
						)
						assert.equal<unknown>(inQuery, host, `the query's verdict over ${shown}`)
						assert.equal<unknown>(inCheck, host, `the check's verdict over ${shown}`)
						k.noteAll(pairFeaturesOf(p, inQuery === true))
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host evaluator's includes and the reference evaluator's code point search"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: '? binary(">", call("strpos", [a, b]), lit.int(0n, types.integer))',
				replacement:
					'? binary("~~", a, binary("||", binary("||", lit.text("%", types.text), b), lit.text("%", types.text)))',
				why: "contains lowers to LIKE '%' || needle || '%' with nothing escaped, so a needle's % and _ match any text and its \\ escapes the character after it."
			}
		]
	})

/** A staff search whose term is a query parameter finds exactly the members whose name holds it, ASCII's case folded on both sides or as it stands. */
export const aStaffSearchWhoseTermIsAQueryParameterFindsExactlyTheMembersWhoseNameHoldsItAsciisCaseFoldedOnBothSidesOrAsItStands =
	property.explore(searchCase, {
		needs: { seat: Substrate.seat(staffTemplate) },
		situations: searchFeatures,
		check: (resources, c: Case<SearchFeature>) => (k: SearchCase) => searchCaseRun(resources)(k, c),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's code point search over the names, folded by the host's ASCII case fold"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: '? binary(">", call("strpos", [a, b]), lit.int(0n, types.integer))',
				replacement:
					'? binary("~~", a, binary("||", binary("||", lit.text("%", types.text), b), lit.text("%", types.text)))',
				why: "contains lowers to LIKE '%' || term || '%' with nothing escaped, so a term holding % or _ finds every member."
			}
		]
	})
