import { assert, containsEqual, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	applyCase,
	expected,
	guests,
	Hold,
	keyOf,
	notes,
	requestedOf,
	Room,
	rooms,
	rowOf,
	same,
	sameKey,
	situations,
	spanCaseGen,
	type SpanFeature,
	Spans,
	unique,
	spansInstall,
	spansTemplate
} from "#test/pg/write/span-key/span-key.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Inserts and puts into a span primary key agree with the interval model on drawn states and ChangeSets, both mutabilities and member forms.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/write/span-key/span-key.test.ts at 991e0f9ab).
 */
export const insertsAndPutsIntoASpanPrimaryKeyAgreeWithTheIntervalModelOnDrawnStatesAndChangeSetsBothMutabilitiesAndMemberForms =
	property.explore(spanCaseGen, {
		needs: { fixture: Substrate.seat(spansTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<SpanFeature>>,
		check:
			({ fixture }, cx: Case<SpanFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Spans, {}, spansInstall, taken)
								const s = yield* Substrate
								const names = namesOf(o.installed)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})

									const R = c.relation === "Room" ? Room : Hold
									const table = names.table(R)
									const stored = c.stored
									const requested = unique(Arr.map(c.requested, (r) => requestedOf(stored, r)))
									const payload =
										c.relation === "Room" ? names.column(Room, "guest") : names.column(Hold, "note")
									yield* replaceRows(
										s.admin,
										installationGroup(names),
										Arr.map(stored, (f) => ({
											sql: `INSERT INTO ${table} (${names.column(R, "room")}, ${names.column(R, "during")}, ${payload}) VALUES ($1::uuid, pg_catalog.int8range($2::int8, $3::int8), $4::text::${c.relation === "Room" ? "uuid" : "text"})`,
											params: [
												rooms[f.room],
												String(f.start),
												String(f.end),
												c.relation === "Room" ? guests[f.payload] : notes[f.payload]
											]
										}))
									)
									const outcome = yield* applyCase(db, c, requested)
									const want = expected(c.op, stored, requested)
									const state = yield* tableState(o.installed, R)
									cx.note(`${c.op} ${c.relation}`)
									cx.note(`${c.op} ${c.form}`)
									if (want.kind === "refused") {
										if (outcome.kind !== "refused") {
											return assert.fail(`a refusal by the span key, not ${outcome.kind}`)
										}
										assert.deepEqual(refusedLaws(outcome.refused), [
											names.described(names.primaryKeyLaw(R))
										])
										const witness = outcome.witness
										if (witness.kind !== "key") {
											return assert.fail(`a witness key, not ${witness.kind}`)
										}
										assert.equal(witness.relation, c.relation)
										containsEqual(Arr.map(want.witnesses, keyOf), witness.values)
										unorderedEqual(
											state,
											Arr.map(stored, (f) => rowOf(c.relation, f))
										)
										cx.note(
											`${c.op} ${want.within ? "within the ChangeSet" : "over a stored fact"}`
										)
										if (c.op === "put" && !want.within) {
											cx.note("put over a stored overlap at another key")
										}
										return
									}
									unorderedEqual(
										state,
										Arr.map(want.final, (f) => rowOf(c.relation, f))
									)
									if (want.changed === 0) {
										assert.equal(outcome.kind, "unchanged")
										cx.note(`${c.op} unchanged`)
										return
									}
									if (outcome.kind !== "accepted") {
										return assert.fail(`accepted, not ${outcome.kind}`)
									}
									assert.deepEqual(
										Arr.map(outcome.counts, (n) => ({ ...n })),
										[
											{
												relation: c.relation,
												added: c.op === "insert" ? BigInt(want.changed) : 0n,
												deleted: 0n,
												put: c.op === "put" ? BigInt(want.changed) : 0n
											}
										]
									)
									cx.note(`${c.op} accepted`)
									if (
										c.op === "insert" &&
										Arr.some(requested, (f) =>
											Arr.some(
												stored,
												(g) => f.room === g.room && (f.start === g.end || f.end === g.start)
											)
										)
									) {
										cx.note("insert of an adjacent span accepted")
									}
									if (
										c.op === "put" &&
										Arr.some(requested, (f) =>
											Arr.some(stored, (g) => sameKey(f, g) && !same(f, g))
										)
									) {
										cx.note("put replaces a stored payload")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a host interval model of the span key over the stored and requested facts"
		},
		budget: { runs: 80, steered: 80 },
		kept: [],
		kills: []
	})
