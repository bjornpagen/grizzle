/**
 * A contract predicate's check mode (scalar/compute/lower.ts, scalar/compute/total.ts), and the ContractLiteral check.
 *
 * - The check fragment: a contract predicate lowered in the check mode reads only its VALUE and admits only the
 *   operations the host evaluates for the ContractLiteral check; every other verdict is the query mode's over a column
 *   of the base. Oracle: a differential, the same predicate lowered in the query mode.
 * - ContractLiteral: a literal opposite a contract's term, compared with it or beside it in arithmetic, is admitted
 *   exactly when the contract's predicate holds of it. Oracle: the README's rule, a value opposite a term is a value of
 *   its type.
 *
 * Features: each agreed verdict, a zero divisor, a conditional, least, greatest, abs and sign of a float admitted, and
 * each refusal the check mode alone makes; each site admitted and refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Effect } from "effect"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { baseParams, lowerWith, spelledExpr, v } from "#test/support/unit/compute/support.ts"
import {
	Cents,
	checkMode,
	featuresOf,
	type FragmentFeature,
	holds,
	isArithmetic,
	isRound,
	isValueArithmetic,
	lossy,
	predicateSpace,
	queryMode,
	type Verdict,
	verdictOf
} from "#test/unit/compute/total.fixtures.ts"

/** Contract predicate tables agree with the query mode's lowering of the same predicate, but for the reads, round and the float and money arithmetic a check refuses. Its budget is its suite's before it was a property (test/unit/compute/total.test.ts at 4ca3036a): 400 runs and 1200 steered cases. */
export const contractPredicateTablesAgreeWithTheQueryModesLoweringOfTheSamePredicateButForTheReadsRoundAndTheFloatAndMoneyArithmeticACheckRefuses =
	property.explore(predicateSpace, {
		needs: {},
		budget: { runs: 400, steered: 1200 },
		situations: [
			"agreed: admitted",
			"agreed: PartialOperation",
			"agreed: ResourceBound",
			"agreed: MalformedDescription",
			"a zero divisor refused",
			"a conditional admitted",
			"least admitted",
			"greatest admitted",
			"abs and sign of a float admitted",
			"round refused in a check",
			"float arithmetic refused in a check",
			"money arithmetic refused in a check",
			"a parameter refused in a check",
			"a variable refused in a check"
		] satisfies ReadonlyArray<Reached<FragmentFeature>>,
		check: (_, k: Case<FragmentFeature>) => (c) =>
			Effect.sync(() => {
				const check = verdictOf(checkMode(c))
				const query = verdictOf(queryMode(c))
				k.noteAll(featuresOf(c, check, query))
				const round = holds(c.left, isRound)
				if (c.read !== "value") {
					const own: Verdict =
						c.read === "parameter"
							? "Refused:a schema predicate reads no parameter"
							: "MalformedDescription"
					if (query === "admitted") {
						assert.ok(
							check === own || (round && check === "UnsupportedOperation"),
							`a ${c.read} read in a check: ${own}, not ${check}`
						)
					}
					return
				}
				const exempt = round || (lossy(c.base) && holds(c.left, isArithmetic))
				if (!exempt) {
					assert.equal(check, query, "the check mode's verdict is the query mode's")
					return
				}
				assert.ok(
					check === query || check === "UnsupportedOperation",
					`a check refuses what it holds no CHECK of, or agrees: ${check}, not ${query}`
				)
				if (
					query === "admitted" &&
					(round || (lossy(c.base) && holds(c.left, isValueArithmetic)))
				) {
					assert.equal(check, "UnsupportedOperation", "a check refuses round and lossy arithmetic")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the query mode's lowering of the same predicate over a column of the base"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/registry.ts",
				original: '\tround: { arity: 1, check: false, nodes: ["round"] },',
				replacement: '\tround: { arity: 1, check: true, nodes: ["round"] },',
				why: "round's spec says a check admits it (registry.ts computeSpecs), so a check admits it; the check fragment's property fails."
			}
		]
	})

/** The ContractLiteral check checks a literal opposite a contract's term against its predicate, compared with it or beside it in arithmetic. Its budget is its suite's before it was a property (test/unit/compute/total.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const theContractLiteralCheckChecksALiteralOppositeAContractsTermAgainstItsPredicateComparedWithItOrBesideItInArithmetic =
	property.explore(
		(source) => ({
			n: source.draw(bigint(-1000n, 1000n)),
			site: source.draw(element(["compare" as const, "arithmetic" as const]))
		}),
		{
			needs: {},
			budget: { runs: 100, steered: 100 },
			situations: [
				"compare admitted",
				"compare refused",
				"arithmetic admitted",
				"arithmetic refused"
			] satisfies ReadonlyArray<Reached<`${"compare" | "arithmetic"} ${"admitted" | "refused"}`>>,
			check:
				(_, c: Case<`${"compare" | "arithmetic"} ${"admitted" | "refused"}`>) =>
				({ n, site }) =>
					Effect.sync(() => {
						const vars = { c: { kind: "column", type: Cents.scalar } } as const
						const result =
							site === "arithmetic"
								? lowerWith(
										"query",
										spelledExpr(computeCore.add(v("c", Cents), n).expr),
										vars,
										false,
										baseParams
									)
								: lowerWith(
										"query",
										{
											kind: "compare",
											op: "ge",
											left: { kind: "var", var: "c" },
											right: { kind: "literal", value: n }
										},
										vars,
										true,
										baseParams
									)
						if (n >= 0n) {
							c.note(`${site} admitted`)
							succeeded(result)
						} else {
							c.note(`${site} refused`)
							refused(result, "ContractLiteral")
						}
					}),
			oracle: {
				kind: "specification",
				name: "README: a value opposite a term is a value of its type, so the contract judges it wherever it stands"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original:
						"\tfor (const key of keys) {\n\t\tconst child = key === skip ? undefined : value[key]\n\t\tif (child === undefined) {",
					replacement:
						"\tfor (const key of keys) {\n\t\tconst child = key !== skip ? undefined : value[key]\n\t\tif (child === undefined) {",
					why: "Operator mutant 22ac258f7b at packages/engine/src/ir/shape.ts:950 in readRequired: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)
