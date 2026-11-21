/** What the properties of cancel-race.test.ts read: its spaces. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"

/** Where the interruption's first CancelRequest lands (see the header). */
type Lands = "before the read" | "during the wait" | "unreachable"

/** How the flight runs its statements: each alone, or in one transaction. */
type Runner = "apart" | "transaction"

interface RaceCase {
	readonly runner: Runner
	/** The inserts before the locking statement. */
	readonly before: number
	/** The inserts after the locking statement. */
	readonly after: number
	readonly lands: Lands
}

const landings = ["before the read", "during the wait", "unreachable"] as const

const runners = ["apart", "transaction"] as const

/**
 * Every case: each runner, up to two inserts on either side of the locking statement, and each landing. A request that
 * lands before the read is missed, and the next round starts at the server's next answer, so its flight answers before
 * the locking statement: a transaction its BEGIN, statements apart at least one insert.
 */
export const raceCases: Gen<RaceCase> = (source) => {
	const runner = source.draw(element(runners))
	const lands = source.draw(element(landings))
	const least = lands === "before the read" && runner === "apart" ? 1 : 0
	return {
		runner,
		before: source.draw(int(least, 2)),
		after: source.draw(int(0, 2)),
		lands
	}
}

export type RaceFeature = Lands | Runner
