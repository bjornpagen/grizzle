import { leadingReason, type MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import { keyEvidence } from "#compiler/analysis/physical/evidence.ts"
import {
	annotatedProver,
	dependencyBound,
	type Identification,
	type Identity,
	type Implication,
	identityProver,
	type Justification,
	joinJustifications,
	justify,
	type KeyOption,
	nodePremise,
	type OuterColumn,
	type Proof,
	ProofFds,
	type Prover,
	keyCombinations,
	paramPremise,
	physicalKeys,
	type Requirement,
	resolveOuter,
	structural,
	withReason
} from "#compiler/analysis/physical/fds.ts"
import {
	type FixedFact,
	isUnique,
	keyIdentity,
	type Loss,
	type PhysicalProps,
	plainLosses,
	type Realization,
	strongestKey,
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
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
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
import { exprClosure, nativeEqualityKey, type OpId, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	closedColumn,
	exprsOf,
	type Heading,
	inputSetPlaceholder,
	inputsOf,
	type KeySet,
	type NodeOf,
	type RelKind,
	type RelNode,
	unionArms
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { chain } from "#compiler/logical/defined.ts"
import { conjuncts, type Fixed, fixedEqual, readColumns } from "#compiler/logical/props.ts"
import { nativeOp, overloadOf } from "#compiler/scalar/compute/registry.ts"

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

const equalityOp = (t: ScalarType): ReadonlyArray<OpId> => {
	const c = baseOf(t).carrier
	const op = overloadOf("eq", [c, c])
	return op === undefined ? [] : [op.id]
}

const typeIdentity = (t: ScalarType): ReadonlyArray<CoercionIdentity> => {
	const base = baseOf(t)
	const label: CoercionIdentity = `type:${typeLabel(t)}`
	return base.carrier === "text" || base.carrier === "enum"
		? [label, "collation:pg_catalog.pg_c_utf8"]
		: [label]
}

const columnTypes = (heading: Heading, columns: ReadonlyArray<string>): ReadonlyArray<ScalarType> =>
	columns.flatMap((c) => {
		const column = heading.find((x) => x.name === c)
		return column === undefined ? [] : [column.type]
	})

const comparing = (types: ReadonlyArray<ScalarType>): Justification =>
	justify({ equality: types.flatMap(equalityOp), coercions: types.flatMap(typeIdentity) })

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
			return e.deps.nodes.some((n) => locals.has(n))
				? { kind: "unknown" }
				: { kind: "fixed", fact: fixedFact(e, { kind: "expr" }, columnRefs(e)) }
	}
}

/** Finishing a node: its keys among the candidates under its prover, extended by its realization and its cardinality. */
interface Draft {
	readonly fds: ProofFds
	readonly prove: Prover
	readonly candidates: ReadonlyArray<ReadonlyArray<string>>
	readonly fixed: ReadonlyMap<string, FixedFact>
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

const finish = (node: RelNode, cx: RuleContext, draft: Draft): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const realization = realizationOf(cx.placed, node)
	const dedup =
		draft.dedup.kind === "recursiveUnion"
			? draft.dedup.just
			: withReason(
					joinJustifications([
						justify({ premises: [nodePremise(node.id)] }),
						comparing(node.heading.map((c) => c.type))
					]),
					["exactDeduplication"]
				)
	const single = boundsAtMost(draft.maxCard, 1n)
		? withReason(ownPremise(node), ["atMostOneRow"])
		: undefined
	const atMostOne: Proof | undefined = single === undefined ? undefined : () => single
	const prove: Prover = (cs) => {
		const own = draft.prove(cs)
		if (own !== undefined) {
			return own
		}
		if (realization === "distinct") {
			const d = draft.fds.closure(cs)
			if (columns.every((c) => d.columns.has(c))) {
				return () => joinJustifications([dedup, draft.fds.explain(d, columns)])
			}
		}
		return atMostOne
	}
	const keys = physicalKeys(
		columns,
		prove,
		[...draft.candidates, columns],
		draft.fds.implications()
	)
	const plain: Prover = (cs) => draft.prove(cs) ?? atMostOne
	const plainKeys =
		realization === "plain"
			? keys
			: physicalKeys(columns, plain, [...draft.candidates, columns], draft.fds.implications())
	const plainUnique = strongestKey(plainKeys)
	const maxCard = keys.some((k) => k.columns.length === 0)
		? leastCardinality([draft.maxCard, atMost(1n)])
		: draft.maxCard
	/**
	 * A column determined by nothing is fixed: to what an equal fixed column is fixed to, or to a computation. Its
	 * justification keeps the outer columns its derivation read, so it stays fixed only per outer row.
	 */
	const fixed = new Map<string, FixedFact>()
	for (const c of columns) {
		const f = draft.fixed.get(c)
		if (f !== undefined) {
			fixed.set(c, f)
		}
	}
	const determined = draft.fds.closure([])
	for (const c of columns) {
		if (!fixed.has(c) && determined.columns.has(c)) {
			fixed.set(c, { fixed: { kind: "expr" }, just: draft.fds.explain(determined, [c]) })
		}
	}
	const inHeading = new Set(columns)
	const fds: Array<Implication> = []
	for (const imp of draft.fds.implications()) {
		if (imp.from.length + imp.at.length === 0) {
			continue
		}
		if (!imp.from.every((c) => inHeading.has(c)) || !imp.at.every((c) => inHeading.has(c))) {
			continue
		}
		const to = imp.to.filter((c) => inHeading.has(c))
		if (to.length > 0) {
			fds.push({ from: imp.from, at: imp.at, to, just: imp.just })
		}
		if (fds.length >= dependencyBound) {
			break
		}
	}
	/** Why the plain form is not unique, whatever the realization adds. */
	const [loss, ...more] = draft.losses
	const losses: NonEmptyReadonlyArray<Loss> =
		loss === undefined
			? [{ reason: "unknownEvidence", detail: "no admissible evidence proves the heading" }]
			: [loss, ...more]
	/** The plain form is unique when a key proves it citing evidence an elision rule names; a proof that cites none
	 * backs no elision. */
	const lead = plainUnique === undefined ? undefined : leadingReason(plainUnique.just.reasons)
	const uniqueness: Uniqueness =
		plainUnique !== undefined && lead !== undefined
			? { kind: "plain", key: plainUnique, lead }
			: keys.length > 0
				? { kind: "realized", losses }
				: { kind: "none", losses }
	return {
		node: node.id,
		kind: node.kind,
		columns,
		keys,
		plainKeys,
		fixed,
		fds,
		maxCard,
		uniqueness,
		realization
	}
}

/** A node's dependency table and the facts its fixed columns are fixed to. */
interface FixedState {
	readonly fds: ProofFds
	readonly fixed: Map<string, FixedFact>
}

/**
 * Fixes `column` with `just`, recording `fact` as what it is fixed to unless an earlier fact already is: one that names
 * its value, or one that names none where `fact` names none either. So a column an input fixes by a computation and a
 * filter equates with a literal is fixed to the literal, as the logical analysis reads it (logical/closure.ts).
 */
const fixColumn = (
	state: FixedState,
	column: string,
	just: Justification,
	fact: FixedFact
): void => {
	state.fds.fix(column, just)
	const held = state.fixed.get(column)
	if (held === undefined || (held.fixed.kind === "expr" && fact.fixed.kind !== "expr")) {
		state.fixed.set(column, fact)
	}
}

/** A column of the node that stands for an input column, and what representing it rests on. */
interface Rep {
	readonly column: string
	readonly just: Justification
}

/**
 * Carries an input's fixed columns and dependencies into a node's dependency table through `reps`, and returns the
 * input's keys mapped onto the node's columns: a key survives when each of its columns is fixed in the input or has a
 * representative.
 */
const inherit = (
	fds: ProofFds,
	fixed: Map<string, FixedFact>,
	input: PhysicalProps,
	reps: (column: string) => ReadonlyArray<Rep>
): Requirement => {
	for (const [c, f] of input.fixed) {
		for (const r of reps(c)) {
			fixColumn({ fds, fixed }, r.column, joinJustifications([f.just, r.just]), f)
		}
	}
	for (const c of input.columns) {
		chain(reps(c), (first, other) => {
			fds.equate(first.column, other.column, joinJustifications([first.just, other.just]))
		})
	}
	const mapSide = (
		cs: ReadonlyArray<string>
	): { readonly columns: Array<string>; readonly just: Array<Justification> } | undefined => {
		const columns: Array<string> = []
		const just: Array<Justification> = []
		for (const c of cs) {
			const f = input.fixed.get(c)
			if (f !== undefined) {
				just.push(f.just)
				continue
			}
			const r = reps(c)[0]
			if (r === undefined) {
				return undefined
			}
			columns.push(r.column)
			just.push(r.just)
		}
		return { columns, just }
	}
	for (const imp of input.fds) {
		const from = mapSide(imp.from)
		/** A span fixed in the input has every point known. */
		const at = mapSide(imp.at)
		if (from === undefined || at === undefined) {
			continue
		}
		const to = imp.to.flatMap((c) => reps(c).map((r) => r.column))
		fds.implyAt(
			from.columns,
			at.columns,
			to,
			joinJustifications([imp.just, ...from.just, ...at.just])
		)
	}
	const options: Array<KeyOption> = []
	for (const k of input.keys) {
		const m = mapSide(k.columns)
		if (m !== undefined) {
			options.push({ columns: m.columns, just: joinJustifications([k.just, ...m.just]) })
		}
	}
	return options
}

const sameName =
	(fds: ProofFds) =>
	(c: string): ReadonlyArray<Rep> =>
		fds.has(c) ? [{ column: c, just: structural }] : []

/** A node's dependency table and fixed facts inherited from an input of the same columns, with the keys they offer. */
interface SameInherited extends FixedState {
	readonly options: Requirement
	/** The inherited keys' columns; a node offering more keys appends them. */
	readonly candidates: Array<KeySet>
}

/** A node whose heading carries its input's columns under the same names, with its input's evidence. */
const inheritSame = (node: RelNode, input: PhysicalProps): SameInherited => {
	const columns = node.heading.map((c) => c.name)
	const fds = new ProofFds(columns)
	const fixed = new Map<string, FixedFact>()
	const options = inherit(fds, fixed, input, sameName(fds))
	return {
		fds,
		fixed,
		options,
		candidates: options.map((o) => o.columns)
	}
}

const required = (options: Requirement): Identity => (options.length === 0 ? [] : [[options]])

const lossesOf = (
	input: PhysicalProps,
	options: Requirement,
	columns: ReadonlyArray<string>
): ReadonlyArray<Loss> =>
	input.uniqueness.kind === "none"
		? input.uniqueness.losses
		: options.length === 0
			? [{ reason: "projectedKeyLoss", detail: "every key of the input is dropped" }]
			: columns.length === 0
				? []
				: [{ reason: "projectedKeyLoss", detail: "no retained key lies within the heading" }]

/**
 * A filter keeps its input's keys and can fix key components. A span held to contain a point the input's columns, or
 * values fixed per evaluation, give has that point known.
 */
const filterProps = (node: NodeOf<"Filter">, cx: RuleContext): PhysicalProps => {
	const input = cx.props(node.input)
	const s = inheritSame(node, input)
	const fds: ProofFds = s.fds
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
		prove: identityProver(fds, required(s.options)),
		candidates: s.candidates,
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
		prove: identityProver(s.fds, required(s.options)),
		candidates: s.candidates,
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
		const f = right.fixed.get(pair.right)
		if (f !== undefined && resolveOuter(f.just, (n) => inner.has(n)).bound.length === 0) {
			fixColumn(s, pair.left, f.just, f)
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
		prove: identityProver(s.fds, required(s.options)),
		candidates: s.candidates,
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
	const fds = new ProofFds(node.heading.map((c) => c.name))
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, []),
		candidates: [],
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
 * - MatchRegion: one requirement per occurrence; an occurrence is identified when the variables bound to one of its
 *   source's keys are known, constants and columns fixed per evaluation included, and a candidate is a key when it
 *   identifies every occurrence (a key from each input jointly identifies a pair; a left key alone
 *   survives only with at most one matching right row). Unbound key columns lose the key (projectedKeyLoss).
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
 * (exactDeduplication), and a node proved to have at most one row has the empty key.
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
			const fds = new ProofFds(columns)
			const just = withReason(
				joinJustifications([
					justify({
						premises: [paramPremise(inputSetPlaceholder(input)), nodePremise(node.id)]
					}),
					comparing(node.heading.map((c) => c.type))
				]),
				["deduplicatedInput"]
			)
			return finish(node, cx, {
				fds,
				prove: identityProver(fds, [[[{ columns, just }]]]),
				candidates: [],
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
			const identity: Array<Identity[number]> = [...required(s.options)]
			let maxCard = left.maxCard
			if (node.kind === "Intersect") {
				const right = cx.props(node.right)
				const r = inherit(s.fds, s.fixed, right, sameName(s.fds))
				appendAll(identity, required(r))
				appendAll(
					s.candidates,
					r.map((o) => o.columns)
				)
				maxCard = leastCardinality([left.maxCard, right.maxCard])
			}
			return finish(node, cx, {
				fds: s.fds,
				prove: identityProver(s.fds, identity),
				candidates: s.candidates,
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
			const identity: Array<Identity[number]> = [...required(s.options)]
			if (node.fn === "rowNumber") {
				const key = [...node.partition, node.out]
				const just = withReason(ownPremise(node), ["uniqueOrdinal"])
				identity.push([[{ columns: key, just }]])
				s.candidates.push(key)
			}
			return finish(node, cx, {
				fds: s.fds,
				prove: identityProver(s.fds, identity),
				candidates: s.candidates,
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
			const fds = new ProofFds(columns)
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
			return finish(node, cx, {
				fds,
				prove: identityProver(fds, working ? [[[{ columns, just }]]] : []),
				candidates: [],
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
				prove: identityProver(s.fds, required(s.options)),
				candidates: s.candidates,
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
 * A scan's declared key, installed as `constraint` and justified by `just`: an option of the scan's identity and the
 * dependency of the row on the key's columns, and, for a nonoverlap key, on its other columns and one point of each of
 * its spans, since at most one fact's spans hold them.
 */
const declareKey = (fds: ProofFds, constraint: KeyConstraint, just: Justification): KeyOption => {
	const k = constraint.columns
	fds.imply(k, fds.universe, just)
	if (constraint.spans.length > 0) {
		fds.implyAt(
			k.filter((c) => !constraint.spans.includes(c)),
			constraint.spans,
			fds.universe,
			just
		)
	}
	return { columns: k, just }
}

/**
 * A world relation's keys are what its definition proves (annotate rewrote them from analysis/derived/world.ts):
 * the view's own, which hold at every statement, as its definition's base keys and groups do, and which no
 * constraint installs, so they rest on the node itself. A catalog key of the same name belongs to another
 * relation.
 */
const baseProps = (node: NodeOf<"Base">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const fds = new ProofFds(columns)
	const options: Array<KeyOption> = []
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
			options.push({ columns: k, just })
			fds.imply(k, fds.universe, just)
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
		options.push(declareKey(fds, constraint, just))
	}
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, required(options)),
		candidates: options.map((o) => o.columns),
		fixed: new Map(),
		maxCard: unbounded,
		dedup: placed,
		losses
	})
}

const closedProps = (node: NodeOf<"Closed">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const fds = new ProofFds(columns)
	const fixed = new Map<string, FixedFact>()
	const rows = node.rows
	const facts = withReason(justify({ premises: [nodePremise(node.id)], context: "descriptor" }), [
		"finiteFacts"
	])
	const options: Array<KeyOption> = []
	const rowKeys = rows.map((r) => r.map((v) => nativeEqualityKey(v)).join("\u0000"))
	if (new Set(rowKeys).size === rows.length) {
		options.push({
			columns,
			just: joinJustifications([facts, comparing(node.heading.map((c) => c.type))])
		})
	}
	for (const [i, { name: c, type }] of node.heading.entries()) {
		const literals = closedColumn(node, i)
		const values = literals.map(nativeEqualityKey)
		if (new Set(values).size === values.length && rows.length > 0) {
			const just = joinJustifications([facts, comparing([type])])
			options.push({ columns: [c], just })
			fds.imply([c], columns, just)
		}
		const [literal] = literals
		const [key] = values
		if (literal !== undefined && key !== undefined && new Set(values).size === 1) {
			fds.fix(c, facts)
			fixed.set(c, { fixed: { kind: "literal", literal, key }, just: facts })
		}
	}
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, required(options)),
		candidates: options.map((o) => o.columns),
		fixed,
		maxCard: atMost(BigInt(rows.length)),
		dedup: placed,
		losses: [
			{ reason: "finiteFacts", detail: "two declared facts are equal under native equality" }
		]
	})
}

const deltaProps = (node: NodeOf<"Delta">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const fds = new ProofFds(columns)
	const options: Array<KeyOption> = []
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
		options.push(declareKey(fds, constraint, just))
	}
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, required(options)),
		candidates: options.map((o) => o.columns),
		fixed: new Map(),
		dedup: placed,
		maxCard: unbounded,
		losses: [{ reason: "unknownEvidence", detail: "no admissible key of the written relation" }]
	})
}

/** A region's identification of its occurrences: a one-to-one join, or a key combined from several occurrences. */
const annotateRegion = (found: Identification): Justification => {
	const reasons: Array<MultiplicityReason> = []
	if (found.direct.some((d) => !d)) {
		reasons.push("oneToOneJoin")
	} else if (found.direct.length > 1) {
		reasons.push("combinedJoinKeys")
	}
	return withReason(found.just, reasons)
}

/**
 * A rule region.
 *
 * A column fixed to one column of this region equals it.
 */
const regionProps = (node: NodeOf<"MatchRegion">, cx: RuleContext): PhysicalProps => {
	const varType = new Map(node.vars.map((v) => [v.name, v.type]))
	const universe = node.vars.map((v) => v.name)
	const columns = node.heading.map((c) => c.name)
	const fds = new ProofFds(universe)
	const fixed = new Map<string, FixedFact>()
	const locals = new Set<NodeId>([node.id, ...node.occurrences.map((o) => o.source.id)])
	const requirements: Array<Requirement> = []
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
	const fixVar = (v: string, fact: FixedFact): void => {
		fixColumn({ fds, fixed }, v, fact.just, fact)
	}
	/**
	 * A fact of an occurrence's source may vary with rows of this region: a lateral source reads the region's heading
	 * or an earlier occurrence's source. It then holds per value of the variables those columns are bound
	 * to, which join the fact's determinants, and it no longer varies with them (fixing a component is
	 * valid only within the evaluation it is fixed for). Undefined when such a column is bound to no variable: the fact
	 * then holds for no value this region knows, and is dropped.
	 */
	const inside = subtreeLabels(node)
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
	const occurrence = (o: NodeOf<"MatchRegion">["occurrences"][number]): void => {
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
		const constant = (
			c: NodeOf<"MatchRegion">["occurrences"][number]["constants"][number]
		): void => {
			const r = valueRep(c.expr, locals)
			if (r.kind === "fixed") {
				const l = localize(r.fact.just)
				if (l !== undefined) {
					known.set(c.column, l)
				}
				return
			}
			if (r.kind !== "column") {
				return
			}
			const v = varOf(r.node, r.column)
			if (v !== undefined) {
				bind(c.column, v)
			}
		}
		for (const c of o.constants) {
			constant(c)
		}
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
			if (f.fixed.kind === "outer" && l.vars.length === 1) {
				fds.imply([v], l.vars, just)
			}
		}
		for (const [c, f] of src.fixed) {
			fixedColumn(c, f)
		}
		const mapColumns = (cs: ReadonlyArray<string>) => {
			const vars: Array<string> = []
			const just: Array<Justification> = []
			for (const c of cs) {
				const v = colVar.get(c)
				if (v !== undefined) {
					vars.push(v)
					continue
				}
				const k = known.get(c)
				if (k === undefined) {
					return undefined
				}
				appendAll(vars, k.vars)
				just.push(k.just)
			}
			return { vars: [...new Set(vars)], just }
		}
		/**
		 * The spans a dependency reads at a point: the variable each is bound to, or, for a span known per evaluation
		 * (every point of it known), what it is known from, which joins the determinants.
		 */
		const mapSpans = (spans: ReadonlyArray<string>) => {
			const at: Array<string> = []
			const vars: Array<string> = []
			const just: Array<Justification> = []
			for (const c of spans) {
				const v = colVar.get(c)
				if (v !== undefined) {
					at.push(v)
					continue
				}
				const k = known.get(c)
				if (k === undefined) {
					return undefined
				}
				appendAll(vars, k.vars)
				just.push(k.just)
			}
			return { at, vars, just }
		}
		for (const imp of src.fds) {
			const from = mapColumns(imp.from)
			const at = mapSpans(imp.at)
			const l = localize(imp.just)
			if (from === undefined || at === undefined || l === undefined) {
				continue
			}
			const to = imp.to.flatMap((c) => {
				const v = colVar.get(c)
				return v === undefined ? [] : [v]
			})
			fds.implyAt(
				[...new Set([...from.vars, ...at.vars, ...l.vars])],
				at.at,
				to,
				joinJustifications([l.just, ...from.just, ...at.just])
			)
		}
		const scanVars = [...new Set(colVar.values())]
		const options: Array<KeyOption> = []
		for (const k of src.keys) {
			const m = mapColumns(k.columns)
			const l = localize(k.just)
			if (m === undefined || l === undefined) {
				continue
			}
			/**
			 * A key per evaluation of a lateral source identifies its row only together with the outer row it was
			 * evaluated for: the key plus the correlation's identity.
			 */
			const keyColumns = [...new Set([...m.vars, ...l.vars])]
			const just = joinJustifications([l.just, ...m.just])
			options.push({ columns: keyColumns, just })
			if (evaluation !== undefined) {
				fds.imply(
					[...new Set([...keyColumns, ...evaluation.vars])],
					scanVars,
					joinJustifications([just, evaluation.just])
				)
			}
		}
		if (options.length === 0) {
			losses.push(
				src.uniqueness.kind === "none"
					? src.uniqueness.losses[0]
					: {
							reason: "projectedKeyLoss",
							detail: "an occurrence leaves a column of every key unbound"
						}
			)
		}
		requirements.push(options)
	}
	for (const o of node.occurrences) {
		occurrence(o)
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
	/** Candidates: one option per occurrence, up to the combination bound, then the heading. */
	const candidates = keyCombinations(
		requirements.map((r) => (r.length === 0 ? [[]] : r.map((o) => o.columns)))
	)
	const identity: Identity =
		requirements.some((r) => r.length === 0) || requirements.length === 0 ? [] : [requirements]
	const product = productCardinality(cards)
	/**
	 * Keys are sets of heading columns: a variable outside the heading can identify an occurrence only through one
	 * inside it.
	 */
	const prove = annotatedProver(fds, identity, annotateRegion)
	const draft: Draft = {
		fds,
		prove: (cs) => (cs.every((c) => columns.includes(c)) ? prove(cs) : undefined),
		candidates,
		fixed,
		maxCard: product,
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
	const fds = new ProofFds(columns)
	const fixed = new Map<string, FixedFact>()
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
			fixed.set(o.name, r.fact)
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
	const options = inherit(fds, fixed, input, repsOf)
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
				just.push(f.just)
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
			: noninjective && options.length === 0
				? [
						{
							reason: "noninjectiveExpression",
							detail: "a key column is replaced by a noninjective expression"
						}
					]
				: lossesOf(input, options, columns)
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, required(options)),
		candidates: options.map((o) => o.columns),
		fixed,
		maxCard: input.maxCard,
		dedup: placed,
		losses
	})
}

/** A column's fact when it is fixed to a literal. */
const literalFixed = (
	props: PhysicalProps,
	column: string
):
	| { readonly fixed: Extract<Fixed, { readonly kind: "literal" }>; readonly just: Justification }
	| undefined => {
	const f = props.fixed.get(column)
	return f?.fixed.kind === "literal" ? { fixed: f.fixed, just: f.just } : undefined
}

/**
 * The first candidate column of the union's heading on which the two arms fix different literals, with its type under
 * the union and both arms' facts.
 */
const separator = (
	cs: ReadonlyArray<string>,
	columnType: ReadonlyMap<string, ScalarType>,
	a: PhysicalProps,
	b: PhysicalProps
):
	| { readonly type: ScalarType; readonly a: Justification; readonly b: Justification }
	| undefined => {
	for (const column of cs) {
		const type = columnType.get(column)
		const x = literalFixed(a, column)
		const y = literalFixed(b, column)
		if (type !== undefined && x !== undefined && y !== undefined && x.fixed.key !== y.fixed.key) {
			return { type, a: x.just, b: y.just }
		}
	}
	return undefined
}

const unionProps = (node: NodeOf<"Union">, cx: RuleContext): PhysicalProps => {
	const columns = node.heading.map((c) => c.name)
	const arms = mapNonEmpty(unionArms(node.groups), (a) => ({ arm: a, props: cx.props(a) }))
	/** Each arm with its dependency table. */
	const members = arms.map((a) => ({ ...a, fds: armFdsOf(a.props) }))
	/**
	 * A column on which two arms fix different literals tells them apart. Every arm carries each union column at the
	 * union's own type (a valid DAG's union columns have one type in every group, and a group's arms its heading), so
	 * the literals compare under that type.
	 */
	const unionType = new Map(node.heading.map((c) => [c.name, c.type]))
	const disjoint = withReason(justify({ premises: [nodePremise(node.id)] }), ["disjointArms"])
	const armPairs = arms.flatMap((x, i) => arms.slice(i + 1).map((y) => [x.props, y.props] as const))
	/**
	 * Every arm identified by the candidate and every two arms told apart; the proof joins the arms' identifications,
	 * then each pair's separating facts.
	 */
	const proveArms: Prover = (cs) => {
		const found: Array<() => Identification> = []
		for (const m of members) {
			const identification = m.fds.identification(keyIdentity(m.props), cs)
			if (identification === undefined) {
				return undefined
			}
			found.push(identification)
		}
		const told: Array<{
			readonly type: ScalarType
			readonly a: Justification
			readonly b: Justification
		}> = []
		for (const [a, b] of armPairs) {
			const pair = separator(cs, unionType, a, b)
			if (pair === undefined) {
				return undefined
			}
			told.push(pair)
		}
		return () => {
			const justs = found.map((identification) => identification().just)
			for (const pair of told) {
				justs.push(pair.a, pair.b, comparing([pair.type]))
			}
			return joinJustifications(arms.length > 1 ? [...justs, disjoint] : justs)
		}
	}
	const fds = new ProofFds(columns)
	const fixed = new Map<string, FixedFact>()
	for (const c of columns) {
		const facts = arms.map((a) => a.props.fixed.get(c))
		const [first] = facts
		if (first === undefined || first.fixed.kind === "expr") {
			continue
		}
		if (
			facts.every((f) => f !== undefined) &&
			facts.every((f) => fixedEqual(f.fixed, first.fixed))
		) {
			const just = joinJustifications(facts.map((f) => f.just))
			fds.fix(c, just)
			fixed.set(c, { fixed: first.fixed, just })
		}
	}
	const separators = columns.filter((c) =>
		arms.every((a) => literalFixed(a.props, c) !== undefined)
	)
	const candidates = arms.flatMap((a) =>
		a.props.keys
			.filter((k) => k.columns.every((c) => columns.includes(c)))
			.map((k) => [...k.columns, ...separators])
	)
	const maxCard = sumCardinality(arms.map((a) => a.props.maxCard))
	const nonUnique = arms.find((a) => !isUnique(a.props))
	return finish(node, cx, {
		fds,
		prove: proveArms,
		candidates,
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

/** An arm's dependency table: its fixed columns and its dependencies. */
const armFdsOf = (props: PhysicalProps): ProofFds => {
	const f = new ProofFds(props.columns)
	for (const [c, x] of props.fixed) {
		f.fix(c, x.just)
	}
	for (const imp of props.fds) {
		f.implyAt(imp.from, imp.at, imp.to, imp.just)
	}
	return f
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
	const fds = new ProofFds(columns)
	const fixed = new Map<string, FixedFact>()
	inherit(fds, fixed, input, (c) =>
		node.keys.includes(c) && fds.has(c) ? [{ column: c, just: structural }] : []
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
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, [[[{ columns: node.keys, just }]]]),
		candidates: [node.keys],
		fixed,
		maxCard: node.keys.length === 0 ? atMost(1n) : unbounded,
		dedup: placed,
		losses: []
	})
}

const produceProps = (node: NodeOf<"Produce">, cx: RuleContext): PhysicalProps => {
	const input = cx.props(node.input)
	const columns = node.heading.map((c) => c.name)
	const fds = new ProofFds(columns)
	const fixed = new Map<string, FixedFact>()
	const carried = (c: string): ReadonlyArray<Rep> =>
		node.carried.includes(c) && fds.has(c) ? [{ column: c, just: structural }] : []
	const options = inherit(fds, fixed, input, carried)
	const just = justify({ premises: [nodePremise(node.id)] })
	/**
	 * One intersection per input fact keeps the input's carried keys; the pieces of a difference or a pack are told
	 * apart by the produced span.
	 */
	const keyed: ReadonlyArray<KeyOption> =
		node.producer === "spanIntersection"
			? options
			: options.map((o) => ({
					columns: [...o.columns, node.out],
					just: joinJustifications([o.just, just])
				}))
	return finish(node, cx, {
		fds,
		prove: identityProver(fds, required(keyed)),
		candidates: keyed.map((o) => o.columns),
		fixed,
		maxCard: node.producer === "spanIntersection" ? input.maxCard : unbounded,
		dedup: placed,
		losses: lossesOf(input, keyed, columns)
	})
}
