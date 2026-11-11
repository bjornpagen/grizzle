import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, deepEquals, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { lawIdOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"
import { writeNamesOf } from "#test/unit/write/insert/support.ts"

/** The host's refusal of overlapping additions under a span candidate key, against a host interval model: enumerated
 * additions, each a booking of a room over a half-open span, are refused before any SQL with the span key's law exactly
 * when two of them hold one room over overlapping spans, the witness one of those facts' key at the span key's fields;
 * adjacent spans, and overlapping spans in other rooms, are admitted. Every booking has an id and a reference of its
 * own, so the primary key and the plain candidate key never decide. */
const Booking = relation(
	"Booking",
	{ id: pg.integer, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)
const bookingSpan = key(on(Booking, "room", "during"))
const U = schema("U", { Booking }, [bookingSpan, key(on(Booking, "ref"))])
const names = writeNamesOf(U, "u")

const artifacts = succeeded(testArtifacts(U, testCompile))

const program = (changes: unknown): CompiledWrite =>
	succeeded(
		compileWrite(checking(U), descOf(changes), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable"
		})
	)

/** The value's program bound to its members, as the runtime collects them. */
const bind = Effect.fn("bind")(function* (value: ReturnType<typeof ChangeSet.empty>) {
	const p = program(value)
	const members = yield* collectInputs(p.binding.groups, parsedOf(value).inputs)
	return succeeded(
		bindWrite(runnableWrite(p, p.frontend.codes), {
			members,
			params: {},
			transport: inForce(bindFrame)
		})
	)
})

interface Booked {
	readonly room: number
	readonly start: number
	readonly end: number
}

const bookedGen: Gen<Booked> = (source) => {
	const start = source.draw(int(0, 6))
	return { room: source.draw(int(1, 2)), start, end: source.draw(int(start + 1, 8)) }
}

/** Two bookings of one room over spans that share a point: [a, b) and [c, d) with a < d and c < b. */
const clash = (a: Booked, b: Booked): boolean =>
	a.room === b.room && a.start < b.end && b.start < a.end

type UniqueFeature =
	| "overlapping spans in one room refused"
	| "adjacent spans in one room admitted"
	| "overlapping spans in two rooms admitted"

describe("host normalization of a span candidate key", () => {
	it.effect(
		"refuses additions exactly when two hold one room over overlapping spans, before any SQL",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/insert/span-unique",
						draw: drawn(array(bookedGen, { min: 1, max: 4 })),
						literal: Formatter.format,
						coverage: required<UniqueFeature>(
							[
								"overlapping spans in one room refused",
								"adjacent spans in one room admitted",
								"overlapping spans in two rooms admitted"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "a host interval model of the span key" }
					},
					(bookings, c) =>
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
									Arr.some(
										pairs,
										([a, b]) => a.room !== b.room && a.start < b.end && b.start < a.end
									)
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
						})
				)
			)
	)
})
