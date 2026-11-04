import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, element, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { PageRequestRefused, type RequestFault } from "#adapter/errors/failures.ts"
import { type PageRequestValue, pageRequest } from "#adapter/page/request.ts"
import { CursorError } from "#compiler/core/errors.ts"
import { pageMaxSize } from "#compiler/core/policy.ts"
import { assert } from "#test/support/assert.ts"

/** A page request refused for `fault`, as a read reports it. */
const requestRefused = (fault: RequestFault): ReadFailure =>
	ReadFailure.make({ reason: PageRequestRefused.make({ fault }) })

/**
 * Page request validation (packages/grizzle/src/adapter/page/request.ts).
 *
 * The accepted shapes are exactly { first }, { first, after }, { last } and { last, before }: mixed directions, both
 * anchors, an anchor of the other direction, a missing size and any other property are refused as
 * a ReadFailure whose reason is PageRequestRefused (stage request), and so is a size that is not a safe integer from 1 to pageMaxSize; an explicitly
 * supplied null or undefined cursor, or any non-string, is CursorError `cursorType`, checked after the shape; an omitted
 * control property is genuinely absent, so an inherited one is no anchor. The rule is restated here as the oracle, and
 * requests are drawn over every property's presence, own or inherited, every size and cursor kind, and a drawn
 * pageMaxSize.
 */

type Control = "first" | "last" | "after" | "before"
const controls: ReadonlyArray<Control> = ["first", "last", "after", "before"]

/** A property's presence: absent, own, or inherited from the prototype. */
type Presence = "absent" | "own" | "inherited"

const sizeGen = (max: number): Gen<unknown> =>
	weighted([
		[4, int(1, max)],
		[
			2,
			element<unknown>([
				0,
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				max + 1,
				2 ** 53,
				1n,
				"3",
				null,
				undefined
			])
		]
	])

const cursorGen: Gen<unknown> = weighted([
	[4, string(codePoint(0x20, 0x7e), { min: 0, max: 6 })],
	[1, element<unknown>([null, undefined, 1, {}, ["AQ"], new Object("AQ")])]
])

interface RequestCase {
	readonly pageMaxSize: number
	readonly presence: { readonly [C in Control]: Presence }
	readonly values: { readonly [C in Control]: unknown }
	readonly extra: "none" | "a string key" | "a symbol key"
	readonly shape: "an object" | "no object"
	readonly notObject: unknown
}

const presenceGen = element<Presence>(["absent", "absent", "own", "own", "inherited"])

const requestCaseGen: Gen<RequestCase> = (source) => {
	const limit = source.draw(int(1, 2 * pageMaxSize))
	return {
		pageMaxSize: limit,
		presence: {
			first: source.draw(presenceGen),
			last: source.draw(presenceGen),
			after: source.draw(presenceGen),
			before: source.draw(presenceGen)
		},
		values: {
			first: source.draw(sizeGen(limit)),
			last: source.draw(sizeGen(limit)),
			after: source.draw(cursorGen),
			before: source.draw(cursorGen)
		},
		extra: source.draw(
			element<RequestCase["extra"]>(["none", "none", "none", "a string key", "a symbol key"])
		),
		shape: source.draw(
			element<RequestCase["shape"]>(["an object", "an object", "an object", "no object"])
		),
		notObject: source.draw(element<unknown>([null, undefined, 3, "first", [1]]))
	}
}

/** The request a case builds: own properties on the object, inherited ones on its prototype. */
const requestOf = (c: RequestCase): unknown => {
	if (c.shape === "no object") {
		return c.notObject
	}
	const proto: Record<string, unknown> = {}
	const own: Record<string | symbol, unknown> = {}
	for (const k of controls) {
		if (c.presence[k] === "own") {
			own[k] = c.values[k]
		}
		if (c.presence[k] === "inherited") {
			proto[k] = c.values[k]
		}
	}
	if (c.extra === "a string key") {
		own["total"] = true
	}
	if (c.extra === "a symbol key") {
		own[Symbol("x")] = 1
	}
	return Object.assign(Object.create(proto), own)
}

type Expected =
	| { readonly kind: "request error"; readonly fault: RequestFault }
	| { readonly kind: "cursorType" }
	| { readonly kind: "accepted"; readonly value: PageRequestValue }

/**
 * The rule, restated: the shape first (only control properties, own; one size; at most the anchor of its direction),
 * refused as requestShape; a safe integer size in range, refused as requestSize; then the cursor's type.
 */
const expectedOf = (c: RequestCase): Expected => {
	if (c.shape === "no object" || c.extra !== "none") {
		return { kind: "request error", fault: "requestShape" }
	}
	const has = (k: Control) => c.presence[k] === "own"
	const forward = has("first")
	if (forward === has("last")) {
		return { kind: "request error", fault: "requestShape" }
	}
	if (has(forward ? "before" : "after")) {
		return { kind: "request error", fault: "requestShape" }
	}
	const size = c.values[forward ? "first" : "last"]
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > c.pageMaxSize) {
		return { kind: "request error", fault: "requestSize" }
	}
	const anchor = forward ? "after" : "before"
	if (!has(anchor)) {
		return {
			kind: "accepted",
			value: forward ? { variant: "first", size } : { variant: "last", size }
		}
	}
	const cursor = c.values[anchor]
	if (typeof cursor !== "string") {
		return { kind: "cursorType" }
	}
	return {
		kind: "accepted",
		value: forward ? { variant: "after", size, cursor } : { variant: "before", size, cursor }
	}
}

describe("page requests", () => {
	it.effect(
		"accept exactly the four shapes, refuse every other as a request error by its shape or size, and a non-string cursor as cursorType",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/page/request",
						draw: drawn(requestCaseGen),
						literal: Formatter.format,
						coverage: required<
							| "first"
							| "after"
							| "last"
							| "before"
							| RequestFault
							| "cursorType"
							| "an inherited control"
						>(
							[
								"first",
								"after",
								"last",
								"before",
								"requestShape",
								"requestSize",
								"cursorType",
								"an inherited control"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(c, note) =>
						Effect.sync(() => {
							if (Arr.some(controls, (k) => c.presence[k] === "inherited")) {
								note.note("an inherited control")
							}
							const expected = expectedOf(c)
							const result = pageRequest(requestOf(c), c.pageMaxSize)
							switch (expected.kind) {
								case "request error":
									note.note(expected.fault)
									assert.deepEqual(result, Result.fail(requestRefused(expected.fault)))
									return
								case "cursorType":
									note.note("cursorType")
									assert.deepEqual(result, Result.fail(CursorError.make({ _tag: "cursorType" })))
									return
								case "accepted":
									note.note(expected.value.variant)
									assert.deepEqual(result, Result.succeed(expected.value))
									return
							}
						})
				)
			)
	)
})
