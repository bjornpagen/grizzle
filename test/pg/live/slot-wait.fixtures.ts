/** What slot-wait.test.ts reads: its cases, the slot checks a tap's sessions sent, and the case itself. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Order } from "effect"
import { assert } from "#test/support/assert.ts"
import { worldSurfaces } from "#test/support/live/calls.ts"
import { installLive } from "#test/support/live/harness.ts"
import { standingOn } from "#test/support/live/standing.ts"
import {
	type LiveBounds,
	type LiveCase,
	liveCaseGen,
	probeMember
} from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import type { WireWindow } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The surfaces a case's read registers on: a Db's watch in process, or an HTTP read's once, its watch's first value. */
const surfaces = ["in process", "over HTTP"] as const

export type SlotWaitFeature = `a read ${(typeof surfaces)[number]}`

/** A case: the live world installed, and the surface its read registers on. */
export interface SlotWaitCase {
	readonly world: LiveCase
	readonly surface: (typeof surfaces)[number]
}

/**
 * The least live world each part of a world admits: the slot's wait is the installation's, whatever its reads, rows
 * and history, and the probe every world holds is the read that waits.
 */
const least: LiveBounds = {
	groups: 1,
	orders: 1,
	values: 1,
	keys: 1,
	rows: 1,
	reads: 1,
	subscriptions: 1,
	commits: 1,
	writes: 1,
	window: 1
}

export const slotWaitGen: Gen<SlotWaitCase> = (source) => ({
	world: source.draw(liveCaseGen(least)),
	surface: source.draw(element(surfaces))
})

/**
 * The slot checks each session sent, by session: every Bind of the statement the session last parsed under the name
 * it binds, where that Parse's text is the check's, `check`.
 */
const slotChecks = (sessions: ReadonlyArray<WireWindow>, check: string): ReadonlyArray<number> =>
	Arr.map(sessions, (session) => {
		const parsed = new Map<string, string>()
		let checks = 0
		for (const message of session.frontend) {
			if (message.type === "P") {
				parsed.set(message.name, message.text)
			} else if (message.type === "B" && parsed.get(message.name) === check) {
				checks++
			}
		}
		return checks
	})

/**
 * Whether the listener's slot check has been answered: a ReadyForQuery came after a Bind of `check` on the session
 * that parsed the LISTEN, `listen`, which the leader's sessions never send, so the hold outlasts the listener's first
 * check whichever of the two checks first.
 */
const listenerChecked =
	(check: string, listen: string) =>
	(sessions: ReadonlyArray<WireWindow>): boolean =>
		Arr.some(sessions, (session) => {
			const parsed = new Map<string, string>()
			let bound = false
			for (const event of session.events) {
				if (event.side === "backend") {
					if (bound && event.message.type === "Z") {
						return Arr.some([...parsed.values()], (text) => text === listen)
					}
					continue
				}
				for (const message of event.messages) {
					if (message.type === "P") {
						parsed.set(message.name, message.text)
					} else if (message.type === "B" && parsed.get(message.name) === check) {
						bound = true
					}
				}
			}
			return false
		})

/**
 * One case (see slot-wait.test.ts): the world installed fresh, its slot's making held up by a transaction holding a
 * transaction id, which PostgreSQL's logical slot waits for; the read registered on its surface, and the hold ended
 * once the listener's first slot check was answered, so that check found no slot; the read standing; then every slot
 * check the case's sessions sent: the leader's one, and the listener's two, before the slot stood and at its `stands`.
 */
export const slotWaitCase = (value: SlotWaitCase, c: Case<SlotWaitFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.note(`a read ${value.surface}`)
			const substrate = yield* Substrate
			const live = yield* installLive(value.world, "slot_wait", clusterPool)
			const source = live.file.file.live
			if (source.kind === "none") {
				return yield* Effect.die(
					`the served file of a world that reads holds no live source\n${Formatter.format(value.world)}`
				)
			}
			const check = source.check.sql
			const holder = yield* substrate.session(ownerSession())
			yield* holder.query("BEGIN", [])
			yield* holder.values("SELECT pg_catalog.pg_current_xact_id()::text", [])
			yield* Effect.gen(function* () {
				const reached = yield* worldSurfaces(live)
				const calls = value.surface === "in process" ? reached.inProcess : reached.http
				const standing = yield* Effect.forkChild(
					standingOn(calls, probeMember, { params: {}, facts: {} })
				)
				yield* live.tap.until(listenerChecked(check, source.listen.sql))
				yield* holder.query("ROLLBACK", [])
				yield* Fiber.join(standing)
			}).pipe(withLayer(live.layer))
			const checks = Arr.filter(slotChecks(live.tap.sessions(), check), (n) => n > 0)
			assert.deepEqual(
				Arr.sort(checks, Order.Number),
				[1, 2],
				"the leader checks the slot once, and the listener once before the slot stood and once at its stands, however long the slot took"
			)
		})
	)
