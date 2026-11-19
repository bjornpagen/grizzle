import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
/**
 * The compile-target catalog against its compositions on PostgreSQL 19 (R26-R31, R41, R42).
 *
 * - Agreement: every composition the catalog documents, drawn by the choices its text makes (an ordinal's directions,
 *   a running aggregate's restriction, a neighbor's direction, source restriction and parents, an as-of's comparison,
 *   restriction, attachment and path, a share's total and restriction, a percentile's fractions and stage, a
 *   continuous percentile's fraction, the mode), checked and lowered twice, composed (the conservative lowering of the
 *   checked DAG) and native (the catalog's rewrite, its targets lowered by native.ts), agrees over drawn lab facts
 *   (support.ts factsGen: small domains, so ties, groups of one row and empty relations come up) as raw text sets, the
 *   native run repeating no row; the rewrite applies exactly the rules the catalog's specification admits for the
 *   shape (rulesOf), so a dropped condition shows as a wrong answer; and every native target is an overload PostgreSQL
 *   has. The compositions of the hand-written suites this search replaced are the aims of the entry kinds they reach
 *   (agreement.fixtures.ts keptAims).
 * - Percentile fractions: R29 admits exactly the dyadic fractions in (0, 1] whose native form agrees with the
 *   composition, and the native form, forced at any fraction, disagrees exactly where a model of both forms' positions
 *   says (fractionCaseGen).
 *
 * Oracle: the composition's conservative lowering, and the catalog's specification of each shape's rules; the model of
 * both percentile forms for the fractions.
 *
 * Features: each entry kind, each rule applied and none, a delivered row; each fraction class.
 */
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import {
	admitted,
	type AgreementFeature,
	agreementRuns,
	agreementSpace,
	descOf,
	entryKinds,
	type FractionFeature,
	fractionFacts,
	fractionSpace,
	groupAgrees,
	lowerNative,
	nativeTargets,
	optionsOf,
	rulesOf
} from "#test/pg/catalog/agreement.fixtures.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import {
	appliedRules,
	catalogLowering,
	labFacts,
	labOptions,
	oracleCase
} from "#test/pg/catalog/support.ts"
import {
	conservative,
	defaultRunOptions,
	type Lowering,
	printOutcome,
	runLabelledOracle,
	sentConservative
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every composition of the catalog agrees with its native rewrite, which applies exactly the rules its shape admits,
 * each case in its one rolled-back transaction on the worker's clone.
 *
 * Its pre-conversion budget: runs 120, coverage cases 120 (test/pg/catalog/agreement.test.ts at f6a7126a8).
 */
export const everyCompositionOfTheCatalogAgreesWithItsNativeRewriteWhichAppliesExactlyTheRulesItsShapeAdmits =
	property.explore(agreementSpace, {
		needs: { tx: Substrate.transaction },
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
			"delivers rows"
		],
		check:
			({ tx }, c: Case<AgreementFeature>) =>
			({ entry, facts }) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const label = Formatter.format(entry)
							const side = catalogLowering(optionsOf(entry))
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
		budget: { runs: 10 * agreementRuns, steered: 10 * agreementRuns },
		kept: [],
		kills: []
	})

/**
 * R29 admits exactly the fractions whose native form agrees with the composition, and the native form disagrees where
 * the model of both says, each case in its one rolled-back transaction on the worker's clone.
 *
 * Its pre-conversion budget: runs 12, coverage cases 16 (test/pg/catalog/agreement.test.ts at f6a7126a8).
 */
export const r29AdmitsExactlyTheFractionsWhoseNativeFormAgreesWithTheComposition = property.explore(
	fractionSpace,
	{
		needs: { tx: Substrate.transaction },
		situations: [
			"admitted",
			"kept at p = 0",
			"kept, the native form rounding apart",
			"kept, the native form agreeing"
		] satisfies ReadonlyArray<FractionFeature>,
		check:
			({ tx }, c: Case<FractionFeature>) =>
			(fc) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const options = {
								...defaultRunOptions,
								schema: { kind: "named", name: yield* held.schema("catalog") }
							} as const
							const forced = (p: number): Lowering => ({
								name: `native at p = ${p}`,
								lower: ({ names }) => {
									const half = oracleCase(
										"p = 0.5",
										Q.discretePercentile([0.5], Q.ordinalStage),
										labFacts
									)
									const rewritten = rewriteCatalog(half.query.dag, labOptions)
									if (!rewritten.ok) {
										return rewritten
									}
									const ed = new CatalogEditor(rewritten.value.dag)
									const cell = Option.getOrThrowWith(
										Arr.findFirst(ed.cells(), (c) => c.current.kind === "OrderedSetAggregate"),
										() => new Error("an OrderedSetAggregate node")
									)
									const osa = cell.current
									if (osa.kind !== "OrderedSetAggregate") {
										throw new Error("an OrderedSetAggregate node")
									}
									const spec = defined(osa.fractions[0], "a fraction")
									if (spec.kind !== "literal") {
										throw new Error("a literal fraction")
									}
									const literal = ed.expr({
										...spec,
										value: floatLiteral(p)
									})
									ed.redefine(cell, { ...osa, fractions: [literal] })
									const built = ed.build()
									return Result.flatMap(lowerNative(built, built.roots[0], names), sentConservative)
								}
							})
							const label = `p = ${fc.p}`
							const desc = Q.discretePercentile([fc.p], Q.ordinalStage)
							const facts = fractionFacts(fc)
							const side = catalogLowering(labOptions)
							const catalog = yield* runLabelledOracle(
								oracleCase(label, desc, facts),
								conservative,
								side,
								options
							)
							assert.equal(catalog.comparison.equal, true, printOutcome(catalog))
							assert.deepEqual(
								appliedRules(side.last()),
								admitted(fc.p) ? ["R29"] : ["R26"],
								"the rewrite admits exactly the dyadic fractions in (0, 1]"
							)
							const agrees = Arr.every(fc.groups, (group) => groupAgrees(fc.p, group))
							const native = yield* runLabelledOracle(
								oracleCase(label, desc, facts),
								conservative,
								forced(fc.p),
								options
							)
							assert.equal(native.comparison.equal, agrees, printOutcome(native))
							if (admitted(fc.p)) {
								assert.ok(agrees, "an admitted fraction's native form agrees in every group")
								c.note("admitted")
							} else if (fc.p === 0) {
								c.note("kept at p = 0")
							} else {
								c.note(
									agrees ? "kept, the native form agreeing" : "kept, the native form rounding apart"
								)
							}
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of both forms' positions: the native ceil in double precision, the composition's through a 15-digit numeric"
		},
		show: Formatter.format,
		budget: { runs: agreementRuns, steered: 16 },
		kept: [],
		kills: []
	}
)
