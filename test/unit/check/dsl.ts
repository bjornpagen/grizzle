import { Array as Arr } from "effect"
import type {
	ComputeFn,
	FieldDesc,
	LiteralDesc,
	OrderDesc,
	ScaledComputeFn
} from "#compiler/ir/desc.ts"

import type {
	BindingsDesc,
	AuthoredExprDesc as ExprDesc,
	HeadTermDesc,
	MatchDesc,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SourceDesc,
	VarDesc
} from "#test/support/fixtures/ir/desc.ts"

/** The comparisons a law and a filter share: the IR fixtures' vocabulary (fixtures/ir/desc.ts). */
export { ge, le, ne } from "#test/support/fixtures/ir/desc.ts"

/**
 * A small vocabulary for writing QueryDescs in the checker's tests.
 *
 * The query builder records these descriptions from `queryDesc(S).rule(...)`; the checker's tests state them
 * directly, so each test reads like the query's rule while exercising exactly the Description boundary the checker
 * consumes. They are authored as JavaScript states a description, without locations: whatever decodes one, the
 * checker's entry point included, locates every node by its path in the whole description, as it locates a JavaScript
 * author's.
 */
export const vars = (relation: string, ...fields: ReadonlyArray<string>): ReadonlyArray<VarDesc> =>
	Arr.map(fields, (field) => ({ id: `${relation}.${field}`, origin: { relation, field } }))

export const plainVar = (id: string): VarDesc => ({ id, origin: undefined })

export const ref = (relation: string, field: string): ExprDesc => ({
	kind: "var",
	var: `${relation}.${field}`
})
export const varRef = (id: string): ExprDesc => ({ kind: "var", var: id })
/** A literal untyped: it takes the type of the slot it meets. */
export const lit = (value: LiteralDesc): ExprDesc => ({ kind: "literal", value, type: undefined })
/** A literal typed by its own descriptor, where an untyped one takes the type of the slot it meets. */
export const typedLit = (value: LiteralDesc, type: FieldDesc): ExprDesc => ({
	kind: "literal",
	value,
	type
})
/** A scalar parameter of its declared field descriptor. */
export const param = (name: string, type: FieldDesc): ExprDesc => ({ kind: "param", name, type })
export const parent = (column: string): ExprDesc => ({ kind: "parent", column })

export const relationSource = (name: string): SourceDesc => ({ kind: "relation", name })
export const imported = (query: QueryDesc, bind: BindingsDesc): SourceDesc => ({
	kind: "query",
	query,
	bind
})

export const delta = (side: "added" | "removed", relation: string): SourceDesc => ({
	kind: "delta",
	side,
	relation
})

export const match = (source: SourceDesc, bindings: BindingsDesc): MatchDesc => ({
	source,
	bindings
})

const compare =
	(op: Extract<ExprDesc, { kind: "compare" }>["op"]) =>
	(left: ExprDesc, right: ExprDesc): ExprDesc => ({ kind: "compare", op, left, right })
export const eq = compare("eq")
export const lt = compare("lt")
export const gt = compare("gt")
export const and = (...args: Arr.NonEmptyReadonlyArray<ExprDesc>): ExprDesc => ({
	kind: "and",
	args
})
export const or = (...args: Arr.NonEmptyReadonlyArray<ExprDesc>): ExprDesc => ({
	kind: "or",
	args
})
export const not = (source: SourceDesc, bindings: BindingsDesc): ExprDesc => ({
	kind: "absent",
	source,
	bindings
})

/** A function without a scale argument; round and trunc state their scale (ir/desc.ts ScaledComputeFn). */
export const compute = (
	fn: Exclude<ComputeFn, ScaledComputeFn>,
	...args: ReadonlyArray<ExprDesc>
): ExprDesc => ({
	kind: "compute",
	fn,
	args
})

export const cast = (arg: ExprDesc, to: FieldDesc): ExprDesc => ({ kind: "cast", to, arg })

type IntegerType = "smallint" | "integer" | "bigint"

/** Each integer type's range, what an exact integer narrowed into it is proved within, and its literal 0. */
const integerTypes: Readonly<
	Record<IntegerType, { readonly low: bigint; readonly high: bigint; readonly zero: LiteralDesc }>
> = {
	smallint: { low: -(2n ** 15n), high: 2n ** 15n - 1n, zero: 0 },
	integer: { low: -(2n ** 31n), high: 2n ** 31n - 1n, zero: 0 },
	bigint: { low: -(2n ** 63n), high: 2n ** 63n - 1n, zero: 0n }
}

/**
 * An exact integer narrowed into an integer type under the guard that it fits, 0 otherwise: what a program writes to
 * store integer arithmetic in an integer field.
 */
export const narrowed = (x: ExprDesc, to: IntegerType): ExprDesc => {
	const { low, high, zero } = integerTypes[to]
	const field: FieldDesc = { kind: "pg", type: to }
	return {
		kind: "when",
		guard: { kind: "within", low, high },
		subject: x,
		proved: cast(x, field),
		otherwise: typedLit(zero, field)
	}
}

export const count = (): HeadTermDesc => ({ kind: "aggregate", fn: "count" })
export const sum = (arg: ExprDesc): HeadTermDesc => ({ kind: "aggregate", fn: "sum", arg })
export const min = (arg: ExprDesc): HeadTermDesc => ({ kind: "aggregate", fn: "min", arg })
export const max = (arg: ExprDesc): HeadTermDesc => ({ kind: "aggregate", fn: "max", arg })

/** A rule's Description, every field stated: no variable, filter, interior or attachment is a stated empty list. */
export const rule = (spec: RuleDesc): RuleDesc => spec

export const queryDesc = (...arms: Arr.NonEmptyReadonlyArray<RuleDesc>): QueryDesc => ({
	stage: { kind: "rules", arms }
})

const wrap = (q: QueryDesc, stage: (input: QueryStageDesc) => QueryStageDesc): QueryDesc => ({
	stage: stage(q.stage)
})

export const orderBy = (
	q: QueryDesc,
	...order: ReadonlyArray<readonly [string, "asc" | "desc"]>
): QueryDesc =>
	wrap(q, (input) => ({
		kind: "order",
		input,
		order: Arr.map(order, ([column, dir]): OrderDesc => ({ column, dir }))
	}))

export const take = (q: QueryDesc, k: number | string): QueryDesc =>
	wrap(q, (input) => ({
		kind: "take",
		input,
		take: typeof k === "number" ? { kind: "literal", k } : { kind: "param", name: k }
	}))

export const attach = (q: QueryDesc, name: string, child: QueryDesc): QueryDesc =>
	wrap(q, (input) => ({ kind: "attach", input, attach: { name, child } }))

export const approximateNearest = (q: QueryDesc, by: string, k: number): QueryDesc =>
	wrap(q, (input) => ({ kind: "approx", input, by, take: k }))
