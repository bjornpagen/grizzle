/**
 * The scalar registry against PostgreSQL 19's catalog (scalar/compute/registry.ts): every entry names the operator,
 * function, cast, input function or constructor PostgreSQL has, with the operand types, result type and volatility the
 * catalog states, and no node has two entries over the same operands.
 *
 * Oracle: PostgreSQL itself, pg_operator, pg_proc, pg_cast and pg_type's rows for the object an entry names.
 *
 * Features: an entry of each kind, operator, function, cast, input and construct.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { describeOp } from "#compiler/ir/expr.ts"
import { nativeOps, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import { type EntryKind, entryProblems, sameOperands } from "#test/pg/compute/registry.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The scalar registry against pg_operator, pg_proc and pg_cast names the catalog's operator, function or cast for every entry, with its result type and volatility, once per node and operands.
 *
 * Exhaustive, though its box is larger than the runner's default budget (fastcycle's cull): each entry is a claim of
 * its own, so a drawn entry checks one claim in 416, and its kill, date_pli's entry gone (trunk's red at 44aaba8fe,
 * fixed by 0615fdabf), falsifies one entry alone. Drawn from the same generator at the runner's default budget, 38
 * floor and 200 steered cases, the kill survived (`TEST_SEED=2219874524 pnpm exec toolchain-test kills
 * test/pg/compute/registry.test.ts`, ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log, 2026-11-23), so a
 * search would need more cases than the box holds to kill it on every run; the box kills it at its entry.
 */
export const theComputeRegistryAgainstPgOperatorPgProcAndPgCastNamesTheCatalogsOperatorFunctionOrCastForEveryEntryWithItsResultTypeAndVolatilityOncePerNodeAndOperands =
	property.exhaust(finite(int(0, nativeOps.length - 1)), {
		needs: { tx: Substrate.transaction },
		situations: ["operator", "function", "cast", "input", "construct"] satisfies ReadonlyArray<
			Reached<EntryKind>
		>,
		check:
			({ tx }, c: Case<EntryKind>) =>
			(i) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

					const op = defined(nativeOps[i], `entry ${i}`)
					const doubled =
						op.fn !== "cast" &&
						Arr.some(
							Arr.take(nativeOps, i),
							(o) => o.fn === op.fn && sameOperands(o.operands, op.operands)
						)
							? [
									`${describeOp(op.id)}: a second ${op.fn} over ${Arr.join(operandCarriers(op.operands), ", ")}`
								]
							: []
					const problems = yield* entryProblems(db, op)
					assert.deepEqual([...doubled, ...problems], [])
					c.note(op.catalog.kind)
				}),
		oracle: {
			kind: "postgresql",
			name: "pg_operator, pg_proc, pg_cast and pg_type's entries for the object an entry names"
		},
		box: "every entry of the scalar registry",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/registry.ts",
				original: "\tdate_pli: datePlus,\n",
				replacement: "",
				why: "The registry holds no entry of date + integer, date_pli, which Time.dateOfEpochDay's construct uses, so the operator's catalog object, result type and volatility are nobody's to state (0615fdabf's red at 44aaba8fe)."
			}
		]
	})
