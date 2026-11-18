/** What the properties of rule-whole.test.ts read: the schemas and their templates, the spaces, and each case's run. */

import { aimed, array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec } from "effect"
import { type PlanNode, parsePlan, planNodes, rowsRead } from "#bench/harness/explain.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import type { OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { exists } from "#compiler/sql/build.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * A document's place: three coordinates, doc, sub and part, which every row of a document holds. A relation's key reads
 * the first one, two or three of them, in that order, then the row's place in the document (`UnitShape` width); its
 * fields declare them in the key's order or reversed (`UnitShape` order), and every rule binds them in that order, so a
 * rule's variables for its unit come in an order of their own beside the unit key's. A document's sub and part are
 * fixed by its doc and apart from every doc (`placed`), so a unit's field read at another's position finds no row.
 */
type UnitShape = readonly [width: 1 | 2 | 3, order: "key" | "reversed"]

/** A unit shape by its name, as a case draws it. */
export type ShapeKey = "1 key" | "2 key" | "2 reversed" | "3 key" | "3 reversed"

const shapes: { readonly [K in ShapeKey]: UnitShape } = {
	"1 key": [1, "key"],
	"2 key": [2, "key"],
	"2 reversed": [2, "reversed"],
	"3 key": [3, "key"],
	"3 reversed": [3, "reversed"]
}

const shapeKeys: Arr.NonEmptyReadonlyArray<ShapeKey> = [
	"1 key",
	"2 key",
	"2 reversed",
	"3 key",
	"3 reversed"
]

const shapeGen: Gen<ShapeKey> = element(shapeKeys)

/** The key of a relation of a shape of width `width`: doc, then sub and part as wide as the shape is, then start. */
type PlacedKey = readonly ["doc", ...ReadonlyArray<"sub" | "part" | "start">]

const placedKey = (width: UnitShape[0]): PlacedKey => {
	switch (width) {
		case 1:
			return ["doc", "start"]
		case 2:
			return ["doc", "sub", "start"]
		case 3:
			return ["doc", "sub", "part", "start"]
	}
}

/** A row's place, doc, sub and part, in the order `order` declares them, however it was written. */
const inOrder =
	(order: UnitShape[1]) =>
	<D, S, P>(place: { readonly doc: D; readonly sub: S; readonly part: P }) =>
		order === "key"
			? { doc: place.doc, sub: place.sub, part: place.part }
			: { part: place.part, sub: place.sub, doc: place.doc }

/** A node of a document, keyed by its place then its start: its parent's start, its start at a root, its kind. */
const nodeOf = (shape: UnitShape) =>
	relation(
		"Node",
		{
			...inOrder(shape[1])({ doc: pg.integer, sub: pg.integer, part: pg.integer }),
			start: pg.integer,
			parent: pg.integer,
			kind: pg.integer
		},
		placedKey(shape[0])
	)

/** An expression at a node, keyed as its node is: its type. */
const exprOf = (shape: UnitShape) =>
	relation(
		"Expr",
		{
			...inOrder(shape[1])({ doc: pg.integer, sub: pg.integer, part: pg.integer }),
			start: pg.integer,
			type: pg.integer
		},
		placedKey(shape[0])
	)

/** Each shape's two stored relations, which both of its judges state and its writes name. */
const relationsOf = Rec.map(shapes, (shape) => ({ Node: nodeOf(shape), Expr: exprOf(shape) }))

/**
 * The place every row of document `doc` holds, as an INSERT's values spell it: its doc, sub and part, its sub and part
 * apart from every doc, start and each other, so a unit's field read at another's position finds no row of the document.
 */
const placed = (doc: number): string => `${doc}, ${doc + 1000000}, ${doc + 2000000}`

/** The judges of each shape: whole, its relations immutable, and probed, its relations mutable. */
type Judge = "whole" | "probed"

/**
 * The schema the properties judge of shape `shape`, by its rules over queries, every one unit-local: each relation keyed
 * by its document's place first, every rule joining within one document. The probed judge's Node and Expr are mutable,
 * so no rule is unit-local and each is probed; the whole judge's immutable, so each is judged whole over the documents
 * a transaction wrote, the unit, and the aggregate's rule beside them, which no probe reads.
 *
 * - Rooted: every expression's parent is an expression: a containment of a join into a table, which a node's insert
 *   breaks and an expression's delete does.
 * - Kinded: a node of kind 1 that is an expression is of type 1: a check over a join.
 * - One type: the expressions below one parent share one type: a key over a projection of the join.
 * - Fanout: a node has at most three children, and one of kind 2 at least two, a root its own child among them: a
 *   check over a count of each node's children, zero by a second rule for a node with none, which a node's insert and
 *   its delete both break.
 * - Reached: every expression's node is reached from a root along parent links, at any depth: a containment into a
 *   recursion, seeded at each root, its own parent, and stepping to each child within the document, which a node's
 *   delete breaks below it and an expression's insert at a node no root reaches does; the parent links may cycle, and
 *   the walk ends at a set.
 * - Leafed: a node of kind 2 has a child that is a leaf, a node no other is a child of: a check over a negation of a
 *   query that negates in turn, which a child's insert under the leaf and the leaf's delete both break.
 */
const judgeSchema = (judge: Judge, shape: ShapeKey) => {
	const [width, order] = shapes[shape]
	const name = `${judge === "whole" ? "Whole" : "Probed"}Judge${width}${order === "key" ? "Keyed" : "Reversed"}`
	const { Node, Expr } = relationsOf[shape]
	const ordered = inOrder(order)
	const probed = judge === "probed"
	const Base = schema(name, [Node, Expr], probed ? [mutable(Node), mutable(Expr)] : [])
	const Typed = derived(
		"Typed",
		query(Base).rule((r) => {
			const { doc, sub, part, start, type } = v(Expr, "e")
			const { parent, kind } = v(Node, "n")
			const at = ordered({ doc, sub, part })
			return r
				.match(Expr, { ...at, start, type })
				.match(Node, { ...at, start, parent, kind })
				.find({ ...at, start, parent, kind, type })
		})
	)
	const Parents = derived(
		"Parents",
		query(Base).rule((r) => {
			const { doc, sub, part, start, type } = v(Expr, "e")
			const { parent } = v(Node, "n")
			const at = ordered({ doc, sub, part })
			return r
				.match(Expr, { ...at, start, type })
				.match(Node, { ...at, start, parent })
				.find({ ...at, parent, type })
		})
	)
	const spj = [
		contained(on(Typed, "doc", "sub", "part", "parent"), on(Expr, "doc", "sub", "part", "start")),
		check("Kinded", Typed, (t) => t.or(t.ne(t.kind, 1), t.eq(t.type, 1))),
		key(on(Parents, "doc", "sub", "part", "parent"))
	] as const
	if (probed) {
		return schema.extend(Base, `${name}_1`, [Typed, Parents], spj)
	}
	const Fanout = derived(
		"Fanout",
		query(Base)
			.rule((r) => {
				const { doc, sub, part, start, kind } = v(Node, "p")
				const { start: child } = v(Node, "c")
				const at = ordered({ doc, sub, part })
				return r
					.match(Node, { ...at, start, kind })
					.match(Node, { ...at, parent: start, start: child })
					.find({ ...at, node: start, kind, children: r.count() })
			})
			.rule((r) => {
				const { doc, sub, part, start, kind } = v(Node, "p")
				const at = ordered({ doc, sub, part })
				return r
					.match(Node, { ...at, start, kind })
					.where(r.not(Node, { ...at, parent: start }))
					.find({ ...at, node: start, kind, children: 0n })
			})
	)
	const reached = query(Base).recursive("Reached", {
		row: { ...ordered({ doc: pg.integer, sub: pg.integer, part: pg.integer }), node: pg.integer },
		base: [
			(r) => {
				const { doc, sub, part, start } = v(Node, "root")
				const at = ordered({ doc, sub, part })
				return r.match(Node, { ...at, start, parent: start }).find({ ...at, node: start })
			}
		],
		rec: [
			(r, self) => {
				const { doc, sub, part, node } = v(self, "at")
				const { start } = v(Node, "child")
				const at = ordered({ doc, sub, part })
				return r
					.match(self, { ...at, node })
					.match(Node, { ...at, parent: node, start })
					.where(r.ne(start, node))
					.find({ ...at, node: start })
			}
		]
	})
	const Reach = derived("Reach", reached)
	const LeafChild = derived(
		"LeafChild",
		query(Base).rule((r) => {
			const { doc, sub, part, start, parent } = v(Node, "c")
			const at = ordered({ doc, sub, part })
			return r
				.match(Node, { ...at, start, parent })
				.where(r.and(r.ne(start, parent), r.not(Node, { ...at, parent: start })))
				.find({ ...at, parent })
		})
	)
	const Leaves = schema.extend(Base, `${name}_0`, [LeafChild], [])
	const Barren = derived(
		"Barren",
		query(Leaves).rule((r) => {
			const { doc, sub, part, start, kind } = v(Node, "p")
			const at = ordered({ doc, sub, part })
			return r
				.match(Node, { ...at, start, kind })
				.where(r.not(LeafChild, { ...at, parent: start }))
				.find({ ...at, start, kind })
		})
	)
	return schema.extend(
		Leaves,
		`${name}_1`,
		[Typed, Parents, Fanout, Reach, Barren],
		[
			...spj,
			check("Fanout", Fanout, (f) =>
				f.and(f.le(f.children, 3n), f.or(f.ne(f.kind, 2), f.ge(f.children, 2n)))
			),
			contained(on(Expr, "doc", "sub", "part", "start"), on(Reach, "doc", "sub", "part", "node")),
			check("Leafed", Barren, (b) => b.ne(b.kind, 2))
		]
	)
}

/** The judge `judge` of shape `shape`, installed through its first migration with no login. */
const judgeTemplate = (judge: Judge, shape: ShapeKey) => {
	const schemaValue = judgeSchema(judge, shape)
	const [width, order] = shapes[shape]
	return migratedTemplate({
		declaredIn: import.meta,
		name: `${judge} judge ${shape}`,
		content: { schema: schemaValue.name, logins: [] },
		versions: [{ schema: schemaValue, logins: [], declarations: noDeclarations }],
		options: {
			label: `${judge}_judge_${width}_${order}`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession
		}
	})
}

/** Every judge of every shape, of which a case takes the two of the shape it draws (Substrate.oneOf). */
export const judgeTemplates: Readonly<
	Record<`${Judge} ${ShapeKey}`, SubstrateTemplate<Installed>>
> = {
	"whole 1 key": judgeTemplate("whole", "1 key"),
	"whole 2 key": judgeTemplate("whole", "2 key"),
	"whole 2 reversed": judgeTemplate("whole", "2 reversed"),
	"whole 3 key": judgeTemplate("whole", "3 key"),
	"whole 3 reversed": judgeTemplate("whole", "3 reversed"),
	"probed 1 key": judgeTemplate("probed", "1 key"),
	"probed 2 key": judgeTemplate("probed", "2 key"),
	"probed 2 reversed": judgeTemplate("probed", "2 reversed"),
	"probed 3 key": judgeTemplate("probed", "3 key"),
	"probed 3 reversed": judgeTemplate("probed", "3 reversed")
}

/** The tables of shape `shape`'s relations in an installation of one of its judges, as its writes name them. */
interface Tables {
	readonly node: string
	readonly expr: string
}

const tablesOf = (installed: Installed, shape: ShapeKey): Tables => {
	const names = namesOf(installed)
	const { Node, Expr } = relationsOf[shape]
	return { node: names.table(Node), expr: names.table(Expr) }
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const docs = [1, 2] as const
type Doc = (typeof docs)[number]
const starts = [0, 1, 2, 3] as const
type Start = (typeof starts)[number]
const kinds = [0, 1, 2] as const
type Kind = (typeof kinds)[number]
const types = [0, 1] as const
type Type = (typeof types)[number]

/** One write of a transaction over two documents, each a unit, by direct SQL. */
export type Op =
	| {
			readonly kind: "node"
			readonly doc: Doc
			readonly start: Start
			readonly parent: Start
			readonly nodeKind: Kind
	  }
	| { readonly kind: "expr"; readonly doc: Doc; readonly start: Start; readonly type: Type }
	| { readonly kind: "unnode" | "unexpr"; readonly doc: Doc; readonly start: Start }
	| { readonly kind: "unit"; readonly doc: Doc; readonly type: Type }
	| { readonly kind: "drop"; readonly doc: Doc }
	| { readonly kind: "judge" }

/** A case of the equivalence: the shape of its judges, and its transactions, each its writes in order. */
export interface Schedule {
	readonly shape: ShapeKey
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const docGen = element(docs)
const startGen = element(starts)

const opGen: Gen<Op> = weighted<Op>([
	[
		5,
		(s) => ({
			kind: "node",
			doc: s.draw(docGen),
			start: s.draw(startGen),
			parent: s.draw(startGen),
			nodeKind: s.draw(element(kinds))
		})
	],
	[
		4,
		(s) => ({
			kind: "expr",
			doc: s.draw(docGen),
			start: s.draw(startGen),
			type: s.draw(element(types))
		})
	],
	[
		3,
		(s) => ({
			kind: s.draw(element(["unnode", "unexpr"] as const)),
			doc: s.draw(docGen),
			start: s.draw(startGen)
		})
	],
	[2, (s) => ({ kind: "unit", doc: s.draw(docGen), type: s.draw(element(types)) })],
	[1, (s) => ({ kind: "drop", doc: s.draw(docGen) })],
	[1, () => ({ kind: "judge" })]
])

/** A case of transactions `transactions` draws, at a shape drawn first. */
const shaped =
	(transactions: Gen<Schedule["transactions"]>): Gen<Schedule> =>
	(s) => ({ shape: s.draw(shapeGen), transactions: s.draw(transactions) })

const scheduleGen: Gen<Schedule> = shaped(
	array(array(opGen, { min: 1, max: 6 }), { min: 1, max: 4 })
)

/** The situations the equivalence must reach. */
export type WholeFeature =
	| "committed"
	| "refused by Rooted"
	| "refused by Kinded"
	| "refused by One type"
	| "refused by Fanout"
	| "refused by Reached"
	| "refused by Leafed"
	| "a whole unit inserted"
	| "a unit dropped whole"
	| "an expression removed under its member"
	| "two units written in one transaction"
	| "the judge run inside a transaction that writes on"
	| ShapeFeature

/** The situation a case of each shape reaches. */
type ShapeFeature =
	| "a key of one place field"
	| "a key of two place fields, declared in its order"
	| "a key of two place fields, declared reversed"
	| "a key of three place fields, declared in its order"
	| "a key of three place fields, declared reversed"

const shapeFeatures: { readonly [K in ShapeKey]: ShapeFeature } = {
	"1 key": "a key of one place field",
	"2 key": "a key of two place fields, declared in its order",
	"2 reversed": "a key of two place fields, declared reversed",
	"3 key": "a key of three place fields, declared in its order",
	"3 reversed": "a key of three place fields, declared reversed"
}

export const wholeFeatures: Arr.NonEmptyReadonlyArray<WholeFeature> = [
	"committed",
	"refused by Rooted",
	"refused by Kinded",
	"refused by One type",
	"refused by Fanout",
	"refused by Reached",
	"refused by Leafed",
	"a whole unit inserted",
	"a unit dropped whole",
	"an expression removed under its member",
	"two units written in one transaction",
	"the judge run inside a transaction that writes on",
	...Rec.values(shapeFeatures)
]

/**
 * A document written whole (`statementsOf` unit): a root of kind 2, its own parent, and its two children, each an
 * expression, the root's and the second child's of `type` and the first's, of kind 1, of type 1. It keeps every rule
 * at type 1; at type 0 its parent's expressions are of two types, which One type alone refuses.
 */
const lawful = (doc: Doc, type: Type): ReadonlyArray<Op> => [{ kind: "unit", doc, type }]

/** The aims: a case constructed to reach each rare situation, its document drawn. */
const aims: ReadonlyArray<readonly [WholeFeature, Gen<Schedule>]> = [
	[
		"refused by One type",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				s.draw(boolean)
					? lawful(doc, 0)
					: [
							...lawful(doc, 1),
							{ kind: "unexpr", doc, start: 2 },
							{ kind: "expr", doc, start: 2, type: 0 }
						]
			]
		})
	],
	[
		"refused by Fanout",
		shaped((s) => {
			const doc = s.draw(docGen)
			const changed: ReadonlyArray<Op> = s.draw(boolean)
				? [{ kind: "node", doc, start: 3, parent: 0, nodeKind: 0 }]
				: [
						{ kind: "unexpr", doc, start: 1 },
						{ kind: "unexpr", doc, start: 2 },
						{ kind: "unnode", doc, start: 1 },
						{ kind: "unnode", doc, start: 2 }
					]
			return [lawful(doc, 1), changed]
		})
	],
	[
		"refused by Reached",
		shaped((s) => {
			const doc = s.draw(docGen)
			const changed: ReadonlyArray<Op> = s.draw(boolean)
				? [
						{ kind: "unexpr", doc, start: 0 },
						{ kind: "unnode", doc, start: 0 }
					]
				: [
						{ kind: "node", doc, start: 3, parent: 3, nodeKind: 0 },
						{ kind: "unnode", doc, start: 3 },
						{ kind: "node", doc, start: 3, parent: 2, nodeKind: 0 },
						{ kind: "unnode", doc, start: 2 },
						{ kind: "expr", doc, start: 3, type: 1 }
					]
			return [lawful(doc, 1), changed]
		})
	],
	[
		"refused by Leafed",
		shaped((s) => {
			const doc = s.draw(docGen)
			const changed: ReadonlyArray<Op> = s.draw(boolean)
				? [
						{ kind: "unexpr", doc, start: 2 },
						{ kind: "unnode", doc, start: 2 },
						{ kind: "node", doc, start: 3, parent: 1, nodeKind: 0 }
					]
				: [
						{ kind: "node", doc, start: 3, parent: 1, nodeKind: 0 },
						{ kind: "unexpr", doc, start: 2 },
						{ kind: "unnode", doc, start: 2 },
						{ kind: "judge" }
					]
			return [lawful(doc, 1), changed]
		})
	],
	[
		"an expression removed under its member",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [lawful(doc, 1), [{ kind: "unexpr", doc, start: 0 }]]
		})
	],
	[
		"two units written in one transaction",
		shaped((s) => [
			[...lawful(1, 1), ...lawful(2, s.draw(element(types)))],
			[{ kind: "drop", doc: s.draw(docGen) }]
		])
	],
	[
		"the judge run inside a transaction that writes on",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				[...lawful(doc, 1), { kind: "judge" }, { kind: "unexpr", doc, start: s.draw(startGen) }]
			]
		})
	]
]

export const wholeSpace = aimed(scheduleGen, aims)

/** The statements of one write, on an installation's tables. */
const statementsOf = (
	{ node, expr }: Tables,
	op: Exclude<Op, { readonly kind: "judge" }>
): ReadonlyArray<string> => {
	switch (op.kind) {
		case "node":
			return [
				`INSERT INTO ${node} (doc, sub, part, start, parent, kind) VALUES (${placed(op.doc)}, ${op.start}, ${op.parent}, ${op.nodeKind}) ON CONFLICT DO NOTHING`
			]
		case "expr":
			return [
				`INSERT INTO ${expr} (doc, sub, part, start, type) VALUES (${placed(op.doc)}, ${op.start}, ${op.type}) ON CONFLICT DO NOTHING`
			]
		case "unnode":
			return [`DELETE FROM ${node} WHERE doc = ${op.doc} AND start = ${op.start}`]
		case "unexpr":
			return [`DELETE FROM ${expr} WHERE doc = ${op.doc} AND start = ${op.start}`]
		case "unit":
			return [
				`INSERT INTO ${node} (doc, sub, part, start, parent, kind) VALUES (${placed(op.doc)}, 0, 0, 2), (${placed(op.doc)}, 1, 0, 1), (${placed(op.doc)}, 2, 0, 0) ON CONFLICT DO NOTHING`,
				`INSERT INTO ${expr} (doc, sub, part, start, type) VALUES (${placed(op.doc)}, 0, ${op.type}), (${placed(op.doc)}, 1, 1), (${placed(op.doc)}, 2, ${op.type}) ON CONFLICT DO NOTHING`
			]
		case "drop":
			return [
				`DELETE FROM ${expr} WHERE doc = ${op.doc}`,
				`DELETE FROM ${node} WHERE doc = ${op.doc}`
			]
	}
}

/** The law a refusal's trigger reports, through the installation's constraint map. */
const refusedLaw = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): LawId | undefined => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return undefined
	}
	const table = fields.table.value
	const owner = Arr.findFirst(
		["Node", "Expr"],
		(r) => installation.names.relation(r).name === table
	)
	return Option.isNone(owner)
		? undefined
		: constraintLaw(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			)
}

/** The six rules the schemas state, by the names their features read. */
type RuleName = "Rooted" | "Kinded" | "One type" | "Fanout" | "Reached" | "Leafed"

/** The rules the whole schema alone states, which no probe reads: an aggregate's, a recursion's and a nested negation's. */
const wholeOnly: ReadonlyArray<RuleName> = ["Fanout", "Reached", "Leafed"]

/** The situation a refusal by each rule reaches. */
const refusedBy: { readonly [R in RuleName]: WholeFeature } = {
	Rooted: "refused by Rooted",
	Kinded: "refused by Kinded",
	"One type": "refused by One type",
	Fanout: "refused by Fanout",
	Reached: "refused by Reached",
	Leafed: "refused by Leafed"
}

/**
 * The name of the rule a rule over a query's law states, whichever strategy judges it: a containment by the relation it
 * is into, Expr's Rooted's and the walk's Reached's.
 */
const nameOfLaw = (
	law:
		| { readonly kind: "contained"; readonly to: { readonly relation: string } }
		| { readonly kind: "key" }
		| { readonly kind: "check"; readonly name: string }
): RuleName => {
	switch (law.kind) {
		case "contained":
			return law.to.relation === "Reach" ? "Reached" : "Rooted"
		case "key":
			return "One type"
		case "check":
			return law.name === "Fanout" ? "Fanout" : law.name === "Leafed" ? "Leafed" : "Kinded"
	}
}

/** The rule law `law` of an installation states, by its name. */
const ruleNameOf = (installation: Installation, law: LawId): RuleName => {
	const rule = defined(
		Arr.findFirst(installation.laws.rules, (r) => r.law.id === law).pipe(Option.getOrUndefined),
		`the rule of law ${law}`
	).rule
	return nameOfLaw(rule.kind === "whole" ? rule.law : rule)
}

/** What one installation's judge made of a state: the laws its whole checks find broken, and the law it refused by. */
interface Verdict {
	readonly broken: ReadonlySet<RuleName>
	readonly refused: RuleName | undefined
}

/**
 * Judges the state `session`'s transaction leaves against every rule's whole check, then runs the judge (SET
 * CONSTRAINTS ALL IMMEDIATE): it must refuse exactly when a whole check finds the state broken, naming a rule it finds
 * broken under that rule's SQLSTATE.
 */
const judged = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const broken = new Set<RuleName>()
		for (const lawCheck of lawChecks(installation).rules) {
			const found = yield* session.values(`SELECT EXISTS (${printStatement(lawCheck.query)})`, [])
			if (found[0]?.[0] === true) {
				broken.add(ruleNameOf(installation, lawCheck.law))
			}
		}
		const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken.size > 0) {
				return yield* new Disagreed({
					message: `${installation.names.schema}: the judge accepted a state its whole checks find breaking ${Formatter.format([...broken])}, ${where}`
				})
			}
			return { broken, refused: undefined } satisfies Verdict
		}
		const law = refusedLaw(installation, refused.value)
		const rule = law === undefined ? undefined : ruleNameOf(installation, law)
		if (
			rule === undefined ||
			!broken.has(rule) ||
			!["23503", "23505", "23514"].includes(refused.value.code)
		) {
			return yield* new Disagreed({
				message: `${installation.names.schema}: the judge refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where the whole checks find ${Formatter.format([...broken])}, ${where}`
			})
		}
		return { broken, refused: rule } satisfies Verdict
	})

/** The units one transaction's writes reach, by the documents they write. */
const unitsOf = (ops: ReadonlyArray<Op>): ReadonlySet<Doc> =>
	new Set(Arr.flatMap(ops, (op) => (op.kind === "judge" ? [] : [op.doc])))

/**
 * One case of the equivalence on a clone of each installation: each transaction's writes in order on an owner session
 * of each at SERIALIZABLE, the whole judge's and the probed judge's in lockstep. At each judge op and at the
 * transaction's end, each installation's judge is held to its whole checks (`judged`), and the whole judge refuses
 * exactly where the probed judge does, wherever the aggregate's rule, which only the whole schema states, holds. A
 * refusal of either rolls both back, so the two hold one state throughout.
 */
export const runEquivalence = (
	whole: { readonly installed: Installed; readonly session: RawSession },
	probed: { readonly installed: Installed; readonly session: RawSession },
	schedule: Schedule,
	c: Case<WholeFeature>
) =>
	Effect.gen(function* () {
		const sides = Arr.map([whole, probed], (side) => ({
			...side,
			tables: tablesOf(side.installed, schedule.shape)
		}))
		c.note(shapeFeatures[schedule.shape])
		for (const [at, ops] of schedule.transactions.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)}`
			for (const side of sides) {
				yield* side.session.begin
			}
			if (unitsOf(ops).size > 1) {
				c.note("two units written in one transaction")
			}
			/**
			 * Both judges at this point: the whole judge refuses exactly where the probed one does, wherever the rules
			 * only the whole schema states hold.
			 */
			const both = Effect.gen(function* () {
				const w = yield* judged(whole.installed, whole.session, where)
				const p = yield* judged(probed.installed, probed.session, where)
				if (
					!Arr.some(wholeOnly, (rule) => w.broken.has(rule)) &&
					(w.refused === undefined) !== (p.refused === undefined)
				) {
					return yield* new Disagreed({
						message: `the whole judge ${w.refused === undefined ? "accepted" : `refused by ${w.refused}`} where the probed judge ${p.refused === undefined ? "accepted" : `refused by ${p.refused}`}, ${where}`
					})
				}
				return w.refused
			})
			let ended = false
			let judgedOnce = false
			for (const op of ops) {
				if (op.kind === "judge") {
					const refused = yield* both
					if (refused !== undefined) {
						c.note(refusedBy[refused])
						for (const side of sides) {
							yield* side.session.rollback
						}
						ended = true
						break
					}
					for (const side of sides) {
						yield* side.session.query("SET CONSTRAINTS ALL DEFERRED", [])
					}
					judgedOnce = true
					continue
				}
				for (const side of sides) {
					for (const sql of statementsOf(side.tables, op)) {
						yield* side.session.query(sql, [])
					}
				}
				if (op.kind === "unit") {
					c.note("a whole unit inserted")
				}
				if (op.kind === "drop") {
					c.note("a unit dropped whole")
				}
				if (op.kind === "unexpr") {
					c.note("an expression removed under its member")
				}
				if (judgedOnce) {
					c.note("the judge run inside a transaction that writes on")
				}
			}
			if (ended) {
				continue
			}
			const refused = yield* both
			if (refused === undefined) {
				for (const side of sides) {
					yield* side.session.commit
				}
				c.note("committed")
			} else {
				c.note(refusedBy[refused])
				for (const side of sides) {
					yield* side.session.rollback
				}
			}
		}
	})

/** The PL/pgSQL body of the installation's function named `name`. */
const bodyOf = (installation: Installation, name: string): ReadonlyArray<PlStatement> =>
	Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === name
			? s.body.body
			: []
	)

/** The queries a judge's body tests by EXISTS at its top to raise: each whole rule's statement. */
const wholeStatementsOf = (installation: Installation): ReadonlyArray<OperandSelect> =>
	Arr.flatMap(bodyOf(installation, identifierOf(identity.ruleJudge())), (s) =>
		s.kind === "if"
			? Arr.flatMap(s.branches, (b) =>
					b.condition.kind === "exists" && b.body[0]?.kind === "raise" ? [b.condition.query] : []
				)
			: []
	)

/**
 * A case of the locality: its judge's shape, the documents stored beside the written one, then as many again, and the
 * statistics.
 */
export interface Locality {
	/**
	 * Its judge's shape, drawn: at a key of two or three place fields as at one, every statement's work grows with the
	 * units written, Rooted's included, whose two sides it reads through queries inside one step
	 * (analysis/theory/unit.ts walkedRule).
	 */
	readonly shape: ShapeKey
	readonly stored: number
	readonly more: number
	readonly statistics: "none" | "analyzed"
	/** The documents a transaction then writes beside the first, and three times as many again. */
	readonly written: number
}

/** Hundreds of stored documents beside the written one, each a lawful unit of a root and two children. */
export const localityGen: Gen<Locality> = (s) => ({
	shape: s.draw(shapeGen),
	stored: s.draw(int(2000, 3000)),
	more: s.draw(int(2000, 3000)),
	statistics: s.draw(element(["none", "analyzed"] as const)),
	written: s.draw(int(30, 60))
})

export type LocalityFeature = "measured with no statistics" | "measured analyzed"

/** The statements loading lawful documents `from` to `to`, the tables' captures off. */
const loaded = ({ node, expr }: Tables, from: number, to: number): ReadonlyArray<string> => [
	`ALTER TABLE ${node} DISABLE TRIGGER USER`,
	`ALTER TABLE ${expr} DISABLE TRIGGER USER`,
	`INSERT INTO ${node} (doc, sub, part, start, parent, kind) SELECT d, d + 1000000, d + 2000000, s, 0, CASE WHEN s = 0 THEN 2 WHEN s = 1 THEN 1 ELSE 0 END FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
	`INSERT INTO ${expr} (doc, sub, part, start, type) SELECT d, d + 1000000, d + 2000000, s, 1 FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
	`ALTER TABLE ${node} ENABLE TRIGGER USER`,
	`ALTER TABLE ${expr} ENABLE TRIGGER USER`
]

/** Each whole rule's statement's plan, as EXPLAIN ANALYZE runs it, on `connection`. */
const plansOf = (installed: Installed, connection: PgConnection) =>
	Effect.forEach(wholeStatementsOf(installed.installation), (statement) =>
		Effect.map(
			connection.queryValues(
				`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) SELECT ${printExpr(exists(statement))}`,
				[]
			),
			(explained) => succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
		)
	)

/** The rows each whole rule's statement reads of the stored tables, as EXPLAIN ANALYZE counts them, on `connection`. */
const readsOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(plansOf(installed, connection), Arr.map(rowsRead))

/** A plan node that runs more than once, with the rows it handles a run: its output and what its filters removed. */
interface Rerun {
	readonly node: string
	readonly loops: number
	readonly rows: number
}

/** The heaviest run of a node of `plan` that runs more than once (`Rerun`), none where every node runs once. */
const heaviestRerun = (plan: PlanNode): Rerun | undefined =>
	Iterator.from(planNodes(plan))
		.filter((n) => n.actualLoops > 1)
		.map((n): Rerun => ({
			node: n.nodeType,
			loops: n.actualLoops,
			rows: n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByJoinFilter
		}))
		.reduce<Rerun | undefined>(
			(most, r) => (most === undefined || r.rows > most.rows ? r : most),
			undefined
		)

/** Each whole rule's statement's heaviest rerun node (`heaviestRerun`), on `connection`. */
const rerunsOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(plansOf(installed, connection), Arr.map(heaviestRerun))

/** The statements writing lawful documents `from` to `to` through the captures, as a publish writes them whole. */
const writtenWhole = ({ node, expr }: Tables, from: number, to: number): ReadonlyArray<string> => [
	`INSERT INTO ${node} (doc, sub, part, start, parent, kind) SELECT d, d + 1000000, d + 2000000, s, 0, CASE WHEN s = 0 THEN 2 WHEN s = 1 THEN 1 ELSE 0 END FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
	`INSERT INTO ${expr} (doc, sub, part, start, type) SELECT d, d + 1000000, d + 2000000, s, 1 FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
	"SET CONSTRAINTS ALL IMMEDIATE"
]

/**
 * One locality case in its one transaction, which the case's end rolls back: `stored` lawful documents loaded with the
 * captures off, ANALYZE where the case draws it, one document written whole, which the captures hold, and the judge.
 * Every whole rule's statement is explained; then `more` documents are loaded and each explained again. Each must read
 * fewer rows than there are documents beside the written one, each three rows of each table, both times: the written
 * document's rows, three of each table, read once per unit of the region or once per fact a negation reads them at,
 * whichever plan PostgreSQL chooses, and never a row of another document, a read of which reads past the written unit's
 * key range into all of them.
 *
 * Then `written` more documents are written whole, and three times as many again, each statement explained both times:
 * every node of its plan that runs more than once must handle fewer rows a run than there are documents written. A
 * node runs more than once inside a step, once per written unit, and reads that unit's rows alone, a few of each
 * table, whatever the units written; one that reads the region again inside a step, or a second copy of it that an
 * anti join loops over, handles every written unit at every run, so the statement's work grows with the square of the
 * units written.
 */
export const runLocality = (
	installed: Installed,
	connection: PgConnection,
	locality: Locality,
	c: Case<LocalityFeature>
) =>
	Effect.gen(function* () {
		const tables = tablesOf(installed, locality.shape)
		const statistics =
			locality.statistics === "analyzed" ? [`ANALYZE ${tables.node}`, `ANALYZE ${tables.expr}`] : []
		for (const sql of [...loaded(tables, 10, 10 + locality.stored), ...statistics]) {
			yield* connection.query(sql, [])
		}
		const written = 0
		for (const sql of [
			`INSERT INTO ${tables.node} (doc, sub, part, start, parent, kind) VALUES (${placed(written)}, 0, 0, 2), (${placed(written)}, 1, 0, 1), (${placed(written)}, 2, 0, 0)`,
			`INSERT INTO ${tables.expr} (doc, sub, part, start, type) VALUES (${placed(written)}, 0, 1), (${placed(written)}, 1, 1), (${placed(written)}, 2, 1)`,
			"SET CONSTRAINTS ALL IMMEDIATE"
		]) {
			yield* connection.query(sql, [])
		}
		const first = yield* readsOf(installed, connection)
		assert.ok(first.length > 0, "the judge holds a whole rule's statement")
		const from = 11 + locality.stored
		for (const sql of [...loaded(tables, from, from + locality.more), ...statistics]) {
			yield* connection.query(sql, [])
		}
		const again = yield* readsOf(installed, connection)
		const beside = locality.stored
		assert.ok(
			Arr.every([...first, ...again], (rows) => rows < beside),
			`${Formatter.format(locality)}: each whole rule's statement reads the written document's rows alone, fewer than the ${beside} documents beside it, ${Formatter.format(first)} and then ${Formatter.format(again)} beside ${locality.more} more`
		)
		for (const [from, to] of [
			[-locality.written, -1],
			[-4 * locality.written, -locality.written - 1]
		] as const) {
			for (const sql of writtenWhole(tables, from, to)) {
				yield* connection.query(sql, [])
			}
			const documents = 1 - from
			const reruns = yield* rerunsOf(installed, connection)
			assert.ok(
				Arr.every(reruns, (r) => r === undefined || r.rows < documents),
				`${Formatter.format(locality)}: each node a whole rule's statement runs more than once reads one written unit a run, fewer rows than the ${documents} documents written: ${Formatter.format(reruns)}`
			)
		}
		c.note(locality.statistics === "none" ? "measured with no statistics" : "measured analyzed")
	})
