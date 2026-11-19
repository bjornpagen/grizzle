/** What the properties of reconnect.test.ts read: its spaces, models and helpers. */

import { boolean, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { CallError } from "#compiler/live/index.ts"
import type { Surface } from "#test/support/live/system.ts"
import type { LiveBounds } from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { pickGen } from "#test/support/pick.ts"
import type { FrontendMessage } from "#test/support/wire-tap.ts"

/** Where the dropped subscription is dropped: in its first flight, after a commit returns, or after one settled. */
export type DropPoint = "in its first flight" | "right after a commit" | "after a commit settled"

export type Feature =
	| `a drop ${DropPoint}`
	| `a subscription ${Surface} dropped`
	| "a drop before its first answer"
	| "a drop after COMMIT's answer"
	| "a drop part way through its first flight"

export const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 2,
	subscriptions: 3,
	commits: 4,
	writes: 2,
	window: 3
}

export const cases = 24

/** A drop: its point, the subscription dropped by pick, its surface, and a pick of the answers or the commit it follows. */
interface Drop {
	readonly point: DropPoint
	readonly subscription: number
	readonly overHttp: boolean
	readonly at: number
}

export const dropGen: Gen<Drop> = (source) => ({
	point: source.draw(
		weighted<DropPoint>([
			[2, () => "in its first flight"],
			[1, () => "right after a commit"],
			[1, () => "after a commit settled"]
		])
	),
	subscription: source.draw(pickGen),
	overHttp: source.draw(boolean),
	at: source.draw(pickGen)
})

/** What the dropped call's first flight came to: held by the gate, a ready past it, or the call's end. */
export type FirstFlight =
	| { readonly kind: "held" }
	| { readonly kind: "readied" }
	| { readonly kind: "ended"; readonly error: CallError }

/** Whether two frontend messages are one: the same type, statement, text and parameters. */
export const sameMessage = (
	a: FrontendMessage | undefined,
	b: FrontendMessage | undefined
): boolean =>
	a !== undefined &&
	b !== undefined &&
	a.type === b.type &&
	a.name === b.name &&
	a.text === b.text &&
	Arr.makeEquivalence((x: string | null, y: string | null) => x === y)(a.params, b.params)

/** A pool of one session, which every call of the login runs on in turn. */
export const oneSession = Object.freeze({ ...clusterPool, min: 1, max: 1 })
