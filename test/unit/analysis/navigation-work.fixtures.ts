/** What the properties of navigation-work.test.ts read: their space, the chains of unions, and the work counted. */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { Navigation, navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { buildTheory } from "#compiler/analysis/theory/theory.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { descIdentity, type InferredQuery } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/input.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { checking } from "#test/support/policy.ts"

/** The depths of the box, one to sixteen levels: where navigation distributed a chain sixteen deep in 28 s (GENMEM). */
const depths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const

/**
 * One case: a chain of unions `depth` deep over Node, each level two rules, the nodes of kind 0 and of any other kind,
 * each reading the level below `reads` times, as judge-size.fixtures.ts union1 and twiceUnion1 do at every level; read
 * whole, as a whole rule's check over every row reads it (RegionExtent `every`), or at one document, a parameter, as the
 * judge reads a whole rule's violation at its units' channels (RegionExtent `units`).
 */
export interface Chain {
	readonly reads: 1 | 2
	readonly read: "whole" | "at a document"
	readonly depth: (typeof depths)[number]
}

export const chainGen: Gen<Chain> = (s) => ({
	reads: s.draw(element<Chain["reads"]>([1, 2])),
	read: s.draw(element<Chain["read"]>(["whole", "at a document"])),
	depth: s.draw(element(depths))
})

export type Reached =
	| "a level reading the one below once"
	| "a level reading the one below twice"
	| "a chain read whole"
	| "a chain read at a document"
	| "a chain sixteen deep"

const Node = relation("Node", { doc: int4, start: int4, parent: int4, kind: int4 }, [
	"doc",
	"start"
])
const Base = schema("navigation_work", [Node], [])

/** The leaf, each node with its parent and kind under its own names. */
const leaf = query(Base).rule((r) => {
	const { doc, start, parent, kind } = v(Node, "n")
	return r.match(Node, { doc, start, parent, kind }).find({ doc, a: start, b: parent, k: kind })
})

/** A level over the leaf whose rules read it once each, at the row's own `a`. */
const once = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(leaf, "x0")
		return r.match(leaf, { doc, a, b, k: 0 }).find({ doc, a, b, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(leaf, "x0")
		return r.match(leaf, { doc, a, b, k }).where(r.ne(k, 0)).find({ doc, a, b, k })
	})

/** A level over the leaf whose rules read it twice each, at the row's own `a` and at the first read's `b`. */
const twice = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(leaf, "x0")
		const { b: b1 } = v(leaf, "x1")
		return r
			.match(leaf, { doc, a, b, k: 0 })
			.match(leaf, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(leaf, "x0")
		const { b: b1 } = v(leaf, "x1")
		return r
			.match(leaf, { doc, a, b, k })
			.match(leaf, { doc, a: b, b: b1 })
			.where(r.ne(k, 0))
			.find({ doc, a, b: b1, k })
	})

/** A read of a level over the leaf at one document, a parameter. */
const atDocument = query(Base).rule((r) => {
	const { a, b, k } = v(once, "t")
	return r.match(once, { doc: r.param("doc", int4), a, b, k }).find({ a, b, k })
})

/** The Description of a public query. */
const descOf = (q: unknown): InferredQuery => succeeded(queryInput(q)).desc

/**
 * `level`, a query over one import, with `below` in its place: every match of its rules imports `below`. A level of the
 * chain is the one level over the leaf with the level below it imported in the leaf's place, each of its rules reading
 * one object, as a Description shares the queries it imports by reference.
 */
const over = (level: InferredQuery, below: InferredQuery): InferredQuery => {
	const stage = level.stage
	if (stage.kind !== "rules") {
		return assert.fail("a level of rules")
	}
	return {
		...level,
		stage: {
			...stage,
			arms: mapNonEmpty(stage.arms, (arm) => ({
				...arm,
				matches: Arr.map(arm.matches, (m) =>
					m.source.kind === "query" ? { ...m, source: { ...m.source, query: below } } : m
				)
			}))
		}
	}
}

/** The query case `c` reads at `depth`: its chain that deep, read whole or at one document. */
const readAt = (c: Chain, depth: number): InferredQuery => {
	const level = descOf(c.reads === 1 ? once : twice)
	let chain = descOf(leaf)
	for (let at = 0; at < depth; at++) {
		chain = over(level, chain)
	}
	return c.read === "whole" ? chain : over(descOf(atDocument), chain)
}

const loc = SourceLoc("navigation work", [])

/** The columns of each query the chains import, over Base. */
const columns = queryColumns(checking(Base), loc)

/** The containments Base's theory holds, which order a chain (analysis/theory/navigate.ts Navigation `within`). */
const facts = succeeded(buildTheory(checking(Base))).regionFacts

/** Every function of navigation's module, whose calls are its work (analysis/theory/navigate.ts). */
const isNavigation = (file: string): boolean => Str.endsWith("analysis/theory/navigate.ts")(file)

/** The calls of navigation's functions navigating case `c`'s read at `depth`: its work, counted, never timed. */
const navigationWork = (c: Chain, depth: number): Effect.Effect<number> =>
	Effect.map(
		everyCallCount(
			Effect.sync(() =>
				navigateQuery(
					readAt(c, depth),
					loc,
					columns,
					{ kind: "perStatement", extent: c.read === "whole" ? "every" : "units" },
					new Navigation(facts)
				)
			),
			isNavigation
		),
		([, counts]) => Arr.reduce([...counts.values()], 0, (sum, n) => sum + n)
	)

/** The identity digests' modules (core/fingerprint.ts), whose calls are the work of digesting what navigation reads. */
const isDigesting = (file: string): boolean => Str.endsWith("core/fingerprint.ts")(file)

/**
 * The calls of the identity digests' functions navigating case `c`'s read at `depth`: the digesting of every identity
 * and import key navigation asks of what it reads, counted, never timed. The declared queries the chain is made of are
 * digested before the count begins, as a compile's are before its navigation reads them (ir/desc.ts descIdentities, one
 * for the process, which keeps each frozen part's identity whatever read it first), and the navigation reads columns of
 * its own, whose checks ask the identity of each query they import once for their session (check/session.ts
 * ResolvedImports), so the count is navigation's own digesting whatever case ran before it.
 */
const digestWork = (c: Chain, depth: number): Effect.Effect<number> =>
	Effect.gen(function* () {
		yield* Effect.sync(() => succeeded(descIdentity(readAt(c, depth))))
		const own = queryColumns(checking(Base), loc)
		const [, counts] = yield* everyCallCount(
			Effect.sync(() =>
				navigateQuery(
					readAt(c, depth),
					loc,
					own,
					{ kind: "perStatement", extent: c.read === "whole" ? "every" : "units" },
					new Navigation(facts)
				)
			),
			isDigesting
		)
		return Arr.reduce([...counts.values()], 0, (sum, n) => sum + n)
	})

/**
 * Judges case `c`'s digesting: navigating its chain `depth` deep digests what its chain two deep does and, for each level
 * more, what the third level added to the second, each level's frozen parts digested once for every identity and import
 * key of it; where each identity and key digested its query anew, every level digested the whole chain below it again.
 */
export const digestedChain = (c: Chain, note: (r: Reached) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		note(
			c.reads === 1 ? "a level reading the one below once" : "a level reading the one below twice"
		)
		note(c.read === "whole" ? "a chain read whole" : "a chain read at a document")
		if (c.depth === 16) {
			note("a chain sixteen deep")
		}
		const two = yield* digestWork(c, 2)
		const three = yield* digestWork(c, 3)
		assert.ok(three > two, "a level more digests more")
		const work = yield* digestWork(c, c.depth)
		if (c.depth >= 2) {
			assert.equal(
				work,
				two + (c.depth - 2) * (three - two),
				`navigating the chain ${c.depth} deep, each level reading the one below ${c.reads === 1 ? "once" : "twice"}, ${c.read}, digests what two levels and ${c.depth - 2} levels more of what the third added do`
			)
		}
	})

/**
 * Judges case `c`: navigating its chain `depth` deep works what its chain two deep does and, for each level more, what
 * the third level added to the second, every level over a union below it navigated alike, once for each set of values
 * its rules read it at (the first, over the leaf, reads no union); where navigation distributed the rules over the
 * unions below them, read the unions' rules again at every read of them, or navigated a level again at every read of
 * it, a level was worked once for every path down to it, and each level doubled the work below it.
 */
export const judgedChain = (c: Chain, note: (r: Reached) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		note(
			c.reads === 1 ? "a level reading the one below once" : "a level reading the one below twice"
		)
		note(c.read === "whole" ? "a chain read whole" : "a chain read at a document")
		if (c.depth === 16) {
			note("a chain sixteen deep")
		}
		const two = yield* navigationWork(c, 2)
		const three = yield* navigationWork(c, 3)
		assert.ok(three > two, "a level more is more work")
		const work = yield* navigationWork(c, c.depth)
		if (c.depth >= 2) {
			assert.equal(
				work,
				two + (c.depth - 2) * (three - two),
				`navigating the chain ${c.depth} deep, each level reading the one below ${c.reads === 1 ? "once" : "twice"}, ${c.read}, works what two levels and ${c.depth - 2} levels more of what the third added do`
			)
		}
	})
