import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	compileSpanQuery,
	type InstalledSpans,
	installSpans,
	rowsAs,
	runArtifact
} from "#test/pg/spans/allen/support.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type Canonical,
	canonicalize,
	type HalfOpen,
	limitSpans,
	type RangeType,
	rangeLimits,
	type Spelling,
	spanText,
	spellingText
} from "#test/support/oracle/allen.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/** Tick's bound: a tick lies in [-tickBound, tickBound]. */
const tickBound = 100n

const Tick = contract("Tick", pg.bigint, (value) =>
	Compute.and(Compute.ge(value, -tickBound), Compute.le(value, tickBound))
)

/** Slot's declared width. */
const slotWidth = 15

const Booking = relation("Booking", { room: uuid, during: span(pg.bigint), guest: uuid }, [
	"room",
	"during"
])
const Slot = relation("Slot", { id: pg.integer, fixed: span(pg.integer, slotWidth) }, ["id"])
const Plan = relation("Plan", { id: pg.integer, ticks: span(Tick) }, ["id"])
const Edge = relation("Edge", { id: pg.integer, s: span(pg.bigint) }, ["id"])
const Store = schema("Store", { Booking, Slot, Plan, Edge }, [])

const edgeBounds = query(Store).rule((r) => {
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

const int8 = rangeLimits.int8range
const int4 = rangeLimits.int4range

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

/** A nonempty span of two distinct drawn endpoints, the lesser its start. */
const spanOf = (endpoint: Gen<bigint>): Gen<HalfOpen> =>
	map(
		filter(
			(source): readonly [bigint, bigint] => [source.draw(endpoint), source.draw(endpoint)],
			([a, b]) => a !== b,
			10
		),
		([a, b]): HalfOpen => (a < b ? { lo: a, hi: b } : { lo: b, hi: a })
	)

/** What every property's exploration shares. */
const exploration = {
	literal: Formatter.format,
	runs: 80,
	shrink: boundedShrink(100),
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/**
 * What a write must do: be stored as the canonical span, be refused under a constraint, or be refused as an invalid
 * literal, which no constraint reports.
 */
type Written =
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
const written = (
	installed: InstalledSpans,
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

const holds = (x: bigint): boolean => x >= -tickBound && x <= tickBound

layer(Substrate.layer)("span storage", (it) => {
	const setup = Effect.gen(function* () {
		const installed = yield* installSpans(Store, { label: "store", extensions: [] })
		return { installed, names: installationNamesOf(installed.installation) }
	})

	it.effect(
		"the shape CHECK refuses empty and unbounded spans and stores every other spelling canonical",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { installed, names } = yield* setup
					const shape = names.spanCheck(Edge, "s", { kind: "shape" })
					type Drawn =
						| { readonly kind: "bounded"; readonly spelling: Spelling }
						| {
								readonly kind: "unbounded"
								readonly lower: { readonly value: bigint; readonly inclusive: boolean } | "infinite"
								readonly upper: { readonly value: bigint; readonly inclusive: boolean } | "infinite"
						  }
					type F =
						| "a canonical spelling stored"
						| "another spelling stored canonical"
						| "an empty spelling refused"
						| `unbounded ${"below" | "above" | "on both sides"} refused`
					const finite = (source: Source) => ({
						value: source.draw(endpointGen(int8)),
						inclusive: source.draw(boolean)
					})
					/** An unbounded span: infinite below, above or on both sides, each alike. */
					const unbounded: Gen<Drawn> = oneOf<Drawn>([
						(source) => ({ kind: "unbounded", lower: "infinite", upper: finite(source) }),
						(source) => ({ kind: "unbounded", lower: finite(source), upper: "infinite" }),
						constant({ kind: "unbounded", lower: "infinite", upper: "infinite" })
					])
					const arb: Gen<Drawn> = oneOf<Drawn>([
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
						map(spanOf(endpointGen(int8)), (h): Drawn => ({
							kind: "bounded",
							spelling: { lowerInc: true, lo: h.lo, hi: h.hi, upperInc: false }
						})),
						(source) => ({
							kind: "bounded",
							spelling: source.draw(
								oneOf([
									map(endpointGen(int8), (x): Spelling => ({
										lowerInc: true,
										lo: x,
										hi: x,
										upperInc: false
									})),
									map(endpointGen({ min: int8.min, max: int8.max - 1n }), (x): Spelling => ({
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
					const literal = (
						d: Drawn
					): { readonly text: string; readonly canonical: Canonical | "unbounded" } => {
						if (d.kind === "bounded") {
							return {
								text: spellingText(d.spelling),
								canonical: canonicalize("int8range", d.spelling)
							}
						}
						const lower =
							d.lower === "infinite" ? "(" : `${d.lower.inclusive ? "[" : "("}${d.lower.value}`
						const upper =
							d.upper === "infinite" ? ")" : `${d.upper.value}${d.upper.inclusive ? "]" : ")"}`
						const overflows =
							(d.lower !== "infinite" && !d.lower.inclusive && d.lower.value === int8.max) ||
							(d.upper !== "infinite" && d.upper.inclusive && d.upper.value === int8.max)
						return {
							text: `${lower},${upper}`,
							canonical: overflows ? { kind: "error", sqlstate: "22003" } : "unbounded"
						}
					}
					return yield* explore(
						{
							suite: "spans/storage/shape",
							draw: drawn(arb),
							kept: [],
							coverage: required<F>(
								[
									"a canonical spelling stored",
									"another spelling stored canonical",
									"an empty spelling refused",
									"unbounded below refused",
									"unbounded above refused",
									"unbounded on both sides refused"
								],
								{ cases: exploration.runs, sense: notesOnly }
							),
							...exploration
						},
						(d, c) =>
							Effect.gen(function* () {
								const { text, canonical } = literal(d)
								const expected: Written =
									canonical === "unbounded" || canonical.kind === "empty"
										? { kind: "refused", sqlstate: "23514", constraint: shape }
										: canonical.kind === "error"
											? { kind: "invalid", sqlstate: canonical.sqlstate }
											: { kind: "stored", text: spanText(canonical.span) }
								yield* written(installed, "Edge", "s", "int8range", text, expected)
								if (canonical === "unbounded" && d.kind === "unbounded") {
									c.note(
										d.lower === "infinite" && d.upper === "infinite"
											? "unbounded on both sides refused"
											: d.lower === "infinite"
												? "unbounded below refused"
												: "unbounded above refused"
									)
								} else if (canonical !== "unbounded" && canonical.kind === "empty") {
									c.note("an empty spelling refused")
								} else if (canonical !== "unbounded" && canonical.kind === "span") {
									c.note(
										spanText(canonical.span) === text
											? "a canonical spelling stored"
											: "another spelling stored canonical"
									)
								}
							})
					)
				})
			)
	)

	it.effect(
		"a fixed width is checked in numeric: accepted iff the width is the declared one, at the limits too",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { installed, names } = yield* setup
					const width = names.spanCheck(Slot, "fixed", { kind: "width" })
					type F =
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
					const arb: Gen<HalfOpen> = (source) => source.draw(placed(source.draw(widths)))
					return yield* explore(
						{
							suite: "spans/storage/width",
							draw: drawn(arb),
							kept: [],
							coverage: required<F>(
								[
									"the declared width stored",
									"the declared width stored from the lower limit",
									"the declared width stored to the upper limit",
									"a narrower span refused",
									"a wider span refused",
									"a span wider than the type refused"
								],
								{ cases: exploration.runs, sense: notesOnly }
							),
							...exploration
						},
						(d, c) =>
							Effect.gen(function* () {
								const w = d.hi - d.lo
								const expected: Written =
									w === BigInt(slotWidth)
										? { kind: "stored", text: spanText(d) }
										: { kind: "refused", sqlstate: "23514", constraint: width }
								yield* written(installed, "Slot", "fixed", "int4range", spanText(d), expected)
								if (w === BigInt(slotWidth)) {
									c.note("the declared width stored")
									if (d.lo === int4.min) {
										c.note("the declared width stored from the lower limit")
									}
									if (d.hi === int4.max) {
										c.note("the declared width stored to the upper limit")
									}
								} else {
									c.note(
										w < BigInt(slotWidth)
											? "a narrower span refused"
											: w > int4.max
												? "a span wider than the type refused"
												: "a wider span refused"
									)
								}
							})
					)
				})
			)
	)

	it.effect(
		"a span over a contract checks both endpoints against its predicate, reporting the contract's law",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { installed, names } = yield* setup
					const endpoints = names.spanCheck(Plan, "ticks", { kind: "endpoint", contract: "Tick" })
					assert.equal(
						names.lawOfConstraint({ kind: "table", name: names.tableIdent(Plan) }, endpoints),
						names.contract("Tick").law
					)
					type F =
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
					const arb = spanOf(endpoint)
					return yield* explore(
						{
							suite: "spans/storage/endpoints",
							draw: drawn(arb),
							kept: [],
							coverage: required<F>(
								[
									"both endpoints in the contract stored",
									"an endpoint at the contract's bound stored",
									"refused by its lower endpoint alone",
									"refused by its upper endpoint alone",
									"refused by both endpoints"
								],
								{ cases: exploration.runs, sense: notesOnly }
							),
							...exploration
						},
						(d, c) =>
							Effect.gen(function* () {
								const lower = holds(d.lo)
								const upper = holds(d.hi)
								const expected: Written =
									lower && upper
										? { kind: "stored", text: spanText(d) }
										: { kind: "refused", sqlstate: "23514", constraint: endpoints }
								yield* written(installed, "Plan", "ticks", "int8range", spanText(d), expected)
								c.note(
									lower && upper
										? "both endpoints in the contract stored"
										: lower
											? "refused by its upper endpoint alone"
											: upper
												? "refused by its lower endpoint alone"
												: "refused by both endpoints"
								)
								if (lower && upper && (d.lo === -tickBound || d.hi === tickBound)) {
									c.note("an endpoint at the contract's bound stored")
								}
							})
					)
				})
			)
	)

	it.effect(
		"a span parameter binds as its canonical text, and lower, upper and width read every span the window meets",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { installed } = yield* setup
					const reader = yield* s.session({ ...worldSession(installed.world), label: "reader" })
					const n = installed.installation.names.relation("Edge")
					const table = `${quoteIdent(n.schema)}.${quoteIdent(n.name)}`
					const template = compileSpanQuery(edgeBounds, installed.schema)
					type F =
						| "a span from the lower limit read"
						| "a span to the upper limit read"
						| "a width past bigint read exactly"
						| "an empty answer"
						| "a nonempty answer"
						| "an empty window refused by its codec"
						| "a reversed window refused by its codec"
					interface Drawn {
						readonly spans: ReadonlyArray<HalfOpen>
						readonly window: { readonly start: bigint; readonly end: bigint }
					}
					const spanGen = spanOf(endpointGen(int8))
					/**
					 * The spans at the type's limits are planted (oracle/allen.ts limitSpans), and the window may be the whole
					 * type or empty, since drawn endpoints meet them too rarely.
					 */
					const limits = nonEmpty(limitSpans("int8range"), "the spans at the type's limits")
					const arb: Gen<Drawn> = (source) => ({
						spans: source.draw(array(oneOf([spanGen, element(limits)]), { min: 0, max: 4 })),
						window: source.draw(
							oneOf<Drawn["window"]>([
								(inner) => ({
									start: inner.draw(endpointGen(int8)),
									end: inner.draw(endpointGen(int8))
								}),
								constant({ start: int8.min, end: int8.max }),
								map(endpointGen(int8), (x) => ({ start: x, end: x }))
							])
						)
					})
					return yield* explore(
						{
							suite: "spans/storage/bound",
							draw: drawn(arb),
							kept: [],
							coverage: required<F>(
								[
									"a span from the lower limit read",
									"a span to the upper limit read",
									"a width past bigint read exactly",
									"an empty answer",
									"a nonempty answer",
									"an empty window refused by its codec",
									"a reversed window refused by its codec"
								],
								{ cases: exploration.runs, sense: notesOnly }
							),
							...exploration
						},
						(d, c) =>
							Effect.gen(function* () {
								const specs = Arr.map(["optimized", "conservative"] as const, (artifact) => ({
									artifact,
									spec: defined(template[artifact][0], `the ${artifact} statement`)
								}))
								if (d.window.start >= d.window.end) {
									for (const { spec } of specs) {
										const slot = defined(spec.paramSlots[0], "the window's placeholder")
										assert.ok(
											slot.kind === "scalar" && !slot.encode(d.window).ok,
											`the window ${d.window.start}, ${d.window.end}`
										)
									}
									c.note(
										d.window.start === d.window.end
											? "an empty window refused by its codec"
											: "a reversed window refused by its codec"
									)
									return
								}
								const window: HalfOpen = { lo: d.window.start, hi: d.window.end }
								yield* s.admin.query(`TRUNCATE ${table}`, [])
								for (const [i, span] of d.spans.entries()) {
									yield* s.admin.query(
										`INSERT INTO ${table} ("id", "s") VALUES ($1::int4, $2::int8range)`,
										[String(i + 1), spanText(span)]
									)
								}
								const met = Arr.flatMap(d.spans, (span, i) =>
									span.lo < window.hi && window.lo < span.hi ? [{ id: i + 1, span }] : []
								)
								const pastBigint = Arr.some(met, ({ span }) => span.hi - span.lo > int8.max)
								const columns = ["id", "s", "lo", "hi", "w"]
								const expected = Arr.sort(
									Arr.map(met, ({ id, span }) => [
										String(id),
										spanText(span),
										String(span.lo),
										String(span.hi),
										String(span.hi - span.lo)
									]),
									Order.Array(Order.String)
								)
								for (const { artifact, spec } of specs) {
									assert.deepEqual(
										paramTexts(
											spec,
											{ window: d.window },
											declaredOf(template, edgeBounds, undefined, testCompile)
										),
										[spanText(window)]
									)
									const [rows] = yield* runArtifact(reader, template, artifact, {
										window: d.window
									})
									const read = rowsAs(spec, defined(rows, "the statement's rows"), columns)
									assert.deepEqual(read, { rows: expected, repeats: 0 }, artifact)
								}
								if (pastBigint) {
									c.note("a width past bigint read exactly")
								}
								c.note(met.length === 0 ? "an empty answer" : "a nonempty answer")
								if (Arr.some(met, ({ span }) => span.lo === int8.min)) {
									c.note("a span from the lower limit read")
								}
								if (Arr.some(met, ({ span }) => span.hi === int8.max)) {
									c.note("a span to the upper limit read")
								}
							})
					)
				})
			)
	)
})
