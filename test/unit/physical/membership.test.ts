/**
 * A membership test, `Bits.subset(Bits.singleton(c), s)`, as the work its CHECK does (lower/conservative/expr
 * memberTest): the one bit it reads, never a set built and compared.
 *
 * The box, exhausted: the code a row asks for (its own closed id, a closed read's, a handle) against the set it asks
 * of (a stored set, a closed row of a product key, a closed row of a dependent key whose last field is a slot, a set
 * value, a union computed in the row), a handle in a set value left out since the CHECK folds whole, and the control, a
 * subset test of a closed row in a stored set. Each case installs one CHECK of T and counts what its predicate's SQL
 * calls, the body of the row function it calls read in its place (physical/ddl/row-functions.ts). The oracle is the work a membership needs, stated here: no singleton's set_bit, no complement, no bit_count;
 * over a closed row, one binary search of the row's relation's cells, no row read whole and no get_bit, the key completed
 * by the code (C.has's read, sql/constants.ts closedRead); over any other set, one get_bit. The control still reads two
 * whole sets, the row by the library's closedRow and no search of the relation's cells beside it.
 * What the bit means is held on PostgreSQL by test/pg/closed/absent's member arm, its NULLs and absent rows included,
 * and by its kill of the completed key's order.
 *
 * Features: each code, each set, and the control.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Asked,
	box,
	type CodeSource,
	installedWork,
	type SetSource
} from "#test/unit/physical/membership.fixtures.ts"

type Feature = `code ${CodeSource}` | `set ${SetSource}` | "a subset test of two sets"

/** A membership test reads one bit of its set, or searches its closed row's cells once, and builds and compares no set. */
export const aMembershipTestReadsOneBitOfItsSetOrSearchesItsClosedRowsCellsOnceAndBuildsAndComparesNoSet =
	property.exhaust(finite(box), {
		needs: {},
		situations: [
			"code own",
			"code picked",
			"code handle",
			"set stored",
			"set row",
			"set slotted row",
			"set value",
			"set union",
			"a subset test of two sets"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (asked: Asked) =>
			Effect.sync(() => {
				const { work, codes } = installedWork(asked)
				const calls = (name: string): number => work.calls.get(name) ?? 0
				const searches = codes === undefined ? 0 : (work.searches.get(codes) ?? 0)
				if (asked.kind === "subset") {
					c.note("a subset test of two sets")
					assert.equal(calls("bit_count"), 1, "a subset test of two sets counts what one leaves")
					assert.equal(work.complements, 1, "of the other's complement")
					assert.equal(work.rows, 1, "and reads the row whole, by the library's closedRow")
					assert.equal(searches, 0, "searching none of the relation's codes beside it")
					return
				}
				c.note(`code ${asked.code}`)
				c.note(`set ${asked.set}`)
				assert.equal(calls("set_bit"), 0, "a membership builds no singleton")
				assert.equal(work.complements, 0, "takes no complement")
				assert.equal(calls("bit_count"), 0, "and counts no set")
				if (asked.set === "row" || asked.set === "slotted row") {
					assert.equal(searches, 1, "over a closed row it searches the row's relation's cells once")
					assert.equal(work.rows, 0, "reads no row whole")
					assert.equal(calls("get_bit"), 0, "and no set of the row")
					return
				}
				assert.equal(calls("get_bit"), 1, "over any other set it reads one bit of it")
			}),
		oracle: {
			kind: "specification",
			name: "the work a membership test needs: one bit, or one search of a closed relation's cells"
		},
		box: "every code source against every set source, a handle in a set value left out, and the control",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: '\t\tnativeOp(expr.op)?.fn !== "subset" ||\n',
				replacement: '\t\tnativeOp(expr.op)?.fn !== "subset" || expr.args.length > 0 ||\n',
				why: "A membership is lowered as the subset test of a singleton, a set built and compared; every membership case counts a set_bit, a complement and a bit_count."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: '\tset.kind === "closedRow" && site.whole(set) === undefined\n',
				replacement: "\tfalse\n",
				why: "A membership in a closed row reads the row whole and tests its bit with get_bit; the row cases call closedRow, not one search of the cells."
			},
			{
				file: "packages/engine/src/sql/constants.ts",
				original:
					'\teq({ kind: "subscript", array: constantValue(cells), index: positionOf(cells, index) }, index)',
				replacement:
					'\t({ kind: "equalsAny", expr: index, array: constantValue(cells), schema: undefined })',
				why: "A membership scans every cell, `index = ANY(cells)`, O(n) in the relation's rows where the binary search is O(log n): the row cases search the cells no time, not once."
			}
		]
	})
