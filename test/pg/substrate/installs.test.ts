/**
 * A case seated on a template applies no migration, whatever helper it reads its seat through: every installation it
 * reads was applied once per member, by the template's build, and the helper each form's case reads its seat through
 * (installs.fixtures.ts forms) opens what the case needs over the case's clone with none of the install a converted
 * suite's search did once before its cases and its conversion did again in every case (lane TESTPERF, codemod-b2.tsv's
 * setup-per-case rows).
 *
 * - Work counted: each case counts the apply runner's runs (installs.fixtures.ts migrationsApplied) while it reads its
 *   seat through its form's helper, after the take, which may build the template on a worker's first case, and holds
 *   the count to zero. A build runs once per member and outside every case's reading; an install per case counts one.
 * - Each form's reading is what its template made: an installed template's tables and no row, a seeded one's facts, a
 *   fixture's facts loaded by openedIn, the family's one law, the rig's served writer role, the world's installed
 *   names.
 * - Kills: the fixture's, the family's and the rig's helpers each put back to the install per case its converted
 *   suites made before: the property fails, the case counting the install.
 *
 * Features: every form, read three times on a worker's seat.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, Record as Rec } from "effect"
import { commitInstall, commitTemplate } from "#test/pg/adapter/commit.fixtures.ts"
import { writtenTemplate } from "#test/pg/derived/install.fixtures.ts"
import { familySeatIn } from "#test/pg/fin/family.ts"
import { orderTemplates } from "#test/pg/fin/order.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	type Form,
	formCase,
	forms,
	installedForm,
	migrationsApplied
} from "#test/pg/substrate/installs.fixtures.ts"
import { docsWorld } from "#test/pg/world-model/sessions.fixtures.ts"
import { skew, skewRig } from "#test/schedules/write/met-skew.fixtures.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { templateWorld } from "#test/support/worlds/execute/template.ts"

/** A case seated on a template applies no migration, whatever helper it reads its seat through. */
export const aCaseSeatedOnATemplateAppliesNoMigrationWhateverHelperItReadsItsSeatThrough =
	property.exhaust(finite(formCase), {
		needs: {
			installed: Substrate.seat(installedForm.template),
			seeded: Substrate.seat(writtenTemplate),
			fixture: Substrate.seat(commitTemplate),
			family: Substrate.seat(orderTemplates.ordered),
			rig: Substrate.seat(skewRig),
			world: Substrate.seat(docsWorld)
		},
		situations: forms satisfies ReadonlyArray<Reached<Form>>,
		check:
			(seats, c: Case<Form>) =>
			([form]) =>
				Effect.gen(function* () {
					/** Each form's reading of its seat, and the migrations it applied. */
					const readings = {
						installed: Effect.flatMap(seats.installed, (taken) =>
							Effect.map(
								migrationsApplied(
									Effect.provideService(
										tableState(taken.value, installedForm.relation),
										Substrate,
										taken.substrate
									)
								),
								([rows, count]) => {
									assert.deepEqual(rows, [], "the installed template's Owner holds no row")
									return count
								}
							)
						),
						seeded: Effect.flatMap(seats.seeded, (taken) =>
							Effect.map(
								migrationsApplied(
									Effect.provideService(
										tableState(taken.value, W.Account),
										Substrate,
										taken.substrate
									)
								),
								([rows, count]) => {
									assert.ok(rows.length > 0, "the seeded accounts")
									return count
								}
							)
						),
						fixture: Effect.flatMap(seats.fixture, (taken) =>
							Effect.map(
								migrationsApplied(
									Effect.flatMap(openedIn(W.Work, workFacts, commitInstall, taken), (opened) =>
										Effect.provideService(
											tableState(opened.installed, W.Account),
											Substrate,
											taken.substrate
										)
									)
								),
								([rows, count]) => {
									assert.equal(rows.length, workFacts.Account.length, "the loaded accounts")
									return count
								}
							)
						),
						family: Effect.flatMap(seats.family, (taken) =>
							Effect.map(
								migrationsApplied(familySeatIn("ordered", taken, "order ordered")),
								([seat, count]) => {
									assert.equal(seat.seat.lawsOf("family").length, 1, "the family's one law")
									return count
								}
							)
						),
						rig: Effect.flatMap(seats.rig, (taken) =>
							Effect.map(migrationsApplied(rigIn(taken, skew)), ([rig, count]) => {
								assert.equal(
									rig.installed.declared,
									taken.value.installed.declared,
									"the rig over the seat's installation"
								)
								return count
							})
						),
						world: Effect.flatMap(seats.world, (taken) =>
							Effect.map(
								migrationsApplied(templateWorld(taken, Option.none())),
								([world, count]) => {
									assert.ok(Rec.keys(world.names.tables).length > 0, "the world's installed tables")
									return count
								}
							)
						)
					}
					const applied = yield* readings[form]
					assert.equal(applied, 0, `a case over the ${form} template applied ${applied} migrations`)
					c.note(form)
				}),
		oracle: {
			kind: "specification",
			name: "a template's installation is applied by its build, once per member, never by a case over a clone of it"
		},
		box: "every template form the converted suites seat their cases on, three cases of each on a worker's seat",
		kept: [],
		kills: [
			{
				file: "test/pg/reads/support.ts",
				original: "\t\topenedOver(fixture, facts, options, taken.value),",
				replacement: "\t\tinstalled(fixture, facts, options),",
				why: "A fixture's seat opened as the converted read suites opened theirs before (lane TESTPERF): openedIn installs the fixture again in every case (reads/support.ts installed), and the fixture form's cases count its migration."
			},
			{
				file: "test/pg/fin/family.ts",
				original: "seatOfInstalled(taken.value, FAMILY_RELATIONS, label)",
				replacement: "seatOf(familySchema(shape), FAMILY_RELATIONS, label)",
				why: "A family's seat read as the converted fin suites read theirs before (lane TESTPERF): familySeatIn installs the shape's family again in every case (installed.ts seatOf), and the family form's cases count its migration."
			},
			{
				file: "test/support/schedules/rig.ts",
				original: "Effect.provideService(rigOver(taken.value, build), Substrate, taken.substrate)",
				replacement: "Effect.provideService(openRig(build), Substrate, taken.substrate)",
				why: "A schedule's rig opened as the converted schedules opened theirs before (lane TESTPERF): rigIn installs the schedule again in every case (rig.ts openRig), and the rig form's cases count its migration."
			}
		]
	})
