import { Cause, Deferred, Effect, Exit, Option, Result, type Scope } from "effect"
import { ListenerLost, SourceInvalidated, SourceMigrated } from "#adapter/errors/failures.ts"
import {
	type Candidacy,
	candidacy,
	LeaderDied,
	LeaderFailed,
	type LeaderReason,
	alone,
	secretOf,
	slotCheckOf
} from "#adapter/live/leader.ts"
import type { ChangeSink, ChangeSource, SourceRefusal } from "#adapter/live/source.ts"
import { preparedStatement } from "#adapter/wire/batch.ts"
import { connectListener, type LoginConnection } from "#adapter/wire/session.ts"
import {
	type LiveSecret,
	openPayload,
	textParam,
	type WalPosition
} from "#compiler/plan/runtime.ts"
import type { ServedLive, ServedSession } from "#compiler/plan/serve.ts"

/**
 * The installation's fan-out as a change source (live/source.ts ChangeSource), one per process's live source, built in
 * its scope (pool/live.ts): a listening session of the installation's decoder login, outside any pool (wire/session.ts
 * connectListener), on the installation's channel, and the process's candidacy for the installation's leader
 * (live/leader.ts), which a source's open starts where none runs, in the live source's scope, and whose end, of any
 * kind, loses the source it last opened (leading).
 *
 * An open reads the installation's secret, sends the LISTEN, then checks the slot: one that stands means every change
 * committed from then on is decoded, and its keys fanned out once visible (live/leader.ts), which is the source's
 * contract. A slot that does not stand yet holds the open, since a read begun before the slot stands could miss a change
 * no slot decodes: it waits for the next `stands` a leader fans out once it holds the slot, the process's own candidacy
 * among them, which the open starts where none runs, and checks again. The LISTEN comes before each check, so a slot
 * made after a check is one whose `stands` the open hears, and the open waits on nothing but that: it checks the slot
 * once, and once more for each `stands` it hears, however long the slot takes to make. A copy of `stands` is a check
 * more, never an open on a slot that does not stand, since the check, not the notification, decides. Each payload of the channel is opened under the secret: one that does not open is no sender's of
 * the installation, and is dropped, so no forged payload names a key; each notification of one that opens is routed,
 * `invalidated` losing the source with SourceInvalidated and `migrated` with SourceMigrated, which ends every live read
 * of the layer, a constant read's as a routed one's. The session's end loses it with ListenerLost. The source
 * moves only forward, from opening to listening to over, and its one loss is the first.
 *
 * A seal proves who sealed a payload, never when: a copy of a payload the leader sealed opens again, sent by any session
 * that may NOTIFY on the channel (pg_notify is PUBLIC, and LISTEN lets a session of the database read every payload), so
 * a copy is routed as the original was. That is safe, since it only ever over-marks:
 * - a key's copy marks only the subscriptions a past commit really touched, and a mark is only ever set by a key
 *   (subscriptions.ts markSubscription) and cleared only by the subscription's own re-read, which begins after the
 *   clear (rerun), so a copy costs an extra re-read that diffs empty, and never clears or skips a mark;
 * - a copy of `invalidated` loses only a source standing at or before the position it names (heardInvalidation), a
 *   source the original lost too, never one on a slot made since;
 * - a copy of `migrated` ends every live read `stale` once more, which its client answers by reading again.
 * No copy can make a read miss a change: each fails closed.
 *
 * No ready is lost inside the process once a change's key reaches the listener, along every path from a read's
 * registration to its ready (live/subscriptions.ts):
 * - a subscription enters its generation's index (addRoutes) once the generation opened and before its first run
 *   begins, so a change its first run's snapshot misses commits after that snapshot, is fanned out only once visible,
 *   and so reaches the index after the subscription is in it; a key routed before then names a change the first run
 *   reads;
 * - a mark is only set (markSubscription) and only cleared at the start of the subscription's own re-read (rerun),
 *   before that re-read takes its snapshot, so a key routed during the re-read marks it again and the next turn reads
 *   again; a re-read refused or interrupted marks it again itself;
 * - a waiting stream (settled) is woken by every mark and every end, and its wait is installed only when its state is
 *   clean, in the same synchronous step that reads it; a registration's `changes` is taken once, so its one consumer
 *   is the subscription's one waiter, and a second, which would take the first's place, cannot exist;
 * - `changes` begins only after `initial` ended (Stream.concat), which records the value every turn diffs from, and a
 *   turn that reads the same value holds it and waits again, emitting nothing to lose;
 * - a generation lost ends every member with its error, so a read ends rather than waits; a listener's end loses its
 *   generation (ListenerLost).
 * So a read that waits with every session idle and the slot confirmed to the end of the WAL waits on something other
 * than this process's routing: a key the listener never received, or a consumer that stopped pulling.
 *
 * What the source runs with: the decoder login's connection and its sessions' texts, the installation's live source,
 * and the candidacy each process runs for its leader.
 */
export interface Fanout {
	readonly connection: LoginConnection
	readonly session: ServedSession
	readonly source: Extract<ServedLive, { readonly kind: "source" }>
	readonly candidacy: Candidacy
}

/**
 * The process's leadership of the installation: whether a candidacy runs, and the source it reports its end to, the one
 * a read last opened.
 */
export interface Leadership {
	running: boolean
	sink: ChangeSink | undefined
}

/** What a candidacy's end comes to: its failure's reason, or LeaderDied for a defect or an interruption. */
const endedBy = (exit: Exit.Exit<never, LeaderReason>): LeaderReason =>
	Exit.isSuccess(exit)
		? exit.value
		: Result.match(Cause.findError(exit.cause), {
				onSuccess: (reason) => reason,
				onFailure: (cause) => new LeaderDied({ cause })
			})

/**
 * `run`, a candidacy, started in `scope` where none runs, and nothing where one does. The leadership is taken from the
 * moment it starts until its fiber ends, by its own exit, which takes it back whatever the end: a failure, a defect or
 * an interruption, each reported to the source the leadership last served as LeaderFailed (endedBy), so every read
 * waiting on it ends with that typed outcome and the next open starts another candidacy. A fiber the scope never runs,
 * one forked into a scope already closing, leaves it taken; that scope's source serves no read again.
 */
export const leading = (
	leadership: Leadership,
	run: Effect.Effect<never, LeaderReason>,
	scope: Scope.Scope
): Effect.Effect<void> =>
	Effect.suspend(() => {
		if (leadership.running) {
			return Effect.void
		}
		leadership.running = true
		return Effect.asVoid(
			Effect.forkIn(
				Effect.exit(
					Effect.onExit(run, (exit) =>
						Effect.sync(() => {
							leadership.running = false
							leadership.sink?.lost(new LeaderFailed({ reason: endedBy(exit) }))
						})
					)
				),
				scope
			)
		)
	})

/**
 * What a listener knows of the slot its source stands on: `unchecked` until its open's slot check answers, with the
 * latest invalidation it heard meanwhile; `checked`, the position the slot stood at when it answered, the incarnation
 * the source stands on (live/notify.ts WalPosition).
 */
export type SlotSeen =
	| { readonly kind: "unchecked"; readonly heard: Option.Option<WalPosition> }
	| { readonly kind: "checked"; readonly at: WalPosition }

/** What a listener's source comes to after an event: what it knows of its slot, and whether its source is lost. */
export interface SlotTurn {
	readonly seen: SlotSeen
	readonly lost: boolean
}

/**
 * Whether an invalidation of `before`, the WAL position its leader read where it found no slot standing, names the
 * slot a source saw standing at `at`: that slot stood at or before it. A slot made since stands past it, so its
 * sources are none an earlier slot's invalidation names.
 */
const invalidates = (before: WalPosition, at: WalPosition): boolean => at <= before

/**
 * An invalidation of `before` heard: before the slot check, kept, the latest of those heard, for the check to judge;
 * after it, it loses the source exactly where it names the slot the source stands on (invalidates).
 */
export const heardInvalidation = (seen: SlotSeen, before: WalPosition): SlotTurn => {
	switch (seen.kind) {
		case "unchecked":
			return {
				seen: {
					kind: "unchecked",
					heard: Option.some(
						Option.match(seen.heard, {
							onNone: () => before,
							onSome: (earlier) => (earlier > before ? earlier : before)
						})
					)
				},
				lost: false
			}
		case "checked":
			return { seen, lost: invalidates(before, seen.at) }
	}
}

/**
 * The slot check found the slot standing at `at`: the source stands on it, and is lost already where an invalidation
 * heard before the check names it.
 */
export const checkedSlot = (
	seen: Extract<SlotSeen, { readonly kind: "unchecked" }>,
	at: WalPosition
): SlotTurn => ({
	seen: { kind: "checked", at },
	lost: Option.exists(seen.heard, (before) => invalidates(before, at))
})

/** The fan-out's change source, in the layer's scope (see the header). */
export const fanoutSource = (fanout: Fanout): Effect.Effect<ChangeSource, never, Scope.Scope> =>
	Effect.map(Effect.scope, (layer) => {
		const leader: Leadership = { running: false, sink: undefined }
		const lead = leading(leader, candidacy(fanout.candidacy), layer)
		const slot = textParam(fanout.candidacy.slot)
		return {
			open: (sink) =>
				Effect.gen(function* () {
					leader.sink = sink
					yield* lead
					const state: {
						current:
							| { readonly kind: "opening" }
							| { readonly kind: "listening"; readonly secret: LiveSecret; readonly seen: SlotSeen }
							| { readonly kind: "over" }
					} = { current: { kind: "opening" } }
					/** Completed by the next `stands` heard: the open's wait for a slot that did not stand at its check. */
					const stands = { next: Deferred.makeUnsafe<void>() }
					const lose = (reason: ListenerLost | SourceInvalidated | SourceMigrated): void => {
						if (state.current.kind !== "over") {
							state.current = { kind: "over" }
							sink.lost(reason)
						}
					}
					const session = yield* connectListener(
						{ ...fanout.connection, controls: fanout.session },
						{
							notified: (payload) => {
								const current = state.current
								if (current.kind !== "listening" || payload === undefined) {
									return
								}
								const opened = openPayload(current.secret, payload)
								if (!opened.ok) {
									return
								}
								for (const notification of opened.value) {
									switch (notification.kind) {
										case "invalidated": {
											const listening = state.current
											if (listening.kind !== "listening") {
												return
											}
											const turn = heardInvalidation(listening.seen, notification.before)
											if (turn.lost) {
												lose(new SourceInvalidated())
												return
											}
											state.current = { ...listening, seen: turn.seen }
											break
										}
										case "stands":
											Deferred.doneUnsafe(stands.next, Effect.void)
											break
										case "migrated":
											lose(new SourceMigrated())
											return
										case "table":
										case "keyed":
											sink.touched(notification)
									}
								}
							},
							ended: () => {
								lose(new ListenerLost())
							}
						}
					)
					const secret = yield* Effect.flatMap(
						alone(session, preparedStatement(fanout.source.secret, [])),
						secretOf
					)
					if (state.current.kind === "opening") {
						state.current = {
							kind: "listening",
							secret,
							seen: { kind: "unchecked", heard: Option.none() }
						}
					}
					yield* alone(session, preparedStatement(fanout.source.listen, []))
					const standing: Effect.Effect<WalPosition, SourceRefusal> = Effect.gen(function* () {
						const heard = stands.next
						const checked = yield* alone(session, preparedStatement(fanout.source.check, [slot]))
						const check = slotCheckOf(checked)
						if (check.kind === "stands") {
							return check.at
						}
						yield* Deferred.await(heard)
						stands.next = Deferred.makeUnsafe<void>()
						return yield* standing
					})
					const at = yield* standing
					const listening = state.current
					if (listening.kind === "listening" && listening.seen.kind === "unchecked") {
						const turn = checkedSlot(listening.seen, at)
						if (turn.lost) {
							lose(new SourceInvalidated())
						} else {
							state.current = { ...listening, seen: turn.seen }
						}
					}
				})
		}
	})
