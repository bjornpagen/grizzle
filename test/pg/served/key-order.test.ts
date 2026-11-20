/**
 * A declared call receives each argument by its name, and a row type each value at its attribute's name, whatever
 * order the declarations' records write their keys in: PostgreSQL reads a row type's attributes and a function's
 * parameters by position, and grizzle installs both in their names' code point order, so a body written once in that
 * order, as the README tells it, holds under every order sort-keys or a hand leaves a record in.
 *
 * - **Property:** a case draws an order of the keys of every record the declarations of key-order.fixtures.ts write
 *   (Single, a heading of nine integers named as QTI's single value's fields, the arguments of pack, of spread and of
 *   mix(iy, x, y)) and of every call the program writes (Fn.rows of spread, Fn.call of mix), and one to
 *   three seeds, each field a value of its own and iy, x and y distinct digits. It installs the declarations as
 *   `grizzle generate` drafts and serves them, stores the seeds, and runs `run`, which matches each seed, then the rows of
 *   spread at its values, spread's body calling pack positionally and pack's building a row of Single positionally, and
 *   finds each row's fields beside mix at the seed's iy, x and y, mix's body reading its parameters by number. Each seed
 *   answers one row, each of Single's fields the seed's value of the same name and mixed its x, y and iy as digits.
 * - **Oracle:** the specification: an argument is passed by its name and a row's field read by its name, so each comes
 *   back as the seed holds it.
 * - **Features:** a heading, an argument list and a call's arguments written out of their names' order, every record
 *   written in it, and several seeds.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import {
	caseGen,
	expectedTexts,
	factsOf,
	featuresOf,
	installationOf,
	type KeyOrderFeature,
	rowText,
	servedOf
} from "#test/pg/served/key-order.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce } from "#test/support/calls.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const features = [
	"a heading written out of its names' order",
	"an argument list written out of its names' order",
	"a call's arguments written out of their names' order",
	"every record written in its names' order",
	"several seeds"
] as const satisfies ReadonlyArray<Reached<KeyOrderFeature>>

/** A declared call receives each argument by its name, and a row each value by its field's, under every key order. */
export const aDeclaredCallReceivesEachArgumentByItsNameAndARowEachValueByItsFieldsUnderEveryKeyOrder =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: features,
		budget: { runs: 8, steered: features.length },
		check:
			({ substrate }, notes: Case<KeyOrderFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						for (const feature of featuresOf(c)) {
							notes.note(feature)
						}
						const generated = yield* installGenerated(installationOf(c.orders), {
							label: "key_order",
							ambient: ordinarySession
						})
						const installed = generated.installed
						yield* loadMigrated(installed, factsOf(c))
						const served = servedOf(c.orders, installed.declared)
						yield* withServedDb(
							installed,
							served.world.server.roles.app,
							{},
							({ ctx: db, loadWithTables }) =>
								Effect.gen(function* () {
									const loaded = yield* loadWithTables(served.programs)
									const run = member(loaded.members, "run")
									const answered = yield* Effect.result(
										readOnce(onceCalls(db, run))({ params: {}, facts: {} })
									)
									if (Result.isFailure(answered)) {
										return assert.fail(`the program answers: ${Formatter.format(answered.failure)}`)
									}
									assert.deepEqual(
										Arr.sort(Arr.map(answered.success, rowText), Order.String),
										Arr.sort(expectedTexts(c), Order.String),
										"each seed's row holds each of its values under its own name"
									)
								})
						)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "an argument passed by its name and a row's field read by its name come back as the seed holds them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/function.ts",
				original: "\tconst heading = byName(fields).map(",
				replacement: "\tconst heading = Object.entries(fields).map(",
				why: "Single's attributes install in its record's key order, so pack's ROW(b, base, ...) puts each value at another field."
			},
			{
				file: "packages/engine/src/schema/function.ts",
				original: "\t\t\tbyName(args).map(([arg, type]) => ({",
				replacement: "\t\t\tObject.entries(args).map(([arg, type]) => ({",
				why: "A function's parameters install in its args' key order, so spread's call pack(b, base, ...) and mix's $1 read other arguments."
			}
		]
	})
