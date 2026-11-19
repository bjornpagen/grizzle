/**
 * The Compute registry against PostgreSQL 19's catalog (scalar/compute/registry.ts): every entry names the operator,
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
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The Compute registry against pg_operator, pg_proc and pg_cast names the catalog's operator, function or cast for every entry, with its result type and volatility, once per node and operands.
 */
export const theComputeRegistryAgainstPgOperatorPgProcAndPgCastNamesTheCatalogsOperatorFunctionOrCastForEveryEntryWithItsResultTypeAndVolatilityOncePerNodeAndOperands =
	property.exhaust(finite(int(0, nativeOps.length - 1)), {
		needs: { substrate: Substrate.installing },
		situations: ["operator", "function", "cast", "input", "construct"] satisfies ReadonlyArray<
			Reached<EntryKind>
		>,
		check:
			({ substrate }, c: Case<EntryKind>) =>
			(i) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { session } = yield* Substrate
						const db = yield* session(ownerSession())

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
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "pg_operator, pg_proc, pg_cast and pg_type's entries for the object an entry names"
		},
		box: "every entry of the Compute registry",
		kept: [],
		kills: []
	})
