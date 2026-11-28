/**
 * A whole rule's region reads a row its relation gained only where no proof spares it (analysis/theory/unit.ts
 * proofsOf): a proved occurrence of a closed relation reads none of its gained rows, a row it gains opening a fact only
 * beside a witness's row the write gained, and the rest read every gained row their conditions admit. Each property
 * draws a schema of closed relations, a rule the judge holds whole, and a transition a served write makes between two
 * states its laws hold in, every row kept and rows added at new keys alone (physical/ddl/immutable.ts), and reads the
 * region as the judge does, each of its rules over the transition's delta.
 *
 * Oracle: the rule itself. The reference evaluator (test/support/oracle/reference) reads the rule's violation query over
 * each document's rows after the transition, the state before it holding every law, so every document it finds broken
 * holds a fact the transition opened, which the judge must read: the region holds it. And the proofs are counted: the
 * region reads the gained rows of exactly the occurrences the box says no proof spares (`wholeReads`). And the region's
 * work is linear in its occurrences: a rule that reads an import of many rules again and again makes each of the region's rules once,
 * its calls growing no faster than linearly in the import's rules however often it is read (`readsTheoryOf`).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, type Kill, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import type { TestTheory } from "#test/support/unit/analysis/theory/support.ts"
import {
	brokenDocs,
	chainTheory,
	chainTransitionGen,
	chainWholeReads,
	deltaRead,
	type Instance,
	lawfulBut,
	lawfulTransition,
	type NodeBox,
	nodeBoxGen,
	nodeTheoryOf,
	nodeTransitionGen,
	provesAnOccurrence,
	readsTheoryOf,
	regionOf,
	regionRulesOf,
	type Shape,
	type Transition,
	wholeReads,
	wholeRuleOf,
	wholeRuleOver,
	withUnrelated
} from "#test/unit/analysis/theory/region-proofs.fixtures.ts"

/**
 * The region of `t`'s whole rule over `transition`, its every broken document held to be among it, and its rules over
 * `relation`'s gained rows.
 */
const judged = (
	t: TestTheory,
	drawn: { readonly before: Instance; readonly after: Instance }
): {
	readonly transition: Transition
	readonly broken: ReadonlyArray<bigint>
	readonly whole: (relation: string) => number
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
	return {
		transition,
		broken,
		whole: (relation) =>
			Arr.filter(regionRulesOf(rule.judged), (r) => {
				const read = deltaRead(r)
				return read.relation === relation && read.side === "added"
			}).length
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
	"a publish beside a document it keeps"
] as const

/**
 * The node box's property over `shapes`: the region of each box's rule over each transition reads every document the
 * transition breaks the rule in, and every gained node at the occurrences no proof spares (`wholeReads`), none at a
 * proved one.
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
					if ((read.transition.before["T"] ?? []).length > 0) {
						k.note("a publish beside a document it keeps")
					}
				}),
			oracle: {
				kind: "universal",
				name: "the rule's violation query, as the reference evaluator reads it over each document's rows after a served write's transition from a state every law holds in: every document it breaks the rule in is the region's; and the box's proofs, the occurrences each spares"
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
				original: "[...containmentsInto(facts, n.name), identity]",
				replacement: "containmentsInto(facts, n.name)",
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
				replacement: "\t\t\t\t? undefined\n\t\t\t\t: undefined",
				why: "No node is proved through its tree's root: a node beside the kind its document lists reads every node its relation gains, which the kind's own occurrence already puts in the region."
			}
		]
	)

type ChainFeature =
	| "N proved by E, itself proved by F"
	| "a document the transition breaks the rule in"

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
			"a document the transition breaks the rule in"
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

/** Every function of the region's module (analysis/theory/unit.ts), whose calls are a region's work. */
const isRegionModule = (file: string): boolean => Str.endsWith("analysis/theory/unit.ts")(file)

/** What a reads box reaches: its import read once, or again. */
type RegionReads = "an import read once" | "an import read again"

/** What a node box's region reaches of the counted work: a proof's witnesses read, and none. */
type RegionWork = "an occurrence proved" | "no occurrence proved"

/**
 * A whole rule's region reads the containments into its occurrences' relations alone: decided over its theory's region
 * facts and over those facts with one to sixty-four containments more among relations it reads none of
 * (region-proofs.fixtures.ts withUnrelated), its region is the same and the calls of the region's module, counted (kernel/calls.ts
 * everyCallCount), are the same, where each occurrence's proof scanned every containment of the facts, its work growing
 * with them, O(occurrences × containments) over a theory (5,171,760 tests over edullm's QTI schema's 2,612 occurrences).
 * Each facts value's index is made before the count begins, as a theory's is by its first region (unit.ts
 * containmentsInto). Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRulesRegionDoesTheSameWorkHoweverManyContainmentsTheFactsHoldAmongRelationsItReadsNoneOf =
	property.explore(
		(s) => ({
			box: s.draw(
				nodeBoxGen([
					"parent beside child",
					"child beside its parent's tag",
					"two nodes at one key",
					"two nodes of one kind",
					"a tag beside its node",
					"a false tag beside its node",
					"a node beside its kind"
				])
			),
			unrelated: s.draw(int(1, 64))
		}),
		{
			needs: {},
			situations: ["an occurrence proved", "no occurrence proved"] satisfies ReadonlyArray<
				Reached<RegionWork>
			>,
			check:
				(_, c: Case<RegionWork>) =>
				({ box, unrelated }) =>
					Effect.gen(function* () {
						const t = nodeTheoryOf(box)
						const work = (facts: typeof t.regionFacts) =>
							Effect.gen(function* () {
								wholeRuleOver(t, facts)
								const [rule, counts] = yield* everyCallCount(
									Effect.sync(() => wholeRuleOver(t, facts)),
									isRegionModule
								)
								return { rule, calls: Arr.reduce([...counts.values()], 0, (n, k) => n + k) }
							})
						const own = yield* work(t.regionFacts)
						const more = yield* work(withUnrelated(t.regionFacts, unrelated))
						const { definitionOf: _own, ...ownRegion } = own.rule
						const { definitionOf: _more, ...moreRegion } = more.rule
						assert.ok(
							canonicalEquals(ownRegion, moreRegion),
							"the region over facts with unrelated containments is the region over the theory's own"
						)
						assert.equal(
							more.calls,
							own.calls,
							`the region's work over ${unrelated} unrelated containments more is its work over the theory's own`
						)
						c.note(provesAnOccurrence(box) ? "an occurrence proved" : "no occurrence proved")
					}),
			oracle: {
				kind: "specification",
				name: "the region's module's calls, counted (kernel/calls.ts everyCallCount), and the region itself, alike over facts with containments it reads none of"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/unit.ts",
					original: "[...containmentsInto(facts, n.name), identity]",
					replacement: "[...facts.containments.filter((c) => c.to === n.name), identity]",
					why: "Each occurrence's proof scans every containment of the facts for those into its relation, as it did before the index: its work grows with every containment among relations the rule reads none of, and the property fails."
				}
			]
		}
	)

/**
 * A whole rule's region makes each of its rules once in work linear in its occurrences: over a rule reading an import of
 * `kinds` rules `reads` times, its region holds a rule for each kind and the node's own, each once, and the region
 * module's calls grow no faster than linearly in `kinds` (growth.ts incrementsDoNotGrow, at 2h, 4h and 6h kinds),
 * however many times each kind's occurrence stands in it.
 */
export const aWholeRulesRegionMakesEachRuleOnceInWorkLinearInItsOccurrencesHoweverOftenItsImportIsRead =
	property.exhaust(
		finite((s) => ({
			nodes: s.draw(element(["tree", "plain"] as const)),
			half: s.draw(int(1, 3)),
			reads: s.draw(int(1, 3))
		})),
		{
			needs: {},
			box: "each kind of nodes, at 2h, 4h and 6h kinds for h from 1 to 3, read one to three times",
			situations: ["an import read once", "an import read again"] satisfies ReadonlyArray<
				Reached<RegionReads>
			>,
			check:
				(_, c: Case<RegionReads>) =>
				({ nodes, half, reads }) =>
					Effect.gen(function* () {
						const calls = new Map<number, number>()
						for (const kinds of [2 * half, 4 * half, 6 * half]) {
							const t = readsTheoryOf(nodes, kinds, reads)
							const { rule } = wholeRuleOf(t)
							assert.equal(
								regionRulesOf(rule.judged).length,
								kinds + 1,
								`the region of ${reads} reads of ${kinds} rules holds a rule for each kind and the node's own, each once`
							)
							wholeRuleOver(t, t.regionFacts)
							const [, counts] = yield* everyCallCount(
								Effect.sync(() => wholeRuleOver(t, t.regionFacts)),
								isRegionModule
							)
							calls.set(
								kinds,
								Arr.reduce([...counts.values()], 0, (n, k) => n + k)
							)
						}
						incrementsDoNotGrow(
							(kinds) => defined(calls.get(kinds), "the calls of a size counted"),
							half,
							`the region's calls over ${reads} reads of an import of its kinds' rules`
						)
						c.note(reads === 1 ? "an import read once" : "an import read again")
					}),
			oracle: {
				kind: "specification",
				name: "the region's rules, each once, and its module's calls (kernel/calls.ts everyCallCount), growing no faster than linearly (growth.ts incrementsDoNotGrow)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/unit.ts",
					original: "\t\t\trules.push(rule)\n",
					replacement:
						"\t\t\tif (!rules.some((held) => canonicalEquals(held, rule))) {\n\t\t\t\trules.push(rule)\n\t\t\t}\n",
					why: "Each rule made is compared with every rule held, O(o · r): the region's calls grow with the square of its rules, and the growth law fails."
				},
				{
					file: "packages/engine/src/analysis/theory/unit.ts",
					original: "\t\t\tif (made.has(identity)) {",
					replacement: "\t\t\tif ([...made].some((held) => sameOrder(held, identity))) {",
					why: "Each occurrence is compared with every rule made before it, O(o · r): the region's calls grow with the square of its rules, and the growth law fails."
				}
			]
		}
	)
