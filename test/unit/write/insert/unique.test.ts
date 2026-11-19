/**
 * The host's refusal of overlapping additions under a span candidate key, against a host interval model: enumerated
 * additions, each a booking of a room over a half-open span, are refused before any SQL with the span key's law exactly
 * when two of them hold one room over overlapping spans, the witness one of those facts' key at the span key's fields;
 * adjacent spans, and overlapping spans in other rooms, are admitted. Every booking has an id and a reference of its
 * own, so the primary key and the plain candidate key never decide.
 *
 * Features: overlapping spans in one room refused, adjacent spans in one room admitted, overlapping spans in two rooms
 * admitted.
 */

import { assert, assertVariant, deepEquals } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { lawIdOf } from "#test/support/kernel/naming.ts"
import {
	bind,
	bookedGen,
	Booking,
	bookingSpan,
	clash,
	U,
	type UniqueFeature
} from "#test/unit/write/insert/unique.fixtures.ts"

/**
 * Host normalization of a span candidate key refuses additions exactly when two hold one room over overlapping spans,
 * before any SQL.
 *
 * Budget: 300 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/write/insert/unique.test.ts:94 at 8cad5bce, its runs and its coverage's cases).
 */
export const hostNormalizationOfASpanCandidateKeyRefusesAdditionsExactlyWhenTwoHoldOneRoomOverOverlappingSpansBeforeAnySQL =
	property.explore(array(bookedGen, { min: 1, max: 4 }), {
		needs: {},
		budget: { runs: 300, steered: 200 },
		situations: [
			"overlapping spans in one room refused",
			"adjacent spans in one room admitted",
			"overlapping spans in two rooms admitted"
		] satisfies ReadonlyArray<Reached<UniqueFeature>>,
		check: (_, c: Case<UniqueFeature>) => (bookings) =>
			Effect.gen(function* () {
				const facts = Arr.map(bookings, (b, i) => ({
					id: i + 1,
					room: b.room,
					during: { start: b.start, end: b.end },
					ref: i + 1
				}))
				const pairs = Arr.flatMap(bookings, (a, i) =>
					Arr.map(bookings.slice(i + 1), (b) => [a, b] as const)
				)
				const clashing = Arr.filter(bookings, (a, i) =>
					Arr.some(bookings, (b, j) => i !== j && clash(a, b))
				)
				const bound = yield* bind(ChangeSet.empty(U).insert(Booking, facts))
				if (clashing.length === 0) {
					assertVariant(bound, "kind", "bound", "no two bookings of one room overlap")
					if (
						Arr.some(
							pairs,
							([a, b]) => a.room === b.room && (a.end === b.start || b.end === a.start)
						)
					) {
						c.note("adjacent spans in one room admitted")
					}
					if (
						Arr.some(pairs, ([a, b]) => a.room !== b.room && a.start < b.end && b.start < a.end)
					) {
						c.note("overlapping spans in two rooms admitted")
					}
					return
				}
				c.note("overlapping spans in one room refused")
				assertVariant(bound, "kind", "invariant-rejected", "two bookings of one room overlap")
				assert.equal(bound.law, lawIdOf(U, bookingSpan))
				const witness = bound.witness
				assert.ok(
					Arr.some(clashing, (b) =>
						deepEquals(witness, {
							kind: "key",
							relation: "Booking",
							values: { room: b.room, during: { start: b.start, end: b.end } }
						})
					),
					"the witness is one overlapping booking's key at the span key's fields"
				)
			}),
		oracle: { kind: "specification", name: "a host interval model of the span key" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/normalize.ts",
				original: "\t\t\t\tif (reach !== undefined && position(value.start) < reach) {",
				replacement: "\t\t\t\tif (reach !== undefined && position(value.start) <= reach) {",
				why: "Adjacent spans in one room taken to overlap (runtime/write/normalize.ts, a span starting at the reach refused)."
			},
			{
				file: "packages/engine/src/runtime/write/normalize.ts",
				original: "\t\t\t\tif (reach === undefined || position(value.end) > reach) {",
				replacement: "\t\t\t\tif (reach === undefined) {",
				why: "The reach kept at the first span's end, never moved past it, so a span overlapping a later, longer one is admitted."
			}
		]
	})
