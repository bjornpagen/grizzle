/** What the properties of exactness.test.ts read: its spaces, models and helpers. */

import type { Surface } from "#test/support/live/system.ts"
import type { CommitSituation, LiveBounds, ReadKind } from "#test/support/live/world.ts"

export type Feature =
	| CommitSituation
	| `a ${ReadKind} read`
	| "a direct writer's commit"
	| "a grizzle call's commit"
	| `a subscription ${Surface}`

export const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 3,
	subscriptions: 4,
	commits: 5,
	writes: 3,
	window: 3
}

export const cases = 24
