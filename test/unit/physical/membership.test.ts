/**
 * A membership test, `Bits.subset(Bits.singleton(c), s)`, as the work its CHECK does (lower/conservative/expr
 * memberTest): the one bit it reads, never a set built and compared.
 *
 * The box, exhausted: the code a row asks for (its own closed id, a closed read's, a handle) against the set it asks
 * of (a stored set, a closed row of a product key, a closed row of a dependent key whose last field is a slot, a set
 * value, a union computed in the row), a handle in a set value left out since the CHECK folds whole, and the control, a
 * subset test of a closed row in a stored set. Each case installs one CHECK of T and counts what its predicate's SQL
 * calls, the body of the row function it calls read in its place (physical/ddl/row-functions.ts). The oracle is the work a membership needs, stated here: no singleton's set_bit, no complement, no bit_count;
 * over a closed row, one read of one bit of the row's relation's key set and no get_bit, the key completed by the code
 * (C.has's read, sql/constants.ts closedRead); over any other set, one get_bit. The control still reads two whole sets, the row as a run of its key set.
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

/** A membership test reads one bit, of its set or of its closed row's key set, and builds and compares no set. */
export const aMembershipTestReadsOneBitOfItsSetOrOfItsClosedRowsKeySetAndBuildsAndComparesNoSet =
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
				const { work, keys } = installedWork(asked)
				const calls = (name: string): number => work.calls.get(name) ?? 0
				const keyReads = keys === undefined ? [] : (work.reads.get(keys) ?? [])
				if (asked.kind === "subset") {
					c.note("a subset test of two sets")
					assert.equal(calls("bit_count"), 1, "a subset test of two sets counts what one leaves")
					assert.equal(work.complements, 1, "of the other's complement")
					assert.deepEqual(
						keyReads,
						[5n],
						"and reads the row whole, a run of its key set, a bit per code of Flag"
					)
					return
				}
				c.note(`code ${asked.code}`)
				c.note(`set ${asked.set}`)
				assert.equal(calls("set_bit"), 0, "a membership builds no singleton")
				assert.equal(work.complements, 0, "takes no complement")
				assert.equal(calls("bit_count"), 0, "and counts no set")
				if (asked.set === "row" || asked.set === "slotted row") {
					assert.deepEqual(
						keyReads,
						[1n],
						"over a closed row it reads one bit of the row's key set"
					)
					assert.equal(calls("get_bit"), 0, "and no set of the row")
					return
				}
				assert.equal(calls("get_bit"), 1, "over any other set it reads one bit of it")
			}),
		oracle: { kind: "specification", name: "the work a membership test needs: one bit" },
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
				why: "A membership in a closed row reads the row whole and tests its bit with get_bit; the row cases read a run of the key set, not one bit."
			}
		]
	})
