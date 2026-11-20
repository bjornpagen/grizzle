/**
 * The share planning keys only the nodes its decisions read (lower/shapes/share/statements.ts planStatementShares,
 * ShareIndex.shape, ir/dag.ts nodeShapes): a node's shape is a function of exactly what its share key encodes, so two
 * nodes of one key are of one shape, and a node whose shape no other node the statements read has has a key no other
 * node has, which no decision compares; such a node is classed by itself, by identity, and undigested. The nodes of a
 * shape several share are classed by their keys, digested, and a class's key is digested where a decision reads it: the
 * highest class enough statements read, against the others of its height. The planning decides what it decided with
 * every node keyed (referenceShares, the planning at db1a7e895).
 *
 * The box, drawn: one to six statements over a work queue's pick, each reading the one shared pick or a copy of its
 * own, so equal sub-queries are shared nodes and unshared copies alike, each statement bounding its reads under a name
 * of its own; and two to six statements all reading the one shared pick.
 *
 * Properties: the carried shares, each its key, its node and its copies, are the reference's, and every two nodes the
 * statements read of one key are of one shape; and over statements that all read one shared pick, the digests the
 * planning takes do not grow with the statements, where the reference digests every node they read. Kills: a shape
 * that reads a node's label, which no key encodes, so equal copies are classed apart; and every node digested.
 *
 * Features: shares carried and none; a copy among the statements and none.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import { planStatementShares, ShareIndex } from "#compiler/lower/shapes/share/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	programOf,
	referenceShares,
	sharedCountGen,
	sketchGen
} from "#test/unit/lower/shapes/share-elision.fixtures.ts"

type Situation = "carried" | "none carried" | "a copy" | "no copy"

/** The share planning keys only the nodes its decisions read, and decides what it decided with every node keyed. */
export const theSharePlanningKeysOnlyTheNodesItsDecisionsReadAndDecidesWhatItDecidedWithEveryNodeKeyed =
	property.explore(sketchGen, {
		needs: {},
		situations: ["carried", "none carried", "a copy", "no copy"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (sketch) =>
			Effect.sync(() => {
				const p = programOf(sketch)
				const shares = succeeded(planStatementShares(new ShareIndex(p.dag), p.roots))
				const reference = referenceShares(new ShareIndex(p.dag), p.dag, p.roots)
				assert.deepEqual(
					Arr.map(shares, (s) => ({
						key: s.key,
						node: s.node.id,
						copies: Arr.map(s.copies, (n) => n.id)
					})),
					Arr.map(reference, (s) => ({
						key: s.key,
						node: s.node.id,
						copies: Arr.map(s.copies, (n) => n.id)
					})),
					"the carried shares are the reference's"
				)
				const index = new ShareIndex(p.dag)
				const keyed = Arr.flatMap(topoOrder(p.dag), (n) =>
					index.eligible(n) ? [{ node: n, key: succeeded(shareKey(p.dag, n)) }] : []
				)
				for (const a of keyed) {
					for (const b of keyed) {
						if (a.key === b.key) {
							assert.equal(
								index.shape(a.node),
								index.shape(b.node),
								"nodes of one key are of one shape"
							)
						}
					}
				}
				c.note(shares.length > 0 ? "carried" : "none carried")
				c.note(
					Arr.some(sketch.shared, (s) => !s) && sketch.shared.length > 1 ? "a copy" : "no copy"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the share planning with every node keyed by its digest (referenceShares, db1a7e895)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: `\t\tlet text = \`\${node.kind}\\u0000\${node.heading`,
				replacement: `\t\tlet text = \`\${node.id}\${node.kind}\\u0000\${node.heading`,
				why: "A shape reads the node's label, which no share key encodes, so two equal copies are of two shapes, each classed by itself: the copies a carried share holds are fewer than the reference's, and the search fails."
			}
		]
	})

/** Over statements that all read one shared sub-query, the share planning's digests do not grow with the statements. */
export const overStatementsThatAllReadOneSharedSubQueryTheSharePlanningsDigestsDoNotGrowWithTheStatements =
	property.explore(sharedCountGen, {
		needs: {},
		situations: [],
		check: () => (statements) =>
			Effect.sync(() => {
				const digestsAt = (n: number): number => {
					const p = programOf({ shared: Array.from({ length: n }, () => true) })
					const index = new ShareIndex(p.dag)
					succeeded(planStatementShares(index, p.roots))
					return index.digested
				}
				assert.equal(
					digestsAt(statements),
					digestsAt(2),
					`the digests over ${statements} statements are those over 2`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the digests a decision reads, the same for every count of readers"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\tif (same.length === 1) {\n",
				replacement: "\t\tif (same.length === 0) {\n",
				why: "Every node the statements read is digested, its shape shared or not, so each statement's own bound sub-query is digested and the digests grow with the statements: the search fails."
			}
		]
	})
