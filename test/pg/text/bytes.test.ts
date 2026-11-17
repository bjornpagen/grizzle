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
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Str.bytes, generated stores exactly the texts of its pattern of at most N bytes, as the analysis bounds and judges them. */
export const strBytesGeneratedStoresExactlyTheTextsOfItsPatternOfAtMostNBytesAsTheAnalysisBoundsAndJudgesThem =
	property.explore(array(caseGen, { min: cases, max: cases }), {
		needs: { substrate: Substrate.installing },
		situations: requiredFeatures satisfies ReadonlyArray<Reached<BytesFeature>>,
		/** Its pre-conversion budget: runs 1, coverage cases 1, each case a batch of 24 (bytes.test.ts at 4fbc3e95). */
		budget: { runs: 1, steered: 1 },
		check:
			({ substrate }, c: CaseOf<BytesFeature>) =>
			(b) =>
				Effect.provideServiceEffect(checkBatch(b, c.noteAll), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "ECMAScript membership of the pattern and TextEncoder's byte length: stored exactly when both hold"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/text/refinement.ts",
				original: '\tle(call("octet_length", [value]), lit.int(octets, types.integer))',
				replacement: '\tle(call("char_length", [value]), lit.int(octets, types.integer))',
				why: "str.bytes bounding characters, not UTF-8 bytes."
			}
		]
	})
