/**
 * The ordered probe (sql/ordered-probe.ts): the one scalar subquery that reads the row of an index nearest past a cut of
 * its order, which a span run's straddler (sql/span-runs.ts) and an order statistic's successor and predecessor read.
 *
 * - **Property:** over every cut, every set of ordered values and every bound, what the probe's statement reads, its
 *   WHERE, ORDER BY and LIMIT applied to the values, is the value nearest the bound past the cut, or none.
 * - **Oracle:** the specification, the greatest value below the bound for `<` and `<=` and the least above it for `>`
 *   and `>=`.
 * - **Box, exhausted:** the four cuts, none, one and several values, every bound from below them to above them.
 * - **Features:** a predecessor, a successor, a probe finding a value and one finding none, a bound at a held value.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import { binary, col, lit, table, types } from "#compiler/sql/build.ts"
import { orderedProbe } from "#compiler/sql/ordered-probe.ts"
import {
	nearestPast,
	type ProbeFeature,
	probeBox,
	probeFeatures,
	probeReads
} from "#test/unit/sql/ordered-probe.fixtures.ts"

/** An ordered probe reads exactly the value nearest its bound past its cut, or none. */
export const anOrderedProbeReadsExactlyTheValueNearestItsBoundPastItsCutOrNone = property.exhaust(
	finite(probeBox),
	{
		needs: {},
		situations: [
			"a predecessor",
			"a successor",
			"a probe finding its nearest value",
			"a probe finding no value",
			"a bound at a held value"
		] satisfies ReadonlyArray<Reached<ProbeFeature>>,
		check: (_, c: Case<ProbeFeature>) => (pc) =>
			Effect.sync(() => {
				const probe = orderedProbe({
					from: table("s", "t", "p"),
					prefix: [binary("=", col("p", "k"), lit.int(1, types.integer))],
					order: col("p", "v"),
					cut: { op: pc.cut, bound: lit.int(pc.bound, types.integer) },
					take: col("p", "v")
				})
				const want = nearestPast(pc)
				assert.deepEqual(
					probeReads(probe, pc.values),
					Option.match(want, { onNone: () => [], onSome: (v) => [v] }),
					`the probe ${pc.cut} ${pc.bound} over ${Formatter.format(pc.values)}`
				)
				c.noteAll(probeFeatures(pc, Option.isSome(want)))
			}),
		oracle: {
			kind: "specification",
			name: "the greatest value below the bound for < and <=, the least above it for > and >="
		},
		box: "the four cuts, none, one and several ordered values, and every bound from 0 to 9",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/ordered-probe.ts",
				original: '\t"<": desc,\n',
				replacement: '\t"<": asc,\n',
				why: "A probe below a bound walks forward: it reads the least value below the bound, the farthest, where the predecessor is the nearest."
			},
			{
				file: "packages/engine/src/sql/ordered-probe.ts",
				original: '\t">=": asc\n',
				replacement: '\t">=": desc\n',
				why: "A probe at least a bound walks backward: it reads the greatest value past it, where the successor is the least."
			},
			{
				file: "packages/engine/src/sql/ordered-probe.ts",
				original: "\t\tlimit: lit.int(1, types.bigint)\n",
				replacement: "\t\tlimit: lit.int(2, types.bigint)\n",
				why: "A probe of two rows is no scalar subquery's: it reads the value past its nearest too."
			},
			{
				file: "packages/engine/src/sql/ordered-probe.ts",
				original: "\t\t\tand([...p.prefix, binary(p.cut.op, p.order, p.cut.bound)])\n",
				replacement: '\t\t\tand([...p.prefix, binary("<=", p.order, p.cut.bound)])\n',
				why: "A probe that cuts at most its bound whatever its cut: a strict cut reads a value at the bound, a cut above it reads values below."
			}
		]
	}
)
