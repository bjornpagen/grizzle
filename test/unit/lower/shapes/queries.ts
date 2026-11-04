import { OpId, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type RelNode,
	type TakeBound
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import {
	Account,
	keyed,
	Posting,
	plainRegion,
	Q,
	T,
	Task
} from "#test/unit/lower/conservative/fixtures.ts"
import type { LoweringCase } from "#test/unit/lower/conservative/queries.ts"

/**
 * IR queries for the shape tests, over the conservative lowering's ledger fixture (test/unit/lower/conservative),
 * shared by the unit goldens and the PostgreSQL agreement suite so both read the same IR.
 */

const kindLit = (q: Q, handle: "Automatic" | "Manual"): ScalarExpr =>
	q.lit({ kind: "enum", handle }, T.kind)

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

export type ConditionalForm = "int4" | "int8" | "numeric1.0" | "numeric5.2" | "term"

/** A numeric with a scale typmod: its literal 1 displays 1.00. */
const numeric5_2: ScalarType = scalarOf(f.numeric(5, 2), {})

/**
 * Per account, the sum of a conditional over its tasks' (id, account, amount) bindings: sum(cond(amount > threshold,
 * 1, 0)) over integer or bigint literals, the same over numeric 1.0 or numeric(5,2) 1 and 0, or sum(cond(amount >
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
				: form === "numeric1.0"
					? [q.decimal("1.0", T.numeric), q.decimal("0", T.numeric), T.numeric, T.numeric]
					: form === "numeric5.2"
						? [q.decimal("1", numeric5_2), q.decimal("0", numeric5_2), numeric5_2, T.numeric]
						: [q.col(m, "amount"), q.int(0, T.int8), T.int8, T.numeric]
	const c = cond(q, p, a, b, type)
	const node = q.b.node({
		kind: "Group",
		input: m,
		bound: ["id", "account", "amount"],
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

/**
 * The queries below carry repeats at the boundaries the shapes elide: postings p1 and p2 are both (A, 100), so a
 * region binding (account, amount) of Posting realized plain holds that row twice.
 */
const amountOrder: CompletedOrder = {
	keys: [
		{ column: "amount", dir: "desc" },
		{ column: "account", dir: "asc" }
	]
}

/**
 * The two largest (account, amount) pairs of Posting, delivered in order: (A, 100) and (B, 70). A bound that kept the
 * repeated (A, 100) would fill both places with it.
 */
export const topAmounts = (): LoweringCase => {
	const q = new Q()
	const m = q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { account: "account", amount: "amount" },
			constants: {}
		}
	])
	const top = q.take(m, amountOrder, { kind: "literal", k: 2n }, [], conservativeMeta)
	return {
		name: "topAmounts",
		query: q.build(q.ordered(top, amountOrder))
	}
}

/**
 * Per account, its top `bound` posting amounts as (acct, amount): the take of Posting's (account, amount) correlated
 * to the region's account. For k = 2, account A has the one pair (A, 100), which its two postings repeat.
 */
export const amountsPerAccount = (bound: TakeBound): LogicalQuery => {
	const q = new Q()
	const amounts = q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { account: "account", amount: "amount" },
			constants: {}
		}
	])
	const outer = q.b.reserve()
	const accountRef: ScalarExpr = q.b.expr({
		kind: "column",
		column: { node: outer, name: "acct" },
		args: [],
		type: T.uuid,
		nonNull: "storage"
	})
	const top = q.take(
		amounts,
		amountOrder,
		bound,
		[{ column: "account", expr: accountRef }],
		conservativeMeta
	)
	const region = q.regionWith(
		[
			{ source: q.base(Account, conservativeMeta), bind: { id: "acct" }, constants: {} },
			{ source: top, bind: { account: "acct", amount: "amount" }, constants: {} }
		],
		{ ...plainRegion, id: { kind: "reserved", id: outer } }
	)
	return q.build(region)
}

/**
 * Each account with the set of its posting amounts attached, largest first: A's children are the one pair (A, 100)
 * however many postings repeat it.
 */
export const accountsWithAmounts = (): LoweringCase => {
	const q = new Q()
	const accounts = q.project(
		q.region([
			{ source: q.base(Account, conservativeMeta), bind: { id: "id", name: "name" }, constants: {} }
		]),
		[
			["id", "id"],
			["name", "name"]
		],
		conservativeMeta
	)
	const amounts = q.project(
		q.region([
			{
				source: q.base(Posting, conservativeMeta),
				bind: { account: "account", amount: "amount" },
				constants: {}
			}
		]),
		[
			["account", "account"],
			["amount", "amount"]
		],
		conservativeMeta
	)
	const a = q.attach(accounts, amounts, "amounts", [["id", "account"]], "array", {
		keys: [{ column: "amount", dir: "desc" }]
	})
	return {
		name: "accountsWithAmounts",
		query: q.build(a)
	}
}
