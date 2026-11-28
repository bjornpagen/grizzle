/**
 * Lowering a scalar description in query mode (scalar/compute/lower.ts).
 *
 * - Untyped leaves: a literal never stands first; a parameter does, at its declared type; two untyped literal branches
 *   are typed by the literal typing rule, a number integer and a bigint bigint, and branches of the two are malformed;
 *   a JavaScript fraction is no numeric literal. Oracle: the literal typing rule as a checker.
 * - Casts into a contract: every partial cast of a lowered table carries a proof the kernel re-derives, and every cast
 *   into a contract is a domain cast whose proof holds, checked or unchecked, over generated terms and planted
 *   conditionals. Oracle: the proof kernel (oracle/proof.ts operationProofHolds).
 * - Common type: a conditional, LEAST or GREATEST over two compatible terms has one common type whichever comes first,
 *   each branch widening into it, and an exact value beside a plain value of its family is refused in either order.
 *   Oracle: commonType both ways, widensTo, and mixesExact.
 *
 * Features: each untyped form and pair of branch kinds; a generated term, a domain cast into a checked and an unchecked
 * contract; each planted combination in each order.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { exactDigitsOf, sameScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { mixesExact } from "#compiler/scalar/compute/types.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { baseParams, lowerWith, testPg } from "#test/support/unit/compute/support.ts"
import {
	castCaseGen,
	type CastFeature,
	castVars,
	checkCasts,
	combined,
	combinedCaseGen,
	type CombinedFeature,
	combinedVars,
	contracts,
	fields,
	fractionGen,
	generated,
	literalOf,
	lowered,
	noteShape,
	numberColumns,
	opGen,
	pairOf,
	type UntypedFeature,
	type UntypedForm,
	untypedLiteralGen,
	variable,
	vars
} from "#test/unit/compute/lower.fixtures.ts"

/** Lowering in query mode refuses an untyped leaf standing first, types two untyped branches by the literal typing rule, and refuses a fraction for a numeric. Its budget is its suite's before it was a property (test/unit/compute/lower.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const loweringInQueryModeRefusesAnUntypedLeafStandingFirstTypesTwoUntypedBranchesByTheLiteralTypingRuleAndRefusesAFractionForANumeric =
	property.explore(
		(source) => ({
			form: source.draw(
				element<UntypedForm>([
					"literal first",
					"parameter first",
					"two untyped branches",
					"fraction for numeric"
				])
			),
			column: source.draw(element(numberColumns)),
			op: source.draw(opGen),
			literals: source.draw(
				(source) => [source.draw(untypedLiteralGen), source.draw(untypedLiteralGen)] as const
			),
			fraction: source.draw(fractionGen)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [
				"form literal first",
				"form parameter first",
				"form fraction for numeric",
				"branches number and number",
				"branches bigint and bigint",
				"branches number and bigint",
				"branches bigint and number"
			] satisfies ReadonlyArray<Reached<UntypedFeature>>,
			check:
				(_, c: Case<UntypedFeature>) =>
				({ form, column, op, literals: [a, b], fraction }) =>
					Effect.sync(() => {
						const term: ExprDesc = { kind: "var", var: column }
						switch (form) {
							case "literal first":
								c.note(`form ${form}`)
								refused(
									lowerWith(
										"query",
										{ kind: "compare", op, left: literalOf(a), right: term },
										vars,
										true,
										baseParams
									),
									"MalformedDescription"
								)
								return
							case "parameter first": {
								c.note(`form ${form}`)
								const declared = defined(fields[column], "the column's field")
								const sum = succeeded(
									lowerWith(
										"query",
										{
											kind: "compute",
											fn: "add",
											args: [{ kind: "param", name: "q", type: declared.desc }, term]
										},
										vars,
										false,
										baseParams
									)
								)
								assert.ok(
									Arr.some(sum.emitted, (e) => e.kind === "param"),
									"a parameter standing first is lowered at its declared type"
								)
								return
							}
							case "fraction for numeric":
								c.note(`form ${form}`)
								refused(
									lowerWith(
										"query",
										{
											kind: "compare",
											op,
											left: { kind: "var", var: "n" },
											right: { kind: "literal", value: fraction }
										},
										vars,
										true,
										baseParams
									),
									"MalformedDescription"
								)
								return
							case "two untyped branches": {
								c.note(`branches ${a.kind} and ${b.kind}`)
								const cond: ExprDesc = {
									kind: "cond",
									pred: { kind: "var", var: "f" },
									onTrue: literalOf(a),
									onFalse: literalOf(b)
								}
								const result = lowerWith("query", cond, vars, false, baseParams)
								if (a.kind !== b.kind) {
									refused(result, "MalformedDescription")
									return
								}
								const expected = a.kind === "number" ? testPg.integer : testPg.bigint
								const { nominal } = succeeded(result).root
								assert.ok(
									sameScalarType(nominal, expected.scalar),
									`${a.kind} branches typed ${typeLabel(nominal)}`
								)
								return
							}
						}
					}),
			oracle: {
				kind: "specification",
				name: "the literal typing rule: a literal never first, a number integer, a bigint bigint, no fraction for a numeric"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original:
						'\t\tif (desc.kind === "literal" && desc.type === undefined) {\n\t\t\treturn stop(\n\t\t\t\t"MalformedDescription",\n\t\t\t\tat,\n\t\t\t\t"a term here: a literal takes the type of the term it meets and never stands first"\n\t\t\t)\n\t\t}\n',
					replacement: "",
					why: "An untyped literal standing first is lowered at its value's type, not refused; the untyped leaves property fails."
				}
			]
		}
	)

/** A conversion into a contract can fail wherever the contract has a CHECK, never total. Its budget is its suite's before it was a property (test/unit/compute/lower.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const aConversionIntoAContractCanFailWhereverTheContractHasACHECKNeverTotal =
	property.explore(castCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"generated term",
			"domain cast into a checked contract",
			"domain cast into an unchecked contract"
		] satisfies ReadonlyArray<Reached<CastFeature>>,
		check: (_, c: Case<CastFeature>) => (sketch) =>
			Effect.sync(() => {
				if (sketch.kind === "generated") {
					generated(sketch.term, c)
					return
				}
				const name = sketch.contract
				const chosen = contracts[name]
				const column: ExprDesc = { kind: "var", var: name }
				/**
				 * Type.cast of a contract column into its own contract: castTo leaves a numeric contract's value at its
				 * base typmod, so the conditional converts it into the domain (CastHow "domain"), the one path a checked
				 * schema reaches.
				 */
				const other: ExprDesc =
					sketch.other === "column"
						? column
						: sketch.other === "parameter"
							? { kind: "param", name: "q", type: chosen.desc }
							: { kind: "cast", arg: column, to: chosen.desc }
				const desc: ExprDesc = {
					kind: "cond",
					pred: { kind: "var", var: "f" },
					onTrue: sketch.contractFirst ? column : other,
					onFalse: sketch.contractFirst ? other : column
				}
				checkCasts(lowered(desc, castVars).emitted, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the proof kernel re-deriving each cast's preconditions (oracle/proof.ts operationProofHolds)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/compute/lower.test.ts#aConversionIntoAContractCanFailWhereverTheContractHasACHECKNeverTotal:-:1.2.1.0"
				),
				reason: "tag or its parameter",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/lower.ts",
				original: "\t\t\t\treturn this.emit({ ...node.spec, proof: this.domainProof(node) })",
				replacement: "\t\t\t\treturn this.emit({ ...node.spec, proof: [] })",
				why: "A domain cast carries no proof; the casts into a contract property fails."
			}
		]
	})

/** A combination of two compatible terms combines in one common type whichever comes first, and widens each branch into it. Its budget is its suite's before it was a property (test/unit/compute/lower.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const aCombinationOfTwoCompatibleTermsCombinesInOneCommonTypeWhicheverComesFirstAndWidensEachBranchIntoIt =
	property.explore(combinedCaseGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"generated cond",
			"generated least or greatest",
			"sign over the other branch's typmod, sign first",
			"sign over the other branch's typmod, sign second",
			"sign over another typmod, sign first",
			"sign over another typmod, sign second",
			"sign over a negative scale, sign first",
			"sign over a negative scale, sign second",
			"a plain span against a based fixed-width span, base first",
			"a plain span against a based fixed-width span, base second",
			"an exact value beside a plain value of its family refused, exact first",
			"an exact value beside a plain value of its family refused, plain first"
		] satisfies ReadonlyArray<Reached<CombinedFeature>>,
		check: (_, c: Case<CombinedFeature>) => (sketch) =>
			Effect.sync(() => {
				const pair = pairOf(sketch)
				if (pair === undefined) {
					return
				}
				const [term, other] = pair
				const left = lowered(term, combinedVars).root
				const right = lowered(other, combinedVars).root
				for (const [first, second, a, b] of [
					[term, other, left, right],
					[other, term, right, left]
				] as const) {
					const cond: ExprDesc = {
						kind: "cond",
						pred: variable("f"),
						onTrue: first,
						onFalse: second
					}
					if (mixesExact(a.nominal, b.nominal)) {
						for (const combination of [
							cond,
							{ kind: "compute", fn: "least", args: [first, second] },
							{ kind: "compute", fn: "greatest", args: [first, second] }
						] as const) {
							refused(
								lowerWith("query", combination, combinedVars, false, baseParams),
								"MalformedDescription"
							)
						}
						c.note(
							`an exact value beside a plain value of its family refused, ${exactDigitsOf(a.nominal) === undefined ? "plain" : "exact"} first`
						)
						continue
					}
					if (combined(cond, a, b, (node) => node.args.slice(1))) {
						noteShape(first, second, c)
						if (sketch.kind === "generated") {
							c.note("generated cond")
						}
					}
					for (const fn of ["least", "greatest"] as const) {
						if (
							combined({ kind: "compute", fn, args: [first, second] }, a, b, (node) => node.args) &&
							sketch.kind === "generated"
						) {
							c.note("generated least or greatest")
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "commonType taken in either order, and each branch reaching it by a widening (widensTo)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/types.ts",
				original: "\t\treturn numericValue(numericHull(nx, ny))",
				replacement: "\t\treturn x",
				why: "Two numeric typmods' common type is the first's, not their hull; the common type property fails."
			}
		]
	})
