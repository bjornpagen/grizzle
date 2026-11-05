import type { Broken, Corruption } from "@grizzle/testing/lsw"
import { Array as Arr, Option, Record as Rec } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { ExprId, NodeId, VarId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { sortedUnique, type TableExpr } from "#compiler/ir/expr.ts"
import { claimedColumns, claimedKeyIn, rewriteClaim } from "#compiler/ir/keys.ts"
import type { Exact } from "#compiler/ir/proof.ts"
import {
	type DagTable,
	type Heading,
	type HeadingColumn,
	type Identified,
	inputsOf,
	type KeySet,
	keptRowsOf,
	type KindOver,
	type NodeMeta,
	orderSensitiveWindowFns,
	type RelKind,
	type TableNode,
	type TableRefs
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { fitRange } from "#compiler/scalar/compute/lower.ts"
import { f as field } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { scalarTypes } from "#test/unit/ir/fixture.ts"

/** Where the validator must report the rule a corrupted DAG breaks. */
export interface DagRefusal {
	readonly path: ReadonlyArray<string | number>
	readonly match: "within" | "at"
}

/**
 * Every rule a corruption breaks, as the validator holds it: a corruption names one of these, so a misspelt rule is a
 * compile error.
 */
export type DagRule =
	| "a feedback edge names a node"
	| "a column reference names a column of its node"
	| "a binding names a declared variable"
	| "a variable is declared by one region"
	| "a region declares a variable once"
	| "a region's variables have distinct names"
	| "an occurrence id is fresh"
	| "a region binds its own variables only"
	| "a heading names each column once"
	| "a heading is the one its kind defines"
	| "a heading column has the type its kind defines"
	| "a group's keys lie in its bound tuple"
	| "a declared key names columns of the heading"
	| "a union of several headings has a discriminant"
	| "every arm binds the discriminant to a literal"
	| "arms of different headings differ in their discriminant literals"
	| "an arm has its group's heading"
	| "an attachment binds a parent variable"
	| "an attachment delivers no narrower than its child's evidence"
	| "an order belongs to a delivered array"
	| "a delivery node lies on its root's delivered rows"
	| "a filter's predicate is boolean"
	| "an approximate search is sealed and scored by a double precision column"
	| "a take's bound is positive"
	| "set operation inputs have equal headings"
	| "join columns exist on both sides at one base type"
	| "a producer has its arity"
	| "a closed row has the heading's width"
	| "closed facts are distinct under native equality"
	| "an expression reads its node's input only"
	| "a scope expression's column is bound on its way to every root"
	| "an aggregate reads only its bound tuple"
	| "a node's read dependencies are the computed ones"
	| "a node's parameter dependencies are the computed ones"
	| "an order is total"
	| "a logical key names heading columns"
	| "logical keys are distinct"
	| "the empty key needs at most one row"
	| "a recursion's self is its feedback reference"
	| "a recursion's base and step have its state heading"
	| "a recursion has one feedback reference"
	| "a recursion's base never reads its feedback"
	| "a recursion's step reads its feedback"
	| "only the step reads the feedback"
	| "a window function has its arity"
	| "lead and lag take an integer offset and a default of the value's type"
	| "a ROWS frame belongs to an ordered window aggregate, start before end"
	| "only a count is filtered"
	| "an aggregate has its arity"
	| "an ordered-set aggregate orders by one column, with a double precision fraction per output"
	| "a literal fits its type"
	| "a comparison parameter is bound as its base type"
	| "an expression's dependencies are the computed ones"
	| "an expression is stable when an argument is"
	| "a conditional has a boolean condition and branches of its type"
	| "VALUE appears only in a contract predicate"
	| "a column reference keeps its column's type"
	| "a partial operation stands with a proof the kernel re-derives"
	| "every precondition of a partial operation stands with a proof of its own"
	| "a domain cast targets a refined type"
	| "a node or expression holds its kind's properties only"
	| "no field holds null"

export type DagCorruption = Corruption<DagTable, DagRefusal, DagRule>

/** A node of the table form, of one kind. */
type TableOf<K extends RelKind> = KindOver<K, TableRefs> & Identified

/** The expressions `roots` reach through their arguments in a table, each once, in first-visit order. */
const exprClosure = (dag: DagTable, roots: ReadonlyArray<ExprId>): ReadonlyArray<ExprId> => {
	const seen = new Set<ExprId>()
	const queue = [...roots]
	for (const id of queue) {
		if (!seen.has(id)) {
			seen.add(id)
			appendAll(queue, Rec.has(dag.exprs, id) ? (dag.exprs[id]?.args ?? []) : [])
		}
	}
	return [...seen]
}

/** A valid DAG derived from another, which the validator must accept, and what it varies. */
export interface LiveVariant {
	readonly at: string
	readonly value: unknown
}

interface Raw {
	readonly roots: ReadonlyArray<unknown>
	readonly nodes: Readonly<Record<string, unknown>>
	readonly exprs: Readonly<Record<string, unknown>>
}

const withNodes = (
	dag: DagTable,
	entries: ReadonlyArray<readonly [string, unknown]>,
	roots: DagTable["roots"]
): Raw => ({
	roots,
	nodes: { ...dag.nodes, ...Rec.fromEntries(entries) },
	exprs: dag.exprs
})

const withNode = (dag: DagTable, key: string, node: unknown): Raw =>
	withNodes(dag, [[key, node]], dag.roots)

const withExprs = (dag: DagTable, entries: ReadonlyArray<readonly [string, unknown]>): Raw => ({
	roots: dag.roots,
	nodes: dag.nodes,
	exprs: { ...dag.exprs, ...Rec.fromEntries(entries) }
})
const withExpr = (dag: DagTable, key: string, expr: unknown): Raw => withExprs(dag, [[key, expr]])

/** Identifiers no table holds. */
const absentNode = NodeId("n-absent")
const absentVar = VarId("v-absent")

const refused = (path: ReadonlyArray<string | number>, match: "within" | "at"): DagRefusal => ({
	path,
	match
})

const atNode = (id: NodeId, ...rest: ReadonlyArray<string | number>): DagRefusal =>
	refused(["nodes", id, ...rest], "within")

const atExpr = (id: ExprId, ...rest: ReadonlyArray<string | number>): DagRefusal =>
	refused(["exprs", id, ...rest], "within")

const site = (value: unknown, refusal: DagRefusal, at: string): Broken<DagRefusal> => ({
	value,
	refusal,
	at
})

const nodesOf = (dag: DagTable): ReadonlyArray<TableNode> => Rec.values(dag.nodes)
const exprsOf = (dag: DagTable): ReadonlyArray<TableExpr> => Rec.values(dag.exprs)
const nodeAt = (dag: DagTable, id: NodeId): TableNode | undefined =>
	Rec.has(dag.nodes, id) ? dag.nodes[id] : undefined

const exprAt = (dag: DagTable, id: ExprId): TableExpr | undefined =>
	Rec.has(dag.exprs, id) ? dag.exprs[id] : undefined

/** The first column of a node's heading `p` holds of: none where there is no node, or no such column. */
const columnWhere = (
	node: TableNode | undefined,
	p: (c: HeadingColumn) => boolean
): Option.Option<HeadingColumn> =>
	node === undefined ? Option.none() : Arr.findFirst(node.heading, p)

/** The field names of a node or an expression, as Object.keys lists its own enumerable string keys, in order. */
const fieldNames = (fields: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
	Rec.keys(fields)

const ofKind = <K extends RelKind>(dag: DagTable, kind: K): ReadonlyArray<TableOf<K>> =>
	Arr.filter(nodesOf(dag), (n): n is TableOf<K> => n.kind === kind)

const ofExprKind = <K extends TableExpr["kind"]>(
	dag: DagTable,
	kind: K
): ReadonlyArray<Extract<TableExpr, { readonly kind: K }>> =>
	Arr.filter(exprsOf(dag), (e): e is Extract<TableExpr, { readonly kind: K }> => e.kind === kind)

/** A column name a heading lacks. */
const freshName = (heading: Heading, stem: string): string => {
	let name = stem
	while (Arr.some(heading, (c) => c.name === name)) {
		name = `${name}_`
	}
	return name
}

/** A type unequal to `t`. */
const otherType = (t: ScalarType): ScalarType =>
	baseOf(t).carrier === "int4" ? scalarTypes.text : scalarTypes.int4

/** A node no root reaches and no rule but the one under test refuses: a Closed relation of no rows under `heading`. */
const foreignNode = (id: NodeId, heading: Heading, meta: NodeMeta): TableNode => ({
	id,
	kind: "Closed",
	closed: "Foreign",
	rows: [],
	heading,
	meta: { logicalKeys: [], card: "many", context: meta.context, paramDeps: [], reads: [] },
	loc: undefined
})

/**
 * The order a node's rows are total in: every column of its input's heading, or a key of it (a logical key, by a
 * column of each of its classes, or a Base's declared key).
 */
const totalOver = (dag: DagTable, input: NodeId, ordered: ReadonlyArray<string>): boolean => {
	const node = nodeAt(dag, input)
	if (node === undefined) {
		return true
	}
	const covered = new Set(ordered)
	const declared = node.kind === "Base" ? [node.primaryKey, ...node.keys] : []
	const holds = (c: string) => covered.has(c)
	return (
		Arr.every(node.heading, (c) => covered.has(c.name)) ||
		Arr.some(node.meta.logicalKeys, (k) => claimedKeyIn(k, holds) !== undefined) ||
		Arr.some(declared, (key) => Arr.every(key, holds))
	)
}

/**
 * The literal expression an arm binds a column to, read down the nodes that keep their input's rows to the projection
 * that names it.
 */
const literalBinding = (dag: DagTable, arm: NodeId, column: string): ExprId | undefined => {
	for (let node = nodeAt(dag, arm); node !== undefined;) {
		if (node.kind === "ProjectSet") {
			const out = Arr.findFirst(node.out, (o) => o.name === column)
			const expr = Option.isNone(out) ? undefined : exprAt(dag, out.value.expr)
			return expr?.kind === "literal" ? expr.id : undefined
		}
		const kept = keptRowsOf(node)
		node = kept === undefined ? undefined : nodeAt(dag, kept.input)
	}
	return undefined
}

/** The projection an arm's discriminant literals come from. */
const armHead = (dag: DagTable, arm: NodeId): TableOf<"ProjectSet"> | undefined => {
	for (let node = nodeAt(dag, arm); node !== undefined;) {
		if (node.kind === "ProjectSet") {
			return node
		}
		const kept = keptRowsOf(node)
		node = kept === undefined ? undefined : nodeAt(dag, kept.input)
	}
	return undefined
}

/** Whether an attachment's correlated child columns cover a key of its child. */
const keyBound = (child: TableNode, correlated: ReadonlyArray<string>): boolean => {
	const bound = new Set(correlated)
	const declared = child.kind === "Base" ? [child.primaryKey, ...child.keys] : []
	const holds = (c: string) => bound.has(c)
	return (
		Arr.some(child.meta.logicalKeys, (k) => claimedKeyIn(k, holds) !== undefined) ||
		Arr.some(declared, (key) => Arr.every(key, holds))
	)
}

/** The column expressions a node evaluates over its input's rows, with the input. */
const evaluatedOver = (
	n: TableNode
): { readonly input: NodeId; readonly exprs: ReadonlyArray<ExprId> } | undefined => {
	switch (n.kind) {
		case "Filter":
			return { input: n.input, exprs: [n.pred] }
		case "ProjectSet":
			return { input: n.input, exprs: Arr.map(n.out, (o) => o.expr) }
		case "Group":
			return {
				input: n.input,
				exprs: Arr.flatMap(n.aggs, (a) => (a.filter === undefined ? a.args : [...a.args, a.filter]))
			}
		case "Produce":
			return { input: n.input, exprs: n.args }
		case "Window":
			return { input: n.input, exprs: n.filter === undefined ? n.args : [...n.args, n.filter] }
		case "OrderedSetAggregate":
			return { input: n.input, exprs: n.fractions }
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
		case "Recursive":
		case "SelfRef":
		case "SemiJoin":
		case "Take":
		case "Union":
			return undefined
	}
}

/** The nodes some root reaches through data inputs. */
const reachedFromRoots = (dag: DagTable): ReadonlySet<NodeId> => {
	const seen = new Set<NodeId>()
	const queue = [...dag.roots]
	for (const id of queue) {
		if (seen.has(id)) {
			continue
		}
		seen.add(id)
		const node = nodeAt(dag, id)
		if (node !== undefined) {
			appendAll(queue, inputsOf(node))
		}
	}
	return seen
}

/** The columns of `input` an expression list reads. */
const columnsRead = (
	dag: DagTable,
	input: NodeId,
	exprs: ReadonlyArray<ExprId>
): ReadonlyArray<string> =>
	Arr.flatMap(exprClosure(dag, exprs), (id) => {
		const e = exprAt(dag, id)
		return e?.kind === "column" && e.column.node === input ? [e.column.name] : []
	})

/**
 * The first expression of the DAG reading a column of `input` of another type than `t`, or any type when `t` is none.
 */
const columnOfOtherType = (
	dag: DagTable,
	input: NodeId,
	t: ScalarType | undefined
): Option.Option<ExprId> =>
	Option.map(
		Arr.findFirst(
			ofExprKind(dag, "column"),
			(e) =>
				e.column.node === input && (t === undefined || !sameScalarType(baseOf(e.type), baseOf(t)))
		),
		(e) => e.id
	)

/**
 * A literal of another base type than `t`: an expression that reads no node, so a node may read it whatever its input.
 */
const literalOfOtherType = (dag: DagTable, t: ScalarType): Option.Option<ExprId> =>
	Option.map(
		Arr.findFirst(ofExprKind(dag, "literal"), (e) => !sameScalarType(baseOf(e.type), baseOf(t))),
		(e) => e.id
	)

/** A boolean literal of the DAG, which reads nothing, so any node may evaluate it. */
const booleanLiteral = (dag: DagTable): Option.Option<ExprId> =>
	Option.map(
		Arr.findFirst(exprsOf(dag), (e) => e.kind === "literal" && e.value.kind === "bool"),
		(e) => e.id
	)

/** The id of an expression that is a literal; none for any other expression or a dangling one. */
const without = <A>(xs: ReadonlyArray<A>, x: A): ReadonlyArray<A> => Arr.filter(xs, (y) => y !== x)

const references: Arr.NonEmptyReadonlyArray<DagCorruption> = [
	{
		rule: "a feedback edge names a node",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "SelfRef"), (s) =>
				site(withNode(dag, s.id, { ...s, recursive: absentNode }), atNode(s.id), s.kind)
			)
	},
	{
		rule: "a column reference names a column of its node",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofExprKind(dag, "column"), (e) =>
				site(
					withExpr(dag, e.id, {
						...e,
						column: {
							...e.column,
							name: freshName(nodeAt(dag, e.column.node)?.heading ?? [], "ghost")
						}
					}),
					atExpr(e.id),
					"column"
				)
			)
	},
	{
		rule: "a binding names a declared variable",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "MatchRegion"), (r) =>
				Arr.flatMap(r.occurrences, (o, i) =>
					Arr.map([...o.bindings.keys()], (j) =>
						site(
							withNode(dag, r.id, {
								...r,
								occurrences: Arr.map(r.occurrences, (p, k) =>
									k === i
										? {
												...p,
												bindings: Arr.map(p.bindings, (b, l) =>
													l === j ? { ...b, var: absentVar } : b
												)
											}
										: p
								)
							}),
							atNode(r.id),
							r.kind
						)
					)
				)
			)
	}
]

/** Identities declared twice: an identity of another region or scan. */
const identities: ReadonlyArray<DagCorruption> = [
	{
		rule: "a variable is declared by one region",
		from: "stale",
		weight: 1,
		sites: (dag) => {
			const regions = ofKind(dag, "MatchRegion")
			return Arr.flatMap(regions, (later, i) => {
				const [stolen] = Arr.flatMap(regions.slice(0, i), (earlier) => earlier.vars)
				const [first, ...rest] = later.vars
				if (stolen === undefined || first === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, later.id, { ...later, vars: [{ ...first, id: stolen.id }, ...rest] }),
						atNode(later.id, "vars", 0),
						later.kind
					)
				]
			})
		}
	},
	{
		rule: "a region declares a variable once",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "MatchRegion"), (r) => {
				const [first] = r.vars
				if (first === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, r.id, {
							...r,
							vars: [...r.vars, { ...first, name: freshName(r.heading, "ghost") }]
						}),
						atNode(r.id, "vars", r.vars.length),
						r.kind
					)
				]
			})
	},
	{
		rule: "a region's variables have distinct names",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "MatchRegion"), (r) => {
				const [first] = r.vars
				if (first === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, r.id, { ...r, vars: [...r.vars, { ...first, id: VarId("v-twin") }] }),
						atNode(r.id, "vars", r.vars.length),
						r.kind
					)
				]
			})
	},
	{
		rule: "an occurrence id is fresh",
		from: "stale",
		weight: 1,
		sites: (dag) => {
			const claims: Array<string> = []
			return Arr.flatMap(nodesOf(dag), (n) => {
				const [earlier] = claims
				const broken =
					n.kind === "Base" && earlier !== undefined
						? [site(withNode(dag, n.id, { ...n, occurrence: earlier }), atNode(n.id), n.kind)]
						: []
				if (n.kind === "Base") {
					claims.push(n.occurrence)
				}
				if (n.kind === "MatchRegion") {
					appendAll(
						claims,
						Arr.map(n.occurrences, (o) => o.id)
					)
				}
				return broken
			})
		}
	},
	{
		rule: "a region binds its own variables only",
		from: "stale",
		weight: 1,
		sites: (dag) => {
			const regions = ofKind(dag, "MatchRegion")
			return Arr.flatMap(regions, (r) => {
				const others = Arr.filter(regions, (other) => other.id !== r.id)
				const [foreign] = Arr.flatMap(others, (other) => other.vars)
				if (foreign === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, r.id, {
							...r,
							equalities: [...r.equalities, { a: foreign.id, b: foreign.id }]
						}),
						atNode(r.id),
						r.kind
					)
				]
			})
		}
	}
]

/**
 * The kinds whose heading their inputs define: never a leaf whose heading a description states (a relation's, a
 * context's, a parameter's, a delta's, an empty closed relation's).
 */
const definedHeading = (n: TableNode): boolean =>
	!(
		n.kind === "Base" ||
		n.kind === "Context" ||
		n.kind === "InputSet" ||
		n.kind === "Delta" ||
		(n.kind === "Closed" && n.rows.length === 0)
	)

/**
 * The kinds whose first heading column's type their inputs define: a group's types only at its keys, a producer's and
 * an ordered-set aggregate's never, a window's only at its input's columns.
 */
const typedFirstColumn = (dag: DagTable, n: TableNode): boolean => {
	switch (n.kind) {
		case "Base":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Produce":
		case "OrderedSetAggregate":
			return false
		case "Closed":
			return n.rows.length > 0
		case "Group":
			return n.keys.includes(n.heading[0]?.name ?? "")
		case "Window":
			return (nodeAt(dag, n.input)?.heading.length ?? 0) > 0
		case "AntiJoin":
		case "ApproximateNearest":
		case "Attach":
		case "Difference":
		case "Filter":
		case "Forbid":
		case "Intersect":
		case "MatchRegion":
		case "OrderedResult":
		case "ProjectSet":
		case "Recursive":
		case "SelfRef":
		case "SemiJoin":
		case "Take":
		case "Union":
			return true
	}
}

const headings: ReadonlyArray<DagCorruption> = [
	{
		rule: "a heading names each column once",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(nodesOf(dag), (n) => {
				const [first] = n.heading
				return first === undefined
					? []
					: [
							site(
								withNode(dag, n.id, { ...n, heading: [...n.heading, first] }),
								atNode(n.id, "heading"),
								n.kind
							)
						]
			})
	},
	{
		rule: "a heading is the one its kind defines",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(Arr.filter(nodesOf(dag), definedHeading), (n) =>
				site(
					withNode(dag, n.id, {
						...n,
						heading: [
							...n.heading,
							{ name: freshName(n.heading, "ghost"), type: n.heading[0]?.type ?? scalarTypes.int4 }
						]
					}),
					atNode(n.id),
					n.kind
				)
			)
	},
	{
		rule: "a heading column has the type its kind defines",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(nodesOf(dag), (n) => {
				if (!typedFirstColumn(dag, n)) {
					return []
				}
				const [first, ...rest] = n.heading
				return first === undefined
					? []
					: [
							site(
								withNode(dag, n.id, {
									...n,
									heading: [{ ...first, type: otherType(first.type) }, ...rest]
								}),
								atNode(n.id),
								n.kind
							)
						]
			})
	},
	{
		rule: "a group's keys lie in its bound tuple",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "Group"), (g) =>
				site(
					withNode(dag, g.id, { ...g, keys: [...g.keys, freshName(g.heading, "ghost")] }),
					atNode(g.id),
					g.kind
				)
			)
	},
	{
		rule: "a declared key names columns of the heading",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Base"), (b) => [
				site(
					withNode(dag, b.id, {
						...b,
						primaryKey: [...b.primaryKey, freshName(b.heading, "ghost")]
					}),
					atNode(b.id),
					"primary key"
				),
				site(
					withNode(dag, b.id, { ...b, keys: [...b.keys, [freshName(b.heading, "ghost")]] }),
					atNode(b.id),
					"candidate key"
				)
			])
	}
]

/** A union of several heading groups. */
const heteroUnions = (dag: DagTable): ReadonlyArray<TableOf<"Union">> =>
	Arr.filter(ofKind(dag, "Union"), (u) => u.groups.length > 1)

const unions: ReadonlyArray<DagCorruption> = [
	{
		rule: "a union of several headings has a discriminant",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(heteroUnions(dag), (u) =>
				site(
					withNode(dag, u.id, { ...u, discriminant: [] }),
					refused(["nodes", u.id], "within"),
					u.kind
				)
			)
	},
	{
		rule: "every arm binds the discriminant to a literal",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(heteroUnions(dag), (u) => {
				const undiscriminated = Arr.filter(u.heading, (c) => !u.discriminant.includes(c.name))
				return Arr.flatMap(undiscriminated, (c) => {
					const lacking = Arr.flatMap(u.groups, (g, gi) =>
						Arr.flatMap(g.arms, (arm, ai) =>
							literalBinding(dag, arm, c.name) === undefined ? [[gi, ai] as const] : []
						)
					)
					const [first] = lacking
					if (first === undefined) {
						return []
					}
					return [
						site(
							withNode(dag, u.id, { ...u, discriminant: [...u.discriminant, c.name] }),
							refused(["nodes", u.id, "groups", first[0], "arms", first[1]], "within"),
							u.kind
						)
					]
				})
			})
	},
	{
		rule: "arms of different headings differ in their discriminant literals",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(heteroUnions(dag), (u) => {
				const [group0, ...later] = u.groups
				const [arm0] = group0.arms
				if (u.discriminant.length === 0) {
					return []
				}
				const taken = Arr.map(u.discriminant, (c) => literalBinding(dag, arm0, c))
				return Arr.flatMap(later, (g, i) => {
					const head = armHead(dag, g.arms[0])
					if (head === undefined) {
						return []
					}
					/**
					 * Group 0's literals into this group's arm, as they are: a literal holds its value in its one form,
					 * so no other spelling of it exists to copy.
					 */
					const copied = () => {
						const exprs: Array<readonly [string, TableExpr]> = []
						const out = Arr.map(head.out, (o, k) => {
							const literalId = taken[u.discriminant.indexOf(o.name)]
							const literal = literalId === undefined ? undefined : exprAt(dag, literalId)
							if (literal?.kind !== "literal") {
								return o
							}
							const id = ExprId(`e-copied-${k}`)
							exprs.push([id, { ...literal, id }])
							return { name: o.name, expr: id }
						})
						return {
							...withExprs(dag, exprs),
							nodes: { ...dag.nodes, [head.id]: { ...head, out } }
						}
					}
					const refusal = refused(["nodes", u.id, "groups", i + 1], "within")
					return [site(copied(), refusal, "the same literal")]
				})
			})
	},
	{
		rule: "an arm has its group's heading",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(heteroUnions(dag), (u) => {
				const [g0, g1, ...rest] = u.groups
				if (g1 === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, u.id, {
							...u,
							groups: [{ ...g0, arms: g1.arms }, { ...g1, arms: g0.arms }, ...rest]
						}),
						atNode(u.id, "groups", 0, "arms", 0),
						u.kind
					)
				]
			})
	}
]

const attachments: ReadonlyArray<DagCorruption> = [
	{
		rule: "an attachment binds a parent variable",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "Attach"), (a) =>
				site(
					withNode(dag, a.id, { ...a, correlation: [] }),
					refused(["nodes", a.id], "within"),
					a.delivered
				)
			)
	},
	{
		rule: "an attachment delivers no narrower than its child's evidence",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Attach"), (a) => {
				const child = nodeAt(dag, a.child)
				if (child === undefined) {
					return []
				}
				const { order: _order, ...unordered } = a
				const option =
					child.meta.card === "many" &&
					!keyBound(
						child,
						Arr.map(a.correlation, (c) => c.child)
					) &&
					a.delivered !== "option"
						? [
								site(
									withNode(dag, a.id, { ...unordered, delivered: "option" }),
									atNode(a.id, "delivered"),
									"option"
								)
							]
						: []
				const one =
					child.meta.card !== "one" && a.delivered !== "one"
						? [
								site(
									withNode(dag, a.id, { ...unordered, delivered: "one" }),
									atNode(a.id, "delivered"),
									"one"
								)
							]
						: []
				return [...option, ...one]
			})
	},
	{
		rule: "an order belongs to a delivered array",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Attach"), (a) => {
				const child = nodeAt(dag, a.child)
				if (child === undefined || a.delivered === "array") {
					return []
				}
				const order = { keys: Arr.map(child.heading, (c) => ({ column: c.name, dir: "asc" })) }
				return [site(withNode(dag, a.id, { ...a, order }), atNode(a.id), a.delivered)]
			})
	},
	{
		rule: "a delivery node lies on its root's delivered rows",
		from: "wild",
		weight: 1,
		/**
		 * A new root semi-joins the delivery node's own input with the delivery node itself, which the new root reads
		 * as its right side: off its delivered rows. Every other rule holds (one heading, the right side's columns the
		 * left's, the meta the left's with its structural fields the computed ones).
		 */
		sites: (dag) => {
			const deliveries: ReadonlyArray<
				readonly [TableOf<"Attach"> | TableOf<"OrderedResult">, NodeId]
			> = [
				...Arr.map(ofKind(dag, "Attach"), (a) => [a, a.parent] as const),
				...Arr.map(ofKind(dag, "OrderedResult"), (o) => [o, o.input] as const)
			]
			return Arr.flatMap(deliveries, ([delivery, input]) => {
				const left = nodeAt(dag, input)
				const [first] = delivery.heading
				if (left === undefined || first === undefined) {
					return []
				}
				const id = NodeId("n-reader")
				const reader: TableNode = {
					id,
					kind: "SemiJoin",
					left: input,
					right: delivery.id,
					on: [{ left: first.name, right: first.name }],
					heading: left.heading,
					/** Its structural fields lexical (dag.ts relNode): its left input's and the delivery's. */
					meta: {
						logicalKeys: left.meta.logicalKeys,
						card: left.meta.card,
						context: left.meta.context,
						paramDeps: sortedUnique([...left.meta.paramDeps, ...delivery.meta.paramDeps]),
						reads: sortedUnique([...left.meta.reads, ...delivery.meta.reads])
					},
					loc: undefined
				}
				const roots = [...dag.roots, id]
				return [site(withNodes(dag, [[id, reader]], roots), atNode(delivery.id), delivery.kind)]
			})
		}
	}
]

const kinds: ReadonlyArray<DagCorruption> = [
	{
		rule: "a filter's predicate is boolean",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Filter"), (f) =>
				Arr.map(
					Arr.getSomes([
						columnOfOtherType(dag, f.input, scalarTypes.bool),
						literalOfOtherType(dag, scalarTypes.bool)
					]),
					(nonBoolean) =>
						site(withNode(dag, f.id, { ...f, pred: nonBoolean }), atNode(f.id), f.kind)
				)
			)
	},
	{
		rule: "an approximate search is sealed and scored by a double precision column",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "ApproximateNearest"), (a) => {
				const unscored = columnWhere(
					nodeAt(dag, a.source),
					(c) => baseOf(c.type).carrier !== "float8"
				)
				return [
					site(withNode(dag, a.id, { ...a, sealed: false }), atNode(a.id), "unsealed"),
					...(Option.isNone(unscored)
						? []
						: [
								site(
									withNode(dag, a.id, { ...a, score: unscored.value.name }),
									atNode(a.id),
									"scored by another type"
								)
							])
				]
			})
	},
	{
		rule: "a take's bound is positive",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Take"), (t) =>
				t.bound.kind === "literal"
					? Arr.map([0n, -1n], (k) =>
							site(
								withNode(dag, t.id, { ...t, bound: { kind: "literal", k } }),
								atNode(t.id),
								k === 0n ? "zero" : "negative"
							)
						)
					: []
			)
	},
	{
		rule: "set operation inputs have equal headings",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map([...ofKind(dag, "Intersect"), ...ofKind(dag, "Difference")], (n) => {
				const foreign = foreignNode(
					NodeId("n-foreign"),
					[{ name: freshName(n.heading, "ghost"), type: scalarTypes.int4 }],
					n.meta
				)
				return site(
					withNodes(
						dag,
						[
							[foreign.id, foreign],
							[n.id, { ...n, right: foreign.id }]
						],
						dag.roots
					),
					atNode(n.id),
					n.kind
				)
			})
	},
	{
		rule: "join columns exist on both sides at one base type",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap([...ofKind(dag, "SemiJoin"), ...ofKind(dag, "AntiJoin")], (n) =>
				Arr.flatMap(n.on, (pair, i) => {
					const right = nodeAt(dag, n.right)
					const left = columnWhere(nodeAt(dag, n.left), (c) => c.name === pair.left)
					const mismatched = Option.flatMap(left, (l) =>
						columnWhere(right, (c) => !sameScalarType(baseOf(c.type), baseOf(l.type)))
					)
					const on = (replacement: string) =>
						Arr.map(n.on, (p, j) => (j === i ? { ...p, right: replacement } : p))
					return [
						site(
							withNode(dag, n.id, { ...n, on: on(freshName(right?.heading ?? [], "ghost")) }),
							atNode(n.id, "on", i),
							"absent column"
						),
						...(Option.isNone(mismatched)
							? []
							: [
									site(
										withNode(dag, n.id, { ...n, on: on(mismatched.value.name) }),
										atNode(n.id, "on", i),
										"another base type"
									)
								])
					]
				})
			)
	},
	{
		rule: "a producer has its arity",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "Produce"), (p) => {
				const [first] = p.args
				return site(
					withNode(dag, p.id, { ...p, args: p.producer === "spanPack" ? [first, first] : [first] }),
					atNode(p.id),
					p.producer
				)
			})
	},
	{
		rule: "a closed row has the heading's width",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Closed"), (c) => {
				const [row, ...rows] = c.rows
				const [value] = row ?? []
				if (row === undefined || value === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, c.id, { ...c, rows: [[...row, value], ...rows] }),
						atNode(c.id, "rows", 0),
						"wider"
					),
					site(
						withNode(dag, c.id, { ...c, rows: [row.slice(1), ...rows] }),
						atNode(c.id, "rows", 0),
						"narrower"
					)
				]
			})
	},
	{
		rule: "closed facts are distinct under native equality",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Closed"), (c) => {
				const [row] = c.rows
				if (row === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, c.id, { ...c, rows: [...c.rows, row] }),
						atNode(c.id, "rows", c.rows.length),
						"the same fact"
					)
				]
			})
	}
]

/** Expressions evaluated out of scope, and aggregates outside their bound tuple. */
const scope: ReadonlyArray<DagCorruption> = [
	{
		rule: "an expression reads its node's input only",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(nodesOf(dag), (n) => {
				const evaluated = evaluatedOver(n)
				if (evaluated === undefined) {
					return []
				}
				const read = Arr.flatMap(exprClosure(dag, evaluated.exprs), (id) => {
					const e = exprAt(dag, id)
					return e?.kind === "column" && e.column.node === evaluated.input ? [e] : []
				})
				const [e] = read
				if (e === undefined) {
					return []
				}
				const foreign = foreignNode(
					NodeId("n-foreign"),
					[{ name: e.column.name, type: e.type }],
					n.meta
				)
				const moved = {
					...e,
					column: { node: foreign.id, name: e.column.name },
					deps: {
						params: e.deps.params,
						nodes: Arr.map(e.deps.nodes, (d) => (d === evaluated.input ? foreign.id : d))
					}
				}
				return [
					site(
						{ ...withNode(dag, foreign.id, foreign), exprs: { ...dag.exprs, [e.id]: moved } },
						atNode(n.id),
						n.kind
					)
				]
			})
	},
	{
		/**
		 * A take's correlation is evaluated where the take is read, and names whatever is in scope there. A column of a
		 * node nothing reads as an input is bound by no scope, so planted on a take some root reaches, it reaches that
		 * root unbound, and the validator reports it at the node it names.
		 */
		rule: "a scope expression's column is bound on its way to every root",
		from: "stale",
		weight: 1,
		sites: (dag) => {
			const reached = reachedFromRoots(dag)
			return Arr.flatMap(ofKind(dag, "Take"), (t) => {
				const [column] = t.heading
				if (column === undefined || !reached.has(t.id)) {
					return []
				}
				const foreign = foreignNode(
					NodeId("n-foreign"),
					[{ name: column.name, type: column.type }],
					t.meta
				)
				const read: TableExpr = {
					kind: "column",
					column: { node: foreign.id, name: column.name },
					args: [],
					type: column.type,
					nonNull: "storage",
					volatility: "immutable",
					id: ExprId("e-foreign"),
					deps: { params: [], nodes: [foreign.id] }
				}
				const correlated: TableNode = {
					...t,
					correlation: [...t.correlation, { column: column.name, expr: read.id }]
				}
				return [
					site(
						{
							roots: dag.roots,
							nodes: { ...dag.nodes, [foreign.id]: foreign, [t.id]: correlated },
							exprs: { ...dag.exprs, [read.id]: read }
						},
						atNode(foreign.id),
						t.kind
					)
				]
			})
		}
	},
	{
		rule: "an aggregate reads only its bound tuple",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Group"), (g) =>
				Arr.flatMap(g.aggs, (a, i) => {
					const [c] = columnsRead(
						dag,
						g.input,
						a.filter === undefined ? a.args : [...a.args, a.filter]
					)
					if (c === undefined || !g.bound.columns.includes(c)) {
						return []
					}
					return [
						site(
							withNode(dag, g.id, {
								...g,
								bound: { ...g.bound, columns: without(g.bound.columns, c) },
								keys: without(g.keys, c)
							}),
							atNode(g.id, "aggs", i),
							a.fn
						)
					]
				})
			)
	}
]

const dependencies: ReadonlyArray<DagCorruption> = [
	{
		rule: "a node's read dependencies are the computed ones",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(nodesOf(dag), (n) =>
				site(
					withNode(dag, n.id, {
						...n,
						meta: { ...n.meta, reads: n.meta.reads.length > 0 ? n.meta.reads.slice(1) : ["Ghost"] }
					}),
					atNode(n.id, "meta", "reads"),
					n.kind
				)
			)
	},
	{
		rule: "a node's parameter dependencies are the computed ones",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(nodesOf(dag), (n) =>
				site(
					withNode(dag, n.id, {
						...n,
						meta: {
							...n.meta,
							paramDeps: n.meta.paramDeps.length > 0 ? n.meta.paramDeps.slice(1) : ["ghost"]
						}
					}),
					atNode(n.id, "meta", "paramDeps"),
					n.kind
				)
			)
	}
]

/**
 * The longest prefix of an order, the whole order included, whose columns with `fixed` leave ties among the input's
 * rows: an order is total once a prefix is, so it is the prefix before the first total one.
 */
const tiedPrefix = (
	dag: DagTable,
	input: NodeId,
	keys: ReadonlyArray<{ readonly column: string }>,
	fixed: ReadonlyArray<string>
): ReadonlyArray<{ readonly column: string }> | undefined => {
	const total = (j: number) =>
		totalOver(dag, input, [...Arr.map(keys.slice(0, j), (k) => k.column), ...fixed])
	if (total(0)) {
		return undefined
	}
	let j = 0
	while (j < keys.length && !total(j + 1)) {
		j++
	}
	return keys.slice(0, j)
}

const orders: ReadonlyArray<DagCorruption> = [
	{
		rule: "an order is total",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(nodesOf(dag), (n) => {
				const broken = (
					keys: ReadonlyArray<{ readonly column: string }> | undefined,
					value: object
				) =>
					keys === undefined
						? []
						: [site(withNode(dag, n.id, value), atNode(n.id, "order"), n.kind)]
				switch (n.kind) {
					case "Take": {
						const keys = tiedPrefix(
							dag,
							n.input,
							n.order.keys,
							Arr.map(n.correlation, (c) => c.column)
						)
						return broken(keys, { ...n, order: { keys } })
					}
					case "OrderedResult": {
						const keys = tiedPrefix(dag, n.input, n.order.keys, [])
						return broken(keys, { ...n, order: { keys } })
					}
					case "Attach": {
						if (n.order === undefined) {
							return []
						}
						const keys = tiedPrefix(
							dag,
							n.child,
							n.order.keys,
							Arr.map(n.correlation, (c) => c.child)
						)
						return broken(keys, { ...n, order: { keys } })
					}
					case "Window": {
						if (!orderSensitiveWindowFns.includes(n.fn)) {
							return []
						}
						const keys = tiedPrefix(dag, n.input, n.order.keys, [])
						return broken(keys, { ...n, partition: [], order: { keys } })
					}
					case "AntiJoin":
					case "ApproximateNearest":
					case "Base":
					case "Closed":
					case "Context":
					case "Delta":
					case "Difference":
					case "Filter":
					case "Forbid":
					case "Group":
					case "InputSet":
					case "Intersect":
					case "MatchRegion":
					case "OrderedSetAggregate":
					case "Produce":
					case "ProjectSet":
					case "Recursive":
					case "SelfRef":
					case "SemiJoin":
					case "Union":
						return []
				}
			})
	},
	{
		rule: "a logical key names heading columns",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(nodesOf(dag), (n) =>
				site(
					withNode(dag, n.id, {
						...n,
						meta: {
							...n.meta,
							logicalKeys: [
								...n.meta.logicalKeys,
								rewriteClaim([freshName(n.heading, "ghost")], [])
							]
						}
					}),
					atNode(n.id, "meta", "logicalKeys", n.meta.logicalKeys.length),
					n.kind
				)
			)
	},
	{
		rule: "logical keys are distinct",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(nodesOf(dag), (n) => {
				const [claimed] = n.meta.logicalKeys
				if (claimed === undefined) {
					return []
				}
				return [
					site(
						withNode(dag, n.id, {
							...n,
							meta: {
								...n.meta,
								logicalKeys: [
									...n.meta.logicalKeys,
									rewriteClaim(Arr.reverse([...claimedColumns(claimed)]), [])
								]
							}
						}),
						atNode(n.id, "meta", "logicalKeys", n.meta.logicalKeys.length),
						n.kind
					)
				]
			})
	},
	{
		rule: "the empty key needs at most one row",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(
				Arr.filter(
					nodesOf(dag),
					(n) =>
						n.meta.card === "many" &&
						!Arr.some(n.meta.logicalKeys, (k) => claimedColumns(k).length === 0)
				),
				(n) =>
					site(
						withNode(dag, n.id, {
							...n,
							meta: { ...n.meta, logicalKeys: [...n.meta.logicalKeys, rewriteClaim([], [])] }
						}),
						atNode(n.id, "meta", "logicalKeys", n.meta.logicalKeys.length),
						n.kind
					)
			)
	}
]

const recursion: ReadonlyArray<DagCorruption> = [
	{
		rule: "a recursion's self is its feedback reference",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "Recursive"), (r) =>
				site(withNode(dag, r.id, { ...r, self: r.base }), atNode(r.id), r.kind)
			)
	},
	{
		rule: "a recursion's base and step have its state heading",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Recursive"), (r) => {
				const foreign = foreignNode(
					NodeId("n-foreign"),
					[{ name: freshName(r.heading, "ghost"), type: scalarTypes.int4 }],
					r.meta
				)
				return Arr.map(["base", "step"] as const, (side) =>
					site(
						withNodes(
							dag,
							[
								[foreign.id, foreign],
								[r.id, { ...r, [side]: foreign.id }]
							],
							dag.roots
						),
						atNode(r.id, side),
						side
					)
				)
			})
	},
	{
		rule: "a recursion has one feedback reference",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "SelfRef"), (s) =>
				site(
					withNode(dag, "n-second", { ...s, id: "n-second" }),
					atNode(NodeId("n-second")),
					s.kind
				)
			)
	},
	{
		rule: "a recursion's base never reads its feedback",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "Recursive"), (r) =>
				site(withNode(dag, r.id, { ...r, base: r.self }), atNode(r.id, "base"), r.kind)
			)
	},
	{
		rule: "a recursion's step reads its feedback",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "Recursive"), (r) =>
				site(withNode(dag, r.id, { ...r, step: r.base }), atNode(r.id, "step"), r.kind)
			)
	},
	{
		rule: "only the step reads the feedback",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofKind(dag, "SelfRef"), (s) => {
				const outside: TableNode = {
					id: NodeId("n-outside"),
					kind: "OrderedResult",
					input: s.id,
					order: { keys: Arr.map(s.heading, (c) => ({ column: c.name, dir: "asc" })) },
					heading: s.heading,
					meta: s.meta,
					loc: undefined
				}
				return site(
					withNodes(dag, [[outside.id, outside]], [...dag.roots, outside.id]),
					atNode(outside.id),
					s.kind
				)
			})
	}
]

/** The internal nodes the rewrites produce, and the aggregates. */
const internal: ReadonlyArray<DagCorruption> = [
	{
		rule: "a window function has its arity",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Window"), (w) => {
				const [value] = w.args
				const extra =
					value === undefined ? columnOfOtherType(dag, w.input, undefined) : Option.some(value)
				return Option.isNone(extra)
					? []
					: [
							site(
								withNode(dag, w.id, {
									...w,
									args: [...w.args, extra.value, extra.value, extra.value]
								}),
								atNode(w.id),
								w.fn
							)
						]
			})
	},
	{
		rule: "lead and lag take an integer offset and a default of the value's type",
		from: "wild",
		weight: 1,
		sites: (dag) => {
			const shifts = Arr.filter(ofKind(dag, "Window"), (w) => w.fn === "lag" || w.fn === "lead")
			return Arr.flatMap(shifts, (w) => {
				const [value, offset, fallback] = w.args
				const valueType = value === undefined ? undefined : exprAt(dag, value)?.type
				const offsetType = offset === undefined ? undefined : exprAt(dag, offset)?.type
				return [
					...(value !== undefined &&
					valueType !== undefined &&
					baseOf(valueType).carrier !== "int4" &&
					fallback !== undefined
						? [
								site(
									withNode(dag, w.id, { ...w, args: [value, value, fallback] }),
									atNode(w.id),
									"offset"
								)
							]
						: []),
					...(offset !== undefined &&
					valueType !== undefined &&
					offsetType !== undefined &&
					!sameScalarType(valueType, offsetType)
						? [
								site(
									withNode(dag, w.id, { ...w, args: [value, offset, offset] }),
									atNode(w.id),
									"default"
								)
							]
						: [])
				]
			})
		}
	},
	{
		rule: "a ROWS frame belongs to an ordered window aggregate, start before end",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Window"), (w) => {
				const aggregate = ["count", "sum", "avg", "min", "max"].includes(w.fn)
				const { frame, ...unframed } = w
				if (!aggregate) {
					return [
						site(
							withNode(dag, w.id, {
								...w,
								frame: { unit: "rows", start: "unboundedPreceding", end: "currentRow" }
							}),
							atNode(w.id),
							"framed ordinal"
						)
					]
				}
				if (frame === undefined) {
					return []
				}
				return [
					site(withNode(dag, w.id, unframed), atNode(w.id), "unframed aggregate"),
					site(
						withNode(dag, w.id, {
							...w,
							frame: { unit: "rows", start: { following: 1n }, end: "currentRow" }
						}),
						atNode(w.id),
						"backward frame"
					)
				]
			})
	},
	{
		rule: "only a count is filtered",
		from: "wild",
		weight: 1,
		sites: (dag) => {
			const found = booleanLiteral(dag)
			if (Option.isNone(found)) {
				return []
			}
			const flag = found.value
			return [
				...Arr.map(
					Arr.filter(ofKind(dag, "Window"), (w) => w.fn !== "count"),
					(w) => site(withNode(dag, w.id, { ...w, filter: flag }), atNode(w.id), "window")
				),
				...Arr.flatMap(ofKind(dag, "Group"), (g) =>
					Arr.flatMap(g.aggs, (a, i) =>
						a.fn === "count"
							? []
							: [
									site(
										withNode(dag, g.id, {
											...g,
											aggs: Arr.map(g.aggs, (b, j) => (j === i ? { ...b, filter: flag } : b))
										}),
										atNode(g.id, "aggs", i),
										"aggregate"
									)
								]
					)
				)
			]
		}
	},
	{
		rule: "an aggregate has its arity",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "Group"), (g) =>
				Arr.map(g.aggs, (a, i) =>
					site(
						withNode(dag, g.id, {
							...g,
							aggs: Arr.map(g.aggs, (b, j) =>
								j === i ? { ...b, fn: a.args.length === 0 ? "sum" : "count" } : b
							)
						}),
						atNode(g.id, "aggs", i),
						a.fn
					)
				)
			)
	},
	{
		rule: "an ordered-set aggregate orders by one column, with a double precision fraction per output",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofKind(dag, "OrderedSetAggregate"), (o) => {
				const second = columnWhere(
					nodeAt(dag, o.input),
					(c) => !Arr.some(o.order.keys, (k) => k.column === c.name)
				)
				const integer = Arr.findFirst(
					ofExprKind(dag, "literal"),
					(e) => baseOf(e.type).carrier === "int4"
				)
				return [
					...(o.fn === "mode"
						? []
						: [site(withNode(dag, o.id, { ...o, fractions: [] }), atNode(o.id), "no fraction")]),
					site(
						withNode(dag, o.id, { ...o, fn: o.fn === "mode" ? "percentileDisc" : "mode" }),
						atNode(o.id),
						"other function"
					),
					...(Option.isNone(second)
						? []
						: [
								site(
									withNode(dag, o.id, {
										...o,
										order: { keys: [...o.order.keys, { column: second.value.name, dir: "asc" }] }
									}),
									atNode(o.id),
									"two order columns"
								)
							]),
					...(Option.isNone(integer) || o.fractions.length === 0
						? []
						: [
								site(
									withNode(dag, o.id, {
										...o,
										fractions: Arr.map(o.fractions, () => integer.value.id)
									}),
									atNode(o.id, "fractions", 0),
									"integer fraction"
								)
							])
				]
			})
	}
]

/**
 * A contract over a type's base, which a comparison parameter is never bound as: a type the validator's input may
 * hold, whether or not its shape is one the decoder admits.
 */
const refinedOver = (t: ScalarType): unknown => {
	const base = baseOf(t)
	return { ...base, contract: { name: "Ghost", base } }
}

/** The parents of each expression, with the argument position. */
const parents = (
	dag: DagTable
): ReadonlyArray<{ readonly parent: TableExpr; readonly arg: TableExpr }> =>
	Arr.flatMap(exprsOf(dag), (parent) =>
		Arr.flatMap(parent.args, (id) => {
			const arg = exprAt(dag, id)
			return arg === undefined ? [] : [{ parent, arg }]
		})
	)

const expressions: ReadonlyArray<DagCorruption> = [
	{
		rule: "a literal fits its type",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofExprKind(dag, "literal"), (e) => {
				switch (e.value.kind) {
					case "int":
						return [
							site(
								withExpr(dag, e.id, { ...e, value: { kind: "int", value: 1n << 70n } }),
								atExpr(e.id),
								"integer"
							)
						]
					case "text":
						return [
							site(
								withExpr(dag, e.id, { ...e, value: { kind: "text", value: "\uD800" } }),
								atExpr(e.id),
								"text"
							)
						]
					case "numeric": {
						/** A value with a fraction, under a typmod of scale 0, which would round it. */
						const parts = e.value.value.parts
						const fractional = parts.kind === "finite" && parts.minScale > 0
						const rounding = scalarOf(field.numeric(38, 0), {})
						return fractional
							? [site(withExpr(dag, e.id, { ...e, type: rounding }), atExpr(e.id), "numeric")]
							: []
					}
					case "bool":
					case "handle":
					case "handles":
					case "float":
					case "floatSpecial":
					case "money":
					case "span":
					case "uuid":
					case "vector":
						return []
				}
			})
	},
	{
		rule: "a comparison parameter is bound as its base type",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(
				Arr.filter(ofExprKind(dag, "param"), (e) => e.role === "compare"),
				(e) =>
					site(
						withExpr(dag, e.id, { ...e, type: refinedOver(e.type) }),
						atExpr(e.id),
						baseOf(e.type).carrier
					)
			)
	},
	{
		rule: "an expression's dependencies are the computed ones",
		from: "stale",
		weight: 1,
		sites: (dag) =>
			Arr.map(exprsOf(dag), (e) =>
				site(
					withExpr(dag, e.id, {
						...e,
						deps:
							e.deps.params.length + e.deps.nodes.length > 0
								? { params: [], nodes: [] }
								: { params: [], nodes: [absentNode] }
					}),
					atExpr(e.id),
					e.kind
				)
			)
	},
	{
		rule: "an expression is stable when an argument is",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(
				Arr.filter(
					parents(dag),
					({ parent, arg }) => parent.volatility === "immutable" && arg.volatility === "immutable"
				),
				({ parent, arg }) =>
					site(
						withExpr(dag, arg.id, { ...arg, volatility: "stable" }),
						atExpr(parent.id),
						parent.kind
					)
			)
	},
	{
		rule: "a conditional has a boolean condition and branches of its type",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofExprKind(dag, "cond"), (e) => {
				const [, onTrue, onFalse] = e.args
				const branch = exprAt(dag, onTrue)
				return [
					site(withExpr(dag, e.id, { ...e, type: otherType(e.type) }), atExpr(e.id), "branch type"),
					...(branch === undefined || baseOf(branch.type).carrier === "bool"
						? []
						: [
								site(
									withExpr(dag, e.id, { ...e, args: [onTrue, onTrue, onFalse] }),
									atExpr(e.id),
									"condition"
								)
							])
				]
			})
	},
	{
		rule: "VALUE appears only in a contract predicate",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofExprKind(dag, "literal"), (e) =>
				site(
					withExpr(dag, e.id, {
						id: e.id,
						kind: "value",
						args: [],
						nonNull: "storage",
						type: e.type,
						volatility: e.volatility,
						deps: e.deps
					}),
					atExpr(e.id),
					e.value.kind
				)
			)
	},
	{
		rule: "a column reference keeps its column's type",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofExprKind(dag, "column"), (e) =>
				site(withExpr(dag, e.id, { ...e, type: otherType(e.type) }), atExpr(e.id), "column")
			)
	},
	{
		rule: "a partial operation stands with a proof the kernel re-derives",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofExprKind(dag, "cast"), (e) =>
				"proof" in e
					? [
							site(
								withExpr(dag, e.id, {
									...e,
									proof: mapNonEmpty(e.proof, (p) =>
										p.precondition.kind === "fits"
											? {
													precondition: p.precondition,
													premises: [
														{ kind: "interval", operand: 0, ...pastFit(e.type), nan: false }
													]
												}
											: p
									)
								}),
								atExpr(e.id),
								"an interval past the target"
							)
						]
					: []
			)
	},
	{
		rule: "every precondition of a partial operation stands with a proof of its own",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.flatMap(ofExprKind(dag, "cast"), (e) => {
				if (!("proof" in e)) {
					return []
				}
				const [first, ...rest] = e.proof
				const stranger = {
					precondition: { kind: "powerDomain" },
					premises: first.premises
				} as const
				return [
					site(
						withExpr(dag, e.id, { ...e, proof: [stranger, ...rest] }),
						atExpr(e.id),
						"an entry for a precondition the cast does not require"
					),
					...(Arr.isReadonlyArrayNonEmpty(rest)
						? [
								site(
									withExpr(dag, e.id, { ...e, proof: [first] }),
									atExpr(e.id),
									"a precondition no entry proves"
								)
							]
						: [])
				]
			})
	},
	{
		rule: "a domain cast targets a refined type",
		from: "wild",
		weight: 1,
		sites: (dag) =>
			Arr.map(ofExprKind(dag, "domainCast"), (e) =>
				site(withExpr(dag, e.id, { ...e, type: baseOf(e.type) }), atExpr(e.id), "unrefined target")
			)
	}
]

/**
 * An interval one unit past each end of the range a value must lie in to fit `target`, however wide its typmod; a
 * target with no such range takes no fits proof at all, so any interval is past it.
 */
const pastFit = (target: ScalarType): { readonly low: Exact; readonly high: Exact } => {
	const range = fitRange(target)
	return range === undefined
		? { low: { units: -(10n ** 40n), scale: 0 }, high: { units: 10n ** 40n, scale: 0 } }
		: {
				low: { units: range[0].units - 1n, scale: range[0].scale },
				high: { units: range[1].units + 1n, scale: range[1].scale }
			}
}

/** Values no field of a node or expression holds: properties of no kind, and null. */
const shapes: ReadonlyArray<DagCorruption> = [
	{
		rule: "a node or expression holds its kind's properties only",
		from: "wild",
		weight: 1,
		sites: (dag) => [
			...Arr.map(nodesOf(dag), (n) =>
				site(withNode(dag, n.id, { ...n, ghost: 1 }), atNode(n.id), n.kind)
			),
			...Arr.map(exprsOf(dag), (e) =>
				site(withExpr(dag, e.id, { ...e, ghost: 1 }), atExpr(e.id), e.kind)
			)
		]
	},
	{
		rule: "no field holds null",
		from: "wild",
		weight: 1,
		sites: (dag) => [
			...Arr.flatMap(nodesOf(dag), (n) =>
				Arr.map(fieldNames({ ...n }), (k) =>
					site(withNode(dag, n.id, { ...n, [k]: null }), atNode(n.id), `${n.kind}.${k}`)
				)
			),
			...Arr.flatMap(exprsOf(dag), (e) =>
				Arr.map(fieldNames({ ...e }), (k) =>
					site(withExpr(dag, e.id, { ...e, [k]: null }), atExpr(e.id), `${e.kind}.${k}`)
				)
			)
		]
	}
]

/**
 * The corruptions of a valid relational DAG: one per rule the validator holds (test/support/oracle/dag-validate.ts), each
 * breaking its rule at every site a DAG offers and naming where the validator must report it, and the live variants,
 * valid DAGs derived from a valid one that the validator must accept. A DAG grizzle built that breaks a rule is a defect
 * of grizzle, so the validator raises one, naming the first rule it finds broken.
 *
 * Rule: a refusal is the place the broken rule is reported: the corrupted node or expression, or one of its parts
 * ("within"), or exactly the table ("at"), where the validator reports a rule over the whole table. Never a message:
 * what the validator says about a problem is its own. A corruption may break more than its rule (a dropped column
 * breaks every reader of it); the validator must report its rule among the rest. A site is named by the kind of node or
 * expression it breaks, never by an identifier.
 *
 * Each corruption states its rule in the validator's terms, independently of how the validator checks it: which
 * columns make an order total, which arm binds a literal, which child columns cover a key. A rule restated here and
 * checked there disagree only where one of them is wrong.
 */
export const dagCorruptions: Arr.NonEmptyReadonlyArray<DagCorruption> = [
	...references,
	...identities,
	...headings,
	...unions,
	...attachments,
	...kinds,
	...scope,
	...dependencies,
	...orders,
	...recursion,
	...internal,
	...expressions,
	...shapes
]

/**
 * The valid DAGs a valid one gives when a claim is widened, a key's superset claimed, or a union arm read through a
 * node that keeps its rows (an ordered result, a take of one).
 */
export const liveVariants = (dag: DagTable): ReadonlyArray<LiveVariant> => [
	...Arr.flatMap(ofKind(dag, "Attach"), (a) => {
		const { order: _order, ...unordered } = a
		return a.delivered === "array"
			? []
			: [
					{
						at: "a delivery widened to an array",
						value: withNode(dag, a.id, { ...unordered, delivered: "array" })
					}
				]
	}),
	...Arr.flatMap(nodesOf(dag), (n) => {
		const [first] = n.meta.logicalKeys
		if (first === undefined) {
			return []
		}
		const key = claimedColumns(first)
		const extra = Arr.findFirst(n.heading, (c) => !key.includes(c.name))
		if (Option.isNone(extra)) {
			return []
		}
		const superkey: KeySet = [...key, extra.value.name]
		const claimed = Arr.some(
			Arr.map(n.meta.logicalKeys, claimedColumns),
			(k) => k.length === superkey.length && Arr.every(superkey, (c) => k.includes(c))
		)
		return claimed
			? []
			: [
					{
						at: "a superkey claimed",
						value: withNode(dag, n.id, {
							...n,
							meta: { ...n.meta, logicalKeys: [...n.meta.logicalKeys, rewriteClaim(superkey, [])] }
						})
					}
				]
	}),
	...Arr.flatMap(heteroUnions(dag), (u) =>
		Arr.flatMap(u.groups, (g, gi) =>
			Arr.flatMap(g.arms, (arm, ai) => {
				const node = nodeAt(dag, arm)
				if (node === undefined) {
					return []
				}
				const order = {
					keys: Arr.map(node.heading, (c) => ({ column: c.name, dir: "asc" as const }))
				}
				const wrappers: ReadonlyArray<TableNode> = [
					{
						id: NodeId("n-kept"),
						kind: "OrderedResult",
						input: arm,
						order,
						heading: node.heading,
						meta: node.meta,
						loc: undefined
					},
					{
						id: NodeId("n-kept"),
						kind: "Take",
						input: arm,
						order,
						bound: { kind: "literal", k: 1n },
						correlation: [],
						heading: node.heading,
						meta: node.meta,
						loc: undefined
					}
				]
				const groups = (wrapper: NodeId) =>
					Arr.map(u.groups, (h, hi) =>
						hi === gi ? { ...h, arms: Arr.map(h.arms, (a, aj) => (aj === ai ? wrapper : a)) } : h
					)
				return Arr.map(wrappers, (w) => ({
					at: `an arm read through ${w.kind}`,
					value: withNodes(
						dag,
						[
							[w.id, w],
							[u.id, { ...u, groups: groups(w.id) }]
						],
						dag.roots
					)
				}))
			})
		)
	)
]
