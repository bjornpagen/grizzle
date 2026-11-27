/**
 * QTI's values held as one variant cell per cardinality (README "Variants") are written by a statement of one table's
 * size, where the typed form, one table per cardinality and base type, writes eleven: a hot path's planning bytes, held
 * to their bound. PostgreSQL plans a statement in time and memory that grow with its text (edullm's start: 44 typed
 * tables, 2.29 MB, 2.5 s of cold planning), so the four cells replace the 44 tables.
 *
 * The bound, from first principles: a write's statement is a frame the heading's write prints, and each field's print
 * wherever the write names it, and a cell is one column, named as a scalar column is. So the cell table's write prints
 * what its scalar twin's does, the table of the same heading whose cell is one closed id (variant-cells.fixtures.ts
 * twinTable), the frame and every field's print measured by the printer itself, and is held to that bound with a fifth
 * over it (`slack`).
 *
 * The box, exhausted: each cardinality, single, multiple, ordered and record, its one cell table against its scalar
 * twin, both written from facts; the typed form's eleven tables beside them, the fan-out the cell replaces.
 *
 * Oracle: specification, the cell's write's statement bytes against its scalar twin's.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	bytesOf,
	type Cardinality,
	cardinalities
} from "#test/unit/write/variant-cells.fixtures.ts"

/**
 * How far past its scalar twin's statement a cell's write may print: a fifth, the rule a bar test's bound takes, which
 * holds the composite's own print, its row type's name in its parameter's cast and its tag's attribute in the generated
 * tag's term, and refuses any print that grows with the variant's arms.
 *
 * @limitKind derived
 * @owner grizzle
 * @unit a ratio of UTF-8 bytes
 * @scope the cell's write against its scalar twin's, each cardinality's
 * @derivation a cell names one column wherever its twin's closed id is named; past the twin it prints its row type's
 *   qualified name once, in its parameter's array cast, and `(…)."tag"` once, in the generated tag's term: 90 to 124
 *   bytes over twins of 3,102 to 4,419, under 3% at this grizzle; the typed form's fan-out over the eleven base types
 *   prints 39,611 to 50,284, eleven to thirteen twins
 */
const slack = 1.2

/** A variant cell's write of one cardinality prints at most its scalar twin's statement and a fifth. */
export const aVariantCellsWriteSendsTheStatementOfItsScalarTwin = property.exhaust(
	finite(cardinalities),
	{
		box: "each cardinality, single, multiple, ordered and record: its one cell table against its scalar twin, beside its eleven typed tables",
		needs: {},
		situations: [],
		check: (_, _c: Case<never>) => (cardinality: Cardinality) =>
			Effect.sync(() => {
				const { cell, twin, typed } = bytesOf(cardinality)
				assert.ok(
					cell <= slack * twin,
					`the ${cardinality} cell's write sends ${cell} bytes, where its bound is its scalar twin's ${twin} and a fifth, ${Math.floor(slack * twin)}; the typed form's eleven tables send ${typed}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the cell's write's statement bytes against its scalar twin's"
		},
		kept: [],
		kills: [
			{
				file: "test/unit/write/variant-cells.fixtures.ts",
				original: '\tcell: writeBytes("Cell", [cellTable(cardinality)], [BaseType]),\n',
				replacement:
					'\tcell: writeBytes("Cell", Arr.map(Rec.keys(typedLeaf), (base) => typedTable(cardinality, base)), [BaseType]),\n',
				why: "The cell's write is the representation it replaces, the per-type fan-out: one table of each base type, eleven statements' frames and fields, past its scalar twin's bound elevenfold."
			}
		]
	}
)
