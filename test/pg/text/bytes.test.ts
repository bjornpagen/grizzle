/**
 * str.bytes(N, pattern), generated: a text of the pattern's language of at most N UTF-8 bytes, against PostgreSQL 19
 * and against the analysis.
 *
 * Each case draws a bound N, a pattern (every text, `^.*$`; at most L code points, `^.{0,L}$`, whose four bytes a code
 * point the bound may already meet; or a class of letters of every width, `^[a-zé€𐍈]*$`, of no bound) and a script of
 * one UTF-8 width, 1 to 4 bytes a code point; its values are the texts of N - 1, N and N + 1 bytes in that script, the
 * script's code points then ASCII to make up the bytes. A run installs a batch of cases as one schema through its first
 * migration, each a relation of an integer key and a str.bytes field, and inserts each value as the migration identity,
 * a direct writer. A value is stored exactly when it is a member of the pattern, by ECMAScript (jsMatcher), and of
 * at most N bytes, by TextEncoder; otherwise the domain's CHECK refuses it with SQLSTATE 23514. The analysis agrees:
 * the field's type bounds its bytes at the lesser of the pattern's bound and N and its code points at the lesser of
 * the pattern's and N, and the host's membership (scalar/regex/patterns.ts ProgramPatterns) answers as PostgreSQL does.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BytesFeature,
	caseGen,
	cases,
	checkBatch,
	requiredFeatures
} from "#test/pg/text/bytes.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Str.bytes, generated stores exactly the texts of its pattern of at most N bytes, as the analysis bounds and judges them.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/text/bytes.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/text/bytes.test.ts` at its budget before, `{
 *   runs: 1, steered: 1 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const strBytesGeneratedStoresExactlyTheTextsOfItsPatternOfAtMostNBytesAsTheAnalysisBoundsAndJudgesThem =
	property.explore(array(caseGen, { min: cases, max: cases }), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: requiredFeatures satisfies ReadonlyArray<Reached<BytesFeature>>,
		budget: { runs: 1, steered: 1 },
		check:
			({ substrate }, c: CaseOf<BytesFeature>) =>
			(b) =>
				Effect.provideServiceEffect(
					checkBatch(b, c.noteAll),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "ECMAScript membership of the pattern and TextEncoder's byte length: stored exactly when both hold"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/text/membership.ts",
				original: '\tle(call("octet_length", [value]), lit.int(octets, types.integer))',
				replacement: '\tle(call("char_length", [value]), lit.int(octets, types.integer))',
				why: "str.bytes bounding characters, not UTF-8 bytes."
			}
		]
	})
