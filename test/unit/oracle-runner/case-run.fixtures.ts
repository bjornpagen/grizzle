/** What the properties of case-run.test.ts read: its spaces. */

import { type Gen, int, map } from "@bjornpagen/testing/gen"

/** A search the property runs inline: the case, in start order, that never finishes. */
export interface Interrupted {
	readonly hangs: number
}

/** What the interrupted search held when it was interrupted: the hanging case alone, or finished cases before it. */
export type Held = "the first case hangs" | "after finished cases"

/** The hanging case's place among the first six cases a search starts. */
export const interruptedGen: Gen<Interrupted> = map(int(0, 5), (hangs): Interrupted => ({ hangs }))
