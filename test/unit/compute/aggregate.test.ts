/**
 * Aggregates over generated inputs. min and max, LEAST and GREATEST return one of their inputs, so what a head delivers
 * keeps the contract that input has, over a contract drawn over each type they are defined on: a column of the contract
 * and a parameter of it, which a rule reads as its base, deliver the contract, and Type.base of a column the plain
 * value. The oracle is the compiled heading's type.
 *
 * - Conditional counts: sum(cond(p, 1, 0)) over literals of one carrier counts by FILTER, and every other shape stays
 *   composed, over every shape of the box. Oracle: the specification of R24's rewrite.
 * - Vocabulary: the registry lists a node for every word of the description vocabulary. Oracle: the registry's own list.
 * - Returning input: min, max, LEAST and GREATEST deliver the contract of the input they return. Oracle: the compiled
 *   heading's type.
 * - Mean bound: a numeric mean's result bound holds the mean of its argument's greatest value, and that mean reaches its
 *   integer digits. Oracle: the reference evaluator's numeric_avg.
 *
 * Features: counted by FILTER and left composed; each word kind; each function over each reading; each way a mean
 * rounds.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { numericBoundOf } from "#compiler/ir/scalar.ts"
import { flight } from "#compiler/lower/conservative/types.ts"

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { aggregateOverload } from "#compiler/scalar/aggregate.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
import { aggregate } from "#test/support/oracle/reference/aggregate.ts"
import { asDecimal } from "#test/support/oracle/reference/values.ts"
import {
	argumentBoundGen,
	countsByFilter,
	headOf,
	integerDigits,
	integerLeaves,
	kept,
	listed,
	type MeanFeature,
	numericLeaves,
	aggregateQueryOf,
	type Reading,
	readings,
	type Returning,
	returnings,
	shapes,
	type VocabularyWord,
	words
} from "#test/unit/compute/aggregate.fixtures.ts"

/** R24 conditional aggregates counts by FILTER exactly sum(cond(p, 1, 0)) over literals of one carrier, and leaves every other shape composed. */
export const r24ConditionalAggregatesCountsByFILTERExactlySumCondP10OverLiteralsOfOneCarrierAndLeavesEveryOtherShapeComposed =
	property.exhaust(
		finite(
			oneOf([
				(source) =>
					[source.draw(shapes), source.draw(integerLeaves), source.draw(integerLeaves)] as const,
				(source) =>
					[source.draw(shapes), source.draw(numericLeaves), source.draw(numericLeaves)] as const
			])
		),
		{
			needs: {},
			situations: ["counted by FILTER", "left composed"] satisfies ReadonlyArray<
				Reached<"counted by FILTER" | "left composed">
			>,
			check:
				(_, c: Case<"counted by FILTER" | "left composed">) =>
				([shape, then, otherwise]) =>
					Effect.sync(() => {
						const counts =
							shape === "sum" &&
							((then === "integer 1" && otherwise === "integer 0") ||
								(then === "numeric(5,1) 1.0" && otherwise === "numeric(5,1) 0"))
						c.note(counts ? "counted by FILTER" : "left composed")
						const template = succeeded(
							compileTemplate(aggregateQueryOf(shape, then, otherwise), undefined, testCompile)
						)
						const { optimized, conservative } = template.programs
						assert.equal(
							countsByFilter(Arr.map(programAsts(optimized), (ast) => ({ ast }))),
							counts,
							`${shape}(cond(p, ${then}, ${otherwise}))`
						)
						if (!counts) {
							assert.equal(countsByFilter(flight(conservative.roots)), false)
						}
					}),
			oracle: {
				kind: "specification",
				name: "R24: sum(cond(p, 1, 0)) over literals of one carrier is a count with a FILTER"
			},
			box: "sum or bare cond(p, a, b) over every pair of integer branches and of numeric(5,1) branches",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/aggregate/index.ts",
					original: "\t\tintegerLiteral(one.value) === 1n &&",
					replacement: "\t\tintegerLiteral(one.value) === 2n &&",
					why: "R24's rewrite counts cond(p, 2, 0) by FILTER and leaves cond(p, 1, 0) composed; the conditional counts property fails."
				}
			]
		}
	)

/** The overload registry names a node for every word of the description vocabulary. */
export const theOverloadRegistryNamesANodeForEveryWordOfTheDescriptionVocabulary = property.exhaust(
	finite(words),
	{
		needs: {},
		situations: [
			"word function",
			"word comparison",
			"word connective",
			"word cast"
		] satisfies ReadonlyArray<Reached<`word ${VocabularyWord["kind"]}`>>,
		check: (_, c: Case<`word ${VocabularyWord["kind"]}`>) => (word) =>
			Effect.sync(() => {
				c.note(`word ${word.kind}`)
				assert.ok(
					listed.has(word.node),
					`the registry lists no ${word.node} node for ${Formatter.format(word)}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the registry lists a node of every function it names"
		},
		box: "each node every scalar function lowers to, every comparison, every connective and the cast",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/registry.ts",
				original:
					"\t...Object.entries(catalogOverloads).map(([id, overload]) => listedOp(opId(id), overload)),",
				replacement:
					'\t...Object.entries(catalogOverloads)\n\t\t.filter(([id]) => !id.startsWith("between:"))\n\t\t.map(([id, overload]) => listedOp(opId(id), overload)),',
				why: "The registry lists no BETWEEN node; the vocabulary property fails."
			}
		]
	}
)

/** Min, max, LEAST and GREATEST deliver the contract of the input they return. */
export const minMaxLEASTAndGREATESTDeliverTheContractOfTheInputTheyReturn = property.exhaust(
	finite(
		(source) =>
			[
				source.draw(element(kept)),
				source.draw(element(returnings)),
				source.draw(element(readings))
			] as const
	),
	{
		needs: {},
		situations: nonEmpty(
			Arr.flatMap(returnings, (f) => Arr.map(readings, (g) => `${f} over a ${g}` as const)),
			"each function over each reading"
		) satisfies ReadonlyArray<Reached<`${Returning} over a ${Reading}`>>,
		check:
			(_, c: Case<`${Returning} over a ${Reading}`>) =>
			([k, returning, reading]) =>
				Effect.sync(() => {
					c.note(`${returning} over a ${reading}`)
					const Held = relation("Held", { id: Id, a: k, b: k }, ["id"])
					const held = queryOver(schema("Held", [Held], [])).rule((r: RuleValue) => {
						const x = varsOver(Held, "held")
						return r
							.match(Held, { id: x["id"], a: x["a"], b: x["b"] })
							.find({ out: headOf(r, x, k, returning, reading) })
					})
					const template = succeeded(compileTemplate(held, undefined, testCompile))
					const out = defined(
						Option.getOrUndefined(
							Arr.findFirst(template.heading, (column) => column.name === "out")
						),
						"the head's column"
					)
					const delivered = out.type.contract
					assert.equal(
						delivered === undefined ? undefined : String(delivered.name),
						reading === "base" ? undefined : k.name,
						`${returning} over a ${reading} of ${k.name}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "the compiled heading's type: the input's contract, none for its base"
		},
		box: "every contract min, max, LEAST and GREATEST are defined on, under each, read each way",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/aggregate.ts",
				original: "\tconst kept = arg",
				replacement: "\tconst kept = baseOf(arg)",
				why: "min and max deliver their argument's base, not its contract; the returning input property fails."
			}
		]
	}
)

/** A numeric mean's result bound holds the mean of its argument's greatest value, PostgreSQL's numeric_avg, and that mean reaches its integer digits. */
export const aNumericMeansResultBoundHoldsTheMeanOfItsArgumentsGreatestValuePostgreSQLsNumericAvgAndThatMeanReachesItsIntegerDigits =
	property.exhaust(finite(argumentBoundGen), {
		needs: {},
		situations: [
			"kept at its argument's scale",
			"rounded up into a new integer digit",
			"rounded to zero",
			"an argument holding zero alone"
		] satisfies ReadonlyArray<Reached<MeanFeature>>,
		check: (_, c: Case<MeanFeature>) => (bound) =>
			Effect.sync(() => {
				const argType = numericValue(bound)
				const result = succeeded(
					aggregateOverload({ name: "mean", arg: argType }, SourceLoc("test", [])),
					"the mean's overload"
				).result
				const greatest = succeeded(
					N.fromUnits(10n ** BigInt(Math.max(bound.digits + bound.scale, 0)) - 1n, bound.scale),
					"the argument's greatest value"
				)
				const mean = asDecimal(aggregate("avg", [greatest], argType))
				succeeded(strictRead(result, mean.text), "the mean within its bound")
				const p = mean.parts
				if (p.kind !== "finite" || p.coefficient === 0n) {
					c.note(greatest.isZero() ? "an argument holding zero alone" : "rounded to zero")
					return
				}
				c.note(
					mean.equals(greatest)
						? "kept at its argument's scale"
						: "rounded up into a new integer digit"
				)
				assert.equal(
					integerDigits(p.coefficient, p.minScale),
					defined(numericBoundOf(result), "the mean's bound").digits,
					"the mean reaches its bound's integer digits"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's numeric_avg, written from numeric.c (test/support/oracle/reference/aggregate.ts numericMean), read back by the strict reader"
		},
		box: "a computed numeric argument of integer digits -1002 to -998 or -2 to 2 and scale 0 to 2 or 998 to 1002",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/aggregate.ts",
				original: "\t\t\t\t: Math.max(b.digits, -numericMaxDisplayScale) + 1,",
				replacement: "\t\t\t\t: Math.max(b.digits, -numericMaxDisplayScale),",
				why: "A numeric mean whose argument has more fraction digits than its scale loses the integer digit its rounding may carry; the mean bound property fails."
			}
		]
	})
