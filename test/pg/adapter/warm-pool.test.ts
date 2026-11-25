/**
 * A pool keeps every session it opened, warm, for its layer's life: an application that builds a login's layer once
 * and opens a Db per request, as one Vercel Fluid instance serves its requests, pays a session's connection and its
 * first plan of each statement once, never again after a pause between requests (packages/grizzle/src/adapter/wire/
 * pool.ts makePool, its pg Pool built with an idle timeout of 0, pg's "never").
 *
 * Each case: a fresh clone of one mutable relation, whose login serves a put and a read; the clone's backends counting
 * every statement's plans (pg_stat_statements, for the database alone); the login's layer built once, a pool of two
 * sessions over a transport that counts its sockets; then bursts of requests, one at a time, two at once, two after
 * one or one after two, each burst after a pause at least the least delay a Node timer waits, every request a Db.open of
 * its own on the layer and one call of the case's program.
 *
 * Oracle: the sockets the transport opened and closed, and PostgreSQL's pg_stat_statements: no session closes while the
 * layer lives; a burst opens sessions only past those open, never past the pool's two; it plans exactly its new
 * sessions times a session's first call, so a request on a session that ran the program before plans nothing; and no
 * statement is planned more often than the sessions the layer opened, each prepared once a session.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type ReapFeature,
	reapGen,
	runReap,
	runVisits,
	visitsGen,
	type WarmFeature,
	warmTemplate
} from "#test/pg/adapter/warm-pool.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Db.open per request on one layer, with pauses between requests, opens no session it opened before, closes none, and
 * plans each program once per session.
 */
export const dbOpenPerRequestWithPausesOpensNoSessionTwiceClosesNoneAndPlansEachProgramOncePerSession =
	property.exhaust(finite(visitsGen), {
		needs: { fixture: Substrate.fresh(warmTemplate) },
		situations: [
			"put one at a time",
			"put two at once",
			"put two after one",
			"put one after two",
			"read one at a time",
			"read two at once",
			"read two after one",
			"read one after two",
			"a burst after a pause opened no session",
			"a burst past the open sessions opened only the ones it lacked"
		] satisfies ReadonlyArray<Reached<WarmFeature>>,
		check:
			({ fixture }, c: Case<WarmFeature>) =>
			(visits) =>
				Effect.scoped(Effect.flatMap(fixture, (taken) => runVisits(taken, visits, c))),
		oracle: {
			kind: "postgresql",
			name: "the sockets the layer's transport opened and closed, and pg_stat_statements' plans of the clone's statements around each burst"
		},
		box: "a put or a read, called by bursts one at a time, two at once, two after one and one after two, each after a pause, every request a Db.open of its own on one layer with a pool of two",
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/pool.ts",
				original: "\t\t\tidleTimeoutMillis: 0\n",
				replacement: "\t\t\tidleTimeoutMillis: 1\n",
				why: "The pool closes a session idle for a millisecond, as it closed one idle past the caller's idleTimeoutMs: the request after a pause opens a new session and plans its program again."
			},
			{
				file: "packages/grizzle/src/adapter/wire/pool.ts",
				original: '\t\t\t\tgiveBack(client, session.state() !== "open")\n',
				replacement: "\t\t\t\tgiveBack(client, true)\n",
				why: "Every release closes its session: each request opens a connection of its own and plans its program again, as a pool per request would."
			},
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\tname: query.text.name,\n",
				replacement: "",
				why: "A served statement runs as the unnamed statement: no session keeps it, so every call plans it again."
			}
		]
	})

/**
 * A pooled session its server ended while its client heard nothing, as a frozen instance hears nothing, is replaced
 * before a call's first statement: the pool probes a session silent past its reap window, finds it dead before anything
 * of the call is sent, and opens another, so the call answers neither commitUnknown nor transport; and a warm call
 * sends no probe (wire/pool.ts makePool, its header's Reap).
 *
 * Each case: a fresh clone whose sessions each get a reap window of 2,000 ms, the login's layer over a proxy that plays
 * the frozen client (warm-pool.fixtures.ts FreezingProxy), and a put or a read called on a new session, at once again,
 * then once more after the proxy froze the session's link, the window passed and its backend was terminated.
 *
 * Oracle: the call's own answer, pg_stat_statements' calls of the reap window's read, the backends pg_stat_activity
 * lists for the login, and the connections the proxy opened and reset.
 */
export const aPooledSessionItsServerEndedUnheardIsReplacedBeforeACallsFirstStatementAndAWarmCallSendsNoProbe =
	property.exhaust(finite(reapGen), {
		needs: { fixture: Substrate.fresh(warmTemplate) },
		situations: [
			"put after its session's server ended it unheard",
			"read after its session's server ended it unheard"
		] satisfies ReadonlyArray<Reached<ReapFeature>>,
		check:
			({ fixture }, c: Case<ReapFeature>) =>
			(program) =>
				Effect.scoped(Effect.flatMap(fixture, (taken) => runReap(taken, program, c))),
		oracle: {
			kind: "postgresql",
			name: "the third call's answer, pg_stat_statements' calls of the reap window's read, the login's backends and the proxy's connections"
		},
		box: "a put and a read, each called on a new session, again at once, and once more after its server ended it unheard past its reap window",
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/pool.ts",
				original:
					"\t\t\t\t\tconst due = known === undefined || (yield* silentFor(known.taken)) >= known.window\n",
				replacement: "\t\t\t\t\tconst due = known === undefined\n",
				why: "No session is probed after its first lease: the call after its server ended it unheard goes out on the dead session, its COMMIT with it, and answers commitUnknown, a read transport."
			},
			{
				file: "packages/grizzle/src/adapter/wire/pool.ts",
				original:
					"\t\t\t\t\tconst due = known === undefined || (yield* silentFor(known.taken)) >= known.window\n",
				replacement: "\t\t\t\t\tconst due = true\n",
				why: "Every lease probes its session: the warm call sends the window's read again, a round trip a warm call never pays."
			}
		]
	})
