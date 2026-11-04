import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { ExprId } from "#compiler/core/ids.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import { defaultOps, opForms } from "#compiler/lower/conservative/expr/ops.ts"
import { type NativeOp, nativeOps, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import { col } from "#compiler/sql/build.ts"
import { assert, contains } from "#test/support/assert.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { T } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * The conservative lowering's scalar vocabulary and literal forms on PostgreSQL 19.
 *
 * Every entry of the default operator table names a real overload: an operator form's identity is the implementing
 * function (pg_operator.oprcode) of a builtin operator spelled with the form's symbol, unary for negation. Every
 * function the default vocabulary lowers is a registry entry whose OpId is its regprocedure signature, and the call it
 * emits names that function. That every literal kind reaches PostgreSQL exactly is the generated oracle suites': their
 * compared and projected literals and closed payloads over every palette type, against the reference.
 */

/**
 * The op node of `native` that defaultOps lowers: it reads the overload; the rest makes a well-formed scalar
 * expression, a partial overload's proof among it, which no lowering of the form reads.
 */
const opExpr = (native: NativeOp): ScalarExpr & { readonly kind: "op" } => {
	const common = {
		kind: "op",
		id: ExprId("e1"),
		args: [],
		type: T.bool,
		nonNull: "strict",
		volatility: "immutable",
		deps: { params: [], nodes: [] },
		pgType: T.bool
	} as const
	return native.partial
		? {
				...common,
				op: native.id,
				proof: {
					precondition: { kind: "nonzero", operand: 1 },
					premises: [{ kind: "checked", operand: 1, by: "literal" }]
				}
			}
		: { ...common, op: native.id }
}

layer(Substrate.layer)("the conservative vocabulary on PostgreSQL 19", (it) => {
	it.effect("names a builtin operator for every operator form", () =>
		Effect.gen(function* () {
			const { admin } = yield* Substrate
			for (const [identity, form] of opForms) {
				const rows = yield* admin.queryValues(
					"SELECT o.oprname::text, (o.oprleft = 0)::text FROM pg_catalog.pg_operator AS o WHERE o.oprcode::text = $1::text",
					[identity]
				)
				assert.ok(rows.length > 0, identity)
				contains(
					Arr.map(rows, (r) => `${String(r[0])} ${String(r[1])}`),
					form.kind === "negate" ? "- true" : `${form.op} false`,
					identity
				)
			}
		})
	)

	it.effect("lowers every function by its regprocedure signature to a call of that function", () =>
		Effect.gen(function* () {
			const { admin } = yield* Substrate
			let checked = 0
			for (const native of nativeOps) {
				if (
					native.sql.kind !== "function" ||
					native.totality.kind === "exact" ||
					native.totality.kind === "ieee"
				) {
					continue
				}
				const args = Arr.map(indices(operandCarriers(native.operands).length), (i) =>
					col("r1", `c${i + 1}`)
				)
				const lowered = defaultOps(opExpr(native), args)
				if (lowered === undefined) {
					continue
				}
				const name = describeOp(native.id)
				assert.ok(lowered.kind === "call", name)
				/** A range-polymorphic function's identity is its signature at a range carrier. */
				const signature = typeof native.id === "string" ? native.id : native.id.code
				const rows = yield* admin.queryValues(
					"SELECT p.proname::text FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure($1::text) AND p.pronamespace = 'pg_catalog'::regnamespace",
					[signature]
				)
				assert.deepEqual(
					Arr.map(rows, (r) => r[0]),
					[lowered.fn.name],
					name
				)
				checked += 1
			}
			assert.ok(checked > 0, "a function the default vocabulary lowers")
		})
	)
})
