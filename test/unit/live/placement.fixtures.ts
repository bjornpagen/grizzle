/** What the properties of placement.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"

/** A snapshot and a transaction, each id an offset from the horizon, which is `epoch` 2^32 plus `low`. */
interface Placed {
	readonly epoch: number
	readonly low: number
	readonly running: ReadonlyArray<number>
	readonly id: number
}

export type Feature =
	| "an id ahead of the horizon"
	| "an id running in the snapshot"
	| "an id the snapshot sees"
	| "an id in another epoch than the horizon's"

export const span = 2 ** 32

const half = 2 ** 31

/** PostgreSQL's first normal transaction id (transam.h FirstNormalTransactionId). */
const firstNormal = 3

/** The full horizon of `placed`. */
export const horizonOf = (placed: Pick<Placed, "epoch" | "low">): bigint =>
	BigInt(placed.epoch) * BigInt(span) + BigInt(placed.low)

/** The least offset from `horizon` an id may stand at: within 2^31 of it, and no lower than the first normal id. */
const leastOffset = (horizon: bigint): number =>
	horizon - BigInt(half - 1) < BigInt(firstNormal) ? firstNormal - Number(horizon) : -(half - 1)

export const placedGen: Gen<Placed> = (source) => {
	const epoch = source.draw(element([0, 1, 7, span - 2]))
	const least = epoch === 0 ? firstNormal + 1 : 0
	const low = source.draw(
		oneOf([element([least, half - 1, half, half + 1, span - 1]), int(least, span - 1)])
	)
	const below = leastOffset(horizonOf({ epoch, low }))
	const running = source.draw(
		array(oneOf([int(Math.max(below, -2), -1), int(below, -1)]), { min: 0, max: 4 })
	)
	const id = source.draw(
		oneOf([
			int(0, 2),
			int(below, -1),
			int(below, half - 1),
			...(Arr.isReadonlyArrayNonEmpty(running) ? [element(running)] : [])
		])
	)
	return { epoch, low, running, id }
}

/** pg_snapshot's text of a snapshot of `horizon` and `running`, its xmin the least of them. */
export const snapshotText = (horizon: bigint, running: ReadonlyArray<bigint>): string => {
	const sorted = Arr.sort(Arr.dedupe(running), Order.BigInt)
	const xmin = sorted[0] ?? horizon
	return `${xmin}:${horizon}:${Arr.join(Arr.map(sorted, String), ",")}`
}
