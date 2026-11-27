/**
 * A restriction of an attachment's head reaches the attachment's child too, at the head's columns its correlation names
 * (lower/shapes/share/keys.ts restrictionWalk): a node an attachment's head reads and an attachment under it reads again
 * at the head's key is read at that key by both, derived once there, never left the statement's whole and scanned once per
 * head row. Before, the walk entered an attachment's parent alone, so a node read both by the head and inside a nested
 * attachment arrived at fewer reads than it had and was reached by none: qti-pie's ItemSessionControl, which metis's
 * resume (`sitting`) reads at each item session's key for its `control` and again under it for `left`, was derived for
 * every learner's 1.4M item sessions and scanned once per sitting item (34 × 1.4M rows, 6.06M pages; the bar's row 1,
 * cancelled at 20 minutes at its pin).
 *
 * On PostgreSQL 19, a ledger's sittings, item sessions and their controls (attachment-reach.fixtures.ts): Control, a
 * union of a session's item's control and its learner's stage's, read by a sitting's sessions' `control` at each session
 * and again by `left` under it; the read sitting's learner beside a few learners and then a few dozen more, its tables in
 * each pg_class state (test/support/advice.ts PgClassState), the read run under its carried advice once the plan laws
 * hold over it.
 *
 * Oracle: store invariance, the read's scans read no more rows once a few dozen learners more stand beside the sitting's
 * than beside a few, in any pg_class state: the sitting's rows alone enter its work (test/support/judge.ts readWork); and no CTE of its plan is read by one
 * scan, a node the root's query reads once lowered in place there (lower/shapes/share/keyed.ts pushedInto, the readers
 * the root's query lowers), never held for its one read.
 *
 * Features: a read beside few learners and beside many; each pg_class state.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ReachFeature,
	reachGen,
	reachTemplate,
	runReach
} from "#test/pg/lower-shapes/attachment-reach.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A sitting's sessions, each with its control and the attempts it leaves attached, read the sitting's own rows alone
 * however many learners stand beside it, in any pg_class state: both reads of Control are at the session's key.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aNodeAnAttachmentAndOneUnderItReadIsReadAtTheHeadsKey = property.explore(reachGen, {
	needs: { stored: Substrate.rolledBack(reachTemplate) },
	situations: [
		"beside few learners",
		"beside many learners",
		"its tables never vacuumed",
		"its tables counted empty",
		"its tables analyzed",
		"its tables skewed",
		"its tables large"
	] satisfies ReadonlyArray<Reached<ReachFeature>>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runReach(value.installed, connection, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "store invariance: the read's scans read no more rows beside a few dozen learners more than beside a few, in any pg_class state; no CTE of its plan read by one scan"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original:
				"\t\t\t\tdeliver(\n\t\t\t\t\tat,\n\t\t\t\t\tat.child,\n\t\t\t\t\tequalities.flatMap((e) =>\n\t\t\t\t\t\tat.correlation.flatMap((c) =>\n\t\t\t\t\t\t\tc.parent === e.column ? [{ column: c.child, value: e.value }] : []\n\t\t\t\t\t\t)\n\t\t\t\t\t),\n\t\t\t\t\tfalse\n\t\t\t\t)\n",
			replacement: "",
			why: "The walk enters an attachment's parent alone: Control, read by the head's control and again by left under it, arrives at one of its two reads and is reached by neither, so it is the statement's CTE, every learner's sessions' controls, scanned once per session."
		},
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original: "\t\t\tr.readers.filter((reader) => lowered.has(reader)).length > 1 &&\n",
			replacement: "\t\t\tr.readers.length > 1 &&\n",
			why: "A node reached at several reads under the root is held in the root's query wherever its readers stand: Control, read by the head's control and by left under it, whose attachment reads it in its own query, is held for the control's one read, a CTE of one scan per session."
		}
	]
})
