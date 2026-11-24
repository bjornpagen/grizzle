/**
 * A pool keeps every session it opened, warm, for its layer's life: an application that builds a login's layer once
 * and opens a Db per request, as one Vercel Fluid instance serves its requests, pays a session's connection and its
 * first plan of each statement once, never again after a pause between requests (packages/grizzle/src/adapter/wire/
 * session.ts makePool, its pg Pool built with an idle timeout of 0, pg's "never").
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
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\t\tidleTimeoutMillis: 0\n",
				replacement: "\t\t\tidleTimeoutMillis: 1\n",
				why: "The pool closes a session idle for a millisecond, as it closed one idle past the caller's idleTimeoutMs: the request after a pause opens a new session and plans its program again."
			},
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
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
