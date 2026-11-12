import { Effect, type Scope } from "effect"
import {
	ListenerLost,
	SlotAbsent,
	SourceInvalidated,
	SourceMigrated
} from "#adapter/errors/failures.ts"
import {
	type Candidacy,
	candidacy,
	LeaderFailed,
	alone,
	onlyCell,
	secretOf,
	trueText
} from "#adapter/live/leader.ts"
import type { ChangeSink, ChangeSource } from "#adapter/live/source.ts"
import { preparedStatement } from "#adapter/wire/batch.ts"
import { connectListener, type LoginConnection } from "#adapter/wire/session.ts"
import { type LiveSecret, openPayload, textParam } from "#compiler/plan/runtime.ts"
import type { ServedLive, ServedSession } from "#compiler/plan/serve.ts"

/**
 * The installation's fan-out as a change source (live/source.ts ChangeSource), one per process's live source, built in
 * its scope (pool/live.ts): a listening session of the installation's decoder login, outside any pool (wire/session.ts
 * connectListener), on the installation's channel, and the process's candidacy for the installation's leader
 * (live/leader.ts), which a source's open starts where none runs, in the live source's scope, and whose failure loses
 * the source it last opened.
 *
 * An open reads the installation's secret, sends the LISTEN, then checks the slot: a slot that does not stand refuses
 * the open, since a read begun before the slot stands could miss a change no slot decodes; one that stands means every
 * change committed from then on is decoded, and its keys fanned out once visible (live/leader.ts), which is the
 * source's contract. Each payload of the channel is opened under the secret: one that does not open is no sender's of
 * the installation, and is dropped, so no forged payload names a key; each notification of one that opens is routed,
 * `invalidated` losing the source with SourceInvalidated and `migrated` with SourceMigrated, which ends every live read
 * of the layer, a constant read's as a routed one's. The session's end loses it with ListenerLost. The source
 * moves only forward, from opening to listening to over, and its one loss is the first.
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

/** The fan-out's change source, in the layer's scope (see the header). */
export const fanoutSource = (fanout: Fanout): Effect.Effect<ChangeSource, never, Scope.Scope> =>
	Effect.map(Effect.scope, (layer) => {
		const leader: { running: boolean; sink: ChangeSink | undefined } = {
			running: false,
			sink: undefined
		}
		const lead = Effect.suspend(() => {
			if (leader.running) {
				return Effect.void
			}
			leader.running = true
			return Effect.asVoid(
				Effect.forkIn(
					Effect.catch(candidacy(fanout.candidacy), (reason) =>
						Effect.sync(() => {
							leader.running = false
							leader.sink?.lost(new LeaderFailed({ reason }))
						})
					),
					layer
				)
			)
		})
		const slot = textParam(fanout.candidacy.slot)
		return {
			open: (sink) =>
				Effect.gen(function* () {
					leader.sink = sink
					yield* lead
					const state: {
						current:
							| { readonly kind: "opening" }
							| { readonly kind: "listening"; readonly secret: LiveSecret }
							| { readonly kind: "over" }
					} = { current: { kind: "opening" } }
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
										case "invalidated":
											lose(new SourceInvalidated())
											return
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
						state.current = { kind: "listening", secret }
					}
					yield* alone(session, preparedStatement(fanout.source.listen, []))
					const checked = yield* alone(session, preparedStatement(fanout.source.check, [slot]))
					if (onlyCell(checked) !== trueText) {
						return yield* new SlotAbsent()
					}
				})
		}
	})
