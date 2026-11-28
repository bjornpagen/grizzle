/** What the properties of reference-plans.test.ts read: its spaces, models and helpers. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Budget, type Kill, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import type { RelDag } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { ValueIdentity } from "#test/support/kernel/identity.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
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
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import {
	type DeclineReason,
	rowIdentity,
	type Value
} from "#test/support/oracle/reference/values.ts"

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

/** One thing the reference makes of a case: a relation's rows by their identities, a decline, or what stops it. */
type TranscriptEntry =
	| { readonly kind: "rows"; readonly label: string; readonly rows: ReadonlyArray<ValueIdentity> }
	| { readonly kind: "declined"; readonly reason: DeclineReason }
	| { readonly kind: "stop"; readonly what: string }

/**
 * Everything the reference makes of a case, in order: the root's rows, each delivered statement's rows, every decline,
 * and the refusal or defect that stops it.
 */
const transcript = (c: QueryCase, nested: boolean): ReadonlyArray<TranscriptEntry> => {
	const lines: Array<TranscriptEntry> = []
	const input: ReferenceInput = {
		schema: c.schema,
		facts: c.facts,
		params: c.query.params,
		functions: noFunctions,
		observer: {
			...unobserved,
			decline: (reason) => {
				lines.push({ kind: "declined", reason })
			}
		}
	}
	const ref = nested ? NestedLoops.nested(c.query.dag, input) : Reference.of(c.query.dag, input)
	const ran = Result.try(() => {
		const rel = ref.eval(c.query.dag.roots[0], noBindings)
		lines.push({
			kind: "rows",
			label: "root",
			rows: Arr.map(rel.rows, (r) => rowIdentity(r, rel.heading))
		})
		for (const s of expectedStatements(ref, c.query.dag.roots[0])) {
			lines.push({
				kind: "rows",
				label: s.label,
				rows: Arr.map(s.rows, (r) => rowIdentity(r, s.heading))
			})
		}
	})
	if (Result.isFailure(ran)) {
		const e = ran.failure
		lines.push({ kind: "stop", what: Error.isError(e) ? `${e.name} ${e.message}` : String(e) })
	}
	return lines
}

/** Explores a population: on every case the plans' transcript equals the nested loops'. */
export const agree = (
	generator: Gen<QueryCase>,
	own: { readonly budget: Budget; readonly kills: ReadonlyArray<Kill> }
) =>
	property.explore(generator, {
		needs: {},
		situations: [],
		check: () => (c) =>
			Effect.sync(() => {
				assert.deepEqual(transcript(c, false), transcript(c, true))
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference's nested loops of its definition, every plan refused"
		},
		budget: own.budget,
		kept: [],
		kills: own.kills
	})

const int2 = scalarOfSpec({ carrier: "int2" })
const text = scalarOfSpec({ carrier: "text" })
const uuid = scalarOfSpec({ carrier: "uuid" })
export const handles = closedIdType({ name: "Color", handles: ["red", "green"] })
const samples: Arr.NonEmptyReadonlyArray<readonly [ScalarType, Arr.NonEmptyReadonlyArray<Value>]> =
	[
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
				(spelled) => Numeric.of(spelled)
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

/**
 * Every sampled value of every type, so each type meets every other carrier's values, and the handles type meets
 * strings outside its roster, which comparison refuses.
 */
const everyValue = nonEmpty(
	Arr.flatMap(samples, ([, values]) => values),
	"the sampled values"
)

/** What indexIdentity gives a pair of sampled values. */
export type KeyFeature =
	| "one identity"
	| "two identities"
	| "none for another carrier"
	| "none outside the roster"

/** Each sampled type, and every ordered pair of every type's values. */
export const keyPairs: Gen<
	readonly [ScalarType, Arr.NonEmptyReadonlyArray<Value>, Value, Value]
> = (source) => {
	const [type, own] = source.draw(element(samples))
	return [type, own, source.draw(element(everyValue)), source.draw(element(everyValue))] as const
}
