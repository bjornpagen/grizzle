/**
 * Endpoints equal programs, on the wire: every request the HTTP surface answers is answered by the named prepared
 * statements `grizzle generate` wrote into the login's served file, and by nothing else. No statement text is built at
 * request time, and nothing is ever un-prepared.
 *
 * Each case draws a live world (test/support/live/world.ts), installs it as generate drafts it (test/support/live/
 * harness.ts), and sends a drawn request to every route of its login (http httpRoutes): each read with a drawn binding,
 * a page with a drawn window, each write with a drawn row, a shelf of the world's counted family and then a book naming
 * it, whose write appends a member to a stored owner in its one flight (a family write's additions statement), beside
 * requests no route serves (a path no program has, a method other than POST). Every session the layer opened, pooled,
 * listening or leading, is read off the wire tap (test/support/wire-tap.ts Tap.sessions), each by what its startup
 * packet asked (Tap.startups), and:
 *
 * - on every session but the leader's replication connection, every Parse names its statement, by the name its text
 *   gives it (core/prepared.ts prepared), and its text is one the served file holds; every Bind names a statement, none
 *   runs as the unnamed one; every simple Query's text is one the served file holds, its BEGINs, COMMIT and ROLLBACK,
 *   and the listening session's one statement; and no Close names a statement;
 * - on the decoder's replication connection, a walsender of the database, which takes simple queries alone, the
 *   protocol's one exception: every simple Query is exactly one of the served file's live texts (served/forms.ts
 *   ServedLive), and nothing else is sent but the replication protocol's own messages;
 * - a request no route serves sends nothing: its answer is a route error before any session is asked for.
 *
 * The oracle is the served file itself: every string its JSON value holds, by value, is what generate wrote, and its
 * live source's texts are what the leader may send.
 *
 * A role that serves nothing, and so has no route, is test/unit/live/routes.test.ts's: this suite's world has one role,
 * `app`, which serves every member.
 *
 * Features: each read shape, a page, each write member, a request no route serves, a method no route serves, the
 * leader's replication session, a write naming a family member, a read of closed relations alone.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { servedFile } from "#compiler/served/json.ts"
import {
	bounds,
	cases,
	type Feature,
	liveTextsOf,
	replicationStrayOf,
	strayOf,
	stringsOf
} from "#test/pg/live/endpoints.fixtures.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { inputOf, worldSurfaces } from "#test/support/live/calls.ts"
import { installLive, liveLogin } from "#test/support/live/harness.ts"
import {
	closedRead,
	familyMembers,
	familyRelations,
	liveCaseGen,
	probeMember,
	readMember,
	relationName,
	writeMember
} from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Every HTTP route is answered by the served file's named prepared statements alone, over ${cases} generated logins.
 *
 * Its pre-conversion budget: runs cases, coverage cases 32 (test/pg/live/endpoints.test.ts at d8eed1786).
 */
export const everyHTTPRouteIsAnsweredByTheServedFilesNamedPreparedStatementsAloneOverCasesGeneratedLogins =
	property.explore(liveCaseGen(bounds), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a keyed read",
			"a page read",
			"a window read",
			"the probe read",
			"an insert",
			"a delete",
			"a put",
			"a path no route serves",
			"a method no route serves",
			"the leader's replication session",
			"a write naming a family member",
			"a read of closed relations alone"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const live = yield* installLive(c, "live_endpoints", clusterPool)
						const served = stringsOf(live.json, new Set())
						yield* Effect.gen(function* () {
							const surfaces = yield* worldSurfaces(live)
							const loginRole = live.installed.as(live.world.server).role
							/** What the login's own sessions sent since `marks`, a session opened since in whole. */
							const sentSince = (marks: ReadonlyArray<number>) => {
								const startups = live.tap.startups()
								return Arr.flatMap(live.tap.sessions(), (session, i) =>
									startups[i]?.user === loginRole ? session.frontend.slice(marks[i] ?? 0) : []
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
							notes.note("a read of closed relations alone")
							yield* Effect.ignore(surfaces.http.once(closedRead.member, { params: {}, facts: {} }))
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
							yield* surfaces.http.write(familyMembers.owner, {
								params: {},
								facts: { insert: { [familyRelations.owner]: [{ id: 1 }] } }
							})
							notes.note("a write naming a family member")
							yield* surfaces.http.write(familyMembers.member, {
								params: {},
								facts: { insert: { [familyRelations.member]: [{ id: 1, shelf: 1 }] } }
							})
						}).pipe(withLayer(live.layer))
						const source = succeeded(servedFile(live.json), "the served file").live
						if (source.kind !== "source") {
							return assert.fail("a world whose reads read its relations installs a live source")
						}
						const liveTexts = liveTextsOf(source, live.installed.decoder().role)
						const liveText = (text: string): boolean => liveTexts.has(text)
						const startups = live.tap.startups()
						for (const [at, session] of live.tap.sessions().entries()) {
							if (startups[at]?.replication === true) {
								notes.note("the leader's replication session")
								assert.deepEqual(
									replicationStrayOf(session, liveText),
									[],
									`the replication session ${at} sent only the served file's live texts, each a simple Query\n${Formatter.format(c)}`
								)
							} else {
								assert.deepEqual(
									strayOf(session, served),
									[],
									`session ${at} sent only the served file's statements, each named\n${Formatter.format(c)}`
								)
							}
						}
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "every text the served file holds, and the name each text is prepared under"
		},
		budget: { runs: cases, steered: 32 },
		kept: [],
		kills: []
	})
