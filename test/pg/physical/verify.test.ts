import { assert, defined } from "@bjornpagen/testing/assert"
/**
 * The catalog verifiers against drift on PostgreSQL 19: the erasure verifier (test/support/catalog/verify.ts), the
 * installed checker (test/support/catalog/installed.ts) and the manifest projection (test/support/catalog/expected.ts),
 * which every other physical suite expects to find nothing, so a verifier that accepted everything would pass them all.
 * Each drift is made in a transaction rolled back, so drifts never accumulate (the drift worlds' JSDoc below states
 * them).
 *
 * - Erasure drifts and world drifts: each drawn drift is named exactly as its rule states, and one that confers nothing
 *   is named by nothing.
 * - Not valid: every foreign key re-added NOT VALID is caught by the manifest comparison alone, exhausted over the
 *   installation's foreign keys.
 *
 * Oracle: each rule as its specification states it, over targets drawn from the installation's own catalog and
 * expectation.
 *
 * Features: each drift kind, named and conferring nothing, and each foreign key.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { fixtureWorlds, worldsExpectation, fixtureCatalog } from "#test/pg/physical/support.ts"
import {
	drifted,
	driftWorldsTemplate,
	erasureCases,
	erasureContextOf,
	erasureDrifts,
	type ErasureFeature,
	erasureFeatures,
	foreignKeyCases,
	ledgerTemplate,
	named,
	qualified,
	worldCases,
	worldContextOf,
	worldDrifts,
	type WorldFeature,
	worldFeatures
} from "#test/pg/physical/verify.fixtures.ts"
import { expectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"
import { checkInstalled } from "#test/support/catalog/installed.ts"
import { verifyErasure } from "#test/support/catalog/verify.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Ledger } from "#test/unit/physical/fixtures.ts"

/**
 * The erasure verifier names each drawn drift's problem, and nothing for a drift that confers nothing, each case on the
 * worker's seat of Ledger: the case's arm (erasureArms) drawn by the space, its targets over the clone's catalog.
 *
 * Its pre-conversion budget: runs 64, coverage cases 240 (test/pg/physical/verify.test.ts at 5bc9f6eeb).
 */
export const theErasureVerifierNamesEachDrawnDriftsProblemAndNothingForADriftThatConfersNothing =
	property.explore(erasureCases, {
		needs: { ledger: Substrate.seat(ledgerTemplate) },
		situations: erasureFeatures satisfies ReadonlyArray<Reached<ErasureFeature>>,
		check:
			({ ledger }, c: Case<ErasureFeature>) =>
			(arm) =>
				Effect.scoped(
					Effect.flatMap(ledger, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { installation, schema } = seat.value
								const catalog = yield* fixtureCatalog(seat.value)
								const x = yield* erasureContextOf(installation, catalog, schema)
								const drift = c.draw(erasureDrifts(x)[arm])
								const after = yield* drifted([schema], drift.statements)
								named(verifyErasure(after, x.expectation), drift)
								c.note(drift.feature)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "each drift's rule as the erasure verifier's specification states it, over the installation's own objects"
		},
		show: Formatter.format,
		budget: { runs: 64, steered: 240 },
		kept: [],
		kills: []
	})

/**
 * Every foreign key re-added NOT VALID keeps the verifier's shape rules, and the manifest comparison catches it, each
 * case on the worker's seat of Ledger.
 *
 * Its pre-conversion budget: the box (test/pg/physical/verify.test.ts at 5bc9f6eeb).
 */
export const everyForeignKeyReaddedNotValidKeepsTheVerifiersShapeRulesAndTheManifestComparisonCatchesIt =
	property.exhaust(finite(foreignKeyCases), {
		needs: { ledger: Substrate.seat(ledgerTemplate) },
		situations: ["a foreign key re-added NOT VALID"] satisfies ReadonlyArray<
			Reached<"a foreign key re-added NOT VALID">
		>,
		check:
			({ ledger }, c: Case<"a foreign key re-added NOT VALID">) =>
			(fk) =>
				Effect.scoped(
					Effect.flatMap(ledger, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { installation, schema } = seat.value
								const catalog = yield* fixtureCatalog(seat.value)
								const expectation = worldsExpectation(Ledger, installation, fixtureWorlds(Ledger))
								const expected = expectedCatalog(installation)
								assert.deepEqual(projectCatalog(catalog), expected, "the installation as installed")
								const key = defined(
									Arr.findFirst(
										Arr.flatMap(catalog.tables, (t) => (t.name === fk.table ? t.constraints : [])),
										(k) => k.type === "f" && k.name === fk.name
									).pipe(Option.getOrUndefined),
									`the foreign key ${fk.table}.${fk.name} the clone holds`
								)
								const after = yield* drifted(
									[schema],
									[
										`ALTER TABLE ${qualified(catalog, fk.table)} DROP CONSTRAINT ${quoteIdent(key.name)}`,
										`ALTER TABLE ${qualified(catalog, fk.table)} ADD CONSTRAINT ${quoteIdent(key.name)} ${key.definition} NOT VALID`
									]
								)
								assert.deepEqual(verifyErasure(after, expectation), [], "the shape rules hold")
								const projected = projectCatalog(after)
								assert.deepEqual(
									projected,
									{
										...expected,
										tables: Arr.map(expected.tables, (t) =>
											t.name === fk.table
												? {
														...t,
														constraints: Arr.map(t.constraints, (k) =>
															k.name === key.name ? { ...k, validated: false } : k
														)
													}
												: t
										)
									},
									"only the constraint's validation differs"
								)
								c.note("a foreign key re-added NOT VALID")
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the manifest's projection, differing in that constraint's validation alone"
		},
		box: "every foreign key of the installation",
		kept: [],
		kills: []
	})

/**
 * The installed checker names each drawn drift of a world written under row security, each case on the worker's seat
 * of the drift worlds: the case's arm (worldArms) drawn by the space, its targets over the clone's catalog.
 *
 * Its pre-conversion budget: runs 64, coverage cases 240 (test/pg/physical/verify.test.ts at 5bc9f6eeb).
 */
export const theInstalledCheckerNamesEachDrawnDriftOfAWorldWrittenUnderRowSecurity =
	property.explore(worldCases, {
		needs: { worlds: Substrate.seat(driftWorldsTemplate) },
		situations: worldFeatures satisfies ReadonlyArray<Reached<WorldFeature>>,
		check:
			({ worlds }, c: Case<WorldFeature>) =>
			(arm) =>
				Effect.scoped(
					Effect.flatMap(worlds, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const x = yield* worldContextOf(seat.value)
								const drift = c.draw(worldDrifts(x)[arm])
								const after = yield* drifted(x.schemas, drift.statements)
								named(checkInstalled(after, x.scope), drift)
								c.note(drift.feature)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "each drift's rule as the installed checker's specification states it, over the installation's own world objects"
		},
		show: Formatter.format,
		budget: { runs: 64, steered: 240 },
		kept: [],
		kills: []
	})
