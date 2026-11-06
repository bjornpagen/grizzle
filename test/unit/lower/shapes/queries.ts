import { OpId, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { type CompletedOrder, conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { foldInputOf } from "#test/support/fixtures/ir/fold.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { keyed, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * IR queries for the shape tests, over the conservative lowering's ledger fixture (test/unit/lower/conservative),
 * shared by the unit goldens and the PostgreSQL agreement suite so both read the same IR.
 */

const kindLit = (q: Q, handle: "Automatic" | "Manual"): ScalarExpr =>
	q.lit({ kind: "handle", handle }, T.kind)

const byIdThenKind: CompletedOrder = {
	keys: [
		{ column: "id", dir: "asc" },
		{ column: "kind", dir: "asc" }
	]
}

/**
 * Tasks by kind, a union of two heading groups told apart by the discriminant kind: the automatic tasks with their
 * amount, and the manual ones from two arms (amounts at most 20 and above 20, or at least 20 when `overlap`, so both
 * manual arms hold t2 and only UNION keeps it once). The common fields (kind, id) hold Task's key. `rows` keeps every
 * row, or the take of the first k in the order (id, kind), or, joined back, the rows of that
 * kind's heading group among those first k, its arms joined back to the take on every common field, as the checker
 * narrows a match of the bounded union that binds kind to the handle.
 * The first k rows, if any, and the heading group joined back to them, if any.
 */
type KindTake =
	| { readonly kind: "every row" }
	| { readonly kind: "first"; readonly k: bigint }
	| {
			readonly kind: "first, joined back"
			readonly k: bigint
			readonly joinBack: "Automatic" | "Manual"
	  }

export const tasksByKind = (rows: KindTake, overlap: boolean): LogicalQuery => {
	const q = new Q()
	const auto = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", amount: "amount" },
			constants: { kind: kindLit(q, "Automatic") }
		}
	])
	const armA = q.project(
		auto,
		[
			["kind", [kindLit(q, "Automatic"), T.kind]],
			["id", "id"],
			["amount", "amount"]
		],
		keyed(["id"], "many")
	)
	const manualArm = (small: boolean) => {
		const m = q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { id: "id", amount: "amount" },
				constants: { kind: kindLit(q, "Manual") }
			}
		])
		const filtered = q.filter(
			m,
			q.op(
				small ? "int8le" : overlap ? "int8ge" : "int8gt",
				[q.col(m, "amount"), q.int(20, T.int8)],
				T.bool
			)
		)
		return q.project(
			filtered,
			[
				["kind", [kindLit(q, "Manual"), T.kind]],
				["id", "id"]
			],
			keyed(["id"], "many")
		)
	}
	const manual = [manualArm(true), manualArm(false)]
	const u = q.union([armA, ...manual], ["kind"])
	if (rows.kind === "every row") {
		return q.build(u)
	}
	const take = q.take(
		u,
		byIdThenKind,
		{ kind: "literal", k: rows.k },
		[],
		keyed(["id", "kind"], "many")
	)
	if (rows.kind === "first") {
		return q.build(take)
	}
	const group = rows.joinBack === "Automatic" ? armA : q.union(manual, [])
	return q.build(
		q.semi(group, take, [
			["kind", "kind"],
			["id", "id"]
		])
	)
}

const cond = (q: Q, p: ScalarExpr, a: ScalarExpr, b: ScalarExpr, type: ScalarType): ScalarExpr =>
	q.b.expr({
		kind: "cond",
		args: [p, a, b],
		type,
		nonNull: "cond"
	})

export type ConditionalForm = "int4" | "int8" | "numeric" | "numeric5.2" | "term"

/** A numeric with a scale typmod: its literal 1 displays 1.00. */
const numeric5_2: ScalarType = scalarOf(f.numeric(5, 2), {})

/**
 * The numeric literals 1 and 0 as the checker types them, each a computed numeric its own value bounds: one integer
 * digit and no fraction (scalar/compute/types.ts literalNumeric). An operand at numeric's own limits leaves a sum no
 * room for the rows it adds, so the numeric form's literals carry their bound.
 */
const numericDigit: ScalarType = numericValue({ digits: 1, scale: 0 })

/**
 * Per account, the sum of a conditional over its tasks' (id, account, amount) bindings: sum(cond(amount > threshold,
 * 1, 0)) over integer or bigint literals, the same over numeric or numeric(5,2) 1 and 0, or sum(cond(amount >
 * threshold, amount, 0)).
 */
export const conditional = (
	form: ConditionalForm,
	threshold: number
): LogicalQuery & { readonly node: RelNode } => {
	const q = new Q()
	const m = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])
	const p = q.op("int8gt", [q.col(m, "amount"), q.int(threshold, T.int8)], T.bool)
	const [a, b, type, resultType] =
		form === "int4"
			? [q.int(1, T.int4), q.int(0, T.int4), T.int4, T.int8]
			: form === "int8"
				? [q.int(1, T.int8), q.int(0, T.int8), T.int8, T.numeric]
				: form === "numeric"
					? [q.decimal("1", numericDigit), q.decimal("0", numericDigit), numericDigit, T.numeric]
					: form === "numeric5.2"
						? [q.decimal("1", numeric5_2), q.decimal("0", numeric5_2), numeric5_2, T.numeric]
						: [q.col(m, "amount"), q.int(0, T.int8), T.int8, T.numeric]
	const c = cond(q, p, a, b, type)
	const node = q.b.node({
		kind: "Group",
		input: m,
		bound: foldInputOf(m, ["id", "account", "amount"]),
		keys: ["account"],
		aggs: [{ name: "passed", fn: "sum", op: OpId("sum(integer)"), args: [c], filter: undefined }],
		heading: [
			{ name: "account", type: T.uuid },
			{ name: "passed", type: resultType }
		],
		loc: undefined,
		meta: conservativeMeta
	})
	return { ...q.build(node), node }
}
