import type { NodeId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Heading, HeadingColumn, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	type LowerContext,
	outputNames
} from "#compiler/lower/conservative/context.ts"
import { parentRowsSource } from "#compiler/lower/conservative/deliver.ts"
import { carriedFrom, positiveLinear } from "#compiler/lower/shapes/attach-recursive/carried.ts"
import type { DeliveredRows, PipelinedAttachment } from "#compiler/lower/shapes/attach/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { ChoiceInput } from "#compiler/lower/shapes/take/index.ts"
import { orderIsTotal, orderItemsOf } from "#compiler/lower/shapes/take/order.ts"
import type { Expr, OrderItem, Select, SelectCore, With } from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	cast,
	col,
	core,
	cteRefAs,
	eq,
	provedCore,
	select,
	target
} from "#compiler/sql/build.ts"

/**
 * A parent key column of a seeded attachment, with the origin column of the state it is delivered from: the first the
 * Attach equates it with.
 */
interface SeedKey {
	readonly parent: HeadingColumn
	readonly origin: string
}

/** Why an attachment is or is not seeded, for diagnostics and tests. */
type SeedDecision =
	| {
			readonly seeded: true
			readonly recursive: NodeOf<"Recursive">
			/** The parent columns the child reads, every one correlated, in delivered order. */
			readonly keys: ReadonlyArray<SeedKey>
			/** Each equation of the Attach: a parent key column and the origin column of the state it equates. */
			readonly origin: NonEmptyReadonlyArray<{ readonly parent: string; readonly child: string }>
	  }
	| { readonly seeded: false; readonly why: string }

const no = (why: string): SeedDecision => ({ seeded: false, why })

/** Whether, and how, an attachment's child is seeded from the parent keys (see the header for each condition). */
const seedDecision = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	parentColumns: Heading
): SeedDecision => {
	const child = attach.child
	if (child.kind !== "Recursive") {
		return no("the child is not a recursive relation")
	}
	if (cx.feedback.has(child.id)) {
		return no("the child is the recursion being lowered")
	}
	const correlation = attach.correlation
	if (!isNonEmpty(correlation)) {
		return no("the attachment correlates on no parent column")
	}
	const origin = new Set(child.origin)
	for (const c of attach.correlation) {
		if (!origin.has(c.child)) {
			return no(`the correlated column ${c.child} is not an origin column of the state`)
		}
	}
	const keys: Array<SeedKey> = []
	for (const p of parentColumns) {
		const first = attach.correlation.find((c) => c.parent === p.name)
		if (first === undefined) {
			return no(`the child reads the parent column ${p.name} it is not correlated on`)
		}
		keys.push({ parent: p, origin: first.child })
	}
	for (const c of attach.correlation) {
		const p = parentColumns.find((x) => x.name === c.parent)
		const k = child.heading.find((x) => x.name === c.child)
		if (p === undefined || k === undefined) {
			return no(`the correlated columns ${c.parent} and ${c.child}`)
		}
		if (!sameScalarType(p.type, k.type)) {
			return no(`the correlated column ${c.child} is not of its parent column's type`)
		}
	}
	const spineNodes = new Set(spine.map((n) => n.id))
	for (const ref of cx.freeRefs(child.step).keys()) {
		if (spineNodes.has(ref)) {
			return no("the step reads a parent column")
		}
	}
	for (const c of child.heading) {
		if (!c.type.caps.includes("hashing")) {
			return no(`the state column ${c.name} has no hash operator class`)
		}
	}
	if (!positiveLinear(child)) {
		return no("the feedback is not positive and linear")
	}
	for (const c of attach.correlation) {
		if (!carriedFrom(child.step, c.child, child.self, c.child)) {
			return no(`the step does not carry the origin column ${c.child}`)
		}
	}
	return { seeded: true, recursive: child, keys, origin: correlation }
}

/**
 * The R37 statement, or undefined where the attachment is not seeded (the pipelined statement then stands). A seeded
 * attachment is delivered exactly like a pipelined one: the parent key columns, then the child's heading.
 *
 * A recursive attachment seeded once from the delivered parent keys.
 *
 * Pattern: an attachment whose child is a recursive relation whose state carries the originating parent, its origin
 * (check/recursion/origin.ts): the Attach equates each parent key column with an origin column of the state. The
 * pipelined statement (shapes/attach) reads the child per delivered parent, LATERAL to the parent's rows, and
 * filters its states by the origin, so the recursion's seed is whatever the child's base delivers: every root of the
 * relation, not only the delivered parents. R37 instead lowers one recursive statement for the whole page whose seed
 * is the parent's rows, computed again in this statement (conservative/deliver.ts parentRowsSource):
 *
 *   WITH RECURSIVE r1(c1, c2) AS (
 *     SELECT r4.c5::uuid, r4.c6::uuid
 *     FROM (<the parent's rows>) AS r2(c3, c4),
 *       LATERAL (<base>) AS r4(c5, c6)
 *     WHERE r4.c5 = r2.c3
 *     UNION
 *     SELECT r7.c8::uuid, r7.c9::uuid FROM (<step reading r1>) AS r7(c8, c9)
 *   )
 *   SELECT r10.c1, r10.c1, r10.c2 FROM r1 AS r10 [ORDER BY r10.c1, <child order>]
 *
 * The seed is the recursion's non-recursive term, evaluated once, so the closure of every delivered parent is seeded
 * once and computed once, and the planner estimates the seed from the parent's own query. The parent key columns,
 * then the child's heading, as the pipelined statement delivers them, so the library stitches the rows onto their
 * parents by key exactly as before; never one recursive statement per parent.
 *
 * Why it equals the pipelined statement. Write P for the parent key columns, C for the origin columns the Attach
 * equates them with, base(p) for the child's base under parent p, and S(X) for the fixed point seeded by X. The
 * pipelined statement delivers, for each delivered parent p, the states s of S(base(p)) with s.C = p.P.
 *
 * 1. Every column of C is carried by the step (carried.ts): each state's C equals its seed's C. So a seed whose C is
 *    not a delivered parent's P never produces a state the pipelined filter keeps, and restricting the seed to
 *    C = P for some delivered parent removes no delivered state.
 * 2. The feedback is positive and linear (carried.ts positiveLinear), so S distributes over a union of seeds:
 *    S(U_q seed(q)) = U_q S(seed(q)), and by 1 the states of S(seed(q)) all have C = q.P, so the seeded closure's
 *    states with C = p.P are exactly those of S(seed(q)) for the parents q with q.P = p.P.
 * 3. The base reads no parent column but the correlated ones, P, so base(q) = base(p) when q.P = p.P, and the
 *    seeded seed for p, base(p) restricted to C = p.P, is what the pipelined filter keeps of base(p)'s states.
 * 4. C's canonical cell text is the parent's key's (codec/scalar.ts cellText): C equals P natively, and equal values
 *    have one cell text, so C, delivered as the parent key, stitches as the parent's own key and the stitch by key is
 *    the pipelined one. The rows are distinct: the full
 *    state is delivered and the recursive UNION deduplicates it, so no DISTINCT is needed, and a
 *    parent key repeated in the parent's rows only repeats a seed, which the UNION collapses.
 *
 * The step must read no parent column: it would then be correlated to one parent, and a seeded closure has none.
 * Where any condition fails the attachment is not seeded and the pipelined statement stands; both deliver the same
 * nested result.
 */
export const seededAttachment = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	rows: DeliveredRows<ChoiceInput>,
	facts: ShapeFacts,
	parentColumns: Heading
): PipelinedAttachment | undefined => {
	const decision = seedDecision(cx, attach, spine, parentColumns)
	if (!decision.seeded) {
		return undefined
	}
	const rec = decision.recursive

	/**
	 * The parent's rows, computed again in this statement as the pipelined statement reads them, before the recursion
	 * is registered as feedback, so nothing of the parent's lowering can scan it.
	 */
	const parent = parentRowsSource(cx, rows, { kind: "node", node: attach.id })
	const parentMap: ColumnMap = new Map(
		decision.keys.map((k) => [k.parent.name, parent.column(k.parent.name)])
	)

	/** The recursive CTE, registered as the feedback its SelfRef scans while the terms are lowered. */
	const recOrigin = { kind: "node", node: rec.id } as const
	const cte = cx.relationAlias(recOrigin)
	const columns = cx.freshColumns(outputNames(rec.heading), recOrigin)
	const terms = cx.withFeedback(rec, cte, columns)
	/** The base's and the step's headings have the state's columns (valid DAG). */
	const stateTargets = (map: ColumnMap) =>
		rec.heading.map((c) => target(cast(columnIn(map, c.name), cx.baseTypeRef(c.type))))
	/**
	 * The seed: the base for every parent row, LATERAL to the parent's rows, restricted to the states whose origin is
	 * that parent's key.
	 */
	const env: Env = new Map<NodeId, ColumnMap>(spine.map((n) => [n.id, parentMap]))
	const base = terms.sourceAs(rec.base, env, true)
	/** Every equation of the Attach, so a parent key equated with two origin columns restricts both. */
	const restrict = mapNonEmpty(decision.origin, (c) =>
		eq(columnIn(base.map, c.child), parent.column(c.parent))
	)
	const seed: SelectCore = core(stateTargets(base.map), [parent.item, base.item], and(restrict))
	/** The step: uncorrelated to any parent, it reads only the feedback and the stored relations. */
	const stepSource = terms.source(rec.step, new Map())
	const step: SelectCore = core(stateTargets(stepSource.map), [stepSource.item], undefined)
	const body: Select = select({ kind: "setOp", op: "UNION", arms: [seed, step] })

	/** The delivered rows: each origin column as its parent key, then the child's heading. */
	const child = rec
	const scan = cx.relationAlias(recOrigin)
	const states = columns.map((c) => ({ name: c.name, expr: col(scan, c.column) }))
	const stateMap: ColumnMap = new Map(states.map((c) => [c.name, c.expr]))
	/** The decision found every origin column in the state's heading. */
	const originOf = (k: SeedKey): Expr => columnIn(stateMap, k.origin)
	const targets = [
		...decision.keys.map((k) => target(originOf(k))),
		...states.map((c) => target(c.expr))
	]
	const orderBy: ReadonlyArray<OrderItem> =
		attach.order === undefined
			? []
			: [
					...decision.keys.map((k) => asc(originOf(k))),
					...orderItemsOf(attach.order, child.heading, stateMap, {
						leading: [],
						total: orderIsTotal(facts, attach.child, attach.order, child.heading),
						fixed: []
					})
				]
	const scanned = provedCore("keyed", targets, [cteRefAs(cte, scan)], undefined)
	const recursion: With = {
		recursive: true,
		ctes: [
			{ name: cte, columns: columns.map((c) => c.column), query: body, materialized: undefined }
		]
	}
	return {
		rows: { ...select(scanned), with: recursion },
		query: { ...select(scanned), with: recursion, orderBy }
	}
}
