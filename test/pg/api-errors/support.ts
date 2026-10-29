import { element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { Effect, type Scope } from "effect"
import { makeDb } from "#adapter/db/db.ts"
import type { Db } from "#adapter/public/db.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { contextOf } from "#test/support/runtime-db.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap } from "#test/support/wire-tap.ts"

/**
 * Shared parts of the public-API error matrix (test/pg/api-errors).
 *
 * - A Db on a tapped pool of one warmed session, so a window of the tap holds one call's traffic: a refusal before any
 *   SQL sends no frontend message.
 * - PostgreSQL's integer arithmetic as a model, the oracle of the partial Compute operations both the write and the
 *   read side draw: an integer operation either yields its integer or fails with the SQLSTATE PostgreSQL 19 raises,
 *   division by zero (22012) or an integer out of range (22003). The model is the documented semantics of the int4
 *   operators (truncating division, a remainder taking the dividend's sign, INT_MIN % -1 = 0), written over bigint,
 *   independent of grizzle.
 *
 * `db`'s runtime on a tapped pool of one session for `credentials`, its login's, warmed: a Db of no workload program.
 */
export const tappedDb = <R>(
	db: Db<R, unknown>,
	credentials: Credentials
): Effect.Effect<
	{ readonly db: Db<R, unknown>; readonly tap: Tap },
	never,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const tap = makeTap((yield* Substrate).cluster)
		const pool = yield* poolFor(credentials, {
			...defaultPool,
			transport: { kind: "given", transport: { _tag: "stream", open: tap.open } },
			pool: { idleTimeoutMs: 60_000, min: 1, max: 1 }
		})
		yield* Effect.orDie(
			Effect.scoped(
				Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
			)
		)
		return { db: makeDb<R, unknown>({ ...contextOf(db), pool }, {}), tap }
	})

const int4Min = -(2n ** 31n)
const int4Max = 2n ** 31n - 1n

/** The integer operations drawn, each a Compute builder over two integer terms. */
export const integerOperations = ["div", "mod", "add", "sub", "mul", "neg", "abs"] as const
export type IntegerOperation = (typeof integerOperations)[number]

/** An operation's answer: its value, or the SQLSTATE it fails with. */
export type IntegerAnswer =
	| { readonly kind: "value"; readonly value: number }
	| { readonly kind: "fails"; readonly sqlstate: "22012" | "22003" }

const inRange = (x: bigint): IntegerAnswer =>
	x < int4Min || x > int4Max
		? { kind: "fails", sqlstate: "22003" }
		: { kind: "value", value: Number(x) }

/** PostgreSQL's answer for `op` over int4 operands `a` and `b` (a unary operation reads `a` alone). */
export const integerAnswer = (op: IntegerOperation, a: number, b: number): IntegerAnswer => {
	const x = BigInt(a)
	/**
	 * The remainder takes the dividend's sign, as int4mod's; INT_MIN % -1 is 0.
	 *
	 * bigint division truncates toward zero, as int4div does; INT_MIN / -1 is out of range.
	 */
	const y = BigInt(b)
	switch (op) {
		case "div":
			return y === 0n ? { kind: "fails", sqlstate: "22012" } : inRange(x / y)
		case "mod":
			return y === 0n ? { kind: "fails", sqlstate: "22012" } : inRange(y === -1n ? 0n : x % y)
		case "add":
			return inRange(x + y)
		case "sub":
			return inRange(x - y)
		case "mul":
			return inRange(x * y)
		case "neg":
			return inRange(-x)
		case "abs":
			return inRange(x < 0n ? -x : x)
	}
}

/** int4 operands: the edges an integer operation branches on, five times in six, else any int4. */
export const int4Gen: Gen<number> = weighted([
	[5, element([0, 1, -1, 2, -2, 7, 46_341, -46_341, 2_147_483_647, -2_147_483_648])],
	[1, int(-2_147_483_648, 2_147_483_647)]
])

/**
 * Operands `op` fails on (planted, since drawn operands rarely overflow), the operand `x` kept where it does not
 * decide: a zero divisor, a sum, difference or product past int4, and INT_MIN negated.
 */
const failingOperands = (op: IntegerOperation, x: number): readonly [number, number] => {
	switch (op) {
		case "div":
		case "mod":
			return [x, 0]
		case "add":
			return [2_147_483_647, Math.max(1, Math.abs(x) % 1_000)]
		case "sub":
			return [-2_147_483_648, Math.max(1, Math.abs(x) % 1_000)]
		case "mul":
			return [46_341, x >= 0 ? 46_341 : -46_341]
		case "neg":
		case "abs":
			return [-2_147_483_648, x]
	}
}

/**
 * Where a case's operands come from: the operation's failing operands, small operands every operation answers (a
 * divisor of 1 to 100), and the drawn ones. A case runs its operation on all three, so every case reaches both of its
 * operation's outcomes, and the drawn operands explore the rest.
 */
export const operandSources = ["failing", "total", "drawn"] as const
export type Operands = (typeof operandSources)[number]

export const operandsOf = (
	op: IntegerOperation,
	operands: Operands,
	a: number,
	b: number
): readonly [number, number] => {
	switch (operands) {
		case "failing":
			return failingOperands(op, a)
		case "total":
			return [(Math.abs(a) % 201) - 100, (Math.abs(b) % 100) + 1]
		case "drawn":
			return [a, b]
	}
}
