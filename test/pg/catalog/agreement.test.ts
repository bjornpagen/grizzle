/**
 * The compile-target catalog against its compositions on PostgreSQL 19 (R26-R31, R41, R42): every composition the
 * catalog documents, drawn by the choices its text makes (an ordinal's directions, a running aggregate's restriction, a
 * neighbor's direction, source restriction and parents, an as-of's comparison, restriction, attachment and path, a
 * share's total and restriction, a percentile's fractions and stage, a continuous percentile's fraction, the mode),
 * checked and lowered twice, composed (the conservative lowering of the checked DAG) and native (the catalog's rewrite,
 * its targets lowered by native.ts), agrees over drawn lab facts (support.ts factsGen: small domains, both zeros among
 * the scores, so ties, groups of one row and empty relations come up) as raw text sets, the native run repeating no
 * row; the rewrite applies exactly the rules the catalog's specification admits for the shape (rulesOf), so a dropped
 * condition shows as a wrong answer; and every native target is an overload PostgreSQL has. The compositions of the
 * hand-written suites this search replaced are the aims of the entry kinds they reach (agreement.fixtures.ts keptAims).
 *
 * Oracle: the composition's conservative lowering, and the catalog's specification of each shape's rules.
 *
 * Features: each entry kind, each rule applied and none, a delivered row, R29 and R30 each selecting a -0 that is the
 * only zero of its group, whose canonical zero the native form must take as the composition's merged head does.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import {
	type AgreementFeature,
	agreementSpace,
	descOf,
	entryKinds,
	nativeTargets,
	rulesOf,
	selectsNegativeZero
} from "#test/pg/catalog/agreement.fixtures.ts"
import { appliedRules, catalogLowering, labOptions, oracleCase } from "#test/pg/catalog/support.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Every composition of the catalog agrees with its native rewrite, which applies exactly the rules its shape admits,
 * each case in its one rolled-back transaction on the worker's clone.
 *
 * Its pre-conversion budget: runs 120, coverage cases 120 (test/pg/catalog/agreement.test.ts at f6a7126a8).
 */
export const everyCompositionOfTheCatalogAgreesWithItsNativeRewriteWhichAppliesExactlyTheRulesItsShapeAdmits =
	property.explore(agreementSpace, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			...Arr.map(entryKinds, (kind): AgreementFeature => `entry ${kind}`),
			"applied R26",
			"applied R27",
			"applied R28",
			"applied R29",
			"applied R30",
			"applied R31",
			"applied R41",
			"applied R42",
			"applied none",
			"delivers rows",
			"R29 selecting -0",
			"R30 selecting -0"
		],
		check:
			({ tx }, c: Case<AgreementFeature>) =>
			({ entry, facts }) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const label = Formatter.format(entry)
							const side = catalogLowering(labOptions())
							const outcome = yield* runLabelledOracle(
								oracleCase(label, descOf(entry), facts),
								conservative,
								side,
								{
									...defaultRunOptions,
									schema: { kind: "named", name: yield* held.schema("catalog") }
								}
							)
							assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
							const applied = appliedRules(side.last())
							assert.deepEqual(applied, Arr.sort([...rulesOf(entry)], Order.String), label)
							for (const op of nativeTargets(side.last())) {
								const resolved = yield* held.connection.queryValues(
									"SELECT to_regprocedure($1)::text",
									[op]
								)
								assert.equal(
									resolved[0]?.[0],
									op,
									`the native target ${op} is an overload PostgreSQL has`
								)
							}
							c.note(`entry ${entry.kind}`)
							c.noteAll(
								Arr.isReadonlyArrayNonEmpty(applied)
									? Arr.map(applied, (rule): AgreementFeature => `applied ${rule}`)
									: ["applied none"]
							)
							if (Arr.some(outcome.right.run.statements, (st) => st.rows.length > 0)) {
								c.note("delivers rows")
							}
							if (selectsNegativeZero(entry, facts)) {
								if (Arr.contains(applied, "R29")) {
									c.note("R29 selecting -0")
								}
								if (Arr.contains(applied, "R30")) {
									c.note("R30 selecting -0")
								}
							}
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the composition's conservative lowering, as raw text sets, and the catalog's specification of the rules each shape admits"
		},
		show: Formatter.format,
		budget: { runs: 120, steered: 120 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/catalog/percentile.ts",
				original:
					"\t\t\t\texpr: canonicalOver(cx.ed, colExpr(cx.ed, osa, column, type), read.canonical)\n",
				replacement: "\t\t\t\texpr: colExpr(cx.ed, osa, column, type)\n",
				why: "R29's PERCENTILE_DISC delivers the zero it selects as it is: a student's scores whose selected value is -0 deliver -0 natively, where the composition's merged head delivers +0."
			},
			{
				file: "packages/engine/src/lower/shapes/catalog/percentile.ts",
				original:
					"\t\t\texpr: canonicalOver(cx.ed, colExpr(cx.ed, out, outName, type), read.canonical)\n",
				replacement: "\t\t\texpr: colExpr(cx.ed, out, outName, type)\n",
				why: "R30's PERCENTILE_CONT at a whole position returns the value there as it is, -0 for a group whose value there is -0, where the composition's merged head delivers +0."
			}
		]
	})
