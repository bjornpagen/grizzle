/**
 * A call is never computed at keys, whatever its readers read it at (lower/shapes/share/keys.ts computedAt): its rows
 * are its function's at its arguments, evaluated whole wherever it stands, and a statement that reads it holds its
 * evaluation once (lower/conservative/call evaluationQuery, share/statements.ts StatementSharing carryEvaluation), so
 * a copy of it at keys would evaluate the call again beside the one the statement holds. metis's submit carried the
 * texts of its response processing at their readers' keys, the call's 230 KB evaluated a second time in a nested WITH
 * beside the statement's own, and seventeen of its fields each at a key set of its own.
 *
 * The box, exhausted: a call's field read by one rule or two, joined to the session's items by its row, whose readers
 * then read it at those items' keys, or alone.
 *
 * Oracle: specification, every call's key set whole; joined to the items, its reads read it at keys.
 *
 * Features: read at the session's items; read alone.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { boxGen, callKeysOf, type Reading } from "#test/unit/lower/shapes/call-keys.fixtures.ts"

/** A call read at its readers' keys is computed whole, never at those keys. */
export const aCallReadAtItsReadersKeysIsComputedWholeNeverAtThem = property.exhaust(
	finite(boxGen),
	{
		needs: {},
		situations: ["at the session's items", "alone"],
		check: (_, k: Case<Reading>) => (box) =>
			Effect.sync(() => {
				k.note(box.reading)
				const calls = callKeysOf(box)
				assert.ok(calls.length > 0, `${Formatter.format(box)}: the read calls its function`)
				for (const call of calls) {
					assert.equal(
						call.read.kind,
						box.reading === "alone" ? "whole" : "keys",
						`${Formatter.format(box)}: the call's reads read it ${box.reading === "alone" ? "whole" : "at the items' keys"}`
					)
					assert.equal(
						call.computed.kind,
						"whole",
						`${Formatter.format(box)}: the call is computed whole, never at its readers' keys`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every call's key set whole; joined to the items, its reads read it at keys"
		},
		box: "a call's field read by one rule or two, joined to the session's items by its row, or alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: '\tnode.kind === "Call"\n\t\t? whole\n',
				replacement: '\tnode.kind === "Window"\n\t\t? whole\n',
				why: "Call keyed: a call its readers read at keys is computed at them, a copy of it evaluated again beside the one the statement holds."
			}
		]
	}
)
