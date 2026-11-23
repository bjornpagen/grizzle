/**
 * Generated span queries against the span reference evaluator, in both artifacts: an Allen filter, an Allen join and
 * pointIn, over every endpoint kind (integer, bigint, a contract, date), Left and Right each span-keyed or not, each
 * answer the reference's as a set of rows with no repeat.
 *
 * Features: each query kind over each endpoint kind, an Allen filter's window and pointIn's point each a parameter and a
 * literal.
 */

import { ReplayToken } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	printSpanCase,
	referenceRows,
	spanCaseGen,
	spanInsert,
	spanQueryDesc,
	spanQueryHeading,
	spanQueryParams,
	spanRelationNames,
	spanSchemaDesc,
	spanVariantOf
} from "#test/support/oracle/gen/spans.ts"
import { PropertyFailed, seatedOracleProperty } from "#test/support/oracle/runner.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

import {
	compileSpanDesc,
	allenOracleFeatures,
	featureOf,
	oracleBudget,
	rowsAs,
	runArtifact,
	sameRowSet,
	oracleSpans
} from "#test/pg/spans/allen/oracle.fixtures.ts"

/**
 * Generated span queries against the reference agree with the reference in both artifacts on Allen and pointIn cases,
 * each case on the worker's seat of its schema's template (oracleSpans). It caught 1e1c91673's bug, kept as its kill
 * and its kept case; its budget is the least that kills it, measured (oracleBudget).
 */
export const generatedSpanQueriesAgainstTheReferenceAgreeWithTheReferenceInBothArtifactsOnAllenAndPointInCases =
	seatedOracleProperty(oracleSpans, spanVariantOf, spanCaseGen, {
		situations: allenOracleFeatures,
		perturb: "none",
		oracle: {
			kind: "second-implementation",
			name: "the span reference evaluator, in both artifacts"
		},
		budget: oracleBudget,
		kept: [
			{
				token: ReplayToken(
					"test/pg/spans/allen/oracle.test.ts#generatedSpanQueriesAgainstTheReferenceAgreeWithTheReferenceInBothArtifactsOnAllenAndPointInCases:fffe0.e:2.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"1e1c91673's red: pointIn over Left at a parameter point, -4, over the Tick contract's endpoint, no facts stored; its point was sent as the contract's domain, `int8range @> <domain>`, which PostgreSQL has no operator for (42883)",
				since: "2026-11-13"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/span/index.ts",
				original: '\treturn binary("@>", left, cast(right, endpointType[endpoint]))',
				replacement: '\treturn binary("@>", left, right)',
				why: "1e1c91673's red, its fix reverted: pointIn's point is sent as lowered, never cast to its endpoint's base, so a parameter point over a contract endpoint, cast to the contract's domain as it is bound, meets `int8range @> <domain>`, which PostgreSQL has no operator for (42883)."
			}
		],
		show: Formatter.format,
		check: (c, target) => (sc) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session({ ...ownerSession(), label: "owner" })
				c.note(featureOf(sc.query, sc.schema.endpoint))
				const template = compileSpanDesc(
					spanQueryDesc(sc),
					spanSchemaDesc(sc.schema),
					target.schema
				)
				const expected = referenceRows(sc)
				const columns = spanQueryHeading(sc.query)
				yield* db.begin
				const outcome = yield* Effect.gen(function* () {
					for (const name of spanRelationNames) {
						if (sc.facts[name].length === 0) {
							continue
						}
						const insert = spanInsert(target.schema, sc, name, sc.facts[name])
						yield* db.query(insert.sql, insert.params)
					}
					const problems: Array<string> = []
					for (const artifact of ["optimized", "conservative"] as const) {
						const spec = template[artifact][0]
						if (spec === undefined || template[artifact].length !== 1) {
							return [`${artifact}: one statement`]
						}
						if (regex("\\b(lower|upper)\\(").test(spec.sql)) {
							problems.push(`${artifact}: lower() or upper()`)
						}
						const [rows] = yield* runArtifact(db, template, artifact, spanQueryParams(sc))
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
					return problems
				}).pipe(Effect.ensuring(Effect.ignore(db.rollback)))
				if (outcome.length > 0) {
					return yield* new PropertyFailed({
						report: `${printSpanCase(sc)}\n${Arr.join(outcome, "\n")}`
					})
				}
			})
	})
