/** What the properties of unique.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { writeNamesOf } from "#test/unit/write/insert/support.ts"

/** Booking(id, room, during, ref): a room held over a span, keyed by id. */
export const Booking = relation(
	"Booking",
	{ id: pg.integer, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)

export const bookingSpan = key(on(Booking, "room", "during"))

export const U = schema("U", [Booking], [bookingSpan, key(on(Booking, "ref"))])

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
			level: "serializable",
			clock: noClock,
			source: transactionClock
		})
	)

/** The value's program bound to its members, as the runtime collects them. */
export const bind = Effect.fn("bind")(function* (value: ReturnType<typeof ChangeSet.empty>) {
	const p = program(value)
	const members = yield* collectInputs(p.binding.groups, parsedOf(value).inputs)
	return succeeded(
		bindWrite(flightOf(servableWrite(p), p.frontend.codes, noAdvice), {
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

export const bookedGen: Gen<Booked> = (source) => {
	const start = source.draw(int(0, 6))
	return { room: source.draw(int(1, 2)), start, end: source.draw(int(start + 1, 8)) }
}

/** Two bookings of one room over spans that share a point: [a, b) and [c, d) with a < d and c < b. */
export const clash = (a: Booked, b: Booked): boolean =>
	a.room === b.room && a.start < b.end && b.start < a.end

export type UniqueFeature =
	| "overlapping spans in one room refused"
	| "adjacent spans in one room admitted"
	| "overlapping spans in two rooms admitted"
