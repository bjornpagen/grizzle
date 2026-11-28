/**
 * An HTTP handler's routes are exactly its served logins' members, and every request is answered as a stream of
 * events, 200, whatever it asks. Over generated public schemas (test/support/oracle/public), each extended by a drawn
 * law level, and logins drawn over them (test/support/served-login.ts: roles that read the case's queries, an ordered
 * one whole or paged, write relations through ChangeSets, and perhaps a query entry reading a context), each compiled
 * as `grizzle generate` compiles it, served as an application serves its committed file, its layer built with no
 * database, given a live source that connects nothing (test/support/live-layer.ts), and the handler over it
 * (http/handler.ts httpHandler):
 *
 * - The routes are the members: httpRoutes lists exactly `POST /<login>/<role>/<program>` for each member of each role
 *   the served file holds, and nothing else.
 * - The handler dispatches by them: a drawn request line, a route's mutated (another method, a query, a segment
 *   renamed, added or dropped, a trailing slash) or its own, answers `route` exactly when no member names it.
 * - A route's call is refused in its order, before any SQL: a request naming no wire digest is an `input`, one naming
 *   another form `stale`; an Authorization header that is no bearer token, or none where the role reads a context, is
 *   `tokenRefused`; a body that is no JSON is an `input`.
 * - Every answer is 200, text/event-stream, no cache and no proxy buffering, and its stream, read as WHATWG HTML reads
 *   one (test/support/event-stream.ts), is one `error` event whose CallError has its kind's retry, then `end`, with no
 *   `id` and no `retry` field.
 *
 * The oracle is the served file itself, its roles' members and contexts, and the order of the call's checks.
 *
 * A drawn probe calls with no bearer token a route whose role reads a context only as one in nine calls of such a
 * route, and the streams the suite's label fixes held none, so a witness whose turn aims at it draws a sketch whose
 * case is constructed to (aimed, `no bearer`): its login's first role holds the query entry wherever a field may carry
 * a claim (served-login.ts liveLoginGen), and after its drawn probes it calls a route of a role reading a context,
 * naming the route's wire, with no Authorization header. A paged member's route is in about one drawn case in five, so a
 * witness whose turn aims at it draws a case every read of which is ordered (oracle/public/generate.ts
 * orderedCaseSketchGen), and its login's first role reads each of them paged (served-login.ts pagedLoginGen), rather
 * than leave the situation to the tape: its fixed floor witnesses missed it once bbf0a29d drew a law level's order.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Result as Answered, Array as Arr, Effect, Formatter, Order } from "effect"
import { served } from "#adapter/public/layer.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { httpHandler, httpRoutes } from "#http/index.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { clusterPool } from "#test/support/pg.ts"
import { offlineConnection } from "#test/support/pg/cli/support.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	liveLoginGen,
	loginGen,
	pagedLoginGen
} from "#test/support/served-login.ts"
import {
	answered,
	type Feature,
	fileRoutes,
	heartbeatGen,
	noBearer,
	noBearerProbesGen,
	pagedRoute,
	probeRequest,
	probesGen,
	refusedAs,
	sketchGen
} from "#test/support/unit/http/routes.fixtures.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * An HTTP handler's routes are exactly the served members, and every request is answered as one stream of events.
 *
 * Budget: its suite's count before the conversion (unit/http/routes: 60 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const anHTTPHandlersRoutesAreExactlyTheServedMembersAndEveryRequestIsAnsweredAsOneStreamOfEvents =
	property.explore(
		aimed(sketchGen("drawn"), [
			[noBearer, sketchGen("no bearer")],
			[pagedRoute, sketchGen("paged")]
		]),
		{
			needs: {},
			situations: [
				"a route of a role reading a context",
				"a route of a role reading none",
				"a paged member's route",
				"a change member's route",
				"a route named with no wire digest",
				"a route named with another wire digest",
				"a route called with no bearer token",
				"a route called with a refused Authorization header",
				"a route whose body is no JSON",
				"a line of another method",
				"a line with a query",
				"a line naming no member",
				"a drawn line a member names"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, notes: Case<Feature>) =>
				([sketch, level, probing]) =>
					Effect.gen(function* () {
						const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
						const aimedAtNoBearer = probing === "no bearer"
						const shapes = notes.draw(
							(probing === "no bearer"
								? liveLoginGen
								: probing === "paged"
									? pagedLoginGen
									: loginGen)(schema)
						)
						const compiled = yield* Effect.result(
							compiledLogin(drawnLogin(schema, shapes), schema.laws.codes)
						)
						if (Answered.isFailure(compiled)) {
							return
						}
						const { json, back } = compiled.success
						const printed = () =>
							`${printCase(schema.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
						const login = served<AnyLogin>(json, back.login)
						const routes = fileRoutes(back)
						const lines = new Set(Arr.map(routes, (r) => r.line))
						const listed = httpRoutes([login])
						assert.ok(Answered.isSuccess(listed), `one login's routes are distinct\n${printed()}`)
						assert.deepEqual(
							Arr.sort([...listed.success.keys()], Order.String),
							Arr.sort([...lines], Order.String),
							`the routes are exactly the served members\n${printed()}`
						)
						if (!Arr.isReadonlyArrayNonEmpty(routes)) {
							return
						}
						const probes = notes.draw(
							aimedAtNoBearer ? noBearerProbesGen(routes) : probesGen(routes.length)
						)
						yield* Effect.gen(function* () {
							const handler = yield* httpHandler({
								logins: [login],
								heartbeatMs: notes.draw(heartbeatGen)
							})
							for (const probe of probes) {
								const { request, expected } = probeRequest(routes, lines, probe, notes.note)
								const { response, read } = yield* answered(handler, request)
								refusedAs(
									response,
									read,
									expected,
									() => `${printed()}\n${Formatter.format(probe)}`
								)
							}
						}).pipe(
							withLayer(
								servedSourcedLayer(offlineDecoders, {
									...offlineConnection,
									pool: clusterPool,
									login,
									verify: testVerify
								})
							),
							Effect.orDie
						)
					}).pipe(Effect.scoped),
			oracle: {
				kind: "specification",
				name: "the served file's members, their roles' contexts, and the order of a call's checks"
			},
			budget: { runs: 60, steered: 0 },
			kept: [],
			kills: [
				{
					file: "test/support/served-login.ts",
					original: "\t\t\t\t? [{ place, query: read.query, paged: true }]",
					replacement: "\t\t\t\t? [{ place, query: read.query, paged: false }]",
					why: "The paged aim's login reads its ordered queries whole, so no witness pages one; the property fails on its unreached paged member's route."
				},
				{
					file: "test/support/oracle/public/generate.ts",
					original: '\t\tdecisions.draw(directedSwarm([...deliveredOn, "ordered"], deliveredOff))',
					replacement: "\t\tdecisions.draw(directedSwarm(deliveredOn, deliveredOff))",
					why: "The ordered aim's case orders a read only where its swarm's drawn weight keeps it, so the paged aim may hold no ordered query; the property fails on its unreached paged member's route."
				},
				{
					file: "packages/grizzle/src/http/routes.ts",
					original: "\t\t\t\ttable.set(line, { route, role, member })",
					replacement: `\t\t\t\ttable.set(line, { route, role, member })\n\t\t\t\ttable.set(\`\${line}/\`, { route, role, member })`,
					why: "The table serves a route no member names, each route's line with a trailing slash: the routes are not the members."
				},
				{
					file: "packages/grizzle/src/http/handler.ts",
					original: "\t\t\t\t\t{ status: 200, headers: sseHeaders }",
					replacement:
						"\t\t\t\t\t{ status: table.has(requestLine(request)) ? 200 : 404, headers: sseHeaders }",
					why: "A request line no route serves is answered 404: the answer is not the stream."
				},
				{
					file: "packages/grizzle/src/http/handler.ts",
					original:
						"\t\tconst token = yield* Effect.fromResult(openingToken(route.role.held.role, given))\n\t\tconst attested = yield* Effect.mapError(\n\t\t\tEffect.fromResult(openingAttested(attesting, route.role.held.role, request)),\n\t\t\topenCallError\n\t\t)\n\t\tconst body = yield* bodyJson(request)",
					replacement:
						"\t\tconst body = yield* bodyJson(request)\n\t\tconst token = yield* Effect.fromResult(openingToken(route.role.held.role, given))\n\t\tconst attested = yield* Effect.mapError(\n\t\t\tEffect.fromResult(openingAttested(attesting, route.role.held.role, request)),\n\t\t\topenCallError\n\t\t)",
					why: "A call's missing token is checked after its body's JSON, so a call with no bearer token and no JSON body is an `input`."
				}
			]
		}
	)
