/** What the properties of rule-whole.test.ts read: the schemas and their templates, the spaces, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec } from "effect"
import { type PlanNode, planNodes, rowsRead } from "#bench/harness/explain.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { dataStepOf, refusedByRecheck } from "#test/support/data-step.ts"
import {
	type Installed,
	migratedTemplate,
	noPlaceholders,
	seededTemplate
} from "#test/support/install-migrate.ts"
import {
	foundQueryOf,
	judgedPlans,
	type JudgedStatement,
	judgedStatementsOf,
	raisedRule,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { storedSeed } from "#test/support/stored.ts"
import { firstRefusalOf, refusalOf } from "#test/support/substrate.ts"
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

export const shapeKeys: Arr.NonEmptyReadonlyArray<ShapeKey> = [
	"1 key",
	"2 key",
	"2 reversed",
	"3 key",
	"3 reversed"
]

const shapeGen: Gen<ShapeKey> = element(shapeKeys)

/** A relation's key: its place's fields as wide as its shape is, and its start, in its judge's order. */
type PlacedKey = readonly ["doc" | "start", ...ReadonlyArray<"doc" | "sub" | "part" | "start">]

/** The key of a relation of a shape of width `width`: doc, then sub and part as wide as the shape is, then start. */
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

/**
 * The key of the probed judge's Expr and Tag (`judgeSchema`): their start, then their place as wide as the shape is, so
 * no rule binds one unit key across them and Node, keyed by its place first.
 */
const startedKey = (width: UnitShape[0]): PlacedKey => {
	switch (width) {
		case 1:
			return ["start", "doc"]
		case 2:
			return ["start", "doc", "sub"]
		case 3:
			return ["start", "doc", "sub", "part"]
	}
}

/** A node of a document, keyed by its place then its start: its parent's start, its start at a root, its kind. */
const nodeOf = (shape: UnitShape) =>
	relation(
		"Node",
		{
			...inOrder(shape[1])({ doc: int4, sub: int4, part: int4 }),
			start: int4,
			parent: int4,
			kind: int4
		},
		placedKey(shape[0])
	)

/** An expression at a node, keyed by `key`: its type. */
const exprOf = (shape: UnitShape, key: PlacedKey) =>
	relation(
		"Expr",
		{
			...inOrder(shape[1])({ doc: int4, sub: int4, part: int4 }),
			start: int4,
			type: int4
		},
		key
	)

/** A tag at a node, keyed by `key`: its mark. */
const tagOf = (shape: UnitShape, key: PlacedKey) =>
	relation(
		"Tag",
		{
			...inOrder(shape[1])({ doc: int4, sub: int4, part: int4 }),
			start: int4,
			mark: int4
		},
		key
	)

/**
 * Each shape's three stored relations of each judge, which its writes name: the whole judge's Expr and Tag keyed as
 * Node is, the probed judge's by their start first (`startedKey`); one name and one heading each, so one write writes
 * either judge's.
 */
const relationsOf = Rec.map(shapes, (shape) => ({
	whole: {
		Node: nodeOf(shape),
		Expr: exprOf(shape, placedKey(shape[0])),
		Tag: tagOf(shape, placedKey(shape[0]))
	},
	probed: {
		Node: nodeOf(shape),
		Expr: exprOf(shape, startedKey(shape[0])),
		Tag: tagOf(shape, startedKey(shape[0]))
	}
}))

/**
 * The place every row of document `doc` holds, as an INSERT's values spell it: its doc, sub and part, its sub and part
 * apart from every doc, start and each other, so a unit's field read at another's position finds no row of the document.
 */
const placed = (doc: number): string => `${doc}, ${doc + 1000000}, ${doc + 2000000}`

/** The judges of each shape: whole, its relations immutable, and probed, its relations mutable and keyed apart. */
export type Judge = "whole" | "probed"

/** The kinds of node Expressed's selection holds, each an expression: a node of any other kind stands outside it. */
const expressedKinds = [1, 2] as const satisfies ReadonlyArray<Kind>

/**
 * The schema the properties judge of shape `shape`, by its rules over queries and its containments between selected
 * sides, every one unit-local in the whole judge: each relation keyed by its document's place first, every rule joining
 * within one document. The probed judge's Node, Expr and Tag are mutable, Node in the unit of its document and Expr and
 * Tag, keyed by their start first (`startedKey`), in the unit of their start, so no rule is unit-local and each is
 * probed, and each containment is native, its foreign key deferred since the two close a cycle (laws/model/model.ts
 * FkCycles); the whole judge's immutable, so each rule over a query is judged whole over the documents a transaction
 * wrote, the unit, and the aggregate's rule beside them, which no probe reads, and each containment, unit-local, by
 * its probes, key by key (laws/model/plan.ts containmentDischarge), its region facts proving the whole rules' reads.
 *
 * - Expressed: a node of kind 1 or 2 is an expression: a containment from a side selected by a list of kinds, which
 *   a node's insert breaks and an expression's delete does.
 * - Parented: an expression of type 0 stands at a node whose parent is the root's place: a containment between two
 *   selected sides, which an expression's insert breaks and a node's delete does.
 * - Rooted: every expression's parent is an expression: a containment of a join into a table, which a node's insert
 *   breaks and an expression's delete does.
 * - Kinded: a node of kind 1 that is an expression is of type 1: a check over a join of a node matched at kind 1 and
 *   its expression, Expressed's selection holding every node the match reads, so its region reads the expressions a
 *   transaction wrote only where they replace one it removed (analysis/theory/unit.ts proofsOf), which an expression's
 *   insert breaks and its node's does.
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
 * - Tagged: every tag stands at a node of a kind the cases write: a containment of every row of a relation into a
 *   selection of a keyed one, which the rule judge holds, where one into the keyed relation's every row would be its
 *   foreign key (laws/model/plan.ts containmentDischarge), and which proves Marks's node as one into every row does,
 *   a row in a selection of Node being a row of Node (analysis/theory/unit.ts regionFactsOf), which a tag's
 *   insert breaks and its node's delete does.
 * - Marked: a tag of mark 1 stands at a node of kind 0: a check over a join of Tag and Node, Tag contained in Node at
 *   Node's key, so its region reads the nodes a transaction wrote only where they replace a node it removed
 *   (analysis/theory/unit.ts proofsOf), which a tag's insert breaks and its node's replacement by one of another kind
 *   does. Typed and Parents join Expr and Node as Marks joins Tag and Node, but no containment holds every Expr in
 *   Node, nor every Node in Expr, and their matches of Node read every kind, which Expressed's selection does not
 *   imply, so theirs reads every node and every expression written.
 */
const judgeSchema = (judge: Judge, shape: ShapeKey) => {
	const [width, order] = shapes[shape]
	const name = `${judge === "whole" ? "Whole" : "Probed"}Judge${width}${order === "key" ? "Keyed" : "Reversed"}`
	const { Node, Expr, Tag } = relationsOf[shape][judge]
	const ordered = inOrder(order)
	const probed = judge === "probed"
	const Base = schema(
		name,
		[Node, Expr, Tag],
		[
			contained(
				on(
					select(Node, (n) => n.in(n.kind, expressedKinds)),
					"doc",
					"sub",
					"part",
					"start"
				),
				on(Expr, "doc", "sub", "part", "start")
			),
			contained(
				on(
					select(Expr, (e) => e.eq(e.type, 0)),
					"doc",
					"sub",
					"part",
					"start"
				),
				on(
					select(Node, (n) => n.eq(n.parent, 0)),
					"doc",
					"sub",
					"part",
					"start"
				)
			),
			contained(
				on(Tag, "doc", "sub", "part", "start"),
				on(
					select(Node, (n) => n.in(n.kind, [0, 1, 2])),
					"doc",
					"sub",
					"part",
					"start"
				)
			),
			...(probed
				? [
						mutable(Node),
						mutable(Expr),
						mutable(Tag),
						unit("Document", { doc: int4 }),
						unit("Started", { start: int4 })
					]
				: [])
		]
	)
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
	const KindOne = derived(
		"KindOne",
		query(Base).rule((r) => {
			const { doc, sub, part, start, type } = v(Expr, "e")
			const at = ordered({ doc, sub, part })
			return r
				.match(Expr, { ...at, start, type })
				.match(Node, { ...at, start, kind: 1 })
				.find({ ...at, start, type })
		})
	)
	const Marks = derived(
		"Marks",
		query(Base).rule((r) => {
			const { doc, sub, part, start, mark } = v(Tag, "t")
			const { kind } = v(Node, "n")
			const at = ordered({ doc, sub, part })
			return r
				.match(Tag, { ...at, start, mark })
				.match(Node, { ...at, start, kind })
				.find({ ...at, start, mark, kind })
		})
	)
	const spj = [
		contained(on(Typed, "doc", "sub", "part", "parent"), on(Expr, "doc", "sub", "part", "start")),
		check("Kinded", KindOne, (k) => k.eq(k.type, 1)),
		key(on(Parents, "doc", "sub", "part", "parent")),
		check("Marked", Marks, (m) => m.or([m.ne(m.mark, 1), m.eq(m.kind, 0)]))
	] as const
	if (probed) {
		return schema.extend([Base], `${name}_1`, [Typed, Parents, KindOne, Marks], spj)
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
	/**
	 * The roots, each a node its own parent, as a union of those of kind 2 and the rest: read by the walk's seed, inside
	 * Reached's recursion, and again by Reach beside the walk, each read keeping it at the unit: the judge's statement
	 * inlines the union at each read, each correlated to the unit, so PostgreSQL seeks each arm by the unit's key. The two
	 * reads are no one node, so the key sets (lower/shapes/share/keys.ts) share none of it in this judge's statements
	 * (rule-whole.test.ts, the commute property).
	 */
	const roots = query(Base)
		.rule((r) => {
			const { doc, sub, part, start } = v(Node, "root")
			const at = ordered({ doc, sub, part })
			return r.match(Node, { ...at, start, parent: start, kind: 2 }).find({ ...at, node: start })
		})
		.rule((r) => {
			const { doc, sub, part, start, kind } = v(Node, "root")
			const at = ordered({ doc, sub, part })
			return r
				.match(Node, { ...at, start, parent: start, kind })
				.where(r.ne(kind, 2))
				.find({ ...at, node: start })
		})
	const reached = query(Base).recursive("Reached", {
		row: { ...ordered({ doc: int4, sub: int4, part: int4 }), node: int4 },
		base: [
			(r) => {
				const { doc, sub, part, node } = v(roots, "root")
				const at = ordered({ doc, sub, part })
				return r.match(roots, { ...at, node }).find({ ...at, node })
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
	/** The nodes the walk reaches, and the roots it starts from, which it reaches too. */
	const Reach = derived(
		"Reach",
		query(Base)
			.rule((r) => {
				const { doc, sub, part, node } = v(reached, "walked")
				const at = ordered({ doc, sub, part })
				return r.match(reached, { ...at, node }).find({ ...at, node })
			})
			.rule((r) => {
				const { doc, sub, part, node } = v(roots, "root")
				const at = ordered({ doc, sub, part })
				return r.match(roots, { ...at, node }).find({ ...at, node })
			})
	)
	const LeafChild = derived(
		"LeafChild",
		query(Base).rule((r) => {
			const { doc, sub, part, start, parent } = v(Node, "c")
			const at = ordered({ doc, sub, part })
			return r
				.match(Node, { ...at, start, parent })
				.where(r.and([r.ne(start, parent), r.not(Node, { ...at, parent: start })]))
				.find({ ...at, parent })
		})
	)
	const Leaves = schema.extend([Base], `${name}_0`, [LeafChild], [])
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
		[Leaves],
		`${name}_1`,
		[Typed, Parents, KindOne, Fanout, Reach, Barren, Marks],
		[
			...spj,
			check("Fanout", Fanout, (f) =>
				f.and([f.le(f.children, 3n), f.or([f.ne(f.kind, 2), f.ge(f.children, 2n)])])
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
		versions: [{ schema: schemaValue, declarations: noDeclarations }],
		options: {
			label: `${judge}_judge_${width}_${order}`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

/**
 * The lawful documents `from` to `to`, each a unit of a root and two children: rows a case reads as stored beside the
 * ones it writes.
 */
const storedDocuments = (
	{ node, expr }: Tables,
	from: number,
	to: number
): ReadonlyArray<string> => [
	`INSERT INTO ${node} (doc, sub, part, start, parent, kind) SELECT d, d + 1000000, d + 2000000, s, 0, CASE WHEN s = 0 THEN 2 WHEN s = 1 THEN 1 ELSE 0 END FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
	`INSERT INTO ${expr} (doc, sub, part, start, type) SELECT d, d + 1000000, d + 2000000, s, 1 FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`
]

/** The documents stored beside the written ones, a template's: thousands, then twice as many, documents 10 and up. */
const storedSizes = { stored: 2500, more: 5000 } as const

/**
 * The whole judge of `shape` installed, and `documents` lawful documents, 10 to documents + 9, committed through the
 * captures once per member, judged at their COMMIT (stored.ts storedSeed): the template a locality or a commute case of
 * that shape writes beside.
 */
const storedTemplate = (shape: ShapeKey, documents: number): SubstrateTemplate<Installed> => {
	const [width, order] = shapes[shape]
	return seededTemplate({
		declaredIn: import.meta,
		name: `whole judge ${shape} stored ${documents}`,
		schema: judgeSchema("whole", shape),
		options: {
			ambient: ordinarySession,
			extensions: [],
			label: `whole_judge_${width}_${order}`
		},
		seed: storedSeed((installed) => storedDocuments(tablesOf(installed, shape), 10, documents + 9))
	})
}

/** Each shape's whole judge with its stored documents, and with twice as many. */
export const storedTemplates = (
	shape: ShapeKey
): {
	readonly stored: SubstrateTemplate<Installed>
	readonly more: SubstrateTemplate<Installed>
} => ({
	stored: storedTemplate(shape, storedSizes.stored),
	more: storedTemplate(shape, storedSizes.more)
})

/** Every shape's whole judge with its stored documents, of which a commute case takes its shape's (Substrate.oneOf). */
export const commuteTemplates: Readonly<Record<ShapeKey, SubstrateTemplate<Installed>>> = {
	"1 key": storedTemplate("1 key", storedSizes.stored),
	"2 key": storedTemplate("2 key", storedSizes.stored),
	"2 reversed": storedTemplate("2 reversed", storedSizes.stored),
	"3 key": storedTemplate("3 key", storedSizes.stored),
	"3 reversed": storedTemplate("3 reversed", storedSizes.stored)
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
export interface Tables {
	readonly node: string
	readonly expr: string
	readonly tag: string
}

export const tablesOf = (installed: Installed, shape: ShapeKey): Tables => {
	const names = namesOf(installed)
	const { Node, Expr, Tag } = relationsOf[shape].whole
	return { node: names.table(Node), expr: names.table(Expr), tag: names.table(Tag) }
}

/**
 * What a transaction of `ops` runs around its writes on `judge`'s installation `installed`: on the whole judge, whose
 * relations are closed, one that removes a row (`removes`) is a migration's data step, inside the one bracket a
 * migration's runner sends (data-step.ts dataStepOf), `before` after its BEGIN and `after`, the judge and the re-check,
 * which judge it, after its last write; none for any other, and none on the probed judge, whose relations are mutable,
 * so a removal there is a served write, judged as any other is.
 */
export const bracketOf = (judge: Judge, installed: Installed, ops: ReadonlyArray<Op>) =>
	judge === "whole" && Arr.some(ops, (op) => removes[op.kind])
		? Option.some(dataStepOf(installed.installation))
		: Option.none()

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const docs = [1, 2] as const
type Doc = (typeof docs)[number]
const starts = [0, 1, 2, 3] as const
type Start = (typeof starts)[number]
const kinds = [0, 1, 2] as const
type Kind = (typeof kinds)[number]
const types = [0, 1] as const
type Type = (typeof types)[number]
const marks = [0, 1] as const
type Mark = (typeof marks)[number]

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
	| { readonly kind: "tag"; readonly doc: Doc; readonly start: Start; readonly mark: Mark }
	| { readonly kind: "unnode" | "unexpr" | "untag"; readonly doc: Doc; readonly start: Start }
	| {
			/** A node removed and one written at its key, of its own parent and kind, in one transaction. */
			readonly kind: "renode"
			readonly doc: Doc
			readonly start: Start
			readonly parent: Start
			readonly nodeKind: Kind
	  }
	| { readonly kind: "unit"; readonly doc: Doc; readonly type: Type }
	| { readonly kind: "drop"; readonly doc: Doc }
	| { readonly kind: "judge" }

/**
 * Whether each write removes a row, a removal's or a replacement's, which a closed relation loses only in a data step:
 * on the whole judge a transaction that removes one runs its writes inside a data step's bracket (`bracketOf`).
 */
export const removes: { readonly [K in Op["kind"]]: boolean } = {
	node: false,
	expr: false,
	tag: false,
	unnode: true,
	unexpr: true,
	untag: true,
	renode: true,
	unit: false,
	drop: true,
	judge: false
}

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
	[
		3,
		(s) => ({
			kind: "tag",
			doc: s.draw(docGen),
			start: s.draw(startGen),
			mark: s.draw(element(marks))
		})
	],
	[1, (s) => ({ kind: "untag", doc: s.draw(docGen), start: s.draw(startGen) })],
	[
		2,
		(s) => ({
			kind: "renode",
			doc: s.draw(docGen),
			start: s.draw(startGen),
			parent: s.draw(startGen),
			nodeKind: s.draw(element(kinds))
		})
	],
	[2, (s) => ({ kind: "unit", doc: s.draw(docGen), type: s.draw(element(types)) })],
	[1, (s) => ({ kind: "drop", doc: s.draw(docGen) })],
	[1, () => ({ kind: "judge" })]
])

/**
 * A transaction as it runs: one that removes a row (`removes`) is the whole judge's data step, which its bracket's
 * checks judge at its end alone (`bracketOf`), as a migration's runner judges a custom data step, so it runs no judge
 * of its own; any other as drawn.
 */
const asRun = (ops: ReadonlyArray<Op>): ReadonlyArray<Op> =>
	Arr.some(ops, (op) => removes[op.kind]) ? Arr.filter(ops, (op) => op.kind !== "judge") : ops

/** A case of transactions `transactions` draws, at a shape drawn first, each as it runs (`asRun`). */
const shaped =
	(transactions: Gen<Schedule["transactions"]>): Gen<Schedule> =>
	(s) => ({ shape: s.draw(shapeGen), transactions: Arr.map(s.draw(transactions), asRun) })

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
	| "refused by Expressed"
	| "refused by Parented"
	| "refused by Tagged"
	| "refused by Marked"
	| "a node replaced under its tag"
	| "an expression written at a node that stood before"
	| "Rooted refusing an expression written at a node outside Expressed's selection that stood before"
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
	"refused by Expressed",
	"refused by Parented",
	"refused by Tagged",
	"refused by Marked",
	"a node replaced under its tag",
	"an expression written at a node that stood before",
	"Rooted refusing an expression written at a node outside Expressed's selection that stood before",
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

/**
 * An expression written at a node that stood before, outside Expressed's selection: a document written whole and a
 * node of kind 0 below its second child, also of kind 0; then the child's expression removed, which no rule refuses;
 * then the expression of the node below it, whose parent is no expression's now, which Rooted refuses. Expressed's
 * containment proves nothing of the node, which its selection does not hold, so the whole judge reads the expression
 * written where no expression stood (analysis/theory/unit.ts proofsOf).
 */
const writtenAtStanding: Gen<Schedule> = shaped((s) => {
	const doc = s.draw(docGen)
	return [
		[...lawful(doc, 1), { kind: "node", doc, start: 3, parent: 2, nodeKind: 0 }],
		[{ kind: "unexpr", doc, start: 2 }],
		[{ kind: "expr", doc, start: 3, type: s.draw(element(types)) }]
	]
})

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
						{ kind: "unnode", doc, start: 2 }
					]
			return [lawful(doc, 1), changed]
		})
	],
	[
		"refused by Kinded",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				[
					...lawful(doc, 0),
					{ kind: "unexpr", doc, start: 1 },
					{ kind: "expr", doc, start: 1, type: 0 }
				]
			]
		})
	],
	[
		"refused by Rooted",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				lawful(doc, 1),
				[
					{ kind: "unexpr", doc, start: 2 },
					{ kind: "node", doc, start: 3, parent: 2, nodeKind: 0 },
					{ kind: "expr", doc, start: 3, type: 1 }
				]
			]
		})
	],
	[
		"refused by Expressed",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [lawful(doc, 1), [{ kind: "unexpr", doc, start: 1 }]]
		})
	],
	[
		"refused by Parented",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				lawful(doc, 1),
				[
					{ kind: "node", doc, start: 3, parent: 1, nodeKind: 0 },
					{ kind: "expr", doc, start: 3, type: 0 }
				]
			]
		})
	],
	[
		"refused by Tagged",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				lawful(doc, 1),
				[
					s.draw(boolean)
						? { kind: "tag", doc, start: 3, mark: 0 }
						: { kind: "unnode", doc, start: 2 }
				],
				...(s.draw(boolean) ? [] : [[{ kind: "tag", doc, start: 2, mark: 0 } as const]])
			]
		})
	],
	[
		"refused by Marked",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [lawful(doc, 1), [{ kind: "tag", doc, start: 1, mark: 1 }]]
		})
	],
	[
		"a node replaced under its tag",
		shaped((s) => {
			const doc = s.draw(docGen)
			return [
				[...lawful(doc, 1), { kind: "tag", doc, start: 2, mark: 1 }],
				[{ kind: "renode", doc, start: 2, parent: 0, nodeKind: s.draw(element(kinds)) }]
			]
		})
	],
	["an expression written at a node that stood before", writtenAtStanding],
	[
		"Rooted refusing an expression written at a node outside Expressed's selection that stood before",
		writtenAtStanding
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
				[
					...lawful(doc, 1),
					{ kind: "judge" },
					{
						kind: "node",
						doc,
						start: 3,
						parent: s.draw(startGen),
						nodeKind: s.draw(element(kinds))
					}
				]
			]
		})
	]
]

export const wholeSpace = aimed(scheduleGen, aims)

/** The statements of one write, on an installation's tables. */
export const statementsOf = (
	{ node, expr, tag }: Tables,
	op: Exclude<Op, { readonly kind: "judge" }>
): ReadonlyArray<string> => {
	switch (op.kind) {
		case "node":
			return [
				`INSERT INTO ${node} (doc, sub, part, start, parent, kind) VALUES (${placed(op.doc)}, ${op.start}, ${op.parent}, ${op.nodeKind}) ON CONFLICT DO NOTHING`
			]
		case "renode":
			return [
				`DELETE FROM ${node} WHERE doc = ${op.doc} AND start = ${op.start}`,
				`INSERT INTO ${node} (doc, sub, part, start, parent, kind) VALUES (${placed(op.doc)}, ${op.start}, ${op.parent}, ${op.nodeKind}) ON CONFLICT DO NOTHING`
			]
		case "tag":
			return [
				`INSERT INTO ${tag} (doc, sub, part, start, mark) VALUES (${placed(op.doc)}, ${op.start}, ${op.mark}) ON CONFLICT DO NOTHING`
			]
		case "untag":
			return [`DELETE FROM ${tag} WHERE doc = ${op.doc} AND start = ${op.start}`]
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
				`DELETE FROM ${tag} WHERE doc = ${op.doc}`,
				`DELETE FROM ${expr} WHERE doc = ${op.doc}`,
				`DELETE FROM ${node} WHERE doc = ${op.doc}`
			]
	}
}

/** Every law a refusal's constraint serves, through the installation's constraint map: none for another table's. */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(
		["Node", "Expr", "Tag"],
		(r) => installation.names.relation(r).name === table
	)
	return Option.isNone(owner)
		? []
		: (lawsOfConstraint(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			) ?? [])
}

/** The rules and containments the schemas state, by the names their features read. */
export type RuleName =
	| "Rooted"
	| "Kinded"
	| "One type"
	| "Fanout"
	| "Reached"
	| "Leafed"
	| "Expressed"
	| "Parented"
	| "Tagged"
	| "Marked"

/** The rules the whole schema alone states, which no probe reads: an aggregate's, a recursion's and a nested negation's. */
const wholeOnly: ReadonlyArray<RuleName> = ["Fanout", "Reached", "Leafed"]

/** The containments between the stored relations, each probed in the whole judge and its twin's native foreign key. */
const containments: ReadonlyArray<RuleName> = ["Expressed", "Parented", "Tagged"]

/** The situation a refusal by each rule reaches. */
const refusedBy: { readonly [R in RuleName]: WholeFeature } = {
	Rooted: "refused by Rooted",
	Kinded: "refused by Kinded",
	"One type": "refused by One type",
	Fanout: "refused by Fanout",
	Reached: "refused by Reached",
	Leafed: "refused by Leafed",
	Expressed: "refused by Expressed",
	Parented: "refused by Parented",
	Tagged: "refused by Tagged",
	Marked: "refused by Marked"
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
			return law.name === "Fanout"
				? "Fanout"
				: law.name === "Leafed"
					? "Leafed"
					: law.name === "Marked"
						? "Marked"
						: "Kinded"
	}
}

/** The rule or containment law `law` of an installation states, by its name, whichever strategy discharges it. */
const ruleNameOf = (installation: Installation, law: LawId): RuleName => {
	const detail = defined(
		Arr.findFirst(installation.laws.theory.laws, (l) => l.id === law).pipe(Option.getOrUndefined),
		`the law ${law}`
	).detail
	if (detail.kind === "containment") {
		return detail.from.relation === "Node"
			? "Expressed"
			: detail.from.relation === "Tag"
				? "Tagged"
				: "Parented"
	}
	assert.ok(detail.kind === "rule", `the law ${law} is a rule or a containment`)
	return nameOfLaw(detail.rule.kind === "whole" ? detail.rule.law : detail.rule)
}

/** The law of the rule or containment `rule` that `installation` states, whichever strategy discharges it. */
export const lawNamed = (installation: Installation, rule: RuleName): LawId =>
	defined(
		Arr.findFirst(installation.laws.rules, (r) => ruleNameOf(installation, r.law.id) === rule).pipe(
			Option.getOrUndefined
		),
		`the law of ${rule} among ${installation.names.schema}'s rules`
	).law.id

/** What one installation's judge made of a state: the laws its whole checks find broken, and the law it refused by. */
interface Verdict {
	readonly broken: ReadonlySet<RuleName>
	readonly refused: RuleName | undefined
}

/**
 * Judges the state `session`'s transaction leaves against every check of the laws its judge holds, the violation
 * queries a migration runs over every row, and `held`, the laws found broken in the same state that it holds natively,
 * then runs `judge`, what judges that state: at a served transaction's judge op or end, SET CONSTRAINTS ALL IMMEDIATE,
 * the judge and every deferred foreign key; at a data step's end, its bracket's checks (`bracketOf`), the judge and
 * then the re-check, which checks every rule over a closed relation over every row, the judge reading none of the rows
 * a data step removes of one. It must refuse exactly when a check finds the state broken, naming a law it finds broken:
 * the judge under that law's SQLSTATE, the re-check under 23000 and the law's identity (data-step.ts refusedByRecheck).
 */
const judged = (
	installed: Installed,
	session: RawSession,
	where: string,
	held: ReadonlySet<RuleName>,
	judge: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const broken = new Set<RuleName>(held)
		const found = new Set<LawId>()
		for (const lawCheck of baselineRuleChecks(installation)) {
			const rows = yield* session.values(`SELECT EXISTS (${printStatement(lawCheck.query)})`, [])
			if (rows[0]?.[0] === true) {
				broken.add(ruleNameOf(installation, lawCheck.law))
				found.add(lawCheck.law)
			}
		}
		for (const check of lawChecks(installation).rules) {
			const rows = yield* session.values(foundQueryOf(check.query), [])
			if ((rows[0]?.[0] === true) !== found.has(check.law)) {
				return yield* new Disagreed({
					message: `${installation.names.schema}: the check over every row of ${check.law} finds ${rows[0]?.[0] === true ? "a row" : "none"} where its whole check finds ${found.has(check.law) ? "the rule broken" : "nothing"}, ${where}`
				})
			}
		}
		const refused = yield* firstRefusalOf(judge, (sql) => session.query(sql, []))
		if (Option.isNone(refused)) {
			if (broken.size > 0) {
				return yield* new Disagreed({
					message: `${installation.names.schema}: the judge accepted a state its whole checks find breaking ${Formatter.format([...broken])}, ${where}`
				})
			}
			return { broken, refused: undefined } satisfies Verdict
		}
		/** The law the re-check refused under, none where the judge or a foreign key refused. */
		const rechecked = Arr.filter(
			Arr.map(installation.laws.rules, (r) => r.law.id),
			(law) => refusedByRecheck(refused.value, law)
		)
		const rule = Arr.findFirst(
			Arr.map(
				Arr.isReadonlyArrayNonEmpty(rechecked)
					? rechecked
					: refusedLaws(installation, refused.value),
				(law) => ruleNameOf(installation, law)
			),
			(r) => broken.has(r)
		).pipe(Option.getOrUndefined)
		if (
			rule === undefined ||
			(!Arr.isReadonlyArrayNonEmpty(rechecked) &&
				!["23503", "23505", "23514"].includes(refused.value.code))
		) {
			return yield* new Disagreed({
				message: `${installation.names.schema}: the judge refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where the whole checks find ${Formatter.format([...broken])}, ${where}`
			})
		}
		return { broken, refused: rule } satisfies Verdict
	})

/** Whether `table` holds a row at the document and start `at`, as `session` sees it. */
const standing = (
	session: RawSession,
	table: string,
	at: { readonly doc: Doc; readonly start: Start }
) =>
	Effect.map(
		session.values(
			`SELECT EXISTS (SELECT FROM ${table} WHERE doc = ${at.doc} AND start = ${at.start})`,
			[]
		),
		(found) => found[0]?.[0] === true
	)

/** The kind of the node a write names, as the session holds it; none where no node stands there. */
const kindAt = (
	session: RawSession,
	table: string,
	at: { readonly doc: Doc; readonly start: Start }
) =>
	Effect.map(
		session.values(`SELECT kind FROM ${table} WHERE doc = ${at.doc} AND start = ${at.start}`, []),
		(rows) => Option.fromUndefinedOr(rows[0]?.[0]).pipe(Option.filter((k) => typeof k === "number"))
	)

/** The units one transaction's writes reach, by the documents they write. */
const unitsOf = (ops: ReadonlyArray<Op>): ReadonlySet<Doc> =>
	new Set(Arr.flatMap(ops, (op) => (op.kind === "judge" ? [] : [op.doc])))

/**
 * One case of the equivalence on a clone of each installation: each transaction's writes in order on an owner session
 * of each at SERIALIZABLE, the whole judge's and the probed judge's in lockstep. At each judge op and at the
 * transaction's end, each installation's judge is held to its whole checks (`judged`), and the whole judge refuses
 * exactly where the probed judge does, wherever the aggregate's rule, which only the whole schema states, holds. A
 * transaction that removes a row is the whole judge's data step, inside its bracket (`bracketOf`), judged at its end by
 * the bracket's checks, the re-check refusing what the judge, which reads none of a closed relation's removed rows, does
 * not; on the probed judge, whose relations are mutable, it is a served write. A refusal of either rolls both back, so
 * the two hold one state throughout.
 */
export const runEquivalence = (
	whole: { readonly installed: Installed; readonly session: RawSession },
	probed: { readonly installed: Installed; readonly session: RawSession },
	schedule: Schedule,
	c: Case<WholeFeature>
) =>
	Effect.gen(function* () {
		assert.ok(
			Arr.every(whole.installed.installation.laws.rules, (r) =>
				r.law.detail.kind === "containment" ? r.rule.kind === "contained" : r.rule.kind === "whole"
			) && Arr.every(probed.installed.installation.laws.rules, (r) => r.rule.kind !== "whole"),
			"the whole judge judges every rule over a query whole and every containment by its probes, and the probed judge none whole"
		)
		const sides = [
			{ ...whole, judge: "whole", tables: tablesOf(whole.installed, schedule.shape) },
			{ ...probed, judge: "probed", tables: tablesOf(probed.installed, schedule.shape) }
		] as const
		const wholeTables = tablesOf(whole.installed, schedule.shape)
		c.note(shapeFeatures[schedule.shape])
		for (const [at, ops] of schedule.transactions.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)}`
			/** Each judge's bracket of the transaction, the whole judge's where it is a data step (`bracketOf`). */
			const brackets = {
				whole: bracketOf("whole", whole.installed, ops),
				probed: bracketOf("probed", probed.installed, ops)
			} as const satisfies Record<Judge, unknown>
			assert.ok(
				Option.isNone(brackets.whole) || !Arr.some(ops, (op) => op.kind === "judge"),
				`a data step runs no judge of its own, its bracket's checks judging it at its end (asRun), ${where}`
			)
			for (const side of sides) {
				yield* side.session.begin
				for (const sql of Option.match(brackets[side.judge], {
					onNone: () => [],
					onSome: (b) => b.before
				})) {
					yield* side.session.query(sql, [])
				}
			}
			if (unitsOf(ops).size > 1) {
				c.note("two units written in one transaction")
			}
			/**
			 * Both judges at this point: the whole judge refuses exactly where the probed one does, wherever the rules
			 * only the whole schema states hold, the probed one's containments, its native foreign keys, judged by the
			 * whole one's checks of the same state.
			 */
			const both = (judging: (judge: Judge) => ReadonlyArray<string>) =>
				Effect.gen(function* () {
					const w = yield* judged(
						whole.installed,
						whole.session,
						where,
						new Set(),
						judging("whole")
					)
					const p = yield* judged(
						probed.installed,
						probed.session,
						where,
						new Set(Arr.filter(containments, (r) => w.broken.has(r))),
						judging("probed")
					)
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
			/** What judges a served write's state: SET CONSTRAINTS ALL IMMEDIATE, the judge and the deferred foreign keys. */
			const served = (): ReadonlyArray<string> => ["SET CONSTRAINTS ALL IMMEDIATE"]
			let ended = false
			let judgedOnce = false
			/** Whether this transaction wrote an expression at a node that stood before outside Expressed's selection. */
			let outsideSelection = false
			/** The refusal of the transaction by `rule`, noted with what the transaction wrote. */
			const noteRefused = (rule: RuleName): void => {
				c.note(refusedBy[rule])
				if (rule === "Rooted" && outsideSelection) {
					c.note(
						"Rooted refusing an expression written at a node outside Expressed's selection that stood before"
					)
				}
			}
			/** The nodes this transaction wrote, each by its document and start. */
			const nodesWritten = new Set<string>()
			for (const op of ops) {
				if (op.kind === "judge") {
					const refused = yield* both(served)
					if (refused !== undefined) {
						noteRefused(refused)
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
				if (op.kind === "renode" && (yield* standing(whole.session, wholeTables.tag, op))) {
					c.note("a node replaced under its tag")
				}
				if (
					op.kind === "expr" &&
					!nodesWritten.has(`${op.doc}:${op.start}`) &&
					!(yield* standing(whole.session, wholeTables.expr, op))
				) {
					const kind = yield* kindAt(whole.session, wholeTables.node, op)
					if (Option.isSome(kind)) {
						c.note("an expression written at a node that stood before")
						outsideSelection ||= !Arr.contains<number>(expressedKinds, kind.value)
					}
				}
				if (op.kind === "node" || op.kind === "renode") {
					nodesWritten.add(`${op.doc}:${op.start}`)
				}
				if (op.kind === "unit") {
					for (const start of [0, 1, 2]) {
						nodesWritten.add(`${op.doc}:${start}`)
					}
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
			/** The transaction's end: a data step's bracket's checks judge it, where it is one; else as at a judge op. */
			const refused = yield* both((judge) =>
				Option.match(brackets[judge], { onNone: served, onSome: (b) => b.after })
			)
			if (refused === undefined) {
				for (const side of sides) {
					yield* side.session.commit
				}
				c.note("committed")
			} else {
				noteRefused(refused)
				for (const side of sides) {
					yield* side.session.rollback
				}
			}
		}
	})

/** The statements the judge's parts test a whole rule by: each whole rule's statement. */
export const wholeStatementsOf = (installation: Installation): ReadonlyArray<JudgedStatement> => {
	const whole = new Set<string>(
		Arr.flatMap(installation.laws.rules, (rule) =>
			rule.rule.kind === "whole" ? [identifierOf(rule.named)] : []
		)
	)
	return Arr.filter(judgedStatementsOf(installation), (s) =>
		Option.exists(raisedRule(s), (rule) => whole.has(rule))
	)
}

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
	readonly statistics: "none" | "analyzed"
	/** The documents a transaction then writes beside the first, and three times as many again. */
	readonly written: number
}

/** A locality case of `shape`, its stored documents its templates' (storedTemplates). */
export const localityGen =
	(shape: ShapeKey): Gen<Locality> =>
	(s) => ({
		shape,
		statistics: s.draw(element(["none", "analyzed"] as const)),
		written: s.draw(int(30, 60))
	})

export type LocalityFeature = "measured with no statistics" | "measured analyzed"

/** Each whole rule's statement's plan, as EXPLAIN ANALYZE runs it, on `connection`. */
const plansOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(
		judgedPlans(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			wholeStatementsOf(installed.installation)
		),
		Arr.map((judged) => judged.plan)
	)

/** The rows each whole rule's statement reads of the stored tables, as EXPLAIN ANALYZE counts them, on `connection`. */
export const readsOf = (installed: Installed, connection: PgConnection) =>
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
export const rerunsOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(plansOf(installed, connection), Arr.map(heaviestRerun))

/** The statements writing lawful documents `from` to `to` through the captures, as a publish writes them whole, their
 * rows standing in the deltas until the judge reads them. */
const writtenWhole = ({ node, expr }: Tables, from: number, to: number): ReadonlyArray<string> => [
	"SET CONSTRAINTS ALL DEFERRED",
	`INSERT INTO ${node} (doc, sub, part, start, parent, kind) SELECT d, d + 1000000, d + 2000000, s, 0, CASE WHEN s = 0 THEN 2 WHEN s = 1 THEN 1 ELSE 0 END FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`,
	`INSERT INTO ${expr} (doc, sub, part, start, type) SELECT d, d + 1000000, d + 2000000, s, 1 FROM generate_series(${from}, ${to}) AS g(d), generate_series(0, 2) AS h(s)`
]

/** The judge's run, after every measurement of its statements, which reads and deletes the deltas' rows. */
const judgeRun = "SET CONSTRAINTS ALL IMMEDIATE"

/**
 * One locality case over two clones, each in one transaction the case's end rolls back: on `stored`'s, beside its
 * template's committed lawful documents (storedTemplates), ANALYZE where the case draws it, and one document written
 * whole, which the captures hold; every whole rule's statement is explained over the deltas that hold its rows
 * (test/support/judge.ts judgedPlans); then the same on `more`'s, beside twice as many. Each must read fewer rows than
 * there are documents beside the written one, each three rows of each table, both times: the written document's rows,
 * three of each table, read once per unit of the region or once per fact a negation reads them at, whichever plan
 * PostgreSQL chooses, and never a row of another document, a read of which reads past the written unit's key range into
 * all of them.
 *
 * Then, on `more`'s, `written` more documents are written whole, and three times as many again, each statement
 * explained both times over the deltas that hold every document written so far, and the judge runs at the case's end,
 * after every measurement, since it deletes every row of a delta it reads: every node of its plan that runs more than
 * once must handle fewer rows a run than there are documents written. A node runs more than once inside a step, once
 * per written unit, and reads that unit's rows alone, a few of each table, whatever the units written; one that reads
 * the region again inside a step, or a second copy of it that an anti join loops over, handles every written unit at
 * every run, so the statement's work grows with the square of the units written.
 */
export const runLocality = (
	stored: { readonly installed: Installed; readonly connection: PgConnection },
	more: { readonly installed: Installed; readonly connection: PgConnection },
	locality: Locality,
	c: Case<LocalityFeature>
) =>
	Effect.gen(function* () {
		/** The judge's reads over document 0 written whole on one clone. */
		const measured = (installed: Installed, connection: PgConnection) =>
			Effect.gen(function* () {
				yield* standUpJudge(connection, installed.installation)
				const tables = tablesOf(installed, locality.shape)
				const written = 0
				for (const sql of [
					...(locality.statistics === "analyzed"
						? [`ANALYZE ${tables.node}`, `ANALYZE ${tables.expr}`]
						: []),
					`INSERT INTO ${tables.node} (doc, sub, part, start, parent, kind) VALUES (${placed(written)}, 0, 0, 2), (${placed(written)}, 1, 0, 1), (${placed(written)}, 2, 0, 0)`,
					`INSERT INTO ${tables.expr} (doc, sub, part, start, type) VALUES (${placed(written)}, 0, 1), (${placed(written)}, 1, 1), (${placed(written)}, 2, 1)`
				]) {
					yield* connection.query(sql, [])
				}
				return yield* readsOf(installed, connection)
			})
		const first = yield* measured(stored.installed, stored.connection)
		assert.ok(first.length > 0, "the judge holds a whole rule's statement")
		yield* stored.connection.query(judgeRun, [])
		const again = yield* measured(more.installed, more.connection)
		const beside = storedSizes.stored
		assert.ok(
			Arr.every([...first, ...again], (rows) => rows < beside),
			`${Formatter.format(locality)}: each whole rule's statement reads the written document's rows alone, fewer than the ${beside} documents beside it, ${Formatter.format(first)} and then ${Formatter.format(again)} beside ${storedSizes.more}`
		)
		const { installed, connection } = more
		const tables = tablesOf(installed, locality.shape)
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
		yield* connection.query(judgeRun, [])
		c.note(locality.statistics === "none" ? "measured with no statistics" : "measured analyzed")
	})

/**
 * A case of two units written at once: its judge's shape, and the lawful documents stored and committed beside them
 * first, each a root and two children, so every stored table spans many pages.
 */
export interface Commute {
	readonly shape: ShapeKey
}

/** A commute case's shape, its stored documents, thousands, its template's (commuteTemplates). */
export const commuteGen: Gen<Commute> = (s) => ({ shape: s.draw(shapeGen) })

/**
 * The relations, Node's and Expr's tables and their indexes, that `session`'s transaction holds a SIRead lock on whole,
 * by name: each a relation the other transaction writes, so a lock on all of it is broken by any row the other writes.
 */
const wholeLocksOn = (session: RawSession, { node, expr }: Tables) =>
	Effect.map(
		session.values(
			`SELECT c.relname FROM pg_catalog.pg_locks AS l JOIN pg_catalog.pg_class AS c ON c.oid = l.relation WHERE l.mode = 'SIReadLock' AND l.locktype = 'relation' AND l.pid = ${session.pid} AND l.relation IN (SELECT i.indexrelid FROM pg_catalog.pg_index AS i WHERE i.indrelid IN ('${node}'::regclass, '${expr}'::regclass) UNION ALL SELECT '${node}'::regclass UNION ALL SELECT '${expr}'::regclass) ORDER BY 1`,
			[]
		),
		Arr.map(([name]) => (typeof name === "string" ? name : assert.fail("a relation's name")))
	)

/**
 * One case of two units written at once, on a fresh clone of its shape's whole judge: `stored` lawful documents loaded
 * and committed with the captures off, then two transactions at SERIALIZABLE on two sessions, each writing one document
 * whole, the first left of every stored one in key order and the second right of them, and each running its judge,
 * both open before either commits. Neither's judge may hold a SIRead lock on all of a relation the other writes, Node,
 * Expr or an index of theirs, and both commit: each judge reads its own unit's rows, its key range's index pages, so
 * the two writes share no row and no page and PostgreSQL's SSI finds no conflict between them. A relation neither writes
 * is not asked after: Tag stands empty, and PostgreSQL reads a table of no page by a sequential scan and locks an empty
 * index whole at its first scan (nbtsearch.c _bt_first), its limits on a young table, not the judge's reads.
 */
export const runCommute = (
	installed: Installed,
	first: RawSession,
	second: RawSession,
	commute: Commute,
	c: Case<"two units written at once, both committed">
) =>
	Effect.gen(function* () {
		const tables = tablesOf(installed, commute.shape)
		const right = 20 + storedSizes.stored
		const written: ReadonlyArray<readonly [RawSession, number]> = [
			[first, 0],
			[second, right]
		]
		for (const [session, doc] of written) {
			yield* session.begin
			for (const sql of [...writtenWhole(tables, doc, doc), judgeRun]) {
				yield* session.query(sql, [])
			}
			const locked = yield* wholeLocksOn(session, tables)
			assert.deepEqual(
				locked,
				[],
				`${Formatter.format(commute)}: the judge of document ${doc} holds no SIRead lock on all of a relation the other transaction writes`
			)
		}
		const ended = yield* Effect.forEach(written, ([session]) => refusalOf(session.commit))
		assert.deepEqual(
			Arr.map(
				ended,
				Option.map((f) => f.code)
			),
			[Option.none(), Option.none()],
			`${Formatter.format(commute)}: two transactions each writing a unit of its own beside ${storedSizes.stored} stored both commit`
		)
		c.note("two units written at once, both committed")
	})

/**
 * A case of the narrowed region: its judge's shape, the documents a transaction writes whole, three nodes and three
 * expressions each, and how many of them it tags, one tag each.
 */
export interface Narrowed {
	readonly shape: ShapeKey
	readonly documents: number
	readonly tagged: number
}

/** Tens of documents written whole, a few of them tagged. */
export const narrowedGen: Gen<Narrowed> = (s) => ({
	shape: s.draw(shapeGen),
	documents: s.draw(int(40, 80)),
	tagged: s.draw(int(1, 10))
})

/**
 * One case of the narrowed region in its one transaction, which the case's end rolls back: `documents` lawful documents
 * written whole through the captures, as a publish writes them, the first `tagged` of them tagged at their start 2, a
 * node of kind 0 at mark 1, every whole rule's statement explained over the deltas that hold them, and then the judge. Each scan of Tag runs at most
 * once per tag written: Marks joins Tag and Node at Node's key, Tag contained in Node there, so its region holds the
 * tags' units and no node's, every node written fresh (analysis/theory/unit.ts proofsOf), and Tagged's region holds
 * the tags' units and the nodes removed, none; where the region held every node written, Marks would read Tag once per
 * node, three a document.
 */
export const runNarrowed = (
	installed: Installed,
	connection: PgConnection,
	narrowed: Narrowed,
	c: Case<"documents written whole beside a few tags">
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const tables = tablesOf(installed, narrowed.shape)
		for (const sql of [
			...writtenWhole(tables, 1, narrowed.documents),
			`INSERT INTO ${tables.tag} (doc, sub, part, start, mark) SELECT d, d + 1000000, d + 2000000, 2, 1 FROM generate_series(1, ${narrowed.tagged}) AS g(d)`
		]) {
			yield* connection.query(sql, [])
		}
		const tag = installed.installation.names.relation("Tag").name
		const plans = yield* plansOf(installed, connection)
		yield* connection.query(judgeRun, [])
		const loops = Arr.flatMap(plans, (plan) =>
			Iterator.from(planNodes(plan))
				.filter((n) => Option.contains(n.relation, tag))
				.map((n) => n.actualLoops)
				.toArray()
		)
		assert.ok(loops.length > 0, "a whole rule's statement reads Tag")
		assert.ok(
			Arr.every(loops, (n) => n <= narrowed.tagged),
			`${Formatter.format(narrowed)}: each scan of Tag runs at most once per tag written, ${narrowed.tagged}, beside the ${3 * narrowed.documents} nodes written: ${Formatter.format(loops)}`
		)
		c.note("documents written whole beside a few tags")
	})
