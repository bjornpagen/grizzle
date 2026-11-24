/**
 * A whole rule's region reads a row its relation gained only where no proof spares it (analysis/theory/unit.ts
 * proofsOf): a proved occurrence reads its gained rows only where they replace a row lost at the fields its witness
 * fixes the relation's rows at, a key's or a tree's root fields, and the rest read every gained row their conditions
 * admit. Each property draws a schema, a rule the judge holds whole, and a transition between two states its laws hold
 * in, and reads the region as the judge does, each of its rules over the transition's delta.
 *
 * Oracle: the rule itself. The reference evaluator (test/support/oracle/reference) reads the rule's violation query over
 * each document's rows after the transition, the state before it holding every law, so every document it finds broken
 * holds a fact the transition opened, which the judge must read: the region holds it. And the proofs are counted: the
 * region reads every gained row of exactly the occurrences the box says no proof spares (`wholeReads`), and on a
 * publish, which loses no row, a proved occurrence reads none. And each proof takes its occurrence's least-reading
 * witness whatever order the schema's containments stand in (`wholeRuleInOrder`).
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, type Kill, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	admitted,
	brokenDocs,
	chainTheory,
	chainTransitionGen,
	chainWholeReads,
	deltaRead,
	type Instance,
	isPublish,
	lawfulBut,
	lawfulTransition,
	type NodeBox,
	nodeBoxGen,
	nodeTheoryOf,
	nodeTransitionGen,
	type Nodes,
	orderReplacedFields,
	orderTheoryOf,
	permutationGen,
	readsReplaced,
	regionOf,
	regionReadsOf,
	regionRulesOf,
	type Shape,
	replacedFields,
	type Transition,
	wholeReads,
	wholeRuleInOrder,
	wholeRuleOf
} from "#test/unit/analysis/theory/region-proofs.fixtures.ts"
import type { TestTheory } from "#test/unit/analysis/theory/support.ts"

/**
 * The region of `t`'s whole rule over `transition`, its every broken document held to be among it, and its reads of
 * `relation`'s gained rows: the rules that read every one, and on a publish none read by a proved occurrence.
 */
const judged = (
	t: TestTheory,
	drawn: { readonly before: Instance; readonly after: Instance }
): {
	readonly transition: Transition
	readonly broken: ReadonlyArray<bigint>
	readonly whole: (relation: string) => number
	readonly replaced: (relation: string) => number
} => {
	const { law, rule } = wholeRuleOf(t)
	const transition = lawfulTransition(t, law, drawn.before, drawn.after)
	assert.equal(brokenDocs(t, law, transition.before).length, 0, "the state before breaks no rule")
	assert.ok(
		lawfulBut(t, law, transition.before) && lawfulBut(t, law, transition.after),
		`both states hold every other law: ${Formatter.format(transition)}`
	)
	const region = regionOf(rule, transition)
	const broken = brokenDocs(t, law, transition.after)
	for (const doc of broken) {
		assert.ok(
			Arr.contains(region, doc),
			`the transition breaks the rule in document ${doc}, which its region ${Formatter.format(region)} misses: ${Formatter.format(transition)}`
		)
	}
	const gained = (relation: string) =>
		Arr.filter(regionRulesOf(rule.judged), (r) => {
			const read = deltaRead(r)
			return read.relation === relation && read.side === "added"
		})
	const replaced = (relation: string): number =>
		Arr.reduce(
			Arr.filter(gained(relation), readsReplaced),
			0,
			(sum, r) => sum + admitted(r, transition).length
		)
	if (isPublish(transition)) {
		for (const relation of ["T", "Tag", "K", "F", "E", "N"]) {
			assert.equal(
				replaced(relation),
				0,
				`a publish's region reads no ${relation} row a proof spares`
			)
		}
	}
	return {
		transition,
		broken,
		whole: (relation) => Arr.filter(gained(relation), (r) => !readsReplaced(r)).length,
		replaced
	}
}

type NodeFeature =
	| "a parent proved by its child in a tree"
	| "a parent read whole in no tree"
	| "a child proved by its parent's tag in a tree"
	| "a node proved at its key by itself read again"
	| "a node proved by another of its kind in its tree"
	| "a node proved by tags whose selections together cover b"
	| "a node read whole beside a tag no containment its reading implies holds"
	| "a node proved by the kind its document lists"
	| "a document the transition breaks the rule in"
	| "a publish beside a document it keeps"
	| "a node read where it replaces one"

/** The situations a node box reaches by its schema alone. */
const nodeBoxFeatures = (box: NodeBox): ReadonlyArray<NodeFeature> => {
	const tree = box.nodes === "tree"
	switch (box.shape) {
		case "parent beside child":
			return [tree ? "a parent proved by its child in a tree" : "a parent read whole in no tree"]
		case "child beside its parent's tag":
			return tree ? ["a child proved by its parent's tag in a tree"] : []
		case "two nodes at one key":
			return tree ? [] : ["a node proved at its key by itself read again"]
		case "two nodes of one kind":
			return tree ? ["a node proved by another of its kind in its tree"] : []
		case "a tag beside its node":
			return box.tagged === "true and false"
				? ["a node proved by tags whose selections together cover b"]
				: box.tagged === "true"
					? ["a node read whole beside a tag no containment its reading implies holds"]
					: []
		case "a false tag beside its node":
			return box.tagged === "true"
				? ["a node read whole beside a tag no containment its reading implies holds"]
				: []
		case "a node beside its kind":
			return tree ? ["a node proved by the kind its document lists"] : []
	}
}

/** What every node property reaches beside its shapes' own situations. */
const transitions = [
	"a document the transition breaks the rule in",
	"a publish beside a document it keeps",
	"a node read where it replaces one"
] as const

/**
 * The node box's property over `shapes`: the region of each box's rule over each transition reads every document the
 * transition breaks the rule in, every gained node at the occurrences no proof spares (`wholeReads`), the lost nodes at
 * the fields each proof fixes T's rows at (`replacedFields`), and on a publish no node a proof spares.
 */
const nodeProperty = (
	shapes: Arr.NonEmptyReadonlyArray<Shape>,
	situations: ReadonlyArray<Reached<NodeFeature>>,
	kills: ReadonlyArray<Kill>
) =>
	property.explore(
		(s) => {
			const box = s.draw(nodeBoxGen(shapes))
			return { box, ...s.draw(nodeTransitionGen(box)) }
		},
		{
			needs: {},
			situations,
			check: (_, k: Case<NodeFeature>) => (drawn) =>
				Effect.sync(() => {
					const t = nodeTheoryOf(drawn.box)
					const read = judged(t, drawn)
					const replaced: ReadonlyArray<ReadonlyArray<string>> = Arr.flatMap(
						wholeRuleOf(t).rule.replaced,
						(r) => (r.relation === "T" ? [r.fields] : [])
					)
					assert.deepEqual(
						replaced,
						replacedFields(drawn.box),
						`the region reads the nodes lost at the fields each proof fixes T's rows at, in ${Formatter.format(drawn.box)}`
					)
					assert.equal(
						read.whole("T"),
						wholeReads(drawn.box),
						`the region reads every gained node at the occurrences no proof spares, in ${Formatter.format(drawn.box)}`
					)
					for (const feature of nodeBoxFeatures(drawn.box)) {
						k.note(feature)
					}
					if (read.broken.length > 0) {
						k.note("a document the transition breaks the rule in")
					}
					if (isPublish(read.transition) && (read.transition.before["T"] ?? []).length > 0) {
						k.note("a publish beside a document it keeps")
					}
					if (read.replaced("T") > 0) {
						k.note("a node read where it replaces one")
					}
				}),
			oracle: {
				kind: "universal",
				name: "the rule's violation query, as the reference evaluator reads it over each document's rows after a transition from a state every law holds in: every document it breaks the rule in is the region's; and the box's proofs, the occurrences each spares and the fields each fixes T's rows at"
			},
			kept: [],
			kills
		}
	)

/** A parent beside its child, and a child beside its parent's tag. Its budget is the runner's: a new property, with no
 * suite before it to carry a count from. */
export const aWholeRuleOverAParentAndItsChildReadsEveryDocumentATransitionBreaksItInAndEveryGainedNodeOnlyWhereNoProofSparesIt =
	nodeProperty(
		["parent beside child", "child beside its parent's tag"],
		[
			"a parent proved by its child in a tree",
			"a parent read whole in no tree",
			"a child proved by its parent's tag in a tree",
			...transitions
		],
		[
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\t: root?.every((f) => alike.includes(f)) === true\n\t\t\t\t? { by: "roots", fields: root }\n\t\t\t\t: undefined',
				replacement:
					'\t\t\t: alike.includes(n.primaryFields[0].name)\n\t\t\t\t? { by: "roots", fields: [n.primaryFields[0].name] }\n\t\t\t\t: undefined',
				why: "A relation's rows are taken as fixed at its key's leading field by any one of them standing, a tree's or not, so a plain T's parent is proved by its child in their document, and a parent gained under a child that stood before, which no tree law forbids a plain T, is never judged."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t: root?.every((f) => alike.includes(f)) === true",
				replacement: "\t\t\t: false && root?.every((f) => alike.includes(f)) === true",
				why: "No tree's root fixes its rows, so a child beside its parent's tag proves no node, and the region reads every gained node of kind 1."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: ".find((w) => !reaches(w.beside, at))",
				replacement: ".find(() => true)",
				why: "Two occurrences may each prove the other, so a parent and its child are both read only where they replace a node, and a child gained under a parent gained beside it is never judged."
			}
		]
	)

/** Two nodes at one key, and two nodes of one kind. Its budget is the runner's: a new property, with no suite before it to
 * carry a count from. */
export const aWholeRuleOverTwoNodesReadsEveryDocumentATransitionBreaksItInAndEveryGainedNodeOnlyWhereNoProofSparesIt =
	nodeProperty(
		["two nodes at one key", "two nodes of one kind"],
		[
			"a node proved at its key by itself read again",
			"a node proved by another of its kind in its tree",
			...transitions
		],
		[
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "[...(facts.into.get(n.name) ?? []), identity]",
				replacement: "(facts.into.get(n.name) ?? [])",
				why: "Two occurrences of a relation at one key do not witness each other, so a plain node read again at its key is read whole twice."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t: root?.every((f) => alike.includes(f)) === true",
				replacement: "\t\t\t: false && root?.every((f) => alike.includes(f)) === true",
				why: "No tree's root fixes its rows, so two nodes of one kind in a tree prove neither, and the region reads every gained node of each."
			}
		]
	)

/** A tag beside its node, and a tag of b false beside its node. Its budget is the runner's: a new property, with no suite
 * before it to carry a count from. */
export const aWholeRuleOverATagAndItsNodeReadsEveryDocumentATransitionBreaksItInAndEveryGainedNodeOnlyWhereNoProofSparesIt =
	nodeProperty(
		["a tag beside its node", "a false tag beside its node"],
		[
			"a node proved by tags whose selections together cover b",
			"a node read whole beside a tag no containment its reading implies holds",
			...transitions
		],
		[
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\treturn [...implied, ...united]\n",
				replacement: "\treturn [...implied]\n",
				why: "Containments of tags of b true and of b false together into T prove no node beside a tag of either b, which every tag's b makes one of them, so the region reads every gained node there."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: 't.carrier === "bool" ? [true, false]',
				replacement: 't.carrier === "bool" ? [true]',
				why: "A union of selections of b that lists true alone is taken to cover b, so the containment of tags of b true proves a node beside a tag of b false, which no node need stand at: a node gained at such a tag in a document of no nodes before is never judged."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\t\t\treturn bound?.field === within.field && among(bound.values, within.values)",
				replacement: "\t\t\treturn bound?.field === within.field",
				why: "A reading that bounds a selection's field anywhere is taken to imply the selection, so a tag read at b false is taken to be one the containment of tags of b true holds, and a node gained at it in a document of no nodes before is never judged."
			}
		]
	)

/** A node beside the kind its document lists. Its budget is the runner's: a new property, with no suite before it to carry
 * a count from. */
export const aWholeRuleOverANodeAndItsKindReadsEveryDocumentATransitionBreaksItInAndEveryGainedNodeOnlyWhereNoProofSparesIt =
	nodeProperty(
		["a node beside its kind"],
		["a node proved by the kind its document lists", ...transitions],
		[
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\t\t? { by: "roots", fields: root }\n\t\t\t\t: undefined',
				replacement: '\t\t\t\t? { by: "roots", fields: alike }\n\t\t\t\t: undefined',
				why: "A node proved through its tree's root is read only where a row of every field its witness binds alike was lost, its kind among them, where only a row of its document need be: a node whose kind is drawn anew to one K lists for another node of its document is never judged."
			}
		]
	)

type ChainFeature =
	| "N proved by E, itself proved by F"
	| "a document the transition breaks the rule in"
	| "a row read where it replaces one"

/**
 * A whole rule over a chain of keyed relations, F contained in E at E's key and E in N at N's key, reads every document
 * a transition breaks it in, and every gained row of F alone: E proves N, F proves E, and no composition proves N.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRuleOverAChainOfKeyedRelationsReadsEveryDocumentATransitionBreaksItInAndEveryGainedRowOfItsFirstAlone =
	property.explore(chainTransitionGen, {
		needs: {},
		situations: [
			"N proved by E, itself proved by F",
			"a document the transition breaks the rule in",
			"a row read where it replaces one"
		] satisfies ReadonlyArray<Reached<ChainFeature>>,
		check: (_, k: Case<ChainFeature>) => (drawn) =>
			Effect.sync(() => {
				const read = judged(chainTheory, drawn)
				for (const relation of ["F", "E", "N"]) {
					assert.equal(
						read.whole(relation),
						Arr.contains(chainWholeReads, relation) ? 1 : 0,
						`the region reads every gained row of ${relation} where no proof spares it`
					)
				}
				k.note("N proved by E, itself proved by F")
				if (read.broken.length > 0) {
					k.note("a document the transition breaks the rule in")
				}
				if (read.replaced("N") + read.replaced("E") > 0) {
					k.note("a row read where it replaces one")
				}
			}),
		oracle: {
			kind: "universal",
			name: "the rule's violation query, as the reference evaluator reads it over each document's rows after a transition from a state every law holds in: every document it breaks the rule in is the region's; and the chain's one occurrence no proof spares"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: ".find((w) => !reaches(w.beside, at))",
				replacement:
					".find((w) => !proved.has(w.beside) && ![...proved.values()].some((p) => p.beside === at))",
				why: "A witness itself proved proves nothing, so N, whose one witness E is proved by F, is read whole."
			}
		]
	})

/** A box of the order property: a node box, or the order box over T, a tree or plain (region-proofs.fixtures.ts
 * orderTheoryOf). */
type OrderedBox =
	| { readonly kind: "nodes"; readonly box: NodeBox }
	| { readonly kind: "order"; readonly nodes: Nodes }

type OrderFeature =
	| "a node box"
	| "a node proved at T's key beside a witness at its root"
	| "a node proved at its key in no tree"
	| "containments in another order"

const shapes: Arr.NonEmptyReadonlyArray<Shape> = [
	"parent beside child",
	"child beside its parent's tag",
	"two nodes at one key",
	"two nodes of one kind",
	"a tag beside its node",
	"a false tag beside its node",
	"a node beside its kind"
]

const orderedBoxGen: Gen<OrderedBox> = (s) =>
	s.draw(element(["nodes", "order"] as const)) === "nodes"
		? { kind: "nodes", box: s.draw(nodeBoxGen(shapes)) }
		: { kind: "order", nodes: s.draw(element(["tree", "plain"] as const)) }

/**
 * A whole rule's proofs are the same whatever order its schema's containments stand in (analysis/theory/unit.ts
 * witnessesOf, witnessOrder): over every node box and the order box, whose node has two witnesses beside its tag, at
 * T's key and, in a tree, at its root, the rule decided again over its containments in a drawn order reads the rows T
 * lost at the fields the box's least-reading witness fixes T's rows at, and its region reads as the theory's own does.
 * The containments come in the order the owned schema states its statements in, which no meaning fixes, so a proof
 * that took its first witness in that order read a tree's whole document where it could read one node.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRulesProofsAreItsLeastReadingWitnessesWhateverOrderItsSchemasContainmentsStandIn =
	property.explore(
		(s) => {
			const box = s.draw(orderedBoxGen)
			const t = box.kind === "nodes" ? nodeTheoryOf(box.box) : orderTheoryOf(box.nodes)
			return { box, order: s.draw(permutationGen(t.regionFacts.containments.length)) }
		},
		{
			needs: {},
			situations: [
				"a node box",
				"a node proved at T's key beside a witness at its root",
				"a node proved at its key in no tree",
				"containments in another order"
			] satisfies ReadonlyArray<Reached<OrderFeature>>,
			check: (_, k: Case<OrderFeature>) => (drawn) =>
				Effect.sync(() => {
					const t =
						drawn.box.kind === "nodes"
							? nodeTheoryOf(drawn.box.box)
							: orderTheoryOf(drawn.box.nodes)
					const own = wholeRuleOf(t).rule
					const ordered = wholeRuleInOrder(t, drawn.order)
					const fields: ReadonlyArray<ReadonlyArray<string>> = Arr.flatMap(ordered.replaced, (r) =>
						r.relation === "T" ? [r.fields] : []
					)
					assert.deepEqual(
						fields,
						drawn.box.kind === "nodes" ? replacedFields(drawn.box.box) : orderReplacedFields,
						`the rule over its containments in the order ${Formatter.format(drawn.order)} reads the nodes lost at the fields its least-reading witness fixes T's rows at, in ${Formatter.format(drawn.box)}`
					)
					assert.deepEqual(
						regionReadsOf(ordered),
						regionReadsOf(own),
						`the rule's region reads as the theory's own over its containments in the order ${Formatter.format(drawn.order)}, in ${Formatter.format(drawn.box)}`
					)
					if (drawn.box.kind === "nodes") {
						k.note("a node box")
					} else {
						k.note(
							drawn.box.nodes === "tree"
								? "a node proved at T's key beside a witness at its root"
								: "a node proved at its key in no tree"
						)
					}
					if (Arr.some(drawn.order, (at, i) => at !== i)) {
						k.note("containments in another order")
					}
				}),
			oracle: {
				kind: "specification",
				name: "the least-reading witness of each box's node, a key's before a root's, and the theory's own region, whatever order its containments stand in"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/unit.ts",
					original: "\t\t.toSorted(witnessOrder)\n",
					replacement: "",
					why: "Each node proved by its first witness in the order its containments stand in: in a tree, the order box's tag at its node's kind, stated or composed before its tag at its node's key, proves the node at its root, so the region reads every gained node of a document that lost one, where it read the one that replaced a node."
				},
				{
					file: "packages/engine/src/analysis/theory/unit.ts",
					original: "const fixedRank = { key: 0, roots: 1 } as const",
					replacement: "const fixedRank = { key: 1, roots: 0 } as const",
					why: "A root's witness taken before a key's: in a tree, the order box's node is proved at its document, doc, and two nodes at one key at doc, so the region reads every gained node of a document that lost one, where it read the one that replaced a node."
				}
			]
		}
	)
