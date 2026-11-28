/**
 * Text's terms on PostgreSQL 19, against the host.
 *
 * Installed CHECKs: the real installer's DDL, one CHECK whose pattern is a closed relation's str.pattern field,
 * `Pattern.at("pattern", domain)`, read from its ARE dictionary by the domain's key, and one of a drawn literal, each
 * probe row inserted under a savepoint; the server admits a row exactly when ECMAScript's test of its pattern holds, and
 * refuses every other with 23514 naming that CHECK.
 *
 * Oracle: PostgreSQL's CHECK for the installed patterns, against ECMAScript's test.
 *
 * Features: each dictionary situation the search names.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	dictionary,
	type DictionaryFeature,
	dictionarySchema,
	textInstallation,
	judgeDictionary
} from "#test/pg/compute/text.fixtures.ts"
import { installationSql } from "#test/support/compile.ts"
import { inInstallation } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Text's terms on PostgreSQL an installed CHECK over a closed dictionary of patterns admits exactly each domain's matches.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/text.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/text.test.ts` at its budget before, `{
 *   runs: 30, steered: 30 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
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
export const computesTextTermsOnPostgreSQLAnInstalledCHECKOverAClosedDictionaryOfPatternsAdmitsExactlyEachDomainsMatches =
	property.explore(dictionary, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"dictionary admits",
			"dictionary refuses",
			"literal admits",
			"literal refuses"
		] satisfies ReadonlyArray<Reached<DictionaryFeature>>,
		check:
			({ tx }, c: Case<DictionaryFeature>) =>
			(d) =>
				Effect.gen(function* () {
					const { bare, database, schema } = yield* tx
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const s = dictionarySchema(d)
							const schemaName = yield* schema("text")
							const installation = yield* textInstallation(s, schemaName)
							const { problems, reached } = yield* inInstallation(
								bare,
								installationSql(installation, database),
								judgeDictionary(bare, installation, s, d)
							)
							c.noteAll(reached)
							assert.deepEqual(problems, [])
						})
					)
				}),
		oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
		budget: { runs: 1, steered: 30 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: '{ kind: "are", field: read.field }',
				replacement: '{ kind: "at", field: read.field }',
				why: "The CHECK matches its text against its domain's pattern as grizzle spells it, where PostgreSQL reads an ARE: a pattern whose spellings differ admits or refuses another row than ECMAScript's test."
			}
		]
	})
