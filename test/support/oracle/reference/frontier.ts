import { Array as Arr, Option, Record as Rec, Result } from "effect"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import { type ColumnRef, exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { exprsOf, type NodeOf, type RelNode, type VarDecl } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	type CatalogResult,
	type EvalEnv,
	evaluate
} from "#test/support/oracle/evaluate/catalog.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import { type ParentKeys, rootParentKeys } from "#test/support/oracle/reference/deliver.ts"
import {
	columnKey,
	noBindings,
	type Reference,
	type Relation,
	patternMember,
	tupleOf
} from "#test/support/oracle/reference/evaluate.ts"

import {
	agreedOutcome,
	declined,
	equal,
	literalOf,
	possibleOutcomes,
	type ReadingObserver,
	possibleValues,
	type CarrierRead,
	isExecutionFailure,
	Unstated,
	type Value,
	valueKey
} from "#test/support/oracle/reference/values.ts"

/** An expression's outcome over one input row under every evaluation order PostgreSQL may choose. */
type Must =
	| { readonly kind: "value"; readonly value: Value }
	| { readonly kind: "fail"; readonly codes: ReadonlySet<string> }
	| { readonly kind: "maybe" }

const maybe: Must = { kind: "maybe" }

const failMust = (codes: Iterable<string>): Must => ({ kind: "fail", codes: new Set(codes) })

/**
 * A row's columns, each its outcome on the row: a stored or computed value, or, for a projected column a chain of
 * projections defines (forcedFailure), what its own expression gives; undefined for a column the row does not bind.
 * Its readings of merged values go to the reference's observer.
 */
interface Env {
	readonly column: (ref: ColumnRef) => Must | undefined
	readonly param: (id: ParamId) => Value | undefined
	readonly reading: ReadingObserver
}

/** A row's columns from their values. */
const valueColumns =
	(lookup: (ref: ColumnRef) => Value | undefined) =>
	(ref: ColumnRef): Must | undefined => {
		const v = lookup(ref)
		return v === undefined ? undefined : { kind: "value", value: v }
	}

/**
 * The Compute evaluator's row environment over `env`, each column's value read through `read` (values.ts, the one rule
 * for unstated values). A caller evaluates a node only where every column it reads has a value (mustEval answers
 * otherwise), so any other column is none.
 */
const rowEnv = (env: Env, read: CarrierRead): EvalEnv => ({
	kind: "row",
	column: (ref) => {
		const m = env.column(ref)
		return m?.kind === "value" ? read(columnKey(ref), m.value) : undefined
	},
	param: (id) => {
		const v = env.param(id)
		return v instanceof Unstated ? undefined : v
	},
	regexMember: patternMember
})

/** An AND (`decisive` false) or an OR (`decisive` true) over its operands' outcomes, in every evaluation order. */
const connective = (decisive: boolean, outcomes: ReadonlyArray<Must>): Must => {
	if (Arr.some(outcomes, (o) => o.kind === "value" && o.value === decisive)) {
		return Arr.every(outcomes, (o) => o.kind === "value")
			? { kind: "value", value: decisive }
			: maybe
	}
	const failed = Arr.flatMap(outcomes, (o) => (o.kind === "fail" ? [...o.codes] : []))
	if (failed.length > 0) {
		return failMust(failed)
	}
	if (Arr.some(outcomes, (o) => o.kind === "maybe")) {
		return maybe
	}
	return { kind: "value", value: !decisive }
}

/** The codes of the first of `exprs` that fails in every evaluation order under `env`. */
const firstFailing = (
	exprs: ReadonlyArray<ScalarExpr>,
	env: Env
): Option.Option<ReadonlySet<string>> =>
	Arr.findFirst(exprs, (e) => {
		const outcome = mustEval(e, env)
		return outcome.kind === "fail" ? Option.some(outcome.codes) : Option.none()
	})

/**
 * The outcome of `id` in every order: AND and OR are evaluated in no promised order (a top-level conjunct may be
 * pushed into a scan, and the planner orders quals by cost), CASE evaluates its condition and then one branch, and
 * every other node evaluates all its operands before it computes.
 *
 * A column is its outcome on the row. A declined term's value is PostgreSQL's alone, so what reads it may or may not
 * fail; a merged numeric's is read by the one rule for unstated values (values.ts) where a node reads it.
 *
 * A definite decisive operand decides, unless another operand may raise first.
 */
const mustEval = (expr: ScalarExpr, env: Env): Must => {
	if (expr.kind === "column") {
		const m = env.column(expr.column)
		if (m !== undefined) {
			return m.kind === "value" && declined(m.value) ? maybe : m
		}
	}
	const args = (): Array<Must> => Arr.map(expr.args, (a: ScalarExpr) => mustEval(a, env))
	if (expr.kind === "op") {
		const op = nativeOp(expr.op)
		if (op?.fn === "and" || op?.fn === "or") {
			return connective(op.fn === "or", args())
		}
	}
	if (expr.kind === "cond") {
		const [p, t, e] = expr.args
		const c = mustEval(p, env)
		if (c.kind !== "value") {
			return c
		}
		return mustEval(c.value === true ? t : e, env)
	}
	const outcomes = args()
	const failed = Arr.flatMap(outcomes, (o) => (o.kind === "fail" ? [...o.codes] : []))
	if (failed.length > 0) {
		return failMust(failed)
	}
	if (Arr.some(outcomes, (o) => o.kind === "maybe")) {
		return maybe
	}
	/**
	 * Every operand is a definite value: the node's own evaluation decides, its operands recomputed alike, read by the
	 * one rule for unstated values (values.ts). An outcome every spelling of the merged numerics it reads gives is
	 * certain; any other may or may not fail, as a node the oracle declines (oracle/evaluate/catalog.ts declinedOps) may.
	 */
	const agreed = agreedOutcome(
		possibleOutcomes((read) => evaluate(expr, rowEnv(env, read)), env.reading),
		expr.type
	)
	switch (agreed.kind) {
		case "value":
			return { kind: "value", value: agreed.value }
		case "failure":
			return failMust(agreed.codes)
		case "open":
			return maybe
	}
}

/** The parameter values of a case as the evaluator reads them. */
const paramEnv =
	(params: Readonly<Record<string, GenParam>>) =>
	(id: ParamId): Value | undefined => {
		const p = Rec.has(params, id) ? params[id] : undefined
		return p?.kind === "scalar" ? literalOf(p.value, p.type) : undefined
	}

/** Whether an expression reads a column: a constant one is folded at plan time, row or no row. */
const readsColumn = (expr: ScalarExpr): boolean => expr.deps.nodes.length > 0

export interface ForcedFailure {
	readonly codes: ReadonlySet<string>
	readonly node: NodeId
	/**
	 * Where the failing node is: on the delivery's own spine, or in an attachment's child, whose statement must fail.
	 */
	readonly where:
		| { readonly kind: "spine" }
		| { readonly kind: "attachment"; readonly attach: NodeId }
}

/**
 * A failure every correct lowering must meet: an expression on the delivery's fully consumed spine that fails, in
 * every evaluation order, on a row the definition computes, or one met below a projection of constants alone before
 * its input delivers a first row. The definition of every input on the spine is evaluated lazily; an input whose own
 * evaluation fails hands the question to its own inputs.
 */
export const forcedFailure = (
	ref: Reference,
	root: RelNode,
	params: Readonly<Record<string, GenParam>>
): Option.Option<ForcedFailure> => {
	const param = paramEnv(params)
	const rowsOf = (node: RelNode) => {
		try {
			return ref.eval(node, noBindings)
		} catch (e) {
			if (isExecutionFailure(e)) {
				return undefined
			}
			throw e
		}
	}
	/** The projections `chain` defines, by label: a column reference to one of them is its output's expression. */
	type Chain = ReadonlyMap<NodeId, NodeOf<"ProjectSet">>
	const none: Chain = new Map()
	/**
	 * A row of `input` read as its tuple, every column of a projection of `chain` evaluated lazily by its own expression
	 * over that row (see the header).
	 */
	const rowOf = (
		input: RelNode,
		rel: Relation,
		chain: Chain,
		row: Relation["rows"][number]
	): Env => {
		const tuple = tupleOf(rel, row)
		const env: Env = {
			column: (columnRef) => {
				const p = chain.get(columnRef.node)
				if (p === undefined) {
					return valueColumns((r) => (r.node === input.id ? tuple : undefined)?.get(r.name))(
						columnRef
					)
				}
				return Option.match(
					Arr.findFirst(p.out, (o) => o.name === columnRef.name),
					{
						onNone: () => undefined,
						onSome: (out) => mustEval(out.expr, env)
					}
				)
			},
			param,
			reading: ref.input.observer.reading
		}
		return env
	}
	/** The forced expressions of `exprs` over each row of `input` (rowOf). */
	const check = (
		node: RelNode,
		input: RelNode,
		chain: Chain,
		exprs: ReadonlyArray<ScalarExpr>
	): Option.Option<ForcedFailure> => {
		if (exprs.length === 0) {
			return Option.none()
		}
		const rel = rowsOf(input)
		if (rel === undefined) {
			return Option.none()
		}
		return Arr.findFirst(rel.rows, (row): Option.Option<ForcedFailure> =>
			Option.map(firstFailing(exprs, rowOf(input, rel, chain, row)), (codes) => ({
				codes,
				node: node.id,
				where: { kind: "spine" }
			}))
		)
	}
	/**
	 * A failure `node` meets before it delivers its first row, whichever row PostgreSQL reaches first: a filter whose
	 * predicate fails in every order on every row of its input, which holds one at least, or whose input meets one; a
	 * projection whose input meets one, its outputs read by nothing; a group whose input meets one, since a group
	 * delivers nothing before it reads an input row (one with keys emits a group from its rows, one without reads its
	 * whole input); a union no arm of which delivers a row without meeting one, one arm meeting one at least. A join
	 * meets none here: PostgreSQL may skip one side's rows when the other side is empty. Each SQLSTATE a first row
	 * could raise is the failure's.
	 */
	const firstRowFailure = (node: RelNode): Option.Option<ForcedFailure> => {
		switch (node.kind) {
			case "Filter": {
				const rel = rowsOf(node.input)
				if (rel === undefined) {
					return firstRowFailure(node.input)
				}
				const failing = Arr.map(rel.rows, (row) =>
					firstFailing([node.pred], rowOf(node.input, rel, none, row))
				)
				return Arr.isReadonlyArrayNonEmpty(failing) && Arr.every(failing, Option.isSome)
					? Option.some({
							codes: new Set(Arr.flatMap(Arr.getSomes(failing), (codes) => [...codes])),
							node: node.id,
							where: { kind: "spine" }
						})
					: Option.none()
			}
			case "ProjectSet":
			case "Group":
				return firstRowFailure(node.input)
			case "Union": {
				const arms = Arr.flatMap(node.groups, (g) => g.arms)
				const met = Arr.map(arms, (arm) =>
					Option.match(firstRowFailure(arm), {
						onSome: (f): Option.Option<Option.Option<ForcedFailure>> => Option.some(Option.some(f)),
						onNone: () =>
							rowsOf(arm)?.rows.length === 0 ? Option.some(Option.none()) : Option.none()
					})
				)
				const failures = Arr.getSomes(Arr.getSomes(met))
				const [first] = failures
				return first !== undefined && Arr.every(met, Option.isSome)
					? Option.some({
							codes: new Set(Arr.flatMap(failures, (f) => [...f.codes])),
							node: first.node,
							where: { kind: "spine" }
						})
					: Option.none()
			}
			case "AntiJoin":
			case "ApproximateNearest":
			case "Attach":
			case "Base":
			case "Closed":
			case "Context":
			case "Delta":
			case "Difference":
			case "Forbid":
			case "InputSet":
			case "Intersect":
			case "MatchRegion":
			case "OrderedResult":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "SemiJoin":
			case "Take":
			case "Window":
				return Option.none()
		}
	}
	/** The columns of `node` the expressions read, through the projections of `chain`. */
	const reads = (
		exprs: ReadonlyArray<ScalarExpr>,
		node: RelNode,
		chain: Chain
	): ReadonlyArray<string> => {
		const out = new Set<string>()
		const queue = [...exprs]
		for (const e of queue) {
			if (e.kind === "column" && e.column.node === node.id) {
				out.add(e.column.name)
			}
			const through =
				e.kind === "column"
					? Option.flatMap(Option.fromUndefinedOr(chain.get(e.column.node)), (p) =>
							Arr.findFirst(p.out, (o) => o.name === e.column.name)
						)
					: Option.none()
			queue.push(...Option.toArray(Option.map(through, (o) => o.expr)), ...e.args)
		}
		return [...out]
	}
	/** The chain of projections from `top` down through every projection it reads, and the node below them. */
	const chainOf = (
		top: NodeOf<"ProjectSet">
	): { readonly chain: Chain; readonly below: RelNode } => {
		const chain = new Map<NodeId, NodeOf<"ProjectSet">>([[top.id, top]])
		let below: RelNode = top.input
		while (below.kind === "ProjectSet") {
			chain.set(below.id, below)
			below = below.input
		}
		return { chain, below }
	}
	/**
	 * `live` names the columns of `id` the answer observes: a computed column nothing above reads may be pruned, and
	 * PostgreSQL drops an unused subquery output itself. The walk stops at the first filter: its predicate is forced
	 * on its input rows, but any filter above a node may be pushed below it and drop rows before its expressions run.
	 */
	const walk = (node: RelNode, live: ReadonlySet<string>): Option.Option<ForcedFailure> => {
		const all = (n: RelNode) => new Set(Arr.map(n.heading, (c) => c.name))
		switch (node.kind) {
			case "Attach":
				return walk(node.parent, all(node.parent))
			case "OrderedResult":
				return walk(node.input, all(node.input))
			case "Filter":
				return check(node, node.input, none, [node.pred])
			case "ProjectSet": {
				/**
				 * The delivered outputs through the chain of projections they read (see the header). A projection of
				 * constants alone is a DISTINCT over constants, which PostgreSQL may answer with a LIMIT 1: the rows below
				 * are consumed in full only when some output reads a column of them, and otherwise until the first, so
				 * only a failure met before any row is delivered is forced there (firstRowFailure).
				 */
				const outs = Arr.map(
					Arr.filter(node.out, (o) => live.has(o.name)),
					(o) => o.expr
				)
				const { chain, below } = chainOf(node)
				const read = reads(outs, below, chain)
				if (read.length === 0) {
					return firstRowFailure(below)
				}
				return Option.orElse(check(node, below, chain, outs), () => walk(below, new Set(read)))
			}
			case "Group": {
				if (node.heading.length === 0) {
					return Option.none()
				}
				const aggs = Arr.filter(node.aggs, (a) => live.has(a.name))
				const args = Arr.flatMap(aggs, (a) => a.args)
				return Option.orElse(check(node, node.input, none, args), () =>
					walk(node.input, new Set([...node.bound, ...reads(args, node.input, none)]))
				)
			}
			case "Union":
				return Arr.findFirst(
					Arr.flatMap(node.groups, (g) => g.arms),
					(arm) => walk(arm, node.discriminant.length > 0 ? all(arm) : live)
				)
			case "AntiJoin":
			case "ApproximateNearest":
			case "Base":
			case "Closed":
			case "Context":
			case "Delta":
			case "Difference":
			case "Forbid":
			case "InputSet":
			case "Intersect":
			case "MatchRegion":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "SemiJoin":
			case "Take":
			case "Window":
				return Option.none()
		}
	}
	const spine = walk(root, new Set(Arr.map(root.heading, (c) => c.name)))
	if (Option.isSome(spine)) {
		return spine
	}
	const parents = (() => {
		try {
			return rootParentKeys(ref, root)
		} catch (e) {
			if (isExecutionFailure(e)) {
				return []
			}
			throw e
		}
	})()
	return Arr.findFirst(parents, (p) => attachmentFailure(ref, p, param))
}

/**
 * The forced failure of one attachment's statement: its child's top node, through any attachment of the child's own
 * (whose rows are its parent's), checked on the child input rows that correlate with each delivered parent key.
 *
 * A projection of constants alone may be answered with a LIMIT 1, as on the spine.
 */
const attachmentFailure = (
	ref: Reference,
	p: ParentKeys,
	param: (id: ParamId) => Value | undefined
): Option.Option<ForcedFailure> => {
	let top = p.attach.child
	while (top.kind === "Attach") {
		top = top.parent
	}
	const node: NodeOf<"ProjectSet"> | NodeOf<"Filter"> | undefined =
		top.kind === "ProjectSet" || top.kind === "Filter" ? top : undefined
	if (node === undefined) {
		return Option.none()
	}
	if (node.kind === "ProjectSet" && !Arr.some(node.out, (o) => readsColumn(o.expr))) {
		return Option.none()
	}
	/**
	 * The expression delivering a child column over the top node's input tuple, and the expressions the top node needs.
	 */
	const delivering = (name: string): Option.Option<ScalarExpr> =>
		node.kind === "ProjectSet"
			? Option.map(
					Arr.findFirst(node.out, (o) => o.name === name),
					(o) => o.expr
				)
			: Option.none()
	const needed =
		node.kind === "Filter"
			? [node.pred]
			: Arr.map(
					Arr.filter(node.out, (o) => o.expr.kind !== "column"),
					(o) => o.expr
				)
	if (needed.length === 0) {
		return Option.none()
	}
	return Arr.findFirst(p.keys, ({ key, scope }) => {
		const rel = (() => {
			try {
				return ref.eval(node.input, scope)
			} catch (e) {
				if (isExecutionFailure(e)) {
					return undefined
				}
				throw e
			}
		})()
		if (rel === undefined) {
			return Option.none()
		}
		return Arr.findFirst(rel.rows, (row): Option.Option<ForcedFailure> => {
			const input = tupleOf(rel, row)
			const env: Env = {
				column: valueColumns((r) =>
					(r.node === node.input.id ? input : scope.get(r.node))?.get(r.name)
				),
				param,
				reading: ref.input.observer.reading
			}
			/** A child column's value on this row: a projection's output, or a filter's input column. */
			const childValue = (name: string): Must =>
				Option.match(delivering(name), {
					onSome: (expr) => mustEval(expr, env),
					onNone: (): Must => {
						const v = input.get(name)
						return v === undefined ? maybe : { kind: "value", value: v }
					}
				})
			const correlates = Arr.every(p.attach.correlation, (c) => {
				const at = Arr.findFirstIndex(p.heading, (h) => h.name === c.parent)
				if (Option.isNone(at)) {
					return false
				}
				const parentValue = key[at.value]
				const column = p.heading[at.value]
				if (parentValue === undefined || column === undefined) {
					return false
				}
				const outcome = childValue(c.child)
				return outcome.kind === "value" && equal(outcome.value, parentValue, column.type)
			})
			if (!correlates) {
				return Option.none()
			}
			return Option.map(firstFailing(needed, env), (codes) => ({
				codes,
				node: node.id,
				where: { kind: "attachment", attach: p.attach.id }
			}))
		})
	})
}

/**
 * The values a column of a node can carry, over-approximated, or undefined when they are unknown: every value a row
 * may hold there (values.ts possibleValues), a merged numeric each of its spellings.
 */
type Domain = ReadonlyArray<CarrierValue> | undefined

/** The columns whose domains a domain's derivation is computing, outermost first. */
type Visiting = ReadonlyArray<{ readonly node: RelNode; readonly name: string }>

const productLimit = 20_000

export interface PossibleFailures {
	/** Every SQLSTATE some expression could raise on some value PostgreSQL could feed it. */
	readonly codes: ReadonlySet<string>
}

/**
 * The SQLSTATEs an expression raises on its own, beside its operands': its native operation's, a checked cast's, a
 * domain cast's check violation.
 */
const ownFailures = (expr: ScalarExpr): ReadonlyArray<string> => {
	switch (expr.kind) {
		case "op":
			return Arr.filter(nativeOp(expr.op)?.failures ?? [], (c) => c !== "null")
		case "cast": {
			if (!expr.checked) {
				return []
			}
			return ["22003", "0A000"]
		}
		case "domainCast":
			return ["23514"]
		case "column":
		case "cond":
		case "literal":
		case "param":
		case "value":
			return []
	}
}

/**
 * A value's spelling beside its identity: a primitive's text, and a Decimal's or Money's own text, which keeps a
 * numeric's display scale; a span or a vector has no spelling beyond its identity.
 */
const spellingOf = (v: CarrierValue): string => {
	if (typeof v !== "object") {
		return String(v)
	}
	return v instanceof Decimal || v instanceof Money ? v.toString() : ""
}

/** The distinct values, by identity and spelling. */
const dedupe = (
	values: ReadonlyArray<CarrierValue>,
	type: ScalarType
): ReadonlyArray<CarrierValue> => {
	const seen = new Map<string, CarrierValue>()
	for (const v of values) {
		const k = `${valueKey(v, type)}|${spellingOf(v)}`
		if (!seen.has(k)) {
			seen.set(k, v)
		}
	}
	return [...seen.values()]
}

/**
 * The error frontier of a case: whether PostgreSQL must fail, may fail, or must deliver rows. Rewrites must preserve
 * whether an error happens wherever the answer needs the failing value: removing a relation, pruning a column or moving
 * an expression past a LIMIT that stops early must not hide a failure the conservative lowering meets.
 *
 * A query whose expressions can fail has three possible answers on a given state, and the reference decides which a
 * correct lowering may give:
 *
 * - **must fail**: an expression whose value the answer needs fails, so every lowering raises one of the SQLSTATEs the
 *   query's expressions can raise. The needed expressions are those on the delivery's fully consumed spine: a
 *   delivered projection's computed columns, a filter's predicate, a group's aggregate arguments, on every node from
 *   the root down through attachments' parents, ordered results, filters, projections that deliver a computed column,
 *   nonempty groups and union arms. Below a take (a LIMIT may stop early), an existence test's right side (EXISTS
 *   stops at the first match) or a join's other occurrences (a merge join may stop when one input ends), PostgreSQL may
 *   legitimately never evaluate a row, so a failure there is not certain. A predicate's AND and OR are not evaluated
 *   in a promised order (the language promises neither left-to-right evaluation nor that a filtered-out expression is
 *   never evaluated), so a conjunct that fails on a row whose other conjunct is false may or may not
 *   fail; only a failure every evaluation order meets counts. An attachment's statement must fail too where its
 *   child's top node (a delivered projection's computed columns, or a filter's predicate) fails on a child input row
 *   that correlates with a delivered parent key: the statement needs that row's value, whatever join or lateral
 *   evaluation computes it. A child row whose correlated columns fail or are unknown correlates with nothing certain.
 * - **may fail**: PostgreSQL could evaluate some expression on some value combination where it fails, even if the
 *   definition never does: a pushed-down predicate meets rows a join would drop or the right arm of an intersection or
 *   a difference, a CASE branch's constant is folded at plan time, an aggregate's partial sums overflow in some input
 *   order. The values an expression could meet are over-approximated per column from the facts, parameters and
 *   literals the column can carry (an aggregate's result, or a recursion's state, is unknown, so any expression over it
 *   may fail with any code its operation raises).
 * - otherwise **rows**: no expression can fail on anything PostgreSQL could feed it, and every lowering must deliver
 *   exactly the reference's rows.
 *
 * The SQLSTATE a lowering raises must be one the query's own expressions can raise on those values.
 *
 * Factoring invariance: a projection of a projection is the projection of the composed expressions, π_g ∘ π_f =
 * π_(g ∘ f), errors included. Where a failing expression of f stands in the query does not change what the answer
 * needs: a column of f that g reads only in a CASE branch is needed on the rows that take that branch, as the same CASE
 * over f's expression written inline is, and PostgreSQL's own subquery pull-up evaluates it there. So the needed
 * expressions of a chain of projections are judged through the chain: each delivered output evaluated lazily over the
 * rows below the chain, every projected column it reads defined by its own expression.
 *
 * What every expression of the DAG could raise on the values its columns could carry.
 *
 * An aggregate that accumulates in its argument's type can overflow on the way, in some input order, even where its
 * final value fits: sum over money, real and double precision, and the floats' avg (float8_accum's sums).
 */
export const possibleFailures = (
	ref: Reference,
	params: Readonly<Record<string, GenParam>>
): PossibleFailures => {
	const dag = ref.dag
	/** The nodes a column reference names by label, gathered by one walk for this call. */
	const labelled = nodesByLabel(dag)
	const param = paramEnv(params)
	const codes = new Set<string>()
	/**
	 * A column's domain, unknown where its own derivation reaches it again: every column on such a cycle is unknown,
	 * since an unknown part makes every domain built from it unknown.
	 */
	const domain = (node: RelNode, name: string, visiting: Visiting): Domain =>
		Arr.some(visiting, (v) => v.node === node && v.name === name)
			? undefined
			: computeDomain(node, name, [...visiting, { node, name }])
	const union = (parts: ReadonlyArray<Domain>, type: ScalarType): Domain => {
		const out: Array<CarrierValue> = []
		for (const p of parts) {
			if (p === undefined) {
				return undefined
			}
			out.push(...p)
		}
		return dedupe(out, type)
	}
	/** The values of a column a reference names, unknown when it names no node of the DAG. */
	const columnDomain = (ref: ColumnRef, visiting: Visiting): Domain => {
		const node = labelled.get(ref.node)
		return node === undefined ? undefined : domain(node, ref.name, visiting)
	}
	/** The values of a scalar expression over the product of its columns' domains, failures left out. */
	const exprDomain = (expr: ScalarExpr, visiting: Visiting): Domain => {
		const leaves = columnLeaves(expr)
		const domains: Array<ReadonlyArray<CarrierValue>> = []
		for (const l of leaves) {
			const d = columnDomain(l, visiting)
			if (d === undefined) {
				return undefined
			}
			domains.push(d)
		}
		/**
		 * A failure leaves its row's value out. A value the oracle declines is PostgreSQL's alone, and one it does not
		 * evaluate is not stated, so a domain that would hold either is unknown.
		 */
		const results: Array<CatalogResult> = []
		const ok = enumerate(leaves, domains, (env) => {
			results.push(evaluate(expr, env))
		})
		const unknown = Arr.some(results, (r) => Result.isFailure(r) && r.failure.kind !== "failure")
		const out = Arr.flatMap(results, (r) => (Result.isSuccess(r) ? [r.success] : []))
		return ok && !unknown ? dedupe(out, expr.type) : undefined
	}
	/** A stored relation's column: every value its rows may hold there, none known when one is not. */
	const storedDomain = (node: RelNode, name: string, type: ScalarType): Domain => {
		try {
			const rel = ref.eval(node, noBindings)
			const i = Arr.findFirstIndex(rel.heading, (c) => c.name === name)
			if (Option.isNone(i)) {
				return undefined
			}
			const each = Arr.map(rel.rows, (r) => {
				const v = r[i.value]
				return v === undefined ? [] : possibleValues(v)
			})
			const known = Arr.flatMap(each, (values) => (values === undefined ? [] : [values]))
			return known.length !== each.length ? undefined : dedupe(known.flat(), type)
		} catch {
			return undefined
		}
	}
	/** A region's variable: the union of the columns it binds and those of the variables it is equated with. */
	const regionDomain = (
		node: NodeOf<"MatchRegion">,
		name: string,
		visiting: Visiting,
		type: ScalarType
	): Domain => {
		const v = Arr.findFirst(node.vars, (d) => d.name === name)
		if (Option.isNone(v)) {
			return undefined
		}
		const bound = (variable: VarDecl): ReadonlyArray<Domain> =>
			Arr.flatMap(node.occurrences, (o) =>
				Arr.map(
					Arr.filter(o.bindings, (b) => b.var === variable),
					(b) => domain(o.source, b.column, visiting)
				)
			)
		const parts = [
			...bound(v.value),
			...Arr.flatMap(node.equalities, (e) =>
				e.a === v.value ? bound(e.b) : e.b === v.value ? bound(e.a) : []
			)
		]
		if (Arr.some(node.correlated, (c) => c.var === v.value)) {
			return undefined
		}
		return parts.length === 0 ? undefined : union(parts, type)
	}
	/**
	 * PostgreSQL pushes a predicate above a set operation into both of its arms, so the predicate meets the
	 * right arm's values too: a projected constant there is folded at plan time, row or no row.
	 */
	const computeDomain = (node: RelNode, name: string, visiting: Visiting): Domain => {
		const column = Arr.findFirst(node.heading, (c) => c.name === name)
		if (Option.isNone(column)) {
			return undefined
		}
		const type = column.value.type
		switch (node.kind) {
			case "Base":
			case "Closed":
			case "InputSet":
				return storedDomain(node, name, type)
			case "MatchRegion":
				return regionDomain(node, name, visiting, type)
			case "Filter":
			case "Take":
			case "OrderedResult":
				return domain(node.input, name, visiting)
			case "SemiJoin":
			case "AntiJoin":
				return domain(node.left, name, visiting)
			case "Intersect":
			case "Difference":
				return union([domain(node.left, name, visiting), domain(node.right, name, visiting)], type)
			case "Attach":
				return domain(node.parent, name, visiting)
			case "ProjectSet": {
				const out = Arr.findFirst(node.out, (o) => o.name === name)
				if (Option.isNone(out)) {
					return undefined
				}
				const e = out.value.expr
				return e.kind === "column" ? columnDomain(e.column, visiting) : exprDomain(e, visiting)
			}
			case "Group":
				return node.keys.includes(name) ? domain(node.input, name, visiting) : undefined
			case "Union":
				return union(
					Arr.flatMap(node.groups, (g) =>
						Arr.some(g.heading, (c) => c.name === name)
							? Arr.map(g.arms, (arm) => domain(arm, name, visiting))
							: []
					),
					type
				)
			case "ApproximateNearest":
			case "Context":
			case "Delta":
			case "Forbid":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Window":
				return undefined
		}
	}
	/** The distinct column references under an expression, which index the product it is enumerated over. */
	const columnLeaves = (root: ScalarExpr): ReadonlyArray<ColumnRef> => {
		const out: Array<ColumnRef> = []
		const seen = new Set<string>()
		const queue = [root]
		for (const e of queue) {
			if (e.kind === "column" && !seen.has(columnKey(e.column))) {
				seen.add(columnKey(e.column))
				out.push(e.column)
			}
			queue.push(...e.args)
		}
		return out
	}
	/** The Compute evaluator's row environment over one combination of the leaves' values. */
	const comboEnv = (values: ReadonlyMap<string, CarrierValue>): EvalEnv => ({
		kind: "row",
		column: (columnRef) => values.get(columnKey(columnRef)),
		param: (id) => {
			const v = param(id)
			return v instanceof Unstated ? undefined : v
		},
		regexMember: patternMember
	})
	/** Calls `visit` with each combination of the leaves' values; false when the product is too large to enumerate. */
	const enumerate = (
		leaves: ReadonlyArray<ColumnRef>,
		domains: ReadonlyArray<ReadonlyArray<CarrierValue>>,
		visit: (env: EvalEnv) => void
	): boolean => {
		const size = Arr.reduce(domains, 1, (n, d) => n * Math.max(1, d.length))
		if (size > productLimit) {
			return false
		}
		if (Arr.some(domains, (d) => d.length === 0)) {
			return true
		}
		const pick: Array<number> = Arr.map(leaves, () => 0)
		for (;;) {
			const values = new Map<string, CarrierValue>(
				Arr.flatMap(leaves, (l, i) => {
					const v = domains[i]?.[pick[i] ?? 0]
					return v === undefined ? [] : [[columnKey(l), v] as const]
				})
			)
			visit(comboEnv(values))
			if (!advance(pick, domains)) {
				return true
			}
		}
	}
	/** The domains of `leaves`, or none when one leaf's is unknown. */
	const leafDomains = (
		leaves: ReadonlyArray<ColumnRef>
	): Option.Option<ReadonlyArray<ReadonlyArray<CarrierValue>>> => {
		const out: Array<ReadonlyArray<CarrierValue>> = []
		for (const l of leaves) {
			const d = columnDomain(l, [])
			if (d === undefined) {
				return Option.none()
			}
			out.push(d)
		}
		return Option.some(out)
	}
	/**
	 * The SQLSTATEs an expression raises on its own over every combination of its leaves' values: those the
	 * enumeration meets, and all its operation may raise where a leaf's domain is unknown, the product too large, or
	 * the host declines the node.
	 */
	const exprFailures = (expr: ScalarExpr): ReadonlyArray<string> => {
		const own = ownFailures(expr)
		if (own.length === 0) {
			return []
		}
		const leaves = columnLeaves(expr)
		const domains = leafDomains(leaves)
		if (Option.isNone(domains)) {
			return own
		}
		const raised: Array<string> = []
		const complete = enumerate(leaves, domains.value, (env) => {
			/**
			 * The node alone, its operands evaluated as they are: any operand failure is that operand's own entry. A
			 * node the host declines may raise any code its operation raises.
			 */
			const r = evaluate(expr, env)
			if (Result.isFailure(r) && r.failure.kind === "failure") {
				raised.push(r.failure.code)
			}
			if (Result.isFailure(r) && r.failure.kind === "declined") {
				raised.push(...own)
			}
		})
		return complete ? raised : [...raised, ...own]
	}
	/** Whether an aggregate accumulates values a few of which can sum past their type's range. */
	const overflows = (a: NodeOf<"Group">["aggs"][number]): boolean => {
		const e = a.args[0]
		if (e === undefined) {
			return false
		}
		const carrier = e.type.carrier
		const accumulates =
			(a.fn === "sum" && (carrier === "money" || carrier === "float4" || carrier === "float8")) ||
			(a.fn === "avg" && (carrier === "float4" || carrier === "float8"))
		if (!accumulates) {
			return false
		}
		const d = e.kind === "column" ? columnDomain(e.column, []) : exprDomain(e, [])
		return d === undefined || Arr.some(d, (v) => nearOverflow(v))
	}
	const nodes = topoOrder(dag)
	for (const expr of exprClosure(Arr.flatMap(nodes, (n) => exprsOf(n)))) {
		for (const code of exprFailures(expr)) {
			codes.add(code)
		}
	}
	for (const node of nodes) {
		if (Arr.filter(node.kind === "Group" ? node.aggs : [], overflows).length > 0) {
			codes.add("22003")
		}
	}
	return { codes }
}

/** Advances an odometer over `domains` by one, its first digit fastest: false once it wraps past its last value. */
const advance = (
	pick: Array<number>,
	domains: ReadonlyArray<ReadonlyArray<CarrierValue>>
): boolean => {
	for (let i = 0; i < pick.length; i++) {
		const d = domains[i] ?? []
		const next = (pick[i] ?? 0) + 1
		if (next < d.length) {
			pick[i] = next
			return true
		}
		pick[i] = 0
	}
	return false
}

/**
 * A value a few of which can sum past their type's range: a money amount beyond 2^58 minor units, or a float beyond
 * 2^500, whose square overflows float8_accum's sum of squares.
 */
const nearOverflow = (v: CarrierValue): boolean => {
	if (typeof v === "number") {
		return Number.isFinite(v) && Math.abs(v) > 2 ** 500
	}
	if (v instanceof Money) {
		return v.minorUnits > 2n ** 58n || v.minorUnits < -(2n ** 58n)
	}
	return false
}
