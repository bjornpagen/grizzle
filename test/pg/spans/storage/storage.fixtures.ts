/** What the properties of storage.test.ts read: the store, each property's space and the write it checks. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { bigint } from "@bjornpagen/testing/values"
import { Effect, Result } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { quoteIdent } from "#compiler/core/text.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { spansTemplate } from "#test/pg/spans/allen/support.ts"
import { Id } from "#test/support/ids.ts"
import {
	type Canonical,
	canonicalize,
	type HalfOpen,
	limitSpans,
	type RangeType,
	rangeLimits,
	type RangeSpelling,
	spellingText
} from "#test/support/oracle/allen.ts"
import type { ScriptInstall } from "#test/support/script-template.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/** Tick's bound: a tick lies in [-tickBound, tickBound]. */
export const tickBound = 100n

const Tick = contract("Tick", pg.bigint, (value) =>
	Compute.and(Compute.ge(value, -tickBound), Compute.le(value, tickBound))
)

/** Slot's declared width. */
export const slotWidth = 15

const Booking = relation("Booking", { room: Id, during: span(pg.bigint), guest: Id }, [
	"room",
	"during"
])
export const Slot = relation("Slot", { id: pg.integer, fixed: span(pg.integer, slotWidth) }, ["id"])
export const Plan = relation("Plan", { id: pg.integer, ticks: span(Tick) }, ["id"])
export const Edge = relation("Edge", { id: pg.integer, s: span(pg.bigint) }, ["id"])
const Store = schema("Store", [Booking, Slot, Plan, Edge], [])

export const edgeBounds = query(Store).rule((r) => {
	const { id, s } = v(Edge, "edge")
	return r
		.match(Edge, { id, s })
		.where(r.allen(s, ALLEN.intersects, r.param("window", Edge.fields.s)))
		.find({
			id,
			s,
			lo: Compute.lower(s, pg.bigint),
			hi: Compute.upper(s, pg.bigint),
			w: Compute.width(s, pg.bigint)
		})
})

export const int8 = rangeLimits.int8range
export const int4 = rangeLimits.int4range

/** A value within `distance` of `at`, either side. */
const near = (at: bigint, distance: number): Gen<bigint> =>
	map(int(-distance, distance), (d) => at + BigInt(d))

/**
 * An endpoint drawn from the window around zero, within two of a type's least or greatest value, or anywhere in the
 * type.
 */
const endpointGen = (limits: { readonly min: bigint; readonly max: bigint }): Gen<bigint> =>
	oneOf([
		bigint(-4n, 9n),
		map(int(0, 2), (d) => limits.min + BigInt(d)),
		map(int(0, 2), (d) => limits.max - BigInt(d)),
		bigint(limits.min, limits.max)
	])

/**
 * A nonempty span of two drawn int8 endpoints, the lesser its start, built rather than filtered: two equal endpoints `a`
 * span [a, a + 1), or [a - 1, a) at int8's greatest value.
 */
const spanOf =
	(endpoint: Gen<bigint>): Gen<HalfOpen> =>
	(source) => {
		const a = source.draw(endpoint)
		const b = source.draw(endpoint)
		return a < b
			? { lo: a, hi: b }
			: b < a
				? { lo: b, hi: a }
				: a < int8.max
					? { lo: a, hi: a + 1n }
					: { lo: a - 1n, hi: a }
	}

/** The runs of every property: the rotating stream's 80 cases. */
export const runs = 80

/**
 * What a write must do: be stored as the canonical span, be refused under a constraint, or be refused as an invalid
 * literal, which no constraint reports.
 */
export type Written =
	| { readonly kind: "stored"; readonly text: string }
	| { readonly kind: "refused"; readonly sqlstate: string; readonly constraint: ConstraintName }
	| { readonly kind: "invalid"; readonly sqlstate: string }

/** What a write did, in Written's terms. */
const writtenOf = (fields: PgErrorFields): Written =>
	fields.constraint === undefined
		? { kind: "invalid", sqlstate: fields.code }
		: { kind: "refused", sqlstate: fields.code, constraint: fields.constraint }

/**
 * Inserts one row, an id and the span `text` of `field`, as the writer into an emptied table, and checks the outcome
 * against `expected`, reading back what it stored.
 */
export const written = (
	installed: ScriptInstall,
	relationName: string,
	field: string,
	type: RangeType,
	text: string,
	expected: Written
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const n = installed.installation.names.relation(relationName)
		const table = `${quoteIdent(n.schema)}.${quoteIdent(n.name)}`
		const column = quoteIdent(installed.installation.names.column(relationName, field))
		yield* s.admin.query(`TRUNCATE ${table}`, [])
		const writer = yield* s.session({ ...worldSession(installed.world), label: "writer" })
		const ran = yield* Effect.result(
			writer.query(`INSERT INTO ${table} ("id", ${column}) VALUES (1, $1::text::${type})`, [text])
		)
		if (Result.isFailure(ran)) {
			const fields = pgErrorFields(ran.failure)
			assert.ok(fields !== undefined, String(ran.failure))
			assert.deepEqual(writtenOf(fields), expected, `${text}: ${fields.message}`)
			return
		}
		assert.equal(expected.kind, "stored", `${text} is stored`)
		const stored = yield* writer.values(`SELECT ${column}::text FROM ${table}`, [])
		assert.deepEqual(stored, [[expected.kind === "stored" ? expected.text : text]], text)
	}).pipe(Effect.scoped)

export const holds = (x: bigint): boolean => x >= -tickBound && x <= tickBound

export type ShapeDrawn =
	| { readonly kind: "bounded"; readonly spelling: RangeSpelling }
	| {
			readonly kind: "unbounded"
			readonly lower: { readonly value: bigint; readonly inclusive: boolean } | "infinite"
			readonly upper: { readonly value: bigint; readonly inclusive: boolean } | "infinite"
	  }
export type ShapeFeature =
	| "a canonical spelling stored"
	| "another spelling stored canonical"
	| "an empty spelling refused"
	| `unbounded ${"below" | "above" | "on both sides"} refused`
const finiteBound = (source: Source) => ({
	value: source.draw(endpointGen(int8)),
	inclusive: source.draw(boolean)
})
/** An unbounded span: infinite below, above or on both sides, each alike. */
const unbounded: Gen<ShapeDrawn> = oneOf<ShapeDrawn>([
	(source) => ({ kind: "unbounded", lower: "infinite", upper: finiteBound(source) }),
	(source) => ({ kind: "unbounded", lower: finiteBound(source), upper: "infinite" }),
	constant({ kind: "unbounded", lower: "infinite", upper: "infinite" })
])
export const shapeSpace: Gen<ShapeDrawn> = oneOf<ShapeDrawn>([
	(source) => ({
		kind: "bounded",
		spelling: {
			lowerInc: source.draw(boolean),
			lo: source.draw(endpointGen(int8)),
			hi: source.draw(endpointGen(int8)),
			upperInc: source.draw(boolean)
		}
	}),
	unbounded,
	map(spanOf(endpointGen(int8)), (h): ShapeDrawn => ({
		kind: "bounded",
		spelling: { lowerInc: true, lo: h.lo, hi: h.hi, upperInc: false }
	})),
	(source) => ({
		kind: "bounded",
		spelling: source.draw(
			oneOf([
				map(endpointGen(int8), (x): RangeSpelling => ({
					lowerInc: true,
					lo: x,
					hi: x,
					upperInc: false
				})),
				map(endpointGen({ min: int8.min, max: int8.max - 1n }), (x): RangeSpelling => ({
					lowerInc: false,
					lo: x,
					hi: x + 1n,
					upperInc: false
				}))
			])
		)
	})
])
/**
 * The literal and what PostgreSQL makes of it, by the oracle; an unbounded literal is unbounded unless its finite
 * bound leaves the type as the canonical form moves it.
 */
export const shapeLiteral = (
	d: ShapeDrawn
): { readonly text: string; readonly canonical: Canonical | "unbounded" } => {
	if (d.kind === "bounded") {
		return {
			text: spellingText(d.spelling),
			canonical: canonicalize("int8range", d.spelling)
		}
	}
	const lower = d.lower === "infinite" ? "(" : `${d.lower.inclusive ? "[" : "("}${d.lower.value}`
	const upper = d.upper === "infinite" ? ")" : `${d.upper.value}${d.upper.inclusive ? "]" : ")"}`
	const overflows =
		(d.lower !== "infinite" && !d.lower.inclusive && d.lower.value === int8.max) ||
		(d.upper !== "infinite" && d.upper.inclusive && d.upper.value === int8.max)
	return {
		text: `${lower},${upper}`,
		canonical: overflows ? { kind: "error", sqlstate: "22003" } : "unbounded"
	}
}

export type WidthFeature =
	| "the declared width stored"
	| "the declared width stored from the lower limit"
	| "the declared width stored to the upper limit"
	| "a narrower span refused"
	| "a wider span refused"
	| "a span wider than the type refused"
/** A width: within one of the declared width, the least or the whole type's, or any between. */
const widths = oneOf([
	near(BigInt(slotWidth), 1),
	map(int(0, 1), (d) => (d === 0 ? 1n : int4.max - int4.min)),
	bigint(1n, int4.max - int4.min)
])
/** A span of width `w` inside int4: from int4's least value, up to its greatest, or from any start between. */
const placed = (w: bigint): Gen<HalfOpen> =>
	oneOf<HalfOpen>([
		map(int(0, 1), (end): HalfOpen =>
			end === 0 ? { lo: int4.min, hi: int4.min + w } : { lo: int4.max - w, hi: int4.max }
		),
		map(bigint(int4.min, int4.max - w), (lo): HalfOpen => ({ lo, hi: lo + w }))
	])
export const widthSpace: Gen<HalfOpen> = (source) => source.draw(placed(source.draw(widths)))

export type EndpointFeature =
	| "both endpoints in the contract stored"
	| "an endpoint at the contract's bound stored"
	| "refused by its lower endpoint alone"
	| "refused by its upper endpoint alone"
	| "refused by both endpoints"
/** An endpoint within one of either of Tick's bounds, near zero, at a limit of bigint, or anywhere. */
const endpoint = oneOf([
	near(-tickBound, 1),
	near(tickBound, 1),
	near(0n, 1),
	map(int(0, 1), (end) => (end === 0 ? int8.min : int8.max)),
	bigint(-2n * tickBound, 2n * tickBound),
	bigint(int8.min, int8.max)
])
export const endpointSpace = spanOf(endpoint)

export type BoundFeature =
	| "a span from the lower limit read"
	| "a span to the upper limit read"
	| "a width past bigint read exactly"
	| "an empty answer"
	| "a nonempty answer"
	| "an empty window refused by its codec"
	| "a reversed window refused by its codec"
export interface BoundDrawn {
	readonly spans: ReadonlyArray<HalfOpen>
	readonly window: { readonly start: bigint; readonly end: bigint }
}
const spanGen = spanOf(endpointGen(int8))
/**
 * The spans at the type's limits are planted (oracle/allen.ts limitSpans), and the window may be the whole
 * type or empty, since drawn endpoints meet them too rarely.
 */
const limits = nonEmpty(limitSpans("int8range"), "the spans at the type's limits")
export const boundSpace: Gen<BoundDrawn> = (source) => ({
	spans: source.draw(array(oneOf([spanGen, element(limits)]), { min: 0, max: 4 })),
	window: source.draw(
		oneOf<BoundDrawn["window"]>([
			(inner) => ({
				start: inner.draw(endpointGen(int8)),
				end: inner.draw(endpointGen(int8))
			}),
			constant({ start: int8.min, end: int8.max }),
			map(endpointGen(int8), (x) => ({ start: x, end: x }))
		])
	)
})

/** The store's spans installed once per member (allen/support.ts spansTemplate), which every case seats on. */
export const storeTemplate = spansTemplate(import.meta, "span store", Store, {
	label: "store",
	extensions: []
})
