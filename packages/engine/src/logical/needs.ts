/**
 * What a query's rows need of a call's inputs (ir/needs.ts Needs), proved from its node alone, kind by kind: a row exists
 * only where every relation it is joined from holds one, so a member whose every rule matches a relation parameter
 * holds no fact where that parameter holds none. Expressions never add a row, so none is read; a proof is sound where
 * it claims less, so every kind whose rows may exist without its inputs' claims `always` of what it does not read.
 */
import { always, both, either, needing, type Needs, never } from "#compiler/ir/needs.ts"
import { type RelNode, unionArms } from "#compiler/ir/rel.ts"

/**
 * What `node`'s rows need of the call's inputs, each node of its DAG read once:
 *
 * - an InputSet the facts of its relation parameter or member slot, and a membership's row, one fact, nothing;
 * - a stored or derived relation, a context and a delta nothing the call states, a closed relation of no row never;
 * - a declared function's call nothing, since a function may return rows where its rows arguments hold none;
 * - a match region every occurrence it joins, a semi-join and an intersection both sides;
 * - a union any arm, an anti-join and a difference their left side;
 * - a filter, a step, a projection, a take, an order, a window, a producer, an approximate search, a fold and an
 *   attachment their input's (its parent's), since none of them makes a row of no input row: a fold with no key groups
 *   its rows by a constant column its input carries (lower/conservative/group), so an empty input is no group;
 * - an ordered-set aggregate with no key nothing, since its rewrite's SQL aggregates without a GROUP BY;
 * - a law's violation its violation's;
 * - a recursive relation its base's or its step's over an empty self-reference: its least fixpoint is empty where the
 *   base is and one step over nothing derives nothing, so a self-reference needs what never holds.
 */
export const needsOf = (node: RelNode): Needs => {
	const proved = new Map<RelNode, Needs>()
	const of = (n: RelNode): Needs => {
		const known = proved.get(n)
		if (known !== undefined) {
			return known
		}
		const needs = own(n)
		proved.set(n, needs)
		return needs
	}
	const own = (n: RelNode): Needs => {
		switch (n.kind) {
			case "InputSet":
				switch (n.input.kind) {
					case "declared":
						return needing({ kind: "declared", param: n.input.param })
					case "member":
						return needing({ kind: "member", slot: n.input.slot })
					case "row":
					case "bound":
						return always
				}
			case "Base":
			case "Context":
			case "Delta":
			case "Call":
				return always
			case "Closed":
				return n.rows.length === 0 ? never : always
			case "SelfRef":
				return never
			case "MatchRegion":
				return both(n.occurrences.map((o) => of(o.source)))
			case "SemiJoin":
			case "Intersect":
				return both([of(n.left), of(n.right)])
			case "Union":
				return either(unionArms(n.groups).map(of))
			case "AntiJoin":
			case "Difference":
				return of(n.left)
			case "Filter":
			case "Step":
			case "ProjectSet":
			case "Take":
			case "OrderedResult":
			case "Window":
			case "Produce":
			case "Group":
				return of(n.input)
			case "OrderedSetAggregate":
				return n.keys.length === 0 ? always : of(n.input)
			case "ApproximateNearest":
				return of(n.source)
			case "Attach":
				return of(n.parent)
			case "Forbid":
				return of(n.violation)
			case "Recursive":
				return either([of(n.base), of(n.step)])
		}
	}
	return of(node)
}
