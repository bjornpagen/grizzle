import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	concatNonEmpty,
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { searchInRows } from "#compiler/check/approximate/attach.ts"
import { canonicalEquals, unwrap } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import {
	type CompletedOrder,
	type Heading,
	inputsOf,
	type NodeOf,
	type RelKind,
	type RelNode,
	soleOrder
} from "#compiler/ir/rel.ts"
import { withAdmission } from "#compiler/lower/conservative/admission.ts"
import { lowerAntiJoinAt } from "#compiler/lower/conservative/anti-join/index.ts"
import { parentEvaluations, statementEvaluations } from "#compiler/lower/conservative/call/index.ts"
import {
	type Carrying,
	cteAtFirstUse,
	type CteTable,
	emptyEnv,
	type Env,
	envOf,
	type EvaluationHolding,
	type EvaluationLookup,
	freshCtes,
	headingTargets,
	type LowerContext,
	type NodeDispatch,
	nodeLabel,
	type NodeLowerer,
	refuse,
	restrictedRead,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import {
	checkedAttachment,
	Delivery,
	groupOrder,
	groupTake,
	type HeterogeneousPlan,
	headingGroupsDelivery,
	parentColumnsOf,
	type ParentRows,
	deliveredStatement,
	statementRows
} from "#compiler/lower/conservative/deliver.ts"
import { conservativeLowerers } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { bindLaterally } from "#compiler/lower/conservative/expr/lateral.ts"
import {
	keySetOf,
	type ParentFixed,
	parentFixed,
	type RowKeys
} from "#compiler/lower/conservative/keys.ts"
import { lowerSemiJoinAt } from "#compiler/lower/conservative/semi-join/index.ts"
import { orderItemsOf } from "#compiler/lower/conservative/take/order.ts"
import {
	type ConservativeParamSlot,
	type ConservativeProgram,
	type ConservativeStatement,
	type DeclaredParamSlot,
	flight,
	type PageParamSlot,
	type ProgramDelivery
} from "#compiler/lower/conservative/types.ts"
import {
	type CteDecision,
	type CtePlan,
	type CteStrategy,
	filteredRegion,
	semiJoinDriven
} from "#compiler/lower/optimize/cte-policy/index.ts"
import { partQuery, shiftedPart, type TaggedPart, taggedParts } from "#compiler/lower/parts.ts"
import { aggregateLowerer, keyedGroup } from "#compiler/lower/shapes/aggregate/index.ts"
import { seededAttachment } from "#compiler/lower/shapes/attach-recursive/index.ts"
import {
	fusedLayout,
	type PipelinedAttachment,
	pipelinedAttachment,
	withFusedAttachments
} from "#compiler/lower/shapes/attach/index.ts"
import { catalogLowerers } from "#compiler/lower/shapes/catalog/native.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import { refineDelivered } from "#compiler/lower/shapes/refined/index.ts"
import { regionLowerer } from "#compiler/lower/shapes/region/index.ts"
import { inputSetLowerer } from "#compiler/lower/shapes/relparam/index.ts"
import { searchFenced } from "#compiler/lower/shapes/search/index.ts"
import { atRowWalk, drivenSemiJoin } from "#compiler/lower/shapes/semi-join/index.ts"
import type { DrivingSet } from "#compiler/lower/shapes/share/copies.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import {
	type Carrier,
	KeyedLowering,
	type KeyScope,
	type StatementKeys
} from "#compiler/lower/shapes/share/keyed.ts"
import { type Keys, Lookups, readAtKeys } from "#compiler/lower/shapes/share/keys.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { producerLowerer } from "#compiler/lower/shapes/spans/index.ts"
import { takeShape } from "#compiler/lower/shapes/take/index.ts"
import { type DeliveryOrder, deliveryOrder } from "#compiler/lower/shapes/take/order.ts"
import { groupRows, keyedUnion, unionLowerer } from "#compiler/lower/shapes/union/index.ts"
import { approximateLowerer } from "#compiler/lower/shapes/vector/index.ts"
import { collatedRows, executableQuery, executableQueryFrom } from "#compiler/lower/template.ts"
import type { FusedAttachment } from "#compiler/runtime/lower/fused.ts"
import {
	type AttachedTree,
	deliveredHeading,
	mapTree,
	type RowsRole,
	type StatementRole,
	statementOutput,
	type StatementRoots,
	type StatementTree
} from "#compiler/runtime/lower/tree.ts"
import {
	type Cte,
	type EmittedSql,
	isSetQuery,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type Select,
	type SelectCore,
	type StatementText,
	type UnprintedSql
} from "#compiler/sql/ast.ts"
import {
	and,
	col,
	cteRead,
	type DefinedCte,
	derived,
	keyedSet,
	select,
	target
} from "#compiler/sql/build.ts"
import {
	costChosen,
	type Emitting,
	emitText,
	type TextOf,
	unprintedText
} from "#compiler/sql/emit.ts"
import {
	freshNames,
	namedQuery,
	type NameMap,
	type NameOrigin,
	namesPast,
	NameSupply
} from "#compiler/sql/naming.ts"
import { seekingSuffixes } from "#compiler/sql/suffix.ts"

/**
 * A statement as its relations' indexes read it: each suffix test of a text a B-tree holds the suffix key of read as
 * that key's range (sql/suffix.ts seekingSuffixes).
 */
const readByItsIndexes = (query: Select, names: Pick<PhysicalNames, "suffixed">): Select =>
	seekingSuffixes(query, names.suffixed)

/**
 * A statement of an optimized delivery as the conservative statement shape, with the attachments fused into it as
 * output columns after the heading, in order: the statement a page's conservative artifact places, and what a
 * statement of a conservative program fuses (none).
 */
export type FusedStatement<
	Slot extends ConservativeParamSlot = DeclaredParamSlot,
	T extends StatementText = EmittedSql
> = ConservativeStatement<Slot, T> & {
	readonly fused: ReadonlyArray<FusedAttachment>
}

/**
 * A delivered relation of a program, as the runtime reads it: its role (an attachment's with its parent key), the
 * heading of the relation, its fused attachments, and `answer`, the position of its rows among the runs of the
 * program's answer, its part's tag (StatementParts).
 */
export interface DeliveredPart {
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<FusedAttachment>
	readonly answer: number
}

/**
 * A part of a statement of tagged parts as its lowering built it: how the host reads its rows (lower/parts.ts
 * TaggedPart), and `delivered`, the query whose rows it delivers as lowered, before its executable form casts its
 * outputs to texts and the statement tags them: a query of its own, its WITH each CTE of the statement it may read, its
 * operands not yet bound laterally (lower/conservative/expr/lateral.ts bindLaterally), which moves a binding into its
 * core's FROM and changes no column's type. The type oracle describes it as it describes a statement of one part.
 */
export interface LoweredTaggedPart extends TaggedPart {
	readonly delivered: Select
}

/**
 * How the rows of a program's statement divide into its parts: all of them its one part's, the statement its part
 * delivers as lowered (`delivered`, which an embedding reads, before its executable form casts its outputs to text);
 * or each behind its tag, the part's position in part order, each as lowered (LoweredTaggedPart).
 */
export type StatementParts<Slot extends ConservativeParamSlot = DeclaredParamSlot> =
	| { readonly kind: "one"; readonly delivered: FusedStatement<Slot, UnprintedSql> }
	| { readonly kind: "tagged"; readonly parts: NonEmptyReadonlyArray<LoweredTaggedPart> }

/**
 * One form of the statement a program sends: its executable AST, its text, none where another statement composes it
 * (UnprintedSql), and its placeholders.
 */
export interface SentStatement<
	Slot extends ConservativeParamSlot = DeclaredParamSlot,
	T extends StatementText = EmittedSql
> {
	readonly ast: Select
	readonly sql: T
	readonly params: ReadonlyArray<Slot>
}

/**
 * The one statement a program sends, how its rows divide into parts, and each part's delivered relation, in their
 * tree, in part order.
 */
export interface PartedStatement<
	Slot extends ConservativeParamSlot = DeclaredParamSlot,
	T extends StatementText = EmittedSql
> {
	readonly statement: SentStatement<Slot, T>
	readonly parts: StatementParts<Slot>
	readonly roots: StatementRoots<DeliveredPart>
}

/** An optimized delivery's program: its parted statement, and how the runtime delivers its parts' rows. */
export interface OptimizedDeliveryProgram<
	Slot extends ConservativeParamSlot = DeclaredParamSlot,
	T extends StatementText = EmittedSql
> extends PartedStatement<Slot, T> {
	readonly delivery: ProgramDelivery
}

/**
 * A statement lowered composed (UnprintedSql), printed under `binding` (sql/emit.ts emitText), as the lowering that
 * prints prints it: what a program kept across the transactions that send it is sent as by one of them.
 */
export const sentStatement = <Slot extends ConservativeParamSlot>(
	statement: SentStatement<Slot, UnprintedSql>,
	binding: Emitting
): SentStatement<Slot> => ({
	ast: statement.ast,
	sql: emitText(statement.ast, statement.sql.nameMap, binding),
	params: statement.params
})

/**
 * A conservative program's statements as the parts of one statement, as the runtime runs an optimized program's: the
 * oracles' baseline. A program of one statement sends that statement's executable query; one of several sends each as
 * a part (lower/parts.ts), its executable query a CTE whose rows the statement delivers behind its tag, its
 * placeholders renumbered past the earlier statements' (shiftedPart). Each part still computes its parent key's set
 * itself and reads nothing of another part. Its lowering named each statement past the one before
 * (conservative/context.ts beginStatement), so no name is defined twice in it, and the parts' CTEs name past them all.
 */
export const partedConservative = <Slot extends ConservativeParamSlot>(
	roots: StatementRoots<ConservativeStatement<Slot>>
): PartedStatement<Slot> => {
	const parts = mapTree(roots, (s, answer): DeliveredPart => ({
		role: s.role,
		heading: s.heading,
		fused: [],
		answer
	}))
	const [only, ...others] = flight(roots)
	if (!isNonEmpty(others)) {
		const delivered: FusedStatement<Slot> = { ...only, fused: [] }
		const ast = executableQuery(delivered)
		return {
			statement: {
				ast,
				sql: emitText(ast, only.sql.nameMap, costChosen()),
				params: only.params
			},
			parts: { kind: "one", delivered },
			roots: parts
		}
	}
	const statements: NonEmptyReadonlyArray<ConservativeStatement<Slot>> = [only, ...others]
	const supply = new NameSupply(
		statements.reduce((start, s) => namesPast(s.sql.nameMap, start), freshNames)
	)
	const params: Array<Slot> = []
	const names: Array<NameMap[number]> = []
	const tagged = mapNonEmpty(statements, (s) => {
		const shift = shiftedPart(s.ast, s.params, params.length)
		appendAll(params, shift.params)
		appendAll(names, s.sql.nameMap)
		const executable = executableQueryFrom(
			{ ast: shift.query, role: s.role, heading: s.heading, fused: [] },
			supply
		)
		const { query, columns, shape } = partQuery(executable, supply)
		const name = supply.relation({ kind: "internal", purpose: "statement part" })
		return {
			cte: { name, materialized: undefined, query: query },
			columns,
			shape: { ...shape, delivered: shift.query }
		}
	})
	const { body } = taggedParts(
		mapNonEmpty(tagged, (p) => ({ name: p.cte.name, columns: p.columns })),
		0
	)
	const ast: Select = {
		...select(body),
		with: { recursive: false, ctes: mapNonEmpty(tagged, (p) => p.cte) }
	}
	return {
		statement: {
			ast,
			sql: emitText(ast, [...names, ...supply.map()], costChosen()),
			params
		},
		parts: { kind: "tagged", parts: mapNonEmpty(tagged, (p) => p.shape) },
		roots: parts
	}
}

/** A conservative program as one statement of parts (partedConservative), delivered as the program delivers. */
export const conservativeStatement = <Slot extends ConservativeParamSlot>(
	program: ConservativeProgram<Slot>
): OptimizedDeliveryProgram<Slot> => ({
	...partedConservative(program.roots),
	delivery: program.delivery
})

/**
 * The CTEs one statement defined while it was lowered: its WITH entries, and each shared node's CTE, by the label of its
 * class of copies' first node (cte-policy CteDecision `copies`), so every copy reads one CTE.
 */
type CteLog = CteTable<NodeId>

/**
 * The CTEs a holder's query holds while it is lowered (ShapeLog `heldCtes`), and the scope the holder is lowered in,
 * which each body is lowered in: a body stands in the holder's WITH, where no row read inside the holder is in scope.
 */
interface HeldCtes {
	readonly table: CteLog
	readonly env: Env
}

/**
 * What the lowerers of one optimized delivery read and record of its state: the CTE plan's strategy for a node, and the
 * CTEs the statement being lowered defined.
 */
export interface ShapeLog {
	readonly log: CteLog
	strategy(node: RelNode): CteStrategy | undefined
	/** The policy's decision for a node it shares: its strategy and where its CTE stands (cte-policy CteDecision). */
	decision(node: RelNode): CteDecision | undefined
	/**
	 * The CTEs `holder`'s query holds while it is lowered (cte-policy `sharedCorrelated`): a region's SELECT or a call's
	 * evaluation's query, its table made where the holder's lowering begins and read off where it ends; none for a holder
	 * no shared node's CTE stands in.
	 */
	heldCtes(holder: NodeId): HeldCtes | undefined
	/** `lower`'s query of `holder`, lowered in the scope `env`, with the CTEs it holds leading its WITH (ShapeState). */
	withHeldCtes<Q extends OperandSelect>(holder: NodeId, env: Env, lower: () => Q): Q
	/** The key sets the statement computes its nodes at (share/keyed.ts StatementKeys). */
	readonly keys: StatementKeys
	/**
	 * Where the statement being lowered holds its key sets: its WITH, and each key set's CTE once defined, lowered in
	 * `statement`, the statement's own scope.
	 */
	keyScope(statement: LowerContext): KeyScope
	/** Each driving set's evaluation of its copies in the statement being lowered (share/keyed.ts Carrier). */
	readonly carriers: Map<DrivingSet, Carrier>
}

/**
 * The mutable state of one optimized delivery: the CTE plan, and the statement being lowered.
 *
 * The optimized lowering's kind table and statement delivery.
 *
 * The kind table is written once and imports every shape plug-in from its fixed directory. Its type is a mapped type
 * over the closed kind union, so a kind added to the IR fails to typecheck here until it has a plug-in, as the
 * conservative table does (lower/conservative/dispatch.ts).
 *
 * Every node is lowered under the duplicate-elimination placement (lower/optimize/dedup), read through ShapeFacts
 * (shapes/share/physical.ts), never through logical keys or node kinds:
 *
 * - the sources, filters, projections, regions, existence tests and feedback scans are the conservative plug-ins with
 *   their outermost SELECT DISTINCT dropped where the placement realized the node `plain`; a semi-join over the
 *   feedback of a recursion keeps it, because there its DISTINCT is the semi-join's own set semantics
 *   (lower/conservative/semi-join/exists.ts); a region past PostgreSQL's collapse limit is the conservative region's
 *   parts as an explicit JOIN chain in an evidence-chosen order, so its planning stays bounded (region/);
 * - Union, Take, Group and InputSet are the set-boundary shapes (union, take in its one probe form, R20, aggregate
 *   with R24, relparam), each discharging its own input's obligation unless the facts prove it unique;
 * - Window and OrderedSetAggregate are the compile-target catalog's native targets (shapes/catalog);
 * - Intersect and Difference keep their set forms and Recursive its recursive UNION (dedup/policy.ts pins them);
 * - an attachment, an ordered result and a law lower as the rows they deliver.
 *
 * A node the CTE policy shares (lower/optimize/cte-policy) is spelled once per statement as a WITH entry,
 * MATERIALIZED or NOT MATERIALIZED as the policy decided, and every use reads it under a fresh alias; every other node
 * is inlined at each use.
 *
 * The delivery lowers a query's program as one statement of parts: the main rows, or one part per heading group of a
 * heterogeneous union delivered to the host (R21), and the attachments, fused into their parent's part as
 * ARRAY(SELECT ...) where the R36 rule selects it and otherwise parts of their own, over their parent's rows the
 * statement holds once (OptimizedDelivery rowsPart).
 */
export class ShapeState implements ShapeLog {
	readonly cte: CtePlan
	readonly keys: StatementKeys
	#log: CteLog = freshCtes()
	/** Each key set's CTE in the statement being lowered (share/keyed.ts KeyScope). */
	#keySets = new Map<Keys, DefinedCte>()
	/** Each driving set's evaluation of its copies in the statement being lowered (share/keyed.ts KeyScope). */
	#carriers = new Map<DrivingSet, Carrier>()
	/** The holders whose query holds a CTE (cte-policy `sharedCorrelated`): regions and calls' evaluations. */
	readonly #holding: ReadonlySet<NodeId>
	/** The CTEs of each holder being lowered, by the holder (`withHeldCtes`). */
	readonly #held = new Map<NodeId, HeldCtes>()

	/** A state whose nodes are shared by `cte` and computed at `keys`. */
	constructor(cte: CtePlan, keys: StatementKeys) {
		this.cte = cte
		this.keys = keys
		this.#holding = new Set(
			Object.values(cte.decisions).flatMap((d) => (d.scope.kind === "held" ? [d.scope.holder] : []))
		)
	}

	/** The next statement, with a fresh log. */
	begin(): void {
		this.#log = freshCtes()
		this.#keySets = new Map()
		this.#carriers = new Map()
	}

	get log(): CteLog {
		return this.#log
	}

	/** The statement's WITH entries, and a fresh log for the next statement. */
	drain(): CteLog {
		const log = this.#log
		this.#log = freshCtes()
		this.#keySets = new Map()
		this.#carriers = new Map()
		return log
	}

	get carriers(): Map<DrivingSet, Carrier> {
		return this.#carriers
	}

	keyScope(statement: LowerContext): KeyScope {
		return {
			ctes: this.#log.ctes,
			keySets: this.#keySets,
			statement,
			lookups: this.#lookups
		}
	}

	/**
	 * Which nodes the statement reads by an index lookup at keys (share/keys.ts Lookups): none the policy computes in the
	 * statement's WITH, a CTE read where it stands.
	 */
	readonly #lookups = new Lookups((node) => {
		const decision = this.cte.decisions[node.id]
		return (
			decision?.scope.kind === "statement" &&
			!this.keys.atValues.has(node.id) &&
			cteMaterialization(decision.strategy) !== undefined
		)
	})

	strategy(node: RelNode): CteStrategy | undefined {
		return this.cte.decisions[node.id]?.strategy
	}

	decision(node: RelNode): CteDecision | undefined {
		return this.cte.decisions[node.id]
	}

	heldCtes(holder: NodeId): HeldCtes | undefined {
		return this.#held.get(holder)
	}

	/**
	 * A call's evaluation's query with the CTEs its evaluation holds leading its WITH (cte-policy CtePlan `evaluations`),
	 * or as it is where it holds none.
	 */
	readonly evaluationHolding: EvaluationHolding = (call, env, build) => {
		const holder = this.cte.evaluations[call.id]
		return holder === undefined ? build() : this.withHeldCtes(holder, env, build)
	}

	/**
	 * `lower`'s query of `holder`, a region's SELECT or a call's evaluation's query, with the CTEs it holds (cte-policy
	 * `sharedCorrelated`) leading its WITH, each defined at its first read inside it: a fresh table for the holder while
	 * it is lowered, so a holder lowered again, in another statement or another mode, defines its CTEs again.
	 */
	withHeldCtes<Q extends OperandSelect>(holder: NodeId, env: Env, lower: () => Q): Q {
		if (!this.#holding.has(holder) || this.#held.has(holder)) {
			return lower()
		}
		const table: CteLog = freshCtes()
		this.#held.set(holder, { table, env })
		const query = lower()
		this.#held.delete(holder)
		return withLeading(query, table.ctes)
	}
}

/**
 * A query without its outermost set boundary: the plain realization of a conservative plug-in whose query is a SELECT
 * DISTINCT or a set of facts (ir/compare.ts factSet, grouped by its targets and its floats' signs alone), under the
 * proof the physical analysis made of it (`certified`), as its sets' facts read through every column (`keyed`), or an
 * operand where it made neither and the node's consumers make its rows a set. A set operation, DISTINCT ON, or a query of neither boundary is returned unchanged.
 */
export const withoutBoundary = (
	query: OperandSelect,
	rows: "certified" | "keyed" | "operand"
): OperandSelect => {
	const body = query.body
	if (body.kind !== "core" || !boundaryCore(body)) {
		return query
	}
	return {
		...query,
		body:
			rows === "operand"
				? { ...body, distinct: false, groupBy: [], rows }
				: { ...body, distinct: false, groupBy: [], rows }
	}
}

/** Whether a core is a set boundary over its rows: SELECT DISTINCT, or a set of facts (ir/compare.ts factSet). */
const boundaryCore = (body: SelectCore): boolean =>
	body.distinct === true || (body.distinct === false && body.rows === "facts")

/**
 * Whether a query's outermost form eliminates repeats exactly: SELECT DISTINCT, a set of facts, UNION, INTERSECT,
 * EXCEPT, or a recursive CTE under UNION.
 */
const exactBody = (body: OperandBody): boolean =>
	(body.kind === "core" && boundaryCore(body)) ||
	(body.kind === "setOp" && body.op !== "UNION ALL") ||
	(body.kind === "select" && exactBody(body.body))

/**
 * A query with an exact set boundary: unchanged when its outermost form already eliminates repeats, otherwise read as
 * a derived table under SELECT DISTINCT.
 */
export const withBoundary = (cx: LowerContext, node: RelNode, query: OperandSelect): Select => {
	if ((exactBody(query.body) || query.with?.recursive === true) && isSetQuery(query)) {
		return query
	}
	const source = cx.wrap(query, node.heading, { kind: "node", node: node.id })
	return select(cx.setOf(node, headingTargets(node.heading, source.map), [source.item], undefined))
}

/**
 * What a plain realization's rows are: proved unique (certified); its sources' facts read through every column, a set
 * of facts by their identity, -0 and +0 apart, as each source's is (keyed, ShapeFacts distinctFacts); or rows that may
 * repeat (an operand).
 */
const plainRows = (facts: ShapeFacts, node: RelNode): "certified" | "keyed" | "operand" =>
	facts.unique(node) !== undefined ? "certified" : facts.distinctFacts(node) ? "keyed" : "operand"

/** A conservative plug-in realized as the placement decided. */
const realized =
	<K extends RelKind>(facts: ShapeFacts, lower: NodeLowerer<K>): NodeLowerer<K> =>
	(node, cx, env) => {
		const query = lower(node, cx, env)
		return facts.realization(node) === "plain"
			? withoutBoundary(query, plainRows(facts, node))
			: withBoundary(cx, node, query)
	}

/**
 * A plug-in that lowers a node as the rows it delivers (an attachment, an ordered result, a law): its input's query,
 * whose boundary is its input's to keep or drop. Placement never realizes such a node `distinct` (rel.ts
 * deliveredInput, dedup/policy.ts placementTarget); were one requested, the boundary is added.
 */
const delivering =
	<K extends RelKind>(facts: ShapeFacts, lower: NodeLowerer<K>): NodeLowerer<K> =>
	(node, cx, env) => {
		const query = lower(node, cx, env)
		return facts.realization(node) === "distinct" ? withBoundary(cx, node, query) : query
	}

/**
 * A semi-join keeps its DISTINCT over a recursion's feedback, where it lowers as a join (semi-join/exists.ts); one its
 * right side drives (cte-policy semiJoinDriven) reads its left side once per right-side key (shapes/semi-join).
 */
const semiJoinShape = (facts: ShapeFacts): NodeLowerer<"SemiJoin"> => {
	const test = lowerSemiJoinAt(atRowWalk)
	const plain = realized(facts, test)
	const driven = realized<"SemiJoin">(facts, (node, cx, env) => {
		const on = semiJoinDriven(node)
		return on === undefined ? test(node, cx, env) : drivenSemiJoin(cx, env, node, on)
	})
	return (node, cx, env) =>
		cx.readsFeedback(node.right)
			? conservativeLowerers.SemiJoin(node, cx, env)
			: semiJoinDriven(node) !== undefined
				? driven(node, cx, env)
				: plain(node, cx, env)
}

/** The kind table. */
const optimizedLowerers = (
	facts: ShapeFacts,
	state: ShapeLog
): { readonly [K in RelKind]: NodeLowerer<K> } => ({
	Base: realized(facts, conservativeLowerers.Base),
	Closed: realized(facts, conservativeLowerers.Closed),
	Context: realized(facts, conservativeLowerers.Context),
	InputSet: inputSetLowerer(facts),
	Delta: realized(facts, conservativeLowerers.Delta),
	MatchRegion: realized(
		facts,
		regionLowerer(facts, (n) => state.strategy(n) === "materialized")
	),
	Filter: realized(facts, searchFenced(conservativeLowerers.Filter)),
	ProjectSet: realized(facts, conservativeLowerers.ProjectSet),
	SemiJoin: semiJoinShape(facts),
	AntiJoin: realized(facts, lowerAntiJoinAt(atRowWalk)),
	Union: unionLowerer(facts),
	Intersect: conservativeLowerers.Intersect,
	Difference: conservativeLowerers.Difference,
	Take: takeShape(facts),
	Group: aggregateLowerer(facts),
	Produce: producerLowerer(facts),
	Recursive: recursionLowerer(facts),
	SelfRef: realized(facts, conservativeLowerers.SelfRef),
	ApproximateNearest: approximateLowerer(facts),
	OrderedResult: delivering(facts, conservativeLowerers.OrderedResult),
	Attach: delivering(facts, conservativeLowerers.Attach),
	Forbid: delivering(facts, conservativeLowerers.Forbid),
	Window: catalogLowerers.Window,
	OrderedSetAggregate: catalogLowerers.OrderedSetAggregate,
	Step: realized(facts, conservativeLowerers.Step),
	Call: realized(facts, conservativeLowerers.Call)
})

const cteMaterialization = (strategy: CteStrategy): NonNullable<Cte["materialized"]> | undefined =>
	strategy === "materialized"
		? "MATERIALIZED"
		: strategy === "notMaterialized"
			? "NOT MATERIALIZED"
			: undefined

/**
 * The one dispatch: a node to its kind's plug-in, or, for a node
 * the CTE policy shares, a read of its statement-level CTE, defined at its first use in the statement. The CTE policy
 * shares only uncorrelated nodes off every recursion's feedback (cte-policy rule 3), so the body is lowered outside any
 * outer scope: a reference to one would be refused rather than hoisted. Every entry the statement's WITH holds, such a
 * body and each key set, is lowered at the statement's root (LowerContext atStatementRoot), never in a scope of the read
 * that first defines it.
 */
export const optimizedDispatch = (facts: ShapeFacts, state: ShapeLog): Dispatching => {
	const table = optimizedLowerers(facts, state)
	/** The table is a mapped type over the kinds, so its entry at a node's kind takes that kind's node. */
	const plugIn = <K extends RelKind>(
		node: NodeOf<K>,
		cx: LowerContext,
		env: Env
	): OperandSelect => {
		const lower: NodeLowerer<K> = table[node.kind]
		return lower(node, cx, env)
	}
	const keyed = new KeyedLowering(
		(node, cx, env, restriction) =>
			node.kind === "Union"
				? keyedUnion(facts, node, cx, env, restriction)
				: keyedGroup(facts, node, cx, env, restriction),
		(node) => node.id
	)
	/**
	 * Whether `node` is lowered where it is read, in the query that reads it: the policy shares it as no CTE
	 * (CteDecision), every read of it reads it at values (StatementKeys atValues), or a read of it reads a recursion's
	 * feedback.
	 */
	const loweredInPlace = (node: RelNode, cx: LowerContext): boolean => {
		const shared = state.decision(node)
		const decision = shared !== undefined && state.keys.atValues.has(node.id) ? undefined : shared
		return (
			decision === undefined ||
			cteMaterialization(decision.strategy) === undefined ||
			cx.readsFeedback(node)
		)
	}
	/**
	 * The region whose held CTEs (cte-policy sharedCorrelated) lead the query `node` is lowered as: its filtered region,
	 * the node itself or a semi- or anti-join's left, where that region is lowered in this very query; none where the
	 * region is a CTE of its own, whose body is spelled in the statement's WITH and holds them there. A held CTE stands
	 * in its holder's query, which encloses every read of it: opened around a semi-join over a region the statement
	 * shares, it led the semi-join's query, while the reads stood in the region's CTE, out of its reach (key-sets,
	 * rotating 0x2f1e3cf5).
	 */
	const holdingRegion = (node: RelNode, cx: LowerContext): NodeOf<"MatchRegion"> | undefined => {
		const region = filteredRegion(node)
		return region !== undefined && (region === node || loweredInPlace(region, cx))
			? region
			: undefined
	}
	const placed: NodeDispatch = (node, cx: LowerContext, env) => {
		/**
		 * Whether a restriction reaches the node (share/keys.ts restrictionWalk): it is lowered where it is read, at the
		 * values, where its CTE, its key set's or the statement's whole, would be read at them for each row of what reads
		 * it, which no index reads.
		 */
		const restricted = env.restricted.has(node)
		if (restricted) {
			return restrictedRead(cx, node, env, (at, within) => plugIn(node, at, within))
		}
		const shared = state.decision(node)
		/** A node every read of which reads it at values is read inline at each (StatementKeys atValues). */
		const decision = shared !== undefined && state.keys.atValues.has(node.id) ? undefined : shared
		const materialized = decision === undefined ? undefined : cteMaterialization(decision.strategy)
		const inPlace = decision === undefined ? state.keys.inPlace.get(node) : undefined
		if (inPlace !== undefined && readAtKeys(node) && !cx.readsFeedback(node)) {
			return keyed.atKeys(node, inPlace, cx, env, state.keyScope(cx.atStatementRoot(dispatch)))
		}
		if (decision === undefined || materialized === undefined || cx.readsFeedback(node)) {
			const region = holdingRegion(node, cx)
			return region === undefined
				? plugIn(node, cx, env)
				: state.withHeldCtes(region.id, env, () => plugIn(node, cx, env))
		}
		const scope = decision.scope
		switch (scope.kind) {
			case "statement": {
				const keys = state.keys.once.get(node.id)
				const statement = cx.atStatementRoot(dispatch)
				const region = holdingRegion(node, statement)
				const body = (): OperandSelect =>
					keys === undefined
						? plugIn(node, statement, emptyEnv)
						: keyed.body(node, keys, state.keyScope(statement), (within) =>
								plugIn(node, within, emptyEnv)
							)
				return cteAtFirstUse(cx, node, state.log, decision.copies, materialized, () =>
					region === undefined ? body() : state.withHeldCtes(region.id, emptyEnv, body)
				)
			}
			case "held": {
				const held = state.heldCtes(scope.holder)
				return held === undefined
					? plugIn(node, cx, env)
					: cteAtFirstUse(cx, node, held.table, node.id, materialized, () =>
							plugIn(node, cx, held.env)
						)
			}
		}
	}
	const dispatch: NodeDispatch = (node, cx, env) => {
		const site = state.keys.copies.sites.get(node)
		const carried =
			site === undefined || restrictedUnder(node, env)
				? undefined
				: keyed.copied(node, site, cx, env)
		return carried ?? placed(node, cx, env)
	}
	/** A driver of copies the statement computes beside it, read as their one evaluation (share/keyed.ts carried). */
	const carrying: Carrying = (node, cx) => {
		const driving = state.keys.copies.drivers.get(node)
		return driving === undefined
			? undefined
			: keyed.carried(driving, cx, state.keyScope(cx.atStatementRoot(dispatch)), state.carriers)
	}
	return { dispatch, carrying }
}

/**
 * Whether a restriction stands on a node under `node` (share/keyed.ts pushedInto), which a copy's one evaluation, its
 * rows at its driver's every row, would not keep: such a site reads its copy where it stands.
 */
const restrictedUnder = (node: RelNode, env: Env): boolean => {
	if (env.restricted.size === 0) {
		return false
	}
	const under = new Set(postorder([node], inputsOf))
	return [...env.restricted.keys()].some((n) => under.has(n))
}

/**
 * How a delivery's statements lower their nodes (optimizedDispatch): the one dispatch, and how a driver of copies the statement
 * computes beside it carries their arrays where a reader places it (conservative/context.ts Carrying).
 */
export interface Dispatching {
	readonly dispatch: NodeDispatch
	readonly carrying: Carrying
}

/**
 * What one fused attachment column carries, as the runtime's decoder reads it: the parent columns it correlates on and
 * its layout (attach/index.ts fusedLayout).
 */
const fusedDescription = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	heading: Heading
): FusedAttachment => ({
	attach,
	name: attach.name,
	parentColumns: parentColumnsOf(cx, attach, spine, heading).map((c) => c.name),
	layout: fusedLayout(attach, attach.child.heading, attach.parent.heading)
})

/**
 * Whether a query forms its rows by deduplicating them at its top: a DISTINCT or grouped core, or a UNION, INTERSECT or
 * EXCEPT, through a query of no clause of its own.
 */
const deduplicates = (query: OperandSelect): boolean => {
	if (query.orderBy.length > 0 || query.limit !== undefined || query.offset !== undefined) {
		return false
	}
	const body = query.body
	switch (body.kind) {
		case "core":
			return body.distinct !== false || body.rows === "grouped" || body.rows === "facts"
		case "setOp":
			return body.op !== "UNION ALL"
		case "select":
			return deduplicates(body)
	}
}

interface DeliveredAttachment {
	readonly attach: NodeOf<"Attach">
	/** The nodes whose rows are the delivered rows, under the delivered heading's column names. */
	readonly spine: ReadonlyArray<RelNode>
}

interface RowsSpec {
	/** The rows, lowered in the statement being lowered: delivered by their part, or held for their attachments. */
	readonly rel: () => OperandSelect
	readonly heading: Heading
	/** The node whose rows the part delivers, for the facts. */
	readonly origin: RelNode
	readonly attachments: ReadonlyArray<DeliveredAttachment>
	readonly order: DeliveryOrder | undefined
	readonly role: RowsRole
}

/** A part of the statement being lowered: its rows' query in its delivery order, its role, heading and fused columns. */
interface LoweredPart {
	readonly query: Select
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<FusedAttachment>
}

/** An attachment placed as a part of its own under its parent's rows: the attachment, its parent key and its part. */
interface PlacedAttachment {
	readonly attach: NodeOf<"Attach">
	readonly parentKey: Heading
	readonly part: DeliveredPart
}

/** Rows a statement holds once (OptimizedDelivery #held): every column of them, a set. */
interface HeldRows {
	readonly rows: () => OperandSelect
}

/**
 * An attachment part's rows a statement holds once (OptimizedDelivery #heldPairs), each a parent key and a child, and
 * the child's columns alone: a set where the child fixes its parent key (keys.ts ParentFixed), since each pair is one
 * row and the child names its one parent, and an operand otherwise.
 */
interface HeldPairs extends HeldRows {
	readonly children: () => OperandSelect
}

/** The text of the statement `ast` under the names `nameMap`, which a statement the lowering built always prints. */

/** An optimized delivery: its statements, each lowered once in the delivery's state (ShapeState). */
export class OptimizedDelivery<
	Own extends PageParamSlot,
	T extends StatementText
> extends Delivery<Own> {
	readonly facts: ShapeFacts
	readonly state: ShapeState
	/** Each statement's text: its print where it is sent, none where another statement composes it. */
	readonly #text: TextOf<T>

	constructor(cx: LowerContext, facts: ShapeFacts, state: ShapeState, text: TextOf<T>) {
		super(cx)
		this.facts = facts
		this.state = state
		this.#text = text
	}

	/** The parts of the statement being lowered, in part order. */
	#placed: Array<LoweredPart> = []
	/** The attachments placed under each parent's rows in the statement being lowered, by those rows, in part order. */
	#siblings = new Map<ParentRows, Array<PlacedAttachment>>()
	/**
	 * The evaluations the statement being lowered holds for each parent's rows, once for every attachment under them
	 * (call/index.ts parentEvaluations), by those rows.
	 */
	#parentEvaluations = new Map<ParentRows, EvaluationLookup>()

	/** The part `part`, placed at the next position of the statement being lowered, as the runtime reads it. */
	#place(part: LoweredPart): DeliveredPart {
		const answer = this.#placed.length
		this.#placed.push(part)
		return { role: part.role, heading: part.heading, fused: part.fused, answer }
	}

	/**
	 * The rows `query` delivers, `width` columns, a set, held once by the statement being lowered: a MATERIALIZED CTE of
	 * its WITH, defined here, after every CTE `query` reads, which a part and every part under it read in place of
	 * computing them again. Its name and columns.
	 */
	#hold(query: OperandSelect, width: number, origin: NameOrigin): Omit<DefinedCte, "set"> {
		const name = this.cx.relationAlias(origin)
		const columns = this.cx.supply.columns(Array.from({ length: width }, () => origin))
		this.state.log.ctes.add({
			name,
			materialized: "MATERIALIZED",
			query: namedQuery(query, columns)
		})
		return { name, columns }
	}

	/**
	 * The rows a part with attachments holds, in the order the part delivers them where it delivers them in one, each
	 * text under the fixed collation (template.ts collatedRows): PostgreSQL carries a MATERIALIZED CTE's sort order to
	 * the scan that reads it, so the part's row numbers and ORDER BY over the held rows read them presorted, and the one
	 * sort is the CTE's own, which an index read in the order's columns elides.
	 */
	#heldInOrder(spec: RowsSpec): OperandSelect {
		if (spec.order === undefined || spec.heading.length === 0) {
			return spec.rel()
		}
		return collatedRows(
			this.deliveredRows(this.#formed(spec), spec.heading, spec.origin, spec.order),
			spec.heading
		)
	}

	/**
	 * The rows a part delivers, formed before they are ordered: a relation that deduplicates its rows, by DISTINCT, GROUP
	 * BY or a UNION, INTERSECT or EXCEPT (deduplicates), and is delivered in an order, is held in a MATERIALIZED CTE
	 * (`#held`) and ordered as the part reads it. PostgreSQL plans no order a reader states into a CTE, so its r rows are
	 * formed as the plan finds cheapest, a hash of its n input rows, O(n), and sorted after, O(r log r), where an order
	 * over the deduplication itself is read as a sort of every input row, O(n log n), the unique step after it. A
	 * relation of no order, or of rows it forms by no deduplication, is read as it is.
	 */
	#formed(spec: RowsSpec): OperandSelect {
		const rel = spec.rel()
		return spec.order === undefined || spec.heading.length === 0 || !deduplicates(rel)
			? rel
			: this.#held(rel, deliveredHeading(spec.heading).length, {
					kind: "node",
					node: spec.origin.id
				}).rows()
	}

	/** The rows `query` delivers, `width` columns, held once (`#hold`). */
	#held(query: OperandSelect, width: number, origin: NameOrigin): HeldRows {
		const held = this.#hold(query, width, origin)
		return { rows: () => cteRead(this.cx.relationAlias(origin), { ...held, set: true }) }
	}

	/**
	 * An attachment part's rows `query` delivers, the parent key's `keyWidth` columns then the child's `childWidth`,
	 * held once (`#hold`), its children alone a set where `fixed` proves the child fixes its parent key.
	 */
	#heldPairs(
		query: OperandSelect,
		keyWidth: number,
		childWidth: number,
		origin: NameOrigin,
		fixed: ParentFixed | undefined
	): HeldPairs {
		const held = this.#hold(query, keyWidth + childWidth, origin)
		return {
			rows: () => cteRead(this.cx.relationAlias(origin), { ...held, set: true }),
			children: () =>
				cteRead(this.cx.relationAlias(origin), {
					name: held.name,
					columns: held.columns.slice(keyWidth),
					set: fixed !== undefined
				})
		}
	}

	/**
	 * What the rows a part delivers of `node` prove of their keys (keys.ts keySetOf): the physical analysis's key of one
	 * evaluation of `node`, which holds across evaluations where `node` reads nothing of an enclosing node or, for an
	 * attachment's child, where `fixed` proves the child fixes its parent key.
	 */
	#rowKeys(node: RelNode, fixed: ParentFixed | undefined): RowKeys {
		return (columns) =>
			keySetOf(columns, this.facts.keyedBy(node, columns), this.cx.freeRefs(node), fixed)
	}

	/**
	 * The program `place` places: the one statement of its parts, lowered with names, placeholders and WITH entries of
	 * its own, every part in that statement.
	 *
	 * One part is the statement: its query, its refined output casts, the statement's WITH entries and its public
	 * names, its text made (printed by sql/emit where it is sent, none where another statement composes it: TextOf),
	 * then its executable form (template.ts executableQueryFrom), exactly as a statement of its own. Several parts are each part's executable form as a CTE of the statement after its WITH entries
	 * (lower/parts.ts partQuery), and the statement's rows are each part's rows behind its tag (lower/parts.ts
	 * taggedParts). A part's refined outputs are refined over the statement's WITH entries, which the refinement retypes
	 * with the part, so every part and entry reads one placeholder alike.
	 */
	#program(
		place: () => StatementRoots<DeliveredPart>
	): PartedStatement<DeclaredParamSlot | Own, T> {
		this.state.begin()
		this.beginStatement()
		this.cx.hostStatementEvaluations(statementEvaluations(this.state.log.ctes, this.cx))
		this.#placed = []
		this.#siblings = new Map()
		this.#parentEvaluations = new Map()
		const roots = place()
		const placed = this.#placed
		this.#placed = []
		this.#siblings = new Map()
		this.#parentEvaluations = new Map()
		const log = this.state.drain()
		const cx = this.cx
		const supply = cx.supply
		const [only, ...others] = placed
		if (only === undefined) {
			defect("a program places its rows' part")
		}
		if (!isNonEmpty(others)) {
			const output = statementOutput(only.role, only.heading, only.fused)
			const ast = deliveredStatement(
				withAdmission(
					cx,
					readByItsIndexes(
						withLeading(refineDelivered(cx, only.query, output.heading), log.ctes),
						cx.names
					)
				),
				output.names,
				supply
			)
			const nameMap = supply.map()
			const executable = executableQueryFrom(
				{ ast, role: only.role, heading: only.heading, fused: only.fused },
				new NameSupply(namesPast(nameMap, freshNames))
			)
			const params = [...this.params.slots]
			return {
				statement: { ast: executable, sql: this.#text(executable, nameMap), params },
				parts: {
					kind: "one",
					delivered: {
						ast,
						sql: unprintedText(ast, nameMap),
						params,
						role: only.role,
						heading: only.heading,
						fused: only.fused
					}
				},
				roots
			}
		}
		let entries: ReadonlyArray<Cte> = [...log.ctes]
		const parts = mapNonEmpty([only, ...others], (part) => {
			const output = statementOutput(part.role, part.heading, part.fused)
			const refined = refineDelivered(cx, withLeading(part.query, entries), output.heading)
			const refinedWith = refined.with?.ctes ?? []
			const own = refinedWith.slice(entries.length)
			entries = refinedWith.slice(0, entries.length)
			const executable = executableQueryFrom(
				{
					ast: {
						...refined,
						with:
							isNonEmpty(own) && refined.with !== undefined
								? { ...refined.with, ctes: own }
								: undefined
					},
					role: part.role,
					heading: part.heading,
					fused: part.fused
				},
				supply
			)
			const { query, columns, shape } = partQuery(executable, supply)
			const name = supply.relation({ kind: "internal", purpose: "statement part" })
			return {
				cte: { name, materialized: undefined, query: query },
				columns,
				shape: { ...shape, delivered: refined }
			}
		})
		const { body } = taggedParts(
			mapNonEmpty(parts, (p) => ({ name: p.cte.name, columns: p.columns })),
			0
		)
		const ast = bindLaterally(
			withAdmission(
				cx,
				readByItsIndexes(
					{
						...select(body),
						with: {
							recursive: false,
							ctes: concatNonEmpty(
								entries,
								mapNonEmpty(parts, (p) => p.cte)
							)
						}
					},
					cx.names
				)
			),
			supply
		)
		return {
			statement: { ast, sql: this.#text(ast, supply.map()), params: [...this.params.slots] },
			parts: { kind: "tagged", parts: mapNonEmpty(parts, (p) => p.shape) },
			roots
		}
	}

	/**
	 * The delivered rows of a relation, ordered by its completed order with the heading appended only where the facts
	 * do not prove the order total (DeliveryOrder).
	 */
	deliveredRows(
		rel: OperandSelect,
		heading: Heading,
		origin: RelNode,
		ordered: DeliveryOrder | undefined
	): Select {
		const source = this.cx.wrap(rel, heading, { kind: "node", node: origin.id })
		const orderBy: ReadonlyArray<OrderItem> =
			ordered === undefined || heading.length === 0
				? []
				: orderItemsOf(ordered.order, heading, source.map, {
						leading: [],
						total: ordered.total,
						fixed: []
					})
		return {
			...select(
				keyedSet(headingTargets(heading, source.map), [source.item], undefined, "a delivery")
			),
			orderBy
		}
	}

	/** The program delivering `root`'s rows, its attachments' and its heading groups', as one statement (`#program`). */
	optimizedProgram(root: RelNode): OptimizedDeliveryProgram<DeclaredParamSlot | Own, T> {
		const cx = this.cx
		const plan = this.heterogeneousPlan(root)
		if (plan !== undefined) {
			return {
				...this.#program(() => this.headingGroups(plan)),
				delivery: headingGroupsDelivery(plan)
			}
		}
		const rows = root.kind === "OrderedResult" ? root.input : root
		const order =
			root.kind === "OrderedResult"
				? deliveryOrder(this.facts, rows, soleOrder(root.orders), rows.heading)
				: undefined
		const spine = this.spine(rows)
		const program = this.#program(() => [
			this.rowsPart({
				rel: () => cx.lower(rows, emptyEnv),
				heading: rows.heading,
				origin: rows,
				attachments: spine.attachments.map((attach) => ({ attach, spine: spine.nodes })),
				order,
				role: { kind: "main" }
			})
		])
		return { ...program, delivery: { kind: "rows" } }
	}

	/**
	 * A page's program of the parts `place` places (shapes/page/compile.ts), as one statement (`#program`): its rows
	 * parts (placedRows) and their attachments' (pipelinedPart), over the page's rows the statement holds (heldRows).
	 */
	pageProgram(
		place: () => StatementRoots<DeliveredPart>
	): PartedStatement<DeclaredParamSlot | Own, T> {
		return this.#program(place)
	}

	/** The part delivering `query`, rows of heading `heading` in their delivery order, of role `role`, placed next. */
	placedRows(query: Select, heading: Heading, role: RowsRole): DeliveredPart {
		return this.#place({ query, role, heading, fused: [] })
	}

	/**
	 * The rows `query` delivers, of heading `heading`, held once by the statement being lowered (`#held`), as the parts
	 * of the attachments over them read them, and the held rows themselves, which a page's rows part delivers
	 * (lower/shapes/page/compile.ts).
	 */
	heldRows(
		query: OperandSelect,
		heading: Heading,
		origin: RelNode
	): { readonly rows: ParentRows; readonly read: () => OperandSelect } {
		const held = this.#held(query, deliveredHeading(heading).length, {
			kind: "node",
			node: origin.id
		})
		return {
			rows: statementRows(this.cx, heading, origin, held.rows, this.#rowKeys(origin, undefined)),
			read: held.rows
		}
	}

	/**
	 * A rows part and its attachments (R36): fused as columns of the part, or each a part of its own in the same
	 * statement after it.
	 *
	 * An attachment is the nest operator: for each delivered parent fact, the set of its correlated child facts; the
	 * parent set is unchanged, never filtered, multiplied or reordered. Two lowerings deliver identical nested results,
	 * chosen by the rule and never by the caller:
	 *
	 * - a part of its own: the child's facts correlated to each parent key of the parent's rows. A parent with
	 *   attachments of this kind holds its rows once, a MATERIALIZED CTE of the statement (`#held`), which its own part
	 *   delivers and every attachment under it reads its parent key's set from (conservative/deliver.ts
	 *   parentKeysSource), so no part computes a relation above it again; the library stitches children onto parents by
	 *   key, each part's rows read behind its tag;
	 * - fused: the child inside the parent's part as `ARRAY(SELECT ...)`, an empty array rather than NULL, directly for a
	 *   single field and as `ARRAY(SELECT to_jsonb(...))` for several, decoded by the attachment's codec
	 *   (runtime/lower/fused.ts), a child whose correlated columns the parent row supplies included.
	 *
	 * A LEFT JOIN with padded columns is never emitted. Parent predicates stay on the parent and are never pushed into a
	 * child, which correlates to delivered parents only, so the parent's plan is the plan it would have alone and an
	 * attachment on a page is evaluated over the delivered page only.
	 *
	 * Every attachment is a part of its own unless the parent's rows read an approximate search: then every one is
	 * fused, since the search would be read again by the attachments' parts, and two HNSW searches in one snapshot need
	 * not retrieve the same set. A child that must be a part of its own (check/approximate/attach.ts pipelinedOnly: a
	 * recursive child, seeded once from the parent keys (R37, attach-recursive), a child over an approximate source,
	 * evaluated once per execution, and a child with attachments of its own, a heterogeneous union or a bytes column,
	 * whose values travel in chunks (codec/delivery.ts), each delivering more than one array can carry) never sits
	 * under rows that read a search: the lowering takes only an admitted query (check/index.ts AdmittedQuery). No width
	 * or count decides the form.
	 */
	rowsPart(spec: RowsSpec): StatementTree<DeliveredPart> {
		const cx = this.cx
		const searches = searchInRows(spec.origin) !== undefined
		const fused = searches ? spec.attachments : []
		const pipelined = searches ? [] : spec.attachments
		if (!isNonEmpty(pipelined)) {
			/** withFusedAttachments reads every fused child over one spine: the delivered rows' nodes. */
			const spine = [...new Set(fused.flatMap((a) => a.spine))]
			const rel = this.#formed(spec)
			const query =
				fused.length === 0
					? this.deliveredRows(rel, spec.heading, spec.origin, spec.order)
					: withFusedAttachments(
							cx,
							rel,
							spec.rel,
							spec.heading,
							spec.origin,
							spine,
							fused.map((a) => a.attach),
							this.facts,
							spec.order
						).query
			const columns = fused.map((a) => fusedDescription(cx, a.attach, a.spine, spec.heading))
			return {
				statement: this.#place({ query, role: spec.role, heading: spec.heading, fused: columns }),
				attachments: []
			}
		}
		const origin = { kind: "node", node: spec.origin.id } as const
		const held = this.#held(this.#heldInOrder(spec), deliveredHeading(spec.heading).length, origin)
		const statement = this.#place({
			query: this.deliveredRows(held.rows(), spec.heading, spec.origin, spec.order),
			role: spec.role,
			heading: spec.heading,
			fused: []
		})
		const rows = statementRows(
			cx,
			spec.heading,
			spec.origin,
			held.rows,
			this.#rowKeys(spec.origin, undefined)
		)
		return {
			statement,
			attachments: pipelined.map((a) => this.pipelinedPart(a.attach, a.spine, rows))
		}
	}

	/**
	 * One pipelined attachment's rows in the part being lowered, or its seeded recursive form (R37), with its child
	 * lowered over the parent rows and its parent key `parentKey`.
	 */
	pipelinedQuery(
		attach: NodeOf<"Attach">,
		spine: ReadonlyArray<RelNode>,
		rows: ParentRows,
		parentKey: Heading
	): PipelinedAttachment {
		const spineNodes = new Set(spine.map((n) => n.id))
		const evaluations = this.#parentEvaluations.getOrInsertComputed(rows, () =>
			parentEvaluations(this.state.log.ctes, rows, spineNodes)
		)
		const child = this.cx.withEvaluations(evaluations)
		return (
			seededAttachment(child, attach, spine, rows, this.facts, parentKey) ??
			pipelinedAttachment(child, attach, spine, rows, this.facts, parentKey)
		)
	}

	/**
	 * One pipelined attachment, a part of its own in its parent's statement over its parent key's set; its child's own
	 * attachments are parts after it, over its rows, which it then holds once (`#held`) and delivers from. Those rows
	 * read no search: the query is admitted (check/index.ts AdmittedQuery).
	 */
	pipelinedPart(
		attach: NodeOf<"Attach">,
		spine: ReadonlyArray<RelNode>,
		rows: ParentRows
	): AttachedTree<DeliveredPart> {
		const cx = this.cx
		this.oneHeadingAttached(attach)
		const child = attach.child
		const parentKey = parentColumnsOf(cx, attach, spine, rows.heading)
		const role: StatementRole = { kind: "attachment", parentKey }
		const childSpine = this.spine(child)
		const siblings = this.#siblings.getOrInsertComputed(rows, () => [])
		const placed = (part: DeliveredPart): DeliveredPart => {
			siblings.push({ attach, parentKey, part })
			return part
		}
		if (!isNonEmpty(childSpine.attachments)) {
			const feeder = siblings.find((s) => this.#sameRows(s, attach, parentKey))
			if (feeder !== undefined) {
				return {
					statement: { role, heading: child.heading, fused: [], answer: feeder.part.answer },
					attach,
					attachments: []
				}
			}
			const built = this.pipelinedQuery(attach, spine, rows, parentKey)
			return {
				statement: placed(
					this.#place({
						query: checkedAttachment(cx, attach, built.query, parentKey, child.heading, rows),
						role,
						heading: child.heading,
						fused: []
					})
				),
				attach,
				attachments: []
			}
		}
		const built = this.pipelinedQuery(attach, spine, rows, parentKey)
		const origin = { kind: "node", node: attach.id } as const
		const childColumns = deliveredHeading(child.heading)
		const fixed = parentFixed(attach, parentKey)
		const held = this.#heldPairs(
			checkedAttachment(cx, attach, built.rows, parentKey, child.heading, rows),
			parentKey.length,
			childColumns.length,
			origin,
			fixed
		)
		const statement = placed(
			this.#place({
				query: this.#heldAttachment(held, parentKey, childColumns, built.order, origin),
				role,
				heading: child.heading,
				fused: []
			})
		)
		const childRows = statementRows(
			cx,
			child.heading,
			child,
			held.children,
			this.#rowKeys(child, fixed)
		)
		return {
			statement,
			attach,
			attachments: childSpine.attachments.map((nested) =>
				this.pipelinedPart(nested, childSpine.nodes, childRows)
			)
		}
	}

	/**
	 * Whether the attachment placed as `placed` delivers the rows `attach` would, both under one parent's rows (R25):
	 * one parent key, each correlated to the same child column, one delivered type and order, a child of one heading,
	 * and children of one share key (share/index.ts shareKey), so in one snapshot they compute the same set. The share
	 * keys are read only where the rest agree.
	 */
	#sameRows(placed: PlacedAttachment, attach: NodeOf<"Attach">, parentKey: Heading): boolean {
		const other = placed.attach
		if (
			other.delivered !== attach.delivered ||
			!canonicalEquals(other.order, attach.order) ||
			!canonicalEquals(other.correlation, attach.correlation) ||
			!canonicalEquals(placed.parentKey, parentKey) ||
			!canonicalEquals(other.child.heading, attach.child.heading)
		) {
			return false
		}
		return this.#shareKey(other.child) === this.#shareKey(attach.child)
	}

	/** The share key of `child` within the delivery's DAG; a DAG it cannot key is refused. */
	#shareKey(child: RelNode): string {
		return unwrap(shareKey(this.cx.dag, child, this.cx.templates))
	}

	/**
	 * An attachment part's rows from the rows `held` holds, the parent key's columns `parentKey` then the child's
	 * `child`, in the attachment's order (PipelinedAttachment order).
	 */
	#heldAttachment(
		held: HeldRows,
		parentKey: Heading,
		child: Heading,
		order: PipelinedAttachment["order"],
		origin: NameOrigin
	): Select {
		const cx = this.cx
		const alias = cx.relationAlias(origin)
		const keys = parentKey.map((c) => ({ name: c.name, column: cx.supply.column(origin) }))
		const own = child.map((c) => ({ name: c.name, column: cx.supply.column(origin) }))
		const columns = [...keys, ...own].map((c) => c.column)
		return {
			...select(
				keyedSet(
					columns.map((c) => target(col(alias, c))),
					[derived(namedQuery(held.rows(), columns), alias, false)],
					undefined,
					"an attachment's held rows"
				)
			),
			orderBy: order(
				new Map(keys.map((k) => [k.name, col(alias, k.column)])),
				new Map(own.map((c) => [c.name, col(alias, c.column)]))
			)
		}
	}

	/**
	 * `order` over heading group `group` of `union`, total where the facts prove it of the group's rows: by its arm's keys,
	 * where it has one, else by the union's.
	 */
	#groupOrdered(
		union: NodeOf<"Union">,
		group: HeterogeneousPlan["union"]["groups"][number],
		order: CompletedOrder
	): DeliveryOrder {
		const [only, ...others] = group.arms
		return others.length === 0
			? deliveryOrder(this.facts, only, order, group.heading)
			: deliveryOrder(this.facts, union, order, union.heading)
	}

	/** One part per heading group (R21), each with its attachments' parts (groupSpec). */
	headingGroups(plan: HeterogeneousPlan): StatementRoots<DeliveredPart> {
		return mapNonEmpty(plan.union.groups, (group, gi) =>
			this.rowsPart(this.groupSpec(plan, gi, group))
		)
	}

	/**
	 * The rows of heading group `gi`, in the statement it begins: the group's rows, deduplicated unless proved unique
	 * (union/index.ts groupRows), the plan's filters, the take's first k in the common completed order, the delivery
	 * order, and the attachments above the union and those of a group's single arm.
	 */
	groupSpec(
		plan: HeterogeneousPlan,
		gi: number,
		group: HeterogeneousPlan["union"]["groups"][number]
	): RowsSpec {
		const cx = this.cx
		const { union } = plan
		const take = groupTake(plan)
		const at = nodeLabel(union)
		const scopeNodes = [...plan.spineNodes, union]
		/** The group's rows, lowered in the statement being lowered: its own, or an attachment's computing them again. */
		const lowered = (): Select => {
			let rel = groupRows(cx, union, group, emptyEnv, this.facts)
			const filters = plan.filters
			if (isNonEmpty(filters)) {
				const input = cx.wrap(rel, group.heading, {
					kind: "node",
					node: lastNonEmpty(filters).id
				})
				const scope: Env = envOf(scopeNodes.map((n) => [n.id, input.map] as const))
				rel = select(
					keyedSet(
						headingTargets(group.heading, input.map),
						[input.item],
						and(mapNonEmpty(filters, (f) => lowerExpr(cx, f.pred, scope))),
						"a heading group's filtered rows"
					)
				)
			}
			if (take !== undefined) {
				const bounded = cx.wrap(rel, group.heading, { kind: "node", node: take.id })
				const order = defined(take.orders[gi], "a heading group's order")
				const orderBy = orderItemsOf(order, group.heading, bounded.map, {
					leading: [],
					total: this.#groupOrdered(union, group, order).total,
					fixed: []
				})
				rel = {
					...select(
						keyedSet(
							headingTargets(group.heading, bounded.map),
							[bounded.item],
							undefined,
							"a heading group's bounded rows"
						)
					),
					orderBy,
					limit: cx.boundExpr(take.bound)
				}
			}
			return rel
		}
		const rel = lowered
		const attachments: Array<DeliveredAttachment> = plan.attachments.map((attach) => ({
			attach,
			spine: scopeNodes
		}))
		const [only, ...others] = group.arms
		if (others.length === 0) {
			const armSpine = this.spine(only)
			for (const attach of armSpine.attachments) {
				attachments.push({ attach, spine: armSpine.nodes })
			}
		} else {
			const attached = group.arms.find((arm) => this.spine(arm).attachments.length > 0)
			if (attached !== undefined) {
				refuse(
					"UnsupportedOperation",
					at,
					`attachments on the arm ${attached.id} of a heading group of several arms`
				)
			}
		}
		const delivered = groupOrder(plan, gi)
		return {
			rel,
			heading: group.heading,
			origin: union,
			attachments,
			order: delivered === undefined ? undefined : this.#groupOrdered(union, group, delivered),
			role: { kind: "headingGroup", group: gi }
		}
	}
}
