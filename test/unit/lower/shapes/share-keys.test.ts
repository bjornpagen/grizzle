/**
 * Share keys digested from blocks (ir/dag-digest.ts ShareKeys, lower/shapes/share/statements.ts ShareIndex): a node's
 * key is SHA-256 of its block, what it reaches without entering a sealed node, each sealed node an entry its own key
 * fills, so keys are worked out children first, each block once, and the share planning keys every node it reads by
 * them alone.
 *
 * - Classes: the planning carries what the planning keyed by each node's whole reach carried (referenceShares), each
 *   share's node and copies; where a key is coarser than the whole reach's digest it is so only over a sealed node
 *   read twice against two built alike, and a name a block holds of a node a sealed node declares is read by the block,
 *   so two folds keyed by two occurrences of one region are of two keys, as their digests are.
 * - Order: the classes a round ties are decided by their least key, so the carried shares, each its key and copies, do
 *   not depend on the order the members stand in.
 * - Work: keying every node of a DAG digests each block once, its units within the DAG's whole table and a bounded
 *   entry for each node and edge, where a digest of every node's whole reach wrote each level again for every level
 *   above it.
 *
 * Oracles: the planning keyed by whole-reach digests (a second implementation); the digests of the whole reach and the
 * statement of the coarsening (a specification); the DAG's whole table (a specification of the bound).
 *
 * Features: shares carried and none, a copy among the statements and none; the lesser and the greater key read first;
 * a sealed node read twice and two built alike; one occurrence and two.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { edgesOf } from "#compiler/ir/rel.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import {
	type CarriedShare,
	noneHeld,
	planStatementShares,
	ShareIndex
} from "#compiler/lower/shapes/share/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { byCodePoints } from "#test/support/key-order.ts"
import { tableUnits } from "#test/support/unit/ir/dag-digest.fixtures.ts"
import { placedPlain, present } from "#test/support/unit/lower/support.ts"
import {
	attachedBelowItsParent,
	depthGen,
	foldsByOccurrence,
	levels,
	memberOrderGen,
	occurrencePairGen,
	programOf,
	referenceShares,
	sameParameterGen,
	sketchGen,
	twiceAndCopies,
	twoClasses
} from "#test/unit/lower/shapes/share-keys.fixtures.ts"

type Planned = "carried" | "none carried" | "a copy" | "no copy"

/** The share planning keyed by blocks carries what the planning keyed by each node's whole reach carried. */
export const theSharePlanningKeyedByBlocksCarriesWhatThePlanningKeyedByEachNodesWholeReachCarried =
	property.explore(sketchGen, {
		needs: {},
		situations: ["carried", "none carried", "a copy", "no copy"] satisfies ReadonlyArray<
			Reached<Planned>
		>,
		check: (_, c: Case<Planned>) => (sketch) =>
			Effect.sync(() => {
				const p = programOf(sketch)
				const shares = succeeded(
					planStatementShares(
						new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain),
						p.roots,
						noneHeld,
						{
							kind: "never"
						}
					)
				)
				const reference = referenceShares(
					new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain),
					p.dag,
					p.roots
				)
				const view = (
					all: ReadonlyArray<{
						readonly node: { readonly id: string }
						readonly copies: ReadonlyArray<{ readonly id: string }>
					}>
				) => Arr.map(all, (s) => ({ node: s.node.id, copies: Arr.map(s.copies, (n) => n.id) }))
				assert.deepEqual(view(shares), view(reference), "the carried shares are the reference's")
				c.note(shares.length > 0 ? "carried" : "none carried")
				c.note(
					Arr.some(sketch.shared, (s) => !s) && sketch.shared.length > 1 ? "a copy" : "no copy"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the share planning with every node keyed by the digest of its whole reach (referenceShares)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original:
					'\t\t\t\tout.ascii(defined(this.#keys.get(entry.node), "a sealed node\'s key, worked out first"))\n',
				replacement: "\t\t\t\tout.ascii(entry.node.id)\n",
				why: "A sealed node's entry names its label, not its key, so two copies built alike are of two keys: the copies a carried share holds are fewer than the reference's, and the search fails."
			}
		]
	})

type Ordered = "the lesser key read first" | "the greater key read first"

/** The carried shares do not depend on the order the members stand in: a round's tied classes go by their least key. */
export const theCarriedSharesDoNotDependOnTheOrderTheMembersStandIn = property.explore(
	memberOrderGen,
	{
		needs: {},
		situations: ["the lesser key read first", "the greater key read first"] satisfies ReadonlyArray<
			Reached<Ordered>
		>,
		check: (_, c: Case<Ordered>) => (order) =>
			Effect.sync(() => {
				const p = twoClasses()
				const view = (all: ReadonlyArray<CarriedShare>) =>
					Arr.map(all, (s) => ({
						key: s.key,
						copies: Arr.sort(
							Arr.map(s.copies, (n) => n.id),
							byCodePoints
						)
					}))
				const inOrder = succeeded(
					planStatementShares(
						new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain),
						p.roots,
						noneHeld,
						{
							kind: "never"
						}
					)
				)
				const permuted = succeeded(
					planStatementShares(
						new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain),
						Arr.map(order, (i) => present(p.roots[i], "a statement")),
						noneHeld,
						{ kind: "never" }
					)
				)
				assert.equal(inOrder.length, 2, "both classes carried")
				assert.deepEqual(
					view(permuted),
					view(inOrder),
					`the shares in the order ${Formatter.format(order)}`
				)
				/** Statements 0 and 1 read the class over `a`, 2 and 3 the one over `b`. */
				const classOf = (statement: number): "a" | "b" => (statement < 2 ? "a" : "b")
				const lesser = present(inOrder[0], "the share of the least key")
				const copyOfA = present(edgesOf(present(p.roots[0], "statement 0"))[0], "its copy")
				const lesserClass = lesser.copies.includes(copyOfA) ? "a" : "b"
				c.note(
					lesserClass === classOf(present(order[0], "the first member"))
						? "the lesser key read first"
						: "the greater key read first"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the carried shares of one program, each its key and copies, whatever the order of its members"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\tconst winner = keyed.reduce((a, b) => (b.key < a.key ? b : a))\n",
				replacement: "\t\t\tconst winner = keyed.reduce((a) => a)\n",
				why: "A round carries the tied class the members read first, not the least key: the order of the carried shares follows the members', and the search fails."
			}
		]
	}
)

type Coarsened = "one key over two digests" | "two keys"

/**
 * A union reading one sealed node twice and one reading two built alike are of one key and two whole-reach digests: the
 * one way a key is coarser than the digest; over two parameters they are of two keys.
 */
export const aSealedNodeReadTwiceAndTwoBuiltAlikeAreOfOneKeyTheOneWayAKeyIsCoarserThanTheWholeReachsDigest =
	property.exhaust(sameParameterGen, {
		needs: {},
		situations: ["one key over two digests", "two keys"] satisfies ReadonlyArray<
			Reached<Coarsened>
		>,
		check: (_, c: Case<Coarsened>) => (same) =>
			Effect.sync(() => {
				const p = twiceAndCopies(same)
				const index = new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain)
				assert.notEqual(
					succeeded(shareKey(p.dag, p.twice, new DagTemplates("derivation"))),
					succeeded(shareKey(p.dag, p.copies, new DagTemplates("derivation"))),
					"one node read twice and two copies are of two whole-reach digests"
				)
				assert.equal(
					index.key(p.twice) === index.key(p.copies),
					same,
					"one key exactly over one parameter"
				)
				c.note(same ? "one key over two digests" : "two keys")
			}),
		oracle: {
			kind: "specification",
			name: "a key coarser than the whole reach's digest only over a sealed node read twice against two built alike"
		},
		box: "two unions of two projections of one account's first task: one task read twice, and two copies over one or two parameters",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\tconst block = new BlockNumbering(root, () => labels.of(), this.#sealed)\n",
				replacement: "\t\tconst block = new BlockNumbering(root, () => labels.of(), () => false)\n",
				why: "No node is sealed, so every key is its whole reach's digest again: a task read twice and two copies are of two keys, and the search fails."
			}
		]
	})

type Attached = "carried" | "two keys"

/**
 * Two statements reading copies of a bound of an attachment whose child reads a node of its parent's delivered rows
 * below the parent, a sealed node of the bound's block, carry them as one exactly when they are over one parameter:
 * the block names that node by its place under the parent, a name a copy built alike gives it too.
 */
export const anAttachmentsChildReadingBelowItsSealedParentNamesItsPlaceSoCopiesBuiltAlikeAreCarriedAsOne =
	property.exhaust(sameParameterGen, {
		needs: {},
		situations: ["carried", "two keys"] satisfies ReadonlyArray<Reached<Attached>>,
		check: (_, c: Case<Attached>) => (same) =>
			Effect.sync(() => {
				const p = attachedBelowItsParent(same)
				const index = new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain)
				const shares = succeeded(planStatementShares(index, p.roots, noneHeld, { kind: "never" }))
				const [first, second] = p.copies
				assert.equal(
					index.key(first) === index.key(second),
					same,
					"the copies are of one key exactly over one parameter"
				)
				assert.equal(shares.length > 0, same, "a share carried exactly over one parameter")
				c.note(same ? "carried" : "two keys")
			}),
		oracle: {
			kind: "specification",
			name: "two copies of one sub-query, an attachment's child reading below its parent, of one key exactly over one parameter"
		},
		box: "two statements bounding an attachment of a filter of one account's tasks, its child correlated to the filter's region, over one parameter or two",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\treturn place === undefined\n",
				replacement: "\t\treturn true\n",
				why: "A node under a sealed node is named by its label, not its place there, so two copies built alike name two labels: they are of two keys, and nothing is carried."
			}
		]
	})

type Folded = "one occurrence" | "two occurrences"

/** Two folds of one region keyed by its occurrences are of one key exactly when they read by one occurrence, as their whole-reach digests are. */
export const twoFoldsOfOneRegionAreOfOneKeyExactlyWhenTheyReadByOneOccurrence = property.exhaust(
	occurrencePairGen,
	{
		needs: {},
		situations: ["one occurrence", "two occurrences"] satisfies ReadonlyArray<Reached<Folded>>,
		check:
			(_, c: Case<Folded>) =>
			([first, second]) =>
				Effect.sync(() => {
					const p = foldsByOccurrence(first, second)
					const [a, b] = p.folds
					const index = new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain)
					assert.equal(
						succeeded(shareKey(p.dag, a, new DagTemplates("derivation"))) ===
							succeeded(shareKey(p.dag, b, new DagTemplates("derivation"))),
						first === second,
						"the whole-reach digests"
					)
					assert.equal(index.key(a) === index.key(b), first === second, "the keys")
					c.note(first === second ? "one occurrence" : "two occurrences")
				}),
		oracle: {
			kind: "specification",
			name: "two folds of one region of one key exactly when they read by one of its occurrences, as their digests"
		},
		box: "two folds of one region of two tasks, each keyed by its first or its second occurrence",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\t\t\t\tdeclared.has(naming.id)\n",
				replacement: "\t\t\t\t\ttrue\n",
				why: "A block names an occurrence its sealed region declares by a name of its own, not by its place in the region: two folds keyed by two occurrences are of one key, and the search fails."
			}
		]
	}
)

/**
 * Keying every node of a DAG digests each block once, and the units digested are within the DAG's whole table and a
 * bounded entry for each node and edge: linear in the distinct nodes, where a digest of each node's whole reach writes
 * each level again for every level above it.
 *
 * Its bound is the DAG's own table: each node's and expression's template once, beside a block's frame and a sealed
 * node's entry, a name and a key, for each node and each edge.
 */
export const keyingEveryNodeOfADagDigestsEachBlockOnceInUnitsLinearInItsDistinctNodes =
	property.explore(depthGen, {
		needs: {},
		situations: [],
		check: () => (depth) =>
			Effect.sync(() => {
				const dag = levels(depth)
				const nodes = topoOrder(dag)
				const edges = Arr.reduce(nodes, 0, (n, node) => n + edgesOf(node).length)
				const index = new ShareIndex(dag, new DagTemplates("derivation"), placedPlain)
				for (const node of nodes) {
					index.key(node)
				}
				const whole = succeeded(tableUnits(dag, dag.roots, "followed"))
				assert.ok(
					index.work.blocks <= nodes.length,
					`${index.work.blocks} blocks over ${nodes.length} nodes`
				)
				assert.ok(
					index.work.units <= whole + entryUnits * (nodes.length + edges),
					`${index.work.units} units over ${depth} levels, ${nodes.length} nodes and ${edges} edges, the whole table ${whole}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the DAG's whole table and a block's frame and a sealed node's entry for each node and edge"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\tconst block = new BlockNumbering(root, () => labels.of(), this.#sealed)\n",
				replacement: "\t\tconst block = new BlockNumbering(root, () => labels.of(), () => false)\n",
				why: "No node is sealed, so every key re-numbers and re-writes its node's whole reach: the units digested grow with the levels squared, past the bound."
			}
		]
	})

/**
 * The most units a block's frame or a sealed node's entry adds: a frame's braces and its root, or an entry's comma,
 * name and quoted key of 64 hex digits.
 *
 * @limitKind derived
 * @owner grizzle
 * @unit UTF-16 code units
 * @scope the work property's bound
 * @derivation an entry `,"n#<i>":"<64 hex>"` is 72 units at four digits of number; a frame `{"exprs":{` `},"nodes":{`
 *   `},"roots":["n#0"]}` is 41; 128 holds either with room for wider numbers
 */
const entryUnits = 128
