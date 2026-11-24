/** What the properties of unit-recursion.test.ts read: the schemas of the box, and the verdict each states. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { CompileError } from "#compiler/core/errors.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"

/**
 * A document's nodes, each with its parent's place, keyed by its document first; a link from a node to a node of any
 * document; a document's claim of a node it reaches. The document is the unit every rule over a walk is judged in.
 */
const Node = relation("Node", { doc: pg.integer, start: pg.integer, parent: pg.integer }, [
	"doc",
	"start"
])
const Link = relation(
	"Link",
	{ doc: pg.integer, start: pg.integer, toDoc: pg.integer, toStart: pg.integer },
	["doc", "start"]
)
const Claim = relation("Claim", { doc: pg.integer, start: pg.integer }, ["doc", "start"])

/**
 * Where the walk's step reaches its next node:
 *
 * - `child`: a child of the node in its document, which carries the unit;
 * - `link`: the node a link of it names, in the document the link names, which leaves it;
 * - `other document`: a node of another document at the same place, which leaves it;
 * - `a fixed document`: a child whose document the step states as a literal, which leaves it;
 * - `derived child`: the child through a materialized derived relation of the node's parent links within its document,
 *   which carries it;
 * - `derived link`: the node through a materialized derived relation of the links, which leaves it. A rule reads either
 *   through its definition, live, never its view, inside the recursion as anywhere (analysis/theory/query.ts
 *   liveQuery), so its definition's matches are judged for the unit like the step's own.
 */
export type Step =
	| "child"
	| "link"
	| "other document"
	| "a fixed document"
	| "derived child"
	| "derived link"

const steps = [
	"child",
	"link",
	"other document",
	"a fixed document",
	"derived child",
	"derived link"
] as const satisfies ReadonlyArray<Step>

/** What the walk starts from: every root of a document, at its document, or at a document the base states. */
export type Seed = "roots" | "a fixed document"

/**
 * The rule over the walk: a claim of a reached node (a containment into it); the parent of each claimed node reached (a
 * containment into it of a join of Claim and Node, whose every-row check reads its side as a chain and the walk, which
 * imports the recursion, as the chain's condition as written: analysis/theory/navigate.ts Navigator #chain
 * `asWritten`); a check over it; or a key over it.
 */
export type Law = "contained" | "parent contained" | "check" | "key"

/**
 * Whether every relation the walk reads is immutable, or Node is mutable: in the unit of its document, every relation's
 * key leading with it, so every write of their rows borrows the document the walk stays in; or in the unit of a node's
 * place, (doc, start), every relation's whole key, which no borrow of one place covers a walk of the document by.
 */
export type Mutability = "immutable" | "Node mutable in its document" | "Node mutable in its place"

export interface WalkCase {
	readonly seed: Seed
	readonly step: Step
	readonly law: Law
	readonly mutability: Mutability
}

export const walkCase: Gen<WalkCase> = (s) => ({
	seed: s.draw(element<Seed>(["roots", "a fixed document"])),
	step: s.draw(element(steps)),
	law: s.draw(element<Law>(["contained", "parent contained", "check", "key"])),
	mutability: s.draw(
		element<Mutability>(["immutable", "Node mutable in its document", "Node mutable in its place"])
	)
})

/**
 * The rule (analysis/theory/unit.ts unitLocalRecursion, wholeRule): a rule over a recursion is judged whole, and so
 * compiles, exactly when every relation it reads is immutable or all of them sit in one declared unit no wider than the
 * walk's, the document, the base delivers its unit from a stored relation's leading key field, and every step carries
 * it from self through every match into its head, a derived relation a step reads read through its definition; it is
 * refused otherwise, since no probe reads a recursion.
 */
export const localWalk = (c: WalkCase): boolean =>
	c.mutability !== "Node mutable in its place" &&
	c.seed === "roots" &&
	(c.step === "child" || c.step === "derived child")

const Base = (mutability: Mutability) =>
	schema(
		"UnitWalk",
		[Node, Link, Claim],
		mutability === "Node mutable in its document"
			? [unit("Document", { doc: pg.integer }), mutable(Node)]
			: mutability === "Node mutable in its place"
				? [unit("Place", { doc: pg.integer, start: pg.integer }), mutable(Node)]
				: []
	)

/** The case's schema: the derived relations its step reads, the walk, and the rule over it. */
export const walkSchemaOf = (c: WalkCase) => {
	const B = Base(c.mutability)
	const Within = derived.materialized(
		"Within",
		query(B).rule((r) => {
			const n = v(Node, "n")
			return r
				.match(Node, { doc: n.doc, start: n.start, parent: n.parent })
				.find({ doc: n.doc, from: n.parent, to: n.start })
		})
	)
	const Across = derived.materialized(
		"Across",
		query(B).rule((r) => {
			const l = v(Link, "l")
			return r
				.match(Link, { doc: l.doc, start: l.start, toDoc: l.toDoc, toStart: l.toStart })
				.find({ doc: l.doc, from: l.start, toDoc: l.toDoc, to: l.toStart })
		})
	)
	const Edges = schema.extend([B], "UnitWalkEdges", [Within, Across], [])
	const row = { doc: pg.integer, node: pg.integer }
	type Walk = SelfSource<typeof row>
	const stepOf = (r: Rule<typeof Edges>, self: Walk) => {
		const s = v(self, "s")
		const n = v(Node, "n")
		const l = v(Link, "l")
		const w = v(Within, "w")
		const a = v(Across, "a")
		const fed = r.match(self, { doc: s.doc, node: s.node })
		switch (c.step) {
			case "child":
				return fed
					.match(Node, { doc: s.doc, parent: s.node, start: n.start })
					.find({ doc: s.doc, node: n.start })
			case "link":
				return fed
					.match(Link, { doc: s.doc, start: s.node, toDoc: l.toDoc, toStart: l.toStart })
					.find({ doc: l.toDoc, node: l.toStart })
			case "other document":
				return fed
					.match(Node, { doc: n.doc, start: s.node, parent: n.parent })
					.where(r.ne(n.doc, s.doc))
					.find({ doc: n.doc, node: n.start })
			case "a fixed document":
				return fed
					.match(Node, { doc: s.doc, parent: s.node, start: n.start })
					.find({ doc: 1, node: n.start })
			case "derived child":
				return fed
					.match(Within, { doc: s.doc, from: s.node, to: w.to })
					.find({ doc: s.doc, node: w.to })
			case "derived link":
				return fed
					.match(Across, { doc: s.doc, from: s.node, toDoc: a.toDoc, to: a.to })
					.find({ doc: a.toDoc, node: a.to })
		}
	}
	const walk = query(Edges).recursive("Walk", {
		row,
		base: [
			(r) => {
				const n = v(Node, "n")
				return r
					.match(Node, { doc: n.doc, start: n.start, parent: n.start })
					.find({ doc: c.seed === "roots" ? n.doc : 1, node: n.start })
			}
		],
		rec: [stepOf]
	})
	const Reached = derived("Reached", walk)
	const ClaimedParent = derived(
		"ClaimedParent",
		query(Edges).rule((r) => {
			const cl = v(Claim, "claim")
			const n = v(Node, "n")
			return r
				.match(Claim, { doc: cl.doc, start: cl.start })
				.match(Node, { doc: cl.doc, start: cl.start, parent: n.parent })
				.find({ doc: cl.doc, node: n.parent })
		})
	)
	const law =
		c.law === "contained"
			? contained(on(Claim, "doc", "start"), on(Reached, "doc", "node"))
			: c.law === "parent contained"
				? contained(on(ClaimedParent, "doc", "node"), on(Reached, "doc", "node"))
				: c.law === "check"
					? check("Positive", Reached, (x) => x.ge(x.node, 0))
					: key(on(Reached, "doc"))
	return schema.extend([Edges], "UnitWalkTop", [Reached, ClaimedParent], [law])
}

/** How a case's compile ended: compiled, or refused for a reason named by its tag (and refusal). */
export type Ended = "compiled" | `refused ${string}`

export const endedOf = (
	r: { readonly ok: true } | { readonly ok: false; readonly error: CompileError }
): Ended =>
	r.ok
		? "compiled"
		: `refused ${r.error.reason._tag === "Refused" ? `Refused: ${r.error.reason.refusal}` : r.error.reason._tag}`

/** The refusal a rule over a recursion that is not unit-local meets: no probe reads a recursion. */
export const notLocalRefusal: Ended =
	"refused Refused: a rule reads a recursion only where it is unit-local: every relation it reads immutable or all of them in one declared unit, every match of it within one unit, and every step carrying the unit from self into its head"
