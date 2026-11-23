/**
 * Every operation of grizzle's scalar language over operands that are each NULL or one of two values, on PostgreSQL
 * 19: grizzle's host evaluator (scalar/compute/evaluate.ts) agrees with PostgreSQL, NULL included, and so does the
 * model of language.ts.
 *
 * The box, exhausted: each operation the host evaluates in a check (each comparison over each sort, BETWEEN, IN, AND,
 * OR, NOT, arithmetic, greatest, a guarded division and remainder, concatenation and a text's prefix and suffix tests,
 * a set's algebra and tests, and a conditional), with each operand slot a closed read of Pick at k0, at k1 or at k2,
 * which Pick holds no row at: the first value, the second, or NULL. A slot of a set reads Next at the flag Pick holds,
 * a bigint casts the integer, an exact integer adds zero to it, and a truth compares the boolean with true. Each case's
 * expression stands in a row check, whose installed predicate the law model holds; the host evaluates it, and for a
 * term its first operand, over the closed rows the host's fill reads, and PostgreSQL evaluates the expression written
 * in plain SQL from its meaning alone.
 *
 * The roundings (round, trunc, ceil and floor) are a query's alone: each case of one holds that every place the host
 * evaluates an expression refuses it at compile (a row check, a generated field, a containment's and a key's
 * selection, a fold's selection and a fold stepping a generated field), and that the host's evaluator, over the
 * registry's node of it, claims no value but NULL's, where PostgreSQL's is NULL too.
 *
 * Oracle: PostgreSQL itself, the expression written in plain SQL from its meaning alone, with the model of language.ts
 * agreeing.
 *
 * Features: every operation form, a NULL operand and none, and each of Kleene's and SQL's NULL rules the box turns on.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	caseGen,
	type Feature,
	operatorCase,
	roundingPositions
} from "#test/pg/null/operators.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Each operation over NULL is evaluated by the host as PostgreSQL evaluates it, at every slot NULL or a value.
 *
 * Exhaustive, though its box is larger than the runner's default budget (fastcycle's cull): drawn from the same
 * generator at the runner's default budget, its 38 floor and 200 steered cases reached none of cond, guard, OR over
 * unknown, a guard's otherwise at NULL, a conditional's else at unknown, BETWEEN false at an unknown bound and a
 * singleton read at an absent key, so the search goes red with no mutant (`TEST_SEED=2219874524 pnpm exec toolchain-test
 * kills test/pg/null/operators.test.ts`, ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log, 2026-11-23); the box
 * reaches every situation it requires and kills its kill.
 */
export const eachOperationOverNULLIsEvaluatedByTheHostAsPostgreSQLEvaluatesItAtEverySlotNULLOrAValue =
	property.exhaust(finite(caseGen), {
		needs: { tx: Substrate.transaction },
		situations: [
			"compare",
			"between",
			"in",
			"connective",
			"not",
			"arith",
			"extremum",
			"cast",
			"text",
			"set",
			"cond",
			"guard",
			"a NULL operand",
			"no NULL operand",
			"NOT keeps unknown unknown",
			"OR holds over unknown",
			"AND fails over unknown",
			"a guard takes its otherwise at NULL",
			"a conditional takes its else at unknown",
			"greatest or least skips a NULL",
			"BETWEEN is false with one bound unknown",
			"IN is unknown at a NULL subject",
			"a singleton of an id read at an absent key is NULL",
			...Arr.map(roundingPositions, (position): Feature => `a ${position} refuses a rounding`),
			"the host declines a rounding",
			"a rounding of NULL is NULL"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ tx }, c: Case<Feature>) =>
			(oc) =>
				Effect.gen(function* () {
					const { session: owner } = yield* tx
					return yield* operatorCase(owner, oc, c)
				}),
		oracle: {
			kind: "postgresql",
			name: "the expression written in plain SQL from its meaning alone, evaluated by PostgreSQL, with the model of language.ts agreeing"
		},
		box: "each operation the host evaluates in a check, and each rounding in every place the host evaluates an expression, every operand slot NULL or one of two values",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: "\t\t\treturn { present, absent: (values) => Result.ok(extreme(values)) }",
				replacement: "\t\t\treturn { present, absent: () => nullValue }",
				why: "The host's greatest and least return NULL when any operand is NULL."
			}
		]
	})
