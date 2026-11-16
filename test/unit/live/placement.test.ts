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

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { parseSnapshot, type Placement, placement } from "#compiler/live/replication.ts"
import { assert } from "#test/support/assert.ts"
import {
	type Feature,
	horizonOf,
	placedGen,
	snapshotText,
	span
} from "#test/unit/live/placement.fixtures.ts"

/**
 * A decoded transaction placed in the leader's snapshot stands where its full id stands: ahead at or past the horizon,
 * running where held running, else seen.
 *
 * Budget: its suite's count before the conversion (unit/live/placement: 400 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aDecodedTransactionPlacedInTheLeadersSnapshotStandsWhereItsFullIdStandsAheadAtOrPastTheHorizonRunningWhereHeldRunningElseSeen =
	property.explore(placedGen, {
		needs: {},
		situations: [
			"an id ahead of the horizon",
			"an id running in the snapshot",
			"an id the snapshot sees",
			"an id in another epoch than the horizon's"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (placed) =>
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
			}),
		oracle: {
			kind: "specification",
			name: "XidInMVCCSnapshot's placement over full 64-bit ids"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/replication.ts",
				original: '\tif (full >= snapshot.horizon) {\n\t\treturn "ahead"\n\t}\n',
				replacement: "",
				why: "placement places a transaction by the snapshot's running set alone, so one at or past its horizon reads as seen."
			}
		]
	})
