import type { NodeOf, RelNode, VarDecl } from "#compiler/ir/rel.ts"
import { feedbackBlock } from "#compiler/lower/conservative/recursive/index.ts"

/** The variables a region equates with `v`, `v` included: the closure of its equalities. */
const equatedVars = (region: NodeOf<"MatchRegion">, v: VarDecl): ReadonlySet<VarDecl> => {
	const out = new Set<VarDecl>([v])
	for (let grew = true; grew;) {
		grew = false
		for (const e of region.equalities) {
			if (out.has(e.a) === out.has(e.b)) {
				continue
			}
			out.add(e.a)
			out.add(e.b)
			grew = true
		}
	}
	return out
}

/**
 * Whether column `name` of `node` equals, natively, column `target` of the SelfRef `self` in every row: the column
 * is the feedback's own value, copied through filters, projections and region variables.
 *
 * What a recursion's step carries unchanged, and the other facts a batched or seeded recursion rests on.
 *
 * A state column is carried when every state the step derives has, in that column, a value natively equal to the
 * same column of the state it was derived from: the step reads it from its single feedback scan and delivers it
 * unchanged. Then every state of the fixed point has, in that column, a value natively equal to the seed it came
 * from, so
 *
 * - a predicate that reads only carried columns holds of a state exactly when it holds of its seed, and may be
 *   evaluated on the seed instead of on the completed recursion (a proved root pushdown: an endpoint
 *   filter is not automatically a seed filter, and only a carried column is a seed filter);
 * - seeds that differ in a carried column never merge, so one recursion seeded by several roots at once answers for
 *   each root separately when the root identity is carried (batched traversal carries the originating
 *   seed identity through recursive state; R37).
 *
 * The proof is structural and follows only operators whose output column is an input column: a filter, the left side
 * of a semi-join or anti-join, a projection that copies a column, and a region variable, which equals every column
 * bound to it and every variable it is equated with. Anything else, a computed column above all, is not carried.
 *
 * Native equality is the host's identity for every type: equal values decode to one host value (a numeric's 1.0 and
 * 1.00 are one Decimal, a float's -0 and 0 one zero), and no reading grizzle emits sees what tells them apart in
 * PostgreSQL (registry.ts OperandReading). So a carried column turns into a filter or a stitched key whatever its
 * type, as a fused attachment copies a correlated column from its parent row (shapes/attach/index.ts fusedLayout).
 */
export const carriedFrom = (
	node: RelNode,
	name: string,
	self: RelNode,
	target: string
): boolean => {
	/** The columns each node was walked at: the walk's seen-set. */
	const seen = new Map<RelNode, Set<string>>()
	const walk = (at: RelNode, column: string): boolean => {
		const columns = seen.get(at)
		if (columns?.has(column) === true) {
			return false
		}
		if (columns === undefined) {
			seen.set(at, new Set([column]))
		} else {
			columns.add(column)
		}
		if (at === self) {
			return column === target
		}
		if (!at.heading.some((c) => c.name === column)) {
			return false
		}
		switch (at.kind) {
			case "Filter":
				return walk(at.input, column)
			case "SemiJoin":
			case "AntiJoin":
				return walk(at.left, column)
			case "ProjectSet": {
				const e = at.out.find((o) => o.name === column)?.expr
				return (
					e?.kind === "column" && e.column.node === at.input.id && walk(at.input, e.column.name)
				)
			}
			case "MatchRegion": {
				const v = at.vars.find((x) => x.name === column)
				if (v === undefined) {
					return false
				}
				const vars = equatedVars(at, v)
				return at.occurrences.some((o) =>
					o.bindings.some((b) => vars.has(b.var) && walk(o.source, b.column))
				)
			}
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Union":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return false
		}
	}
	return walk(node, name)
}

/** The state columns of a recursion its step carries unchanged. */
export const carriedColumns = (rec: NodeOf<"Recursive">): ReadonlySet<string> =>
	new Set(
		rec.heading.filter((c) => carriedFrom(rec.step, c.name, rec.self, c.name)).map((c) => c.name)
	)

/**
 * Whether a recursion's feedback is positive and linear, so its fixed point distributes over a union of seeds:
 * no path from the step to its SelfRef passes through an operator that is not monotone and distributive over the
 * feedback (conservative/recursive feedbackBlock). Admission refuses every other recursion, and the recursive lowering
 * refuses it again; a seeded form relies on the property, so it checks it too.
 */
export const positiveLinear = (rec: NodeOf<"Recursive">): boolean =>
	feedbackBlock(rec) === undefined
