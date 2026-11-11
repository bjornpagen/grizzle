import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	drawnFeature,
	lsw,
	passed,
	WILD_IS_DATA,
	WILD_KINDS,
	type WildKind
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { absurd, Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import type { RequestFault } from "#adapter/errors/failures.ts"
import { pageRequest } from "#adapter/page/request.ts"
import { CursorError } from "#compiler/core/errors.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert, failed, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The fault a page request's refusal names, at stage request; none for any other read failure. */
const requestFault = (failure: ReadFailure): RequestFault | undefined =>
	failure.stage === "request" && failure.reason._tag === "PageRequestRefused"
		? failure.reason.fault
		: undefined

/**
 * The public boundary: every value a JavaScript caller can hand a page request or a schema door is parsed once, and a
 * value the types refuse is a typed refusal from the vocabulary, never a defect.
 *
 * The oracle is the contract README "Reading" states, restated here: a page request is exactly { first }, { first, after }, { last } or
 * { last, before }, its size a safe integer of at least 1 with no upper bound, its anchor a string; a refused shape is a ReadFailure
 * at stage `request` with fault `requestShape`, a refused size one with `requestSize`, a non-string anchor CursorError
 * `cursorType`. The request is read as data before any of its fields is judged, so a value in it that is not data (a
 * refusing proxy, a getter: WILD_IS_DATA) refuses its shape wherever it sits. A schema door takes a value
 * schema(...)
 * built, and refuses anything else as a MalformedDescription. The caller's code runs at most once at a boundary: an
 * accessor is refused without being called.
 *
 * Values are drawn live and wild (lsw): a live request is valid by construction, its size up to the largest safe
 * integer; a wild one is any value JavaScript can pass, in place of the whole request or of one of its fields. A page
 * request has no earlier state, so none is stale. A valid request whose size or anchor is an accessor returning its
 * valid value is refused for its shape, its getter never called: a reader that called it would admit the request.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): boundary-page-size-zero.patch (a page of size 0 is admitted).
 *
 * Features: each live request shape, each wild kind at each site, and each schema door's live and wild values.
 */
type Direction = "first" | "last"

/** A valid request: its direction, its size, and its anchor when it has one. */
interface Request {
	readonly direction: Direction
	readonly size: number
	readonly anchor: { readonly kind: "none" } | { readonly kind: "token"; readonly token: string }
}

const anchorKey = (d: Direction): "after" | "before" => (d === "first" ? "after" : "before")

/** The README's page size: a safe integer of at least 1. */
const isPageSizeSpec = (value: unknown): boolean =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1

/** What a request holding a wild value answers: admitted, a refused shape or size, or a non-string anchor. */
type WildVerdict = "admitted" | RequestFault | "cursorType"

/**
 * The verdict on a wild value at `site`: one that is not data refuses the request's shape wherever it sits; a wild
 * request is refused for its shape; a size is judged by the size's rule, a number the limit admits being a size; an
 * anchor that is a string (a lone surrogate, a NUL) is one the cursor codec validates later, and any other is the
 * cursor's refusal.
 */
const wildVerdict = (site: WildSite, data: boolean, value: unknown): WildVerdict => {
	if (!data) {
		return "requestShape"
	}
	switch (site) {
		case "whole":
			return "requestShape"
		case "size":
			return isPageSizeSpec(value) ? "admitted" : "requestSize"
		case "anchor":
			return typeof value === "string" ? "admitted" : "cursorType"
	}
}

/** Every wild kind but `anything`, which may draw a valid request itself. */
const pageWildKinds = [
	"null",
	"undefined",
	"negative-zero",
	"nan",
	"infinity",
	"bigint-for-number",
	"number-for-bigint",
	"lone-surrogate",
	"nul-character",
	"symbol",
	"function",
	"proxy",
	"throwing-getter"
] as const satisfies ReadonlyArray<WildKind>

const requestValue = (r: Request): Readonly<Record<string, unknown>> =>
	r.anchor.kind === "none"
		? { [r.direction]: r.size }
		: { [r.direction]: r.size, [anchorKey(r.direction)]: r.anchor.token }

/** A page size: small, any safe integer, or the largest. */
const sizeGen: Gen<number> = weighted([
	[3, int(1, 7)],
	[1, int(1, Number.MAX_SAFE_INTEGER)],
	[1, constant(Number.MAX_SAFE_INTEGER)]
])

const requestGen: Gen<Request> = (source) => ({
	direction: source.draw(element<Direction>(["first", "last"])),
	size: source.draw(sizeGen),
	anchor: source.draw(
		oneOf<Request["anchor"]>([
			constant({ kind: "none" }),
			map(string(codePoint(0x20, 0x7e), { min: 0, max: 10 }), (token) => ({
				kind: "token",
				token
			}))
		])
	)
})

/** Where a wild value goes: the whole request, its size, or its anchor. */
type WildSite = "whole" | "size" | "anchor"

/** The field of a valid request an accessor stands in for, returning the field's valid value when it is called. */
type AccessorField = "size" | "anchor"

/**
 * A case: a live or wild value at a site of a request; or a valid request one of whose fields is an accessor, which a
 * reader that judged it by calling it would admit.
 */
type PageCase =
	| {
			readonly kind: "drawn"
			readonly site: WildSite
			readonly base: Request
			readonly drawn: Drawn<Request, never>
	  }
	| { readonly kind: "accessor"; readonly base: Request; readonly field: AccessorField }

const pageCaseGen: Gen<PageCase> = weighted<PageCase>([
	[
		8,
		(source) => ({
			kind: "drawn",
			site: source.draw(element<WildSite>(["whole", "size", "anchor"])),
			base: source.draw(requestGen),
			drawn: source.draw(
				lsw<Request>({ live: requestGen, stale: Option.none(), wild: pageWildKinds })
			)
		})
	],
	[
		1,
		(source) => ({
			kind: "accessor",
			base: source.draw(requestGen),
			field: source.draw(element<AccessorField>(["size", "anchor"]))
		})
	]
])

/**
 * The request a case's accessor stands in: the valid request with `field` an enumerable getter returning its value,
 * counting its calls.
 */
const withAccessor = (
	base: Request,
	field: AccessorField
): { readonly request: object; readonly calls: () => number } => {
	let calls = 0
	const key = field === "size" ? base.direction : anchorKey(base.direction)
	const value = field === "size" ? base.size : base.anchor.kind === "token" ? base.anchor.token : ""
	const request = { ...requestValue(base) }
	Object.defineProperty(request, key, {
		enumerable: true,
		get: () => {
			calls++
			return value
		}
	})
	return { request, calls: () => calls }
}

/** The value a drawn case hands pageRequest. */
const pageInput = (c: Extract<PageCase, { readonly kind: "drawn" }>): unknown => {
	const d = c.drawn
	if (d.kind !== "wild") {
		return requestValue(d.value)
	}
	const value = passed(d)
	switch (c.site) {
		case "whole":
			return value
		case "size":
			return { [c.base.direction]: value }
		case "anchor":
			return { [c.base.direction]: c.base.size, [anchorKey(c.base.direction)]: value }
	}
}

type PageFeature =
	| DrawnFeature<never>
	| `site ${WildSite}`
	| "refused request"
	| "refused cursorType"
	| `an accessor at the ${AccessorField}, refused uncalled`

const pageFeatures: Arr.NonEmptyReadonlyArray<PageFeature> = [
	"live",
	...Arr.map(pageWildKinds, (k: WildKind): PageFeature => `wild ${k}`),
	"site whole",
	"site size",
	"site anchor",
	"refused request",
	"refused cursorType",
	"an accessor at the size, refused uncalled",
	"an accessor at the anchor, refused uncalled"
]

/** A built schema, the one value a schema door admits. */
const Item = relation("Item", { id: uuid }, ["id"])
const Shop = schema("BoundaryShop", { Item }, [])

describe("the public boundary", () => {
	it.effect(
		"answers every page request by the README's contract, and refuses every other value with a typed refusal",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "README Reading's page request: its four shapes, a size of at least 1, a string anchor"
						},
						suite: "unit/adapter/boundary-page",
						draw: drawn(pageCaseGen),
						literal: Formatter.format,
						coverage: required<PageFeature>(pageFeatures, { cases: 2_000, sense: notesOnly }),
						kept: [],
						runs: 2_000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							if (c.kind === "accessor") {
								const { request, calls } = withAccessor(c.base, c.field)
								const refusal = failed(pageRequest(request))
								assert.ok(refusal instanceof ReadFailure, String(refusal))
								assert.equal(requestFault(refusal), "requestShape")
								assert.equal(calls(), 0, "the caller's getter never runs")
								k.note(`an accessor at the ${c.field}, refused uncalled`)
								return
							}
							k.note(drawnFeature(c.drawn))
							if (c.drawn.kind === "wild") {
								k.note(`site ${c.site}`)
							}
							const result = pageRequest(pageInput(c))
							const d = c.drawn
							if (d.kind === "live") {
								const admitted = succeeded(result)
								const r = d.value
								const variant = r.anchor.kind === "none" ? r.direction : anchorKey(r.direction)
								assert.equal(admitted.variant, variant)
								assert.equal(admitted.size, r.size)
								return
							}
							if (d.kind === "stale") {
								return absurd(d.from)
							}
							const verdict = wildVerdict(c.site, WILD_IS_DATA[d.wild.kind], passed(d))
							if (verdict === "admitted") {
								succeeded(result)
								return
							}
							assert.ok(Result.isFailure(result), "a wild value is refused")
							const failure = result.failure
							if (verdict === "cursorType") {
								assert.ok(failure instanceof CursorError, String(failure))
								assert.equal(failure.reason._tag, "cursorType")
								k.note("refused cursorType")
								return
							}
							assert.ok(failure instanceof ReadFailure, String(failure))
							assert.equal(requestFault(failure), verdict)
							k.note("refused request")
						})
				)
			)
	)

	it.effect(
		"admits a built schema at the schema door, and refuses every other value as a MalformedDescription",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					type DoorFeature = DrawnFeature<never>
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "a schema door takes a value schema(...) built and refuses anything else"
							},
							suite: "unit/adapter/boundary-schema",
							draw: drawn(
								lsw<typeof Shop>({
									live: constant(Shop),
									stale: Option.none(),
									wild: WILD_KINDS
								})
							),
							literal: Formatter.format,
							coverage: required<DoorFeature>(
								["live", ...Arr.map(WILD_KINDS, (k: WildKind): DoorFeature => `wild ${k}`)],
								{ cases: 500, sense: notesOnly }
							),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d, k) =>
							Effect.sync(() => {
								k.note(drawnFeature(d))
								const parsed = parseSchemaInput(passed(d))
								if (d.kind === "live") {
									assert.ok(parsed.ok)
									return
								}
								assert.ok(!parsed.ok)
								assert.equal(parsed.error.reason._tag, "MalformedDescription")
							})
					)
				})
			)
	)
})
