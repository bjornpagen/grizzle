/**
 * A region that joins a union by columns another of its occurrences binds, one the statement's values restrict, reads
 * the union per binding, each arm at those columns' values (lower/optimize/cte-policy probesByKey, lower/shapes/region
 * keyedProbes, lower/shapes/union keyedUnion): `LATERAL ((SELECT ... FROM <arm 1> WHERE k = r.k) UNION (...))`, where
 * the whole union was read and joined beside, as PostgreSQL moves no join of its reader into a UNION's arms: edullm's
 * ledger answer read every attempt's outcomes in force, each attempt's snapshot no assertion replaced and its
 * assertions, deduplicated whole and then joined to the call's attempt, 35 ms of 780 at 5,220 attempts and growing
 * with them.
 *
 * The box, exhausted: a write recording the outcomes in force of the call's sessions, a relation parameter, or of every
 * stored attempt, which no value of the call restricts.
 *
 * Oracle: specification, the union read LATERAL with each arm at the call's session where the call's sessions bind it,
 * and read whole beside every stored attempt, whose rows would each read every arm again.
 *
 * Features: by the call's sessions; beside every attempt.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	boxGen,
	type Joined,
	scans,
	statementsOf
} from "#test/unit/lower/shapes/union-probe.fixtures.ts"

/** A region joining a union by columns a restricted occurrence binds reads it per binding, each arm at those values. */
export const aRegionJoiningAUnionByColumnsARestrictedOccurrenceBindsReadsEachArmAtTheirValues =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: ["by the call's sessions", "beside every attempt"],
		check: (_, k: Case<Joined>) => (box) =>
			Effect.sync(() => {
				k.note(box.joined)
				const sql = Arr.join(statementsOf(box), "\n")
				const probed = box.joined === "by the call's sessions"
				assert.equal(
					Str.includes("LATERAL ((SELECT")(sql),
					probed,
					`the outcomes in force ${box.joined}: the union ${probed ? "read per session, LATERAL" : "read whole"}\n${sql}`
				)
				assert.equal(
					scans(sql, "snapshot"),
					1,
					`the outcomes in force ${box.joined}: Snapshot read in the union's one arm\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the union read LATERAL, each arm at the call's session, where the call's sessions bind it; whole beside every attempt"
		},
		box: "a write recording the outcomes in force, a union of two rules, of the call's sessions or of every stored attempt",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\treturn at.kind === "Group" || at.kind === "Union"\n',
				replacement: '\treturn at.kind === "Group"\n',
				why: "No union is read per key, as before: the region reads the outcomes in force whole, every session's, and joins the call's sessions beside."
			}
		]
	})
