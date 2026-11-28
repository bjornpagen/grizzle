/**
 * A reading of the database's clock lies in the clock's range: a parameter a clocked member binds to the clock in a unit
 * is a value of PostgreSQL's timestamptz range in that unit (core/clock.ts clockReadingRange) beside its declared type's
 * bounds (scalar/compute/typing.ts param, readingProof), so a deadline of the reading and a contract-bounded delay types
 * with no guard exactly where those bounds prove it fits its field, and a guard is asked of every other.
 *
 * The box, exhausted: the clock in millis or micros, the delay bounded within [0, 10^0] to [0, 10^18], and the field
 * an unbounded contract over bigint or one at most 10^16 (clock-reading.fixtures.ts). Each case compiles its write
 * (write/program/compile.ts compileWrite) with `now` bound to the clock in its unit; the verdict is the rule restated
 * over the published range (fits): compiled, or refused as PartialOperation at the deadline's cast.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	type DeadlineFeature,
	deadlineFeature,
	deadlineGen,
	deadlineOf,
	fits
} from "#test/unit/check/clock-reading.fixtures.ts"

/** A deadline of a clock reading and a bounded delay types with no guard exactly where the clock's range and the delay's bounds prove it fits its field. */
export const aDeadlineOfAClockReadingAndABoundedDelayTypesWithNoGuardExactlyWhereTheClocksRangeProvesItFits =
	property.exhaust(finite(deadlineGen), {
		needs: {},
		situations: [
			"a millis deadline that fits",
			"a micros deadline past bigint",
			"a deadline past its field's bound"
		] satisfies ReadonlyArray<Reached<DeadlineFeature>>,
		check: (_, k: Case<DeadlineFeature>) => (d) =>
			Effect.sync(() => {
				k.note(deadlineFeature(d))
				const deadline = deadlineOf(d)
				const compiled = compileWrite(checking(deadline.schema), descOf(deadline.changeSet()), {
					...realityWrite(
						succeeded(testArtifacts(deadline.schema, testCompile), "the case's artifacts")
					),
					clock: { now: d.unit }
				})
				if (fits(d)) {
					succeeded(compiled, "the deadline types with no guard")
					return
				}
				const reason = refused(compiled, "PartialOperation", "the deadline asks a guard").reason
				assert.equal(reason._tag, "PartialOperation", "the cast that may not fit is refused")
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's timestamptz range, MIN_TIMESTAMP to END_TIMESTAMP, in the clock's unit, plus the delay's bounds, within the field's (clock-reading.fixtures.ts fits)"
		},
		box: "the clock in millis or micros, the delay within [0, 10^0] to [0, 10^18] by threes, the field an unbounded contract over bigint or one at most 10^16",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\tcase "clock": {\n\t\t\tconst own = boundsOfType(t)\n',
				replacement:
					'\t\tcase "clock": {\n\t\t\treturn undefined\n\t\t\tconst own = boundsOfType(t)\n',
				why: "A clock reading has only its declared type's bounds, bigint's, so no deadline over it fits a field: every millis case the rule types asks a guard."
			},
			{
				file: "packages/engine/src/core/clock.ts",
				original:
					"\tmillis: Object.freeze({\n\t\tlow: (minTimestamp + postgresEpochMicros) / 1000n,\n\t\thigh: (endTimestamp + postgresEpochMicros - 1n) / 1000n\n\t})\n",
				replacement:
					"\tmillis: Object.freeze({\n\t\tlow: minTimestamp + postgresEpochMicros,\n\t\thigh: endTimestamp + postgresEpochMicros - 1n\n\t})\n",
				why: "A millis reading is read with the micros range, past bigint at its top, so a millis deadline overflows as a micros one does and asks a guard the rule does not."
			}
		]
	})
