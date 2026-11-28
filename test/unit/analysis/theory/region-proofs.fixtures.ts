/**
 * What region-proofs.test.ts reads: its boxes of schemas, each one rule its judge holds whole, over nodes beside tags or
 * over a chain of keyed relations; the transitions it draws between two states the schema's laws hold in; and the
 * region the rule's judge reads over a transition, each rule of the region read over the transition's delta.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { WholeRule } from "#compiler/analysis/theory/query.ts"
import {
	type FieldContainment,
	type RegionFacts,
	wholeRule
} from "#compiler/analysis/theory/unit.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type {
	InferredExpr,
	InferredQuery,
	InferredRule,
	InferredStage,
	LiteralDesc
} from "#compiler/ir/desc.ts"
import { type Node, numbered } from "#test/support/families/tree.ts"
import {
	type AuthoredExprDesc,
	type AuthoredRelationDesc,
	contained,
	decodedQuery,
	eq,
	f,
	field,
	fin,
	literal,
	ne,
	on,
	onWhere,
	type QueryDesc,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	drawnNatural,
	type HostFacts,
	relationsOf,
	type TestTheory,
	theoryOf,
	violates
} from "#test/support/unit/analysis/theory/support.ts"

/** A value of a row: a natural or an integer, as a bigint, or a boolean. */
type Value = bigint | boolean

/** A row of a box: its fields' values. */
export type Row = Readonly<Record<string, Value>>

/** Rows of each relation, a set by their values. */
export type Instance = Readonly<Record<string, ReadonlyArray<Row>>>

/** Whether two rows hold one value at every field. */
const sameRow = (a: Row, b: Row): boolean =>
	Rec.keys(a).length === Rec.keys(b).length && Arr.every(Rec.keys(a), (h) => a[h] === b[h])

/** The rows of `rows` no row of `others` is. */
const without = (rows: ReadonlyArray<Row>, others: ReadonlyArray<Row>): ReadonlyArray<Row> =>
	Arr.filter(rows, (r) => !Arr.some(others, (o) => sameRow(r, o)))

/** A box's documents: every relation of every box leads its key with `doc`, the unit of each rule. */
const docs = [1n, 2n, 3n] as const

/** An instance's rows of document `doc` alone. */
const unitOf = (instance: Instance, doc: bigint): HostFacts =>
	Rec.map(instance, (rows) => Arr.filter(rows, (r) => r["doc"] === doc))

/** A transition between two states. */
export interface Transition {
	readonly before: Instance
	readonly after: Instance
}

/** The rows of `relation` a transition gained, `added`, or lost, `removed`. */
const deltaOf = (
	t: Transition,
	relation: string,
	side: "added" | "removed"
): ReadonlyArray<Row> => {
	const before = t.before[relation] ?? []
	const after = t.after[relation] ?? []
	return side === "added" ? without(after, before) : without(before, after)
}

/** The rule a theory states over its D, judged whole: the theory's one check law, which no other statement states. */
export const wholeRuleOf = (
	t: TestTheory
): { readonly law: TheoryLaw; readonly rule: WholeRule } => {
	const [found, ...more] = Arr.flatMap(t.laws, (law) =>
		law.shape === "check" && law.detail.kind === "rule" && law.detail.rule.kind === "whole"
			? [{ law, rule: law.detail.rule }]
			: []
	)
	assert.equal(more.length, 0, "the theory judges one check whole")
	return defined(found, "the theory judges its check whole")
}

/** The rules of a whole rule's region, the step every outermost rule of its judged query matches (unit.ts regionOf). */
export const regionRulesOf = (judged: InferredQuery): ReadonlyArray<InferredRule> => {
	const rulesOf = (stage: InferredStage): ReadonlyArray<InferredRule> => {
		switch (stage.kind) {
			case "rules":
				return stage.arms
			case "union":
				return [...rulesOf(stage.input), ...stage.arms]
			case "named":
			case "attach":
			case "order":
			case "take":
			case "approx":
				return rulesOf(stage.input)
			case "recursive":
				return []
		}
	}
	const [region] = Arr.flatMap(rulesOf(judged.stage), (r) =>
		Arr.flatMap(r.matches, (m) => (m.source.kind === "step" ? [m.source.query] : []))
	)
	return rulesOf(defined(region, "a whole rule's judged query matches its region").stage)
}

/** A region rule's delta: the relation and side its one match reads. */
export const deltaRead = (
	rule: InferredRule
): { readonly relation: string; readonly side: "added" | "removed" } => {
	const [m, ...more] = rule.matches
	assert.equal(more.length, 0, "a region rule matches one delta")
	const source = defined(m, "a region rule's match").source
	return source.kind === "delta" && source.side !== "met"
		? { relation: source.relation, side: source.side }
		: assert.fail("a region rule matches a delta of added or removed rows")
}

/** A literal of a region's condition as a row holds it: an integer a bigint. */
const valueOfLiteral = (value: LiteralDesc): Value =>
	typeof value === "number"
		? BigInt(value)
		: typeof value === "bigint" || typeof value === "boolean"
			? value
			: assert.fail(`a literal the boxes' rules state: ${Formatter.format(value)}`)

/**
 * The rows of a region rule's delta it admits over `t`: each row its match binds, whose bindings its conditions hold of,
 * each condition a comparison of its variables and literals, a membership, a connective, or the existence of a delta's
 * row at its variables, the forms the boxes' regions state; any other a failure of the box.
 */
const admitted = (rule: InferredRule, t: Transition): ReadonlyArray<Row> => {
	const read = deltaRead(rule)
	const [m] = rule.matches
	const bindings = defined(m, "a region rule's match").bindings
	const valueOf = (e: InferredExpr, env: ReadonlyMap<string, Value>): Value =>
		e.kind === "var"
			? defined(env.get(e.var), `${e.var}, bound by the rule's match`)
			: e.kind === "literal"
				? valueOfLiteral(e.value)
				: assert.fail(`a term the boxes' regions read: ${e.kind}`)
	const holds = (e: InferredExpr, env: ReadonlyMap<string, Value>): boolean => {
		if (e.kind === "compare") {
			const l = valueOf(e.left, env)
			const r = valueOf(e.right, env)
			switch (e.op) {
				case "eq":
					return l === r
				case "ne":
					return l !== r
				case "lt":
					return l < r
				case "le":
					return l <= r
				case "gt":
					return l > r
				case "ge":
					return l >= r
			}
		}
		if (e.kind === "in") {
			const at = valueOf(e.arg, env)
			return Arr.some(e.values, (value) => valueOfLiteral(value) === at)
		}
		if (e.kind === "and") {
			return Arr.every(e.args, (a) => holds(a, env))
		}
		if (e.kind === "or") {
			return Arr.some(e.args, (a) => holds(a, env))
		}
		if (e.kind === "not") {
			return !holds(e.arg, env)
		}
		if (e.kind === "exists" && e.source.kind === "delta" && e.source.side !== "met") {
			const lost = deltaOf(t, e.source.relation, e.source.side)
			return Arr.some(lost, (row) =>
				Arr.every(Rec.toEntries(e.bindings), ([field, term]) => row[field] === valueOf(term, env))
			)
		}
		return assert.fail(`a condition the boxes' regions state: ${e.kind}`)
	}
	return Arr.filter(deltaOf(t, read.relation, read.side), (row) => {
		const env = new Map(
			Arr.flatMap(Rec.toEntries(bindings), ([field, term]) =>
				term.kind === "var" ? [[term.var, defined(row[field], `${field} of a row`)] as const] : []
			)
		)
		return Arr.every(rule.where, (c) => holds(c, env))
	})
}

/** The documents a whole rule's region reads over `t`: the unit of every row a rule of it admits. */
export const regionOf = (rule: WholeRule, t: Transition): ReadonlyArray<bigint> =>
	Arr.dedupe(
		Arr.flatMap(regionRulesOf(rule.judged), (r) =>
			Arr.flatMap(admitted(r, t), (row) => {
				const doc = row["doc"]
				return typeof doc === "bigint" ? [doc] : []
			})
		)
	)

/** The documents where the state after `t` breaks `law` (the reference evaluator over each document's rows alone). */
export const brokenDocs = (
	t: TestTheory,
	law: TheoryLaw,
	instance: Instance
): ReadonlyArray<bigint> => Arr.filter(docs, (doc) => violates(t, law, unitOf(instance, doc)))

/** Whether `instance` holds every law of `t` but `except`. */
export const lawfulBut = (t: TestTheory, except: TheoryLaw, instance: Instance): boolean =>
	Arr.every(t.laws, (law) => law.id === except.id || !violates(t, law, instance))

/** `instance` without the documents `doc` among `broken`: a rule unit-local at doc holds there of the rest alone. */
const withoutDocs = (instance: Instance, broken: ReadonlyArray<bigint>): Instance =>
	Rec.map(instance, (rows) => Arr.filter(rows, (r) => !Arr.some(broken, (doc) => r["doc"] === doc)))

/**
 * A transition to `after` from `before` with every document where `before` breaks the rule dropped, so the state before
 * it holds every law: dropping a document drops every row of its unit, which keeps every other law.
 */
export const lawfulTransition = (
	t: TestTheory,
	law: TheoryLaw,
	before: Instance,
	after: Instance
): Transition => ({ before: withoutDocs(before, brokenDocs(t, law, before)), after })

/** How the box's T stands: each document's tree, its root doc, or a plain relation of its fields under no tree law. */
export type Nodes = "tree" | "plain"

/** Which of Tag's rows the schema contains in T at (doc, start): every row, those of b true, or those of b true and,
 * by a second statement, those of b false. */
export type Tagged = "every" | "true" | "true and false"

/**
 * The rule the box judges whole, a check over D, a node's or a tag's value at 1 refused:
 *
 * - `parent beside child`: a node of kind 2 beside its parent, the parent's kind;
 * - `child beside its parent's tag`: a node of kind 1 beside the tag of b true at its parent, the tag's mark;
 * - `two nodes at one key`: a node of kind 1 beside itself read again, its children;
 * - `two nodes of one kind`: two nodes of one document and one kind, the later a leaf, that kind;
 * - `a tag beside its node`: a tag of mark 1 and either b beside its node, the node's kind;
 * - `a false tag beside its node`: a tag of mark 1 and b false beside its node, the node's kind;
 * - `a node beside its kind`: a node beside the row of K that lists its kind in its document, its children.
 */
export type Shape =
	| "parent beside child"
	| "child beside its parent's tag"
	| "two nodes at one key"
	| "two nodes of one kind"
	| "a tag beside its node"
	| "a false tag beside its node"
	| "a node beside its kind"

export interface NodeBox {
	readonly nodes: Nodes
	readonly tagged: Tagged
	readonly shape: Shape
}

/** A node box of one of `shapes`, its nodes and its tags' containments drawn. */
export const nodeBoxGen =
	(shapes: Arr.NonEmptyReadonlyArray<Shape>): Gen<NodeBox> =>
	(s) => ({
		nodes: s.draw(element(["tree", "plain"] as const)),
		tagged: s.draw(element(["every", "true", "true and false"] as const)),
		shape: s.draw(element(shapes))
	})

/**
 * How many of the region's rules read the rows T gained, every one their conditions admit: one for each set of
 * conditions of the occurrences of T the proofs of analysis/theory/unit.ts spare nothing, the region holding each rule
 * once, and none for a proved occurrence, whose gained rows open a fact only beside a witness's row the write gained. A tree's rows are fixed at its root, doc, by any of them standing,
 * so another occurrence of T in the document proves one, or an occurrence of Tag whose reading implies a containment of
 * it into T; a plain T's are fixed at its key alone, so only such an occurrence at its key does. Of the occurrences that
 * prove each other, the one its conditions restrict most is read.
 */
export const wholeReads = (box: NodeBox): number => {
	const tree = box.nodes === "tree"
	switch (box.shape) {
		case "parent beside child":
		case "two nodes of one kind":
			return tree ? 1 : 2
		case "child beside its parent's tag":
			return tree ? 0 : 1
		case "two nodes at one key":
			return 1
		case "a tag beside its node":
		case "a false tag beside its node":
			return box.tagged === "true" ? 1 : 0
		case "a node beside its kind":
			return tree ? 0 : 1
	}
}

/**
 * Whether the box's rule proves an occurrence of T (unit.ts proofsOf): one beside a witness binding a key of T alike, or
 * a tree's root, doc, where one binds doc alike.
 */
export const provesAnOccurrence = (box: NodeBox): boolean => {
	const tree = box.nodes === "tree"
	switch (box.shape) {
		case "parent beside child":
		case "child beside its parent's tag":
		case "two nodes of one kind":
		case "a node beside its kind":
			return tree
		case "two nodes at one key":
			return true
		case "a tag beside its node":
		case "a false tag beside its node":
			return box.tagged !== "true"
	}
}

/** A term a match binds a field to: a variable by its name, or a literal. */
type Bound = string | bigint | boolean

/** A match of `relation` binding each field `bindings` names. */
interface Match {
	readonly relation: string
	readonly bindings: Readonly<Record<string, Bound>>
}

/**
 * D: the one rule of `matches`, joined at their shared variables under `where`, finding each fact's `doc`, `start` and
 * `value`, its variables declared at the first field each is bound to.
 */
const derivedOf = (
	matches: ReadonlyArray<Match>,
	where: ReadonlyArray<AuthoredExprDesc>,
	head: { readonly doc: string; readonly start: string; readonly value: string }
): AuthoredRelationDesc => {
	const declared: ReadonlyArray<{
		readonly id: string
		readonly origin: { readonly relation: string; readonly field: string }
	}> = Arr.flatMap(matches, (m) =>
		Arr.flatMap(Rec.toEntries(m.bindings), ([at, term]) =>
			typeof term === "string" ? [{ id: term, origin: { relation: m.relation, field: at } }] : []
		)
	)
	const vars = Arr.dedupeWith(declared, (x, y) => x.id === y.id)
	const query: QueryDesc = decodedQuery({
		kind: "rules",
		arms: [
			{
				vars,
				matches: Arr.map(matches, (m) => ({
					source: { kind: "relation", name: m.relation },
					bindings: Rec.map(m.bindings, (term) =>
						typeof term === "string" ? { kind: "var", var: term } : literal(term)
					)
				})),
				where,
				head: Rec.map(head, (term) => ({ kind: "var", var: term })),
				interiors: [],
				attach: []
			}
		]
	})
	return { kind: "derived", name: "D", level: 1, query }
}

/** A comparison of two variables. */
const lt = (left: string, right: string): AuthoredExprDesc => ({
	kind: "compare",
	op: "lt",
	left: { kind: "var", var: left },
	right: { kind: "var", var: right }
})

/**
 * The reads box's D: a node of T at kind 0 beside `reads` reads of an import of `kinds` rules, rule j T's nodes at kind
 * j, by their document and key: its walk stands `reads` × `kinds` occurrences of T in its region beside the node's own,
 * each rule's read `reads` times, so its region holds a rule for each kind and side, each made of `reads` occurrences
 * (unit.ts regionOf).
 */
const readsRuleOf = (kinds: number, reads: number): AuthoredRelationDesc => {
	/** Rule j of the import: T's nodes at kind 1 + j. */
	const nodesAt = (j: number) =>
		({
			vars: Arr.map(["doc", "start"], (id) => ({ id, origin: { relation: "T", field: id } })),
			matches: [
				{
					source: { kind: "relation", name: "T" },
					bindings: {
						doc: { kind: "var", var: "doc" },
						start: { kind: "var", var: "start" },
						kind: literal(BigInt(1 + j))
					}
				}
			],
			where: [],
			head: { doc: { kind: "var", var: "doc" }, start: { kind: "var", var: "start" } },
			interiors: [],
			attach: []
		}) as const
	const nodes: QueryDesc = decodedQuery({
		kind: "rules",
		arms: [nodesAt(0), ...Array.from({ length: kinds - 1 }, (_, j) => nodesAt(j + 1))]
	})
	const read = Array.from({ length: reads }, (_, i) => `s${i}`)
	const query: QueryDesc = decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "doc", origin: { relation: "T", field: "doc" } },
					{ id: "start", origin: { relation: "T", field: "start" } },
					...Arr.map(read, (id) => ({ id, origin: undefined }))
				],
				matches: [
					{
						source: { kind: "relation", name: "T" },
						bindings: {
							doc: { kind: "var", var: "doc" },
							start: { kind: "var", var: "start" },
							kind: literal(0n)
						}
					},
					...Arr.map(
						read,
						(id) =>
							({
								source: { kind: "query", query: nodes, bind: {} },
								bindings: { doc: { kind: "var", var: "doc" }, start: { kind: "var", var: id } }
							}) as const
					)
				],
				where: [],
				head: {
					doc: { kind: "var", var: "doc" },
					start: { kind: "var", var: "start" },
					value: { kind: "var", var: "start" }
				},
				interiors: [],
				attach: []
			}
		]
	})
	return { kind: "derived", name: "D", level: 1, query }
}

/**
 * The reads box's theory: the nodes' schema, T's kinds contained in K, and the rule of `reads` reads of an import of
 * `kinds` rules (readsRuleOf).
 */
export const readsTheoryOf = (nodes: Nodes, kinds: number, reads: number): TestTheory =>
	theoryOf(
		judgedOver(
			nodeSchemaOf(nodes, [contained(on("K", ["doc", "kind"]), on("T", ["doc", "kind"]))]),
			readsRuleOf(kinds, reads)
		)
	)

/** The schema of `base` with D and the check over it that refuses its value at 1. */
const judgedOver = (base: SchemaDesc, D: AuthoredRelationDesc): SchemaDesc => ({
	name: "Judged",
	relations: [D],
	statements: [
		{ kind: "check", name: "Judged", relation: "D", predicate: ne(field("value"), literal(1n)) }
	],
	bases: [base]
})

/** The node box's D: its shape's one rule. */
const nodeRuleOf = (shape: Shape): AuthoredRelationDesc => {
	switch (shape) {
		case "parent beside child":
			return derivedOf(
				[
					{ relation: "T", bindings: { doc: "doc", parent: "parent", start: "start", kind: 2n } },
					{ relation: "T", bindings: { doc: "doc", start: "parent", kind: "up" } }
				],
				[],
				{ doc: "doc", start: "start", value: "up" }
			)
		case "child beside its parent's tag":
			return derivedOf(
				[
					{ relation: "T", bindings: { doc: "doc", parent: "parent", start: "start", kind: 1n } },
					{ relation: "Tag", bindings: { doc: "doc", start: "parent", mark: "mark", b: true } }
				],
				[],
				{ doc: "doc", start: "start", value: "mark" }
			)
		case "two nodes at one key":
			return derivedOf(
				[
					{ relation: "T", bindings: { doc: "doc", start: "start", kind: 1n } },
					{ relation: "T", bindings: { doc: "doc", start: "start", children: "children" } }
				],
				[],
				{ doc: "doc", start: "start", value: "children" }
			)
		case "two nodes of one kind":
			return derivedOf(
				[
					{ relation: "T", bindings: { doc: "doc", start: "start", kind: "kind" } },
					{ relation: "T", bindings: { doc: "doc", start: "next", kind: "kind", children: 0n } }
				],
				[lt("start", "next")],
				{ doc: "doc", start: "start", value: "kind" }
			)
		case "a tag beside its node":
			return derivedOf(
				[
					{ relation: "Tag", bindings: { doc: "doc", start: "start", mark: 1n, b: "b" } },
					{ relation: "T", bindings: { doc: "doc", start: "start", kind: "kind" } }
				],
				[],
				{ doc: "doc", start: "start", value: "kind" }
			)
		case "a false tag beside its node":
			return derivedOf(
				[
					{ relation: "Tag", bindings: { doc: "doc", start: "start", mark: 1n, b: false } },
					{ relation: "T", bindings: { doc: "doc", start: "start", kind: "kind" } }
				],
				[],
				{ doc: "doc", start: "start", value: "kind" }
			)
		case "a node beside its kind":
			return derivedOf(
				[
					{ relation: "K", bindings: { doc: "doc", kind: "kind" } },
					{
						relation: "T",
						bindings: { doc: "doc", start: "start", kind: "kind", children: "children" }
					}
				],
				[],
				{ doc: "doc", start: "start", value: "children" }
			)
	}
}

/** The nodes' schema: T, a tree of root doc or a plain relation, Tag and K, with `statements` after T's tree. */
const nodeSchemaOf = (nodes: Nodes, statements: SchemaDesc["statements"]): SchemaDesc => {
	const drawnOrNot = nodes === "tree" ? drawnNatural : f.natural
	return {
		name: "Nodes",
		relations: [
			relation(
				"T",
				{
					doc: f.natural,
					start: drawnOrNot,
					parent: drawnOrNot,
					at: drawnOrNot,
					children: drawnOrNot,
					end: drawnOrNot,
					kind: f.natural
				},
				["doc", "start"]
			),
			relation("Tag", { doc: f.natural, start: f.natural, mark: f.natural, b: f.boolean }, [
				"doc",
				"start"
			]),
			relation("K", { doc: f.natural, kind: f.natural }, ["doc", "kind"])
		],
		statements: [
			...(nodes === "tree"
				? [
						{
							kind: "tree" as const,
							member: on("T", ["parent", "at"]),
							slots: fin("T", "children"),
							root: ["doc"] as const
						}
					]
				: []),
			...statements
		],
		bases: []
	}
}

/** The node box's schema with its rule, a check over D refusing its value at 1, and the theory of both. */
export const nodeTheoryOf = (box: NodeBox): TestTheory => {
	const tagged = (b: boolean) =>
		contained(
			onWhere("Tag", ["doc", "start"], eq(field("b"), literal(b))),
			on("T", ["doc", "start"])
		)
	const base = nodeSchemaOf(box.nodes, [
		...(box.tagged === "every"
			? [contained(on("Tag", ["doc", "start"]), on("T", ["doc", "start"]))]
			: box.tagged === "true"
				? [tagged(true)]
				: [tagged(true), tagged(false)]),
		contained(on("K", ["doc", "kind"]), on("T", ["doc", "kind"]))
	])
	return theoryOf(judgedOver(base, nodeRuleOf(box.shape)))
}

const loc = SourceLoc("region-proofs", [])

/** `t`'s whole rule decided again over region facts `facts` (unit.ts wholeRule). */
export const wholeRuleOver = (t: TestTheory, facts: RegionFacts): WholeRule => {
	const { rule } = wholeRuleOf(t)
	return defined(
		wholeRule(rule.law, rule.everyRow, relationsOf(t), facts, loc),
		"the rule is whole over facts that add containments among relations it reads none of"
	)
}

/**
 * `facts` with `n` containments more, each among relations no node theory names, `U0` into `V0` and so on, at their key:
 * facts no occurrence of a node theory's rule reads, whose proofs read the containments into T, Tag and K alone.
 */
export const withUnrelated = (facts: RegionFacts, n: number): RegionFacts => ({
	...facts,
	containments: [
		...facts.containments,
		...Array.from({ length: n }, (_, i): FieldContainment => ({
			from: `U${i}`,
			to: `V${i}`,
			pairs: [{ from: "k", to: "k" }],
			selection: []
		}))
	]
})

/** A kind or a count of 0, 1 or 2, 1 the likeliest, the value each rule refuses. */
const smallGen: Gen<bigint> = weighted([
	[1, constant(0n)],
	[2, constant(1n)],
	[1, constant(2n)]
])

/** A tree of `least` to five nodes, each a child of a node on the rightmost path, its kinds drawn. */
const treeGen =
	(least: number): Gen<Node> =>
	(s) => {
		const size = s.draw(int(least, 5))
		const parents: Array<number> = []
		const path: Array<number> = [0]
		for (let i = 1; i < size; i += 1) {
			const depth = s.pick(0, path.length - 1)
			path.length = depth + 1
			parents.push(defined(path[depth], "a node of the path"))
			path.push(i)
		}
		const kinds = Array.from({ length: size }, () => Number(s.draw(smallGen)))
		const nodeAt = (node: number): Node => ({
			kind: defined(kinds[node], "a node's kind"),
			children: Arr.flatMap(parents, (p, i) => (p === node ? [nodeAt(i + 1)] : []))
		})
		return nodeAt(0)
	}

/** A tree document's rows of T: its tree numbered in pre-order. */
const treeRows = (doc: bigint, node: Node): ReadonlyArray<Row> =>
	Arr.map(numbered([{ root: [String(doc)], tree: node }]), (n) => ({
		doc,
		start: BigInt(n.start),
		parent: BigInt(n.parent),
		at: BigInt(n.at),
		children: BigInt(n.children),
		end: BigInt(n.end),
		kind: BigInt(n.kind)
	}))

/** A plain row of T at `start`, its other fields drawn. */
const plainRowGen =
	(doc: bigint, start: number): Gen<Row> =>
	(s) => ({
		doc,
		start: BigInt(start),
		parent: BigInt(s.draw(int(0, 3))),
		at: BigInt(s.draw(int(0, 2))),
		children: s.draw(smallGen),
		end: BigInt(s.draw(int(0, 4))),
		kind: s.draw(smallGen)
	})

/** A plain document's rows of T: one at each of some starts of 0 to 3. */
const plainGen =
	(doc: bigint): Gen<ReadonlyArray<Row>> =>
	(s) =>
		Arr.flatMap(
			Array.from({ length: 4 }, (_, i) => i),
			(start) => (s.draw(boolean) ? [s.draw(plainRowGen(doc, start))] : [])
		)

/**
 * A plain document grown, as a served write grows a closed relation: every row kept, and a row drawn at each start no
 * row holds, or not.
 */
const grownGen =
	(rows: ReadonlyArray<Row>): Gen<ReadonlyArray<Row>> =>
	(s) => {
		const kept = rows
		const doc = defined(rows[0], "a grown document's row")["doc"]
		return typeof doc === "bigint"
			? [
					...kept,
					...Arr.flatMap(
						Array.from({ length: 4 }, (_, i) => i),
						(start) =>
							!Arr.some(kept, (r) => r["start"] === BigInt(start)) && s.draw(boolean)
								? [s.draw(plainRowGen(doc, start))]
								: []
					)
				]
			: assert.fail("a document's doc is a bigint")
	}

/** A document's nodes as a transition reads them: its tree, or its plain rows. */
type DocNodes =
	| { readonly kind: "tree"; readonly tree: Node }
	| { readonly kind: "plain"; readonly rows: ReadonlyArray<Row> }

/** A document's nodes, a tree of at least `least` nodes. */
const docNodesGen =
	(nodes: Nodes, doc: bigint, least: number): Gen<DocNodes> =>
	(s) =>
		nodes === "tree"
			? { kind: "tree", tree: s.draw(treeGen(least)) }
			: { kind: "plain", rows: s.draw(plainGen(doc)) }

/** A plain document's rows kept, with a row of a drawn kind at each start of 0 to 3 no row holds and a row's parent or
 * one of `tags` names: a node gained where a row stood before named it. */
const aimedPlainGen =
	(doc: bigint, rows: ReadonlyArray<Row>, tags: ReadonlyArray<Row>): Gen<ReadonlyArray<Row>> =>
	(s) => [
		...rows,
		...Arr.flatMap(
			Array.from({ length: 4 }, (_, i) => i),
			(at) => {
				const start = BigInt(at)
				return !Arr.some(rows, (r) => r["start"] === start) &&
					(Arr.some(rows, (r) => r["parent"] === start) ||
						Arr.some(tags, (g) => g["doc"] === doc && g["start"] === start))
					? [{ ...s.draw(plainRowGen(doc, at)), kind: s.draw(smallGen) }]
					: []
			}
		)
	]

const rowsOfDoc = (doc: bigint, d: DocNodes): ReadonlyArray<Row> =>
	d.kind === "tree" ? treeRows(doc, d.tree) : d.rows

/** A tag at each of some starts of 0 to 3 of each document, of a mark of 0 or 1 and a b drawn. */
const tagsGen: Gen<ReadonlyArray<Row>> = (s) =>
	Arr.flatMap(docs, (doc) =>
		Arr.flatMap(
			Array.from({ length: 4 }, (_, i) => i),
			(start) =>
				s.draw(int(0, 2)) === 0
					? [
							{
								doc,
								start: BigInt(start),
								mark: BigInt(Math.min(1, s.draw(int(0, 2)))),
								b: s.draw(int(0, 2)) === 0
							}
						]
					: []
		)
	)

/** `tags` kept where the box contains them in T only where T holds a row at their (doc, start): a tag of b false in a
 * box of b true alone stands at any. */
const containedTags = (
	box: NodeBox,
	tags: ReadonlyArray<Row>,
	nodes: ReadonlyArray<Row>
): ReadonlyArray<Row> =>
	Arr.filter(
		tags,
		(g) =>
			(box.tagged === "true" && g["b"] === false) ||
			Arr.some(nodes, (n) => n["doc"] === g["doc"] && n["start"] === g["start"])
	)

/** A row of K at each of some kinds of 0 to 2 of each document. */
const kindsGen: Gen<ReadonlyArray<Row>> = (s) =>
	Arr.flatMap(docs, (doc) =>
		Arr.flatMap(
			Array.from({ length: 3 }, (_, i) => i),
			(kind) => (s.draw(boolean) ? [{ doc, kind: BigInt(kind) }] : [])
		)
	)

/** `kinds` kept where a node of `nodes` stands in their document at their kind, as K's containment in T holds them. */
const listedKinds = (kinds: ReadonlyArray<Row>, nodes: ReadonlyArray<Row>): ReadonlyArray<Row> =>
	Arr.filter(kinds, (k) => Arr.some(nodes, (n) => n["doc"] === k["doc"] && n["kind"] === k["kind"]))

/**
 * A transition of the node box as a served write makes one over its closed relations, every row kept and rows added at
 * new keys alone (physical/ddl/immutable.ts): some documents' nodes drawn, and tags and kinds; then each tree kept, each
 * plain document kept, grown or aimed, and each absent document drawn or not, a tagged one's tree of four nodes or five;
 * an aimed plain document gains a node at each start a row's parent or a tag names that no row holds; and every tag and
 * kind kept beside some drawn anew, every tag the box contains in T kept only where a node stands at it and every kind
 * where a node of it stands in its document; a publish keeps every document and draws only absent documents' nodes.
 * A transition that removes a closed row, a migration's data step's alone, is its migration's to check whole.
 */
export const nodeTransitionGen =
	(box: NodeBox): Gen<{ readonly before: Instance; readonly after: Instance }> =>
	(s) => {
		const present = Arr.flatMap(docs, (doc) =>
			s.draw(int(0, 3)) > 0 ? [{ doc, nodes: s.draw(docNodesGen(box.nodes, doc, 1)) }] : []
		)
		const beforeNodes = Arr.flatMap(present, (d) => rowsOfDoc(d.doc, d.nodes))
		const beforeTags = containedTags(box, s.draw(tagsGen), beforeNodes)
		const beforeKinds = listedKinds(s.draw(kindsGen), beforeNodes)
		const publish = s.draw(boolean)
		const after = Arr.flatMap(docs, (doc): ReadonlyArray<Row> => {
			const was = Arr.findFirst(present, (d) => d.doc === doc)
			if (Option.isNone(was)) {
				const tagged = Arr.some(beforeTags, (g) => g["doc"] === doc)
				return s.draw(boolean)
					? rowsOfDoc(doc, s.draw(docNodesGen(box.nodes, doc, tagged ? 4 : 1)))
					: []
			}
			const nodes = was.value.nodes
			if (nodes.kind === "tree" || publish) {
				return rowsOfDoc(doc, nodes)
			}
			switch (s.draw(element(["keep", "grow", "aim"] as const))) {
				case "keep":
					return rowsOfDoc(doc, nodes)
				case "grow":
					return nodes.rows.length === 0 ? [] : s.draw(grownGen(nodes.rows))
				case "aim":
					return s.draw(aimedPlainGen(doc, nodes.rows, beforeTags))
			}
		})
		const tags = [
			...beforeTags,
			...Arr.filter(
				s.draw(tagsGen),
				(g) => !Arr.some(beforeTags, (o) => o["doc"] === g["doc"] && o["start"] === g["start"])
			)
		]
		const kinds = [
			...beforeKinds,
			...Arr.filter(s.draw(kindsGen), (k) => !Arr.some(beforeKinds, (o) => sameRow(o, k)))
		]
		return {
			before: { T: beforeNodes, Tag: beforeTags, K: beforeKinds },
			after: { T: after, Tag: containedTags(box, tags, after), K: listedKinds(kinds, after) }
		}
	}

/**
 * The chain: F(doc, a) contained in E(doc, a, b) at (doc, a), E's key, and E contained in N(doc, b, x) at (doc, b), N's
 * key, none a tree; the rule reads F, E and N joined, N's x at 1 refused. E proves N at N's key and F proves E at
 * E's key, and no composition proves N from F, since F's pairs reach no b: the region reads F alone whole, N proved by
 * a witness itself proved.
 */
export const chainTheory: TestTheory = theoryOf(
	judgedOver(
		{
			name: "Chain",
			relations: [
				relation("F", { doc: f.natural, a: f.natural }, ["doc", "a"]),
				relation("E", { doc: f.natural, a: f.natural, b: f.natural }, ["doc", "a"]),
				relation("N", { doc: f.natural, b: f.natural, x: f.natural }, ["doc", "b"])
			],
			statements: [
				contained(on("F", ["doc", "a"]), on("E", ["doc", "a"])),
				contained(on("E", ["doc", "b"]), on("N", ["doc", "b"]))
			],
			bases: []
		},
		derivedOf(
			[
				{ relation: "F", bindings: { doc: "doc", a: "a" } },
				{ relation: "E", bindings: { doc: "doc", a: "a", b: "b" } },
				{ relation: "N", bindings: { doc: "doc", b: "b", x: "x" } }
			],
			[],
			{ doc: "doc", start: "a", value: "x" }
		)
	)
)

/** The relations of the chain whose every gained row its region reads: F alone. */
export const chainWholeReads: ReadonlyArray<string> = ["F"]

/** The chain's instance of the documents `present`: rows of N, E's each at one of N's b, F's each at one of E's a. */
const chainInstanceGen =
	(present: ReadonlyArray<bigint>): Gen<Instance> =>
	(s) => {
		const ns = Arr.flatMap(present, (doc) =>
			Arr.flatMap(
				Array.from({ length: 3 }, (_, i) => i),
				(b) => (s.draw(boolean) ? [{ doc, b: BigInt(b), x: BigInt(s.draw(int(0, 1))) }] : [])
			)
		)
		const es = Arr.flatMap(present, (doc) => {
			const at = Arr.filter(ns, (n) => n.doc === doc)
			return Arr.flatMap(
				Array.from({ length: 3 }, (_, i) => i),
				(a) =>
					at.length > 0 && s.draw(boolean)
						? [{ doc, a: BigInt(a), b: defined(at[s.pick(0, at.length - 1)], "an N row").b }]
						: []
			)
		})
		const fs = Arr.flatMap(es, (e) => (s.draw(boolean) ? [{ doc: e.doc, a: e.a }] : []))
		return { F: fs, E: es, N: ns }
	}

/**
 * A transition of the chain as a served write makes one over its closed relations: a state of some documents drawn,
 * then every row kept and some absent documents drawn.
 */
export const chainTransitionGen: Gen<{ readonly before: Instance; readonly after: Instance }> = (
	s
) => {
	const present = Arr.filter(docs, () => s.draw(boolean))
	const before = s.draw(chainInstanceGen(present))
	const fresh = s.draw(
		chainInstanceGen(Arr.filter(docs, (doc) => !Arr.contains(present, doc) && s.draw(boolean)))
	)
	return {
		before,
		after: {
			F: [...(before["F"] ?? []), ...(fresh["F"] ?? [])],
			E: [...(before["E"] ?? []), ...(fresh["E"] ?? [])],
			N: [...(before["N"] ?? []), ...(fresh["N"] ?? [])]
		}
	}
}
