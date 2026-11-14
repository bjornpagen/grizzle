/**
 * Routing exactness: a commit re-runs exactly the subscriptions whose routing values it touched, each exactly once
 * however many of its changes reached it, and no other.
 *
 * Each case draws a live world (test/support/live/world.ts) and installs it as generate drafts it, its live source
 * among its objects (test/support/live/harness.ts). Every subscription is registered in process on watch's own path
 * (adapter/db/handles.ts liveRead) and read to its first `ready`, and then re-runs only when the suite turns it (the
 * registration's turn: a clean subscription runs nothing, a marked one re-runs exactly once), so what a commit's
 * notifications did to each is its state, read without a race. A fence settles what came before the first commit: every
 * subscription a change before it marked is turned. After each commit of the history (a grizzle call or a direct
 * writer's SERIALIZABLE transaction), a fence commit inserts a Probe row that only the probe subscription reads, and the
 * probe is awaited until that row's change marks it and turned, its value then holding the row: notifications reach the
 * one listener in commit order and each is routed as it arrives, so by then every notification of the commit has been
 * routed.
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
 *   route key of a subscription's own group, and every sealed payload received so far with one character changed),
 *   mark no subscription: the listener drops what its seal does not open.
 *
 * The oracle is the routing a program's own parameters state (world.ts touches), restated over the drawn writes, never
 * the footprint the served file records; a re-run is counted as the wire shows it, the Binds of the subscription's
 * statement with the values its first read bound.
 *
 * Plants (~/.cache/grizzle-release/LIVE-TESTS/plants): routing-key-ignored.patch (the router hands a keyed change to
 * every subscription of its table, so a subscription of another group is marked); source-missing-publication.patch
 * and source-identity-too-narrow.patch (the publication leaves out a footprint table, or the replica identity of one is
 * too narrow for its routing column, so a subscription its write touched, or the group an update moved a row out of,
 * stays clean); unauthenticated-fanout.patch
 * (the listener reads a payload its seal does not open as plaintext, so a forged route key marks its subscription).
 *
 * Features: a touched and an untouched subscription of one relation, a commit touching several subscriptions, an
 * update moving a row between groups, each read shape, each writer.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { awaitFact } from "@bjornpagen/testing/fact"
import { required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { formOf, RowKey } from "#compiler/live/index.ts"
import { servedFile } from "#compiler/served/json.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { commitLive, inputOf, worldRegistrations, worldSurfaces } from "#test/support/live/calls.ts"
import { commitDirectly, fenceStatement } from "#test/support/live/direct.ts"
import { installLive, type LiveInstallation } from "#test/support/live/harness.ts"
import {
	expectedRoutes,
	groupOf,
	type LiveBounds,
	type LiveSubscription,
	liveCaseGen,
	probeMember,
	type ReadKind,
	readMember,
	relationName,
	touches,
	writesOf
} from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import type { FrontendMessage, Notification, WireWindow } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"

class Misrouted extends Data.TaggedError("Misrouted")<{ readonly report: string }> {}

type Feature =
	| "a forged plaintext notification"
	| "a tampered sealed notification"
	| "a touched and an untouched subscription of one relation"
	| "a commit touching several subscriptions"
	| "an update moving a row between groups"
	| `a ${ReadKind} read`
	| "a direct writer's commit"
	| "a grizzle call's commit"

const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 3,
	subscriptions: 5,
	commits: 4,
	writes: 3,
	window: 3
}

const cases = 20

/** A Bind as a re-run sends it: the statement it names and the values it binds, as the wire carries them. */
const bindText = (message: FrontendMessage): string =>
	`${message.name}(${Arr.join(
		Arr.map(message.params, (p) => (p === null ? "NULL" : Formatter.format(p))),
		","
	)})`

/** Where every session of the tap stands: how many frontend messages each has sent, in session order. */
type Marks = ReadonlyArray<number>

/** The tap's marks now. */
const marksOf = (sessions: ReadonlyArray<WireWindow>): Marks =>
	Arr.map(sessions, (session) => session.frontend.length)

/** Every Bind every session of the tap sent since `marks`, a session opened since counting from its start. */
const bindsSince = (sessions: ReadonlyArray<WireWindow>, marks: Marks): ReadonlyArray<string> =>
	Arr.flatMap(sessions, (session, i) =>
		Arr.flatMap(session.frontend.slice(marks[i] ?? 0), (m) => (m.type === "B" ? [bindText(m)] : []))
	)

/** How many of `seen` are `signature`'s Binds: a multiset count. */
const countOf = (seen: ReadonlyArray<string>, signature: ReadonlyArray<string>): number =>
	Arr.filter(seen, (b) => signature.includes(b)).length

/** The served footprint each read records, against the routes its program states (world.ts expectedRoutes). */
const footprintsHold = (live: LiveInstallation): void => {
	const file = succeeded(servedFile(live.json), "the served file")
	const app = defined(
		Option.getOrUndefined(Arr.findFirst(file.roles, (r) => r.name === "app")),
		"the served role app"
	)
	for (const [place, read] of live.c.reads.entries()) {
		const member = defined(
			Option.getOrUndefined(Arr.findFirst(app.members, (m) => m.name === readMember(place))),
			`the served member ${readMember(place)}`
		)
		if (member.kind !== "read" && member.kind !== "paged") {
			return assert.fail(`${readMember(place)} serves a read, not a ${member.kind}`)
		}
		const expected = Rec.fromEntries(
			Arr.map(expectedRoutes(read), (e) => {
				const table = defined(live.installed.plan.tables[relationName(e.relation)], "a table")
				return [
					table.name.name,
					Rec.fromEntries(
						Arr.map(e.routes, (field) => [
							defined(
								Option.getOrUndefined(Arr.findFirst(table.columns, (col) => col.field === field)),
								`${table.relation}.${field}`
							).column,
							field
						])
					)
				] as const
			})
		)
		assert.deepEqual(
			member.read.live,
			Rec.isEmptyRecord(expected) ? { kind: "constant" } : { kind: "routed", footprint: expected },
			`${readMember(place)} (${Formatter.format(read)}) routes as its program fixes its parameter`
		)
	}
}

/**
 * Notifications no holder of the live secret sealed, sent on the fan-out channel as any session may send them: for each
 * subscription that binds a group, the plaintext route key of its group in a relation it reads, as an unsealed fan-out
 * would spell it (live/notify.ts), and every sealed payload the listener has received so far with one character of its
 * text changed, a tampering its seal must refuse.
 */
const forgeries = (
	live: LiveInstallation,
	registered: ReadonlyArray<{ readonly s: LiveSubscription }>,
	received: ReadonlyArray<Notification>
): { readonly payloads: ReadonlyArray<string>; readonly kinds: ReadonlyArray<Feature> } => {
	const plain = Arr.flatMap(registered, ({ s }) => {
		const group = groupOf(s)
		const read = Arr.getUnsafe(live.c.reads, s.read)
		if (group === undefined) {
			return []
		}
		const table = defined(live.installed.plan.tables[relationName(read.relation)], "a table")
		const column = defined(
			Option.getOrUndefined(Arr.findFirst(table.columns, (col) => col.field === "g")),
			`${table.relation}.g`
		)
		return [`${table.name.name}:${column.column}=${group}`]
	})
	const tampered = Arr.map(received, (n) => {
		const characters = Arr.fromIterable(n.payload)
		const at = characters.length >> 1
		return Arr.join(
			Arr.map(characters, (character, i) => (i !== at ? character : character === "A" ? "B" : "A")),
			""
		)
	})
	return {
		payloads: [...plain, ...tampered],
		kinds: [
			...(Arr.isReadonlyArrayNonEmpty(plain) ? ["a forged plaintext notification" as const] : []),
			...(Arr.isReadonlyArrayNonEmpty(tampered) ? ["a tampered sealed notification" as const] : [])
		]
	}
}

layer(Substrate.layer)("a commit's notifications", (it) => {
	it.effect(
		`re-run exactly the subscriptions whose routing values the commit touched, each once, over ${cases} generated histories`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the routing each program's parameters state, restated over the drawn writes"
						},
						suite: "pg/live/routing",
						draw: drawn(liveCaseGen(bounds)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a forged plaintext notification",
								"a tampered sealed notification",
								"a touched and an untouched subscription of one relation",
								"a commit touching several subscriptions",
								"an update moving a row between groups",
								"a direct writer's commit",
								"a grizzle call's commit"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: cases,
						shrink: { kind: "bounded", candidates: 60 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							const live = yield* installLive(c, "live_routing", clusterPool)
							footprintsHold(live)
							yield* Effect.gen(function* () {
								const surfaces = yield* worldSurfaces(live)
								const register = yield* worldRegistrations(live)
								const probe = yield* register(probeMember, { params: {}, facts: {} })
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
									return assert.fail(
										"a world whose reads read its relations installs a live source"
									)
								}
								let fence = 0
								/**
								 * A fence: a Probe row committed after everything before it, the probe awaited until the row's
								 * change marks it, and turned once, its value then holding the row: notifications reach the one
								 * listener in commit order and each is routed as it arrives, so by then every change committed
								 * before the fence has been routed.
								 */
								const fenced = Effect.gen(function* () {
									fence += 1
									yield* commitDirectly(live.writer, [fenceStatement(live.installed.plan, fence)])
									yield* awaitFact(
										Effect.map(probe.state, (state) =>
											state === "marked" ? Option.some(undefined) : Option.none()
										)
									)
									const turned = yield* probe.turn
									assert.ok(
										Option.exists(
											turned,
											(value) => value.at(formOf(RowKey([fence]))) !== undefined
										),
										`the probe's turn after fence ${fence} holds its row`
									)
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
										commit.writer === "psql"
											? "a direct writer's commit"
											: "a grizzle call's commit"
									)
									if (
										Arr.some(writesOf(commit), (w) => w.kind === "update" && w.from.g !== w.to.g)
									) {
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
									const forged = forgeries(live, registered, live.tap.notifications())
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
						}).pipe(Effect.scoped)
				)
			)
	)
})
