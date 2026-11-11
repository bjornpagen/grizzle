/**
 * Endpoints equal programs, on the wire: every request the HTTP surface answers is answered by the named prepared
 * statements `grizzle generate` wrote into the login's served file, and by nothing else. No statement text is built at
 * request time, and nothing is ever un-prepared.
 *
 * Each case draws a live world (test/support/live/world.ts), installs it as generate drafts it (test/support/live/
 * harness.ts), and sends a drawn request to every route of its login (http httpRoutes): each read with a drawn binding,
 * a page with a drawn window, each write with a drawn row, beside requests no route serves (a path no program has, a
 * method other than POST). Every session the layer opened, pooled or listening, is read off the wire tap
 * (test/support/wire-tap.ts Tap.sessions), and:
 *
 * - every Parse names its statement, by the name its text gives it (core/prepared.ts prepared), and its text is one the
 *   served file holds;
 * - every Bind names a statement: none runs as the unnamed one;
 * - every simple Query's text is one the served file holds: its BEGINs, COMMIT and ROLLBACK, and the listening session's
 *   one statement;
 * - no Close names a statement;
 * - a request no route serves sends nothing: its answer is a route error before any session is asked for.
 *
 * The oracle is the served file itself: every string its JSON value holds, by value, is what generate wrote.
 *
 * Plant: none of its own beyond the routes suite's route-without-program.patch, which this suite meets as a route whose
 * request sends no served statement.
 *
 * Features: each read shape, a page, each write member, a request no route serves, a method no route serves.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { prepared } from "#compiler/core/prepared.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { inputOf, worldSurfaces } from "#test/support/live/calls.ts"
import { installLive, liveLogin } from "#test/support/live/harness.ts"
import {
	type LiveBounds,
	liveCaseGen,
	probeMember,
	type ReadKind,
	readMember,
	relationName,
	writeMember
} from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import type { WireWindow } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"

type Feature =
	| `a ${ReadKind} read`
	| "the probe read"
	| "an insert"
	| "a delete"
	| "a put"
	| "a path no route serves"
	| "a method no route serves"

const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 4,
	subscriptions: 4,
	commits: 0,
	writes: 1,
	window: 3
}

const cases = 16

/** Every string a JSON value holds, at any depth, keys included. */
const stringsOf = (value: unknown, into: Set<string>): Set<string> => {
	if (typeof value === "string") {
		into.add(value)
	} else if (isList(value)) {
		for (const item of value) {
			stringsOf(item, into)
		}
	} else if (isRecord(value)) {
		for (const [key, item] of Rec.toEntries(value)) {
			into.add(key)
			stringsOf(item, into)
		}
	}
	return into
}

/** What a session sent that no served file holds, or that runs no named statement, one line each. */
const strayOf = (session: WireWindow, served: ReadonlySet<string>): ReadonlyArray<string> =>
	Arr.flatMap(session.frontend, (m): ReadonlyArray<string> => {
		if (m.type === "P") {
			return m.name === "" || m.name !== prepared(m.text).name || !served.has(m.text)
				? [`Parse ${Formatter.format(m.name)} of ${Formatter.format(m.text)}`]
				: []
		}
		if (m.type === "B") {
			return m.name === "" ? ["a Bind of the unnamed statement"] : []
		}
		if (m.type === "Q") {
			return served.has(m.text) ? [] : [`Query ${Formatter.format(m.text)}`]
		}
		return m.type === "C" && m.name !== "" ? [`a Close of ${Formatter.format(m.name)}`] : []
	})

layer(Substrate.layer)("every HTTP route", (it) => {
	it.effect(
		`is answered by the served file's named prepared statements alone, over ${cases} generated logins`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "every text the served file holds, and the name each text is prepared under"
						},
						suite: "pg/live/endpoints",
						draw: drawn(liveCaseGen(bounds)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a keyed read",
								"a page read",
								"a window read",
								"the probe read",
								"an insert",
								"a delete",
								"a put",
								"a path no route serves",
								"a method no route serves"
							],
							{ cases: 32, sense: notesOnly }
						),
						kept: [],
						runs: cases,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							const live = yield* installLive(c, "live_endpoints", clusterPool)
							const served = stringsOf(live.json, new Set())
							yield* Effect.gen(function* () {
								const surfaces = yield* worldSurfaces(live)
								const loginRole = live.installed.as(live.world.server).role
								/** What the login's own sessions sent since `marks`, a session opened since in whole. */
								const sentSince = (marks: ReadonlyArray<number>) => {
									const users = live.tap.users()
									return Arr.flatMap(live.tap.sessions(), (session, i) =>
										users[i] === loginRole ? session.frontend.slice(marks[i] ?? 0) : []
									)
								}
								const marks = Arr.map(live.tap.sessions(), (session) => session.frontend.length)
								const nothing = yield* surfaces.raw({
									method: "POST",
									path: `/${liveLogin}/app/nothing`,
									headers: {},
									body: `{"params":{},"facts":{}}`
								})
								notes.note("a path no route serves")
								assert.deepEqual(
									Arr.map(nothing, (e) => e.type),
									["error", "end"],
									"a path no route serves is answered by its route error and its end"
								)
								const wrongMethod = yield* surfaces.raw({
									method: "GET",
									path: `/${liveLogin}/app/${readMember(0)}`,
									headers: {},
									body: `{"params":{},"facts":{}}`
								})
								notes.note("a method no route serves")
								assert.deepEqual(
									Arr.map(wrongMethod, (e) => e.type),
									["error", "end"],
									"a method other than POST is answered by its route error and its end"
								)
								assert.deepEqual(
									sentSince(marks),
									[],
									"a request no route serves sends nothing on the login's sessions"
								)
								for (const s of c.subscriptions) {
									notes.note(`a ${Arr.getUnsafe(c.reads, s.read).kind} read`)
									yield* Effect.ignore(surfaces.http.once(readMember(s.read), inputOf(s)))
								}
								notes.note("the probe read")
								yield* Effect.ignore(surfaces.http.once(probeMember, { params: {}, facts: {} }))
								for (const place of [0, 1] as const) {
									const row = c.facts[place][0] ?? { id: 0, g: 0, o: 0, val: 0 }
									const relation = relationName(place)
									notes.note("an insert")
									yield* Effect.ignore(
										surfaces.http.write(writeMember("insert", place), {
											params: {},
											facts: { insert: { [relation]: [{ ...row, id: row.id + 1000 }] } }
										})
									)
									notes.note("a put")
									yield* Effect.ignore(
										surfaces.http.write(writeMember("put", place), {
											params: {},
											facts: { put: { [relation]: [{ ...row, val: row.val + 1 }] } }
										})
									)
									notes.note("a delete")
									yield* Effect.ignore(
										surfaces.http.write(writeMember("delete", place), {
											params: {},
											facts: { delete: { [relation]: [row] } }
										})
									)
								}
							}).pipe(withLayer(live.layer))
							for (const [at, session] of live.tap.sessions().entries()) {
								assert.deepEqual(
									strayOf(session, served),
									[],
									`session ${at} sent only the served file's statements, each named\n${Formatter.format(c)}`
								)
							}
						}).pipe(Effect.scoped)
				)
			)
	)
})
