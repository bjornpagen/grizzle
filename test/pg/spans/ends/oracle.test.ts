/**
 * A span from its ends, r.range(start, end), against the span reference evaluator, in both artifacts: over every
 * endpoint kind (integer, bigint, a contract, date), Left and Right each span-keyed or not, from a Left span's start to
 * a Right span's end over the pairs of one group, or from each span's start to a point, a parameter or a literal. Each
 * answer is the reference's as a set of rows with no repeat: [start, end) for a binding whose end lies after its start,
 * and no row for one whose end does not, the empty and the reversed pair alike (test/support/oracle/gen/spans.ts
 * endsReferenceRows).
 *
 * Each case runs in its one rolled-back transaction on the worker's own clone of its schema's template, the one the
 * Allen property's cases clone too (test/pg/spans/allen/oracle.fixtures.ts oracleSpans). Its budget is the runner's: a
 * new property, with no suite before it to carry a count from.
 *
 * Features: each form over each endpoint kind, a point a parameter and a literal, a binding that yields its span and
 * one that yields none.
 */

import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	compileSpanDesc,
	oracleSpans,
	rowsAs,
	runArtifact,
	sameRowSet
} from "#test/pg/spans/allen/oracle.fixtures.ts"
import {
	type EndsFeature,
	endsFeatures,
	endsFeaturesOf,
	endsReferenceRows
} from "#test/pg/spans/ends/oracle.fixtures.ts"
import {
	endsCaseGen,
	endsQueryDesc,
	endsQueryHeading,
	endsQueryParams,
	printEndsCase,
	spanInsert,
	spanRelationNames,
	spanSchemaDesc,
	spanVariantOf
} from "#test/support/oracle/gen/spans.ts"
import { PropertyFailed } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A span from its ends agrees with the reference in both artifacts, over every endpoint kind and both forms. */
export const aSpanFromItsEndsAgreesWithTheReferenceInBothArtifactsOverEveryEndpointKindAndBothForms =
	property.explore(endsCaseGen, {
		needs: Substrate.oneOf(oracleSpans, Substrate.rolledBack),
		situations: endsFeatures,
		check: (clones, c: Case<EndsFeature>) => (ec) =>
			Effect.gen(function* () {
				c.noteAll(endsFeaturesOf(ec))
				const held = yield* clones[spanVariantOf(ec)]
				const target = held.value.schema
				const template = compileSpanDesc(endsQueryDesc(ec), spanSchemaDesc(ec.schema), target)
				for (const name of spanRelationNames) {
					if (ec.facts[name].length > 0) {
						const insert = spanInsert(target, ec, name, ec.facts[name])
						yield* held.session.query(insert.sql, insert.params)
					}
				}
				const expected = endsReferenceRows(ec)
				const columns = endsQueryHeading(ec.query)
				const problems: Array<string> = []
				for (const artifact of ["optimized", "conservative"] as const) {
					const spec = template[artifact][0]
					if (spec === undefined || template[artifact].length !== 1) {
						problems.push(`${artifact}: one statement`)
						continue
					}
					const [rows] = yield* runArtifact(held.session, template, artifact, endsQueryParams(ec))
					const got = rowsAs(spec, rows ?? [], columns)
					if (got.repeats > 0) {
						problems.push(`${artifact}: ${got.repeats} repeated rows`)
					}
					const difference = sameRowSet(got.rows, expected)
					if (Option.isSome(difference)) {
						problems.push(
							`${artifact}: ${difference.value}\n  reference  ${Formatter.format(expected)}\n  postgresql ${Formatter.format(got.rows)}`
						)
					}
				}
				if (problems.length > 0) {
					return yield* new PropertyFailed({
						report: `${printEndsCase(ec)}\n${Arr.join(problems, "\n")}`
					})
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the span reference evaluator's span from its ends, in both artifacts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/producers/ends.ts",
				original: '\t\tbinary("<", start, end)\n',
				replacement: "\t\tundefined\n",
				why: "The guard dropped: a binding whose end is not after its start meets the range constructor, which makes the empty span of an equal pair and refuses a reversed one (22000), where it yields no row."
			},
			{
				file: "packages/engine/src/lower/conservative/producers/ends.ts",
				original: 'binary("<", start, end)',
				replacement: 'binary("<=", start, end)',
				why: "The guard admits an equal pair, whose span is the empty one, a row of `empty` where the binding yields none."
			}
		],
		show: Formatter.format
	})
