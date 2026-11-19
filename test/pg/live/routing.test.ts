/**
 * Routing exactness: a commit re-runs exactly the subscriptions whose routing values it touched, each exactly once
 * however many of its changes reached it, and no other.
 *
 * Each case draws a live world (test/support/live/world.ts) and installs it as generate drafts it, its live source
 * among its objects (test/support/live/harness.ts), its live source made to stand first by the probe's watch, which
 * answers once the leader has made the slot (test/support/live/standing.ts standingOn). Every
 * subscription is registered in process on watch's own path
 * (adapter/db/handles.ts liveRead) and read to its first `ready`, and then re-runs only when the suite turns it (the
 * registration's turn: a clean subscription runs nothing, a marked one re-runs exactly once), so what a commit's
 * notifications did to each is its state, read without a race. A fence settles what came before the first commit: every
 * subscription a change before it marked is turned. After each commit of the history (a grizzle call or a direct
 * writer's SERIALIZABLE transaction), a fence commit inserts a Probe row that only the fence's own probe reads, a
 * subscription of that row alone (world.ts probeAtMember) registered before the commit, and the probe is awaited until
 * that row's change marks it and turned, its value then holding the row: notifications reach the one listener in commit
 * order and each is routed as it arrives, so by then every notification of the commit has been routed. Only the fence's
 * own commit marks its own probe; a probe of every row, marked as well by any copy of an earlier fence's notification,
 * would let the fence pass before its commit was routed (the Misrouted reds of routing at 0b7b5f31 and 4c9ce8f7). That
 * order is forced before every fence after the first: a copy of the last fence's notification, sealed under the secret
 * as the leader seals it and sent on the channel as any session may send one (pg_notify is PUBLIC), is routed (the last
 * fence's probe marked by it), and the fence's own probe must still be clean.
 *
 * Properties, after each commit:
 *
 * - every read's served footprint routes exactly as its program fixes its parameter (world.ts expectedRoutes): each
 *   relation it reads routed by `g`, a wide read's by its table alone;
 * - a subscription is marked exactly when the commit touched one of its routing values (world.ts touches: it wrote a
 *   relation the read reads, and the read binds no group, or a row it wrote held the bound group before or after), and
 *   no subscription re-ran unturned;
 * - turned, each marked subscription re-runs exactly once, its program's statement executed with its own bound values
 *   once on the wire (test/support/wire-tap.ts), and is clean after it; an unmarked one is never turned and never
 *   executes again;
 * - notifications no holder of the live secret sealed, sent on the fan-out channel by the direct writer (a plaintext
 *   route key of a subscription's own group, and every payload the leader sealed so far with one character changed,
 *   each once from its original, never a payload the case sent itself, and each checked to open under no secret), mark
 *   no subscription: the listener drops what its seal does not open.
 *
 * The oracle is the routing a program's own parameters state (world.ts touches), restated over the drawn writes, never
 * the footprint the served file records; a re-run is counted as the wire shows it, the Binds of the subscription's
 * statement with the values its first read bound.
 *
 * Features: a touched and an untouched subscription of one relation, a commit touching several subscriptions, an
 * update moving a row between groups, each read shape, each writer, a sealed copy of the last fence's notification.
 */

import { awaitFact } from "@bjornpagen/testing/fact"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { SecureRandom } from "effect/crypto"
import { sealNonceBytes } from "#compiler/core/seal.ts"
import {
	batchesOf,
	openPayload,
	parseLiveSecret,
	parseNotification,
	sealBatch,
	sealNonce
} from "#compiler/live/notify.ts"
import { servedFile } from "#compiler/served/json.ts"
import {
	bindsSince,
	bounds,
	cases,
	countOf,
	type Feature,
	footprintsHold,
	forgeries,
	marksOf,
	Misrouted
} from "#test/pg/live/routing.fixtures.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { commitLive, inputOf, worldRegistrations, worldSurfaces } from "#test/support/live/calls.ts"
import { commitDirectly, fenceStatement } from "#test/support/live/direct.ts"
import { installLive } from "#test/support/live/harness.ts"
import { standingOn } from "#test/support/live/standing.ts"
import type { Registration } from "#test/support/live/system.ts"
import {
	liveCaseGen,
	type LiveSubscription,
	probeAtMember,
	probeMember,
	probeRelation,
	readMember,
	touches,
	writesOf
} from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A commit's notifications re-run exactly the subscriptions whose routing values the commit touched, each once, over ${cases} generated histories.
 *
 * Its pre-conversion budget: runs cases, coverage cases 40 (test/pg/live/routing.test.ts at d8eed1786).
 */
export const aCommitsNotificationsReRunExactlyTheSubscriptionsWhoseRoutingValuesTheCommitTouchedEachOnceOverCasesGeneratedHistories =
	property.explore(liveCaseGen(bounds), {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a forged plaintext notification",
			"a tampered sealed notification",
			"a touched and an untouched subscription of one relation",
			"a commit touching several subscriptions",
			"an update moving a row between groups",
			"a direct writer's commit",
			"a grizzle call's commit",
			"a sealed copy of the last fence's notification"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, notes: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const live = yield* installLive(c, "live_routing", clusterPool)
						footprintsHold(live)
						yield* Effect.gen(function* () {
							const surfaces = yield* worldSurfaces(live)
							const register = yield* worldRegistrations(live)
							yield* standingOn(surfaces.inProcess, probeMember, { params: {}, facts: {} })
							/** Each subscription registered and read once, with the Binds its first read sent. */
							const registered = yield* Effect.forEach(c.subscriptions, (s: LiveSubscription) =>
								Effect.gen(function* () {
									notes.note(`a ${Arr.getUnsafe(c.reads, s.read).kind} read`)
									const before = marksOf(live.tap.sessions())
									const registration = yield* register(readMember(s.read), inputOf(s))
									const sent = bindsSince(live.tap.sessions(), before)
									const prologue = succeeded(servedFile(live.json), "the served file").prologue
									const signature = Arr.filter(
										sent,
										(b) =>
											!Str.startsWith(`${prologue.fence.name}(`)(b) &&
											!Str.startsWith(`${prologue.enter.name}(`)(b)
									)
									assert.ok(
										Arr.isReadonlyArrayNonEmpty(signature),
										`subscription ${Formatter.format(s)} sent its statement on its first read`
									)
									return { s, registration, signature }
								})
							)
							const source = succeeded(servedFile(live.json), "the served file").live
							if (source.kind !== "source") {
								return assert.fail("a world whose reads read its relations installs a live source")
							}
							const substrate = yield* Substrate
							const secretRows = yield* substrate.superuserRead((rows) => rows(source.secret.sql))
							const secret = succeeded(
								parseLiveSecret(String(defined(secretRows[0]?.[0], "the live secret's cell"))),
								"the live secret"
							)
							const probeTable = defined(
								live.installed.plan.tables[probeRelation],
								"the Probe table"
							)
							const probeId = defined(
								Option.getOrUndefined(
									Arr.findFirst(probeTable.columns, (col) => col.field === "id")
								),
								"Probe.id"
							)
							/** The leader's notification of Probe's row `id`, sealed under the secret as the leader seals it. */
							const sealedProbe = (id: number): string => {
								const notification = succeeded(
									parseNotification(`${probeTable.name.name}:${probeId.column}=${id}`),
									"a Probe row's route key"
								)
								const [batch] = batchesOf([notification])
								return sealBatch(
									secret,
									succeeded(sealNonce(SecureRandom.randomBytesUnsafe(sealNonceBytes)), "a nonce"),
									defined(batch, "the batch of one key")
								)
							}
							/** Every payload the case sent on the channel itself, which are not the leader's. */
							const sent = new Set<string>()
							let fence = 0
							/** The last fence's own probe, once a fence ran. */
							const last: { probe: Option.Option<Registration> } = { probe: Option.none() }
							const marked = (registration: Registration) =>
								awaitFact(
									Effect.map(registration.state, (state) =>
										state === "marked" ? Option.some(undefined) : Option.none()
									)
								)
							/**
							 * A fence: a Probe row committed after everything before it, its own probe (probeAtMember, the row
							 * of its id, registered before the row is) awaited until the row's change marks it, and turned
							 * once, its value then holding the row: notifications reach the one listener in commit order and
							 * each is routed as it arrives, so by then every change committed before the fence has been
							 * routed. Only the fence's own commit marks its own probe. A probe of every row would be marked
							 * as well by a copy of an earlier fence's notification, sealed under the secret as the leader
							 * seals it, which PostgreSQL lets any session send on the channel (pg_notify is PUBLIC), so the
							 * fence would pass before its own commit was routed. So before each fence after the first, that
							 * order is forced: a sealed copy of the last fence's notification is sent and routed (the last
							 * fence's probe marked by it), and the fence's own probe must still be clean.
							 */
							const fenced = Effect.gen(function* () {
								fence += 1
								const own = yield* register(probeAtMember, { params: { id: fence }, facts: {} })
								const previous = last.probe
								if (Option.isSome(previous)) {
									const copy = sealedProbe(fence - 1)
									sent.add(copy)
									yield* live.writer.query(source.fanout.sql, [[copy]])
									yield* marked(previous.value)
									const standing = yield* own.state
									if (standing !== "clean") {
										return yield* new Misrouted({
											report: `fence ${fence}'s own probe is ${standing} after a sealed copy of fence ${fence - 1}'s notification`
										})
									}
									yield* previous.value.turn
									notes.note("a sealed copy of the last fence's notification")
								}
								yield* commitDirectly(live.writer, [fenceStatement(live.installed.plan, fence)])
								yield* marked(own)
								const turned = yield* own.turn
								assert.ok(
									Option.exists(turned, (value) =>
										Arr.some(Arr.fromIterable(value), (row) => "id" in row && row.id === fence)
									),
									`fence ${fence}'s own probe holds its row once turned: ${Formatter.format(turned)}`
								)
								last.probe = Option.some(own)
							})
							/** One turn of a subscription: the Binds of its statement the turn sent. */
							const rerun = (r: (typeof registered)[number]) =>
								Effect.gen(function* () {
									const mark = marksOf(live.tap.sessions())
									yield* r.registration.turn
									return countOf(bindsSince(live.tap.sessions(), mark), r.signature)
								})
							yield* fenced
							for (const r of registered) {
								if ((yield* r.registration.state) === "marked") {
									yield* rerun(r)
								}
							}
							for (const commit of c.history) {
								notes.note(
									commit.writer === "psql" ? "a direct writer's commit" : "a grizzle call's commit"
								)
								if (Arr.some(writesOf(commit), (w) => w.kind === "update" && w.from.g !== w.to.g)) {
									notes.note("an update moving a row between groups")
								}
								const base = marksOf(live.tap.sessions())
								yield* commitLive(live, surfaces.inProcess, commit)
								yield* fenced
								const after = bindsSince(live.tap.sessions(), base)
								const touched = Arr.map(registered, (r) => touches(c, r.s, commit))
								if (Arr.filter(touched, (t) => t).length > 1) {
									notes.note("a commit touching several subscriptions")
								}
								for (const [i, r] of registered.entries()) {
									const state = yield* r.registration.state
									const expected = touched[i] === true ? "marked" : "clean"
									if (state !== expected) {
										return yield* new Misrouted({
											report: `subscription ${i} (${Formatter.format(r.s)}) is ${state} after ${Formatter.format(commit)}, which ${touched[i] === true ? "touched" : "did not touch"} its routing values`
										})
									}
									assert.equal(
										countOf(after, r.signature),
										0,
										`subscription ${i} re-ran while no one pulled it`
									)
									const read = Arr.getUnsafe(c.reads, r.s.read)
									if (
										Arr.some(
											registered,
											(other, j) =>
												j !== i &&
												touched[j] !== touched[i] &&
												Arr.some(
													Arr.getUnsafe(c.reads, other.s.read).kind === "join"
														? []
														: [Arr.getUnsafe(c.reads, other.s.read)],
													(o) => o.relation === read.relation
												)
										)
									) {
										notes.note("a touched and an untouched subscription of one relation")
									}
								}
								for (const [i, r] of registered.entries()) {
									if (touched[i] !== true) {
										continue
									}
									const reran = yield* rerun(r)
									assert.equal(
										reran,
										r.signature.length,
										`subscription ${i} (${Formatter.format(r.s)}) re-ran exactly once for ${Formatter.format(commit)}`
									)
								}
								const genuine = Arr.dedupe(
									Arr.filter(
										Arr.map(live.tap.notifications(), (n) => n.payload),
										(payload) => !sent.has(payload)
									)
								)
								const forged = forgeries(live, registered, genuine)
								for (const payload of forged.payloads) {
									assert.ok(
										!openPayload(secret, payload).ok,
										`a forged payload opens under no secret: ${payload} does`
									)
									sent.add(payload)
								}
								if (Arr.isReadonlyArrayNonEmpty(forged.payloads)) {
									notes.noteAll(forged.kinds)
									yield* live.writer.query(source.fanout.sql, [forged.payloads])
									yield* fenced
									for (const [i, r] of registered.entries()) {
										const state = yield* r.registration.state
										if (state !== "clean") {
											return yield* new Misrouted({
												report: `subscription ${i} (${Formatter.format(r.s)}) is ${state} after notifications no secret sealed: ${Formatter.format(forged.payloads)}`
											})
										}
									}
								}
							}
						}).pipe(withLayer(live.layer))
					}).pipe(Effect.scoped),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "specification",
			name: "the routing each program's parameters state, restated over the drawn writes"
		},
		budget: { runs: cases, steered: 40 },
		kept: [],
		kills: []
	})
