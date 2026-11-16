/**
 * Where the live leader places a decoded transaction in the snapshot it reads (engine live/replication.ts parseSnapshot,
 * placement): pgoutput's Begin carries a transaction's id in 32 bits, and pg_current_snapshot states its horizon (xmax)
 * and its running ids (xip) in 64, so the leader widens the id to the full one nearest the horizon before it compares,
 * as PostgreSQL's TransactionIdPrecedes compares 32-bit ids, every id it still compares within 2^31 of the next one.
 *
 * Each case draws a snapshot, its horizon in a drawn epoch at a drawn low half (an epoch's first and last ids among
 * them), ids it holds running below it, and a transaction's full id within 2^31 of it and no lower than PostgreSQL's
 * first normal id, 3: past the horizon, one of the running ids, or another below it, in the horizon's epoch or the one
 * either side. The snapshot is written as pg_snapshot's text and read back by parseSnapshot, and the transaction placed
 * by its low 32 bits.
 *
 * Property: the placement is the one the full ids state, as XidInMVCCSnapshot places an id: `ahead` at or past the
 * horizon, `running` where the snapshot holds it running, else `seen`.
 *
 * The oracle is that statement over the full 64-bit ids, which never wrap.
 *
 * Features: an id ahead of the horizon, an id running in the snapshot, an id the snapshot sees, an id in another epoch
 * than the horizon's.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { type Placement, parseSnapshot, placement } from "#compiler/live/replication.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A snapshot and a transaction, each id an offset from the horizon, which is `epoch` 2^32 plus `low`. */
interface Placed {
	readonly epoch: number
	readonly low: number
	readonly running: ReadonlyArray<number>
	readonly id: number
}

type Feature =
	| "an id ahead of the horizon"
	| "an id running in the snapshot"
	| "an id the snapshot sees"
	| "an id in another epoch than the horizon's"

const span = 2 ** 32

const half = 2 ** 31

/** PostgreSQL's first normal transaction id (transam.h FirstNormalTransactionId). */
const firstNormal = 3

/** The full horizon of `placed`. */
const horizonOf = (placed: Pick<Placed, "epoch" | "low">): bigint =>
	BigInt(placed.epoch) * BigInt(span) + BigInt(placed.low)

/** The least offset from `horizon` an id may stand at: within 2^31 of it, and no lower than the first normal id. */
const leastOffset = (horizon: bigint): number =>
	horizon - BigInt(half - 1) < BigInt(firstNormal) ? firstNormal - Number(horizon) : -(half - 1)

const placedGen: Gen<Placed> = (source) => {
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
const snapshotText = (horizon: bigint, running: ReadonlyArray<bigint>): string => {
	const sorted = Arr.sort(Arr.dedupe(running), Order.BigInt)
	const xmin = sorted[0] ?? horizon
	return `${xmin}:${horizon}:${Arr.join(Arr.map(sorted, String), ",")}`
}

describe("a decoded transaction placed in the leader's snapshot", () => {
	it.effect(
		"stands where its full id stands: ahead at or past the horizon, running where held running, else seen",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "XidInMVCCSnapshot's placement over full 64-bit ids"
						},
						suite: "unit/live/placement",
						draw: drawn(placedGen),
						literal: Formatter.format,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"an id ahead of the horizon",
								"an id running in the snapshot",
								"an id the snapshot sees",
								"an id in another epoch than the horizon's"
							],
							{ cases: 400, sense: notesOnly }
						)
					},
					(placed, c) =>
						Effect.sync(() => {
							const horizon = horizonOf(placed)
							const running = Arr.map(placed.running, (offset) => horizon + BigInt(offset))
							const full = horizon + BigInt(placed.id)
							const expected: Placement =
								full >= horizon ? "ahead" : running.includes(full) ? "running" : "seen"
							c.note(
								expected === "ahead"
									? "an id ahead of the horizon"
									: expected === "running"
										? "an id running in the snapshot"
										: "an id the snapshot sees"
							)
							if (full / BigInt(span) !== horizon / BigInt(span)) {
								c.note("an id in another epoch than the horizon's")
							}
							const text = snapshotText(horizon, running)
							const read = parseSnapshot(text)
							assert.ok(read.ok, `pg_snapshot's text ${text} reads as a snapshot`)
							assert.equal(
								placement(read.value, Number(full % BigInt(span))),
								expected,
								`transaction ${full} in snapshot ${text}`
							)
						})
				)
			)
	)
})
