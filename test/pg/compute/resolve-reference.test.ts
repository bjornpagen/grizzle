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
import { inInstallation, textCell } from "#test/pg/compute/support.ts"
import { resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import type { UriFeature } from "#test/unit/text/uri.fixtures.ts"

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

/** Text.resolveReference on PostgreSQL 19 the library function's target of every reference against every base is the host's and RFC 3986's. */
export const computeResolveReferenceOnPostgreSQL19TheLibraryFunctionsTargetOfEveryReferenceAgainstEveryBaseIsTheHostsAndRFC3986s =
	property.explore(pairsBatch, {
		needs: { substrate: Substrate.installing },
		situations,
		check:
			({ substrate }, k: Case<UriFeature>) =>
			({ pairs, features }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						for (const feature of features) {
							k.note(feature)
						}
						const pinned = yield* s.admin.pin
						const rows = yield* inInstallation(
							pinned,
							[createLibrary],
							pinned.queryValues(resolveSql, [
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
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "RFC 3986 read by other means (Appendix B's expression, §5.2.4's rules as patterns), and the host's grizzle-text resolver"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\twhen(kept, basePath, removeDotSegments(names, targets.read("input"))),',
				replacement: '\t\twhen(kept, basePath, targets.read("input")),',
				why: "The SQL leaves a reference's dot segments in its target's path; the RFC's `.` and `..` examples resolve to paths that still hold them."
			}
		]
	})
