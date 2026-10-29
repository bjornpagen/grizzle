import { describe, it } from "@effect/vitest"
import { Array as Arr, Option, String as Str } from "effect"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import {
	type Installation,
	compileInstallation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { owning } from "#test/support/policy.ts"

const install = (s: unknown, extensions: ReadonlyArray<InstallExtension>) => {
	const owned = owning(s)
	return compileInstallation(owned, { ...installOptions(owned, "owner"), extensions })
}

const installed = (s: unknown, extensions: ReadonlyArray<InstallExtension>): Installation => {
	const r = install(s, extensions)
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/** A relation whose span is part of its key: its WITHOUT OVERLAPS index serves a span predicate. */
const Booking = relation("Booking", { room: uuid, during: span(pg.bigint), guest: uuid }, [
	"room",
	"during"
])

/** The workload extension of `programs` over `s`, planned as the generator plans it. */
const workloadOf = (s: unknown, programs: object): InstallExtension =>
	workloadExtension(
		succeeded(
			compileTestWorkload(
				[{ login: "server", workloads: [workload(s, programs)] }],
				s,
				testCompile
			),
			"the workload plans"
		)
	)

const keysOf = (x: PlannedIndex) => Arr.map(x.keys, (k) => k.field)

describe("GiST span indexes of workload programs", () => {
	const Visit = relation(
		"Visit",
		{ id: uuid, room: uuid, during: span(pg.bigint), n: pg.integer },
		["id"]
	)
	const S = schema("V", { Visit, Booking }, [])
	const Visits = schema("V", { Visit }, [])
	/** Each relation's rows of one room meeting a window: `room = $room AND during && $w`. */
	const visitsInRoom = query(S).rule((r) => {
		const { id, during } = v(Visit)
		return r
			.match(Visit, { id, room: r.param("room", Visit.fields.room), during })
			.where(r.allen(during, ALLEN.intersects, r.param("w", Visit.fields.during)))
			.find({ id })
	})
	const bookingsInRoom = query(S).rule((r) => {
		const { during, guest } = v(Booking)
		return r
			.match(Booking, { room: r.param("room", Booking.fields.room), during, guest })
			.where(r.allen(during, ALLEN.intersects, r.param("w", Booking.fields.during)))
			.find({ guest })
	})
	/** The visits meeting a window, in any room: `during && $w`. */
	const visitsInWindow = query(Visits).rule((r) => {
		const { id, during } = v(Visit)
		return r
			.match(Visit, { id, during })
			.where(r.allen(during, ALLEN.intersects, r.param("w", Visit.fields.during)))
			.find({ id })
	})

	it("creates GiST (room, during) with btree_gist where no key serves it, and reuses a span key's index", () => {
		const i = installed(S, [workloadOf(S, { visitsInRoom, bookingsInRoom })])
		const created = Arr.filter(i.indexes, (x) => x.index.kind === "created")
		assert.deepEqual(
			Arr.map(created, (x) => [x.relation, x.method, keysOf(x)]),
			[["Visit", "gist", ["room", "during"]]]
		)
		assert.ok(
			Arr.some(i.sql, (s) => Str.includes('CREATE EXTENSION IF NOT EXISTS "btree_gist"')(s))
		)
		/** The span key's WITHOUT OVERLAPS index serves Booking's span predicate and records its justification. */
		const pk = Option.getOrThrowWith(
			Arr.findFirst(i.indexes, (x) => x.relation === "Booking" && x.index.kind === "installed"),
			() => new Error("no Booking key index")
		)
		assert.equal(pk.method, "gist")
		assert.deepEqual(
			Arr.map(pk.requests, (q) => [q.role, q.use]),
			[["access", "span predicate"]]
		)
		/** A span index over a span alone needs no btree_gist of its own. */
		const j = installed(Visits, [workloadOf(Visits, { visitsInWindow })])
		assert.deepEqual(
			Arr.map(
				Arr.filter(j.indexes, (x) => x.index.kind === "created"),
				(x) => [x.relation, x.method, keysOf(x)]
			),
			[["Visit", "gist", ["during"]]]
		)
		assert.equal(
			Arr.some(j.sql, (s) => Str.includes("btree_gist")(s)),
			false
		)
	})
})
