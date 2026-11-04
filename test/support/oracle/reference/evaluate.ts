import { Array as Arr, Option, Record as Rec, Result } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import {
	type ColumnRef,
	describeOp,
	exprClosure,
	type RangeOpCode,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"

import {
	type CompletedOrder,
	exprsOf,
	type Heading,
	inputsOf,
	type NodeOf,
	type RelDag,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import type { RegexRef, ScalarType } from "#compiler/ir/scalar.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { defined } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { type GenFacts, rowValues } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { aggregate } from "#test/support/oracle/reference/aggregate.ts"
import {
	asBigint,
	asSpan,
	coerce,
	compare,
	Declined,
	type DeclineReason,
	decidedKeys,
	distinctRows,
	equal,
	indexKey,
	joinedKey,
	literalOf,
	outcomeOf,
	referenceUnsupported,
	type Row,
	type Value,
	valueAt,
	valueKey
} from "#test/support/oracle/reference/values.ts"

/** The range operators an Allen atom lowers to; range_eq is also the span equality the Compute evaluator compares. */
const rangeAtoms: ReadonlySet<RangeOpCode> = new Set([
	"range_overlaps",
	"range_contains",
	"range_contained_by",
	"range_before",
	"range_after",
	"range_overleft",
	"range_overright",
	"range_adjacent",
	"range_eq"
])

/** The point-membership atom `r.pointIn` lowers to: its operands are the span, then the point (checker.ts). */
const pointAtom = "range_contains_elem"

/**
 * Membership of a text value in a regex refinement, or in a descriptor's pattern, the text package's NFA: what a domain
 * cast into a refined text type checks.
 */
export const patternMember = (regex: Pick<RegexRef, "source" | "flags">, text: string): boolean => {
	const analyzed = analyzeText(regex.source, regex.flags, SourceLoc("a regex refinement", []))
	return analyzed.ok && accepts(analyzed.value, text)
}

/** A heading with its column positions by name, built with the rows a tuple reads through it (tupleOf). */
export interface Layout {
	readonly heading: Heading
	/** Each column's position by name; a repeated name reads its last column, as a map built from the heading would. */
	readonly positions: ReadonlyMap<string, number>
}

/** A heading's layout. */
export const layoutOf = (heading: Heading): Layout => ({
	heading,
	positions: new Map(Arr.map(heading, (c, i) => [c.name, i] as const))
})

/** A relation: its heading's layout and its set of tuples, each a row of values in heading order. */
export interface Relation extends Layout {
	readonly rows: ReadonlyArray<Row>
}

/** A node's tuple, read by column name: a row of its heading, or a map from names to values. */
interface Tuple {
	get(name: string): Value | undefined
	has(name: string): boolean
}

/**
 * A predicate's value as a truth: true or false. A predicate's value the reference does not state (a declined term's,
 * values.ts) has none it states: it refuses to judge the row.
 */
const truthOf = (v: Value): boolean => {
	if (v instanceof Declined) {
		throw referenceUnsupported("a predicate over a declined term's value")
	}
	return v === true
}

/**
 * Where the reference evaluates an ApproximateNearest node: the node and its source's set under the outer tuples then in
 * scope, at every evaluation, a correlated source once per outer tuple. A source read on its own has no value where it
 * reads an outer tuple, so a test judging the candidates a search chose among (a tie at its cutoff) observes its
 * reference's and evaluates the root; every other caller ignores them.
 */
type NearestObserver = (node: NodeOf<"ApproximateNearest">, source: Relation) => void

/**
 * What a test observes of its reference's evaluation: every decline, by its reason (values.ts DeclineReason), so a
 * suite notes how often and why its reference gave up instead of judging, and every evaluation of an
 * ApproximateNearest node.
 */
export interface ReferenceObserver {
	readonly decline: (reason: DeclineReason) => void
	readonly nearest: NearestObserver
}

/** The observer of a reference no test observes. */
export const unobserved: ReferenceObserver = {
	decline: () => {},
	nearest: () => {}
}

/**
 * The bindings an expression or a correlated source sees: one tuple per node in scope. A map from node to tuple is
 * one.
 */
export interface Bindings {
	get(id: NodeId): Tuple | undefined
}

/** The outer tuples of a closed node's evaluation: none. */
export const noBindings: Bindings = new Map<NodeId, Tuple>()

/** How many fixed-point iterations a recursion may take before the reference gives up. */
export const maxIterations = 10_000

/**
 * How many region rows a scaled reference completes, in all, before it gives up (ScaledReference): copies of the facts
 * raise a region of k occurrences by the k-th power of their count, past what the host holds in memory.
 */
const scaledRegionRows = 500_000

class RowTuple implements Tuple {
	readonly #positions: ReadonlyMap<string, number>
	readonly #row: Row

	constructor(byName: ReadonlyMap<string, number>, row: Row) {
		this.#positions = byName
		this.#row = row
	}

	get(name: string): Value | undefined {
		const i = this.#positions.get(name)
		return i === undefined ? undefined : this.#row[i]
	}

	has(name: string): boolean {
		return this.#positions.has(name)
	}
}

/**
 * The tuple of a row under its heading's layout. A row shorter than its heading is a defect of the evaluator, refused
 * here as reading each of its columns would refuse it.
 */
export const tupleOf = (layout: Layout, row: Row): Tuple => {
	if (row.length < layout.heading.length) {
		valueAt(row, row.length)
	}
	return new RowTuple(layout.positions, row)
}

/** What a map holds under a key the DAG names; a missing one is a column or variable the DAG lacks. */
const lookup = <K, V>(map: { get(key: K): V | undefined }, key: K, what: string): V => {
	const v = map.get(key)
	if (v === undefined) {
		throw referenceUnsupported(what)
	}
	return v
}

/** A value a term reads; a missing one is a column or parameter value the case lacks. */
const stated = (v: Value | undefined, what: string): Value => {
	if (v === undefined) {
		throw referenceUnsupported(what)
	}
	return v
}

/** The literal at position i of a stored or parameter row the caller indexed. */
const literalAt = (row: ReadonlyArray<TypedLiteral>, i: number): TypedLiteral => {
	const l = row[i]
	if (l === undefined) {
		throw referenceUnsupported(`a row column ${i}`)
	}
	return l
}

/** The column at position i of a heading the caller indexed. */
const columnAt = (heading: Heading, i: number): Heading[number] => {
	const c = heading[i]
	if (c === undefined) {
		throw referenceUnsupported(`a heading column ${i}`)
	}
	return c
}

/** A scope extended by tuples, a later one shadowing an earlier one and every one shadowing the outer scope. */
class Extended implements Bindings {
	readonly #outer: Bindings
	readonly #entries: ReadonlyArray<readonly [NodeId, Tuple]>

	constructor(outer: Bindings, entries: ReadonlyArray<readonly [NodeId, Tuple]>) {
		this.#outer = outer
		this.#entries = entries
	}

	get(id: NodeId): Tuple | undefined {
		for (let i = this.#entries.length - 1; i >= 0; i--) {
			const entry = this.#entries[i]
			if (entry?.[0] === id) {
				return entry[1]
			}
		}
		return this.#outer.get(id)
	}
}

const bind = (scope: Bindings, entries: ReadonlyArray<readonly [NodeId, Tuple]>): Bindings =>
	new Extended(scope, entries)

export const columnIndex = (heading: Heading, name: string, at: string): number => {
	const i = Arr.findFirstIndex(heading, (c) => c.name === name)
	if (Option.isNone(i)) {
		throw referenceUnsupported(`${at}: a column ${name}`)
	}
	return i.value
}

/** A row of `from` rearranged into the column order of `to`, by name. */
const project = (from: Heading, to: Heading, row: Row, at: string): Row =>
	Arr.map(to, (c) => valueAt(row, columnIndex(from, c.name, at)))

/** project over many rows, finding each column once, at the first row, where project would first look for it. */
const projectAll = (
	from: Heading,
	to: Heading,
	rows: ReadonlyArray<Row>,
	at: string
): ReadonlyArray<Row> => {
	if (rows.length === 0) {
		return []
	}
	const index = Arr.map(to, (c) => columnIndex(from, c.name, at))
	return Arr.map(rows, (row) => Arr.map(index, (i) => valueAt(row, i)))
}

/** Whether a heading names each column once, so a position read by name is the column's only position. */
const distinctNames = (layout: Layout): boolean => layout.positions.size === layout.heading.length

/**
 * A candidate index over a set of rows: the rows by the identity of one value, in their order; none when some value
 * has no identity that agrees with native equality, so only the nested loop decides.
 */
type RowIndex = Option.Option<ReadonlyMap<string, ReadonlyArray<Row>>>

const indexRows = (
	rows: ReadonlyArray<Row>,
	width: number,
	column: number,
	type: ScalarType
): RowIndex => {
	const index = new Map<string, Array<Row>>()
	for (const row of rows) {
		const key =
			row.length < width
				? Option.none()
				: Option.flatMap(Arr.get(row, column), (v) => Option.fromUndefinedOr(indexKey(v, type)))
		if (Option.isNone(key)) {
			return Option.none()
		}
		const bucket = index.get(key.value)
		if (bucket === undefined) {
			index.set(key.value, [row])
		} else {
			bucket.push(row)
		}
	}
	return Option.some(index)
}

/** The rows of `rows` an index admits for `probe`: the bucket of its identity, or every row when it has none. */
const candidates = (
	rows: ReadonlyArray<Row>,
	index: RowIndex,
	probe: Value,
	type: ScalarType
): ReadonlyArray<Row> =>
	Option.match(index, {
		onNone: () => rows,
		onSome: (byKey) => {
			const key = indexKey(probe, type)
			return key === undefined ? rows : (byKey.get(key) ?? [])
		}
	})

/**
 * What a region occurrence binds and checks, by column position, when its source's heading names each column once
 * and holds every column the occurrence reads, and its variables are declared; undefined otherwise.
 */
export interface OccurrencePlan {
	readonly source: RelNode
	readonly width: number
	readonly bindings: ReadonlyArray<{
		readonly var: VarDecl
		readonly column: string
		readonly index: number
		readonly type: ScalarType
	}>
	readonly constants: ReadonlyArray<{
		readonly index: number
		readonly type: ScalarType
		readonly expr: ScalarExpr
	}>
	/**
	 * The binding whose value an index looks up: the first that compares with a variable an earlier occurrence bound,
	 * when every binding before it binds a variable first; a row it rejects is rejected before anything else.
	 */
	readonly probe: Option.Option<{
		readonly var: VarDecl
		readonly index: number
		readonly type: ScalarType
	}>
}

/** An equality between two of a match region's variables. */
type Equality = NodeOf<"MatchRegion">["equalities"][number]

/**
 * One pass over the pending equalities in order, each giving an unbound variable its partner's value or comparing two
 * bound ones: those still pending, or none when two bound values differ.
 */
const equatePass = (
	values: Map<VarDecl, Value>,
	pending: ReadonlyArray<Equality>
): Option.Option<ReadonlyArray<Equality>> => {
	const left: Array<Equality> = []
	for (const e of pending) {
		const a = values.get(e.a)
		const b = values.get(e.b)
		if (a !== undefined && b !== undefined && !equal(a, b, e.a.type)) {
			return Option.none()
		}
		if (a !== undefined && b !== undefined) {
			continue
		}
		if (a !== undefined) {
			values.set(e.b, a)
		} else if (b !== undefined) {
			values.set(e.a, b)
		} else {
			left.push(e)
		}
	}
	return Option.some(left)
}

/**
 * The region's variable values extended by what an occurrence's `bindings` bind, each read by `read`: a variable bound
 * again keeps its earlier value, which is the new one in its one form; none when one disagrees with it.
 */
const extended = <B extends { readonly var: VarDecl; readonly column: string }>(
	values: ReadonlyMap<VarDecl, Value>,
	bindings: ReadonlyArray<B>,
	read: (b: B) => { readonly value: Value; readonly type: ScalarType }
): Option.Option<ReadonlyMap<VarDecl, Value>> => {
	const next = new Map(values)
	for (const b of bindings) {
		const { value, type } = read(b)
		const prior = next.get(b.var)
		if (prior === undefined) {
			next.set(b.var, value)
			continue
		}
		if (!equal(prior, value, type)) {
			return Option.none()
		}
	}
	return Option.some(next)
}

const occurrencePlan = (
	o: NodeOf<"MatchRegion">["occurrences"][number],
	bound: ReadonlySet<VarDecl>
): Option.Option<OccurrencePlan> => {
	const layout = layoutOf(o.source.heading)
	if (!distinctNames(layout)) {
		return Option.none()
	}
	const { heading, positions: columns } = layout
	const bindings: Array<OccurrencePlan["bindings"][number]> = []
	for (const b of o.bindings) {
		const index = columns.get(b.column)
		if (index === undefined) {
			return Option.none()
		}
		bindings.push({ var: b.var, column: b.column, index, type: b.var.type })
	}
	const constants: Array<OccurrencePlan["constants"][number]> = []
	for (const c of o.constants) {
		const index = columns.get(c.column)
		const column = index === undefined ? undefined : heading[index]
		if (index === undefined || column === undefined) {
			return Option.none()
		}
		constants.push({ index, type: column.type, expr: c.expr })
	}
	return Option.some({
		source: o.source,
		width: heading.length,
		bindings,
		constants,
		probe: probeOf(bindings, bound)
	})
}

/**
 * The binding an index looks up: the first that compares with a variable an earlier occurrence bound, when every
 * binding before it binds a variable first.
 */
const probeOf = (
	bindings: OccurrencePlan["bindings"],
	bound: ReadonlySet<VarDecl>
): OccurrencePlan["probe"] => {
	const fresh = new Set<VarDecl>()
	for (const b of bindings) {
		if (bound.has(b.var)) {
			return Option.some({ var: b.var, index: b.index, type: b.type })
		}
		if (fresh.has(b.var)) {
			return Option.none()
		}
		fresh.add(b.var)
	}
	return Option.none()
}

/**
 * The inputs a reference needs: the schema the Base nodes name, the stored facts and the parameter values, and what its
 * test observes of the evaluation.
 */
export interface ReferenceInput {
	readonly schema: GenSchema
	readonly facts: GenFacts
	readonly params: Readonly<Record<string, GenParam>>
	readonly observer: ReferenceObserver
}

/**
 * The first k tuples in `order`, every remaining heading column ascending after it: the completed order is total over
 * a set, so the tail never decides between distinct tuples.
 */
export const sortRows = (
	heading: Heading,
	rows: ReadonlyArray<Row>,
	order: CompletedOrder
): ReadonlyArray<Row> => {
	const keys = [
		...Arr.map(order.keys, (k) => ({
			index: columnIndex(heading, k.column, "an order"),
			desc: k.dir === "desc"
		})),
		...Arr.flatMap(heading, (c, index) =>
			Arr.some(order.keys, (k) => k.column === c.name) ? [] : [{ index, desc: false }]
		)
	]
	return Arr.sort(rows, (a: Row, b: Row) => {
		for (const k of keys) {
			const c = compare(valueAt(a, k.index), valueAt(b, k.index), columnAt(heading, k.index).type)
			if (c !== 0) {
				return k.desc ? (c < 0 ? 1 : -1) : c
			}
		}
		return 0
	})
}

/**
 * An existence test's column pairs by position, when both sides' headings name each column once and hold the
 * pair's columns; the type is the left column's, which the test compares at.
 */
export interface ExistencePlan {
	readonly rightWidth: number
	readonly pairs: ReadonlyArray<{
		readonly left: number
		readonly right: number
		readonly type: ScalarType
	}>
}

const planExistence = (
	node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
	left: Layout,
	right: Layout
): Option.Option<ExistencePlan> => {
	if (!distinctNames(left) || !distinctNames(right)) {
		return Option.none()
	}
	const pairs: Array<ExistencePlan["pairs"][number]> = []
	for (const p of node.on) {
		const l = left.positions.get(p.left)
		const r = right.positions.get(p.right)
		const column = l === undefined ? undefined : left.heading[l]
		if (l === undefined || r === undefined || column === undefined) {
			return Option.none()
		}
		pairs.push({ left: l, right: r, type: column.type })
	}
	return Option.some({ rightWidth: right.heading.length, pairs })
}

/**
 * The identity of a row's values on an existence test's pairs, read at one side's positions; none when one value
 * has no identity that agrees with native equality.
 */
const pairKey = (
	row: Row,
	pairs: ExistencePlan["pairs"],
	at: (p: ExistencePlan["pairs"][number]) => number
): Option.Option<string> =>
	Option.map(
		Option.all(
			Arr.map(pairs, (p) =>
				Option.flatMap(Arr.get(row, at(p)), (v) => Option.fromUndefinedOr(indexKey(v, p.type)))
			)
		),
		joinedKey
	)

/** The identities of a right side's rows on an existence test's columns, or none when one has none. */
const existenceKeys = (
	rows: ReadonlyArray<Row>,
	plan: ExistencePlan
): Option.Option<ReadonlySet<string>> =>
	Option.map(
		Option.all(
			Arr.map(rows, (r) =>
				r.length < plan.rightWidth ? Option.none() : pairKey(r, plan.pairs, (p) => p.right)
			)
		),
		(all): ReadonlySet<string> => new Set(all)
	)

/** The nodes of a subtree through data inputs, `root` included. */
const reachOf = (root: RelNode): ReadonlySet<RelNode> => {
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const queued of queue) {
		for (const input of Arr.filter(inputsOf(queued), (i) => !seen.has(i))) {
			seen.add(input)
			queue.push(input)
		}
	}
	return seen
}

/** The labels of the nodes outside `root`'s subtree that its expressions read: the outer tuples it is correlated with. */
const freeRefsOf = (root: RelNode): ReadonlySet<NodeId> => {
	const reach = reachOf(root)
	const labels = new Set(Arr.map([...reach], (n) => n.id))
	const free = new Set<NodeId>()
	for (const expr of exprClosure(Arr.flatMap([...reach], (n) => exprsOf(n)))) {
		if (expr.kind === "column" && !labels.has(expr.column.node)) {
			free.add(expr.column.node)
		}
	}
	return free
}

/**
 * Whether a node's set depends on nothing but the case: no outer tuple and no recursion state it does not iterate
 * itself.
 */
const isClosed = (root: RelNode): boolean => {
	const reach = reachOf(root)
	const labels = new Set(Arr.map([...reach], (n) => n.id))
	return (
		freeRefsOf(root).size === 0 &&
		Arr.every([...reach], (node) => node.kind !== "SelfRef" || labels.has(node.recursive))
	)
}

/**
 * The brute-force reference evaluator: the meaning of a checked query DAG over a case's facts, computed by
 * definition on the host with set semantics.
 *
 * It shares nothing with any lowering: no SQL, no names, no plan. Every node denotes the set of its heading's tuples
 * under native equality, computed by nested loops over the facts, so it is slow and obviously right:
 *
 * - Base is the stored facts, Closed the declared ground facts, InputSet the parameter's rows deduplicated on entry;
 * - MatchRegion enumerates every combination of its occurrences' tuples, keeps those whose bindings agree, whose
 *   constants hold and whose equated variables are equal, and returns the set of complete variable bindings: unbound
 *   columns are existential witnesses and never contribute;
 * - Filter keeps the tuples whose predicate is true, ProjectSet evaluates the output tuple of each and collapses
 *   equal outputs, SemiJoin and AntiJoin keep the left tuples that have, or lack, a matching right tuple;
 * - Union, Intersect and Difference are the set operations on equal headings;
 * - Group folds each group's distinct complete bound tuples, not its rows, so equal bindings contribute once and
 *   distinct ones each contribute; an empty input creates no group, so an aggregate-only query over nothing is the
 *   empty relation, never a row of NULL or 0;
 * - Take is the first k tuples of the set under its completed total order;
 * - Recursive is the least fixed point of its step over its base, iterated until no new state appears;
 * - Window is each input tuple with its function's value over its partition in the window's order: an ordinal, a
 *   count or an extreme over the whole partition, or the neighbouring tuple's value with the default past the edge;
 * - ApproximateNearest is what an exact search finds: the `take` source tuples of least score, ties broken by the
 *   other columns ascending, one of the candidate sets an approximate index may return. The tie-break is this
 *   evaluator's, not the contract's: an oracle that compares a lowering's candidates with these must declare an
 *   equivalence equal on the tuples strictly inside the cutoff and on the count drawn from the tuples tied at it, never
 *   compare them as one exact multiset; and at PostgreSQL, where an HNSW index scan is approximate, it must assert the
 *   plan holds no such scan or declare a recall equivalence. A claim about every candidate set (a key, a bound) may be
 *   checked on this one, which is one of them;
 * - Attach is its parent's set unchanged; its children are delivered per parent tuple (deliver.ts).
 *
 * Scalar expressions are oracle/evaluate/catalog.ts, the exact evaluator of the Compute catalogue, over the bindings
 * in scope: a node's input tuple, the outer tuples a correlated source reads, and the case's parameter values.
 *
 * Every closed node's set, one that reads no outer tuple and no recursion state it does not iterate itself, is settled
 * once as the reference is made (Reference.of, settle): in topological order, each from its inputs' settled sets, into
 * the table every evaluation of the node reads. What a closed node's evaluation throws, a refusal or a defect, is kept
 * in its place and thrown wherever the node is read, so a case meets exactly the refusals of the nodes its answer
 * reads; the observer sees every closed node's evaluation once, as the reference is made. A SelfRef denotes its
 * recursion's current state, which the Recursive makes a relation once per step: the state is already a set.
 *
 * The definitions above are what it computes; how is kept from being quadratic where that changes nothing: a tuple
 * reads its row through its heading's column positions instead of being copied into a map, a scope extends its outer
 * scope instead of copying it, and a region occurrence or an existence test over a stable set (a closed node's, or the
 * recursion state a SelfRef reads) looks its candidate rows up in a hash index on the native-equality identity of one
 * join value (values.ts indexKey), built from that set as the region or the test is evaluated. An index only skips the
 * rows the nested loop would reject at that value before anything else could happen to them: the rows it does visit it
 * visits in the same order through the same checks, so results, their order, every decline observed and every refusal
 * are the nested loop's. Wherever the identity is not known to agree with native equality for the values at hand, or a
 * node is shaped outside what the faster path checks, the nested loop runs as written.
 */
export class Reference {
	readonly dag: RelDag
	readonly input: ReferenceInput
	/** Whether each node of the DAG is closed, by node. */
	readonly #closed: ReadonlyMap<RelNode, boolean>
	/** Each closed node's settled set, or what its evaluation threw, filled in topological order by settle. */
	readonly #settled = new Map<RelNode, Result.Result<Relation, unknown>>()
	/** The current state of each Recursive node being iterated, as the relation its SelfRef denotes. */
	readonly #state = new Map<NodeId, Relation>()

	protected constructor(dag: RelDag, input: ReferenceInput) {
		this.dag = dag
		this.input = input
		this.#closed = new Map(Arr.map(topoOrder(dag), (node) => [node, isClosed(node)] as const))
	}

	/** The reference of a case: its DAG's closed sets settled. */
	static of(dag: RelDag, input: ReferenceInput): Reference {
		return new Reference(dag, input).settle()
	}

	/** Settles every closed node's set, inputs first, so each reads its inputs' from the table. */
	protected settle(): this {
		for (const node of topoOrder(this.dag)) {
			if (this.closed(node)) {
				this.#settled.set(
					node,
					Result.try(() => this.relation(node, noBindings))
				)
			}
		}
		return this
	}

	/** The nodes of a subtree through data inputs, `root` included. */
	reach(root: RelNode): ReadonlySet<RelNode> {
		return reachOf(root)
	}

	/**
	 * Whether a node of the DAG has a set that depends on nothing but the case: no outer tuple and no recursion state it
	 * does not iterate itself. Such a set is settled once.
	 */
	closed(node: RelNode): boolean {
		return defined(this.#closed.get(node), `${node.id}, a node of the reference's DAG`)
	}

	/** A closed node's settled set, or none when its evaluation threw. */
	#settledSet(node: RelNode): Option.Option<Relation> {
		return Result.getSuccess(this.#settledOf(node))
	}

	#settledOf(node: RelNode): Result.Result<Relation, unknown> {
		return defined(this.#settled.get(node), `${node.id}, settled before the nodes that read it`)
	}

	/** The set a node denotes, with `scope` the outer tuples in scope. */
	eval(node: RelNode, scope: Bindings): Relation {
		if (node.kind === "SelfRef") {
			return this.state(node)
		}
		return this.closed(node) ? Result.getOrThrow(this.#settledOf(node)) : this.relation(node, scope)
	}

	/** The relation of a node computed from its rows under `scope`, the set of them where the node deduplicates. */
	relation(node: RelNode, scope: Bindings): Relation {
		const rows = this.rows(node, scope)
		return {
			...layoutOf(node.heading),
			rows: this.deduplicates(node)
				? distinctRows(rows, node.heading, `${node.kind} ${node.id}`)
				: rows
		}
	}

	/** Whether a node's relation is the set of its rows: for the reference, every node's is. */
	deduplicates(_node: RelNode): boolean {
		return true
	}

	/** The current state of a SelfRef's recursion. */
	state(node: NodeOf<"SelfRef">): Relation {
		const state = this.#state.get(node.recursive)
		if (state === undefined) {
			throw referenceUnsupported(`${node.id} outside its recursion`)
		}
		return state
	}

	/** The rows of a stable source, whose set is one at every visit of its region: a closed node's, or a recursion state. */
	#stableRows(source: RelNode): Option.Option<ReadonlyArray<Row>> {
		if (source.kind === "SelfRef") {
			return Option.map(Option.fromUndefinedOr(this.#state.get(source.recursive)), (s) => s.rows)
		}
		return this.closed(source) ? Option.map(this.#settledSet(source), (s) => s.rows) : Option.none()
	}

	param(id: ParamId): GenParam {
		const p = Rec.has(this.input.params, id) ? this.input.params[id] : undefined
		if (p === undefined) {
			throw referenceUnsupported(`a value for the parameter ${id}`)
		}
		return p
	}

	/**
	 * The value of a scalar expression, read where `scope` is in scope. An Allen atom, a range operator over two
	 * spans, and a boolean connective over one are evaluated here from the endpoints; everything else by the Compute
	 * evaluator.
	 */
	expr(e: ScalarExpr, scope: Bindings): Value {
		return Option.match(this.allen(e, scope), {
			onNone: () => this.computed(e, scope),
			onSome: (truth) => truth
		})
	}

	/**
	 * The truth of an Allen atom over two non-empty half-open spans, or of a connective whose operands reach one, by
	 * PostgreSQL's range operators: && overlaps, @> contains, <@ is contained by, << strictly left, >> strictly right,
	 * &< does not extend right of, &> does not extend left of, -|- adjacent, = equal; and of the point membership
	 * `span @> point` over the half-open span. None for anything else.
	 *
	 * Left to right, stopping at the deciding operand, as the Compute evaluator folds AND and OR.
	 */
	allen(e: ScalarExpr, scope: Bindings): Option.Option<boolean> {
		if (e.kind !== "op") {
			return Option.none()
		}
		const atom = typeof e.op === "string" ? undefined : e.op.code
		if (atom === pointAtom) {
			const [s, p] = e.args
			if (s === undefined || p === undefined) {
				throw referenceUnsupported(`${describeOp(e.op)} without a span and a point`)
			}
			const span = asSpan(this.expr(s, scope))
			const point = asBigint(this.expr(p, scope))
			return Option.some(span.start <= point && point < span.end)
		}
		if (atom !== undefined && rangeAtoms.has(atom)) {
			const [l, r] = e.args
			if (l === undefined || r === undefined) {
				throw referenceUnsupported(`${describeOp(e.op)} without two operands`)
			}
			const a = asSpan(this.expr(l, scope))
			const b = asSpan(this.expr(r, scope))
			switch (atom) {
				case "range_overlaps":
					return Option.some(a.start < b.end && b.start < a.end)
				case "range_contains":
					return Option.some(a.start <= b.start && b.end <= a.end)
				case "range_contained_by":
					return Option.some(b.start <= a.start && a.end <= b.end)
				case "range_before":
					return Option.some(a.end <= b.start)
				case "range_after":
					return Option.some(a.start >= b.end)
				case "range_overleft":
					return Option.some(a.end <= b.end)
				case "range_overright":
					return Option.some(a.start >= b.start)
				case "range_adjacent":
					return Option.some(a.end === b.start || b.end === a.start)
				case "lower(anyrange)":
				case "range_eq":
				case "range_ge":
				case "range_gt":
				case "range_le":
				case "range_lt":
				case "range_ne":
				case "upper(anyrange)":
					return Option.some(a.start === b.start && a.end === b.end)
			}
		}
		if (e.op === "not" && Arr.some(e.args, (a) => this.reachesAllen(a))) {
			const [only] = e.args
			return Option.some(!truthOf(this.expr(only, scope)))
		}
		if ((e.op === "and" || e.op === "or") && Arr.some(e.args, (a) => this.reachesAllen(a))) {
			const decisive = e.op === "or"
			return Option.some(
				Arr.some(e.args, (a) => truthOf(this.expr(a, scope)) === decisive) ? decisive : !decisive
			)
		}
		return Option.none()
	}

	/** Whether an expression is an Allen atom or a connective over one. */
	reachesAllen(e: ScalarExpr): boolean {
		if (e.kind !== "op") {
			return false
		}
		const atom = typeof e.op === "string" ? undefined : e.op.code
		if (atom !== undefined && (rangeAtoms.has(atom) || atom === pointAtom)) {
			return true
		}
		return (
			(e.op === "and" || e.op === "or" || e.op === "not") &&
			Arr.some(e.args, (a) => this.reachesAllen(a))
		)
	}

	/**
	 * The value of a term by the Compute evaluator, run once (values.ts outcomeOf): every value is in its one form, so
	 * the one run is the term's value. A term the oracle declines (oracle/evaluate/catalog.ts declinedOps), or one
	 * reading a declined term's value, is declined, its value the term's over its reads, which PostgreSQL alone
	 * computes; the decline is observed by its reason. A term that fails fails with its code.
	 *
	 * A column read is the column's value as it is: a declined term's the same value.
	 */
	computed(expr: ScalarExpr, scope: Bindings): Value {
		const param = (pid: ParamId): Value | undefined => {
			const p = this.param(pid)
			return p.kind === "scalar" ? literalOf(p.value, p.type) : undefined
		}
		const column = (ref: ColumnRef) => scope.get(ref.node)?.get(ref.name)
		if (expr.kind === "column") {
			const v = column(expr.column)
			if (v instanceof Declined) {
				return v
			}
		}
		const outcome = outcomeOf((read) =>
			evaluate(expr, {
				kind: "row",
				column: (ref) => {
					const v = column(ref)
					return v === undefined ? undefined : read(v)
				},
				param: (pid) => {
					const v = param(pid)
					return v === undefined ? undefined : read(v)
				},
				regexMember: patternMember
			})
		)
		switch (outcome.kind) {
			case "value":
				return coerce(outcome.value, expr.type)
			case "declined":
				this.input.observer.decline(outcome.reason)
				return new Declined(this.readsOf(expr, scope, param), outcome.reason)
		}
	}

	/**
	 * The identity of a term over what it reads in `scope`: its expression, and each column's and parameter's value,
	 * by native equality, which every reading is a function of (values.ts).
	 */
	readsOf(root: ScalarExpr, scope: Bindings, param: (pid: ParamId) => Value | undefined): string {
		const parts: Array<string> = [root.id]
		for (const expr of exprClosure([root])) {
			if (expr.kind === "column") {
				const v = stated(
					scope.get(expr.column.node)?.get(expr.column.name),
					`the column ${expr.column.name}`
				)
				parts.push(`${expr.column.node}.${expr.column.name}=${valueKey(v, expr.type)}`)
			} else if (expr.kind === "param") {
				const v = stated(param(expr.param), `a value for the parameter ${expr.param}`)
				parts.push(`$${expr.param}=${valueKey(v, expr.type)}`)
			}
		}
		return joinedKey(parts)
	}

	/** The truth of a predicate; a predicate over an unstated value has none the reference states. */
	truth(e: ScalarExpr, scope: Bindings): boolean {
		return truthOf(this.expr(e, scope))
	}

	/** An intersection's row is one of a left and a right row; a difference keeps only left rows. */
	rows(node: RelNode, scope: Bindings): ReadonlyArray<Row> {
		switch (node.kind) {
			case "Base":
				return this.base(node)
			case "Closed":
				return Arr.map(node.rows, (row) =>
					Arr.map(row, (v, i) => literalOf(v, columnAt(node.heading, i).type))
				)
			case "InputSet": {
				const input = node.input
				if (input.kind === "member") {
					throw referenceUnsupported(`${input.slot}, a write's member slot`)
				}
				if (input.kind === "row") {
					throw referenceUnsupported("a write filter's membership row")
				}
				const p = this.param(input.param)
				if (p.kind !== "relation") {
					throw referenceUnsupported(`${input.param} as a relation`)
				}
				return Arr.map(p.rows, (row) =>
					Arr.map(node.heading, (c) =>
						literalOf(literalAt(row, columnIndex(p.heading, c.name, node.id)), c.type)
					)
				)
			}
			case "MatchRegion":
				return this.match(node, scope)
			case "Filter": {
				const input = this.eval(node.input, scope)
				return Arr.filter(input.rows, (row) =>
					this.truth(node.pred, bind(scope, [[node.input.id, tupleOf(input, row)]]))
				)
			}
			case "ProjectSet": {
				const input = this.eval(node.input, scope)
				return Arr.map(input.rows, (row) => {
					const inner = bind(scope, [[node.input.id, tupleOf(input, row)]])
					return Arr.map(node.heading, (c) => {
						const out = Arr.findFirst(node.out, (o) => o.name === c.name)
						if (Option.isNone(out)) {
							throw referenceUnsupported(`a projection named ${c.name}`)
						}
						return coerce(this.expr(out.value.expr, inner), c.type)
					})
				})
			}
			case "SemiJoin":
			case "AntiJoin":
				return this.existence(node, scope)
			case "Union":
				return Arr.flatMap(node.groups, (g) =>
					Arr.flatMap(g.arms, (arm) => {
						const r = this.eval(arm, scope)
						return projectAll(r.heading, node.heading, r.rows, node.id)
					})
				)
			case "Intersect":
			case "Difference": {
				const left = this.eval(node.left, scope)
				const right = this.eval(node.right, scope)
				const projected = Arr.map(right.rows, (row) =>
					project(right.heading, left.heading, row, node.id)
				)
				const decided = decidedKeys(
					[...left.rows, ...projected],
					left.heading,
					`${node.kind} ${node.id}`
				)
				const keyAt = (i: number): string => {
					const key = decided[i]
					if (key === undefined) {
						throw new Error(`no key for row ${i} of ${node.id}`)
					}
					return key
				}
				const keys = new Map(
					Arr.map(projected, (row, i) => [keyAt(left.rows.length + i), row] as const)
				)
				const keep = node.kind === "Intersect"
				return Arr.flatMap(left.rows, (row, i): ReadonlyArray<Row> => {
					const matched = keys.get(keyAt(i))
					if ((matched !== undefined) !== keep) {
						return []
					}
					return [row]
				})
			}
			case "Take":
				return this.take(node, scope)
			case "Group":
				return this.group(node, scope)
			case "Recursive":
				return this.recursive(node, scope)
			case "SelfRef":
				return this.state(node).rows
			case "Attach": {
				const parent = this.eval(node.parent, scope)
				return projectAll(parent.heading, node.heading, parent.rows, node.id)
			}
			case "OrderedResult":
				return this.eval(node.input, scope).rows
			case "ApproximateNearest": {
				const source = this.eval(node.source, scope)
				this.input.observer.nearest(node, source)
				return sortRows(source.heading, source.rows, {
					keys: [{ column: node.score, dir: "asc" }]
				}).slice(0, Number(node.take))
			}
			case "Window":
				return this.window(node, scope)
			case "Context":
			case "Delta":
			case "Forbid":
			case "OrderedSetAggregate":
			case "Produce":
				throw referenceUnsupported(`a ${node.kind} node`)
		}
	}

	/** Each input tuple and its window function's value over its partition in the window's order. */
	window(node: NodeOf<"Window">, scope: Bindings): ReadonlyArray<Row> {
		if (node.frame !== undefined || node.filter !== undefined) {
			throw referenceUnsupported(`a framed or filtered window ${node.id}`)
		}
		const input = this.eval(node.input, scope)
		const heading = input.heading
		const partition = Arr.map(node.partition, (c) => columnIndex(heading, c, node.id))
		const keys = Arr.map(node.order.keys, (k) => ({
			index: columnIndex(heading, k.column, node.id),
			desc: k.dir === "desc"
		}))
		/** The window's order alone: tuples it does not tell apart are peers. */
		const ordered = (a: Row, b: Row): -1 | 0 | 1 => {
			for (const k of keys) {
				const c = compare(valueAt(a, k.index), valueAt(b, k.index), columnAt(heading, k.index).type)
				if (c !== 0) {
					return k.desc ? (c < 0 ? 1 : -1) : c
				}
			}
			return 0
		}
		const partitions = new Map<string, Array<Row>>()
		const partitionKeys = decidedKeys(
			Arr.map(input.rows, (row) => Arr.map(partition, (i) => valueAt(row, i))),
			Arr.map(partition, (i) => columnAt(heading, i)),
			`a partition of ${node.id}`
		)
		for (const [r, row] of input.rows.entries()) {
			const key = partitionKeys[r]
			if (key === undefined) {
				throw new Error(`no partition key for row ${r} of ${node.id}`)
			}
			const rows = partitions.get(key)
			if (rows === undefined) {
				partitions.set(key, [row])
			} else {
				rows.push(row)
			}
		}
		const at = (e: ScalarExpr | undefined, row: Row): Value => {
			if (e === undefined) {
				throw referenceUnsupported(`an argument of the window ${node.id}`)
			}
			return this.expr(e, bind(scope, [[node.input.id, tupleOf(input, row)]]))
		}
		const type = (e: ScalarExpr | undefined): ScalarType => {
			if (e === undefined) {
				throw referenceUnsupported(`an argument of the window ${node.id}`)
			}
			return e.type
		}
		const out: Array<Row> = []
		for (const unsorted of partitions.values()) {
			const rows = Arr.sort(unsorted, ordered)
			/** The dense rank of each tuple: one more than the peer groups before it. */
			const dense: Array<bigint> = []
			for (const [i, row] of rows.entries()) {
				const prior = rows[i - 1]
				dense.push(
					prior === undefined ? 1n : (dense[i - 1] ?? 1n) + (ordered(prior, row) === 0 ? 0n : 1n)
				)
			}
			for (const [i, row] of rows.entries()) {
				/** A partition's extreme, as the aggregate computes it. */
				const value = ((): Value => {
					switch (node.fn) {
						case "rowNumber":
							return BigInt(i + 1)
						case "rank":
							return BigInt(Arr.filter(rows, (peer) => ordered(peer, row) < 0).length + 1)
						case "denseRank":
							return dense[i] ?? 1n
						case "count":
							if (keys.length > 0) {
								throw referenceUnsupported(`a running count ${node.id}`)
							}
							return BigInt(rows.length)
						case "min":
						case "max": {
							if (keys.length > 0) {
								throw referenceUnsupported(`a running ${node.fn} ${node.id}`)
							}
							const [arg] = node.args
							return aggregate(
								node.fn,
								Arr.map(rows, (r) => at(arg, r)),
								type(arg)
							)
						}
						case "lag":
						case "lead": {
							const [arg, offset, fallback] = node.args
							const k = at(offset, row)
							if (typeof k !== "bigint") {
								throw referenceUnsupported(`an integer offset of ${node.id}`)
							}
							const neighbour = rows[node.fn === "lag" ? i - Number(k) : i + Number(k)]
							return neighbour === undefined ? at(fallback, row) : at(arg, neighbour)
						}
						case "avg":
						case "sum":
							throw referenceUnsupported(`the window function ${node.fn}`)
					}
				})()
				out.push([...row, value])
			}
		}
		return out
	}

	base(node: NodeOf<"Base">): ReadonlyArray<Row> {
		const relation = Arr.findFirst(this.input.schema.relations, (r) => r.name === node.relation)
		if (Option.isNone(relation)) {
			throw referenceUnsupported(`the relation ${node.relation}`)
		}
		const facts = this.input.facts[node.relation] ?? []
		const index = Arr.map(node.heading, (c) =>
			columnIndex(relation.value.columns, c.name, node.relation)
		)
		return Arr.map(facts, (fact) =>
			Arr.map(node.heading, (c, i) => {
				const at = index[i]
				if (at === undefined) {
					throw referenceUnsupported(`a column ${c.name} of ${node.relation}`)
				}
				return literalOf(literalAt(rowValues(fact), at), c.type)
			})
		)
	}

	/** Every agreeing combination of the occurrences' tuples, as the set of complete variable bindings. */
	match(node: NodeOf<"MatchRegion">, scope: Bindings): ReadonlyArray<Row> {
		return Option.match(this.regionPlans(node), {
			onNone: () => this.matchByDefinition(node, scope),
			onSome: (plans) => this.matchByPlan(node, scope, plans)
		})
	}

	/**
	 * The occurrence plans of a region, each over the variables the occurrences before it bind, or none when one of its
	 * occurrences is shaped outside what they check.
	 */
	regionPlans(node: NodeOf<"MatchRegion">): Option.Option<ReadonlyArray<OccurrencePlan>> {
		const bound = new Set<VarDecl>()
		const plans: Array<OccurrencePlan> = []
		for (const o of node.occurrences) {
			const plan = occurrencePlan(o, bound)
			if (Option.isNone(plan)) {
				return Option.none()
			}
			plans.push(plan.value)
			for (const b of o.bindings) {
				bound.add(b.var)
			}
		}
		return Option.some(plans)
	}

	/**
	 * match by its occurrence plans: the nested loop of matchByDefinition, reading columns by position, building a scope
	 * only where something reads it, and visiting only the candidate rows of a stable source's index, built from the
	 * source's set before the loop.
	 */
	matchByPlan(
		node: NodeOf<"MatchRegion">,
		scope: Bindings,
		plans: ReadonlyArray<OccurrencePlan>
	): ReadonlyArray<Row> {
		const staged = Arr.map(plans, (plan) => ({
			plan,
			index: Option.flatMap(plan.probe, (probe) =>
				Option.flatMap(this.#stableRows(plan.source), (rows) =>
					indexRows(rows, plan.width, probe.index, probe.type)
				)
			)
		}))
		const out: Array<Row> = []
		const regionTuple = (values: ReadonlyMap<VarDecl, Value>): Tuple => {
			const tuple = new Map<string, Value>()
			for (const [v, value] of values) {
				tuple.set(v.name, value)
			}
			return tuple
		}
		/** Whether `row` holds each constant the occurrence compares a column with, evaluated `at` the row. */
		const constantsHold = (plan: OccurrencePlan, row: Row, at: Bindings): boolean =>
			Arr.every(plan.constants, (c) => equal(valueAt(row, c.index), this.expr(c.expr, at), c.type))
		const step = (
			i: number,
			values: ReadonlyMap<VarDecl, Value>,
			sources: ReadonlyArray<readonly [NodeId, Tuple]>
		): void => {
			const inner = bind(scope, [...sources, [node.id, regionTuple(values)]])
			const stage = staged[i]
			if (stage === undefined) {
				appendAll(out, Option.toArray(this.finishMatch(node, values, inner)))
				return
			}
			const { plan, index } = stage
			const source = this.eval(plan.source, inner)
			const rows = Option.match(plan.probe, {
				onNone: () => source.rows,
				onSome: (probe) => {
					const value = values.get(probe.var)
					return value === undefined
						? source.rows
						: candidates(source.rows, index, value, probe.type)
				}
			})
			for (const row of rows) {
				if (row.length < plan.width) {
					valueAt(row, row.length)
				}
				const next = extended(values, plan.bindings, (b) => ({
					value: valueAt(row, b.index),
					type: b.type
				}))
				if (Option.isNone(next)) {
					continue
				}
				const placed = [...sources, [plan.source.id, tupleOf(source, row)] as const]
				const holds =
					plan.constants.length === 0 ||
					constantsHold(plan, row, bind(scope, [...placed, [node.id, regionTuple(next.value)]]))
				if (holds) {
					step(i + 1, next.value, placed)
				}
			}
		}
		step(0, new Map<VarDecl, Value>(), [])
		return out
	}

	/** match as its definition reads: every combination of the occurrences' tuples, by nested loops. */
	matchByDefinition(node: NodeOf<"MatchRegion">, scope: Bindings): ReadonlyArray<Row> {
		const out: Array<Row> = []
		const regionTuple = (values: ReadonlyMap<VarDecl, Value>): Tuple => {
			const tuple = new Map<string, Value>()
			for (const [v, value] of values) {
				tuple.set(v.name, value)
			}
			return tuple
		}
		const step = (
			i: number,
			values: ReadonlyMap<VarDecl, Value>,
			sources: ReadonlyArray<readonly [NodeId, Tuple]>
		): void => {
			const inner = bind(scope, [...sources, [node.id, regionTuple(values)]])
			const o = node.occurrences[i]
			if (o === undefined) {
				appendAll(out, Option.toArray(this.finishMatch(node, values, inner)))
				return
			}
			const source = this.eval(o.source, inner)
			for (const row of source.rows) {
				const tuple = tupleOf(source, row)
				const next = extended(values, o.bindings, (b) => ({
					value: lookup(tuple, b.column, `a bound column ${b.column}`),
					type: b.var.type
				}))
				if (Option.isNone(next)) {
					continue
				}
				const placed = [...sources, [o.source.id, tuple] as const]
				const at = bind(scope, [...placed, [node.id, regionTuple(next.value)]])
				const holds = Arr.every(o.constants, (c) => {
					const column = Arr.findFirst(source.heading, (h) => h.name === c.column)
					if (Option.isNone(column)) {
						throw referenceUnsupported(`a constant column ${c.column}`)
					}
					return equal(
						lookup(tuple, c.column, `a constant column ${c.column}`),
						this.expr(c.expr, at),
						column.value.type
					)
				})
				if (holds) {
					step(i + 1, next.value, placed)
				}
			}
		}
		const start = new Map<VarDecl, Value>()
		step(0, start, [])
		return out
	}

	finishMatch(
		node: NodeOf<"MatchRegion">,
		bound: ReadonlyMap<VarDecl, Value>,
		scope: Bindings
	): Option.Option<Row> {
		const values = new Map(bound)
		for (const c of node.correlated) {
			const v = this.expr(c.expr, scope)
			const prior = values.get(c.var)
			if (prior === undefined) {
				values.set(c.var, v)
			} else if (!equal(prior, v, c.var.type)) {
				return Option.none()
			}
		}
		/** An equality gives an unbound variable its partner's value and compares two bound ones. */
		let pending: ReadonlyArray<Equality> = node.equalities
		for (;;) {
			const left = equatePass(values, pending)
			if (Option.isNone(left)) {
				return Option.none()
			}
			if (left.value.length === pending.length) {
				break
			}
			pending = left.value
		}
		if (pending.length > 0) {
			throw referenceUnsupported(`a value for every equated variable of ${node.id}`)
		}
		return Option.some(
			Arr.map(node.heading, (c) =>
				Option.getOrThrowWith(
					Option.flatMap(
						Arr.findFirst(node.vars, (d) => d.name === c.name),
						(v) => Option.fromUndefinedOr(values.get(v))
					),
					() => referenceUnsupported(`a value for the variable ${c.name}`)
				)
			)
		)
	}

	existence(node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">, scope: Bindings): ReadonlyArray<Row> {
		const left = this.eval(node.left, scope)
		const keep = node.kind === "SemiJoin"
		const planned = this.existencePlan(node, left)
		if (Option.isSome(planned)) {
			const plan = planned.value
			const matches = this.closed(node.right)
				? Option.flatMap(this.#settledSet(node.right), (right) => existenceKeys(right.rows, plan))
				: Option.none()
			return Arr.filter(left.rows, (row) => {
				const tuple = tupleOf(left, row)
				const rel = this.eval(node.right, bind(scope, [[node.left.id, tuple]]))
				const found = Option.match(
					Option.flatMap(matches, (keys) =>
						Option.map(
							pairKey(row, plan.pairs, (p) => p.left),
							(probe) => keys.has(probe)
						)
					),
					{
						onSome: (has) => has,
						onNone: () =>
							Arr.some(rel.rows, (r) => {
								if (r.length < plan.rightWidth) {
									valueAt(r, r.length)
								}
								return Arr.every(plan.pairs, (p) =>
									equal(valueAt(row, p.left), valueAt(r, p.right), p.type)
								)
							})
					}
				)
				return found === keep
			})
		}
		return Arr.filter(left.rows, (row) => {
			const tuple = tupleOf(left, row)
			const right = this.eval(node.right, bind(scope, [[node.left.id, tuple]]))
			const found = Arr.some(right.rows, (r) => {
				const other = tupleOf(right, r)
				return Arr.every(node.on, (p) => {
					const column = Arr.findFirst(left.heading, (c) => c.name === p.left)
					if (Option.isNone(column)) {
						throw referenceUnsupported(`a join column ${p.left}`)
					}
					return equal(
						lookup(tuple, p.left, `a join column ${p.left}`),
						lookup(other, p.right, `a join column ${p.right}`),
						column.value.type
					)
				})
			})
			return found === keep
		})
	}

	/** The column positions of an existence test, or none when its sides are shaped outside what they check. */
	existencePlan(
		node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
		left: Layout
	): Option.Option<ExistencePlan> {
		return planExistence(node, left, layoutOf(node.right.heading))
	}

	bound(node: NodeOf<"Take">): bigint {
		if (node.bound.kind === "literal") {
			return node.bound.k
		}
		const p = this.param(node.bound.param)
		if (p.kind !== "scalar" || p.value.kind !== "int") {
			throw referenceUnsupported("a take bound value")
		}
		return p.value.value
	}

	take(node: NodeOf<"Take">, scope: Bindings): ReadonlyArray<Row> {
		const input = this.eval(node.input, scope)
		/** A correlated take fixes columns to outer values. */
		const rows = Arr.filter(input.rows, (row) => {
			const tuple = tupleOf(input, row)
			return Arr.every(node.correlation, (c) => {
				const column = Arr.findFirst(input.heading, (h) => h.name === c.column)
				if (Option.isNone(column)) {
					throw referenceUnsupported(`a correlated column ${c.column}`)
				}
				return equal(
					lookup(tuple, c.column, `a correlated column ${c.column}`),
					this.expr(c.expr, scope),
					column.value.type
				)
			})
		})
		const sorted = sortRows(input.heading, rows, node.order)
		return sorted.slice(0, Number(this.bound(node)))
	}

	group(node: NodeOf<"Group">, scope: Bindings): ReadonlyArray<Row> {
		const input = this.eval(node.input, scope)
		const heading: Heading = Arr.map(node.bound, (name) =>
			columnAt(input.heading, columnIndex(input.heading, name, node.id))
		)
		/** The contributions: the distinct complete bound tuples. */
		const tuples = distinctRows(
			Arr.map(input.rows, (row) => project(input.heading, heading, row, node.id)),
			heading,
			`the bound tuples of ${node.id}`
		)
		const keyHeading: Heading = Arr.map(node.keys, (k) =>
			columnAt(heading, columnIndex(heading, k, node.id))
		)
		const groups = new Map<string, { key: Row; members: Array<Row> }>()
		const projected = Arr.map(tuples, (t) => project(heading, keyHeading, t, node.id))
		const groupKeys = decidedKeys(projected, keyHeading, `a group key of ${node.id}`)
		for (const [i, t] of tuples.entries()) {
			const key = projected[i]
			const k = groupKeys[i]
			if (key === undefined || k === undefined) {
				throw new Error(`no group key for tuple ${i} of ${node.id}`)
			}
			const g = groups.get(k)
			if (g === undefined) {
				groups.set(k, { key, members: [t] })
			} else {
				g.members.push(t)
			}
		}
		const keyLayout = layoutOf(keyHeading)
		const boundLayout = layoutOf(heading)
		const out: Array<Row> = []
		for (const { key, members } of groups.values()) {
			const keyTuple = tupleOf(keyLayout, key)
			out.push(
				Arr.map(node.heading, (c) => {
					if (keyTuple.has(c.name) && node.keys.includes(c.name)) {
						return lookup(keyTuple, c.name, `a key column ${c.name}`)
					}
					const agg = Arr.findFirst(node.aggs, (a) => a.name === c.name)
					if (Option.isNone(agg)) {
						throw referenceUnsupported(`a key or aggregate named ${c.name}`)
					}
					const arg = agg.value.args[0]
					const argType = arg?.type
					const values = Arr.map(members, (m) =>
						arg === undefined
							? true
							: this.expr(arg, bind(scope, [[node.input.id, tupleOf(boundLayout, m)]]))
					)
					return coerce(aggregate(agg.value.fn, values, argType), c.type)
				})
			)
		}
		return out
	}

	recursive(node: NodeOf<"Recursive">, scope: Bindings): ReadonlyArray<Row> {
		const cast = (r: Relation): ReadonlyArray<Row> => {
			if (r.rows.length === 0) {
				return []
			}
			const index = Arr.map(node.heading, (c) => columnIndex(r.heading, c.name, node.id))
			return Arr.map(r.rows, (row) =>
				Arr.map(
					Arr.map(index, (at) => valueAt(row, at)),
					(v, i) => coerce(v, columnAt(node.heading, i).type)
				)
			)
		}
		let state = distinctRows(
			cast(this.eval(node.base, scope)),
			node.heading,
			`the base of ${node.id}`
		)
		const seen = new Map<string, number>()
		for (let i = 0; ; i++) {
			if (i >= maxIterations) {
				throw referenceUnsupported(`a recursion of more than ${maxIterations} steps`)
			}
			this.#state.set(node.id, { ...layoutOf(node.self.heading), rows: state })
			const step = cast(this.eval(node.step, scope))
			this.#state.delete(node.id)
			/**
			 * The state and the step keyed together, so a step row told apart from a state row by declined terms alone
			 * is refused rather than kept as fresh.
			 */
			const keys = decidedKeys([...state, ...step], node.heading, `the state of ${node.id}`)
			const keyAt = (j: number): string => {
				const key = keys[j]
				if (key === undefined) {
					throw new Error(`no key for row ${j} of the state of ${node.id}`)
				}
				return key
			}
			/** Each key's row by its index in the state and fresh rows. */
			const rows: Array<Row> = [...state]
			const keyed: ReadonlyArray<readonly [string, number]> = Arr.map(
				[...state.keys()],
				(j) => [keyAt(j), j] as const
			)
			const unrecorded: ReadonlyArray<readonly [string, number]> = Arr.filter(
				keyed,
				([k]) => !seen.has(k)
			)
			const unseen = Arr.dedupeWith(unrecorded, ([a], [b]) => a === b)
			for (const [k, j] of unseen) {
				seen.set(k, j)
			}
			let fresh = 0
			for (const [j, row] of step.entries()) {
				const k = keyAt(state.length + j)
				if (seen.has(k)) {
					continue
				}
				seen.set(k, rows.length)
				rows.push(row)
				fresh++
			}
			if (fresh === 0) {
				return rows
			}
			state = rows
		}
	}
}

/**
 * The reference of a case whose facts a perturbation repeated (perturb.ts multiplyFacts): the reference, giving up past
 * scaledRegionRows region rows completed in all. A runner states such a case through it first, and runs the case with
 * its facts as generated when it gives up.
 */
class ScaledReference extends Reference {
	#completed = 0

	/** The scaled reference of a case: its DAG's closed sets settled, within the region rows it completes. */
	static scaled(dag: RelDag, input: ReferenceInput): ScaledReference {
		return new ScaledReference(dag, input).settle()
	}

	override finishMatch(
		node: NodeOf<"MatchRegion">,
		bound: ReadonlyMap<VarDecl, Value>,
		scope: Bindings
	): Option.Option<Row> {
		const row = super.finishMatch(node, bound, scope)
		if (Option.isSome(row)) {
			this.#completed++
			if (this.#completed > scaledRegionRows) {
				throw referenceUnsupported(`more than ${scaledRegionRows} region rows over repeated facts`)
			}
		}
		return row
	}
}

/**
 * The reference a runner states a case through: over facts a perturbation repeated `multiplier` times, a
 * ScaledReference; over the facts as generated, the reference.
 */
export const statingReference = (
	dag: RelDag,
	input: ReferenceInput,
	multiplier: number
): Reference => (multiplier > 1 ? ScaledReference.scaled(dag, input) : Reference.of(dag, input))
