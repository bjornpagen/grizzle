/**
 * A key over numerics wider than a B-tree entry holds them by the digest of each one's one text, so numeric's equality
 * decides it: a `pg.numeric` key of numeric's widest integer, NaN or an infinity installs and keys, a respelling of a
 * stored value (1.5 as 1.50, NaN as nan) is the same key, a containment pairs equal numerics through their images, and
 * a key of six `pg.numeric(1000, 0)` fields past the item limit keys too.
 *
 * - **Property:** a case draws Parent rows of a drawn value, `n` and payload, Child rows naming a drawn (value, n), and
 *   Wide rows of six 1,000-digit integers. The served insertions write Parent, then Child, then Wide, each from its
 *   facts: an insertion is refused exactly where two of its rows share a key and differ, and otherwise Parent holds the
 *   distinct rows; Child's is refused exactly where a child names no stored parent's key. Then a direct writer's insert
 *   of a stored parent's value respelled, at its `n`, is refused by the key with SQLSTATE 23505.
 * - **Oracle:** the set model of each insertion over keys compared by each numeric's one text (the host's Decimal), and
 *   PostgreSQL's own unique violation on the respelled value.
 * - **Features:** each kind of drawn value, an insertion refused and accepted, a respelling refused, a containment met
 *   and broken, and wide keys accepted and refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result, String as Str } from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	caseGen,
	childrenContained,
	decimalOf,
	drawnFeatures,
	type KeyFeature,
	keysTemplate,
	parentModel,
	parentText,
	programsOf,
	respelled,
	wideModel,
	worldOf
} from "#test/pg/write/numeric-key/numeric-key.fixtures.ts"
import { writeOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const features = [
	"a parent of numeric's widest integer",
	"a parent of NaN",
	"a parent of an infinity",
	"parents refused at a shared key",
	"parents accepted",
	"a respelled key refused by its image",
	"children contained through images",
	"a child of no parent refused",
	"wide keys accepted, held by images",
	"wide keys refused at a shared key"
] as const satisfies ReadonlyArray<Reached<KeyFeature>>

/** A key over wide numerics holds them by their images, compared as numeric's equality compares them. */
export const aKeyOverWideNumericsHoldsThemByTheirImagesComparedAsNumericsEquality =
	property.explore(caseGen, {
		needs: Substrate.oneOf({ keys: keysTemplate }, Substrate.seat),
		situations: features,
		budget: { runs: 16, steered: features.length },
		check: (templates, notes: Case<KeyFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					for (const feature of drawnFeatures(c)) {
						notes.note(feature)
					}
					const taken = yield* templates.keys
					yield* Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const installed = taken.value.installed
							yield* loadMigrated(installed, { Parent: [], Child: [], Wide: [] })
							const world = worldOf(installed.declared)
							const s = quoteIdent(installed.schema)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared))
										const write = (name: string, facts: unknown) =>
											Effect.map(
												Effect.result(
													writeOnce(onceCalls(db, member(loaded.members, name)))(facts)
												),
												(answered): "accepted" | "unchanged" | "refused" => {
													if (Result.isFailure(answered)) {
														return answered.failure.kind === "refused"
															? "refused"
															: assert.fail(
																	`${name} answers: ${Formatter.format(answered.failure)}`
																)
													}
													return answered.success.kind === "accepted" ? "accepted" : "unchanged"
												}
											)
										const parents = parentModel(c)
										const parentOutcome = yield* write("insertParent", {
											params: {},
											facts: {
												insert: {
													Parent: Arr.map(c.parents, (p) => ({
														value: decimalOf(p.value),
														n: p.n,
														payload: p.payload
													}))
												}
											}
										})
										if (parents.kind === "refused") {
											notes.note("parents refused at a shared key")
											assert.equal(parentOutcome, "refused", "parents at a shared key differ")
											return
										}
										notes.note("parents accepted")
										assert.equal(parentOutcome, "accepted", "distinct parents are inserted")
										const stored = yield* substrate.admin.query(
											`SELECT "value"::text AS "value", "n", "payload" FROM ${s}."parent"`,
											[]
										)
										assert.deepEqual(
											Arr.sort(
												Arr.map(stored.rows, (r) =>
													parentText({
														value: String(r["value"]),
														n: Number(r["n"]),
														payload: Number(r["payload"])
													})
												),
												Order.String
											),
											Arr.sort(Arr.map(parents.rows, parentText), Order.String),
											"Parent holds the distinct rows, each value exactly"
										)
										const [first] = parents.rows
										if (first !== undefined) {
											const respelt = yield* Effect.result(
												substrate.admin.query(
													`INSERT INTO ${s}."parent" ("value", "n", "payload") VALUES ($1::numeric, $2, $3)`,
													[respelled(first.value), first.n, first.payload]
												)
											)
											assert.ok(
												Result.isFailure(respelt) &&
													pgErrorFields(respelt.failure)?.code === sqlstates.uniqueViolation,
												`a respelling of ${Str.slice(0, 20)(first.value)} is the stored key: ${Formatter.format(respelt)}`
											)
											notes.note("a respelled key refused by its image")
										}
										const contained = childrenContained(parents.rows, c)
										const childOutcome = yield* write("insertChild", {
											params: {},
											facts: {
												insert: {
													Child: Arr.map(c.children, (child) => ({
														id: child.id,
														value: decimalOf(child.value),
														n: child.n
													}))
												}
											}
										})
										if (contained) {
											if (c.children.length > 0) {
												notes.note("children contained through images")
											}
											assert.ok(
												childOutcome === "accepted" || childOutcome === "unchanged",
												`children of stored parents are inserted: ${childOutcome}`
											)
										} else {
											notes.note("a child of no parent refused")
											assert.equal(childOutcome, "refused", "a child of no parent is refused")
										}
										const wide = wideModel(c)
										const wideOutcome = yield* write("insertWide", {
											params: {},
											facts: {
												insert: {
													Wide: Arr.map(c.wide, (w) => ({
														a: w.fields[0],
														b: w.fields[1],
														c: w.fields[2],
														d: w.fields[3],
														e: w.fields[4],
														f: w.fields[5],
														payload: w.payload
													}))
												}
											}
										})
										if (wide.kind === "refused") {
											notes.note("wide keys refused at a shared key")
											assert.equal(wideOutcome, "refused", "wide rows at a shared key differ")
											return
										}
										notes.note("wide keys accepted, held by images")
										assert.equal(wideOutcome, "accepted", "distinct wide rows are inserted")
										const wideRows = yield* substrate.admin.query(
											`SELECT count(*)::integer AS "count" FROM ${s}."wide"`,
											[]
										)
										assert.equal(
											Number(wideRows.rows[0]?.["count"]),
											wide.rows.length,
											"Wide holds the distinct rows"
										)
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "postgresql",
			name: "the set model of each insertion over keys compared by each numeric's one text, and PostgreSQL's unique violation on a respelling"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: '\t\t\treturn textDigestForm(library, cast(call("trim_scale", [x]), types.text))',
				replacement: "\t\t\treturn textDigestForm(library, cast(x, types.text))",
				why: "A numeric's image is the digest of its text at its stored scale: 1.50 and 1.5 have two images, so a respelled key is admitted beside the stored one."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original: "\tkey: (imaged) => entryImage.key[imaged],",
				replacement: '\tkey: (imaged) => (imaged === "text" ? entryImage.key.text : undefined),',
				why: "A key holds no numeric by its image: Parent's key over a pg.numeric and Wide's six numeric(1000, 0) are UnrepresentableKey, and the template refuses to install."
			}
		]
	})
