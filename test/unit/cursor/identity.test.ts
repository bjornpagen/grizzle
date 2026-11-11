import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled, string, codePoint } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { Record } from "effect"
import {
	type CursorComparator,
	comparatorDigest,
	generationDigest,
	queryDigest
} from "#compiler/codec/cursor/identity.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { contractType } from "#compiler/scalar/registry.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { cursorCodecTypes } from "#test/unit/cursor/support.ts"

import { regex } from "arkregex"
import { directions, opposite } from "#compiler/core/order.ts"
import { definedOpOf } from "#test/support/oracle/gen/ops.ts"
/**
 * The identity a cursor is bound to: the sensitivity of the comparator, query and generation digests to exactly what
 * changes meaning.
 *
 * A contract's predicate in normal form, VALUE >= 0 over int8 (as test/unit/ir/scalar.test.ts builds it): the
 * comparator digest ignores a contract's predicate (ir/scalar.ts sameScalarType).
 *
 * Oracles: specifications. The comparator digest changes with exactly what changes an order's meaning, a contract's
 * predicate excepted; the query and generation digests separate their domains and depend on every component, an
 * extension's order excepted. Each case is constructed where its rewrite applies: the rewrite first, then comparators
 * of distinct fields whose rewritten one holds the type the rewrite changes, so no case is skipped; extension names are
 * distinct by construction, each its drawn stem and its own place.
 *
 * Features: each comparator rewrite; each change of a generation.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): cursor-digest-direction-blind, a comparator digest that omits each
 * comparator's direction; cursor-generation-ordered, a generation digest over its extensions in their given order.
 */
const common = {
	args: [],
	nonNull: "strict",
	volatility: "immutable",
	deps: { params: [], nodes: [] }
} as const
const [e0, e1, e2] = [ExprId("e#0"), ExprId("e#1"), ExprId("e#2")]
const nonNegative: ExprTable = {
	root: e0,
	exprs: {
		[e0]: {
			id: e0,
			...common,
			kind: "op",
			op: definedOpOf("int8ge"),
			args: [e1, e2],
			type: cursorCodecTypes.bool
		},
		[e1]: { id: e1, ...common, kind: "value", type: cursorCodecTypes.int8, nonNull: "storage" },
		[e2]: {
			id: e2,
			...common,
			kind: "literal",
			value: { kind: "int", value: 0n },
			type: cursorCodecTypes.int8,
			nonNull: "literal"
		}
	}
}

const centsWithPredicate = succeeded(
	contractType(
		parsedName("Cents"),
		cursorCodecTypes.int8,
		SourceLoc("the contract Cents", []),
		nonNegative,
		[]
	)
)

const kindEvolved = scalarOf(f.closedId("Kind"), {
	Kind: ["Manual", "Semi", "Automatic", "Ünïcode"]
})

const comparatorPool: Arr.NonEmptyReadonlyArray<ScalarType> = [
	cursorCodecTypes.int4,
	cursorCodecTypes.uuid,
	cursorCodecTypes.text,
	cursorCodecTypes.kind,
	cursorCodecTypes.cents,
	cursorCodecTypes.float8
]

/** A rewrite of one comparator: one the digest identifies, or one that changes the order's meaning. */
type ComparatorRewrite =
	| "a contract's predicate stated"
	| "a roster's handles"
	| "a regex refinement"
	| "a direction"
	| "a field name"
	| "two comparators swapped"

const comparatorRewrites: Arr.NonEmptyReadonlyArray<ComparatorRewrite> = [
	"a contract's predicate stated",
	"a roster's handles",
	"a regex refinement",
	"a direction",
	"a field name",
	"two comparators swapped"
]

/** The types a comparator a rewrite changes may hold: the one type it rewrites, or any of the pool. */
const rewrittenTypes: { readonly [R in ComparatorRewrite]: Arr.NonEmptyReadonlyArray<ScalarType> } =
	{
		"a contract's predicate stated": [cursorCodecTypes.cents],
		"a roster's handles": [cursorCodecTypes.kind],
		"a regex refinement": [cursorCodecTypes.text],
		"a direction": comparatorPool,
		"a field name": comparatorPool,
		"two comparators swapped": comparatorPool
	}

/** How many comparators a rewrite reads from its place: two for a swap, one otherwise. */
const reads = (rewrite: ComparatorRewrite): 1 | 2 => (rewrite === "two comparators swapped" ? 2 : 1)

/** A case: comparators of distinct fields, each as an order states it, and one rewrite at a place where it applies. */
interface DigestCase {
	readonly comparators: ReadonlyArray<CursorComparator>
	readonly at: number
	readonly rewrite: ComparatorRewrite
}

/**
 * The rewrite first, then the comparators: each field once, as many as the rewrite reads at least, and the one at its
 * place of a type the rewrite changes.
 */
const digestCaseGen: Gen<DigestCase> = (source) => {
	const rewrite = source.draw(element(comparatorRewrites))
	const fields = source.draw(shuffled(["a", "b", "c", "d"], { min: reads(rewrite), max: 4 }))
	const at = source.draw(int(0, fields.length - reads(rewrite)))
	const comparators = Arr.map(fields, (field, i) => ({
		field,
		direction: source.draw(element(directions)),
		type: source.draw(element(i === at ? rewrittenTypes[rewrite] : comparatorPool))
	}))
	return { comparators, at, rewrite }
}

/** The comparators with the one at `at` rewritten, where the case's construction makes the rewrite apply. */
const rewritten = ({
	comparators: cs,
	at,
	rewrite
}: DigestCase): ReadonlyArray<CursorComparator> => {
	const c = defined(cs[at], "the rewritten comparator")
	const put = (next: CursorComparator) => cs.with(at, next)
	switch (rewrite) {
		case "a contract's predicate stated":
			return put({ ...c, type: centsWithPredicate })
		case "a roster's handles":
			return put({ ...c, type: kindEvolved })
		case "a regex refinement":
			return put({ ...c, type: cursorCodecTypes.title })
		case "a direction":
			return put({ ...c, direction: opposite(c.direction) })
		case "a field name":
			return put({ ...c, field: `${c.field}_renamed` })
		case "two comparators swapped":
			return cs.with(at, defined(cs[at + 1], "the comparator after it")).with(at + 1, c)
	}
}

describe("the comparator digest", () => {
	it.effect("changes with exactly what changes an order's meaning, positionally", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the comparator digest changes with exactly what changes an order's meaning, a contract's predicate excepted"
					},
					suite: "unit/cursor/comparator-digest",
					draw: drawn(digestCaseGen),
					literal: Formatter.format,
					coverage: required<ComparatorRewrite>(comparatorRewrites, {
						cases: 600,
						sense: notesOnly
					}),
					kept: [],
					/** The rotating stream's sample of six rewrites over up to four comparators of six types. */
					runs: 600,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(digestCase, c) =>
					Effect.sync(() => {
						const { comparators, rewrite } = digestCase
						c.note(rewrite)
						const before = succeeded(comparatorDigest(comparators))
						const after = succeeded(comparatorDigest(rewritten(digestCase)))
						if (rewrite === "a contract's predicate stated") {
							assert.equal(after, before, rewrite)
						} else {
							assert.notEqual(after, before, rewrite)
						}
					})
			)
		)
	)
})

describe("the query and generation digests", () => {
	it.effect(
		"separate their domains and depend on every component, an extension's order excepted",
		(ctx) =>
			Effect.gen(function* () {
				const name = matching(regex("^[a-z]{1,6}$"))
				/** An extension name's stem, which its place in the list completes, so no two names are one. */
				const stem = string(codePoint(0x61, 0x7a), { min: 0, max: 5 })
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "the query and generation digests separate their domains and depend on every component, an extension's order excepted"
							},
							suite: "unit/cursor/generation-digest",
							draw: drawn((source) => ({
								schema: source.draw(name),
								extensions: Arr.map(
									source.draw(
										array(
											(source) =>
												[source.draw(stem), source.draw(matching(regex("^\\d\\.\\d$")))] as const,
											{ min: 2, max: 4 }
										)
									),
									([s, version], i) => [`${s}${String(i)}`, version] as const
								),
								change: source.draw(
									element(["reordered" as const, "a version" as const, "the schema" as const])
								)
							})),
							literal: Formatter.format,
							coverage: required<"reordered" | "a version" | "the schema">(
								["reordered", "a version", "the schema"],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ schema, extensions, change }, c) =>
							Effect.sync(() => {
								c.note(change)
								const g = succeeded(
									generationDigest({ schema, extensions: Record.fromEntries(extensions) })
								)
								assert.notEqual(
									succeeded(queryDigest(schema)),
									g,
									"a query and a generation of one text"
								)
								const [head, ...rest] = extensions
								const [first, version] = defined(head, "an extension")
								const other =
									change === "reordered"
										? { schema, extensions: Record.fromEntries(Arr.reverse([...extensions])) }
										: change === "a version"
											? {
													schema,
													extensions: Record.fromEntries([[first, `${version}.1`], ...rest])
												}
											: { schema: `${schema}x`, extensions: Record.fromEntries(extensions) }
								const h = succeeded(generationDigest(other))
								if (change === "reordered") {
									assert.equal(h, g, "extension order is not identity")
								} else {
									assert.notEqual(h, g, change)
								}
							})
					)
				)
			})
	)
})
