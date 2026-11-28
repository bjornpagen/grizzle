/** What the properties of family-pick.test.ts read: its box, and its writes compiled over its law model in any order of
 * its families. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import type { Family } from "#compiler/ir/family.ts"
import { familyKey } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, mutable, on, relation, schema, tree, unit } from "#compiler/public/schema.ts"
import type { Binding, CountedFamily } from "#compiler/runtime/write/binding.ts"
import type { FillFamily, FillRelation } from "#compiler/runtime/write/fill.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** Doc(id, nodes drawn): the owner of a counted family of Node. */
const Doc = relation("Doc", { id: Id, nodes: drawn(natural) }, ["id"])

/** Shelf(id, nodes drawn): the owner of a second counted family of Node. */
const Shelf = relation("Shelf", { id: Id, nodes: drawn(natural) }, ["id"])

/** Node: a tree's node, keyed by its root and its pre-order start, and a member of Doc's and Shelf's counted families,
 * as edullm's Instance is its assembly's tree's node and a member of TestDocument.instances. */
const Node = relation(
	"Node",
	{
		root: Id,
		doc: Id,
		shelf: Id,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		label: pg.bigint
	},
	["root", "start"]
)

/** Node a member of three families: its tree, the sequence that nests its rows, and two counted ones, whose owners are
 * mutable so a tree may be inserted under stored ones, each owner under the unit of its id. */
const Picked = schema(
	"Picked",
	[Doc, Shelf, Node],
	[
		unit("Owner", { id: Id }),
		mutable(Doc),
		mutable(Shelf),
		counted(on(Node, "shelf"), fin(Shelf, "nodes")),
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["root"] }),
		counted(on(Node, "doc"), fin(Doc, "nodes"))
	]
)

const artifacts = succeeded(testArtifacts(Picked, testCompile))

/** The law model's families, in the order the model states them. */
export const stated: ReadonlyArray<Family> = artifacts.laws.families

/** Every order of the law model's families: each a permutation of them (gen.ts shuffled). */
const familyOrderGen: Gen<ReadonlyArray<Family>> = shuffled(stated, {
	min: stated.length,
	max: stated.length
})

/** The law model with its families, the theory's and its fill order's, in `order`, every other member as it stands: the
 * one input a write compiler reads them in an order from. */
const lawsInOrder = (order: ReadonlyArray<Family>): LawModel => {
	/** `families` in `order`, each the list's own. */
	const sorted = (families: ReadonlyArray<Family>): ReadonlyArray<Family> =>
		Arr.flatMap(order, (f) => Arr.filter(families, (g) => familyKey(g.id) === familyKey(f.id)))
	const laws = artifacts.laws
	return {
		...laws,
		families: sorted(laws.families),
		theory: {
			...laws.theory,
			families: sorted(laws.theory.families),
			fill: { ...laws.theory.fill, families: sorted(laws.theory.fill.families) }
		}
	}
}

/** A shape of ChangeSet over the box: a tree inserted alone, or beside the owners of both its counted families. */
const shapes = ["a tree alone", "a tree beside its counted owners"] as const
export type Shape = (typeof shapes)[number]

/** A ChangeSet of `shape`: one tree of a root and two children, under one Doc and one Shelf. The program depends on its
 * shape alone. */
const changeSetOf = (shape: Shape): unknown => {
	const doc = uuidOf(1)
	const shelf = uuidOf(2)
	const leaf = (label: bigint) => ({ doc, shelf, label, children: [] })
	const trees = ChangeSet.empty(Picked).insert(Node, [
		{ root: uuidOf(3), doc, shelf, label: 0n, children: [leaf(1n), leaf(2n)] }
	])
	switch (shape) {
		case "a tree alone":
			return trees
		case "a tree beside its counted owners":
			return trees.insert(Doc, [{ id: doc }]).insert(Shelf, [{ id: shelf }])
	}
}

/** A case: a shape of ChangeSet, and an order of the law model's families. */
export interface PickCase {
	readonly shape: Shape
	readonly order: ReadonlyArray<Family>
}

/** Every shape under every order of the families: 2 × 3! cases. */
export const pickCaseGen: Gen<PickCase> = (source) => ({
	shape: source.draw(element(shapes)),
	order: source.draw(familyOrderGen)
})

export type PickFeature =
	| Shape
	| "the tree stated after a counted family"
	| "the counted families in the other order"

/** Where the family `owner.count` stands in `order`, a permutation of the model's families. */
const placeIn = (order: ReadonlyArray<Family>, owner: string, count: string): number =>
	defined(
		Option.getOrUndefined(
			Arr.findFirstIndex(order, (f) => f.id.owner === owner && f.id.count === count)
		),
		`${owner}.${count} in the order`
	)

/** The situations a case reaches: its shape, and where its order moves the families: the tree after a counted family,
 * and Doc's and Shelf's counted families the other way round from the law model's own order. */
export const pickFeatures = (c: PickCase): ReadonlyArray<PickFeature> => {
	const docFirst = (order: ReadonlyArray<Family>): boolean =>
		placeIn(order, "Doc", "nodes") < placeIn(order, "Shelf", "nodes")
	const tree = placeIn(c.order, "Node", "children")
	return [
		c.shape,
		...(tree > Math.min(placeIn(c.order, "Doc", "nodes"), placeIn(c.order, "Shelf", "nodes"))
			? ["the tree stated after a counted family" as const]
			: []),
		...(docFirst(c.order) === docFirst(stated)
			? []
			: ["the counted families in the other order" as const])
	]
}

/** The write of `shape` compiled over the box's law model with its families in `order`, at SERIALIZABLE. */
export const compiledInOrder = (shape: Shape, order: ReadonlyArray<Family>): CompiledWrite =>
	succeeded(
		compileWrite(checking(Picked), descOf(changeSetOf(shape)), {
			...realityWrite(artifacts),
			laws: lawsInOrder(order)
		})
	)

/**
 * A binding as the write's meaning reads it: every member as it stands, but the lists the write meets families and
 * relations in, each stratum's fresh counted families (decide.ts freshStrata) and its fill's relations and families
 * (decide.ts hostFillOf), set in their keys' order, since the host meets them in the law model's order and nothing the
 * write does reads that order: its fresh groups are drawn and its rows filled by family and relation, by key.
 */
export const bindingInKeyOrder = (binding: Binding) => ({
	...binding,
	fresh: Arr.map(binding.fresh, (s) => ({
		...s,
		counted: Arr.sort(
			s.counted,
			Order.mapInput(Order.String, (f: CountedFamily) => familyKey(f.id))
		)
	})),
	fill: {
		...binding.fill,
		relations: Arr.sort(
			binding.fill.relations,
			Order.mapInput(Order.String, (r: FillRelation) => r.name)
		),
		families: Arr.sort(
			binding.fill.families,
			Order.mapInput(Order.String, (f: FillFamily) => familyKey(f.id))
		)
	}
})
