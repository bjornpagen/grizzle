/**
 * Every key a program fixes at its parameter is bound to the parameter where its stored relation is read (the
 * constant-column pass, lower/optimize/propagate): a learner's ledger, each relation of the unit Learner keyed by its
 * child first, and a box of ChangeSets whose every read and write of one is at the parameter `child`, which reaches the
 * read only through a column that carries it, a query's projection of the parameter, a filter above the join a write
 * navigates, a union whose every arm projects it, a take correlated with a projected row, a node two readers read at
 * it, or a delta the change added (its producer, the delta's insert). Each program compiles as a reality write at READ
 * COMMITTED, its write statements in every form and its read-backs.
 *
 * Oracle: specification, read off each statement's AST apart from the compiler (propagate.fixtures.ts unboundOf): every
 * stored read of a unit relation stands in a core whose conditions spell `child = $child`, the placeholder itself
 * through casts, and every INSERT into one with ON CONFLICT takes its child from the placeholder, through its own CTEs,
 * as the borrow checker reads both (program/isolation/extract.ts).
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type Program, programGen, sentOf, unboundOf } from "#test/unit/lower/propagate.fixtures.ts"

/** Every key a program fixes at its parameter is bound to it where its stored relation is read. */
export const everyKeyAProgramFixesAtItsParameterIsBoundToItWhereItsStoredRelationIsRead =
	property.exhaust(finite(programGen), {
		box: "a learner's programs over Session, Visit and Mark at the parameter child, each reaching a key through a carried column",
		needs: {},
		situations: [],
		check: (_, k: Case<Program>) => (program) =>
			Effect.sync(() => {
				k.note(program)
				const sent = sentOf(program)
				assert.ok(sent.length > 0, `${program}: the program sends a statement`)
				for (const statement of sent) {
					assert.deepEqual(unboundOf(statement), [], `${program}: every key bound at its read`)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every stored read of a unit relation spells child = $child in its core, and every arbitration of one takes its child from the placeholder"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/propagate/index.ts",
				original: "\t\t\t\tread.push(ref.node)\n\t\t\t\treturn value\n",
				replacement: "\t\t\t\treturn undefined\n",
				why: "No reference reads the value its column holds: the write's navigation reads Visit LATERAL at the column of Session's step, and its INSERT takes the child from the source's column, where nothing spells the parameter."
			},
			{
				file: "packages/engine/src/lower/optimize/propagate/index.ts",
				original: "\t\t\t\t\tadded.push(o.source.id)\n",
				replacement: "\t\t\t\t\treturn o\n",
				why: "No occurrence of a stored relation fixes the key its region holds at the parameter: the read-back joins Visit to the projected rows by the column of their CTE, which binds nothing."
			},

			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\treturn { added: new Map([...sources].filter(([relation]) => !opaque.has(relation))) }\n",
				replacement: "\treturn { added: new Map() }\n",
				why: "A delta holds nothing its relation's inserts hold: the read-back reads Mark at the added visits' columns."
			}
		]
	})
