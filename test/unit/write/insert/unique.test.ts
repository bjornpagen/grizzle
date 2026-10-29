import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { recordsetMaxRows } from "#compiler/core/policy.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { key, relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { lawIdOf } from "#test/support/kernel/naming.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"
import { writeNamesOf } from "#test/unit/write/insert/support.ts"

/** The host's refusal of overlapping additions under a span candidate key: two enumerated additions
 * whose spans overlap at equal scalars are refused before any SQL, with the key's law; adjacent spans, and overlapping
 * spans at other scalars, are admitted. */
const Booking = relation(
	"Booking",
	{ id: pg.integer, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)
const bookingSpan = key(Booking, ["room", "during"])
const U = schema("U", { Booking }, [bookingSpan, key(Booking, ["ref"])])
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
			derived: artifacts.derived
		})
	)
const cs = () => ChangeSet.empty(U)

/** The value's program bound to its members, as the runtime collects them. */
const bind = Effect.fn("bind")(function* (value: ReturnType<typeof cs>) {
	const p = program(value)
	const members = yield* collectInputs(p.frontend, parsedOf(value).inputs, recordsetMaxRows)
	return succeeded(bindWrite(p, { members, params: {} }))
})

describe("host normalization of a span candidate key", () => {
	it.effect("refuses two additions whose spans overlap at equal scalars, before any SQL", () =>
		Effect.gen(function* () {
			const bound = yield* bind(
				cs().insert(Booking, [
					{ id: 1, room: 1, during: { start: 0, end: 10 }, ref: 1 },
					{ id: 2, room: 1, during: { start: 5, end: 15 }, ref: 2 }
				])
			)
			assert.equal(bound.kind, "invariant-rejected")
			assertVariant(bound, "kind", "invariant-rejected")
			assert.equal(bound.law, lawIdOf(U, bookingSpan))
			assert.deepEqual(bound.witness, {
				kind: "key",
				relation: "Booking",
				values: { room: 1, during: { start: 5, end: 15 } }
			})
		})
	)

	it.effect("admits adjacent spans and overlapping spans in other rooms", () =>
		Effect.gen(function* () {
			const bound = yield* bind(
				cs().insert(Booking, [
					{ id: 1, room: 1, during: { start: 0, end: 10 }, ref: 1 },
					{ id: 2, room: 1, during: { start: 10, end: 15 }, ref: 2 },
					{ id: 3, room: 2, during: { start: 5, end: 15 }, ref: 3 }
				])
			)
			assert.equal(bound.kind, "bound")
		})
	)
})
