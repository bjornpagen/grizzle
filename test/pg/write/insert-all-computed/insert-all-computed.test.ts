/**
 * pantry's publish computing `package` from its one parameter stores what insertAll stores with the field stated, on
 * PostgreSQL 19: ChangeSet.insertAllComputed inserts every relation its record names, each row leaving out the field
 * the call computes (write/changeset/value.ts addInsertsComputed), its documents' tokens nested in order, its cell
 * trees' nodes nested under their roots and its documents' counted attributes copying their titles, each nested or
 * counted row holding its owner's computed value (write/frontend/compile.ts FreshFill, write/family/nesting.ts
 * carriedStamps). Publish holds Doc(package, id, title) nesting Token(package, id, at, text) at `tokens` and counting
 * Attr(package, id, name, title) at `attrs`, Attr's title its document's; Cell, a tree per package and root, each node
 * counting its Marks, facts of their own, folded into its weight, which Marked holds to a mark, as pantry's Node counts
 * its Attributes into attrs and AL3 holds them to what its governor requires; Note, one a call to each (package, id)
 * at the place its insert stamps, which Weighed holds to a weight; and Ref, a plain relation. Its full world's login
 * serves `computed`, insertAllComputed of Doc, Attr, Cell, Mark, Note and Ref under the parameter `package`, and
 * `stated`, insertAll of the same relations; the schema is installed as `grizzle generate` drafts it, once per member,
 * each case on a clone of that installation of its own.
 *
 * Property, per case: a package's content, its documents with their tokens and attributes, its cell trees and their
 * marks and its refs, published as `a` by `computed`, its rows leaving `package` out, and as `b` by `stated`, its rows
 * stating it: both calls are accepted, or unchanged where the package holds nothing, and every table holds the same rows
 * at `a` as at `b`, `package` aside; or, where a node lacks its mark or a note its weight, both are refused, each
 * witnessed by the row the stated one names, its whole key, the computed call's at the package its parameter computed:
 * the host evaluates each computed field's term over the call (runtime/write/bind.ts computedValues), so the rows it
 * judges hold it; and a note's place, which its insert stamps and no host value holds, is named as drawn by its place
 * (Witness `drawn`), never `unreported`. qti-pie's choice package with one item's required title removed was refused
 * by AL3 with the witness `unreported`, no row the host held holding a `package`. Oracle: insertAll with the field
 * stated, a second implementation of the same rows and the same refusal. Kills: the nested rows' carried stamp
 * dropped, so a token, a cell's child and an attribute miss their owner's package and the call is refused at bind; the
 * computed field left out of the rows the host judges, so the computed call's refusal is witnessed `unreported`; a key
 * the database draws a field of unreported, as before.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	type ContentFeature,
	contentFeatures,
	contentGen,
	factsOf,
	fieldsOf,
	isEmpty,
	isUnweighed,
	Publish,
	publishInstall,
	publishTemplate,
	situations,
	unmarkedOf
} from "#test/pg/write/insert-all-computed/insert-all-computed.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
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
								/** A publish of nothing changes nothing; one leaving a node unmarked is refused by Marked; any other is
								 * accepted. */
								const unmarked = unmarkedOf(c)
								const refused = unmarked !== undefined || isUnweighed(c)
								const answered = refused ? "refused" : isEmpty(c) ? "unchanged" : "accepted"
								assert.equal(computed.kind, answered, `computed: ${Formatter.format(computed)}`)
								const stated = yield* writeAnswerOf(
									db.workload.stated.once({
										params: {},
										facts: { insert: factsOf(c, { package: "b" }) }
									})
								)
								assert.equal(stated.kind, answered, `stated: ${Formatter.format(stated)}`)
								if (refused) {
									const statedWitness = "witness" in stated ? stated.witness : undefined
									const computedWitness = "witness" in computed ? computed.witness : undefined
									/** A witness at the computed publish's package: the key it names, its package `a`. */
									const atA = (w: typeof statedWitness): typeof statedWitness =>
										w === undefined || w.kind === "unreported" || w.kind === "unreproduced"
											? w
											: { ...w, values: { ...w.values, package: "a" } }
									assert.deepEqual(
										computedWitness,
										atA(statedWitness),
										`computed: the refusal names the row the stated one names, by its whole key, the package the call computed in it`
									)
									assert.ok(
										statedWitness !== undefined &&
											statedWitness.kind !== "unreported" &&
											computedWitness !== undefined &&
											computedWitness.kind !== "unreported",
										`a refusal by Marked or Weighed names its row, its place named as drawn: ${Formatter.format({ stated, computed })}`
									)
									if (unmarked !== undefined && !isUnweighed(c)) {
										assert.deepEqual(
											computedWitness,
											{
												kind: "key",
												relation: "Cell",
												values: { package: "a", root: unmarked.root, start: unmarked.start }
											},
											`computed: Marked's refusal names the unmarked node, ${Formatter.format(computed)}`
										)
									}
									if (unmarked === undefined) {
										assert.deepEqual(
											computedWitness,
											{
												kind: "drawn",
												relation: "Note",
												values: { package: "a", id: BigInt(c.notes.indexOf(0n)) },
												drawn: { n: "place" }
											},
											`computed: Weighed's refusal names the note by its group, its place drawn by its insert, ${Formatter.format(computed)}`
										)
									}
									return
								}
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
								for (const table of ["Doc", "Token", "Attr", "Cell", "Mark", "Note", "Ref"]) {
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
			name: "insertAll of the same rows, every one stating its package, its rows and its refusal's witness"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/insert-all-computed/insert-all-computed.test.ts#aPublishComputingItsPackageFromItsOneParameterStoresWhatInsertAllStoresWithTheFieldStated:ff.1:1.0.1.0.0.0.0.1"
				),
				reason:
					"qti-pie's choice package with one item's required title removed, cut down: one cell tree of one node, its one mark left out. Marked refused both publishes and the host found the node, `every`, but the computed publish's witness was `unreported`, since no row the host judged held the `package` the call computes, as AL3's refusal of pantry's import named no row (QP-PUBFACTS after 7a2243f8, main's ruling on the open witness)",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/pg/write/insert-all-computed/insert-all-computed.test.ts#aPublishComputingItsPackageFromItsOneParameterStoresWhatInsertAllStoresWithTheFieldStated:ff.2:1.0.0.0.1.1.0"
				),
				reason:
					"One note of weight 0, which Weighed refuses: its key's place is its insert's to stamp and no host value holds it, so both publishes' refusals were witnessed `unreported` (README's `a row whose key PostgreSQL draws`), where main's ruling names the note by its group and its place as drawn",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/family/nesting.ts",
				original:
					'\t\tif (stamp.kind === "call") {\n\t\t\treturn carriers.map((field) => ({ field, stamp }))\n\t\t}\n',
				replacement: '\t\tif (stamp.kind === "call") {\n\t\t\treturn []\n\t\t}\n',
				why: "A nested member no longer carries its owner's computed package: a token and a cell's child state no package and hold none, so the publish is refused, or stores them apart from what insertAll stores."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\tconst value = calls.values.get(name) ?? held(columnKeyOf(name))",
				replacement: "\t\t\t\t\tconst value = held(columnKeyOf(name))",
				why: "The rows the host judges hold none of the fields the call computes, as before main's ruling on QP-PUBFACTS' open witness: no unmarked node's key is whole, and the computed publish's refusal by Marked is witnessed `unreported`, where the stated one's names the node."
			},
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original:
					"\t\tif (named) {\n\t\t\treturn drawnWitness(relation.name, values, drawn)\n\t\t}",
				replacement: "\t\tif (named) {\n\t\t\treturn unreported\n\t\t}",
				why: "A key a field of which the database draws names no row, as before main's ruling: Weighed's refusal of a note, whose place its insert stamps, is witnessed `unreported`, where its group's values and its drawn place name it."
			}
		]
	})
