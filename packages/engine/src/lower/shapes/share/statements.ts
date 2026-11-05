import { analyzeDemand, type DemandAnalysis, noPins } from "#compiler/analysis/demand/demand.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { extendNonEmpty, isNonEmpty } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import { type NodeScope, nodeScopes, topoOrder } from "#compiler/ir/dag.ts"
import { Fold } from "#compiler/ir/fold.ts"
import { edgesOf, inputsOf, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import {
	type Env,
	emptyEnv,
	type LowerContext,
	type NodeDispatch,
	outputNames
} from "#compiler/lower/conservative/context.ts"
import { costClass } from "#compiler/lower/optimize/cte-policy/index.ts"
import {
	feedbackReadsOf,
	nodeGraph,
	readsOutside,
	subtreeOf
} from "#compiler/lower/optimize/demand/editor.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import type { Cte, Select } from "#compiler/sql/ast.ts"
import { col, core, cteRefAs, select, target } from "#compiler/sql/build.ts"
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
 * its own copy in the DAG, so two copies share no node id; they share a share key (index.ts shareKey), the semantic
 * digest of the sub-DAG they reach, which is equal exactly when they compute the same set under the same parameter
 * bindings.
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
 * Both placements share only what the CTE policy would share: an expensive node (cte-policy costClass), uncorrelated,
 * off every recursion's feedback, read laterally by no expression, so that its rows are a set the statement can read
 * under any alias. A node that only scans, filters and projects one source, or joins sources, is left inline at each
 * use (cte-policy rules 4 and 6). The rows a carrier or a CTE holds are exactly the rows the copy's lowering delivers,
 * repeats included where the placement realized it plain, so every reader sees what its inline copy would deliver.
 */
export class ShareIndex {
	readonly dag: ValidDag
	readonly #demand: DemandAnalysis
	readonly #feedback: ReadonlySet<RelNode>
	readonly #scopes: Fold<RelNode, NodeScope>
	/** Each node's share key or its absence, by label, computed on its first read. */
	readonly #keys = new Map<NodeId, { readonly key: string | undefined }>()
	/** The longest path from each node to a leaf, folded from its inputs'. */
	readonly #heights = new Fold<RelNode, number>(function* (node) {
		let h = 0
		for (const input of inputsOf(node)) {
			const below: number = yield input
			h = Math.max(h, below + 1)
		}
		return h
	})

	constructor(dag: ValidDag) {
		this.dag = dag
		this.#demand = analyzeDemand(dag, noPins)
		this.#feedback = feedbackReadsOf(nodeGraph, topoOrder(dag))
		this.#scopes = nodeScopes(dag)
	}

	/** The node's inputs, once per reference: a region that matches one input twice lowers it twice. */
	inputs(node: RelNode): ReadonlyArray<RelNode> {
		return edgesOf(node)
	}

	/** The longest path from the node to a leaf: a copy's sub-queries are lower than it, and copies are equally high. */
	height(node: RelNode): number {
		return this.#heights.of(node)
	}

	/**
	 * The node's share key when it may be shared: expensive under the CTE policy's cost classes, uncorrelated, without
	 * free variables, read laterally by no expression and off every recursion's feedback (cte-policy rules 3 to 6).
	 */
	key(node: RelNode): string | undefined {
		const known = this.#keys.get(node.id)
		if (known !== undefined) {
			return known.key
		}
		const eligible =
			node.kind !== "Recursive" &&
			node.kind !== "SelfRef" &&
			this.#scopes.of(node).freeVars.length === 0 &&
			!this.#demand.lateral(node) &&
			!this.#feedback.has(node) &&
			!readsOutside(nodeGraph, subtreeOf(nodeGraph, node)) &&
			costClass(node) === "expensive"
		const key = eligible ? this.#shareKey(node) : undefined
		this.#keys.set(node.id, { key })
		return key
	}

	/** The share key of an eligible node; a DAG it cannot key is refused. */
	#shareKey(node: RelNode): string {
		const key = shareKey(this.dag, node)
		if (!key.ok) {
			throw new Refusal(key.error)
		}
		return key.value
	}
}

/**
 * A sub-query carried across the statements of one stratum: its copies, all of one share key, and the copy the
 * carrier's fill evaluates.
 */
export interface CarriedShare {
	readonly key: string
	readonly node: RelNode
	readonly copies: ReadonlyArray<RelNode>
}

/** The nodes a statement rooted at `root` lowers, each once, without entering a node `stop` names. */
const reach = (
	index: ShareIndex,
	root: RelNode,
	stop: (node: RelNode) => boolean
): ReadonlyArray<RelNode> => {
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const node of queue) {
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
 * The sub-queries more than one of `roots` reads, each statement rooted at one root, to carry across them.
 * The highest shared sub-query is chosen first; a sub-query inside it is then read by the carrier's fill instead of by
 * the statements, and is carried too only when enough statements, that fill among them, still read it. The result is
 * in fill order: a carried sub-query before every carried sub-query that reads it.
 *
 * Every copy of each carried key the statements and the fills reach; filled lowest first.
 */
export const planStatementShares = (
	index: ShareIndex,
	roots: ReadonlyArray<RelNode>
): Result.Result<ReadonlyArray<CarriedShare>, CompileError> =>
	catchRefusal(() => {
		const chosen: Array<CarriedShare> = []
		const carriedKeys = new Set<string>()
		const copiesOf = new Map<string, Array<RelNode>>()
		/** Whether a node is a copy of a carried sub-query, which its carrier's reader reads instead. */
		const stop = (node: RelNode): boolean => {
			const key = index.key(node)
			return key !== undefined && carriedKeys.has(key)
		}
		for (;;) {
			/** The statements: the roots, then each chosen fill, which lowers its own copy of the share `own` names. */
			const units: ReadonlyArray<{ readonly root: RelNode; readonly own: string | undefined }> = [
				...roots.map((root) => ({ root, own: undefined })),
				...chosen.map((c) => ({ root: c.node, own: c.key }))
			]
			const statementsOf = new Map<string, Set<number>>()
			for (const [u, unit] of units.entries()) {
				const nodes =
					unit.own === undefined && stop(unit.root) ? [] : reach(index, unit.root, (n) => stop(n))
				for (const node of nodes) {
					const key = index.key(node)
					if (key === undefined || carriedKeys.has(key) || node.heading.length === 0) {
						continue
					}
					const set = statementsOf.get(key) ?? new Set<number>()
					set.add(u)
					statementsOf.set(key, set)
					const copies = copiesOf.get(key) ?? []
					if (!copies.includes(node)) {
						copies.push(node)
					}
					copiesOf.set(key, copies)
				}
			}
			/** The highest key enough statements read, the least key among equals. */
			let best:
				| { readonly key: string; readonly node: RelNode; readonly height: number }
				| undefined
			for (const [key, statements] of statementsOf) {
				const [node] = copiesOf.get(key) ?? []
				if (statements.size < 2 || node === undefined) {
					continue
				}
				const height = index.height(node)
				if (
					best === undefined ||
					height > best.height ||
					(height === best.height && key < best.key)
				) {
					best = { key, node, height }
				}
			}
			if (best === undefined) {
				break
			}
			carriedKeys.add(best.key)
			chosen.push({ key: best.key, node: best.node, copies: [] })
		}
		return chosen
			.map((c) => ({ ...c, copies: [...(copiesOf.get(c.key) ?? [])] }))
			.toSorted((a, b) => index.height(a.node) - index.height(b.node))
	})

/**
 * How many times the statement rooted at `root` lowers each share key, every use of a node lowered anew: a copy under
 * a chosen CTE is lowered once, in the CTE's body, by its first copy in `order`.
 */
const occurrencesByKey = (
	index: ShareIndex,
	root: RelNode,
	order: ReadonlyArray<RelNode>,
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
		const key = index.key(node)
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
 * entering a node `carried` names (the statement reads its carrier). Occurrences are counted in the statement as it is
 * lowered, every use of a node lowered anew: a copy under a CTE already chosen is lowered once, in the CTE's body. The
 * highest such sub-query is chosen first (cte-policy rule 5: a shared expensive node is MATERIALIZED).
 */
export const statementCtes = (
	index: ShareIndex,
	root: RelNode,
	carried: (node: RelNode) => boolean
): ReadonlySet<string> => {
	const nodes = reach(index, root, carried)
	/** Parents before children: by decreasing height, a node's inputs being strictly lower. */
	const order = [...nodes].toSorted((a, b) => index.height(b) - index.height(a))
	const chosen = new Set<string>()
	for (;;) {
		const byKey = occurrencesByKey(index, root, order, chosen, carried)
		/** The highest key read often enough, the least key among equals. */
		let best: { readonly key: string; readonly height: number } | undefined
		for (const node of order) {
			const key = index.key(node)
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
			return chosen
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

interface StatementScope {
	readonly ctes: Set<Cte>
	readonly defined: Map<string, { readonly name: string; readonly columns: ReadonlyArray<string> }>
	readonly materialize: ReadonlySet<string>
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

	constructor(index: ShareIndex, inner: NodeDispatch) {
		this.index = index
		this.#inner = inner
	}

	/** Every copy of `share` reads `source` from now on. */
	carry(share: CarriedShare, source: SharedSource): void {
		for (const copy of share.copies) {
			this.#carried.set(copy.id, { key: share.key, source })
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
		for (const input of reach(this.index, root, (n) => carrierOf(n) !== undefined).flatMap((n) =>
			this.index.inputs(n)
		)) {
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
		return (node, cx, env) => this.#root(node, cx, env, share.key)
	}

	/** A node read from the carrier that holds it, or undefined when none does. */
	#readCarrier(node: RelNode, cx: LowerContext, filling: string | undefined): Select | undefined {
		const carrier = this.#carrierIn(node, filling)
		if (carrier === undefined) {
			return undefined
		}
		const alias = cx.relationAlias({ kind: "node", node: node.id })
		return select(
			core(
				carrier.columns.map((c) => target(col(alias, c))),
				[
					carrier.kind === "carrier"
						? { kind: "table", table: carrier.carrier, alias }
						: { kind: "enclosing", name: carrier.name, alias }
				],
				undefined
			)
		)
	}

	/** The root of a statement: its CTEs planned, and the node lowered in the statement's scope. */
	#root(node: RelNode, cx: LowerContext, env: Env, filling: string | undefined): Select {
		const carried = this.#readCarrier(node, cx, filling)
		if (carried !== undefined) {
			return carried
		}
		const scope: StatementScope = {
			ctes: new Set(),
			defined: new Map(),
			materialize: statementCtes(this.index, node, (n) => this.#carrierIn(n, filling) !== undefined)
		}
		const inScope: NodeDispatch = (n, ncx, nenv) =>
			this.#readCarrier(n, ncx, filling) ?? this.#shared(n, ncx, nenv, scope)
		const query = this.#shared(node, cx.withDispatch(inScope), env, scope)
		const scoped = [...scope.ctes]
		if (!isNonEmpty(scoped)) {
			return query
		}
		return {
			...query,
			with:
				query.with === undefined
					? { ctes: scoped, recursive: false }
					: { ...query.with, ctes: extendNonEmpty(scoped, query.with.ctes) }
		}
	}

	#shared(node: RelNode, cx: LowerContext, env: Env, scope: StatementScope): Select {
		const key = scope.materialize.size === 0 ? undefined : this.index.key(node)
		if (key === undefined || !scope.materialize.has(key) || cx.readsFeedback(node)) {
			return this.#inner(node, cx, env)
		}
		const origin = { kind: "node", node: node.id } as const
		let defined = scope.defined.get(key)
		if (defined === undefined) {
			const query = this.#inner(node, cx, emptyEnv)
			const name = cx.relationAlias(origin)
			const columns = cx.supply.columns(outputNames(node.heading).map(() => origin))
			scope.ctes.add({ name, columns, materialized: "MATERIALIZED", query })
			defined = { name, columns }
			scope.defined.set(key, defined)
		}
		const alias = cx.relationAlias(origin)
		return select(
			core(
				defined.columns.map((c) => target(col(alias, c))),
				[cteRefAs(defined.name, alias)],
				undefined
			)
		)
	}
}
