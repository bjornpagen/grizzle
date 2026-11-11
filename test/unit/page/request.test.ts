/**
 * Page request validation (packages/grizzle/src/adapter/page/request.ts).
 *
 * The accepted shapes are exactly { first }, { first, after }, { last } and { last, before }: mixed directions, both
 * anchors, an anchor of the other direction, a missing size and any other property are refused as
 * a ReadFailure whose reason is PageRequestRefused (stage request), and so is a size that is not a safe integer of at
 * least 1, with no upper bound; an explicitly supplied null or undefined cursor, or any non-string, is CursorError
 * `cursorType`, checked after the shape; an omitted control property is genuinely absent, so an inherited one is no
 * anchor. The rule is restated here as the oracle, and requests are drawn over every property's presence, own or
 * inherited, and every size and cursor kind, the largest safe integer and the first unsafe one among the sizes.
 *
 * Features: each accepted variant (first, after, last, before), each refusal (requestShape, requestSize, cursorType),
 * and an inherited control.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): request-unsafe-size-admitted (an integer past the safe ones taken as a
 * size), request-other-anchor-ignored (an anchor of the other direction ignored) and request-undefined-cursor-admitted
 * (an explicit undefined cursor read as no anchor).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, constant, element, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { PageRequestRefused, type RequestFault } from "#adapter/errors/failures.ts"
import { type PageRequestValue, pageRequest } from "#adapter/page/request.ts"
import { CursorError } from "#compiler/core/errors.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A page request refused for `fault`, as a read reports it. */
const requestRefused = (fault: RequestFault): ReadFailure =>
	new ReadFailure({ reason: new PageRequestRefused({ fault }) })

type Control = "first" | "last" | "after" | "before"
const controls: ReadonlyArray<Control> = ["first", "last", "after", "before"]

/** A property's presence: absent, own, or inherited from the prototype. */
type Presence = "absent" | "own" | "inherited"

const sizeGen: Gen<unknown> = weighted([
	[3, int(1, 7)],
	[1, int(1, Number.MAX_SAFE_INTEGER)],
	[
		2,
		element<unknown>([
			Number.MAX_SAFE_INTEGER,
			0,
			-0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
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
	readonly presence: { readonly [C in Control]: Presence }
	readonly values: { readonly [C in Control]: unknown }
	readonly extra: "none" | "a string key" | "a symbol key"
	readonly shape: "an object" | "no object"
	readonly notObject: unknown
}

const presenceGen: Gen<Presence> = weighted<Presence>([
	[2, constant("absent")],
	[2, constant("own")],
	[1, constant("inherited")]
])

const requestCaseGen: Gen<RequestCase> = (source) => ({
	presence: {
		first: source.draw(presenceGen),
		last: source.draw(presenceGen),
		after: source.draw(presenceGen),
		before: source.draw(presenceGen)
	},
	values: {
		first: source.draw(sizeGen),
		last: source.draw(sizeGen),
		after: source.draw(cursorGen),
		before: source.draw(cursorGen)
	},
	extra: source.draw(
		weighted<RequestCase["extra"]>([
			[3, constant("none")],
			[1, constant("a string key")],
			[1, constant("a symbol key")]
		])
	),
	shape: source.draw(
		weighted<RequestCase["shape"]>([
			[3, constant("an object")],
			[1, constant("no object")]
		])
	),
	notObject: source.draw(element<unknown>([null, undefined, 3, "first", [1]]))
})

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
 * refused as requestShape; a safe integer size of at least 1, refused as requestSize; then the cursor's type.
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
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
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
						oracle: { kind: "specification", name: "the request rule restated (expectedOf)" },
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
						caseHang
					},
					(c, note) =>
						Effect.sync(() => {
							if (Arr.some(controls, (k) => c.presence[k] === "inherited")) {
								note.note("an inherited control")
							}
							const expected = expectedOf(c)
							const result = pageRequest(requestOf(c))
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
