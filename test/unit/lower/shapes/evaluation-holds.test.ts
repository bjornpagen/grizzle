/**
 * A fold correlated to a call's parent row, which several of the call's rows arguments read, is computed once per
 * parent row in the call's evaluation's query and read there by every argument (lower/optimize/cte-policy holderOf, rule
 * 3b, whose holders are a region and a call's evaluation; restrictedWithin, which counts a value of the outer row the
 * fold is evaluated for as a restriction, as a parameter is one): `LATERAL (WITH r AS MATERIALIZED (<the fold at the
 * parent's sitting>) SELECT ... FROM machine(ARRAY(... r ...), ARRAY(... r ...)))`, where each argument read the fold per
 * key of its own values and spelled it again: edullm's decideStage read-back evaluated attempt_marks_of per sitting, and
 * its 16 rows arguments read the sitting's latest attempts at 162 places, the 1.45 MB statement planning in 466 MB on an
 * empty database. The evaluation is a boundary: its host places its query anywhere (the parent's rows' CTE here), so
 * nothing its arguments read is held by a region outside it.
 *
 * The box, exhausted: one to three of machine's three arguments read the sittings' latest attempts, each a union of one
 * or two rules over them, one to six reads of the fold, every read importing one fold or a factory's copy of it, all
 * of one Description identity, which the checker reads as one query (check/session.ts ResolvedImports): edullm's ledger
 * builds the graded attempts anew at each argument, where one fold object held in the fixture and not in the take; and
 * the rule that calls machine reading the fold beside the call or not, a read outside the call's evaluation, as each
 * of edullm's mark reads reads the latest attempts beside attempt_marks_of, where no holder dominates every read and
 * the evaluation holds the fold for the reads inside it (cte-policy holderOf, evaluationAlone).
 *
 * Oracle: specification: the statement scans Attempt once inside the evaluation, whatever the reads of the fold there,
 * and once more for the read beside the call, which finds no table of the evaluation open and reads the fold where it
 * stands.
 *
 * Features: a read; several reads; one object; a factory per read; every read inside the call; a read beside it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	boxGen,
	optimizedOf,
	readsOf,
	scans
} from "#test/unit/lower/shapes/evaluation-holds.fixtures.ts"

type Feature =
	| "a read"
	| "several reads"
	| "one object"
	| "a factory per read"
	| "every read inside the call"
	| "a read beside the call"

/** A fold correlated to a call's parent row is computed once per parent row, however many arguments read it. */
export const aFoldACallsArgumentsReadAtItsParentRowIsComputedOncePerParentRow = property.exhaust(
	finite(boxGen),
	{
		needs: {},
		situations: [
			"a read",
			"several reads",
			"one object",
			"a factory per read",
			"every read inside the call",
			"a read beside the call"
		],
		check: (_, k: Case<Feature>) => (box) =>
			Effect.sync(() => {
				const reads = readsOf(box)
				k.note(reads === 1 ? "a read" : "several reads")
				k.note(box.copies)
				k.note(box.beside ? "a read beside the call" : "every read inside the call")
				const sql = optimizedOf(box)
				assert.equal(
					scans(sql, "attempt"),
					box.beside ? 2 : 1,
					`${box.reading} arguments reading the latest attempts, ${box.rules} rules each, ${reads} reads of ${box.copies === "one object" ? "one fold" : "a factory's folds"}${box.beside ? " and one beside the call" : ""}: Attempt's scans\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "Attempt scanned once inside the call's evaluation, the fold computed once per parent row whatever its reads there, and once more for a read beside the call"
		},
		box: "one to three of machine's arguments reading the sittings' latest attempts, one or two rules each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					"\t\treturn innermost !== undefined && evaluationSees(innermost, read) ? innermost : undefined\n",
				replacement: "\t\treturn undefined\n",
				why: "No call's evaluation holds a CTE, as before: the fold its arguments share is correlated and no region inside the evaluation dominates its reads, so it is inlined at each, and Attempt is scanned once per read."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\tif (lies.size > 0) {\n\t\t\treturn evaluationOf(lies, read)\n\t\t}\n",
				replacement: "",
				why: "An evaluation is no boundary: the fold is held by the parent's attachment's region, outside the evaluation, whose host places it in the parent's rows' CTE, so the arguments read a CTE out of scope and the read does not compile."
			},
			{
				file: "packages/engine/src/check/session.ts",
				original:
					"\tget(q: InferredQuery): ResolvedQuery | undefined {\n\t\treturn this.#resolved.get(this.#identityOf(q))\n\t}\n\n\tset(q: InferredQuery, walked: ResolvedQuery): void {\n\t\tthis.#resolved.set(this.#identityOf(q), walked)\n\t}\n",
				replacement:
					"\treadonly #byObject = new WeakMap<InferredQuery, ResolvedQuery>()\n\n\tget(q: InferredQuery): ResolvedQuery | undefined {\n\t\treturn this.#byObject.get(q)\n\t}\n\n\tset(q: InferredQuery, walked: ResolvedQuery): void {\n\t\tthis.#byObject.set(q, walked)\n\t}\n",
				why: "Each Description object is a query of its own, as it was: a factory's folds are a node at each read, none read twice, so no evaluation holds one, and Attempt is scanned once per read."
			},
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\treturn holder === undefined ? build() : this.withHeldCtes(holder, build)\n",
				replacement: "\t\treturn build()\n",
				why: "The evaluation's query opens no table: every argument's read of the held fold finds none and reads it inline, and Attempt is scanned once per read."
			}
		]
	}
)
