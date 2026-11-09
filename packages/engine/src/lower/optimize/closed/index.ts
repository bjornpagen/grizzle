import type { NodeId } from "#compiler/core/ids.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { nodePremises } from "#compiler/ir/certificate.ts"
import type { ClosedEvidence } from "#compiler/ir/evidence.ts"
import type { OpId, ScalarExpr } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Cell, EditRefs, KindOver, OccurrenceOver, VarDecl } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	columnRefs,
	type DagEditor,
	derivedMeta,
	widenedHeading
} from "#compiler/lower/optimize/demand/editor.ts"
import {
	type Potential,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { carrierEquality } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"

const membershipRule = "R07.closedMembership"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

/** A key column's value where the occurrence reads it: a variable another occurrence binds, or a constant. */
type KeyValue =
	| { readonly kind: "var"; readonly var: VarDecl }
	| { readonly kind: "constant"; readonly expr: ScalarExpr }

/**
 * A membership-only occurrence of a declared closed relation: the relation's evidence, and each key column's value in
 * key order.
 */
interface Membership {
	readonly occurrence: Occurrence
	readonly relation: string
	readonly evidence: ClosedEvidence
	readonly key: NonEmptyReadonlyArray<KeyValue>
}

/**
 * The value an occurrence gives the key column `column`: its one variable, bound by an occurrence of `elsewhere`, or
 * its one constant, a literal or parameter expression that reads no column; undefined for anything else, a column
 * left free (an existential over it), bound to two variables, or both bound and fixed, since dropping the occurrence
 * would drop the equality or the witness it states.
 */
const keyValue = (
	o: Occurrence,
	column: string,
	elsewhere: ReadonlySet<string>
): KeyValue | undefined => {
	const bound = o.bindings.filter((b) => b.column === column)
	const fixed = o.constants.filter((c) => c.column === column)
	const [binding] = bound
	const [constant] = fixed
	if (bound.length === 1 && fixed.length === 0 && binding !== undefined) {
		return elsewhere.has(binding.var.id) ? { kind: "var", var: binding.var } : undefined
	}
	if (fixed.length === 1 && bound.length === 0 && constant !== undefined) {
		return columnRefs([constant.expr]).length === 0
			? { kind: "constant", expr: constant.expr }
			: undefined
	}
	return undefined
}

/** The type a key column's value has where the predicate reads it. */
const valueType = (value: KeyValue): ScalarType =>
	value.kind === "var" ? value.var.type : value.expr.type

/**
 * The occurrence `o` of the region `region` as a membership test of a declared closed relation, or undefined where
 * it is none. It is one when:
 *
 * - its source is a Closed node that carries a declared closed relation's name, with that relation's heading and its
 *   count of facts: it holds every fact the relation declares, since the simplifier names each relation it narrows
 *   otherwise (simplify/rules.ts narrowedClosedName), and so does the relation's installed key set;
 * - it reads every key column, each as one variable another occurrence of the region binds that is no correlated
 *   source (one whose subtree reads outside itself may read the very variable it binds, so it cannot stand in for the
 *   closed occurrence, whose removal would leave that source waiting on itself), or as one constant that reads no
 *   column, each typed by its key column's type, so its code is one the column's roster holds and every digit of the
 *   key's mixed-radix index is below its radix;
 * - it reads no payload column: it neither binds nor fixes one.
 */
const membershipOf = (cx: RewriteCx, region: Region, o: Occurrence): Membership | undefined => {
	const source = o.source.current
	if (source.kind !== "Closed") {
		return undefined
	}
	const evidence = cx.catalog.closed(source.closed)
	const declared = evidence === undefined ? [] : [...evidence.key, ...evidence.payload]
	if (
		evidence === undefined ||
		source.rows.length !== evidence.facts ||
		source.heading.length !== declared.length ||
		!source.heading.every((c, i) => c.name === declared[i])
	) {
		return undefined
	}
	if (
		o.bindings.some((b) => !evidence.key.includes(b.column)) ||
		o.constants.some((c) => !evidence.key.includes(c.column))
	) {
		return undefined
	}
	const ed = cx.editor
	const others = region.occurrences.filter((x) => x.id !== o.id && !ed.correlated(x.source))
	const elsewhere = new Set(others.flatMap((x) => x.bindings.map((b) => b.var.id)))
	const key: Array<KeyValue> = []
	for (const column of source.heading.slice(0, evidence.key.length)) {
		const value = keyValue(o, column.name, elsewhere)
		if (value === undefined || !sameScalarType(baseOf(valueType(value)), baseOf(column.type))) {
			return undefined
		}
		key.push(value)
	}
	return isNonEmpty(key) ? { occurrence: o, relation: source.closed, evidence, key } : undefined
}

/** The membership-only closed occurrences of the region `cell` holds. */
const membershipsOf = (cx: RewriteCx, cell: Cell, region: Region): ReadonlyArray<Membership> => {
	if (region.occurrences.length < 2 || cx.editor.readsFeedback(cell)) {
		return []
	}
	const d = cx.demand()
	return region.occurrences.flatMap((o) => {
		if (o.source.current.kind !== "Closed" || d.lateral(o.source)) {
			return []
		}
		const m = membershipOf(cx, region, o)
		return m === undefined ? [] : [m]
	})
}

/**
 * A reference to the region's column for `v`, typed as the variable; the region delivers it, widened if need be,
 * before the predicate is placed over it.
 */
const varRef = (ed: DagEditor, region: Cell, v: VarDecl): ScalarExpr =>
	ed.expr({
		kind: "column",
		column: { node: region.id, name: v.name },
		args: [],
		type: v.type,
		nonNull: "storage"
	})

/**
 * The predicate a membership stands for, over the region's own columns: none for a roster, whose domain types every
 * value of its closed id (ir/evidence.ts ClosedEvidence), so every key a column of its type holds is one of its facts;
 * the closed relation's membership test of the key otherwise, one bit of its installed key set (closedHas).
 */
const predicateOf = (ed: DagEditor, region: Cell, m: Membership): ScalarExpr | undefined => {
	if (m.evidence.kind === "roster") {
		return undefined
	}
	const [first, ...rest] = m.key
	const arg = (value: KeyValue): ScalarExpr =>
		value.kind === "var" ? varRef(ed, region, value.var) : value.expr
	return ed.expr({
		kind: "closedHas",
		relation: m.relation,
		args: [arg(first), ...rest.map(arg)],
		type: plainType("bool"),
		nonNull: "strict"
	})
}

/** The code equality each key column's join compared by, which the membership test stands for. */
const equalityOf = (m: Membership): ReadonlyArray<OpId> =>
	[...new Set(m.key.map((value) => baseOf(valueType(value)).carrier))].map(carrierEquality)

/** The R07 rule over a declared closed relation's installed constants. */
const membershipRuleOf: Rule = {
	name: membershipRule,
	at: (cell, cx) => {
		const ed: DagEditor = cx.editor
		const region = cell.current
		if (region.kind !== "MatchRegion") {
			return false
		}
		const [m] = membershipsOf(cx, cell, region)
		if (m === undefined) {
			return false
		}
		const o = m.occurrence
		const remaining: Region = {
			...region,
			occurrences: region.occurrences.filter((x) => x.id !== o.id)
		}
		const outputs: Array<NodeId> = [cell.id]
		const pred = predicateOf(ed, cell, m)
		if (pred === undefined) {
			ed.set(cell, remaining)
		} else {
			/**
			 * The predicate reads the bound variables as the region's columns: one the region does not deliver widens it,
			 * and a projection restores the heading it had.
			 */
			const read = new Set(columnRefs([pred]).map((r) => r.name))
			const heading = widenedHeading(
				region.heading,
				region.vars.filter((v) => read.has(v.name))
			)
			const widened = heading.length > region.heading.length
			ed.set(cell, { ...remaining, heading, meta: derivedMeta(region.meta) })
			ed.insertAbove(cell, (input) => {
				const f = ed.add({
					kind: "Filter",
					input,
					pred,
					heading,
					meta: widened ? derivedMeta(region.meta) : region.meta,
					loc: undefined
				})
				outputs.push(f.id)
				if (!widened) {
					return f
				}
				const restored = ed.add({
					kind: "ProjectSet",
					input: f,
					out: region.heading.map((c) => ({ name: c.name, expr: ed.column(f, c) })),
					heading: region.heading,
					meta: region.meta,
					loc: undefined
				})
				outputs.push(restored.id)
				return restored
			})
		}
		cx.certify({
			rule: membershipRule,
			inputs: [o.source.id, cell.id],
			outputs,
			premises: nodePremises([o.source.id]),
			context: "immediate",
			preservedHeading: region.heading.map((c) => c.name),
			equality: equalityOf(m),
			coercion: [],
			params: undefined
		})
		return true
	}
}

const membershipPotential: Potential = (cx) => {
	let count = 0
	for (const cell of cx.editor.topoOrder()) {
		const node = cell.current
		if (node.kind === "MatchRegion") {
			count += membershipsOf(cx, cell, node).length
		}
	}
	return count
}

/**
 * The R07 pass, over the installation's closed constants.
 *
 * R07: keep finite schema facts visible to PostgreSQL. Pattern: an occurrence of a declared closed relation's every
 * fact that only tests membership (membershipOf): it reads every key column, each as a variable another occurrence of
 * the region binds or a constant, and no payload column. Joining a VALUES source for facts the schema already fixes
 * hides them from the planner and hashes them per statement; the occurrence becomes a predicate over the region
 * instead:
 *
 * - a roster's occurrence is a tautology, since the domain that types the variable's column holds only the roster's
 *   live codes, and it disappears;
 * - a closed relation's occurrence is the membership test of its key, closedHas, which lowers to one bit of the
 *   relation's installed key set at the key's mixed-radix index (lower/conservative/expr closedRead): a cell read,
 *   O(1) per row, with no join, whatever the relation's size.
 *
 * The predicate reads the bound variables as columns of the remaining region; a variable the region does not deliver
 * (a join variable outside its heading) widens it under the filter, and a projection restores its heading.
 *
 * Only a membership is a cell read. An occurrence that reads a payload column, leaves a key column free, or reads a
 * relation the simplifier narrowed keeps its VALUES source of the facts it reads (lower/conservative/closed). The facts
 * are never enumerated from the constant by generate_series over the key space filtered by its cells: the key space
 * is a product of radices, holes included, and a sparse relation fills little of it. qti-pie's ChildGrammar is 819,200
 * cells for 77,734 facts, so a scan of its key space reads ten cells for every fact a VALUES list holds.
 *
 * The facts are the schema's, compiled into the installation as the constants the lowering reads, and the same at
 * every statement: the rewrite's evidence is the Closed node's facts alone, in the immediate context.
 *
 * Potential: the number of membership-only closed occurrences, at most the DAG's occurrences. A rewrite removes one
 * and makes no other one: removing an occurrence only shrinks the variables the others' memberships find bound
 * elsewhere, and its constants read no column, so no source turns uncorrelated.
 */
export const closedPass: Pass<LogicalQuery, LogicalQuery> = rewritePass({
	name: "closed",
	rules: [membershipRuleOf],
	potential: () => membershipPotential
})
