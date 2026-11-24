/**
 * A statement's nested rows past one Bind message (write/program/staged.ts executionsOf): the statement goes inline
 * while its Bind message, every array of its nested rows written whole, fits the transport, and otherwise its carriers
 * are emptied, filled chunk by chunk, and the staged statement sent, each
 * fill as long as one Bind message carries. The cut is measured from the cells' lengths, none of an array written to
 * measure it.
 *
 * Over drawn nested rows of text, bytes and literal columns, of drawn lengths, beside a placeholder the staged
 * statement keeps, under a drawn message bound:
 *
 * - **The executions are the encoders' own** (oracle: a second implementation, the cut by real encodings): the inline
 *   statement, its arrays written whole by the column's encoder, exactly where their Bind message, as the wire counts
 *   it, fits the bound; otherwise the carrier's creation, then fills of the longest runs of rows whose arrays, written
 *   by the same encoders, fit one Bind message, in row order, then the staged statement with the kept placeholder's
 *   value; a row whose fill alone is past the bound refuses the write as that row's NestedRowBound. So
 *   every execution's Bind message fits the bound, every row travels exactly once, in order, and no fill could have
 *   carried the next row too.
 *
 * Kept: rows past one Bind message in several fills.
 *
 * Features: the inline statement, several fills, a row past the bound.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { executionsOf } from "#compiler/runtime/write/staged.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	bindOf,
	expected,
	type Feature,
	resolved,
	sketchGen
} from "#test/unit/write/staged.fixtures.ts"

/**
 * Nested rows past one Bind message go inline where they fit and otherwise through a carrier filled in the longest
 * chunks one Bind carries.
 *
 * Budget: 400 runs and 64 steered cases, what its suite stated before it became a property
 * (test/unit/write/staged.test.ts:330 at 8cad5bce, its runs and its coverage's cases).
 */
export const nestedRowsPastOneBindMessageGoInlineWhereTheyFitAndOtherwiseThroughACarrierFilledInTheLongestChunksOneBindCarries =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 400, steered: 64 },
		situations: [
			"inline",
			"staged in one fill",
			"staged in several fills",
			"a row past one fill alone",
			"a text column",
			"a bytes column",
			"a literal column"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (sketch) =>
			Effect.sync(() => {
				const r = resolved(sketch)
				for (const kind of sketch.kinds) {
					c.note(
						kind === "text"
							? "a text column"
							: kind === "bytes"
								? "a bytes column"
								: "a literal column"
					)
				}
				const got = executionsOf(
					r.statement,
					"statement",
					(position) => {
						assert.equal(position, r.width, "only the kept placeholder is encoded by its slot")
						return Result.ok(r.value)
					},
					r.transport
				)
				const want = expected(r)
				if (!want.ok) {
					c.note("a row past one fill alone")
					assert.deepEqual(got, want, "a row no fill carries alone refuses the write")
					return
				}
				const fills = Arr.filter(want.value, (e) => e.part === "fill").length
				c.note(
					want.value.length === 1
						? "inline"
						: fills <= 1
							? "staged in one fill"
							: "staged in several fills"
				)
				assert.deepEqual(got, want, "the executions are the encoders' own cut")
				for (const e of succeeded(got)) {
					assert.ok(
						bindOf(e.params) <= r.transport.messageBytes,
						"every execution's Bind message fits the bound"
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the inline statement or the greedy cut by the encoders' own arrays"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/write/staged.test.ts#nestedRowsPastOneBindMessageGoInlineWhereTheyFitAndOtherwiseThroughACarrierFilledInTheLongestChunksOneBindCarries:-:2.1.0.4.3c.14.3c.14.3c.14.3c.14.0.0.0.7a"
				),
				reason: "rows past one Bind message in several fills",
				since: "2026-11-09"
			}
		],
		kills: [
			{
				file: "packages/engine/src/runtime/write/staged.ts",
				original: '\t\t\tbound.push(defined(values.get(position), "an encoded value"))\n',
				replacement: "",
				why: "The cut measures a statement's Bind message without its placeholders that carry no nested rows (runtime/write/staged.ts executionsOf), so a statement past the bound goes inline."
			},
			{
				file: "packages/engine/src/runtime/write/staged.ts",
				original: '\tif (staged.kind === "none") {\n\t\treturn inline()\n\t}\n',
				replacement:
					'\tif (staged.kind === "none" || staged.kind === "carriers") {\n\t\treturn inline()\n\t}\n',
				why: "A statement's staged form is never used (runtime/write/staged.ts executionsOf), so its nested rows go inline past any bound: the old suite's planted search over a statement with no staged form, which had to fail on the kept case past the bound."
			}
		]
	})
