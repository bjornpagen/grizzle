/**
 * References resolve across the document set as design 3.3 says. A chain of non-schema references of any length hops
 * between documents, each reference resolved against the base of the document holding it (a member's retrieval URI,
 * a 3.2 entry's `$self`), and ends at its target or at the first refusal: a relative file outside the set (REF-15), an
 * absolute URI outside it (REF-16), a pointer a member lacks (REF-18) or a hop already on the chain (DOC-23). A schema
 * cycle across two documents of any depth resolves, each target lifted under its canonical key. Every member's `$id`
 * and `$anchor` is indexed before a reference is judged (B10), and an `$id` declared twice is REF-14; implicit
 * connections resolve from the entry alone; and no two documents share a URI, by retrieval or by `$self`.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import type { CollisionFeature } from "#test/resolve/document-set.dictionary.ts"
import {
	aimedChains,
	aimedCycles,
	type ChainFeature,
	chainFeatures,
	chainResolved,
	collisionResolved,
	collisionSpace,
	type ConnectionFeature,
	connectionFeatures,
	connectionsResolved,
	connectionsSpace,
	type CycleFeature,
	cycleFeatures,
	cycleResolved,
	expectedChain,
	expectedCollision,
	expectedConnections,
	expectedCycle,
	expectedIndexed,
	type IndexedFeature,
	indexedFeatures,
	indexedResolved,
	indexedSpace
} from "#test/resolve/document-set.fixtures.ts"

/**
 * A chain from the entry's parameter use site ends where design 3.3 says. It replaces ten example cases, so its
 * rotating stream is ten drawn chains; its floor and steered phase reach each situation by an aimed one.
 */
export const documentChains = property.explore(aimedChains, {
	needs: {},
	situations: [
		"a set of one",
		"a chain across two members",
		"a chain past two hundred hops",
		"a local hop inside a member",
		"a relative hop inside a member away from the entry",
		"the entry's $self as its base",
		"a relative reference only the retrieval URI places in the set",
		"a missing target in a member",
		"a relative file outside the set",
		"an absolute URI outside the set",
		"a cycle across documents"
	] satisfies ReadonlyArray<Reached<ChainFeature>>,
	check: (_, c: Case<ChainFeature>) => (chain) =>
		Effect.gen(function* () {
			c.noteAll(chainFeatures(chain))
			const resolved = yield* chainResolved(chain)
			assert.deepEqual(resolved, expectedChain(chain))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.3: each reference against its holder's base, the chain to its target or its first refusal"
	},
	kept: [],
	budget: { runs: 10, steered: 33 },
	kills: [
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: 'remoteUri.test(site.ref) ? "REF-16/outside-set" : "REF-15/outside-set",',
			replacement: 'remoteUri.test(site.ref) ? "REF-15/outside-set" : "REF-16/outside-set",',
			why: "A relative file outside the set reads as a remote URI and a remote URI as a relative file; the property fails."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: ': relatedFailure("REF-18/unresolvable", keyAt(site), outcome.target)',
			replacement: ': failure("REF-18/unresolvable", keyAt(site))',
			why: "A missing target no longer names the member and pointer it is missing from; the property fails."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: 'return relatedFailure("DOC-23/non-schema-cycle", siteKey, hop)',
			replacement: 'return failure("DOC-23/non-schema-cycle", siteKey)',
			why: "A cycle no longer names the hop that closes it; the property fails."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "const outcome = this.lookup(ref, member.base, false, member.line)",
			replacement: "const outcome = this.lookup(ref, site.member.base, false, member.line)",
			why: "Every hop resolves against the use site's document, not the document holding it, so a relative hop inside a member away from the entry lands outside the set; the property fails."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "this.settle(site, hop, via, docs)",
			replacement: "this.settle(site, hop, [], docs)",
			why: "A chain's Reference Objects between its use site and its target are dropped from via; the property fails."
		}
	]
})

/**
 * A schema cycle across two documents resolves, every schema it reaches lifted under its canonical key. It replaces one
 * example case of 2000 levels; its rotating stream is four drawn cycles, a fifth of them a thousand levels or more.
 */
export const schemaCycles = property.explore(aimedCycles, {
	needs: {},
	situations: [
		"one level",
		"an even cycle",
		"an odd cycle",
		"a thousand levels or more"
	] satisfies ReadonlyArray<Reached<CycleFeature>>,
	check: (_, c: Case<CycleFeature>) => (cycle) =>
		Effect.gen(function* () {
			c.noteAll(cycleFeatures(cycle))
			const resolved = yield* cycleResolved(cycle)
			assert.deepEqual(resolved, expectedCycle(cycle))
		}),
	oracle: {
		kind: "specification",
		name: "design 2.2 and 3.3: a schema reference is one hop, its target lifted under its canonical key"
	},
	kept: [],
	budget: { runs: 4, steered: 12 },
	kills: [
		{
			file: "packages/cli-generator/src/resolve/canonical.ts",
			original: "\tif (key.document !== entry) {\n\t\treturn keyOf(key)\n\t}\n",
			replacement: "",
			why: "A target in a member is lifted under its pointer alone, so two members' targets share a key; the property fails."
		}
	]
})

/**
 * A reference to an `$id` or `$anchor` only an unreached member declares resolves, and one declared twice is refused.
 * It replaces four example cases; the exhaustion proves it over every declaration, line and home.
 */
export const idsIndexedFirst = property.exhaust(indexedSpace, {
	needs: {},
	box: "every declaration an unreached member makes (a fragment's $id, an OpenAPI document's component $id, an $anchor under its root $id) on 3.1 and 3.2, beside the entry or its $self, with the entry declaring the $id again or not",
	situations: [
		"a fragment's $id",
		"an OpenAPI document's component $id",
		"an $anchor under its root $id",
		"an $id the entry declares again"
	] satisfies ReadonlyArray<Reached<IndexedFeature>>,
	check: (_, c: Case<IndexedFeature>) => (indexed) =>
		Effect.gen(function* () {
			c.noteAll(indexedFeatures(indexed))
			const resolved = yield* indexedResolved(indexed)
			assert.deepEqual(resolved, expectedIndexed(indexed))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.3 B10: every member's $id and $anchor indexed before any reference is judged"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original:
				"\t\tconst indexed = this.index()\n\t\tif (indexed !== undefined) {\n\t\t\treturn indexed\n\t\t}\n",
			replacement: "",
			why: "Members are indexed only where references reach them, so an $id an unreached member declares is outside the set and a duplicate is never seen; the property fails."
		}
	]
})

/**
 * Implicit connections resolve from the entry alone: a member's security scheme is not found by name and a member's
 * operationId is not recorded. It replaces two example cases; the exhaustion proves it over every line and home.
 */
export const entryOnlyConnections = property.exhaust(connectionsSpace, {
	needs: {},
	box: "every line, beside the entry or its $self, with the entry holding the scheme and an operation of its own or not",
	situations: [
		"a scheme a member alone holds",
		"a scheme the entry holds too",
		"an operationId a member alone holds",
		"an operationId of the entry's own"
	] satisfies ReadonlyArray<Reached<ConnectionFeature>>,
	check: (_, c: Case<ConnectionFeature>) => (connections) =>
		Effect.gen(function* () {
			c.noteAll(connectionFeatures(connections))
			const connected = yield* connectionsResolved(connections)
			assert.deepEqual(connected, expectedConnections(connections))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.3: implicit connections resolve from the entry document only"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original:
				"\t\tif (place.member !== this.entry) {\n\t\t\treturn\n\t\t}\n\n\t\tconst operationId",
			replacement: "\t\tconst operationId",
			why: "Every document's operations are recorded, so an operationId a member alone holds is found; the property fails."
		}
	]
})

/**
 * A 3.2 member whose `$self` names a document of the set is refused where the repeated URI registers. It replaces one
 * example case; the exhaustion proves it over each document the `$self` may name.
 */
export const selfCollisions = property.exhaust(collisionSpace, {
	needs: {},
	box: "a 3.2 member's $self naming the entry, a member before it or a member after it, beside the entry or its $self",
	situations: ["the entry", "a member before it", "a member after it"] satisfies ReadonlyArray<
		Reached<CollisionFeature>
	>,
	check: (_, c: Case<CollisionFeature>) => (collision) =>
		Effect.gen(function* () {
			c.note(collision.named)
			const resolved = yield* collisionResolved(collision)
			assert.deepEqual(resolved, expectedCollision(collision))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.3: no two documents of a set share a URI, by retrieval or by $self"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: 'pointer: resource === retrieval ? "" : "/$self"',
			replacement: 'pointer: resource === retrieval ? "/$self" : ""',
			why: "A repeated URI is stated at the wrong place, a $self's at the member's root and a retrieval URI's at its $self; the property fails."
		}
	]
})
