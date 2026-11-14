/**
 * R07 over a closed relation's installed constants (lower/optimize/closed): which occurrences of a declared closed
 * relation become a membership test of its installed key set, and the simplifier's invariant that a Closed node holding
 * fewer facts than its relation carries no declared name. The oracle is the rule's specification as a checker
 * (membershipOf's doc comment): an occurrence is rewritten exactly when every key field is read as a variable another
 * occurrence binds, a literal or a parameter, and no payload field is read. A rewritten occurrence of a sparse relation is
 * read from its installed key set, one of a roster is the tautology its domain makes it and reads nothing, and a kept one
 * is read from its facts. That the rewritten query delivers what the VALUES join delivers is
 * test/pg/closed/membership.test.ts's, on PostgreSQL. A roster's occurrence whose source another occurrence reads
 * laterally, through a constant, stays in its region, its reader's reference in scope; one read by no other occurrence,
 * or beside a lateral read of another source, is its membership test. A Closed node the simplifier narrows holds the
 * rows its filter keeps, as a set.
 *
 * Features: each verdict and each reason a kept occurrence is kept; a whole, a narrowed and an empty roster; rewritten
 * and kept beside a lateral read.
 *
 * Plants, each failing its search: a payload read admitted as a membership (closed-payload); a narrowed Closed node
 * keeping its declared name (closed-narrowed-name); an occurrence read laterally rewritten (closed-lateral).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type Heading, type RelNode } from "#compiler/ir/rel.ts"
import { closedPass } from "#compiler/lower/optimize/closed/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
import { Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"
import { scopedStay } from "#test/unit/lower/rewrite/guarded.ts"
import {
	ledgerCatalog,
	nodesOf,
	passContext,
	queryOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** How the query reads one key field of Grid. */
const KEY_READS = ["item", "literal", "param", "free", "own"] as const
type KeyRead = (typeof KEY_READS)[number]

/** How the query reads Grid's payload `w`. */
const PAYLOAD_READS = ["unread", "item", "literal"] as const
type PayloadRead = (typeof PAYLOAD_READS)[number]

const Kind = closed("Kind", ["Open", "Done", "Held"])
const Tier = closed("Tier", ["Low", "High"])
/** A sparse relation keyed by (k0, k1), with a payload of Kind's closed id: 2 of its 6 key points. */
const Grid = closed.relation(
	"Grid",
	{ k0: closedId(Kind), k1: closedId(Tier), w: closedId(Kind) },
	["k0", "k1"],
	[
		{ k0: "Open", k1: "Low", w: "Done" },
		{ k0: "Held", k1: "High", w: "Open" }
	]
)
const Item = relation(
	"Item",
	{ id: pg.bigint, k0: closedId(Kind), k1: closedId(Tier), w: closedId(Kind) },
	["id"]
)
const Rewrite = schema("Rewrite", [Kind, Tier, Grid, Item], [])

/** The items matched with Grid, its key fields read as `k0` and `k1` say and its payload as `w` says. */
const membership = (k0: KeyRead, k1: KeyRead, w: PayloadRead) =>
	query(Rewrite).rule((r) => {
		const item = v(Item, "item")
		const grid = v(Grid, "grid")
		const itemBinding = {
			id: item.id,
			...(k0 === "item" ? { k0: item.k0 } : {}),
			...(k1 === "item" ? { k1: item.k1 } : {}),
			...(w === "item" ? { w: item.w } : {})
		}
		const first =
			k0 === "item"
				? { k0: item.k0 }
				: k0 === "literal"
					? { k0: "Open" as const }
					: k0 === "param"
						? { k0: r.param("p0", Grid.fields.k0) }
						: k0 === "own"
							? { k0: grid.k0 }
							: {}
		const second =
			k1 === "item"
				? { k1: item.k1 }
				: k1 === "literal"
					? { k1: "High" as const }
					: k1 === "param"
						? { k1: r.param("p1", Grid.fields.k1) }
						: k1 === "own"
							? { k1: grid.k1 }
							: {}
		const payload = w === "item" ? { w: item.w } : w === "literal" ? { w: "Open" as const } : {}
		return r
			.match(Item, itemBinding)
			.match(Grid, { ...first, ...second, ...payload })
			.find({
				id: item.id,
				...(k0 === "own" ? { g0: grid.k0 } : {}),
				...(k1 === "own" ? { g1: grid.k1 } : {})
			})
	})

/**
 * An occurrence the box reads: Grid, a sparse relation, its two key fields and its payload each read some way; or Kind,
 * a roster, its one key field read some way.
 */
type Occurrence =
	| { readonly kind: "Grid"; readonly k0: KeyRead; readonly k1: KeyRead; readonly w: PayloadRead }
	| { readonly kind: "Kind"; readonly id: KeyRead }

const occurrenceGen: Gen<Occurrence> = oneOf<Occurrence>([
	(source) => ({
		kind: "Grid",
		k0: source.draw(element(KEY_READS)),
		k1: source.draw(element(KEY_READS)),
		w: source.draw(element(PAYLOAD_READS))
	}),
	(source) => ({ kind: "Kind", id: source.draw(element(KEY_READS)) })
])

/** The items matched with the roster Kind, its key field read as `id` says. */
const rosterMembership = (id: KeyRead) =>
	query(Rewrite).rule((r) => {
		const item = v(Item, "item")
		const kind = v(Kind, "kind")
		const read =
			id === "item"
				? { id: item.k0 }
				: id === "literal"
					? { id: "Open" as const }
					: id === "param"
						? { id: r.param("p0", closedId(Kind)) }
						: id === "own"
							? { id: kind.id }
							: {}
		return r
			.match(Item, id === "item" ? { id: item.id, k0: item.k0 } : { id: item.id })
			.match(Kind, read)
			.find({ id: item.id, ...(id === "own" ? { g: kind.id } : {}) })
	})

/** Whether a key field is read as one value: a variable another occurrence binds, a literal or a parameter. */
const one = (read: KeyRead): boolean => read === "item" || read === "literal" || read === "param"

/** Whether the specification rewrites the occurrence: every key field one value, and no payload read. */
const specified = (o: Occurrence): boolean =>
	o.kind === "Kind" ? one(o.id) : one(o.k0) && one(o.k1) && o.w === "unread"

type ClosedFeature =
	| "rewritten"
	| "a roster rewritten"
	| "kept: a key field left free"
	| "kept: a key field the relation alone binds"
	| "kept: the payload read"

const featureOf = (o: Occurrence): ClosedFeature => {
	const reads = o.kind === "Kind" ? [o.id] : [o.k0, o.k1]
	return specified(o)
		? o.kind === "Kind"
			? "a roster rewritten"
			: "rewritten"
		: Arr.contains(reads, "free")
			? "kept: a key field left free"
			: Arr.contains(reads, "own")
				? "kept: a key field the relation alone binds"
				: "kept: the payload read"
}

/** A handle of the fixture roster Kind as the Closed node's rows hold it. */
const kindHandle = (handle: string): TypedLiteral => ({ kind: "handle", handle })

/** The fixture roster's handles, the rows of its Closed node in order. */
const kindHandles = ["Automatic", "Manual"] as const
type KindHandle = (typeof kindHandles)[number]

/**
 * A predicate over the roster's one column, of at most one connective: a constant, the column equal to a handle, or the
 * negation, conjunction or disjunction of two of those.
 */
type Leaf =
	| { readonly kind: "constant"; readonly value: boolean }
	| { readonly kind: "equals"; readonly handle: KindHandle }
type Pred =
	| Leaf
	| { readonly kind: "not"; readonly arg: Leaf }
	| { readonly kind: "and" | "or"; readonly left: Leaf; readonly right: Leaf }

const leafGen: Gen<Leaf> = oneOf<Leaf>([
	(source) => ({ kind: "constant", value: source.draw(element([true, false])) }),
	(source) => ({ kind: "equals", handle: source.draw(element(kindHandles)) })
])

const predGen: Gen<Pred> = oneOf<Pred>([
	leafGen,
	(source) => ({ kind: "not", arg: source.draw(leafGen) }),
	(source) => ({
		kind: source.draw(element(["and", "or"] as const)),
		left: source.draw(leafGen),
		right: source.draw(leafGen)
	})
])

/** Whether the predicate holds of the row whose column is `handle`: its meaning, by hand. */
const holdsOf = (p: Pred, handle: KindHandle): boolean => {
	switch (p.kind) {
		case "constant":
			return p.value
		case "equals":
			return p.handle === handle
		case "not":
			return !holdsOf(p.arg, handle)
		case "and":
			return holdsOf(p.left, handle) && holdsOf(p.right, handle)
		case "or":
			return holdsOf(p.left, handle) || holdsOf(p.right, handle)
	}
}

/** The predicate as the IR's expression over the column `id` of `source`. */
const predExpr = (q: Q, source: RelNode, p: Pred): ScalarExpr => {
	switch (p.kind) {
		case "constant":
			return q.lit({ kind: "bool", value: p.value }, T.bool)
		case "equals":
			return q.op("code:int2eq", [q.col(source, "id"), q.lit(kindHandle(p.handle), T.kind)], T.bool)
		case "not":
			return q.op("not", [predExpr(q, source, p.arg)], T.bool)
		case "and":
		case "or":
			return q.op(p.kind, [predExpr(q, source, p.left), predExpr(q, source, p.right)], T.bool)
	}
}

type NarrowedFeature = "the whole roster kept" | "a narrowed roster" | "nothing kept"

describe("R07 over closed constants", () => {
	it.effect(
		"rewrites an occurrence exactly when it reads every key field as one value and no payload",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/closed-membership",
						literal: Formatter.format,
						generator: occurrenceGen,
						coverage: requiredInSpace<ClosedFeature>([
							"rewritten",
							"a roster rewritten",
							"kept: a key field left free",
							"kept: a key field the relation alone binds",
							"kept: the payload read"
						]),
						caseHang,
						box: "every read of Grid's two key fields (an item's variable, a literal, a parameter, free, or Grid's own variable) with every read of its payload (none, an item's variable, a literal), and every read of the roster Kind's key field: 80 queries",
						oracle: {
							kind: "specification",
							name: "membershipOf's rule: every key field a variable bound elsewhere, a literal or a parameter, and no payload read"
						},
						concurrency: 1
					},
					(o, c) =>
						Effect.sync(() => {
							const template = succeeded(
								compileTemplate(
									o.kind === "Grid" ? membership(o.k0, o.k1, o.w) : rosterMembership(o.id),
									Rewrite,
									testCompile
								)
							)
							const rewritten = Arr.some(
								template.certificates,
								(cert) => cert.rule === "R07.closedMembership"
							)
							c.note(featureOf(o))
							assert.equal(rewritten, specified(o), Formatter.format(o))
							const shapes = Arr.map(programAsts(template.programs.optimized), shapeOf)
							assert.equal(
								Arr.some(shapes, (shape) => has(shape, "from values")),
								!rewritten,
								`a rewritten occurrence is read from no VALUES, a kept one from its facts: ${Formatter.format(o)}`
							)
							assert.equal(
								Arr.some(shapes, (shape) => has(shape, "call substring")),
								rewritten && o.kind === "Grid",
								`a rewritten Grid is read from its key set, a rewritten roster through no constant: ${Formatter.format(o)}`
							)
						})
				)
			)
	)

	it.effect(
		"names a Closed node the simplifier narrows after no declared relation, and keeps a whole one's name",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/closed-narrowed",
						literal: Formatter.format,
						generator: predGen,
						coverage: requiredInSpace<NarrowedFeature>([
							"the whole roster kept",
							"a narrowed roster",
							"nothing kept"
						]),
						caseHang,
						box: "every predicate over the roster's id of at most one connective (not, and, or) over constants and comparisons with each handle: 40 filters",
						oracle: {
							kind: "specification",
							name: "the predicate's meaning on each row, and a declared name only on every fact"
						},
						concurrency: 1
					},
					(p, c) =>
						Effect.sync(() => {
							const heading: Heading = [{ name: "id", type: T.kind }]
							const q = new Q()
							const source = q.closed(
								"Kind",
								heading,
								Arr.map(kindHandles, (h) => [kindHandle(h)])
							)
							const root = q.project(
								q.filter(source, predExpr(q, source, p)),
								[["id", "id"]],
								conservativeMeta
							)
							const ran = succeeded(
								runPasses(
									queryOf(q.build(root).dag, []),
									[simplifyPass],
									passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
								)
							)
							const kept = Arr.filter(kindHandles, (h) => holdsOf(p, h))
							c.note(
								kept.length === kindHandles.length
									? "the whole roster kept"
									: kept.length === 0
										? "nothing kept"
										: "a narrowed roster"
							)
							const [only, ...others] = nodesOf(ran.query.dag, "Closed")
							assert.ok(only !== undefined && others.length === 0, "one Closed node")
							unorderedEqual(
								only.rows,
								Arr.map(kept, (h) => [kindHandle(h)]),
								"the Closed node holds the rows the predicate keeps"
							)
							assert.equal(
								only.closed === "Kind",
								kept.length === kindHandles.length,
								`the declared name only on every fact: ${only.closed}`
							)
							assert.ok(
								only.closed === "Kind" || Str.startsWith("__")(only.closed),
								`a narrowed Closed node names no declared relation: ${only.closed}`
							)
						})
				)
			)
	)
})

/**
 * What a third occurrence of a region over the roster Kind and a task reads through a constant on its kind: nothing,
 * the task's kind, or the roster occurrence's own id, a lateral read of the closed source.
 */
type LateralRead = "nothing" | "the task's kind" | "the roster's id"

/** A case: what the third occurrence reads, and whether the task binds its kind to the roster's id. */
interface LateralCase {
	readonly read: LateralRead
	readonly bound: boolean
}

describe("R07 beside a lateral read", () => {
	it.effect(
		"keeps a closed occurrence whose source another occurrence reads, and rewrites one no other occurrence reads",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/closed-lateral",
						literal: Formatter.format,
						generator: (source): LateralCase => ({
							read: source.draw(
								element<LateralRead>(["nothing", "the task's kind", "the roster's id"])
							),
							bound: source.draw(boolean)
						}),
						coverage: requiredInSpace<"rewritten" | "kept">(["rewritten", "kept"]),
						caseHang,
						box: "a region of the roster Kind, a task binding its kind to the roster's id or not, and a task whose kind is fixed to nothing, the first task's kind or the roster's id",
						oracle: {
							kind: "specification",
							name: "membershipsOf: a key another occurrence binds, and no occurrence whose source a scope expression reads"
						},
						concurrency: 1
					},
					({ read, bound }, c) =>
						Effect.sync(() => {
							const q = new Q()
							const roster = q.closed(
								"Kind",
								[{ name: "id", type: T.kind }],
								Arr.map(kindHandles, (h) => [kindHandle(h)])
							)
							const task = q.base(Task, conservativeMeta)
							const reader = q.base(Task, conservativeMeta)
							const constants: Record<string, ScalarExpr> =
								read === "nothing"
									? {}
									: { kind: read === "the task's kind" ? q.col(task, "kind") : q.col(roster, "id") }
							const region = q.region([
								{ source: roster, bind: { id: "k" }, constants: {} },
								{
									source: task,
									bind: bound ? { id: "t", kind: "k" } : { id: "t" },
									constants: {}
								},
								{ source: reader, bind: { id: "u" }, constants }
							])
							const query = queryOf(
								q.build(
									q.project(
										region,
										[
											["t", "t"],
											["u", "u"]
										],
										conservativeMeta
									)
								).dag,
								[]
							)
							const ran = succeeded(
								runPasses(
									query,
									[closedPass],
									passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
								)
							)
							const rewritten = Arr.some(
								ran.certificates,
								(certificate) => certificate.rule === "R07.closedMembership"
							)
							assert.equal(
								rewritten,
								bound && read !== "the roster's id",
								Formatter.format({ read, bound })
							)
							scopedStay(query.dag, ran.query.dag)
							c.note(rewritten ? "rewritten" : "kept")
						})
				)
			)
	)
})
