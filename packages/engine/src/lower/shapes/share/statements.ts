import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { analyzeDemand, type DemandAnalysis, noPins } from "#compiler/analysis/demand/demand.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import { catchRefusal, maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { type DagTemplates, ShareKeys } from "#compiler/ir/dag-digest.ts"
import { freeVars, type NodeScope, nodeScopes, nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import { Fold } from "#compiler/ir/fold.ts"
import { edgesOf, inputsOf, type NodeOf, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { evaluationQuery, statementEvaluations } from "#compiler/lower/conservative/call/index.ts"
import {
	type CteTable,
	cteAtFirstUse,
	type Env,
	type EvaluationLookup,
	emptyEnv,
	type LowerContext,
	type NodeDispatch,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import {
	costClass,
	ownCost,
	restrictedByValues
} from "#compiler/lower/optimize/cte-policy/index.ts"
import { feedbackReadsOf, nodeGraph } from "#compiler/lower/optimize/demand/editor.ts"
import { type KeyedRead, KeyedLowering, type KeyScope } from "#compiler/lower/shapes/share/keyed.ts"
import {
	computedAt,
	type FixedOf,
	KeyAnalysis,
	keyedOrder,
	keyPlan,
	type Keys,
	type KeyRestriction,
	Lookups,
	readAtKeys,
	whole as wholeKeys
} from "#compiler/lower/shapes/share/keys.ts"
import type { Cte, FromSource, OperandSelect, Select } from "#compiler/sql/ast.ts"
import { col, type DefinedCte, keyedSet, select, target } from "#compiler/sql/build.ts"
import type { CarrierName } from "#compiler/sql/naming.ts"

/**
 * What the share planning knows of one DAG: each node's share key, computed only for the nodes that may be shared, and
 * whether a node may be shared at all.
 *
 * Sub-queries shared by the statements of one program, and repeated inside one statement.
 *
 * A program's statements often compute one sub-query several times: the members of a ChangeSet stratum that all read
 * the same described query, such as the work queue's `pick`, which each of the claim's three members matches, and
 * within one statement a query imported twice, such as `claimable`, which both rules of `pick` match. Every import is
 * its own copy in the DAG, so two copies share no node id; they share a share key (ir/dag-digest.ts ShareKeys), the
 * digest of the sub-query's block, what it reaches without entering a node that reads nothing outside itself, each such
 * node by its own key, which is equal only when they compute the same set under the same parameter bindings. A call of a
 * volatile function draws its own rows at each evaluation, so its key holds its label (ir/dag-digest.ts templateForm):
 * two calls built alike are never one carrier or one CTE, and one call read twice is.
 *
 * Two placements, by where the copies are read:
 *
 * - Across the statements of one stratum (planStatementShares). Every member of a stratum is evaluated against the
 *   state before the stratum's writes, once, and "when sequential statements consume it, its evaluated set is carried
 *   in a transaction-scoped carrier". A sub-query several member statements read is
 *   carried the same way: evaluated once into a carrier at the start of the stratum, before any of its writes, and
 *   every statement reads the carrier in place of its copy, so every member sees the same rows (the
 *   compiler evaluates pick once and every member sees the same item and seat).
 * - Inside one statement (statementCtes). A sub-query the statement reads more than once is one MATERIALIZED CTE of
 *   the statement under the CTE policy (lower/optimize/cte-policy): a node that folds, sorts, bounds, applies a set
 *   operation or recurses.
 *
 * Both placements share only what the CTE policy computes once (sharedOnce): an expensive node (cte-policy costClass),
 * or a join the statement's own values restrict (cte-policy restrictedByValues), uncorrelated, off every recursion's
 * feedback, read laterally by no expression, so that its rows are a set the statement can read under any alias. A node
 * that only scans, filters and projects one source, or a join no value of the statement restricts, is left inline at
 * each use (cte-policy rules 4 and 6), each read's restriction pushed into it, never derived whole; a single
 * statement's parts carry such a join that two reads or more read at keys, at those keys (keyedShares).
 *
 * What a shared node holds: its rows at the keys every read of it reads it at, where every read restricts it (keys.ts,
 * magic sets), a key set a MATERIALIZED DISTINCT CTE of the statement that reads what the statement fixes; and a union
 * or a fold a statement lowers in place is read at its keys too, every arm at them or the keys below its aggregate. The rows a carrier
 * or a CTE holds are exactly the rows the copy's lowering delivers, repeats included where the placement realized it
 * plain, so every reader sees what its inline copy would deliver.
 */
export class ShareIndex {
	readonly dag: ValidDag
	readonly #demand: DemandAnalysis
	readonly #feedback: ReadonlySet<RelNode>
	readonly #scopes: Fold<RelNode, NodeScope>
	readonly #labels: ReadonlyMap<NodeId, RelNode>
	/** The DAG's share keys, each node's block digested once for every key that reaches it. */
	readonly #shareKeys: ShareKeys
	/** Each node's share key or its absence, by label, computed on its first read. */
	readonly #keys = new Map<NodeId, { readonly key: string | undefined }>()
	/** Whether each node may be shared, by label, decided on its first read. */
	readonly #eligible = new Map<NodeId, boolean>()
	/** Whether each node is a set the statement can read under any alias, by label, decided on its first read. */
	readonly #shareable = new Map<NodeId, boolean>()
	/** The longest path from each node to a leaf, folded from its inputs'. */
	readonly #heights = new Fold<RelNode, number>(function* (node) {
		let h = 0
		for (const input of inputsOf(node)) {
			const below: number = yield input
			h = Math.max(h, below + 1)
		}
		return h
	})

	/** The index of `dag`, its share keys' templates read from `templates`. */
	constructor(dag: ValidDag, templates: DagTemplates) {
		this.dag = dag
		this.#demand = analyzeDemand(dag, noPins)
		this.#feedback = feedbackReadsOf(nodeGraph, topoOrder(dag))
		this.#scopes = nodeScopes()
		this.#labels = nodesByLabel(dag)
		this.#shareKeys = new ShareKeys(
			() => this.#labels,
			maxStringLength,
			(node) => this.#scopes.of(node).outer.size === 0 && !this.#feedback.has(node),
			templates
		)
	}

	/** The node's inputs, once per reference: a region that matches one input twice lowers it twice. */
	inputs(node: RelNode): ReadonlyArray<RelNode> {
		return edgesOf(node)
	}

	/** The longest path from the node to a leaf: a copy's sub-queries are lower than it, and copies are equally high. */
	height(node: RelNode): number {
		return this.#heights.of(node)
	}

	/** How many blocks the index has digested and the code units their tables hold, each block's once: the keying's work. */
	get work(): { readonly blocks: number; readonly units: number } {
		return { blocks: this.#shareKeys.blocks, units: this.#shareKeys.units }
	}

	/**
	 * The node's share key when it may be shared: computed once under the CTE policy (sharedOnce), uncorrelated, without
	 * free variables, read laterally by no expression and off every recursion's feedback (cte-policy rules 3 to 6).
	 */
	key(node: RelNode): string | undefined {
		const known = this.#keys.get(node.id)
		if (known !== undefined) {
			return known.key
		}
		const key = this.eligible(node) ? this.#shareKey(node) : undefined
		this.#keys.set(node.id, { key })
		return key
	}

	/** Whether the node may be shared at all (`key`), which decides whether it has a key, without digesting it. */
	eligible(node: RelNode): boolean {
		const known = this.#eligible.get(node.id)
		if (known !== undefined) {
			return known
		}
		const eligible = this.#isShareable(node) && sharedOnce(node)
		this.#eligible.set(node.id, eligible)
		return eligible
	}

	/**
	 * Whether the node may be carried at its keys alone (keyedShares): a join no value of the statement restricts
	 * (cte-policy costClass, restrictedByValues), which sharedOnce leaves inline at each read, a set the statement can
	 * read under any alias as an eligible node is.
	 */
	restrictable(node: RelNode): boolean {
		return costClass(node) === "join" && !restrictedByValues(node) && this.#isShareable(node)
	}

	/** The share key of a restrictable node: equal for two copies that compute the same set. */
	restrictedKey(node: RelNode): string {
		return this.#shareKey(node)
	}

	/**
	 * Whether the node is a set the statement can read under any alias: no recursion, uncorrelated, without free
	 * variables, read laterally by no expression and off every recursion's feedback (cte-policy rules 3 to 6).
	 */
	#isShareable(node: RelNode): boolean {
		const known = this.#shareable.get(node.id)
		if (known !== undefined) {
			return known
		}
		const shareable =
			node.kind !== "Recursive" &&
			node.kind !== "SelfRef" &&
			freeVars(this.#labels, this.#scopes.of(node)).length === 0 &&
			!this.#demand.lateral(node) &&
			!this.#feedback.has(node) &&
			outerOf(node).length === 0
		this.#shareable.set(node.id, shareable)
		return shareable
	}

	/** The share key of an eligible node (ir/dag-digest.ts ShareKeys); a DAG it cannot key is refused. */
	#shareKey(node: RelNode): string {
		return unwrap(this.#shareKeys.key(node))
	}
}

/**
 * Whether a node a statement reads more than once is computed once, a carrier or a MATERIALIZED CTE, where it is
 * shared at all: an expensive one, which no read restricts below its fold, bound, set operation or recursion (cte-policy
 * rule 5), and a join the statement's own values restrict (cte-policy restrictedByValues, rule 5d), whose rows once are
 * what every read of it restricts it to: answerTestItem's read of the answered member's item session and controls, a
 * join of seven relations at its parameters, which each of the admission's argument arms restated, 96 copies planned.
 */
const sharedOnce = (node: RelNode): boolean => {
	switch (costClass(node)) {
		case "expensive":
			return true
		case "join":
			return restrictedByValues(node)
		case "scan":
			return false
	}
}

/**
 * A sub-query carried across the statements of one stratum: its copies, all of one share key, the copy the carrier's
 * fill evaluates, the rows the carrier holds of it, and the height its fill is placed at, past every carried sub-query
 * its fill reads.
 */
export interface CarriedShare {
	readonly key: string
	readonly node: RelNode
	readonly copies: ReadonlyArray<RelNode>
	readonly restriction: ShareRestriction
	readonly height: number
}

/**
 * The rows a carrier holds of its copy: every row the copy delivers, or those at its key set (keys.ts KeyRestriction), the keys
 * every read of its copies reads them at (keyedShares).
 */
export type ShareRestriction =
	| { readonly kind: "whole" }
	| { readonly kind: "keys"; readonly keys: Keys }

/**
 * Whether a planning carries its shares at their keys (keyedShares), each column's fixings read from `fixed`: a single
 * statement's, whose parts every later part reads; never across statements realized one after another.
 */
export type Restricting =
	| { readonly kind: "byKeys"; readonly fixed: FixedOf }
	| { readonly kind: "never" }

/** No node is opaque to a reach: it enters every node's inputs. */
export const noneOpaque = (_node: RelNode): boolean => false

/**
 * The nodes a statement rooted at `root` lowers, each once, without entering a node `stop` names, nor the inputs of a
 * node `opaque` names below the root: a read of a call's field whose evaluation the statement holds as a part of its
 * own, which reads that part, its arguments lowered there once.
 */
export const reach = (
	index: ShareIndex,
	root: RelNode,
	stop: (node: RelNode) => boolean,
	opaque: (node: RelNode) => boolean
): ReadonlyArray<RelNode> => {
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const node of queue) {
		if (node !== root && opaque(node)) {
			continue
		}
		for (const input of index.inputs(node)) {
			if (!seen.has(input) && !stop(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return queue
}

/**
 * The evaluation key of a read of a call's field whose evaluation a single statement holds as a part of its own
 * (write/program/compile.ts heldEvaluations), undefined for every other node.
 */
export type HeldEvaluation = (node: RelNode) => string | undefined

/** No evaluation is held: statements of their own, each lowering every call it reads itself. */
export const noneHeld: HeldEvaluation = () => undefined

/**
 * The sub-queries more than one of `roots` reads, each statement rooted at one root, to carry across them.
 * The highest shared sub-query is chosen first; a sub-query inside it is then read by the carrier's fill instead of by
 * the statements, and is carried too only when enough statements, that fill among them, still read it. The result is
 * in fill order: a carried sub-query before every carried sub-query that reads it.
 *
 * Every copy of each carried key the statements and the fills reach; filled lowest first. Where `restricting` carries
 * them so, each is carried at the keys every read of it reads it at, and each join no value of the statement restricts
 * that two reads or more read is carried at its keys too (keyedShares).
 */
export const planStatementShares = (
	index: ShareIndex,
	roots: ReadonlyArray<RelNode>,
	held: HeldEvaluation,
	restricting: Restricting
): Result.Result<ReadonlyArray<CarriedShare>, CompileError> =>
	catchRefusal(() => {
		const chosen: Array<{ readonly key: string; readonly node: RelNode }> = []
		const carriedKeys = new Set<string>()
		/** Each node the statements have read that may be shared, carried by no key then, in the order they first read it,
		 * by the round they first read it in. */
		const seen = new Map<RelNode, number>()
		/** Whether a node is a copy of a carried sub-query, which its carrier's reader reads instead: one whose key is
		 * carried. */
		const carried = (node: RelNode): boolean => {
			const key = index.key(node)
			return key !== undefined && carriedKeys.has(key)
		}
		/**
		 * The statements: the roots, then each chosen fill, which lowers its own copy of the share `own` names, each with
		 * the nodes it reads now (reach), which only shrink as keys are carried: a statement reads a node until a key
		 * carries it or every path to it, and never a new one.
		 */
		const units: Array<{
			readonly root: RelNode
			readonly own: string | undefined
			readonly read: () => ReadonlyArray<RelNode>
			nodes: ReadonlyArray<RelNode>
		}> = []
		/** Each node that may be shared, by the statements reading it now. */
		const readers = new Map<RelNode, Set<number>>()
		/** A read of a call's field whose evaluation the statement holds, which reads that part, not its arguments. */
		const opaque = (node: RelNode): boolean => held(node) !== undefined
		/** The nodes a statement reads, a root's none once a key carries the root itself. */
		const readOf = (root: RelNode, own: string | undefined): ReadonlyArray<RelNode> =>
			own === undefined && carried(root) ? [] : reach(index, root, carried, opaque)
		/** A statement entered at `round`: each node it reads that may be shared, read by it, seen first then if never. */
		const enter = (
			root: RelNode,
			own: string | undefined,
			round: number,
			read: () => ReadonlyArray<RelNode>
		): void => {
			const u = units.length
			const nodes = read()
			units.push({ root, own, read, nodes })
			for (const node of nodes) {
				if (!index.eligible(node) || node.heading.length === 0 || carried(node)) {
					continue
				}
				readers.getOrInsertComputed(node, () => new Set<number>()).add(u)
				seen.getOrInsert(node, round)
			}
		}
		/**
		 * Statement `u` read again where it read a node a key carries now, from its root, every node it no longer reads
		 * dropped from its readers, a node the key carries among them; every other statement reads as it did, its reach
		 * stopping at no node it reached.
		 */
		const reread = (u: number): void => {
			const unit = defined(units[u], "a statement")
			const now = unit.nodes.filter(
				(n) => (n !== unit.root || unit.own === undefined) && carried(n)
			)
			if (!isNonEmpty(now)) {
				return
			}
			const nodes = unit.read()
			const kept = new Set(nodes)
			for (const n of unit.nodes) {
				if (!kept.has(n)) {
					readers.get(n)?.delete(u)
				}
			}
			unit.nodes = nodes
		}
		for (const root of roots) {
			enter(root, undefined, 0, () => readOf(root, undefined))
		}
		/**
		 * Each evaluation the statement holds, a statement of its own (write/program/compile.ts heldParts): the nodes its
		 * call's arguments read, which it alone lowers, once, where every read of its fields reads its part.
		 */
		const evaluations = new Map<string, RelNode>()
		for (let u = 0; u < units.length; u++) {
			for (const node of defined(units[u], "a statement").nodes) {
				const key = held(node)
				if (key === undefined || evaluations.has(key)) {
					continue
				}
				evaluations.set(key, node)
				enter(node, undefined, 0, () =>
					index
						.inputs(node)
						.flatMap((argument) =>
							carried(argument) ? [] : reach(index, argument, carried, opaque)
						)
				)
			}
		}
		for (let round = 0; ; round++) {
			/** The highest classes enough statements read this round (decidingClasses), the least key among them chosen. */
			const tied = decidingClasses(index, [...seen.keys()], readers)
			if (!isNonEmpty(tied)) {
				break
			}
			const keyed = tied.map((nodes) => ({
				nodes,
				key: defined(index.key(defined(nodes[0], "a class's first node")), "an eligible key")
			}))
			const winner = keyed.reduce((a, b) => (b.key < a.key ? b : a))
			const node = defined(winner.nodes[0], "a class's first node")
			carriedKeys.add(winner.key)
			chosen.push({ key: winner.key, node })
			for (const u of units.keys()) {
				reread(u)
			}
			enter(node, winner.key, round + 1, () => readOf(node, winner.key))
		}
		/** Each carried key's copies: the nodes of its key the statements read before it was carried. */
		const roundOf = new Map(chosen.map((c, i) => [c.key, i] as const))
		const whole = chosen
			.map((c): CarriedShare => {
				const round = defined(roundOf.get(c.key), "a carried key's round")
				const copies = [...seen].flatMap(([node, at]) =>
					at <= round && index.key(node) === c.key ? [node] : []
				)
				return { ...c, copies, restriction: { kind: "whole" }, height: index.height(c.node) }
			})
			.toSorted((a, b) => a.height - b.height)
		switch (restricting.kind) {
			case "never":
				return whole
			case "byKeys":
				return keyedShares(
					index,
					units.map((u) => u.nodes),
					whole,
					restricting.fixed
				)
		}
	})

/**
 * The carried sub-queries of a single statement, each held at the keys every read of its copies reads them at
 * (keys.ts KeyAnalysis over the program's DAG, its roots whole: magic sets) where no value of the statement restricts it, every read restricts it,
 * and no cycle closes (keyedOrder): computed once at its key set's rows, a union's each arm at them, a fold's below its
 * aggregate, a join's LATERAL per key into it (keyed.ts KeyedLowering body); and each join no value of the
 * statement restricts (ShareIndex restrictable) that the statements read twice or more, its copies one share key's,
 * carried so at its keys, where each read restated it whole; one no read restricts stays inline at each. Each is
 * filled past every carried sub-query its computation reads, its key set's among them. metis's assign derived the
 * status of every assignment, a union of five rules over 100,028 assignments, for two guards that read the statuses of
 * the assigned test's assignments alone; edullm's ledger grade read every item's response declarations, a join of four
 * reads of the attributes, 36 times, each joined to the gradable runs by the item, 934 MB of the grade's 1,186 MB of
 * planning.
 */
const keyedShares = (
	index: ShareIndex,
	read: ReadonlyArray<ReadonlyArray<RelNode>>,
	whole: ReadonlyArray<CarriedShare>,
	fixed: FixedOf
): ReadonlyArray<CarriedShare> => {
	const carried = new Set(whole.flatMap((share) => share.copies))
	const analysis = new KeyAnalysis(
		topoOrder(index.dag),
		new Map(index.dag.roots.map((r) => [r, wholeKeys] as const)),
		fixed,
		new Lookups((node) => carried.has(node))
	)
	const roots = new Set(read.flatMap((statement) => statement.slice(0, 1)))
	/** The joins the statements read, by share key: their copies and how many reads read one. */
	const joins = new Map<string, { readonly copies: Array<RelNode>; reads: number }>()
	for (const node of new Set(read.flat())) {
		for (const input of index.inputs(node)) {
			if (carried.has(input) || !index.restrictable(input)) {
				continue
			}
			const join = joins.getOrInsertComputed(index.restrictedKey(input), () => ({
				copies: [],
				reads: 0
			}))
			if (!join.copies.includes(input)) {
				join.copies.push(input)
			}
			join.reads += 1
		}
	}
	const joined = [...joins]
		.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.flatMap(([key, { copies, reads }]): ReadonlyArray<CarriedShare> => {
			const [node] = copies
			return node === undefined || reads < 2 || copies.some((c) => roots.has(c))
				? []
				: [{ key, node, copies, restriction: { kind: "whole" }, height: index.height(node) }]
		})
	const shares = [...whole, ...joined]
	const order = keyedOrder(
		(node) => index.inputs(node),
		shares.map((share) => ({
			copies: share.copies,
			keys: restrictedByValues(share.node)
				? wholeKeys
				: computedAt(share.node, analysis.keysOfAll(share.copies)),
			height: share.height
		}))
	)
	return shares.flatMap((share, i): ReadonlyArray<CarriedShare> => {
		const at = defined(order[i], "a share's order")
		return at.keys === undefined
			? i < whole.length
				? [{ ...share, height: at.height }]
				: []
			: [{ ...share, restriction: { kind: "keys", keys: at.keys }, height: at.height }]
	})
}

/**
 * The classes of one share key among `nodes`, each a node that may be shared, in the order the statements first read
 * them, that a round's choice reads: every class two statements read at least (`readers`), at the highest height such
 * a class stands at, the classes in the order of their first nodes, each its nodes in that order; none where no class is
 * read twice. Two nodes of one key are of one height, a key holding its node's inputs' keys in order.
 */
export const decidingClasses = (
	index: ShareIndex,
	nodes: ReadonlyArray<RelNode>,
	readers: ReadonlyMap<RelNode, ReadonlySet<number>>
): ReadonlyArray<ReadonlyArray<RelNode>> => {
	/** How many statements read some node of `group`. */
	const statementsOf = (group: ReadonlyArray<RelNode>): number =>
		new Set(group.flatMap((n) => [...(readers.get(n) ?? [])])).size
	const byKey = new Map<string, Array<RelNode>>()
	for (const node of nodes) {
		byKey.getOrInsertComputed(defined(index.key(node), "an eligible key"), () => []).push(node)
	}
	let highest: { readonly height: number; readonly classes: Array<ReadonlyArray<RelNode>> } = {
		height: -1,
		classes: []
	}
	for (const group of byKey.values()) {
		if (statementsOf(group) < 2) {
			continue
		}
		const height = index.height(defined(group[0], "a class's first node"))
		if (height > highest.height) {
			highest = { height, classes: [group] }
		} else if (height === highest.height) {
			highest.classes.push(group)
		}
	}
	return highest.classes
}

/**
 * How many times the statement rooted at `root` lowers each share key, every use of a node lowered anew: a copy under
 * a chosen CTE is lowered once, in the CTE's body, by its first copy in `order`.
 */
const occurrencesByKey = (
	index: ShareIndex,
	root: RelNode,
	order: ReadonlyArray<RelNode>,
	keyed: ReadonlyMap<NodeId, string>,
	chosen: ReadonlySet<string>,
	carried: (node: RelNode) => boolean
): ReadonlyMap<string, number> => {
	const occurrences = new Map<RelNode, number>([[root, 1]])
	const representative = new Map<string, RelNode>()
	const byKey = new Map<string, number>()
	for (const node of order) {
		const occ = occurrences.get(node) ?? 0
		if (occ === 0) {
			continue
		}
		/** The occurrences the node passes on to its inputs: one, from its first copy, under a chosen CTE. */
		const key = keyed.get(node.id)
		let passed = occ
		if (key !== undefined) {
			byKey.set(key, (byKey.get(key) ?? 0) + occ)
			if (chosen.has(key)) {
				const first = representative.get(key)
				if (first === undefined) {
					representative.set(key, node)
				}
				passed = first === undefined || first === node ? 1 : 0
			}
		}
		if (passed === 0) {
			continue
		}
		for (const input of index.inputs(node)) {
			if (!carried(input)) {
				occurrences.set(input, (occurrences.get(input) ?? 0) + passed)
			}
		}
	}
	return byKey
}

/**
 * The share keys one statement rooted at `root` reads at least twice and computes once as a MATERIALIZED CTE, never
 * entering a node `carried` names (the statement reads its carrier), each with the nodes of the statement that are its
 * copies, by label. Occurrences are counted in the statement as it is lowered, every use of a node lowered anew: a
 * copy under a CTE already chosen is lowered once, in the CTE's body. The highest such sub-query is chosen first
 * (cte-policy rule 5: a shared expensive node is MATERIALIZED).
 */
export const statementCtes = (
	index: ShareIndex,
	root: RelNode,
	carried: (node: RelNode) => boolean
): ReadonlyMap<NodeId, string> => {
	const nodes = reach(index, root, carried, noneOpaque)
	/** Parents before children: by decreasing height, a node's inputs being strictly lower. */
	const order = [...nodes].toSorted((a, b) => index.height(b) - index.height(a))
	/** Whether a stage of the node, short of a carried node, which the statement reads as a carrier's scan, is no scan. */
	const costly = new Map<RelNode, boolean>()
	for (const node of order.toReversed()) {
		costly.set(
			node,
			ownCost(node) !== "scan" ||
				index.inputs(node).some((input) => !carried(input) && costly.get(input) === true)
		)
	}
	const keyed = new Map(
		order.flatMap((node) => {
			const key = index.key(node)
			return key !== undefined && costly.get(node) === true ? [[node.id, key] as const] : []
		})
	)
	const chosen = new Set<string>()
	for (;;) {
		const byKey = occurrencesByKey(index, root, order, keyed, chosen, carried)
		/** The highest key read often enough, the least key among equals. */
		let best: { readonly key: string; readonly height: number } | undefined
		for (const node of order) {
			const key = keyed.get(node.id)
			if (key === undefined || chosen.has(key)) {
				continue
			}
			if ((byKey.get(key) ?? 0) < 2) {
				continue
			}
			const height = index.height(node)
			if (
				best === undefined ||
				height > best.height ||
				(height === best.height && key < best.key)
			) {
				best = { key, height }
			}
		}
		if (best === undefined) {
			return new Map([...keyed].filter(([, key]) => chosen.has(key)))
		}
		chosen.add(best.key)
	}
}

/**
 * What a statement reads in place of a carried sub-query, with its columns in the copy's heading order: the carrier a
 * write program filled, or the CTE of the single statement that holds it as a part.
 */
type SharedSource =
	| {
			readonly kind: "carrier"
			readonly carrier: CarrierName
			readonly columns: ReadonlyArray<string>
	  }
	| { readonly kind: "enclosing"; readonly name: string; readonly columns: ReadonlyArray<string> }

/** The FROM item that reads a shared source under `alias`. */
const sourceItem = (source: SharedSource, alias: string): FromSource =>
	source.kind === "carrier"
		? { kind: "table", table: source.carrier, alias }
		: { kind: "enclosing", name: source.name, alias }

interface StatementScope extends CteTable<string>, KeyScope {
	/** The copies of each share key the statement computes once as a MATERIALIZED CTE (statementCtes), by label. */
	readonly materialize: ReadonlyMap<NodeId, string>
	/** The key set each share key of `materialize` is computed at, where it is one (statementKeys). */
	readonly keyed: ReadonlyMap<string, Keys>
	/**
	 * The key set each union or fold the statement lowers in place is computed at, where it is one (statementKeys): the
	 * keys every read of it reaches it at through the nodes above it.
	 */
	readonly inline: ReadonlyMap<RelNode, Keys>
	/** Each key set's MATERIALIZED CTE, defined at its first use (StatementSharing #keyRows). */
	readonly keySets: Map<Keys, DefinedCte>
}

/**
 * The key sets a statement rooted at `root` computes its nodes at (keys.ts KeyAnalysis over the statement's own
 * `nodes`, the root at `rootKeys`, every key set read where the statement reads it): each share key it computes as a
 * CTE (statementCtes) at its copies' key set, and each union or fold it lowers in place, uncorrelated, at its own, where
 * no value of the statement restricts it and no cycle closes (keyedOrder); every other node whole.
 */
const statementKeys = (
	index: ShareIndex,
	root: RelNode,
	rootKeys: KeyRestriction,
	nodes: ReadonlyArray<RelNode>,
	materialize: ReadonlyMap<NodeId, string>,
	fixed: FixedOf
): { readonly keyed: ReadonlyMap<string, Keys>; readonly inline: ReadonlyMap<RelNode, Keys> } => {
	const copiesOf = new Map<string, Array<RelNode>>()
	for (const node of nodes) {
		const key = materialize.get(node.id)
		if (key !== undefined) {
			copiesOf.getOrInsertComputed(key, () => []).push(node)
		}
	}
	const keys = [...copiesOf]
	const plan = keyPlan({
		nodes,
		roots: new Map([[root, rootKeys]]),
		once: keys.map(([, copies]) => copies),
		fixed,
		inputs: (node) => index.inputs(node),
		height: (node) => index.height(node)
	})
	return {
		keyed: new Map(
			keys.flatMap(([key], i) => {
				const at = plan.once[i]
				return at === undefined ? [] : [[key, at] as const]
			})
		),
		inline: plan.inPlace
	}
}

/**
 * The dispatch of a program's statements with sharing: a node a carrier holds reads the carrier, a node whose share key
 * the statement reads at least twice reads the statement's MATERIALIZED CTE, defined at its first use, and every other
 * node is the inner dispatch's. A lowering entered from outside any node (LowerContext.lower called by a statement
 * builder) is the statement's root: its CTEs are planned on entry and lead the query it returns, so each lowered member
 * carries its own WITH, which PostgreSQL evaluates once per execution of that uncorrelated query. The root lowers its
 * nodes through the dispatch of its statement's scope, so every node under it shares those CTEs.
 */
export class StatementSharing {
	readonly index: ShareIndex
	readonly #inner: NodeDispatch
	/** What each carried copy reads, by the copy's label. */
	readonly #carried = new Map<NodeId, { readonly key: string; readonly source: SharedSource }>()
	/**
	 * The CTE of the single statement that holds a call's evaluation as a part (carryEvaluation), by the call's
	 * evaluation key (lower/conservative/call evaluationKey), which every read of it in the statement's parts reads.
	 */
	readonly #evaluations = new Map<string, Extract<SharedSource, { readonly kind: "enclosing" }>>()

	/** The lowering of nodes at key sets (keyed.ts KeyedLowering), copies of one share key read once in a key set. */
	readonly #keyed: KeyedLowering
	/** What each column of a node is fixed to per evaluation, which the statements' key sets read (keys.ts FixedOf). */
	readonly #fixed: FixedOf

	constructor(index: ShareIndex, inner: NodeDispatch, keyed: KeyedRead, fixed: FixedOf) {
		this.index = index
		this.#inner = inner
		this.#keyed = new KeyedLowering(keyed, (node) => index.key(node) ?? node.id)
		this.#fixed = fixed
	}

	/** Every copy of `share` reads `source` from now on. */
	carry(share: CarriedShare, source: SharedSource): void {
		for (const copy of share.copies) {
			this.#carried.set(copy.id, { key: share.key, source })
		}
	}

	/**
	 * No copy of `shares` reads its carrier from now on: a single statement that held them as parts is built, and a
	 * statement after it, which reads a later state, lowers each copy anew (write/program/compile.ts).
	 */
	uncarry(shares: ReadonlyArray<CarriedShare>): void {
		for (const share of shares) {
			for (const copy of share.copies) {
				if (this.#carried.get(copy.id)?.key === share.key) {
					this.#carried.delete(copy.id)
				}
			}
		}
	}

	/**
	 * Every read of a field of a call of evaluation key `key` reads the CTE `source` from now on: the single statement's
	 * part that holds the call's evaluation (write/program/compile.ts), a CTE of the statement each of its parts reads.
	 */
	carryEvaluation(
		key: string,
		source: Extract<SharedSource, { readonly kind: "enclosing" }>
	): void {
		this.#evaluations.set(key, source)
	}

	/**
	 * No evaluation is carried from now on: a single statement's parts are built (write/program/compile.ts), and no
	 * statement after them reads its CTEs.
	 */
	clearEvaluations(): void {
		this.#evaluations.clear()
	}

	/**
	 * The evaluation a part of a single statement reads where the statement holds it as a part of its own
	 * (carryEvaluation), undefined for any other.
	 */
	readonly #carriedEvaluation: EvaluationLookup = (read, key, cx) => {
		const source = this.#evaluations.get(key)
		if (source === undefined) {
			return undefined
		}
		const alias = cx.relationAlias({ kind: "node", node: read.id })
		const [first, ...rest] = source.columns
		if (first === undefined) {
			throw defect("a carried evaluation's columns, one per field of its call's row")
		}
		return {
			from: [{ kind: "enclosing", name: source.name, alias }],
			attributes: [col(alias, first), ...rest.map((c) => col(alias, c))]
		}
	}

	/**
	 * The carrier source a node reads, when one holds it, in a statement filling the carrier of the share key `filling`
	 * (whose own copies are lowered, not read from the carrier) or filling none.
	 */
	#carrierIn(node: RelNode, filling: string | undefined): SharedSource | undefined {
		const entry = this.#carried.get(node.id)
		return entry === undefined || entry.key === filling ? undefined : entry.source
	}

	/**
	 * The carriers a statement rooted at `root`, filling no carrier, reads: those of the carried nodes it reaches before
	 * any other carried one.
	 */
	carriersRead(root: RelNode): ReadonlyArray<CarrierName> {
		const out = new Set<CarrierName>()
		const carrierOf = (node: RelNode) => this.#carrierIn(node, undefined)
		const own = carrierOf(root)
		if (own !== undefined) {
			return own.kind === "carrier" ? [own.carrier] : []
		}
		for (const input of reach(
			this.index,
			root,
			(n) => carrierOf(n) !== undefined,
			noneOpaque
		).flatMap((n) => this.index.inputs(n))) {
			const source = carrierOf(input)
			if (source?.kind === "carrier") {
				out.add(source.carrier)
			}
		}
		return [...out]
	}

	/** The dispatch of a statement that fills no carrier. */
	readonly dispatch: NodeDispatch = (node, cx, env) => this.#root(node, cx, env, undefined)

	/** The dispatch of the statement that fills `share`'s carrier: its own copies are lowered, not read from the carrier. */
	filling(share: CarriedShare): NodeDispatch {
		return (node, cx, env) => {
			const restriction = share.restriction
			return node === share.node && restriction.kind === "keys"
				? this.#statement(node, cx, share.key, restriction.keys, (_, scope) =>
						this.#keyed.body(node, restriction.keys, scope, (within) =>
							this.#inner(node, within, emptyEnv)
						)
					)
				: this.#root(node, cx, env, share.key)
		}
	}

	/**
	 * A node read from the carrier that holds it, or undefined when none does: a keyed read of a set, which every fill
	 * of a carrier and every share part is (write/carriers/carriers.ts memberRows), so a reader that must read a set, a
	 * call's rows argument among them, reads it as it would its copy.
	 */
	#readCarrier(
		node: RelNode,
		cx: LowerContext,
		filling: string | undefined
	): OperandSelect | undefined {
		const carrier = this.#carrierIn(node, filling)
		if (carrier === undefined) {
			return undefined
		}
		const alias = cx.relationAlias({ kind: "node", node: node.id })
		return select(
			keyedSet(
				carrier.columns.map((c) => target(col(alias, c))),
				[sourceItem(carrier, alias)],
				undefined,
				"a carried sub-query's rows"
			)
		)
	}

	/** The root of a statement: its CTEs planned, and the node lowered in the statement's scope. */
	#root(node: RelNode, cx: LowerContext, env: Env, filling: string | undefined): OperandSelect {
		const carried = this.#readCarrier(node, cx, filling)
		if (carried !== undefined) {
			return carried
		}
		return this.#statement(node, cx, filling, wholeKeys, (root, scope) =>
			this.#shared(node, root, env, scope)
		)
	}

	/**
	 * The evaluation of the call `read` reads, a statement rooted at the read (lower/conservative/call evaluationQuery):
	 * every argument of the call lowered in that one statement's scope, so a sub-query two arguments read, a copy in each,
	 * is one MATERIALIZED CTE of the evaluation's WITH (statementCtes, over the call's every argument), where each
	 * argument was a statement of its own and computed its copy again. A copy a carrier holds is read from it.
	 */
	evaluation(read: NodeOf<"Call">, cx: LowerContext): Select {
		return this.#statement(read, cx, undefined, wholeKeys, (root) =>
			evaluationQuery(read, root, emptyEnv)
		)
	}

	/**
	 * The query `lower` builds of the statement rooted at `node`, in the statement's scope: the copies of each share key
	 * the statement reads at least twice planned as its MATERIALIZED CTEs (statementCtes), which lead the query, every
	 * node under it lowered through that scope (a carried node read from its carrier, one the statement shares from its
	 * CTE), and the evaluations of the calls it reads hosted in its WITH or read where a part carries them.
	 */
	#statement<Q extends OperandSelect>(
		node: RelNode,
		cx: LowerContext,
		filling: string | undefined,
		rootKeys: KeyRestriction,
		lower: (root: LowerContext, scope: StatementScope) => Q
	): Q {
		const carried = (n: RelNode): boolean => this.#carrierIn(n, filling) !== undefined
		const materialize = statementCtes(this.index, node, carried)
		/**
		 * A node a restriction reaches (keyed.ts restrictionWalk) is lowered where it is read, at the values, never read
		 * from its carrier or its CTE, whose rows are its whole.
		 */
		const inScope: NodeDispatch = (n, ncx, nenv) =>
			nenv.restricted.has(n)
				? this.#inner(n, ncx, nenv)
				: (this.#readCarrier(n, ncx, filling) ?? this.#inPlace(n, ncx, nenv, scope))
		const root = cx.withDispatch(inScope)
		const ctes = new Set<Cte>()
		const statement = root
			.withEvaluations(statementEvaluations(ctes, root))
			.withEvaluations(this.#carriedEvaluation)
		const scope: StatementScope = {
			ctes,
			defined: new Map(),
			materialize,
			...statementKeys(
				this.index,
				node,
				rootKeys,
				reach(this.index, node, carried, noneOpaque),
				materialize,
				this.#fixed
			),
			keySets: new Map(),
			statement,
			lookups: new Lookups((n) => carried(n) || materialize.get(n.id) !== undefined)
		}
		return withLeading(lower(statement, scope), scope.ctes)
	}

	/**
	 * A node the statement lowers: a union or a fold its reads restrict (StatementScope inline) at its keys, each arm at
	 * them or the keys below its aggregate (#atKeys), where computed whole it would read every row, PostgreSQL moving no
	 * restriction into an arm or below a grouping; any other node as the statement shares it.
	 */
	#inPlace(node: RelNode, cx: LowerContext, env: Env, scope: StatementScope): OperandSelect {
		const keys = scope.inline.get(node)
		return keys !== undefined && readAtKeys(node) && scope.materialize.get(node.id) === undefined
			? this.#keyed.atKeys(node, keys, cx, env, scope)
			: this.#shared(node, cx, env, scope)
	}

	#shared(node: RelNode, cx: LowerContext, env: Env, scope: StatementScope): OperandSelect {
		const key = scope.materialize.get(node.id)
		if (key === undefined || cx.readsFeedback(node)) {
			return this.#inner(node, cx, env)
		}
		const keys = scope.keyed.get(key)
		return cteAtFirstUse(cx, node, scope, key, "MATERIALIZED", () =>
			keys === undefined
				? this.#inner(node, scope.statement, emptyEnv)
				: this.#keyed.body(node, keys, scope, (within) => this.#inner(node, within, emptyEnv))
		)
	}
}
