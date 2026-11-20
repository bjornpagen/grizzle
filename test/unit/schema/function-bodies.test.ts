/**
 * A declared function's body names the row types its level holds for it, against the rule restated as the oracle: a
 * heading `fn.body` names is one its own arguments or result take rows of or return, or one a function it calls does,
 * each of its own level, whose row types the installation creates before it; any other is refused, MalformedDescription
 * at the function, since its row type may stand in no schema of the level, or stand there for another function alone
 * and go with it.
 *
 * - **Property:** a case draws one to three headings, each field a value or rows or a row of a heading before it, and
 *   one to three functions, each calling functions drawn before it,
 *   whose bodies name headings of the whole case beside the ones their calls' arguments build; the schema is owned.
 *   It owns exactly where every function's every named heading is the content of one in its reach, and is refused
 *   otherwise with MalformedDescription at a function whose body names one beyond its reach.
 * - **Oracle:** the rule restated over the sketch: a function's reach is its own signature's headings and its
 *   callees', and every heading a field of one holds, compared by content, as two headings of the same fields are one.
 * - **Features:** a body naming a heading of its own signature, of a callee's alone, one a field of its reach holds,
 *   and one of none; owned and refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { declarationsGen } from "#test/support/declared-functions.ts"
import {
	bodyNamesOutsideReach,
	type BodySituation,
	ownedFunctions,
	situationsOf
} from "#test/unit/schema/function-bodies.fixtures.ts"

/** A declared function's body names only headings its own signature or a callee's takes, every other refused. */
export const aDeclaredFunctionsBodyNamesOnlyHeadingsItsOwnSignatureOrACalleesTakesEveryOtherRefused =
	property.explore(declarationsGen(true), {
		needs: {},
		situations: [
			"owned",
			"refused",
			"a body naming its own signature's heading",
			"a body naming a callee's heading alone",
			"a body naming a heading beyond its reach",
			"a body naming a heading a field of its reach holds"
		] satisfies ReadonlyArray<Reached<BodySituation>>,
		budget: { runs: 200, steered: 200 },
		check: (_, c: Case<BodySituation>) => (v) =>
			Effect.sync(() => {
				for (const s of situationsOf(v)) {
					c.note(s)
				}
				const { owned, locs } = ownedFunctions(v)
				const outside = bodyNamesOutsideReach(v)
				if (outside.length === 0) {
					assert.equal(owned.ok, true, "a schema whose every body names headings of its reach owns")
					c.note("owned")
					return
				}
				assert.equal(owned.ok, false, "a body naming a heading beyond its reach is refused")
				if (owned.ok) {
					return
				}
				const reason = owned.error.reason
				assert.equal(reason._tag, "MalformedDescription")
				if (reason._tag === "MalformedDescription") {
					assert.ok(
						Arr.some(outside, (name) => locs.get(name)?.label === reason.at.label),
						`the refusal is at a function whose body names a heading beyond its reach: ${Arr.join(outside, ", ")}`
					)
				}
				c.note("refused")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the rule of the headings a body may name, restated over the sketch by content"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/function-own.ts",
				original: "\treturn Result.flatMap(callsHeld(out), bodiesHeld)\n",
				replacement: "\treturn callsHeld(out)\n",
				why: "A body naming a heading no signature of its reach takes owns, and installs naming a row type its level may not hold."
			},
			{
				file: "packages/engine/src/schema/function-own.ts",
				original:
					'\tt.kind === "value" ? [] : [t.heading, ...t.heading.flatMap((f) => headingsOf(f.type))]\n',
				replacement: '\tt.kind === "value" ? [] : [t.heading]\n',
				why: "A body naming a heading a field of its signature's holds rows or a row of is refused, though the installation creates that heading's row type first."
			},
			{
				file: "packages/engine/src/schema/function-own.ts",
				original: "\t\t\t...signatureHeadings(fn.desc),\n",
				replacement: "",
				why: "A body naming a heading its own signature takes, and no callee's, is refused."
			}
		]
	})
