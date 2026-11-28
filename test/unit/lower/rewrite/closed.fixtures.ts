/** What the properties of closed.test.ts read: its spaces, models and helpers. */

import { element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { type RelNode } from "#compiler/ir/rel.ts"
import { closedId, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { Q, T } from "#test/support/unit/lower/conservative/fixtures.ts"

/** How the query reads one key field of Grid. */
const KEY_READS = ["item", "literal", "param", "free", "own"] as const

/** One way the query reads a key field of Grid. */
type KeyRead = (typeof KEY_READS)[number]

/** How the query reads Grid's payload `w`. */
const PAYLOAD_READS = ["unread", "item", "literal"] as const

/** One way the query reads Grid's payload `w`. */
type PayloadRead = (typeof PAYLOAD_READS)[number]

/** The roster Kind: three handles, the codes of Grid's first key field and its payload. */
const Kind = closed.ordered("Kind", ["Open", "Done", "Held"])

/** The roster Tier: two handles, the codes of Grid's second key field. */
const Tier = closed.ordered("Tier", ["Low", "High"])

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

/** The items a query matches with Grid, each carrying a value of each of Grid's fields. */
const Item = relation(
	"Item",
	{ id: int8, k0: closedId(Kind), k1: closedId(Tier), w: closedId(Kind) },
	["id"]
)

/** The schema of Kind, Tier, Grid and Item. */
export const Rewrite = schema("Rewrite", [Kind, Tier, Grid, Item], [])

/** The items matched with Grid, its key fields read as `k0` and `k1` say and its payload as `w` says. */
export const membership = (k0: KeyRead, k1: KeyRead, w: PayloadRead) =>
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

/** Every occurrence the box reads: each read of Grid's fields, and each read of Kind's key field. */
export const occurrenceGen: Gen<Occurrence> = oneOf<Occurrence>([
	(source) => ({
		kind: "Grid",
		k0: source.draw(element(KEY_READS)),
		k1: source.draw(element(KEY_READS)),
		w: source.draw(element(PAYLOAD_READS))
	}),
	(source) => ({ kind: "Kind", id: source.draw(element(KEY_READS)) })
])

/** The items matched with the roster Kind, its key field read as `id` says. */
export const rosterMembership = (id: KeyRead) =>
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
export const specified = (o: Occurrence): boolean =>
	o.kind === "Kind" ? one(o.id) : one(o.k0) && one(o.k1) && o.w === "unread"

/** What an occurrence of the box reaches: rewritten (a sparse relation or a roster), or the reason it is kept. */
export type ClosedFeature =
	| "rewritten"
	| "a roster rewritten"
	| "kept: a key field left free"
	| "kept: a key field the relation alone binds"
	| "kept: the payload read"

/** The feature an occurrence reaches by the specification: rewritten, or the first reason it is kept. */
export const featureOf = (o: Occurrence): ClosedFeature => {
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
export const kindHandle = (handle: string): TypedLiteral => ({ kind: "handle", handle })

/** The fixture roster's handles, the rows of its Closed node in order. */
export const kindHandles = ["Automatic", "Manual"] as const

/** A handle of the fixture roster. */
type KindHandle = (typeof kindHandles)[number]

/**
 * A predicate over the roster's one column, of at most one connective: a constant, the column equal to a handle, or the
 * negation, conjunction or disjunction of two of those.
 */
type Leaf =
	| { readonly kind: "constant"; readonly value: boolean }
	| { readonly kind: "equals"; readonly handle: KindHandle }

/** A predicate of at most one connective over the roster's column. */
type Pred =
	| Leaf
	| { readonly kind: "not"; readonly arg: Leaf }
	| { readonly kind: "and" | "or"; readonly left: Leaf; readonly right: Leaf }

/** Every leaf predicate: a constant, or the column equal to each handle. */
const leafGen: Gen<Leaf> = oneOf<Leaf>([
	(source) => ({ kind: "constant", value: source.draw(element([true, false])) }),
	(source) => ({ kind: "equals", handle: source.draw(element(kindHandles)) })
])

/** Every predicate of at most one connective over the leaves. */
export const predGen: Gen<Pred> = oneOf<Pred>([
	leafGen,
	(source) => ({ kind: "not", arg: source.draw(leafGen) }),
	(source) => ({
		kind: source.draw(element(["and", "or"] as const)),
		left: source.draw(leafGen),
		right: source.draw(leafGen)
	})
])

/** Whether the predicate holds of the row whose column is `handle`: its meaning, by hand. */
export const holdsOf = (p: Pred, handle: KindHandle): boolean => {
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
export const predExpr = (q: Q, source: RelNode, p: Pred): ScalarExpr => {
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

/** What the simplifier left of the roster under a predicate: all of it, part of it, or none. */
export type NarrowedFeature = "the whole roster kept" | "a narrowed roster" | "nothing kept"

/**
 * What a third occurrence of a region over the roster Kind and a task reads through a constant on its kind: nothing,
 * the task's kind, or the roster occurrence's own id, a lateral read of the closed source.
 */
export type LateralRead = "nothing" | "the task's kind" | "the roster's id"

/** A case: what the third occurrence reads, and whether the task binds its kind to the roster's id. */
export interface LateralCase {
	readonly read: LateralRead
	readonly bound: boolean
}
