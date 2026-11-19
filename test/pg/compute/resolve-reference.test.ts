/**
 * Compute.resolveReference on PostgreSQL 19, against the host and RFC 3986.
 *
 * 1. The library function's SQL (physical/ddl/library.ts), created in the session's pg_temp, over a batch of pairs in
 *    one round trip, RFC 3986 §5.4's 42 examples and drawn references each against a drawn base: PostgreSQL's target
 *    of each, the host evaluator's, and RFC 3986 read by other means (test/support/oracle/evaluate/uri.ts) are one
 *    text.
 * 2. Installed: a relation Links whose generated field `target` resolves its `href` against its `base`, so its
 *    installation installs the library function before the table that calls it; every pair of a batch is inserted,
 *    and the target PostgreSQL stores for it is the host's.
 *
 * Oracle: a second implementation of RFC 3986 §5.2 (Appendix B's expression, §5.2.4's rules as patterns), and the
 * host's grizzle-text resolver.
 *
 * Features: each component a reference states, a dot segment, a `..` past the root, an undefined query against a
 * base's, and the RFC's example base, in the batches.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import {
	createLibrary,
	hostTarget,
	Links,
	links,
	pairsBatch,
	resolveSql
} from "#test/pg/compute/resolve-reference.fixtures.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { inInstallation } from "#test/pg/compute/utf16-length.fixtures.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import { ownedInput } from "#test/support/policy.ts"
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

/** Compute.resolveReference on PostgreSQL 19 the library function's target of every reference against every base is the host's and RFC 3986's. */
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
				original: '\t\twhen(kept, basePath, removeDotSegments(col("t", "input"))),',
				replacement: '\t\twhen(kept, basePath, col("t", "input")),',
				why: "The SQL leaves a reference's dot segments in its target's path; the RFC's `.` and `..` examples resolve to paths that still hold them."
			}
		]
	})

/** Compute.resolveReference on PostgreSQL 19 an installed generated field stores the host's target of each href against its base. */
export const computeResolveReferenceOnPostgreSQL19AnInstalledGeneratedFieldStoresTheHostsTargetOfEachHrefAgainstItsBase =
	property.explore(pairsBatch, {
		needs: { substrate2: Substrate.installing },
		situations,
		check:
			({ substrate2 }, k: Case<UriFeature>) =>
			({ pairs, features }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								for (const feature of features) {
									k.note(feature)
								}
								const schemaName = yield* substrate.schema({ create: false, label: "resolve" })
								const compiled = Result.flatMap(ownedInput(links), (owned) =>
									compileInstallation(owned, {
										...installOptions(owned),
										levels: [identity.schema(parsedSchemaName(schemaName))]
									})
								)
								assert.ok(
									compiled.ok,
									`a generated resolution compiles: ${compiled.ok ? "" : compiled.error.message}`
								)
								const installation = compiled.value
								const names = installationNamesOf(installation)
								const pinned = yield* substrate.admin.pin
								const stored = yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									Effect.gen(function* () {
										yield* pinned.query(
											`INSERT INTO ${names.table(Links)} (${names.column(Links, "id")}, ${names.column(Links, "n")}, ${names.column(Links, "base")}, ${names.column(Links, "href")}) SELECT gen_random_uuid(), r0.ord, r0.b, r0.r FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, b text, r text)`,
											[jsonText(Arr.map(pairs, (p, ord) => ({ ord, b: p.base, r: p.reference })))]
										)
										return yield* pinned.queryValues(
											`SELECT ${names.column(Links, "target")} FROM ${names.table(Links)} ORDER BY ${names.column(Links, "n")}`,
											[]
										)
									})
								)
								yield* agree<ReadonlyArray<string>>(
									[
										["PostgreSQL's stored target", Arr.map(stored, (row) => textCell(row, 0))],
										["the host", Arr.map(pairs, hostTarget)]
									],
									ordered(exact)
								)
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: { kind: "second-implementation", name: "the host's grizzle-text resolver" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})
