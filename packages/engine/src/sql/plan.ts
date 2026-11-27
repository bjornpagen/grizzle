/**
 * The plan a bound statement carries (sql/bind.ts bindStatement): how PostgreSQL is to read each relation of it, a value
 * the compiler keeps from the binding that proved it, never one an analysis reads back off printed SQL. Its SQL is the
 * bound statement's print (sql/print.ts), its advice this plan's (sql/advice.ts printAdvice): one pass made both, so the
 * two can't disagree.
 *
 * A plan holds each level of its statements that the advice scope named (sql/naming.ts AdviceScope): a statement's top
 * level, and each level PostgreSQL plans apart under an alias or a CTE name the scope minted, a probe, a fenced or
 * non-simple derived table, a kept CTE. A level PostgreSQL names itself (a sublink's `exists_N`, `expr_N`, `array_N`,
 * `any_N`, a set operation's leaf) holds one item and no join by the binding's construction, and nothing of it is
 * carried. Each level lists its join problem in the order PostgreSQL is told to join it, its first item driving, and how
 * each item after the first joins the items before it.
 *
 * A plan is staged by its index type: a read's AccessIndexRequest before index planning (`ReadPlan<AccessIndexRequest>`,
 * the only source of the requests an installation plans its indexes from, `planRequests`), and the IndexRef the plan
 * resolved it to after (`ReadPlan<IndexRef>`, `resolvePlan`), which alone prints as advice.
 */
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import type { IndexRef } from "#compiler/physical/indexes/ref.ts"
import type { Alias } from "#compiler/sql/naming.ts"

/**
 * How an item after a level's first joins the items before it: a nested loop, the item inner and read again per row
 * before it, a probe's and a LATERAL item's, whose reads PostgreSQL plans per driving row with its values as
 * parameters, and a cross product's; or a hash join, the item hashed whole, a set join's of an item no index binds (a
 * CTE's scan, a fenced derived table, a function's or arrays' rows) to the items before it by an equality.
 */
export type JoinMethod = "nestedLoop" | "hash"

/** A level's plan name: the statement's top level, or a level planned apart under a name the scope minted. */
export type PlanName = { readonly kind: "top" } | { readonly kind: "named"; readonly name: Alias }

/**
 * How an item of a level is read, by the index type `I` of its stage:
 * - `seq`: a stored relation read whole;
 * - `index`: a stored relation read through an index, `index` its request or the IndexRef it resolved to, `bound` the
 *   installed columns its binding fixes by equality, each an index condition of its scan (Law 2), and `needs` every
 *   installed column of it the statement reads, its bound ones among them, which an index-only scan must store;
 * - `bitmap`: a stored relation read through the bitmap of an index, `index`, `bound` and `needs` as an index read's,
 *   each bound column an index condition of the bitmap's index scan beneath its heap scan (Law 2): a search document's
 *   match, which a GIN index serves by a bitmap alone;
 * - `tid`: a stored relation read at the tuple ids a probe of it found, each a TID condition of its scan;
 * - `rows`: no stored relation: a probe's or a derived table's rows, a CTE's scan, a function's, arrays' or VALUES rows,
 *   each a range-table entry of the level, which no scan item names.
 */
export type PlanScan<I> =
	| { readonly kind: "seq" }
	| {
			readonly kind: "index"
			readonly index: I
			readonly bound: ReadonlyArray<string>
			readonly needs: ReadonlyArray<string>
	  }
	| {
			readonly kind: "bitmap"
			readonly index: I
			readonly bound: ReadonlyArray<string>
			readonly needs: ReadonlyArray<string>
	  }
	| { readonly kind: "tid" }
	| { readonly kind: "rows" }

/** One item of a level: its alias, the scope's, and how it is read. */
export interface PlanItem<I> {
	readonly alias: Alias
	readonly scan: PlanScan<I>
}

/** An item after a level's first, with how it joins the items before it. */
export interface JoinedItem<I> {
	readonly item: PlanItem<I>
	readonly join: JoinMethod
}

/**
 * One level the scope named (see the header): its name, its first item, and the items joined after it, in order; and the
 * members of a UNION ALL it reads as one item, which PostgreSQL flattens into an append relation of the level, each a
 * set operation's arm planned apart under its own alias (`appended`): scanned at the level, in no join order.
 */
export interface PlanLevel<I> {
	readonly name: PlanName
	readonly first: PlanItem<I>
	readonly joined: ReadonlyArray<JoinedItem<I>>
	readonly appended: ReadonlyArray<PlanItem<I>>
}

/** A plan of the statements of one advice scope, or of one of them (see the header). */
export interface ReadPlan<I> {
	readonly levels: ReadonlyArray<PlanLevel<I>>
}

/** The plan of several statements of one scope: their levels, in order. */
export const joinPlans = <I>(plans: ReadonlyArray<ReadPlan<I>>): ReadPlan<I> => ({
	levels: plans.flatMap((p) => p.levels)
})

/** The items of a level's join problem, its first then the joined ones, in join order. */
export const levelItems = <I>(level: PlanLevel<I>): ReadonlyArray<PlanItem<I>> => [
	level.first,
	...level.joined.map((j) => j.item)
]

/** Every item a level scans: its join problem's, then its append relations' members. */
export const scannedItems = <I>(level: PlanLevel<I>): ReadonlyArray<PlanItem<I>> => [
	...levelItems(level),
	...level.appended
]

/** Every request a plan's index reads make, in plan order, each as often as a read makes it. */
export const planRequests = (
	plan: ReadPlan<AccessIndexRequest>
): ReadonlyArray<AccessIndexRequest> =>
	plan.levels.flatMap((level) =>
		scannedItems(level).flatMap((item) =>
			item.scan.kind === "index" || item.scan.kind === "bitmap" ? [item.scan.index] : []
		)
	)

/** An item with its index read resolved by `resolve`. */
const resolvedItem = (
	item: PlanItem<AccessIndexRequest>,
	resolve: (request: AccessIndexRequest) => IndexRef
): PlanItem<IndexRef> => {
	const scan = item.scan
	switch (scan.kind) {
		case "index":
		case "bitmap":
			return {
				alias: item.alias,
				scan: { kind: scan.kind, index: resolve(scan.index), bound: scan.bound, needs: scan.needs }
			}
		case "seq":
		case "tid":
		case "rows":
			return { alias: item.alias, scan }
	}
}

/** The plan with each index read's request resolved by `resolve` to the IndexRef the installation planned for it. */
export const resolvePlan = (
	plan: ReadPlan<AccessIndexRequest>,
	resolve: (request: AccessIndexRequest) => IndexRef
): ReadPlan<IndexRef> => ({
	levels: plan.levels.map((level) => ({
		name: level.name,
		first: resolvedItem(level.first, resolve),
		joined: level.joined.map((j) => ({ item: resolvedItem(j.item, resolve), join: j.join })),
		appended: level.appended.map((item) => resolvedItem(item, resolve))
	}))
})
