/**
 * The conservative lowering's scalar vocabulary and literal forms on PostgreSQL 19.
 *
 * Every entry of the default operator table names a real overload: an operator form's identity is the implementing
 * function (pg_operator.oprcode) of a builtin operator spelled with the form's symbol, unary for negation. Every
 * function the default vocabulary lowers is a registry entry whose OpId is its regprocedure signature, an exact
 * carrier's own overload prefixing the numeric signature that implements it, and the call it emits names that function. That every literal kind reaches PostgreSQL exactly is the generated oracle suites': their
 * compared and projected literals and closed payloads over every palette type, against the reference.
 *
 * Oracle: PostgreSQL's catalog, pg_operator for each form's function and pg_proc for each registry entry's signature.
 *
 * Features: a binary operator and the negation among the forms; a function lowered to its call among the entries.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): conservative-mod-as-div (the table spells the modulo functions with the
 * division symbol) and conservative-call-misnamed (every function lowers to a call of abs).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import { defaultOps, opForms } from "#compiler/lower/conservative/expr/ops.ts"
import { type NativeOp, nativeOps, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import { col } from "#compiler/sql/build.ts"
import { assert, contains, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { T } from "#test/unit/lower/conservative/fixtures.ts"

/** The namespaces of the exact carriers' own overloads, whose OpIds prefix the numeric signature that implements them. */
const exactNamespaces = ["exact:", "exactMoney:"] as const

/** The regprocedure signature an entry's OpId lists: the id itself, or, for an exact carrier's overload, the one it prefixes. */
const listedSignature = (id: NativeOp["id"]): string => {
	const text = typeof id === "string" ? id : id.code
	return Option.match(
		Arr.findFirst(exactNamespaces, (n) => Str.startsWith(n)(text)),
		{ onNone: () => text, onSome: (n) => Str.slice(n.length)(text) }
	)
}

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
				proof: [
					{
						precondition: { kind: "nonzero", operand: 1 },
						premises: [{ kind: "checked", operand: 1, by: "literal" }]
					}
				]
			}
		: { ...common, op: native.id }
}

/** What an operator form reached: a binary operator or the unary negation. */
type FormFeature = "binary" | "negation"

/** What a registry entry reached: a function the default vocabulary lowers to a call, or none it lowers so. */
type LoweredFeature = "lowered to its function" | "not lowered by name"

layer(Substrate.layer)("the conservative vocabulary on PostgreSQL 19", (it) => {
	it.effect("names a builtin operator for every operator form", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { admin } = yield* Substrate
				const forms = Arr.fromIterable(opForms)
				return yield* exhaust(
					{
						suite: "pg/lower-conservative/operator-forms",
						generator: int(0, forms.length - 1),
						literal: (i: number) => `${i}: ${defined(forms[i], "a form")[0]}`,
						box: "every entry of the default operator table",
						oracle: {
							kind: "postgresql",
							name: "pg_operator's operators implemented by the form's function"
						},
						coverage: requiredInSpace<FormFeature>(["binary", "negation"]),
						caseHang
					},
					(i, c) =>
						Effect.gen(function* () {
							const [identity, form] = defined(forms[i], `form ${i}`)
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
							c.note(form.kind === "negate" ? "negation" : "binary")
						})
				)
			})
		)
	)

	it.effect(
		"lowers every function by its regprocedure signature to a call of that function",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { admin } = yield* Substrate
					return yield* exhaust(
						{
							suite: "pg/lower-conservative/functions",
							generator: int(0, nativeOps.length - 1),
							literal: (i: number) => `${i}: ${describeOp(defined(nativeOps[i], "an entry").id)}`,
							box: "every entry of the Compute registry",
							oracle: {
								kind: "postgresql",
								name: "pg_proc's function at the entry's regprocedure signature"
							},
							coverage: requiredInSpace<LoweredFeature>(["lowered to its function"]),
							caseHang
						},
						(i, c) =>
							Effect.gen(function* () {
								const native = defined(nativeOps[i], `entry ${i}`)
								if (
									native.sql.kind !== "function" ||
									native.totality.kind === "exact" ||
									native.totality.kind === "ieee"
								) {
									c.note("not lowered by name")
									return
								}
								const args = Arr.map(indices(operandCarriers(native.operands).length), (n) =>
									col("r1", `c${n + 1}`)
								)
								const lowered = defaultOps(opExpr(native), args)
								if (lowered === undefined) {
									c.note("not lowered by name")
									return
								}
								const name = describeOp(native.id)
								assert.ok(lowered.kind === "call", name)
								/** A range-polymorphic function's identity is its signature at a range carrier. */
								const signature = listedSignature(native.id)
								const rows = yield* admin.queryValues(
									"SELECT p.proname::text FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure($1::text) AND p.pronamespace = 'pg_catalog'::regnamespace",
									[signature]
								)
								assert.deepEqual(
									Arr.map(rows, (r) => r[0]),
									[lowered.fn.name],
									name
								)
								c.note("lowered to its function")
							})
					)
				})
			)
	)
})
