/**
 * pantry's publish computing `package` from its one parameter stores what insertAll stores with the field stated, on
 * PostgreSQL 19: ChangeSet.insertAllComputed inserts every relation its record names, each row leaving out the field
 * the call computes (write/changeset/value.ts addInsertsComputed), its documents' tokens nested in order, its cell
 * trees' nodes nested under their roots and its documents' counted attributes copying their titles, each nested or
 * counted row holding its owner's computed value (write/frontend/compile.ts FreshFill, write/family/nesting.ts
 * carriedStamps). Publish holds Doc(package, id, title) nesting Token(package, id, at, text) at `tokens` and counting
 * Attr(package, id, name, title) at `attrs`, Attr's title its document's; Cell, a tree per package and root; and Ref, a
 * plain relation. Its full world's login serves `computed`, insertAllComputed of Doc, Attr, Cell and Ref under the
 * parameter `package`, and `stated`, insertAll of the same relations; the schema is installed as `grizzle generate`
 * drafts it, once per member, each case on a clone of that installation of its own.
 *
 * Property, per case: a package's content, its documents with their tokens and attributes, its cell trees and its refs,
 * published as `a` by `computed`, its rows leaving `package` out, and as `b` by `stated`, its rows stating it: both calls
 * are accepted, or unchanged where the package holds nothing, and every table holds the same rows at `a` as at `b`, `package` aside. Oracle: insertAll with the field
 * stated, a second implementation of the same rows. Kill: the nested rows' carried stamp dropped, so a token, a cell's
 * child and an attribute miss their owner's package and the call is refused at bind.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	type ContentFeature,
	contentFeatures,
	contentGen,
	factsOf,
	fieldsOf,
	isEmpty,
	Publish,
	publishInstall,
	publishTemplate,
	situations
} from "#test/pg/write/insert-all-computed/insert-all-computed.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** pantry's publish computing `package` from its one parameter stores what insertAll stores with the field stated. */
export const aPublishComputingItsPackageFromItsOneParameterStoresWhatInsertAllStoresWithTheFieldStated =
	property.explore(contentGen, {
		needs: { fixture: Substrate.fresh(publishTemplate) },
		situations,
		check:
			({ fixture }, k: Case<ContentFeature>) =>
			(c) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							k.noteAll(contentFeatures(c))
							const s = yield* Substrate
							const o = yield* openedIn(Publish, {}, publishInstall, taken)
							const names = o.installed.installation.names
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const computed = yield* writeAnswerOf(
									db.workload.computed.once({
										params: { package: "a" },
										facts: { insert: factsOf(c, {}) }
									})
								)
								/** A publish of nothing changes nothing; any other is accepted. */
								const answered = isEmpty(c) ? "unchanged" : "accepted"
								assert.equal(computed.kind, answered, `computed: ${Formatter.format(computed)}`)
								const stated = yield* writeAnswerOf(
									db.workload.stated.once({
										params: {},
										facts: { insert: factsOf(c, { package: "b" }) }
									})
								)
								assert.equal(stated.kind, answered, `stated: ${Formatter.format(stated)}`)
								/** A table's rows at a package, each column's text but `package`, in one order. */
								const rowsAt = (table: string, at: string) =>
									Effect.map(
										s.admin.queryValues(
											`SELECT ${Arr.join(
												Arr.map(
													fieldsOf[table] ?? [],
													(f) => `${quoteIdent(names.column(table, f))}::text`
												),
												", "
											)} FROM ${printObjectName(names.relation(table))} WHERE ${quoteIdent(names.column(table, "package"))} = $1`,
											[at]
										),
										(rows) =>
											Arr.sort(
												Arr.map(rows, (row) => Arr.join(Arr.map(Arr.drop(row, 1), String), " ")),
												Order.String
											)
									)
								for (const table of ["Doc", "Token", "Attr", "Cell", "Ref"]) {
									const atComputed = yield* rowsAt(table, "a")
									const atStated = yield* rowsAt(table, "b")
									assert.deepEqual(
										atComputed,
										atStated,
										`${table} holds at a, its package computed, what it holds at b, its package stated`
									)
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "insertAll of the same rows, every one stating its package"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/family/nesting.ts",
				original:
					'\t\tif (stamp.kind === "call") {\n\t\t\treturn carriers.map((field) => ({ field, stamp }))\n\t\t}\n',
				replacement: '\t\tif (stamp.kind === "call") {\n\t\t\treturn []\n\t\t}\n',
				why: "A nested member no longer carries its owner's computed package: a token and a cell's child state no package and hold none, so the publish is refused, or stores them apart from what insertAll stores."
			}
		]
	})
