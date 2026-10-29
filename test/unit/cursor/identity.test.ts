import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element, int, uniqueArray } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { Record } from "effect"
import {
	type CursorComparator,
	comparatorDigest,
	generationDigest,
	queryDigest
} from "#compiler/codec/cursor/identity.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type ExprTable, OpId } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { contractType } from "#compiler/scalar/registry.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { cursorCodecTypes } from "#test/unit/cursor/support.ts"

import { regex } from "arkregex"
/**
 * The identity a cursor is bound to: the sensitivity of the comparator, query and generation digests to exactly what
 * changes meaning.
 *
 * A contract's predicate in normal form, VALUE >= 0 over int8 (as test/unit/ir/scalar.test.ts builds it): the
 * comparator digest ignores a contract's predicate (ir/scalar.ts sameScalarType).
 */
const common = {
	args: [],
	nonNull: "strict",
	volatility: "immutable",
	failure: "total",
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
			op: OpId("int8ge"),
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
		nonNegative
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

/** The comparators with one rewritten at `at`, or undefined where the rewrite does not apply there. */
const rewritten = (
	cs: ReadonlyArray<CursorComparator>,
	at: number,
	rewrite: ComparatorRewrite
): ReadonlyArray<CursorComparator> | undefined => {
	const c = cs[at]
	if (c === undefined) {
		return undefined
	}
	const put = (next: CursorComparator) => cs.with(at, next)
	switch (rewrite) {
		case "a contract's predicate stated":
			return c.type === cursorCodecTypes.cents ? put({ ...c, type: centsWithPredicate }) : undefined
		case "a roster's handles":
			return c.type === cursorCodecTypes.kind ? put({ ...c, type: kindEvolved }) : undefined
		case "a regex refinement":
			return c.type === cursorCodecTypes.text
				? put({ ...c, type: cursorCodecTypes.title })
				: undefined
		case "a direction":
			return put({ ...c, direction: c.direction === "asc" ? "desc" : "asc" })
		case "a field name":
			return put({ ...c, field: `${c.field}_renamed` })
		case "two comparators swapped": {
			const next = cs[at + 1]
			if (
				next === undefined ||
				(next.field === c.field && next.direction === c.direction && next.type === c.type)
			) {
				return undefined
			}
			return cs.with(at, next).with(at + 1, c)
		}
	}
}

describe("the comparator digest", () => {
	it.effect("changes with exactly what changes an order's meaning, positionally", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cursor/comparator-digest",
					draw: drawn((source) => ({
						/** Each field once, as an order states it. */
						comparators: source.draw(
							uniqueArray(
								(source) => ({
									field: source.draw(element(["a", "b", "c", "d"])),
									direction: source.draw(element(["asc" as const, "desc" as const])),
									type: source.draw(element(comparatorPool))
								}),
								(c) => c.field,
								{ min: 1, max: 4 },
								20
							)
						),
						at: source.draw(int(0, 3)),
						rewrite: source.draw(element(comparatorRewrites))
					})),
					literal: Formatter.format,
					features: features<ComparatorRewrite>(comparatorRewrites),
					kept: [],
					/** Six rewrites over up to four comparators of six types: 600 cases reach every rewrite many times. */
					runs: 600,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				({ comparators, at, rewrite }, c) =>
					Effect.sync(() => {
						const next = rewritten(comparators, at, rewrite)
						if (next === undefined) {
							return
						}
						c.note(rewrite)
						const before = succeeded(comparatorDigest(comparators))
						const after = succeeded(comparatorDigest(next))
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
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/cursor/generation-digest",
							draw: drawn((source) => ({
								schema: source.draw(name),
								extensions: source.draw(
									uniqueArray(
										(source) =>
											[source.draw(name), source.draw(matching(regex("^\\d\\.\\d$")))] as const,
										([n]) => n,
										{ min: 2, max: 4 },
										20
									)
								),
								change: source.draw(
									element(["reordered" as const, "a version" as const, "the schema" as const])
								)
							})),
							literal: Formatter.format,
							features: features<"reordered" | "a version" | "the schema">([
								"reordered",
								"a version",
								"the schema"
							]),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
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
