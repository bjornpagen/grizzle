import type { JustifiedKey } from "#compiler/analysis/physical/fds.ts"
import { keyAmong } from "#compiler/analysis/physical/props.ts"
import type { VarId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type {
	Cell,
	EditNode,
	EditRefs,
	Heading,
	HeadingColumn,
	KindOver,
	OccurrenceOver,
	VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import { type DagEditor, restrictMeta } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type Potential,
	nodePremises,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { regionChain } from "#compiler/lower/optimize/fuse/chain.ts"
import { carrierEquality } from "#compiler/scalar/compute/registry.ts"

const lateFetchRule = "R06.lateFetch"

/** A payload column worth fetching late: a vector, or text without a proved byte bound. */
const widePayload = (t: ScalarType): boolean => {
	const b = baseOf(t)
	return b.carrier === "vector" || (b.carrier === "text" && b.text.byteBound === undefined)
}

type Take = KindOver<"Take", EditRefs>
type Base = KindOver<"Base", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

interface Plan {
	/** The take's cell, and the take it holds. */
	readonly take: Cell
	readonly takeNode: Take
	/** The scanned relation's cell, and the scan it holds. */
	readonly base: Cell
	readonly baseNode: Base
	readonly key: JustifiedKey
	/** B's key columns, to the stage columns that carry them. */
	readonly keyColumns: ReadonlyArray<readonly [HeadingColumn, string]>
	/** The fetched stage columns, to the B columns they copy. */
	readonly payload: ReadonlyArray<readonly [string, string]>
	readonly narrow: Heading
}

/**
 * Every way to fetch payload late from one scanned relation, one plan per stored occurrence with a key the stage
 * carries.
 */
const lateFetchPlans = (cx: RewriteCx, takeCell: Cell, take: Take): ReadonlyArray<Plan> => {
	const ed = cx.editor
	if (take.correlation.length > 0 || ed.readsFeedback(takeCell) || ed.correlated(take.input)) {
		return []
	}
	const d = cx.demand()
	if (d.lateral(takeCell) || d.lateral(take.input)) {
		return []
	}
	const stage = take.input.current
	const chain = regionChain(take.input)
	if (chain === undefined) {
		return []
	}
	const region = chain.region
	const ordered = new Set(take.order.keys.map((k) => k.column))
	/** Each stage column by the region variable it carries. */
	const columnsOf = new Map<VarId, Array<string>>()
	for (const [col, v] of chain.columns) {
		columnsOf.set(v.id, [...(columnsOf.get(v.id) ?? []), col])
	}
	/** For each stored occurrence, the plan of the one key the stage carries, when its payload is wide. */
	const plans: Array<Plan> = []
	for (const o of region.occurrences) {
		const base = o.source.current
		if (base.kind !== "Base") {
			continue
		}
		const bound = new Map<string, VarDecl>()
		for (const b of o.bindings) {
			if (!bound.has(b.column)) {
				bound.set(b.column, b.var)
			}
		}
		/** The columns of the scan the stage carries, each with the stage column carrying it. */
		const carried = new Map<string, readonly [HeadingColumn, string]>()
		for (const c of base.heading) {
			const v = bound.get(c.name)
			const col = v === undefined ? undefined : columnsOf.get(v.id)?.[0]
			if (col !== undefined) {
				carried.set(c.name, [c, col])
			}
		}
		const props = cx.physical().of(o.source).props
		const narrowCarried = [...carried].flatMap(([name, [c]]) => (widePayload(c.type) ? [] : [name]))
		/**
		 * The key the narrow take sorts (keyAmong): one among the narrow carried columns, so every wide one is payload
		 * it fetches, and otherwise one among all of them, a wide key column then carried through the sort.
		 */
		const key = keyAmong(props, narrowCarried) ?? keyAmong(props, carried.keys())
		if (key === undefined) {
			continue
		}
		/** The stage columns that carry each column of the key. */
		const keyColumns = key.columns.map((k) =>
			defined(carried.get(k), "a key among the carried columns is carried")
		)
		/** The stage columns the occurrence's relation can deliver instead, outside the order and the key, each
		 * from a column of the same type no other fetched column copies; and whether one of them is wide. */
		const keyStage = new Set(keyColumns.map(([, c]) => c))
		const used = new Set(key.columns)
		const payload: Array<readonly [string, string]> = []
		let wide = false
		for (const col of stage.heading) {
			if (ordered.has(col.name) || keyStage.has(col.name)) {
				continue
			}
			const v = chain.columns.get(col.name)
			const source = v === undefined ? undefined : o.bindings.find((b) => b.var.id === v.id)?.column
			if (source === undefined || used.has(source)) {
				continue
			}
			if (!base.heading.some((c) => c.name === source && sameScalarType(c.type, col.type))) {
				continue
			}
			used.add(source)
			payload.push([col.name, source])
			if (widePayload(col.type)) {
				wide = true
			}
		}
		if (!wide) {
			continue
		}
		const fetched = new Set(payload.map(([c]) => c))
		plans.push({
			take: takeCell,
			takeNode: take,
			base: o.source,
			baseNode: base,
			key,
			keyColumns,
			payload,
			narrow: stage.heading.filter((c) => !fetched.has(c.name))
		})
	}
	return plans
}

const fetch = (cx: RewriteCx, plan: Plan): void => {
	const ed: DagEditor = cx.editor
	const take = plan.takeNode
	const base = plan.baseNode
	const stage = take.input
	const narrow = ed.add({
		kind: "ProjectSet",
		input: stage,
		out: plan.narrow.map((c) => ({ name: c.name, expr: ed.column(stage, c) })),
		heading: plan.narrow,
		meta: restrictMeta(stage.current.meta, plan.narrow),
		loc: undefined
	})
	const selected = ed.add({
		kind: "Take",
		input: narrow,
		order: take.order,
		bound: take.bound,
		correlation: [],
		heading: plan.narrow,
		meta: restrictMeta(take.meta, plan.narrow),
		loc: undefined
	})
	const rescan = ed.rescan(base)
	const vars = new Map<string, VarDecl>(
		take.heading.map((c: HeadingColumn) => [
			c.name,
			{ id: ed.freshVar(), name: c.name, type: c.type }
		])
	)
	/** The plan's columns are the take's. */
	const varOf = (name: string): VarDecl => columnIn(vars, name)
	const selectedOcc: Occurrence = {
		id: ed.freshOccurrence(),
		source: selected,
		bindings: plan.narrow.map((c) => ({ column: c.name, var: varOf(c.name) })),
		constants: []
	}
	const fetchOcc: Occurrence = {
		id: ed.freshOccurrence(),
		source: rescan,
		bindings: [
			...plan.keyColumns.map(([k, col]) => ({ column: k.name, var: varOf(col) })),
			...plan.payload.map(([col, source]) => ({ column: source, var: varOf(col) }))
		],
		constants: []
	}
	const region: EditNode = {
		kind: "MatchRegion",
		scope: ed.freshScope(),
		vars: [...vars.values()],
		occurrences: [selectedOcc, fetchOcc],
		equalities: [],
		correlated: [],
		heading: take.heading,
		meta: take.meta,
		loc: take.loc
	}
	ed.set(plan.take, region)
	const equality = plan.keyColumns.map(([k]) => carrierEquality(baseOf(k.type).carrier))
	cx.certify({
		rule: lateFetchRule,
		inputs: [plan.take.id, stage.id, plan.base.id],
		outputs: [plan.take.id, narrow.id, selected.id, rescan.id],
		premises: [...plan.key.just.premises, ...nodePremises([stage.id])],
		context: plan.key.just.context,
		preservedHeading: take.heading.map((c) => c.name),
		equality,
		coercion: [],
		params: undefined
	})
}

const lateFetch: Rule = {
	name: lateFetchRule,
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "Take") {
			return false
		}
		const plan = lateFetchPlans(cx, cell, node)[0]
		if (plan === undefined) {
			return false
		}
		fetch(cx, plan)
		return true
	}
}

/**
 * The wide columns every take carries outside its order: each rewrite fetches one plan's columns, a wide one among them,
 * which leave the narrowed take.
 */
const lateFetchPotential: Potential = (cx) => {
	let count = 0
	for (const cell of cx.editor.topoOrder()) {
		const node = cell.current
		if (node.kind !== "Take") {
			continue
		}
		const ordered = new Set(node.order.keys.map((k) => k.column))
		count += node.heading.filter((c) => widePayload(c.type) && !ordered.has(c.name)).length
	}
	return count
}

/**
 * The R06 pass, under the compilation's catalog (PassContext), which backs B's keys.
 *
 * R06: delay expensive payload work explicitly when legal.
 *
 * Pattern: a bounded subset take(k) over a stage whose heading carries wide payload columns, large text or vectors,
 * that the order does not read, each a stored field of one scanned relation B whose key the stage also carries.
 * Sorting a narrow key is cheaper than carrying wide payload through the sort, so the take first selects
 * the narrow tuple, the key and the order tuple, and then fetches the remaining output through B's key in the same
 * statement:
 *
 *   take_k(P)  =  take_k(pi_N(P))  join  B  on B's key
 *
 * where the fetched payload W is every column of P's heading that the order does not read and that is a stored field
 * of B in the occurrence binding its key, the wide ones and the narrow ones beside them alike, and N is the rest of
 * P's heading: B's key, the order tuple, and the columns B does not store. The proof:
 *
 * - the selected key determines the entire result: every column of W is a stored field of B in the occurrence that
 *   binds B's key K, and K is a physical key of B, proved from admissible evidence in the artifact's context,
 *   so the B fact with a given K is unique and its payload is P's payload;
 * - projection equality is preserved and no new duplicate appears: two rows of P that agree on N agree on K and so on
 *   W, so pi_N is one-to-one on P and the first k of pi_N(P) under the completed order are exactly the first k of P;
 *   the order reads only N, so it orders both alike;
 * - no missing row from an evidence or visibility gap: the B fact a row of P came from is read again in the same
 *   statement, so in the same snapshot, never by a second network round trip;
 * - nothing moves across the limit but plain stored columns: the payload is fetched, not computed.
 *
 * "Wide" is structural, fixed by the policy, never measured per query: a vector, or text with no proved byte bound
 * ("large text and vector payload"). The rewrite fires only when W holds a wide column, and then W takes
 * every fetchable column with it, since B's row is read by key anyway. A correlated take, one on a recursive step,
 * and a stage some expression reads laterally are refused.
 *
 * Potential: the wide columns every take carries outside its order, at most its takes' heading widths. Each rewrite
 * replaces one take by a narrowed take over the same order that carries fewer, since the fetched columns hold a wide
 * one, and changes no other take's heading. Counting only fetchable columns would not do: the fetch region the rewrite leaves is a region chain,
 * so a take over the rewritten one, which had nothing to fetch through a take, now can.
 */
export const lateFetchPass = rewritePass({
	name: "lateFetch",
	rules: [lateFetch],
	potential: () => lateFetchPotential
})
