/**
 * Span storage on PostgreSQL 19: what a span column admits and stores, and how a span parameter binds.
 *
 * - Shape: drawn literals of every spelling (bounded, empty, unbounded on either side or both, and spellings beside a
 *   type's limits) are stored as their canonical half-open span, refused by the shape CHECK when empty or unbounded,
 *   or refused as invalid literals, as the host canonicalization says.
 * - Width: a span of a fixed declared width is accepted exactly when its width is the declared one, at int4's limits
 *   too, the width checked in numeric.
 * - Contract endpoints: a span over a contract is refused, under the contract's law, exactly when an endpoint breaks
 *   the contract's predicate, near its bounds and at bigint's limits.
 * - Parameters: a span parameter binds as its canonical text, and lower, upper and width read every stored span the
 *   window meets, exactly, a width past bigint's range among them; an empty or reversed window is refused by its codec.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Array as Arr, Order } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileSpanQuery, rowsAs, runArtifact } from "#test/pg/spans/allen/support.ts"
import {
	type BoundFeature,
	boundSpace,
	Edge,
	edgeBounds,
	type EndpointFeature,
	int4,
	int8,
	endpointSpace,
	holds,
	Plan,
	runs,
	type ShapeFeature,
	shapeLiteral,
	shapeSpace,
	Slot,
	slotWidth,
	storeTemplate,
	tickBound,
	type WidthFeature,
	widthSpace,
	type Written,
	written
} from "#test/pg/spans/storage/storage.fixtures.ts"
import { declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { type HalfOpen, spanText } from "#test/support/oracle/allen.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/**
 * The shape CHECK refuses empty and unbounded spans and stores every other spelling canonical, each case on the worker's seat
 * of the store.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/spans/storage/storage.test.ts at edabdcc5f).
 */
export const theShapeCheckRefusesEmptyAndUnboundedSpansAndStoresEveryOtherSpellingCanonical =
	property.explore(shapeSpace, {
		needs: { store: Substrate.seat(storeTemplate) },
		situations: [
			"a canonical spelling stored",
			"another spelling stored canonical",
			"an empty spelling refused",
			"unbounded below refused",
			"unbounded above refused",
			"unbounded on both sides refused"
		] satisfies ReadonlyArray<Reached<ShapeFeature>>,
		check:
			({ store }, c: Case<ShapeFeature>) =>
			(d) =>
				Effect.scoped(
					Effect.flatMap(store, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const installed = seat.value
								const names = installationNamesOf(installed.installation)
								const shape = names.spanCheck(Edge, "s", { kind: "shape" })
								const { text, canonical } = shapeLiteral(d)
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the host canonicalization of each literal: stored canonical, refused by the shape CHECK, or invalid"
		},
		show: Formatter.format,
		budget: { runs, steered: runs },
		kept: [],
		kills: []
	})

/**
 * A fixed width is checked in numeric: accepted iff the width is the declared one, at the limits too, each case on the
 * worker's seat of the store.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/spans/storage/storage.test.ts at edabdcc5f).
 */
export const aFixedWidthIsCheckedInNumericAcceptedIffTheWidthIsTheDeclaredOneAtTheLimitsToo =
	property.explore(widthSpace, {
		needs: { store: Substrate.seat(storeTemplate) },
		situations: [
			"the declared width stored",
			"the declared width stored from the lower limit",
			"the declared width stored to the upper limit",
			"a narrower span refused",
			"a wider span refused",
			"a span wider than the type refused"
		] satisfies ReadonlyArray<Reached<WidthFeature>>,
		check:
			({ store }, c: Case<WidthFeature>) =>
			(d) =>
				Effect.scoped(
					Effect.flatMap(store, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const installed = seat.value
								const names = installationNamesOf(installed.installation)
								const width = names.spanCheck(Slot, "fixed", { kind: "width" })
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the declared width checked in numeric: a span of exactly that width, and no other"
		},
		show: Formatter.format,
		budget: { runs, steered: runs },
		kept: [],
		kills: []
	})

/**
 * A span over a contract checks both endpoints against its predicate, reporting the contract's law, each case on the
 * worker's seat of the store.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/spans/storage/storage.test.ts at edabdcc5f).
 */
export const aSpanOverAContractChecksBothEndpointsAgainstItsPredicateReportingTheContractsLaw =
	property.explore(endpointSpace, {
		needs: { store: Substrate.seat(storeTemplate) },
		situations: [
			"both endpoints in the contract stored",
			"an endpoint at the contract's bound stored",
			"refused by its lower endpoint alone",
			"refused by its upper endpoint alone",
			"refused by both endpoints"
		] satisfies ReadonlyArray<Reached<EndpointFeature>>,
		check:
			({ store }, c: Case<EndpointFeature>) =>
			(d) =>
				Effect.scoped(
					Effect.flatMap(store, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const installed = seat.value
								const names = installationNamesOf(installed.installation)
								const endpoints = names.spanCheck(Plan, "ticks", {
									kind: "endpoint",
									contract: "Tick"
								})
								assert.equal(
									names.lawOfConstraint({ kind: "table", name: names.tableIdent(Plan) }, endpoints),
									names.contract("Tick").law
								)
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the contract's predicate on each endpoint, the contract's law named for the first it refuses"
		},
		show: Formatter.format,
		budget: { runs, steered: runs },
		kept: [],
		kills: []
	})

/**
 * A span parameter binds as its canonical text, and lower, upper and width read every span the window meets, each case
 * on the worker's seat of the store.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/spans/storage/storage.test.ts at edabdcc5f).
 */
export const aSpanParameterBindsAsItsCanonicalTextAndLowerUpperAndWidthReadEverySpanTheWindowMeets =
	property.explore(boundSpace, {
		needs: { store: Substrate.seat(storeTemplate) },
		situations: [
			"a span from the lower limit read",
			"a span to the upper limit read",
			"a width past bigint read exactly",
			"an empty answer",
			"a nonempty answer",
			"an empty window refused by its codec",
			"a reversed window refused by its codec"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			({ store }, c: Case<BoundFeature>) =>
			(d) =>
				Effect.scoped(
					Effect.flatMap(store, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const installed = seat.value
								const s = yield* Substrate
								const reader = yield* s.session({
									...worldSession(installed.world),
									label: "reader"
								})
								const n = installed.installation.names.relation("Edge")
								const table = `${quoteIdent(n.schema)}.${quoteIdent(n.name)}`
								const template = compileSpanQuery(edgeBounds, installed.schema)
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host's lower, upper and width of every stored span the window meets"
		},
		show: Formatter.format,
		budget: { runs, steered: runs },
		kept: [],
		kills: []
	})
