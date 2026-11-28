/**
 * A family's members carrying bytes, on PostgreSQL 19: an owner of a bytes value of its own, which its nested write
 * admits once for the owner's row and once for its own insert, is inserted with members nested in order, each
 * member's bytes value empty, short, or one short of, at or one past a chunk of the delivery in force
 * (bytesChunkLength), or of several chunks; then one member is deleted, which re-places every later
 * sibling: grizzle's removals statement re-places each later member in SQL, its bytes value read and written again
 * whole by PostgreSQL.
 * Every member reads back at its slot with its bytes, before and after.
 *
 * Oracle: the drawn values, in slot order, less the one deleted.
 *
 * Features: the vocabulary Feature below, each member value's length class about a chunk.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	type Drawn,
	type Feature,
	Files,
	notes,
	sameBytes,
	space,
	streamBytes,
	filesInstall,
	filesTemplate
} from "#test/pg/fields/bytes-family.fixtures.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** A family's bytes members read their stored suffix in chunks and write each re-placed member's bytes whole. */
export const aFamilysBytesMembersReadTheirStoredSuffixInChunksAndWriteEachRePlacedMembersBytesWhole =
	property.explore(space, {
		needs: { fixture: Substrate.fresh(filesTemplate) },
		situations: [
			"the first member deleted",
			"the last member deleted",
			"a member re-placed",
			"a re-placed member of an empty value",
			"a re-placed member of a chunk or more",
			"a re-placed member of several chunks"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/**
		 * Its pre-conversion runs, 12 (bytes-family.test.ts at 4fbc3e95), and the steered cases its witnesses need: the
		 * floor and 2 steered cases reach every required situation, 1 leaves a member re-placed unreached (measured at
		 * TEST_SEED=1 on grizzle 01506d52; the witnesses are fixed by the property's identity). The old suite ran 4
		 * coverage cases at that seed; 12 ran 27 cases a run.
		 */
		budget: { runs: 12, steered: 2 },
		check:
			({ fixture }, c: Case<Feature>) =>
			(d: Drawn) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const o = yield* openedIn(Files, {}, filesInstall, taken)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const owner = uuidOf(1)
									const members = Arr.map(d.values, (x, i) => ({
										id: uuidOf(100 + i),
										body: streamBytes(x.length, x.seed)
									}))
									const badge = streamBytes(d.values.length + 3, 7)
									const inserted = yield* writeAnswerOf(
										db.workload.insertOwner.once({
											params: {},
											facts: { insert: { Owner: [{ id: owner, badge, members }] } }
										})
									)
									assert.equal(inserted._tag, "accepted", "the owner and its members are written")
									const owners = yield* rowsOf(db.workload.owners.once({ params: {}, facts: {} }))
									assert.ok(
										owners.length === 1 && sameBytes(defined(owners[0], "the owner").badge, badge),
										"the owner's own bytes, admitted with its nested members, read back whole"
									)
									const bySlot = Order.mapInput(
										Order.BigInt,
										(row: { readonly at: bigint }) => row.at
									)
									const readBack = (expected: ReadonlyArray<(typeof members)[number]>) =>
										Effect.gen(function* () {
											const collected = yield* rowsOf(
												db.workload.members.once({ params: {}, facts: {} })
											)
											const rows = Arr.sort(collected, bySlot)
											assert.equal(rows.length, expected.length, "every member reads back")
											for (const [i, [row, member]] of Arr.zip(rows, expected).entries()) {
												assert.equal(row.at, BigInt(i), "a member reads back at its slot")
												assert.equal(row.id, member.id, "the member at its slot")
												assert.ok(
													sameBytes(row.body, member.body),
													"a member's bytes read back whole"
												)
											}
										})
									yield* readBack(members)
									const cut = defined(members[d.cut], "the member deleted")
									const deleted = yield* writeAnswerOf(
										db.workload.deleteMember.once({
											params: {},
											facts: { delete: { Member: [{ id: cut.id, owner, body: cut.body }] } }
										})
									)
									assert.equal(deleted._tag, "accepted", "the member is deleted")
									yield* readBack(Arr.filter(members, (m) => m.id !== cut.id))
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.served.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the drawn values in slot order, less the one deleted"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/delivery.ts",
				original: "\t\tconst offset = Number(rowText(row, chunkAt)) * chunkLength",
				replacement: "\t\tconst offset = Number(rowText(row, chunkAt)) * (chunkLength - 1)",
				why: "A delivered chunk is written at the wrong offset, so a member's bytes past its first chunk read back wrong."
			}
		]
	})
