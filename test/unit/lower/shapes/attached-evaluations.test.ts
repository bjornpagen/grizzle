/**
 * A read whose attachments each read one call of a declared function at their parent's values calls it once per
 * parent row (lower/conservative/call/index.ts parentEvaluations, installed for each parent's rows by
 * lower/shapes/index.ts pipelinedQuery): the statement holds the call's evaluation for each distinct value of the parent
 * columns it reads, one MATERIALIZED CTE per evaluation key, and every attachment under those rows reads it at its
 * parent's values; a region whose occurrences read two fields of that call evaluates it no more itself
 * (match-region regionEvaluations). Each attachment's child evaluated the call again: qti-pie's sessionStartOf reads
 * the machine's run of a session's start in each of its 44 attachments, so edullm's sittingItem and servedItem, and
 * metis's sittingRead and memberRead, called the machine 44 times, 15.8 to 23.1 MB of statement planned in 328 to 758 s.
 *
 * The box, exhausted: one, two or three attachments of one session, each reading machine's run at the session's key,
 * every one at the same arguments (one call) or each at its own (a call each), its first field or both in one rule.
 *
 * Oracle: specification: the optimized statement calls machine once where every attachment reads one call, and once
 * per attachment where each reads its own.
 *
 * Features: one call; a call each.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	boxGen,
	type Calls,
	machineCalls,
	optimizedOf
} from "#test/unit/lower/shapes/attached-evaluations.fixtures.ts"

/** A read whose attachments each read one call at their parent's values calls it once per parent row. */
export const aReadWhoseAttachmentsEachReadOneCallAtTheirParentsValuesCallsItOncePerParentRow =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: ["one call", "a call each"],
		check: (_, k: Case<Calls>) => (box) =>
			Effect.sync(() => {
				k.note(box.calls)
				const sql = optimizedOf(box)
				assert.equal(
					machineCalls(sql),
					box.calls === "one call" ? 1 : box.attachments,
					`${box.attachments} attachments, ${box.calls}, ${box.fields}: machine's calls\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one call of machine for the attachments that read one call, one for each that reads its own"
		},
		box: "one, two or three attachments of a session reading machine's run at its key, at one call's arguments or each at its own, one field or two",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\tconst child = this.cx.withEvaluations(evaluations)\n",
				replacement: "\t\tconst child = this.cx\n",
				why: "No host holds an attachment's call for its parent's rows, as before: each attachment's child evaluates it again, so two or three attachments reading one call call machine two or three times."
			},
			{
				file: "packages/engine/src/lower/conservative/match-region/index.ts",
				original:
					"\t\treturn cx.hostedEvaluation(o.source, key, env) === undefined ? [{ occurrence: o, key }] : []\n",
				replacement: "\t\treturn [{ occurrence: o, key }]\n",
				why: "A region reading two fields of the call evaluates it itself though the parent's rows hold it: the statement's audit finds a relation read out of its scope, and the case's read does not compile."
			}
		]
	})
