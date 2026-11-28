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
 * carried. Each level holds its join problem as the tree PostgreSQL is told to build (`JoinMember`): its members in the
 * order they are joined, the first driving, and how each after it joins the members before it, a member an item or a
 * join of several PostgreSQL builds first and joins as one.
 *
 * A plan is staged by its index type: a read's AccessIndexRequest before index planning (`ReadPlan<AccessIndexRequest>`,
 * the only source of the requests an installation plans its indexes from, `planRequests`), and the IndexRef the plan
 * resolved it to after (`ReadPlan<IndexRef>`, `resolvePlan`), which alone prints as advice.
 */
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import type { IndexRef } from "#compiler/physical/indexes/ref.ts"
import type { Alias } from "#compiler/sql/naming.ts"

/**
 * How a member after a join's first joins the members before it (`JoinedMember`): a nested loop, the member inner and
 * read again per row before it, a probe's, a LATERAL item's and a group's holding one, whose reads PostgreSQL plans per
 * driving row with its values as parameters, and a cross product's; or a hash join, the member hashed whole, a set
 * join's of an item no index binds (a CTE's scan, a fenced derived table, a function's or arrays' rows) to the members
 * before it by an equality PostgreSQL keeps as a join clause, one of a class of the level's equalities that holds no value the level fixes (sql/bind.ts
 * keysJoin): of a class that holds one, PostgreSQL states each member's equality with the value and pairs no two items,
 * so the join is a nested loop.
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
 *   each a range-table entry of the level, which no scan item names;
 * - `catalog`: a relation of PostgreSQL's system catalogs, its schema pg_catalog's, which PostgreSQL reads as its costs
 *   choose over the catalog's real statistics: no index of the installation's serves it and grizzle proves no plan of
 *   it, so the advice holds no item of it, neither a scan nor a NO_GATHER, and the budget bounds no scan of it. Its
 *   level reads it alone (sql/bind.ts levelJoins): a join of it to another relation would be a join no plan of
 *   grizzle's states, an internal compiler error.
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
	| { readonly kind: "catalog" }

/** One item of a level: its alias, the scope's, and how it is read. */
export interface PlanItem<I> {
	readonly alias: Alias
	readonly scan: PlanScan<I>
}

/**
 * A member of a join (`JoinTree`): one item, or a join of several (`tree`) PostgreSQL builds before it joins it as one:
 * a join problem of its own, the first members of a level's FROM past join_collapse_limit (initsplan.c
 * deconstruct_recurse), or a group of items no member before them is linked to apart from the last of them, which
 * PostgreSQL's join search builds as the inner side of the join that reaches them (sql/bind.ts levelJoins). A tree
 * carries its items' aliases in the order of their range-table entries (`range`), which is the order pg_plan_advice
 * prints a join of them in where it names the join as a set, a method's target (pgpa_output.c pgpa_output_relations,
 * over a relid set).
 */
export type JoinMember<I> =
	| { readonly kind: "item"; readonly item: PlanItem<I> }
	| {
			readonly kind: "tree"
			readonly tree: JoinTree<I>
			readonly range: NonEmptyReadonlyArray<Alias>
	  }

/** A join of two members or more in the order PostgreSQL is told to join them: its first driving, the rest joined in
 * order, each on the inner side of the join that joins it to the members before it, by its method. */
export interface JoinTree<I> {
	readonly first: JoinMember<I>
	readonly joined: NonEmptyReadonlyArray<JoinedMember<I>>
}

/** A member after a join's first, with how it joins the members before it. */
export interface JoinedMember<I> {
	readonly member: JoinMember<I>
	readonly join: JoinMethod
}

/**
 * One level the scope named (see the header), by its name:
 * - `joins`: a join problem (`problem`), one item or a tree of them; and the members of a UNION ALL one of its items
 *   reads, which PostgreSQL flattens into that item's append relation (prepjointree.c
 *   pull_up_simple_union_all), each the one item of an arm it pulls up (`appended`): scanned at the level, in no join
 *   order;
 * - `append`: a UNION ALL's query alone, which PostgreSQL flattens into an append relation of its own level
 *   (prepjointree.c flatten_simple_union_all), the relation it scans in no join problem, its members the one item of
 *   each arm, each pulled up into the level: the relation PostgreSQL makes of the set operation's first arm stands for
 *   the whole, under a name of its own, and no plan names it.
 */
export type PlanLevel<I> =
	| {
			readonly kind: "joins"
			readonly name: PlanName
			readonly problem: JoinMember<I>
			readonly appended: ReadonlyArray<PlanItem<I>>
	  }
	| {
			readonly kind: "append"
			readonly name: PlanName
			readonly members: NonEmptyReadonlyArray<PlanItem<I>>
	  }

/** A plan of the statements of one advice scope, or of one of them (see the header). */
export interface ReadPlan<I> {
	readonly levels: ReadonlyArray<PlanLevel<I>>
}

/** The plan of several statements of one scope: their levels, in order. */
export const joinPlans = <I>(plans: ReadonlyArray<ReadPlan<I>>): ReadPlan<I> => ({
	levels: plans.flatMap((p) => p.levels)
})

/** The items of a join member, in join order. */
export const memberItems = <I>(member: JoinMember<I>): ReadonlyArray<PlanItem<I>> =>
	member.kind === "item"
		? [member.item]
		: [
				...memberItems(member.tree.first),
				...member.tree.joined.flatMap((j) => memberItems(j.member))
			]

/** The items of a level's join problem, in join order; none of an append level's. */
export const levelItems = <I>(level: PlanLevel<I>): ReadonlyArray<PlanItem<I>> =>
	level.kind === "joins" ? memberItems(level.problem) : []

/** Every item a level scans: its join problem's, then its append relations' members. */
export const scannedItems = <I>(level: PlanLevel<I>): ReadonlyArray<PlanItem<I>> =>
	level.kind === "joins" ? [...levelItems(level), ...level.appended] : level.members

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
		case "catalog":
			return { alias: item.alias, scan }
	}
}

/** A join member with each of its items' index reads resolved by `resolve`. */
const resolvedMember = (
	member: JoinMember<AccessIndexRequest>,
	resolve: (request: AccessIndexRequest) => IndexRef
): JoinMember<IndexRef> =>
	member.kind === "item"
		? { kind: "item", item: resolvedItem(member.item, resolve) }
		: {
				kind: "tree",
				tree: {
					first: resolvedMember(member.tree.first, resolve),
					joined: mapNonEmpty(member.tree.joined, (j) => ({
						member: resolvedMember(j.member, resolve),
						join: j.join
					}))
				},
				range: member.range
			}

/** The plan with each index read's request resolved by `resolve` to the IndexRef the installation planned for it. */
export const resolvePlan = (
	plan: ReadPlan<AccessIndexRequest>,
	resolve: (request: AccessIndexRequest) => IndexRef
): ReadPlan<IndexRef> => ({
	levels: plan.levels.map((level): PlanLevel<IndexRef> =>
		level.kind === "joins"
			? {
					kind: "joins",
					name: level.name,
					problem: resolvedMember(level.problem, resolve),
					appended: level.appended.map((item) => resolvedItem(item, resolve))
				}
			: {
					kind: "append",
					name: level.name,
					members: mapNonEmpty(level.members, (item) => resolvedItem(item, resolve))
				}
	)
})
