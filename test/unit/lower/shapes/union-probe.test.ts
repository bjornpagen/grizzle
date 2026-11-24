/**
 * A region that joins a union by columns another of its occurrences binds, one the statement's values restrict, reads
 * the union at the key set those values give it (lower/shapes/share/keys.ts, magic sets; share/keyed.ts KeyedLowering
 * atKeys, lower/shapes/union keyedUnion): `LATERAL ((SELECT ... FROM <arm 1> WHERE k = p.k) UNION (...))` per key of
 * a DISTINCT key set, where the whole union was read and joined beside, as PostgreSQL moves no join of its reader into a
 * UNION's arms: edullm's ledger answer read every attempt's outcomes in force, each attempt's snapshot no assertion
 * replaced and its assertions, deduplicated whole and then joined to the call's attempt, 35 ms of 780 at 5,220 attempts
 * and growing with them.
 *
 * And a union beside a stored relation alone is read whole, derived once and joined: a stored relation read whole fixes
 * no key. And a union the statement's values restrict already is read as it stands, never at keys, as are its binders:
 * the outcomes in force of the call's latest attempts, the union bound to their sessions beside a fold of them, each
 * restricted by the call's sessions (edullm's grade admission, C1, at 85910d893).
 *
 * The box, exhausted: the outcomes in force written at the call's sessions, a relation parameter, or at the call's
 * latest attempts, or beside every stored attempt, which no value of the call restricts, or read beside every stored
 * attempt by a workload's read.
 *
 * Oracle: specification, the union read LATERAL per key of its key set, each arm at the key, where the call's sessions
 * bind it, and read as it stands where the call's sessions restrict it already or beside every stored attempt.
 *
 * Features: written at the call's sessions; written at the call's latest attempts; written beside every attempt; read
 * beside every attempt.
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
		situations: [
			"written at the call's sessions",
			"written at the call's latest attempts",
			"written beside every attempt",
			"read beside every attempt"
		],
		check: (_, k: Case<Joined>) => (box) =>
			Effect.sync(() => {
				k.note(box.joined)
				const sql = Arr.join(statementsOf(box), "\n")
				const probed = box.joined === "written at the call's sessions"
				assert.equal(
					Str.includes("LATERAL ((SELECT")(sql),
					probed,
					`the outcomes in force ${box.joined}: the union ${probed ? "read per session, LATERAL" : "read as it stands"}\n${sql}`
				)
				assert.equal(
					scans(sql, "snapshot"),
					1,
					`the outcomes in force ${box.joined}: Snapshot read in the union's one arm\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the union read LATERAL, each arm at the call's session, where the call's sessions bind it; as it stands where they restrict it already, and whole beside every attempt"
		},
		box: "the outcomes in force, a union of two rules, written at the call's sessions, at the call's latest attempts or beside every stored attempt, or read beside every stored attempt",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: '\t\t\t(node.kind === "Union" || node.kind === "Group") &&\n',
				replacement: '\t\t\tnode.kind === "Group" &&\n',
				why: "No union a statement lowers in place is read at its keys: the region reads the outcomes in force whole, every session's, and joins the call's sessions beside."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\trestrictedByValues(node) || overComputed(node)\n",
				replacement: "\t\t\t\toverComputed(node)\n",
				why: "A union the statement's values restrict already is read at keys too: the call's latest attempts' outcomes in force are read LATERAL per key, where they are read as they stand."
			}
		]
	})
