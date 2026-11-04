/**
 * The reference evaluator's faster paths against its nested loops (test/support/oracle/reference/evaluate.ts).
 *
 * A region's occurrence plans and an existence test's column positions only change how the reference finds the rows
 * its definition visits: reading columns by position, and looking a stable source's candidate rows up by the identity
 * of one join value. NestedLoops refuses every plan, so the reference evaluates each region and existence test by the
 * nested loops of its definition; on the oracle populations, both readings agree on every delivered row in order, on
 * every decline the reference observes, and on every refusal. The hash identity they rely on, indexKey, agrees with
 * native comparison wherever it gives one.
 *
 * An enum handle outside its roster compares equal to every other such handle.
 *
 * A value of another carrier is a defect comparison reports.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Result } from "effect"
import type { RelDag } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert } from "#test/support/assert.ts"
import {
	defaultGenConfig,
	optimizerGenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"

import {
	bool,
	float4,
	float8,
	int4,
	int8,
	money,
	numeric,
	scalarOfSpec
} from "#test/support/oracle/gen/domain.ts"

import {
	defaultGraphLimits,
	defaultRecursiveLimits,
	fixedLengthCaseGen,
	recursiveCaseGen
} from "#test/support/oracle/gen/recursive.ts"
import { closedIdType } from "#test/support/oracle/gen/schema.ts"
import { expectedStatements } from "#test/support/oracle/reference/deliver.ts"
import {
	type ExistencePlan,
	noBindings,
	type OccurrencePlan,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"

import { equal, indexKey, rowKey, type Value } from "#test/support/oracle/reference/values.ts"

class NestedLoops extends Reference {
	static nested(dag: RelDag, input: ReferenceInput): NestedLoops {
		return new NestedLoops(dag, input).settle()
	}

	override regionPlans(): Option.Option<ReadonlyArray<OccurrencePlan>> {
		return Option.none()
	}

	override existencePlan(): Option.Option<ExistencePlan> {
		return Option.none()
	}
}

/**
 * Everything the reference makes of a case, in order: the root's rows, each delivered statement's rows, every decline,
 * and the refusal or defect that stops it.
 */
const transcript = (c: QueryCase, nested: boolean): string => {
	const lines: Array<string> = []
	const input: ReferenceInput = {
		schema: c.schema,
		facts: c.facts,
		params: c.query.params,
		observer: {
			...unobserved,
			decline: (reason) => {
				lines.push(`declined ${reason}`)
			}
		}
	}
	const ref = nested ? NestedLoops.nested(c.query.dag, input) : Reference.of(c.query.dag, input)
	const ran = Result.try(() => {
		const rel = ref.eval(c.query.dag.roots[0], noBindings)
		lines.push(
			`root ${Arr.join(
				Arr.map(rel.rows, (r) => rowKey(r, rel.heading)),
				" "
			)}`
		)
		for (const s of expectedStatements(ref, c.query.dag.roots[0])) {
			lines.push(
				`${s.label} ${Arr.join(
					Arr.map(s.rows, (r) => rowKey(r, s.heading)),
					" "
				)}`
			)
		}
	})
	if (Result.isFailure(ran)) {
		const e = ran.failure
		lines.push(`stop ${Error.isError(e) ? `${e.name} ${e.message}` : String(e)}`)
	}
	return Arr.join(lines, "\n")
}

/**
 * Explores a population: on every case the plans' transcript equals the nested loops'. The floor and rotating streams
 * together run 600 cases.
 */
const agree = (suite: string, generator: Gen<QueryCase>) =>
	explore(
		{
			suite,
			draw: drawn(generator),
			literal: Formatter.format,
			coverage: noCoverage,
			kept: [],
			runs: 480,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang: Duration.minutes(2)
		},
		(c) =>
			Effect.sync(() => {
				assert.equal(transcript(c, false), transcript(c, true))
			})
	)

const slow = 180_000

describe("the reference evaluator's plans", () => {
	it.effect(
		"agree with its nested loops on the oracle populations",
		(ctx) =>
			Effect.gen(function* () {
				yield* searched(
					ctx,
					agree("unit/oracle-runner/reference-plans-conservative", queryCaseGen(defaultGenConfig))
				)
				yield* searched(
					ctx,
					agree("unit/oracle-runner/reference-plans-optimized", queryCaseGen(optimizerGenConfig))
				)
			}),
		slow
	)

	it.effect(
		"agree with its nested loops where joins and merges meet twin spellings",
		(ctx) =>
			Effect.gen(function* () {
				yield* searched(
					ctx,
					agree(
						"unit/oracle-runner/reference-plans-twinned",
						queryCaseGen({
							...defaultGenConfig,
							spelling: "twinned"
						})
					)
				)
				yield* searched(
					ctx,
					agree(
						"unit/oracle-runner/reference-plans-one-palette",
						queryCaseGen({
							...defaultGenConfig,
							spelling: "twinned",
							schema: {
								...defaultGenConfig.schema,
								maxPalette: 1
							}
						})
					)
				)
			}),
		slow
	)

	it.effect(
		"agree with its nested loops on recursions",
		(ctx) =>
			Effect.gen(function* () {
				yield* searched(
					ctx,
					agree(
						"unit/oracle-runner/reference-plans-recursive",
						recursiveCaseGen(defaultRecursiveLimits)
					)
				)
				yield* searched(
					ctx,
					agree(
						"unit/oracle-runner/reference-plans-fixed-length",
						fixedLengthCaseGen(defaultGraphLimits)
					)
				)
			}),
		slow
	)
})

describe("indexKey", () => {
	const int2 = scalarOfSpec({ carrier: "int2" })
	const text = scalarOfSpec({ carrier: "text" })
	const uuid = scalarOfSpec({ carrier: "uuid" })
	const handles = closedIdType({ name: "Color", handles: ["red", "green"] })
	const samples: Arr.NonEmptyReadonlyArray<
		readonly [ScalarType, Arr.NonEmptyReadonlyArray<Value>]
	> = [
		[int2, [0n, 1n, -1n, 32767n]],
		[int4, [0n, 7n, -7n]],
		[int8, [0n, 9007199254740993n, -9007199254740993n]],
		[
			numeric,
			Arr.map(
				[
					"1",
					"1.0",
					"1.00",
					"-1",
					"0",
					"0.000",
					"10",
					"1e1",
					"NaN",
					"Infinity",
					"-Infinity"
				] as const,
				(spelled) => Decimal.of(spelled)
			)
		],
		[float4, [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]],
		[
			float8,
			[
				0,
				-0,
				0.1,
				0.30000000000000004,
				Number.NaN,
				Number.NEGATIVE_INFINITY,
				Number.POSITIVE_INFINITY
			]
		],
		[money, [Money.of(0n), Money.of(105n), Money.of(-105n)]],
		[bool, [true, false]],
		[text, ["", "a", "A", "a\u0000", "\u{1F600}", "￿"]],
		[uuid, ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"]],
		[handles, ["red", "green"]]
	]

	it.effect("is one identity exactly for the values comparison finds equal", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/oracle-runner/index-key",
					/** Each sampled type, and every ordered pair of its values. */
					generator: (source) => {
						const [type, values] = source.draw(element(samples))
						return [type, source.draw(element(values)), source.draw(element(values))] as const
					},
					literal: Formatter.format,
					/** The squares of the samples' counts: 4, 3, 3, 11, 5, 7, 3, 2, 6, 2 and 2 values. */
					limit: 286,
					coverage: noCoverage,
					caseHang: Duration.minutes(2)
				},
				([type, a, b]) =>
					Effect.sync(() => {
						const ka = indexKey(a, type)
						const kb = indexKey(b, type)
						assert.notEqual(ka, undefined)
						assert.equal(
							ka === kb,
							equal(a, b, type),
							`${Formatter.format(a)} and ${Formatter.format(b)} as ${type.carrier}`
						)
					})
			)
		)
	)

	it("gives none where comparison alone decides", () => {
		assert.equal(indexKey("blue", handles), undefined)
		assert.equal(indexKey(1, int4), undefined)
		assert.equal(indexKey(1n, numeric), undefined)
		assert.equal(indexKey("1", float8), undefined)
		assert.equal(indexKey(1n, money), undefined)
		assert.equal(indexKey("t", bool), undefined)
		assert.equal(indexKey(1n, text), undefined)
		assert.equal(indexKey(1n, handles), undefined)
	})
})
