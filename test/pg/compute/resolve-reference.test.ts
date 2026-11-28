/**
 * Text.resolveReference on PostgreSQL 19, against the host and RFC 3986.
 *
 * The library function's SQL (physical/ddl/library.ts), created in the session's pg_temp, over a batch of pairs in one
 * round trip, RFC 3986 §5.4's 42 examples and drawn references each against a drawn base: PostgreSQL's target of each,
 * the host evaluator's, and RFC 3986 read by other means (test/support/oracle/evaluate/uri.ts) are one text.
 *
 * Oracle: a second implementation of RFC 3986 §5.2 (Appendix B's expression, §5.2.4's rules as patterns).
 *
 * Features: each component a reference states, a dot segment, a `..` past the root, an undefined query against a
 * base's, and the RFC's example base, in the batches.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	createLibrary,
	hostTarget,
	pairsBatch,
	resolveSql
} from "#test/pg/compute/resolve-reference.fixtures.ts"
import { resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import { inInstallation, textCell } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import type { UriFeature } from "#test/support/unit/text/uri.fixtures.ts"

const situations = [
	"a reference with a scheme",
	"a reference with an authority",
	"a reference with an empty path",
	"a reference with an absolute path",
	"a reference with a relative path",
	"a dot segment",
	"a .. past the root",
	"an undefined query against a base's",
	"the RFC's example base"
] as const satisfies ReadonlyArray<Reached<UriFeature>>

/**
 * Text.resolveReference on PostgreSQL 19 the library function's target of every reference against every base is the host's and RFC 3986's.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/resolve-reference.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/resolve-reference.test.ts` at its
 *   budget before, `{ runs: 24, steered: 24 }`, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
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
export const computeResolveReferenceOnPostgreSQL19TheLibraryFunctionsTargetOfEveryReferenceAgainstEveryBaseIsTheHostsAndRFC3986s =
	property.explore(pairsBatch, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations,
		check:
			({ tx }, k: Case<UriFeature>) =>
			({ pairs, features }) =>
				Effect.gen(function* () {
					const { bare } = yield* tx
					for (const feature of features) {
						k.note(feature)
					}
					const rows = yield* inInstallation(
						bare,
						[createLibrary],
						bare.queryValues(resolveSql, [
							jsonText(Arr.map(pairs, (p, ord) => ({ ord, b: p.base, r: p.reference })))
						])
					)
					yield* agree<ReadonlyArray<string>>(
						[
							["RFC 3986", Arr.map(pairs, (p) => resolvedReference(p.base, p.reference))],
							["PostgreSQL", Arr.map(rows, (row) => textCell(row, 0))],
							["the host", Arr.map(pairs, hostTarget)]
						],
						ordered(exact)
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "RFC 3986 read by other means (Appendix B's expression, §5.2.4's rules as patterns), and the host's grizzle-text resolver"
		},
		budget: { runs: 1, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\t\twhen(kept, basePath, firstNonNull([walk.read("path"), text("")])),',
				replacement: '\t\t\twhen(kept, basePath, targets.read("input")),',
				why: "The SQL leaves a reference's dot segments in its target's path; the RFC's `.` and `..` examples resolve to paths that still hold them."
			}
		]
	})
