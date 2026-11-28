/**
 * Advice: the plan a bound statement carries (sql/plan.ts ReadPlan), printed as PostgreSQL 19's pg_plan_advice reads it
 * (contrib/pg_plan_advice README), so the planner can choose no other plan than the one the compiler proved. It is the
 * second print of one bound tree, beside its SQL (sql/print.ts): the SQL carries each read's binding, the shape that
 * makes every bound column an index condition, and the advice carries each choice the SQL cannot, which index, which
 * scan, which join order and method, and that no read runs under a Gather. Nobody writes advice by hand.
 *
 * Each item names one relation occurrence of one statement by its target: its alias, the advice scope's (sql/naming.ts
 * AdviceScope), at the statement's top level, or `<alias>@<level>` inside the level the scope named that PostgreSQL plans
 * apart (pgpa_identifier.c: an alias, its occurrence among the aliases of its level, and the plan name of its level).
 * An alias is unique in its scope, so no target carries an occurrence number, and no item matches two relations
 * (Law 3). Each item is one atom: grouping targets under one tag, as PostgreSQL's generated advice does, means the
 * same.
 *
 * The atoms, per level the plan holds, in order:
 * - `JOIN_ORDER(…)` where the level joins two items or more: its join tree (sql/plan.ts JoinMember), each join's
 *   members in order, the first driving, a member joining several items its own order in parentheses, a problem past
 *   PostgreSQL's join_collapse_limit, `JOIN_ORDER((t1 … t8) t9 …)`, and a group of items built before it joins,
 *   `JOIN_ORDER(t1 (t2 t3))`, alike (`treeOrder`);
 * - for each member after a join's first, the method that puts it on the inner side: `NESTED_LOOP_PLAIN(t)`, a probe's,
 *   a LATERAL item's, a group's holding one and a cross product's, read again per row before it, or `HASH_JOIN(t)`, a
 *   set join's; a member joining several items named as the set of them, `NESTED_LOOP_PLAIN((t2 t3))`, in the order
 *   of their range-table entries (`methodAtoms`);
 * - for each stored relation, its scan: `SEQ_SCAN(t)` read whole; `INDEX_ONLY_SCAN(t <index>)` through an index that
 *   returns what it stores and stores every column the statement reads of it, else `INDEX_SCAN(t <index>)`, each
 *   disabling every other index of the relation and every other scan kind; `BITMAP_HEAP_SCAN(t)` through a bitmap,
 *   which names no index (pg_plan_advice's README: a bitmap heap scan takes no index specification), so the index set
 *   gives each bitmap read exactly one index able to serve it; `TID_SCAN(t)` at tuple ids;
 * - `NO_GATHER(t)` for every item, every range-table entry of the level, a UNION ALL's members it flattens into an
 *   append relation among them, so no read runs in parallel; but for a relation of PostgreSQL's system catalogs, whose
 *   read the advice holds no item of (sql/plan.ts PlanScan `catalog`).
 * Nothing else: no semi-join item (no sublink the binding leaves is one PostgreSQL flattens), no Memoize or Materialize
 * (a nested loop is plain), no Gather.
 *
 * An identifier is printed as the advice parser reads one (pgpa_scanner.l): bare where it is a lowercase identifier
 * and no advice tag, the parser downcasing a bare one and reading a tag's name as the tag; double-quoted, each quote
 * doubled, otherwise. An index is printed schema-qualified, each part so.
 */
import { nominal } from "#compiler/core/brand.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import type { IndexRef, IndexResolver } from "#compiler/physical/indexes/ref.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import type { Alias } from "#compiler/sql/naming.ts"
import {
	type JoinMember,
	type JoinMethod,
	type JoinTree,
	joinPlans,
	resolvePlan,
	scannedItems,
	type PlanItem,
	type PlanLevel,
	type ReadPlan
} from "#compiler/sql/plan.ts"

declare const adviceBrand: unique symbol

/** A pg_plan_advice string: items separated by one space, each one atom (see the header). */
export type Advice = string & { readonly [adviceBrand]: true }

const mint = nominal<string, Advice>()

/**
 * Every tag pg_plan_advice parses (pgpa_ast.c pgpa_parse_advice_tag), each as its scanner downcases it: an identifier
 * spelled as one is read as the tag, so it is quoted.
 */
const tags: ReadonlySet<string> = new Set([
	"bitmap_heap_scan",
	"do_not_scan",
	"foreign_join",
	"gather",
	"gather_merge",
	"hash_join",
	"index_only_scan",
	"index_scan",
	"join_order",
	"merge_join_materialize",
	"merge_join_plain",
	"nested_loop_materialize",
	"nested_loop_memoize",
	"nested_loop_plain",
	"no_gather",
	"partitionwise",
	"semijoin_non_unique",
	"semijoin_unique",
	"seq_scan",
	"tid_scan"
])

/** Whether a code unit may start a bare identifier the advice scanner keeps as it is: a lowercase letter or `_`. */
const bareStart = (unit: number): boolean => (unit >= 0x61 && unit <= 0x7a) || unit === 0x5f

/** Whether a code unit may continue one: a start's, a digit or `$`. */
const bareContinue = (unit: number): boolean =>
	bareStart(unit) || (unit >= 0x30 && unit <= 0x39) || unit === 0x24

/** Whether a name is a bare identifier the advice scanner reads as itself, downcasing nothing (pgpa_scanner.l). */
const isBare = (name: string): boolean => {
	if (name.length === 0 || !bareStart(name.charCodeAt(0))) {
		return false
	}
	for (let i = 1; i < name.length; i++) {
		if (!bareContinue(name.charCodeAt(i))) {
			return false
		}
	}
	return true
}

/** A name double-quoted, each quote doubled: read by the advice scanner as it is. */
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** An identifier as the advice parser reads it back as itself (see the header). */
const ident = (name: string): string => (isBare(name) && !tags.has(name) ? name : quoted(name))

/** A target inside a level the scope named: `<alias>@<level>`. */
const within = (alias: string, level: string): string => `${ident(alias)}@${ident(level)}`

/** An index, schema-qualified. */
const indexName = (name: ObjectName): string => `${ident(name.schema)}.${ident(name.name)}`

const methodTag: { readonly [M in JoinMethod]: string } = {
	nestedLoop: "NESTED_LOOP_PLAIN",
	hash: "HASH_JOIN"
}

/** Whether a read through `index` needs no heap fetch for the columns it reads: an index-only scan's precondition. */
const onlyIndex = (index: IndexRef, needs: ReadonlyArray<string>): boolean =>
	index.returns && needs.every((c) => index.stores.includes(c))

/** An item's scan atom, none for an item no scan names. */
const scanAtom = (item: PlanItem<IndexRef>, at: string): ReadonlyArray<string> => {
	const scan = item.scan
	switch (scan.kind) {
		case "seq":
			return [`SEQ_SCAN(${at})`]
		case "index":
			return [
				`${onlyIndex(scan.index, scan.needs) ? "INDEX_ONLY_SCAN" : "INDEX_SCAN"}(${at} ${indexName(scan.index.name)})`
			]
		case "bitmap":
			return [`BITMAP_HEAP_SCAN(${at})`]
		case "tid":
			return [`TID_SCAN(${at})`]
		case "rows":
		case "catalog":
			return []
	}
}

/** An item's atom of no Gather. */
const noGather = (at: string): string => `NO_GATHER(${at})`

/** A join member's text in a join order: an item's target, a tree its own order in parentheses (pgpa_output.c
 * pgpa_output_join_member). */
const orderText = (
	member: JoinMember<IndexRef>,
	at: (item: PlanItem<IndexRef>) => string
): string => (member.kind === "item" ? at(member.item) : `(${treeOrder(member.tree, at)})`)

/** A tree's members in join order, each its `orderText`. */
const treeOrder = (tree: JoinTree<IndexRef>, at: (item: PlanItem<IndexRef>) => string): string =>
	[tree.first, ...tree.joined.map((j) => j.member)].map((m) => orderText(m, at)).join(" ")

/**
 * A tree's method atoms: each joined member's, the method that puts it on the inner side, named as an item's target or,
 * a tree, as the set of its items in range-table order (`range`); then each tree member's own, its first's and its
 * joined ones' in order.
 */
const methodAtoms = (
	tree: JoinTree<IndexRef>,
	at: (item: PlanItem<IndexRef>) => string,
	named: (alias: Alias) => string
): ReadonlyArray<string> => {
	const own = (member: JoinMember<IndexRef>): ReadonlyArray<string> =>
		member.kind === "item" ? [] : methodAtoms(member.tree, at, named)
	return [
		...own(tree.first),
		...tree.joined.flatMap((j) => [
			`${methodTag[j.join]}(${j.member.kind === "item" ? at(j.member.item) : `(${j.member.range.map(named).join(" ")})`})`,
			...own(j.member)
		])
	]
}

/** A level's atoms, in the order the header states. */
const levelAtoms = (level: PlanLevel<IndexRef>): ReadonlyArray<string> => {
	const scanned = scannedItems(level)
	const named = (alias: Alias) =>
		level.name.kind === "top" ? ident(alias) : within(alias, level.name.name)
	const at = (item: PlanItem<IndexRef>) => named(item.alias)
	const problem = level.kind === "joins" ? level.problem : undefined
	return [
		...(problem?.kind === "tree"
			? [`JOIN_ORDER(${treeOrder(problem.tree, at)})`, ...methodAtoms(problem.tree, at, named)]
			: []),
		...scanned.flatMap((item) => scanAtom(item, at(item))),
		...scanned.flatMap((item) => (item.scan.kind === "catalog" ? [] : [noGather(at(item))]))
	]
}

/**
 * The advice of no atom: a routine's whose statements read no relation, which it sets all the same, so they are planned
 * under no advice, never its caller's (sql/print.ts adviceClause), as an application's declared function is, whose body
 * grizzle binds no statement of (sql/print.ts declaredAdviceClause, which prints the empty advice from its text, so the
 * printer loads no module of the planner's).
 */
export const noAdvice: Advice = mint("")

/** A plan's advice (see the header): `noAdvice` where it holds no level, a statement's that reads no relation. */
export const printAdvice = (plan: ReadPlan<IndexRef>): Advice =>
	mint(plan.levels.flatMap(levelAtoms).join(" "))

/**
 * The advice of a transaction that may send the statements of `plans`, every one bound under its one scope (sql/naming.ts
 * AdviceScope), each read resolved to the index the installation planned for it (`resolve`): their plans' atoms, which
 * hold whichever of the statements a call sends, an atom of an unsent one targeting no relation the call's statements
 * read. What a served read, page and write is planned under (served/forms.ts ServedRead, ServedPage;
 * runtime/write/flight.ts ServedWrite).
 */
export const transactionAdvice = (
	plans: ReadonlyArray<ReadPlan<AccessIndexRequest>>,
	resolve: IndexResolver
): Advice => printAdvice(resolvePlan(joinPlans(plans), resolve))
