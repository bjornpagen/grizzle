import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Stream } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { slotEncoders } from "#compiler/plan/runtime.ts"
import { httpAnswers } from "#http/handler.ts"
import {
	aims,
	answeredMembers,
	bodyOf,
	caseGen,
	type Feature,
	holdsAll,
	inProcess,
	Items,
	memberNamed,
	origin,
	outcomeKind,
	readFeature
} from "#test/pg/http/stream.fixtures.ts"
import { readStream } from "#test/support/event-stream.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { installed } from "#test/support/pg/reads/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * A login whose reads are all answered (workload answered), beside a write, is served over HTTP under a layer given no
 * live source: DbLayer.make of it requires none, so this property's layer is built of the login's connection alone,
 * and it opens. Each read's answer is its reset, its upserts, its ready, then its end, never a watch, the same events as
 * the member's in-process answer, which holds no watch either; a write's is its outcome, then its end.
 */
export const anAnsweredLoginIsServedOverHTTPWithNoLiveSourceEachReadAnsweredOnceThenEnded =
	property.explore(aimed(caseGen, aims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a read in its key order",
			"an ordered read from its start",
			"an ordered read from its end",
			"a key",
			"a write accepted",
			"a write unchanged"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			({ stored, call, heartbeatMs }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const o = yield* installed(
							Items,
							{ Item: stored },
							{ label: "answered", programs: answeredMembers }
						)
						const printed = () => Formatter.format({ stored, call, heartbeatMs })
						const login = o.served.login
						const role = login.roles.app
						/** The login's layer, given no live source: a login of answered reads and a write requires none. */
						const layer = DbLayer.make({
							...clusterConnection(
								o.installed.cluster,
								o.installed.database,
								o.installed.as(o.server).password
							),
							pool: clusterPool,
							login,
							verify: testVerify
						})
						yield* Effect.gen(function* () {
							const answers = yield* httpAnswers({ logins: [login], heartbeatMs })
							const opened = yield* openServed(role, {})
							const member = memberNamed(opened.role.members, call.member)
							const calls = memberCalls(opened.ctx, member)
							const slots = slotEncoders(member.wire.member, opened.role.wire.witness, {
								some: Option.some,
								none: Option.none(),
								is: Option.isOption,
								fold: Option.match
							})
							const body = bodyOf(call)
							const handled = answers(
								new Request(`${origin}/${login.name}/${role.role}/${call.member}`, {
									method: "POST",
									headers: { "grizzle-wire": member.wire.digest },
									body: jsonText(body)
								})
							)
							const answer: ReadableStream<Uint8Array> | null = handled.response.body
							if (answer === null) {
								return assert.fail("every answer has a body")
							}
							const read = yield* readStream(answer, () => false)
							if (call.member === "put") {
								const accepted = !holdsAll(stored, call.input.put)
								notes.note(accepted ? "a write accepted" : "a write unchanged")
								assert.deepEqual(
									[Arr.map(read.events, (e) => e.event), outcomeKind(read.events[0])],
									[["outcome", "end"], accepted ? "accepted" : "unchanged"],
									`a write answers its outcome, then its end\n${printed()}`
								)
								return
							}
							notes.note(readFeature(call))
							const shape = calls.shape
							if (shape !== "answeredList") {
								return assert.fail(
									`member ${call.member}'s calls are an answered read's, which hold no watch\n${printed()}`
								)
							}
							const names = Arr.map(read.events, (e) => e.event)
							assert.deepEqual(
								[names[0], ...names.slice(-2)],
								["reset", "ready", "end"],
								`an answered read answers its reset, its upserts, its ready, then its end\n${printed()}`
							)
							assert.ok(
								Arr.every(names.slice(1, -2), (name) => name === "upsert"),
								`an answered read's events between its reset and its ready are its upserts\n${printed()}`
							)
							const local = yield* Stream.runCollect(inProcess(calls, slots, body))
							assert.deepEqual(
								read.events,
								local,
								`the answer over HTTP is the in-process answer, in its order, its end too\n${printed()}`
							)
						}).pipe(withLayer(layer))
					}).pipe(Effect.scoped, Effect.orDie),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the same layer's in-process answer of the member (adapter/db/handles.ts memberCalls)"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/pool/served.ts",
				original: "\t\t\treturn Effect.succeed(unsourced)",
				replacement:
					"\t\t\treturn Effect.map(liveSourceSessions<LiveOf<L>>(login.base), (live) => live.subscriptions)",
				why: "A layer whose login serves no live read looks up its installation's live source all the same, so the layer given none fails to build with LiveSourceMissing: LiveSource required regardless."
			},
			{
				file: "packages/grizzle/src/adapter/db/handles.ts",
				original:
					'\t\t\treturn { shape: "answeredList", ...answeredCalls(ctx, answeredAnswer, parse) }',
				replacement:
					'\t\t\treturn { shape: "list", ...readCalls(ctx, { kind: "constant" }, read, liveAnswer, parse) }',
				why: "An answered read's calls are a live read's (db/handles.ts readMemberCalls), a watch registered beside its once: answered treated as live."
			}
		]
	})
