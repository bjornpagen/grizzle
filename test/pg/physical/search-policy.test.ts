/**
 * The vector library's search policy as login defaults, over drawn worlds on one schema: Doc (a text domain of its
 * own, and a contract over it, whose domain rests on the text's), Embedding (a vector column), Tag (another text domain)
 * and Vectors, a derived relation over Embedding.
 *
 * A case draws three roles, each holding a nonempty set of the four relations whole, writing some of the stored ones it
 * holds and refreshing Vectors when it holds it, and puts each in the login `alpha` or `beta`. A role reaches the
 * vector type when it holds Embedding or Vectors, so it may reach it through the derived relation alone. Every install
 * runs the installed-catalog checker (test/support/catalog/installed.ts), which judges what the catalog stores: each
 * login's defaults are the fixed ones plus, exactly when one of its roles reaches the vector type, the search policy's
 * session parameters; a role holds USAGE on the vector schema exactly when it reaches the type, and on a domain of the
 * schema at least when its views or its writes bind the type and at most when its privileges need it, down a
 * contract's base chain (Doc's handle names both its contract's domain and the text domain under it); MAINTAIN on the
 * materialized view goes to exactly its refreshers. Here:
 *
 * - a session of a login whose roles reach the vector type reads the policy's values, PostgreSQL applying them at
 *   login;
 * - over drawn histories of two or three versions, each login's one role holding a drawn set of the relations, a
 *   migration stores the policy for a login that gains it and resets it for one that loses it, and leaves alone a login
 *   whose reach does not change.
 *
 * Features: a role reading and one writing a contract over a refined text, one reaching the vector type through the
 * derived relation alone, logins with and without the policy, a refresher and a reader of the derived relation, and
 * each reach change across a migration.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import {
	caseGen,
	defaultsOf,
	type Holdings,
	holdingsHistoryGen,
	notesOf,
	onlyHolding,
	type ReachChange,
	reachChanges,
	reaches,
	searchAt,
	type SearchFeature,
	searchPairs,
	storedQuery,
	worldsOf
} from "#test/pg/physical/search-policy.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The search policy as login defaults a login's session holds the policy exactly when one of its roles reaches the vector type.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/physical/search-policy.test.ts at d8eed1786).
 */
export const theSearchPolicyAsLoginDefaultsALoginsSessionHoldsThePolicyExactlyWhenOneOfItsRolesReachesTheVectorType =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a role reading a contract over a refined text",
			"a role writing a contract over a refined text",
			"a role reaching the vector type through the derived relation alone",
			"a login none of whose roles reaches the vector type",
			"a login one of whose roles reaches the vector type",
			"a refresher of the derived relation",
			"a reader of the derived relation that does not refresh it"
		] satisfies ReadonlyArray<Reached<SearchFeature>>,
		check:
			({ substrate }, cx: Case<SearchFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								notesOf(c, cx)
								const base = searchAt("Search")
								/** The install runs the installed-catalog checker over what each login stores. */
								const installed = yield* install(base, {
									ambient: ordinarySession,
									label: "search",
									logins: Arr.map(worldsOf(base, c.logins), (l) => l.value),
									extensions: []
								})
								for (const l of worldsOf(searchAt(installed.declared), c.logins)) {
									if (!l.reaches) {
										continue
									}
									const session = yield* s.session({
										...roleSession(installed.as(l.value)),
										label: l.name
									})
									for (const [parameter, value] of searchPairs) {
										const rows = yield* session.values(
											"SELECT pg_catalog.current_setting($1::text, true)",
											[parameter]
										)
										assert.deepEqual(
											rows,
											[[value]],
											`the login ${l.name}'s session holds ${parameter}`
										)
									}
								}
							})
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the policy's values exactly in the sessions of a login one of whose roles reaches the vector type"
		},
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})

/**
 * The search policy as login defaults a migration stores the policy for a login that gains it, resets it for one that loses it, and leaves the rest.
 *
 * Its pre-conversion budget: runs 4, coverage cases 8 (test/pg/physical/search-policy.test.ts at d8eed1786).
 */
export const theSearchPolicyAsLoginDefaultsAMigrationStoresThePolicyForALoginThatGainsItResetsItForOneThatLosesItAndLeavesTheRest =
	property.explore(holdingsHistoryGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"gains the policy",
			"loses the policy",
			"keeps the policy",
			"stays without it"
		] satisfies ReadonlyArray<Reached<ReachChange>>,
		check:
			({ substrate }, k: Case<ReachChange>) =>
			(history) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							k.noteAll(reachChanges(history))
							const built: Array<ReturnType<typeof worldsOf>> = []
							const version =
								(holdings: Holdings) =>
								(name: string): Version => {
									const base = searchAt(name)
									const worlds = worldsOf(base, [
										{ name: "alpha", scopes: [onlyHolding(holdings.alpha)] },
										{ name: "beta", scopes: [onlyHolding(holdings.beta)] }
									])
									built.push(worlds)
									return { schema: base, logins: Arr.map(worlds, (w) => w.value) }
								}
							const observed: Array<ReadonlyArray<ReadonlyArray<string>>> = []
							const [first, ...later] = Arr.map(history, version)
							yield* migrated({
								label: "search_mig",
								schemaName: { kind: "unique" },
								first,
								later,
								apply: { kind: "noPlaceholders" },
								declared: () => noDeclarations,
								observe: Option.some((i: number, owner: RawSession) =>
									Effect.gen(function* () {
										const worlds = defined(built[i], `version ${i}`)
										const stores: Array<ReadonlyArray<string>> = []
										for (const w of worlds) {
											const rows = yield* owner.values(storedQuery, [roleNameOf(w.value, {})])
											stores.push(Arr.map(rows, (row) => String(row[0])))
										}
										observed.push(stores)
									})
								)
							})
							assert.deepEqual(
								observed,
								Arr.map(history, (holdings) => [
									defaultsOf(reaches(onlyHolding(holdings.alpha))),
									defaultsOf(reaches(onlyHolding(holdings.beta)))
								]),
								"each login's defaults at each version"
							)
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a login stores the policy exactly while one of its roles reaches the vector type"
		},
		budget: { runs: 4, steered: 8 },
		kept: [],
		kills: []
	})
