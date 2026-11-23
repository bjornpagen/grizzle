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
import { inInstallation } from "#test/pg/compute/support.ts"
import {
	dictionary,
	type DictionaryFeature,
	dictionarySchema,
	textInstallation,
	judgeDictionary
} from "#test/pg/compute/text.fixtures.ts"
import { installationSql } from "#test/support/compile.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Text's terms on PostgreSQL an installed CHECK over a closed dictionary of patterns admits exactly each domain's matches.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/compute/text.test.ts at c568eb123).
 */
export const computesTextTermsOnPostgreSQLAnInstalledCHECKOverAClosedDictionaryOfPatternsAdmitsExactlyEachDomainsMatches =
	property.explore(dictionary, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"dictionary admits",
			"dictionary refuses",
			"literal admits",
			"literal refuses"
		] satisfies ReadonlyArray<Reached<DictionaryFeature>>,
		check:
			({ substrate2 }, c: Case<DictionaryFeature>) =>
			(d) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const s = dictionarySchema(d)
								const installation = yield* textInstallation(s)
								const pinned = yield* substrate.admin.pin
								const { problems, reached } = yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									judgeDictionary(pinned, installation, s, d)
								)
								c.noteAll(reached)
								assert.deepEqual(problems, [])
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
		budget: { runs: 30, steered: 30 },
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
