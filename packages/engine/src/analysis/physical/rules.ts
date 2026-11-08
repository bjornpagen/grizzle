import { leadingReason } from "#compiler/analysis/certificates/reasons.ts"
import { keyEvidence } from "#compiler/analysis/physical/evidence.ts"
import {
	asTheyAre,
	DependencyDraft,
	hiddenIn,
	type JoinedOccurrence,
	type Justification,
	joinJustifications,
	justify,
	nodePremise,
	type OuterColumn,
	paramPremise,
	type Rep,
	resolveOuter,
	row,
	structural,
	withReason
} from "#compiler/analysis/physical/fds.ts"
import {
	type FixedFact,
	type FixedFacts,
	isUnique,
	type Loss,
	type PhysicalProps,
	plainLosses,
	type Realization,
	type Uniqueness
} from "#compiler/analysis/physical/props.ts"
import { castIdentity, castInjective, comparedValue } from "#compiler/ir/injective.ts"

import {
	AllenReading,
	joinedPairs,
	type PairPredicate,
	pointHolder
} from "#compiler/check/allen.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	atMost,
	boundsAtMost,
	type Cardinality,
	leastCardinality,
	productCardinality,
	sumCardinality,
	unbounded
} from "#compiler/ir/cardinality.ts"
import type { CoercionIdentity } from "#compiler/ir/certificate.ts"
import type { EvidenceCatalog, KeyConstraint } from "#compiler/ir/evidence.ts"
import {
	type EqualityKey,
	exprClosure,
	nativeEqualityKey,
	type OpId,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	closedColumn,
	exprsOf,
	type Heading,
	inputSetPlaceholder,
	inputsOf,
	type NodeOf,
	type RelKind,
	type RelNode,
	unionArms
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { chain } from "#compiler/logical/defined.ts"
import { conjuncts, type Fixed, fixedEqual, readColumns } from "#compiler/logical/props.ts"
import { carrierEquality, nativeOp } from "#compiler/scalar/compute/registry.ts"

export interface RuleContext {
	/**
	 * The physical properties of an input of the node the rule computes: its analysis computes every input before the
	 * node (analyze.ts), so this reads what it already holds.
	 */
	readonly props: (input: RelNode) => PhysicalProps
	readonly catalog: EvidenceCatalog
	/**
	 * The realization a placement decided for the node of a label, or undefined where it decided none and the node has
	 * its kind's default (defaultRealizationOf). By label, since a SelfRef names its Recursive by one.
	 */
	readonly placed: (node: NodeId) => Realization | undefined
}

/**
 * The realization a node of a kind has when no placement decided one: the conservative set forms that remain the
 * general lowering for INTERSECT, EXCEPT and recursive closure, the plain form for every other kind, a union
 * included (UNION ALL), so that the analysis shows where elimination is owed.
 */
const defaultRealizationOf = (kind: RelKind): Realization =>
	kind === "Intersect" || kind === "Difference" || kind === "Recursive" ? "distinct" : "plain"

/** The realization of `node`: the one its placement decided, or its kind's default. */
export const realizationOf = (
	placed: (node: NodeId) => Realization | undefined,
	node: RelNode
): Realization => placed(node.id) ?? defaultRealizationOf(node.kind)

const equalityOp = (t: ScalarType): OpId => carrierEquality(baseOf(t).carrier)

const typeIdentity = (t: ScalarType): ReadonlyArray<CoercionIdentity> => {
	const base = baseOf(t)
	const label: CoercionIdentity = `type:${typeLabel(t)}`
	return base.carrier === "text" ? [label, "collation:pg_catalog.pg_c_utf8"] : [label]
}

const columnTypes = (heading: Heading, columns: ReadonlyArray<string>): ReadonlyArray<ScalarType> =>
	columns.map(
		(c) =>
			defined(
				heading.find((x) => x.name === c),
				"a compared column is a column of its heading"
			).type
	)

const comparing = (types: ReadonlyArray<ScalarType>): Justification =>
	justify({ equality: types.map(equalityOp), coercions: types.flatMap(typeIdentity) })

/**
 * The native equality operators and type and collation identities comparing `columns` of a heading under native
 * equality, the equality DISTINCT and the key constraints use.
 */
export const nativeComparison = (heading: Heading, columns: ReadonlyArray<string>): Justification =>
	comparing(columnTypes(heading, columns))

const equalityOperands = (e: ScalarExpr): readonly [ScalarExpr, ScalarExpr] | undefined => {
	if (e.kind !== "op") {
		return undefined
	}
	const [x, y, ...more] = e.args
	if (x === undefined || y === undefined || more.length > 0 || nativeOp(e.op)?.fn !== "eq") {
		return undefined
	}
	return [x, y]
}

/** A span a predicate holds to contain a point, and the expression the point is a function of. */
interface HeldPoint {
	readonly span: ScalarExpr
	readonly point: ScalarExpr
}

/** The point `s @> t` (pointIn) holds in s. */
const containedPoint = (e: ScalarExpr): HeldPoint | undefined => {
	if (e.kind !== "op") {
		return undefined
	}
	const [a, b, ...more] = e.args
	if (a === undefined || b === undefined || more.length > 0) {
		return undefined
	}
	if (typeof e.op === "string") {
		return undefined
	}
	return e.op.code === "range_contains_elem" ? { span: a, point: b } : undefined
}

/** Joins a predicate into a pair's when both are over one pair of spans; whether they were. */
const joinInto = (q: { pair: PairPredicate }, p: PairPredicate): boolean => {
	const joined = joinedPairs([q.pair, p], "and")
	if (joined === undefined) {
		return false
	}
	q.pair = joined
	return true
}

/**
 * The points a filter's conjuncts hold, each at the conjunct it is learned at. A conjunct over two spans is read by its
 * mask (check/allen.ts): the conjuncts over one pair, under the intersection of their masks, hold a point of one span
 * in the other where every relation of it puts an endpoint of the one inside the other, as `s @> u`, `u <@ s` and
 * `s @> lower(u)` do (a span is never empty, so the endpoint is a point of each), learned at the first of them. Any
 * other `s @> t` holds the point t.
 */
const heldPoints = (
	preds: ReadonlyArray<ScalarExpr>
): ReadonlyArray<{ readonly pred: ScalarExpr; readonly held: ReadonlyArray<HeldPoint> }> => {
	const reading = new AllenReading()
	const pairs: Array<{ readonly at: ScalarExpr; pair: PairPredicate }> = []
	for (const c of preds) {
		const p = reading.pair(c)
		if (p === undefined) {
			continue
		}
		if (!pairs.some((q) => joinInto(q, p))) {
			pairs.push({ at: c, pair: p })
		}
	}
	return preds.map((pred) => {
		if (reading.pair(pred) === undefined) {
			const point = containedPoint(pred)
			return { pred, held: point === undefined ? [] : [point] }
		}
		const held = pairs.flatMap((q) => {
			const holder = q.at === pred ? pointHolder(q.pair) : undefined
			return holder === undefined ? [] : [{ span: holder.span.expr, point: holder.by.expr }]
		})
		return { pred, held }
	})
}

const isFalse = (e: ScalarExpr): boolean =>
	e.kind === "literal" && e.value.kind === "bool" && !e.value.value

/**
 * What a value expression is per evaluation of a fragment whose own nodes are `locals`: fixed (a literal, a
 * parameter, an outer column, or a computation over those), a column of `owner`, or unknown. A value fixed to an outer
 * column, or computed from one, is fixed only per outer row: its justification names the outer columns it varies with.
 */
type ValueRep =
	| { readonly kind: "fixed"; readonly fact: FixedFact }
	| { readonly kind: "column"; readonly node: NodeId; readonly column: string }
	| { readonly kind: "unknown" }

/** The node columns an expression reads, transitively, each once, in first-visit order (expr.ts exprClosure). */
const columnRefs = (e: ScalarExpr): ReadonlyArray<OuterColumn> => {
	const out = new Map<string, OuterColumn>()
	for (const at of exprClosure([e])) {
		if (at.kind === "column") {
			out.set(`${at.column.node}\u0000${at.column.name}`, {
				node: at.column.node,
				column: at.column.name
			})
		}
	}
	return [...out.values()]
}

/** A value fixed per evaluation, varying with the outer columns `outer` (none for a literal or a parameter). */
const fixedFact = (e: ScalarExpr, fixed: Fixed, outer: ReadonlyArray<OuterColumn>): FixedFact => ({
	fixed,
	just: justify({
		premises: e.deps.params.map(paramPremise),
		reasons: ["fixedKeyComponent"],
		outer
	})
})

/**
 * The labels of a subtree's nodes through data inputs, its root included, breadth-first: an outer column of one of them
 * is bound inside it.
 */
const subtreeOf = (root: RelNode): ReadonlyArray<RelNode> => {
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const at of queue) {
		for (const input of inputsOf(at)) {
			if (!seen.has(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return queue
}

/** The labels of a subtree's nodes (subtreeOf), which the column references inside it name. */
const subtreeLabels = (root: RelNode): ReadonlySet<NodeId> =>
	new Set(subtreeOf(root).map((n) => n.id))

/**
 * What an evaluation of a node varies with: every column of a node outside its subtree that the subtree reads (a
 * lateral source's correlation), which the region binding those columns turns into its variables.
 */
const evaluationReads = (root: RelNode): Justification => {
	const nodes = subtreeOf(root)
	const inside = new Set(nodes.map((n) => n.id))
	const outer: Array<OuterColumn> = []
	for (const n of nodes) {
		for (const e of exprsOf(n)) {
			appendAll(
				outer,
				columnRefs(e).filter((c) => !inside.has(c.node))
			)
		}
	}
	return justify({ outer })
}

/** The premise of a node's own computation: at most one row, a grouped key, an ordinal. It holds per evaluation. */
const ownPremise = (node: RelNode): Justification =>
	joinJustifications([justify({ premises: [nodePremise(node.id)] }), evaluationReads(node)])

const valueRep = (given: ScalarExpr, locals: ReadonlySet<NodeId>): ValueRep => {
	const e = comparedValue(given)
	switch (e.kind) {
		case "column":
			return locals.has(e.column.node)
				? { kind: "column", node: e.column.node, column: e.column.name }
				: {
						kind: "fixed",
						fact: fixedFact(e, { kind: "outer", node: e.column.node, column: e.column.name }, [
							{ node: e.column.node, column: e.column.name }
						])
					}
		case "literal":
			return {
				kind: "fixed",
				fact: fixedFact(
					e,
					{ kind: "literal", literal: e.value, key: nativeEqualityKey(e.value) },
					[]
				)
			}
		case "param":
			return { kind: "fixed", fact: fixedFact(e, { kind: "param", param: e.param }, []) }
		case "value":
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return e.deps.nodes.some((n) => locals.has(n))
				? { kind: "unknown" }
				: { kind: "fixed", fact: fixedFact(e, { kind: "expr" }, columnRefs(e)) }
	}
}

/**
 * Finishing a node: its dependency table, extended by its realization and its cardinality, and what its heading
 * identifies.
 */
interface Draft {
	readonly fds: DependencyDraft
	readonly fixed: ReadonlyMap<string, FixedFacts>
	/** The most rows the node can have. */
	readonly maxCard: Cardinality
	readonly losses: ReadonlyArray<Loss>
	/** What the node's own exact duplicate elimination rests on when it is realized `distinct`. */
	readonly dedup: DraftDedup
}

/**
 * A placed DISTINCT, comparing the heading under native equality; or a Recursive node's recursive UNION, which
 * removes repeated states of its working table with `just`.
 */
type DraftDedup =
	| { readonly kind: "placed" }
	| { readonly kind: "recursiveUnion"; readonly just: Justification }

const placed: DraftDedup = { kind: "placed" }

/**
 * A node of at most one row identifies its row by nothing; one realized with an exact duplicate-eliminating operator
 * identifies it by its whole heading, which only the realized table holds. The plain form is unique when its heading
 * identifies a row citing evidence an elision rule names, by its canonical minimal key (fds.ts keyAmong); a proof
 * that cites none backs no elision.
 */
const finish = (node: RelNode, cx: RuleContext, draft: Draft): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const realization = realizationOf(cx.placed, node)
	if (boundsAtMost(draft.maxCard, 1n)) {
		draft.fds.identify([], withReason(ownPremise(node), ["atMostOneRow"]))
	}
	const plain = draft.fds.freeze(columns)
	if (realization === "distinct") {
		draft.fds.identify(
			columns,
			draft.dedup.kind === "recursiveUnion"
				? draft.dedup.just
				: withReason(
						joinJustifications([
							justify({ premises: [nodePremise(node.id)] }),
							comparing(node.heading.map((c) => c.type))
						]),
						["exactDeduplication"]
					)
		)
	}
	const dependencies = realization === "distinct" ? draft.fds.freeze(columns) : plain
	const plainUnique = plain.keyAmong(columns)
	const maxCard =
		dependencies.proof([]) === undefined
			? draft.maxCard
			: leastCardinality([draft.maxCard, atMost(1n)])
	/**
	 * A column determined by nothing is fixed: to what an equal fixed column is fixed to, or to a computation. Its
	 * justification keeps the outer columns its derivation read, so it stays fixed only per outer row.
	 */
	const fixed = new Map<string, FixedFacts>()
	for (const c of columns) {
		const f = draft.fixed.get(c)
		if (f !== undefined) {
			fixed.set(c, f)
		}
	}
	const determined = plain.closure([])
	for (const c of columns) {
		if (!fixed.has(c) && determined.columns.has(c)) {
			fixed.set(c, [{ fixed: { kind: "expr" }, just: plain.explain(determined, [c]) }])
		}
	}
	/** Why the plain form is not unique, whatever the realization adds. */
	const [loss, ...more] = draft.losses
	const losses: NonEmptyReadonlyArray<Loss> =
		loss === undefined
			? [{ reason: "unknownEvidence", detail: "no admissible evidence proves the heading" }]
			: [loss, ...more]
	const lead = plainUnique === undefined ? undefined : leadingReason(plainUnique.just.reasons)
	const uniqueness: Uniqueness =
		plainUnique !== undefined && lead !== undefined
			? { kind: "plain", key: plainUnique, lead }
			: dependencies.proof(columns) === undefined
				? { kind: "none", losses }
				: { kind: "realized", losses }
	return {
		node: node.id,
		kind: node.kind,
		columns,
		dependencies,
		plain,
		fixed,
		maxCard,
		uniqueness,
		realization
	}
}

/** A node's dependency table and the facts its fixed columns are fixed to. */
interface FixedState {
	readonly fds: DependencyDraft
	readonly fixed: Map<string, FixedFacts>
}

/**
 * Records `fact` among what `column` is fixed to: a value it names beside the ones already held, or in place of a
 * computation's fact, which names none; a computation's fact only where nothing is held. So a column an input fixes by
 * a computation and a filter equates with a literal is fixed to the literal, as the logical analysis reads it
 * (logical/props.ts fixedNames), and one two filters equate with two values is fixed to both, in either order.
 */
const recordFact = (fixed: Map<string, FixedFacts>, column: string, fact: FixedFact): void => {
	const held = fixed.get(column)
	if (held === undefined || (held[0].fixed.kind === "expr" && fact.fixed.kind !== "expr")) {
		fixed.set(column, [fact])
	} else if (fact.fixed.kind !== "expr" && !held.some((h) => fixedEqual(h.fixed, fact.fixed))) {
		fixed.set(column, [...held, fact])
	}
}

/** Fixes `column` with `just`, recording `fact` among what it is fixed to (recordFact). */
const fixColumn = (
	state: FixedState,
	column: string,
	just: Justification,
	fact: FixedFact
): void => {
	state.fds.fix(column, just)
	recordFact(state.fixed, column, fact)
}

/**
 * Carries an input's fixed facts and its whole dependency table into a node's draft through `reps`, under
 * `namespace`, its row as `rowAs`: the node's own row where each of the node's rows is one of the input's (a filter, a
 * projection, a bound), so the input's identifications identify the node's rows; a hidden one where a row of the node
 * is not one row of the input (a group). A column the node gives no representative is hidden in the namespace, so a
 * dependency through it still holds among the columns that are represented, and a fixed one stays determined by
 * nothing. Copies of one input column are equal.
 */
const inherit = (
	fds: DependencyDraft,
	fixed: Map<string, FixedFacts>,
	input: PhysicalProps,
	reps: (column: string) => ReadonlyArray<Rep>,
	namespace: string,
	rowAs: string
): void => {
	for (const [c, facts] of input.fixed) {
		for (const r of reps(c)) {
			for (const f of facts) {
				recordFact(fixed, r.column, f)
			}
		}
	}
	for (const c of input.columns) {
		chain(reps(c), (first, other) => {
			fds.equate(first.column, other.column, joinJustifications([first.just, other.just]))
		})
	}
	fds.embed(input.dependencies, { namespace, column: reps, row: rowAs, localize: asTheyAre })
}

const sameName =
	(fds: DependencyDraft) =>
	(c: string): ReadonlyArray<Rep> =>
		fds.has(c) ? [{ column: c, just: structural }] : []

/**
 * A node whose heading carries its input's columns under the same names, each of its rows one of the input's, with
 * its input's evidence.
 */
const inheritSame = (node: RelNode, input: PhysicalProps): FixedState => {
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	const fixed = new Map<string, FixedFacts>()
	inherit(fds, fixed, input, sameName(fds), "input", row)
	return { fds, fixed }
}

/** Why a node over `input` whose heading is `columns` is not unique, when it is not: the input's, or its keys lost. */
const lossesOf = (input: PhysicalProps, columns: ReadonlyArray<string>): ReadonlyArray<Loss> =>
	input.uniqueness.kind === "none"
		? input.uniqueness.losses
		: columns.length === 0
			? []
			: [{ reason: "projectedKeyLoss", detail: "every key of the input is dropped" }]

/**
 * A filter keeps its input's keys and can fix key components. A span held to contain a point the input's columns, or
 * values fixed per evaluation, give has that point known.
 */
const filterProps = (node: NodeOf<"Filter">, cx: RuleContext): PhysicalProps => {
	const input = cx.props(node.input)
	const s = inheritSame(node, input)
	const fds = s.fds
	const inputId = node.input.id
	const locals = new Set([inputId])
	const pin = (held: HeldPoint): void => {
		const span = valueRep(held.span, locals)
		if (span.kind !== "column") {
			return
		}
		const just = comparing(columnTypes(node.heading, [span.column]))
		const point = valueRep(held.point, locals)
		if (point.kind === "fixed") {
			fds.pin([], span.column, joinJustifications([point.fact.just, just]))
		} else if (point.kind === "column") {
			fds.pin([point.column], span.column, just)
		} else {
			const outer = columnRefs(held.point).filter((r) => r.node !== inputId)
			fds.pin(
				readColumns(held.point, inputId),
				span.column,
				joinJustifications([justify({ outer }), just])
			)
		}
	}
	const equate = (c: ScalarExpr): void => {
		const operands = equalityOperands(c)
		if (operands === undefined) {
			return
		}
		const x = valueRep(operands[0], locals)
		const y = valueRep(operands[1], locals)
		const eqJust = comparing(
			columnTypes(
				node.heading,
				[x, y].flatMap((r) => (r.kind === "column" ? [r.column] : []))
			)
		)
		if (x.kind === "column" && y.kind === "column") {
			fds.equate(x.column, y.column, eqJust)
		}
		for (const [col, other] of [
			[x, y],
			[y, x]
		] as const) {
			if (col.kind === "column" && other.kind === "fixed") {
				fixColumn(s, col.column, joinJustifications([other.fact.just, eqJust]), other.fact)
			}
		}
	}
	const held = heldPoints(conjuncts(node.pred))
	for (const { pred: c, held: points } of held) {
		for (const h of points) {
			pin(h)
		}
		equate(c)
	}
	const empty = held.some(({ pred: c }) => isFalse(c))
	return finish(node, cx, {
		fds,
		fixed: s.fixed,
		maxCard: empty ? atMost(0n) : input.maxCard,
		dedup: placed,
		losses: plainLosses(input)
	})
}

/**
 * A semi-join or anti-join keeps the left's keys and multiplicity. A right column fixed per evaluation fixes the left
 * column a semi-join equates it with, unless it varies with a row of the semi-join's own inputs (a correlated EXISTS):
 * it is then fixed only per left row.
 */
const semiProps = (
	node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
	cx: RuleContext
): PhysicalProps => {
	const left = cx.props(node.left)
	const s = inheritSame(node, left)
	if (node.kind === "SemiJoin") {
		fixFromRight(node, cx, s)
	}
	return finish(node, cx, {
		fds: s.fds,
		fixed: s.fixed,
		maxCard: left.maxCard,
		dedup: placed,
		losses: plainLosses(left)
	})
}

const fixFromRight = (node: NodeOf<"SemiJoin">, cx: RuleContext, s: FixedState): void => {
	const right = cx.props(node.right)
	const inner = subtreeLabels(node)
	for (const pair of node.on) {
		const [first, ...others] = (right.fixed.get(pair.right) ?? []).filter(
			(f) => resolveOuter(f.just, (n) => inner.has(n)).bound.length === 0
		)
		if (first !== undefined) {
			fixColumn(s, pair.left, first.just, first)
			for (const f of others) {
				recordFact(s.fixed, pair.left, f)
			}
		}
	}
}

/** A take keeps its input's keys, its correlation's fixed values fix their columns, and a literal bound caps its rows. */
const takeProps = (node: NodeOf<"Take">, cx: RuleContext): PhysicalProps => {
	const input = cx.props(node.input)
	const s = inheritSame(node, input)
	const locals = new Set([node.input.id])
	for (const c of node.correlation) {
		const r = valueRep(c.expr, locals)
		if (r.kind === "fixed") {
			fixColumn(s, c.column, r.fact.just, r.fact)
		}
	}
	const maxCard = leastCardinality([
		input.maxCard,
		node.bound.kind === "literal" ? atMost(node.bound.k) : unbounded
	])
	return finish(node, cx, {
		fds: s.fds,
		fixed: s.fixed,
		maxCard,
		dedup: placed,
		losses: plainLosses(input)
	})
}

/**
 * A node of at most one fact by construction: a context, its one row or none (lower/conservative/claims), and a
 * membership's row, the one fact its caller names.
 */
const atMostOneFact = (node: RelNode, cx: RuleContext): PhysicalProps => {
	return finish(node, cx, {
		fds: new DependencyDraft(node.heading.map((c) => c.name)),
		fixed: new Map(),
		dedup: placed,
		maxCard: atMost(1n),
		losses: []
	})
}

/**
 * The physical uniqueness inference rules, one per node kind.
 *
 * Each rule computes what a node's SQL delivers when it is realized plainly, or under the exact deduplication its
 * realization names, from its inputs' physical properties alone:
 *
 * - Base: each declared key the catalog backs with an installed constraint (evidence.ts); nothing else about the
 *   table is assumed. A derived relation's keys are its view's unique indexes (inheritedDerivedKey).
 * - Closed: canonical finite facts, distinct under native equality, with their distinct-valued columns as keys
 *   (finiteFacts). InputSet: its complete heading, deduplicated on entry (deduplicatedInput); a membership's row, one
 *   fact by construction, at most one row. Delta: its relation's immediate keys.
 * - MatchRegion: an occurrence is identified when its source's table, embedded over the variables it binds, reaches
 *   its row, constants and columns fixed per evaluation included, and a candidate is a key when it identifies every
 *   occurrence (a key from each input jointly identifies a pair; a left key alone survives only with at most one
 *   matching right row). Unbound key columns lose the key (projectedKeyLoss).
 * - Filter keeps its input's keys and can fix key components. ProjectSet keeps a key whose every column
 *   is copied, equal to a copied column, fixed, or injectively represented (injective.ts).
 * - SemiJoin and AntiJoin keep the left's keys and multiplicity. Intersect and Difference, in their set
 *   forms, establish the whole heading; in an ALL form they keep a unique side's keys.
 * - Union: a candidate is a key when it is a key of every arm and every two arms are told apart by a literal both
 *   fix on one of its columns, which every arm carries at the union's type, so the arms' coerced rows are pairwise
 *   disjoint; as UNION it also establishes the whole heading.
 * - Take and the other bounded or ordered forms keep their input's keys; take(1) is at most one row.
 * - Group and OrderedSetAggregate: the complete grouping key. Window adds partition plus ordinal for
 *   row_number. Produce keeps its input's carried keys, a span difference or pack with its produced
 *   span. Recursive under UNION, and its SelfRef working table, are their whole state; the Recursive
 *   only through its own UNION, which is therefore never proved redundant.
 * - A lateral source's keys and fixed columns hold per outer row: their justifications name the outer
 *   columns they vary with, and the region binding those columns turns them into dependencies on its variables.
 * - Attach is its parent unchanged; Forbid its violation query.
 *
 * Every node realized with an exact duplicate-eliminating operator also has its whole heading as a key
 * (exactDeduplication), and a node proved to have at most one row has the empty key. A key is an identification in
 * the node's dependency table (fds.ts Dependencies), never one entry of a list of keys.
 */
export const physicalPropsOf = (node: RelNode, cx: RuleContext): PhysicalProps => {
	switch (node.kind) {
		case "Base":
			return baseProps(node, cx)
		case "Closed":
			return closedProps(node, cx)
		case "InputSet": {
			const input = node.input
			if (input.kind === "row") {
				return atMostOneFact(node, cx)
			}
			const columns = node.heading.map((c) => c.name)
			const fds = new DependencyDraft(columns)
			fds.identify(
				columns,
				withReason(
					joinJustifications([
						justify({
							premises: [paramPremise(inputSetPlaceholder(input)), nodePremise(node.id)]
						}),
						comparing(node.heading.map((c) => c.type))
					]),
					["deduplicatedInput"]
				)
			)
			return finish(node, cx, {
				fds,
				fixed: new Map(),
				dedup: placed,
				maxCard: unbounded,
				losses: []
			})
		}
		case "Context":
			return atMostOneFact(node, cx)
		case "Delta":
			return deltaProps(node, cx)
		case "MatchRegion":
			return regionProps(node, cx)
		case "Filter":
			return filterProps(node, cx)
		case "ProjectSet":
			return projectProps(node, cx)
		case "SemiJoin":
		case "AntiJoin":
			return semiProps(node, cx)
		case "Intersect":
		case "Difference": {
			const left = cx.props(node.left)
			const s = inheritSame(node, left)
			let maxCard = left.maxCard
			if (node.kind === "Intersect") {
				const right = cx.props(node.right)
				inherit(s.fds, s.fixed, right, sameName(s.fds), "right", row)
				maxCard = leastCardinality([left.maxCard, right.maxCard])
			}
			return finish(node, cx, {
				fds: s.fds,
				fixed: s.fixed,
				maxCard,
				dedup: placed,
				losses: plainLosses(left)
			})
		}
		case "Union":
			return unionProps(node, cx)
		case "Take":
			return takeProps(node, cx)
		case "Group":
		case "OrderedSetAggregate":
			return groupProps(node, cx)
		case "Window": {
			const input = cx.props(node.input)
			const s = inheritSame(node, input)
			if (node.fn === "rowNumber") {
				s.fds.identify(
					[...node.partition, node.out],
					withReason(ownPremise(node), ["uniqueOrdinal"])
				)
			}
			return finish(node, cx, {
				fds: s.fds,
				fixed: s.fixed,
				maxCard: input.maxCard,
				dedup: placed,
				losses: plainLosses(input)
			})
		}
		case "Produce":
			return produceProps(node, cx)
		case "Recursive":
		case "SelfRef": {
			const recursive = node.kind === "Recursive" ? node.id : node.recursive
			const columns = node.heading.map((c) => c.name)
			const fds = new DependencyDraft(columns)
			const closure = (cx.placed(recursive) ?? defaultRealizationOf("Recursive")) === "distinct"
			const just = withReason(
				joinJustifications([
					justify({ premises: [nodePremise(recursive)] }),
					comparing(node.heading.map((c) => c.type))
				]),
				["globalRecursiveClosure"]
			)
			/**
			 * The recursive UNION is the Recursive node's own exact duplicate elimination: its whole state is a key
			 * only through that realization (finish), never a proof that the UNION is redundant, which would be
			 * circular and would admit recursive UNION ALL. The working table a SelfRef reads is deduplicated by
			 * the recursive UNION, which stays in place.
			 */
			const working = node.kind === "SelfRef" && closure
			if (working) {
				fds.identify(columns, just)
			}
			return finish(node, cx, {
				fds,
				fixed: new Map(),
				dedup: node.kind === "Recursive" ? { kind: "recursiveUnion", just } : placed,
				maxCard: unbounded,
				losses: [
					closure
						? {
								reason: "globalRecursiveClosure",
								detail: "only the recursive UNION removes repeated states"
							}
						: {
								reason: "globalRecursiveClosure",
								detail: "recursive feedback without UNION repeats states"
							}
				]
			})
		}
		case "ApproximateNearest":
		case "OrderedResult": {
			const input = cx.props(node.kind === "ApproximateNearest" ? node.source : node.input)
			const s = inheritSame(node, input)
			const maxCard =
				node.kind === "ApproximateNearest"
					? leastCardinality([input.maxCard, atMost(node.take)])
					: input.maxCard
			return finish(node, cx, {
				fds: s.fds,
				fixed: s.fixed,
				maxCard,
				dedup: placed,
				losses: plainLosses(input)
			})
		}
		case "Attach":
		case "Forbid": {
			const input = cx.props(node.kind === "Attach" ? node.parent : node.violation)
			return {
				...input,
				node: node.id,
				kind: node.kind,
				realization: realizationOf(cx.placed, node)
			}
		}
	}
}

/**
 * A scan's declared key, installed as `constraint` and justified by `just`, over the scan's `columns`: it identifies
 * the scan's row and determines its columns, and, for a nonoverlap key, its other columns and one point of each of its
 * spans determine the row's columns too, since at most one fact's spans hold them.
 */
const declareKey = (
	fds: DependencyDraft,
	columns: ReadonlyArray<string>,
	constraint: KeyConstraint,
	just: Justification
): void => {
	const k = constraint.columns
	fds.imply(k, columns, just)
	fds.identify(k, just)
	if (constraint.spans.length > 0) {
		fds.implyAt(
			k.filter((c) => !constraint.spans.includes(c)),
			constraint.spans,
			columns,
			just
		)
	}
}

/**
 * A world relation's keys are what its definition proves (annotate rewrote them from analysis/derived/world.ts):
 * the view's own, which hold at every statement, as its definition's base keys and groups do, and which no
 * constraint installs, so they rest on the node itself. A catalog key of the same name belongs to another
 * relation.
 */
const baseProps = (node: NodeOf<"Base">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	const losses: Array<Loss> = []
	const declared = [node.primaryKey, ...node.keys]
	for (const [i, k] of declared.entries()) {
		if (node.relationKind === "world") {
			const just = withReason(
				joinJustifications([
					justify({ premises: [nodePremise(node.id)], context: "immediate" }),
					comparing(columnTypes(node.heading, k))
				]),
				["inheritedDerivedKey"]
			)
			fds.imply(k, columns, just)
			fds.identify(k, just)
			continue
		}
		const constraint = cx.catalog.keyConstraint(node.relation, k, {
			primary: i === 0,
			derived: node.relationKind === "derived"
		})
		if (constraint === undefined) {
			losses.push({
				reason: "unknownEvidence",
				detail: "a declared key has no installed constraint"
			})
			continue
		}
		const just = withReason(
			joinJustifications([
				justify(keyEvidence(constraint)),
				comparing(columnTypes(node.heading, k))
			]),
			[node.relationKind === "derived" ? "inheritedDerivedKey" : "retainedPrimaryKey"]
		)
		declareKey(fds, columns, constraint, just)
	}
	return finish(node, cx, {
		fds,
		fixed: new Map(),
		maxCard: unbounded,
		dedup: placed,
		losses
	})
}

const closedProps = (node: NodeOf<"Closed">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	const fixed = new Map<string, FixedFacts>()
	const rows = node.rows
	const facts = withReason(justify({ premises: [nodePremise(node.id)], context: "queryLocal" }), [
		"finiteFacts"
	])
	const rowKeys = new TupleMap<ReadonlyArray<EqualityKey>, ReadonlyArray<TypedLiteral>>()
	for (const r of rows) {
		rowKeys.set(
			r.map((v) => nativeEqualityKey(v)),
			r
		)
	}
	if (rowKeys.size === rows.length) {
		fds.identify(columns, joinJustifications([facts, comparing(node.heading.map((c) => c.type))]))
	}
	for (const [i, { name: c, type }] of node.heading.entries()) {
		const literals = closedColumn(node, i)
		const values = literals.map(nativeEqualityKey)
		if (new Set(values).size === values.length && rows.length > 0) {
			const just = joinJustifications([facts, comparing([type])])
			fds.identify([c], just)
			fds.imply([c], columns, just)
		}
		const [literal] = literals
		const [key] = values
		if (literal !== undefined && key !== undefined && new Set(values).size === 1) {
			fds.fix(c, facts)
			fixed.set(c, [{ fixed: { kind: "literal", literal, key }, just: facts }])
		}
	}
	return finish(node, cx, {
		fds,
		fixed,
		maxCard: atMost(BigInt(rows.length)),
		dedup: placed,
		losses: [
			{ reason: "finiteFacts", detail: "two declared facts are equal under native equality" }
		]
	})
}

/**
 * A Delta: one side of a relation's change, read in its write's transaction from the carrier the write filled. Each of
 * the relation's keys is a key of it, since delta.added(R) lies in R after the change and delta.removed(R) in R before
 * it. The carrier holds the primary key as its own constraint (write/carriers relationCarrier), checked at each
 * statement's end, so a carrier that came to hold one fact twice, or two facts at one key, refuses the write with
 * 23505 before anything reads it.
 */
const deltaProps = (node: NodeOf<"Delta">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	for (const [i, k] of node.keys.entries()) {
		const constraint = cx.catalog.keyConstraint(node.relation, k, {
			primary: i === 0,
			derived: false
		})
		if (constraint === undefined) {
			continue
		}
		const just = withReason(
			joinJustifications([
				justify(keyEvidence(constraint)),
				comparing(columnTypes(node.heading, k))
			]),
			["retainedPrimaryKey"]
		)
		declareKey(fds, columns, constraint, just)
	}
	return finish(node, cx, {
		fds,
		fixed: new Map(),
		dedup: placed,
		maxCard: unbounded,
		losses: [{ reason: "unknownEvidence", detail: "no admissible key of the written relation" }]
	})
}

/**
 * A rule region.
 *
 * A column fixed to one column of this region equals it. Every occurrence identified identifies the region's row: a key
 * from each occurrence jointly identifies a tuple of them, and a key reached only through another occurrence's
 * variables is a one-to-one join (fds.ts annotateJoin).
 */
const regionProps = (node: NodeOf<"MatchRegion">, cx: RuleContext): PhysicalProps => {
	const varType = new Map(node.vars.map((v) => [v.name, v.type]))
	const universe = node.vars.map((v) => v.name)
	const fds = new DependencyDraft(universe)
	const fixed = new Map<string, FixedFacts>()
	const locals = new Set<NodeId>([node.id, ...node.occurrences.map((o) => o.source.id)])
	const joined: Array<JoinedOccurrence> = []
	const losses: Array<Loss> = []
	const cards: Array<Cardinality> = []
	const eqJust = (vars: ReadonlyArray<string>) =>
		comparing(
			vars.flatMap((v) => {
				const t = varType.get(v)
				return t === undefined ? [] : [t]
			})
		)
	/** The variable a column of a local node is bound to: the region's own column, or an occurrence's binding. */
	const varOf = (n: NodeId, column: string): string | undefined => {
		if (n === node.id) {
			return universe.includes(column) ? column : undefined
		}
		const [occ, ...others] = node.occurrences.filter((o) => o.source.id === n)
		if (occ === undefined || others.length > 0) {
			return undefined
		}
		return occ.bindings.find((x) => x.column === column)?.var.name
	}
	/** The variable a fixed value is bound to where it is a column of a local node bound to one: an outer value's. */
	const equalVar = (value: Fixed): string | undefined => {
		switch (value.kind) {
			case "outer":
				return varOf(value.node, value.column)
			case "literal":
			case "param":
			case "expr":
				return undefined
		}
	}
	const fixVar = (v: string, fact: FixedFact): void => {
		fixColumn({ fds, fixed }, v, fact.just, fact)
	}
	const inside = subtreeLabels(node)
	/**
	 * A fact of an occurrence's source may vary with rows of this region: a lateral source reads the region's heading
	 * or an earlier occurrence's source. It then holds per value of the variables those columns are bound to, which
	 * join the fact's determinants, and it no longer varies with them (fixing a component is valid only within the
	 * evaluation it is fixed for). Undefined when such a column is bound to no variable: the fact then holds for no
	 * value this region knows, and is dropped.
	 */
	const localize = (
		just: Justification
	): { readonly vars: ReadonlyArray<string>; readonly just: Justification } | undefined => {
		const r = resolveOuter(just, (n) => inside.has(n))
		const vars: Array<string> = []
		for (const o of r.bound) {
			const v = varOf(o.node, o.column)
			if (v === undefined) {
				return undefined
			}
			if (!vars.includes(v)) {
				vars.push(v)
			}
		}
		return { vars, just: r.just }
	}
	/**
	 * An occurrence's facts, its source's table embedded under the namespace of its place among the region's
	 * occurrences, which no other occurrence of the region shares.
	 */
	const occurrence = (o: NodeOf<"MatchRegion">["occurrences"][number], place: number): void => {
		const src = cx.props(o.source)
		/**
		 * A key identifies the source's row within one evaluation, so it determines the variables the scan binds only
		 * together with what the evaluation varies with; nothing when that is a column bound to no variable.
		 */
		const evaluation = localize(evaluationReads(o.source))
		cards.push(src.maxCard)
		const colVar = new Map<string, string>()
		const bind = (column: string, v: string): void => {
			const prior = colVar.get(column)
			if (prior !== undefined) {
				fds.equate(prior, v, eqJust([prior, v]))
			} else {
				colVar.set(column, v)
			}
		}
		for (const b of o.bindings) {
			bind(b.column, b.var.name)
		}
		/**
		 * Source columns known per evaluation of the region given the variables listed (none when fixed outright), and
		 * the variables a lateral constant equals.
		 */
		const known = new Map<
			string,
			{ readonly vars: ReadonlyArray<string>; readonly just: Justification }
		>()
		/**
		 * A column fixed to the value `f` names: the variable it is bound to is fixed by it where it holds outright, and
		 * determined by the variables it is known from otherwise, and where the value is a column of this region's own
		 * nodes, the variable bound to the one determines the variable bound to the other, the two being one value; a
		 * column bound to no variable is known per evaluation.
		 */
		const fixedColumn = (c: string, f: FixedFact): void => {
			const l = localize(f.just)
			if (l === undefined) {
				return
			}
			const v = colVar.get(c)
			if (v === undefined) {
				known.set(c, l)
				return
			}
			if (l.vars.length === 0) {
				fixVar(v, f)
				return
			}
			const just = joinJustifications([l.just, eqJust([v, ...l.vars])])
			fds.imply(l.vars, [v], just)
			const equal = equalVar(f.fixed)
			if (equal !== undefined) {
				fds.imply([v], [equal], just)
			}
		}
		/**
		 * Each constant, its column equal to its value under the column's native equality, as its value is represented
		 * among the region's columns.
		 */
		const constants = o.constants.map((c) => ({
			column: c.column,
			rep: valueRep(c.expr, locals)
		}))
		/** A constant a column of the region gives binds its column to that column's variable. */
		const bindConstant = (c: (typeof constants)[number]): void => {
			if (c.rep.kind !== "column") {
				return
			}
			const v = varOf(c.rep.node, c.rep.column)
			if (v !== undefined) {
				bind(c.column, v)
			}
		}
		/**
		 * A constant fixed per evaluation fixes its column as a fact of the source does (fixedColumn), on the column's
		 * equality with it: so a bound column's variable is fixed by it too, read after every constant has bound its
		 * column. A column bound to no variable is known per evaluation from what the value is known from.
		 */
		const fixConstant = (c: (typeof constants)[number]): void => {
			if (c.rep.kind !== "fixed") {
				return
			}
			const fact = c.rep.fact
			const v = colVar.get(c.column)
			if (v === undefined) {
				const l = localize(fact.just)
				if (l !== undefined) {
					known.set(c.column, l)
				}
				return
			}
			fixedColumn(c.column, {
				fixed: fact.fixed,
				just: joinJustifications([fact.just, eqJust([v])])
			})
		}
		for (const c of constants) {
			bindConstant(c)
		}
		for (const c of constants) {
			fixConstant(c)
		}
		/**
		 * Each further value the source fixes a column to names the variable's value too, where it holds outright: the
		 * variable is fixed by it where nothing fixed it yet.
		 */
		const furtherFact = (c: string, f: FixedFact): void => {
			const l = localize(f.just)
			const v = colVar.get(c)
			if (l === undefined || v === undefined || l.vars.length > 0) {
				return
			}
			if (fixed.has(v)) {
				recordFact(fixed, v, f)
			} else {
				fixVar(v, f)
			}
		}
		for (const [c, [first, ...others]] of src.fixed) {
			fixedColumn(c, first)
			for (const f of others) {
				furtherFact(c, f)
			}
		}
		/**
		 * The occurrence's own row, which its source's identifications reach once embedded over the variables it binds:
		 * a column bound to a variable reads as that variable, a column known per evaluation as a hidden attribute of
		 * the occurrence determined by what it is known from, any other as a hidden attribute nothing determines. A
		 * dependency of a lateral source holds per value of the variables its outer columns are bound to (localize),
		 * which join its determinants, so a key per evaluation identifies the row only together with the outer row it
		 * was evaluated for.
		 */
		const ns = `occurrence${place}`
		const occurrenceRow = hiddenIn(ns, row)
		for (const [c, k] of known) {
			if (!colVar.has(c)) {
				fds.implyWithin(ns, k.vars, [hiddenIn(ns, c)], k.just)
			}
		}
		fds.embed(src.dependencies, {
			namespace: ns,
			column: (c) => {
				const v = colVar.get(c)
				return v === undefined ? [] : [{ column: v, just: structural }]
			},
			row: occurrenceRow,
			localize: (just) => {
				const l = localize(just)
				return l === undefined ? undefined : { from: l.vars, just: l.just }
			}
		})
		const scanVars = [...new Set(colVar.values())]
		if (evaluation !== undefined) {
			fds.implyWithin(ns, [occurrenceRow, ...evaluation.vars], scanVars, evaluation.just)
		}
		joined.push({ row: occurrenceRow, origin: [ns] })
		if (src.dependencies.proof([...colVar.keys(), ...known.keys()]) === undefined) {
			losses.push(
				src.uniqueness.kind === "none"
					? src.uniqueness.losses[0]
					: {
							reason: "projectedKeyLoss",
							detail: "an occurrence leaves a column of every key unbound"
						}
			)
		}
	}
	for (const [place, o] of node.occurrences.entries()) {
		occurrence(o, place)
	}
	const correlate = (c: NodeOf<"MatchRegion">["correlated"][number]): void => {
		const v = c.var.name
		const r = valueRep(c.expr, locals)
		if (r.kind === "column") {
			const w = varOf(r.node, r.column)
			if (w !== undefined) {
				fds.equate(v, w, eqJust([v, w]))
			}
			return
		}
		if (r.kind !== "fixed") {
			return
		}
		const l = localize(r.fact.just)
		if (l === undefined) {
			return
		}
		if (l.vars.length === 0) {
			fixVar(v, r.fact)
		} else {
			fds.imply(l.vars, [v], l.just)
		}
	}
	for (const c of node.correlated) {
		correlate(c)
	}
	for (const e of node.equalities) {
		const a = e.a.name
		const b = e.b.name
		fds.equate(a, b, eqJust([a, b]))
	}
	if (joined.length > 0) {
		fds.identifyByJoin(joined, structural)
	}
	const draft: Draft = {
		fds,
		fixed,
		maxCard: productCardinality(cards),
		dedup: placed,
		losses:
			losses.length > 0
				? losses
				: [
						{
							reason: "projectedKeyLoss",
							detail: "a variable an occurrence's key binds is not delivered"
						}
					]
	}
	return finish(node, cx, draft)
}

/** The input column an output expression injectively represents, with the coercions it passes through. */
const injectiveColumn = (
	e: ScalarExpr,
	input: NodeId
): { readonly column: string; readonly coercions: ReadonlyArray<CoercionIdentity> } | undefined => {
	if (e.kind === "column") {
		return e.column.node === input ? { column: e.column.name, coercions: [] } : undefined
	}
	if (e.kind !== "cast" && e.kind !== "domainCast") {
		return undefined
	}
	const [arg] = e.args
	const inner = injectiveColumn(arg, input)
	if (inner === undefined) {
		return undefined
	}
	if (e.kind === "domainCast") {
		return { column: inner.column, coercions: [...inner.coercions, `domain:${typeLabel(e.type)}`] }
	}
	if (!castInjective(arg.type, e.type)) {
		return undefined
	}
	return { column: inner.column, coercions: [...inner.coercions, castIdentity(arg.type, e.type)] }
}

const projectProps = (node: NodeOf<"ProjectSet">, cx: RuleContext): PhysicalProps => {
	const input = cx.props(node.input)
	const inputId = node.input.id
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	const fixed = new Map<string, FixedFacts>()
	const locals = new Set([inputId])
	const reps = new Map<string, Array<Rep>>()
	/** A computed output, the input columns it reads, and what else it varies with: the outer columns it reads. */
	const computed: Array<{
		readonly out: string
		readonly reads: ReadonlyArray<string>
		readonly just: Justification
	}> = []
	let noninjective = false
	for (const o of node.out) {
		const inj = injectiveColumn(o.expr, inputId)
		if (inj !== undefined) {
			const just =
				inj.coercions.length === 0
					? structural
					: withReason(justify({ coercions: inj.coercions }), ["injectiveRepresentation"])
			reps.set(inj.column, [...(reps.get(inj.column) ?? []), { column: o.name, just }])
			continue
		}
		const r = valueRep(o.expr, locals)
		if (r.kind === "fixed") {
			fds.fix(o.name, r.fact.just)
			fixed.set(o.name, [r.fact])
			continue
		}
		noninjective = true
		computed.push({
			out: o.name,
			reads: readColumns(o.expr, inputId),
			just: justify({ outer: columnRefs(o.expr).filter((c) => c.node !== inputId) })
		})
	}
	/** Copies of equal input columns are equal; inherit maps the rest. */
	const repsOf = (c: string): ReadonlyArray<Rep> => reps.get(c) ?? []
	inherit(fds, fixed, input, repsOf, "input", row)
	/** The columns a computed column is determined by, and why; none when a column it reads is not represented. */
	const determinants = (
		c: (typeof computed)[number]
	):
		| { readonly from: ReadonlyArray<string>; readonly just: ReadonlyArray<Justification> }
		| undefined => {
		const from: Array<string> = []
		const just: Array<Justification> = [c.just]
		for (const r of c.reads) {
			const f = input.fixed.get(r)
			if (f !== undefined) {
				just.push(f[0].just)
				continue
			}
			const rep = repsOf(r)[0]
			if (rep === undefined) {
				return undefined
			}
			from.push(rep.column)
		}
		return { from, just }
	}
	for (const c of computed) {
		const d = determinants(c)
		if (d !== undefined) {
			fds.imply(d.from, [c.out], joinJustifications(d.just))
		}
	}
	const losses: ReadonlyArray<Loss> =
		input.uniqueness.kind === "none"
			? input.uniqueness.losses
			: noninjective
				? [
						{
							reason: "noninjectiveExpression",
							detail: "a key column is replaced by a noninjective expression"
						}
					]
				: lossesOf(input, columns)
	return finish(node, cx, {
		fds,
		fixed,
		maxCard: input.maxCard,
		dedup: placed,
		losses
	})
}

/**
 * The literal a column is fixed to, with its fact's justification: the one literal among its values; none where they
 * hold no literal, or two, which no row holds at once.
 */
const literalFixed = (
	props: PhysicalProps,
	column: string
): { readonly key: EqualityKey; readonly just: Justification } | undefined => {
	const [only, ...more] = (props.fixed.get(column) ?? []).flatMap((f) =>
		f.fixed.kind === "literal" ? [{ key: f.fixed.key, just: f.just }] : []
	)
	return more.length === 0 ? only : undefined
}

/**
 * A union's row is identified when every arm identifies its own and every two arms are told apart. Each arm's table is
 * embedded under its own namespace with every column hidden: an arm's dependencies hold among its rows only, so a
 * union column determines the arm's copy of it, and nothing the arm derives flows back into the union's columns. Two
 * arms are told apart by a column each fixes to a different literal, which every arm carries at the union's own type
 * (a valid DAG's union columns have one type in every group, and a group's arms its heading), so the literals compare
 * under that type and the arms' coerced rows are pairwise disjoint.
 */
const unionProps = (node: NodeOf<"Union">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const arms = mapNonEmpty(unionArms(node.groups), (a) => ({ arm: a, props: cx.props(a) }))
	const unionType = new Map(node.heading.map((c) => [c.name, c.type]))
	const disjoint = withReason(justify({ premises: [nodePremise(node.id)] }), ["disjointArms"])
	const fds = new DependencyDraft(columns)
	const fixed = new Map<string, FixedFacts>()
	for (const c of columns) {
		/** Each value the first arm fixes the column to that every arm does, with every arm's fact of it. */
		const [first, ...others] = (arms[0].props.fixed.get(c) ?? []).flatMap(
			(f): ReadonlyArray<FixedFact> => {
				if (f.fixed.kind === "expr") {
					return []
				}
				const facts = arms.map((a) =>
					a.props.fixed.get(c)?.find((g) => fixedEqual(g.fixed, f.fixed))
				)
				return facts.every((g) => g !== undefined)
					? [{ fixed: f.fixed, just: joinJustifications(facts.map((g) => g.just)) }]
					: []
			}
		)
		if (first !== undefined) {
			fds.fix(c, first.just)
			fixed.set(c, [first, ...others])
		}
	}
	const identifiedBy: Array<string> = []
	for (const [i, a] of arms.entries()) {
		const ns = `arm${i}`
		fds.embed(a.props.dependencies, {
			namespace: ns,
			column: () => [],
			row: hiddenIn(ns, row),
			localize: asTheyAre
		})
		for (const c of a.props.columns) {
			if (unionType.has(c)) {
				fds.imply([c], [hiddenIn(ns, c)], structural)
			}
		}
		identifiedBy.push(hiddenIn(ns, row))
	}
	for (const [i, x] of arms.entries()) {
		for (const [j, y] of arms.entries()) {
			if (j <= i) {
				continue
			}
			const apart = hiddenIn(`apart${i}.${j}`, row)
			for (const c of columns) {
				const type = unionType.get(c)
				const lx = literalFixed(x.props, c)
				const ly = literalFixed(y.props, c)
				if (type !== undefined && lx !== undefined && ly !== undefined && lx.key !== ly.key) {
					fds.imply([c], [apart], joinJustifications([lx.just, ly.just, comparing([type])]))
				}
			}
			identifiedBy.push(apart)
		}
	}
	fds.identify(identifiedBy, arms.length > 1 ? disjoint : structural)
	const maxCard = sumCardinality(arms.map((a) => a.props.maxCard))
	const nonUnique = arms.find((a) => !isUnique(a.props))
	return finish(node, cx, {
		fds,
		fixed,
		maxCard,
		dedup: placed,
		losses:
			nonUnique === undefined
				? [
						{
							reason: "overlappingArms",
							detail: "two arms are not told apart by a retained literal discriminant"
						}
					]
				: plainLosses(nonUnique.props)
	})
}

/**
 * Only the group key is carried from the input: an aggregate output may reuse the name of an input column that is
 * not a key, and carries none of its facts.
 */
const groupProps = (
	node: NodeOf<"Group"> | NodeOf<"OrderedSetAggregate">,
	cx: RuleContext
): PhysicalProps => {
	const input = cx.props(node.input)
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	const fixed = new Map<string, FixedFacts>()
	inherit(
		fds,
		fixed,
		input,
		(c) => (node.keys.includes(c) && fds.has(c) ? [{ column: c, just: structural }] : []),
		"input",
		hiddenIn("input", row)
	)
	const just = withReason(
		joinJustifications([ownPremise(node), comparing(columnTypes(node.heading, node.keys))]),
		["groupedOutputKey"]
	)
	fds.imply(
		node.keys,
		columns.filter((c) => !node.keys.includes(c)),
		just
	)
	fds.identify(node.keys, just)
	return finish(node, cx, {
		fds,
		fixed,
		maxCard: node.keys.length === 0 ? atMost(1n) : unbounded,
		dedup: placed,
		losses: []
	})
}

/**
 * One intersection per input fact keeps the input's carried keys: each of its rows is one of the input's. The pieces
 * of a difference or a pack are several per input fact, told apart by the produced span.
 */
const produceProps = (node: NodeOf<"Produce">, cx: RuleContext): PhysicalProps => {
	const input = cx.props(node.input)
	const columns = node.heading.map((c) => c.name)
	const fds = new DependencyDraft(columns)
	const fixed = new Map<string, FixedFacts>()
	const carried = (c: string): ReadonlyArray<Rep> =>
		node.carried.includes(c) && fds.has(c) ? [{ column: c, just: structural }] : []
	const inputRow = node.producer === "spanIntersection" ? row : hiddenIn("input", row)
	inherit(fds, fixed, input, carried, "input", inputRow)
	if (node.producer !== "spanIntersection") {
		fds.identify([inputRow, node.out], justify({ premises: [nodePremise(node.id)] }))
	}
	return finish(node, cx, {
		fds,
		fixed,
		maxCard: node.producer === "spanIntersection" ? input.maxCard : unbounded,
		dedup: placed,
		losses: lossesOf(input, columns)
	})
}
