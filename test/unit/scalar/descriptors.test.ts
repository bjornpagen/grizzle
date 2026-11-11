/**
 * The scalar descriptors (scalar/pg.ts, scalar/registry.ts describeField, schema/relation.ts closedId, contracts and
 * spans), each held to its own definition:
 *
 * - alias identity and distinct types: two spellings are one descriptor exactly when they name one type and one
 *   writing, and two descriptors one type exactly when their parts name one; a descriptor's Description decodes to
 *   itself, keys in order. Oracle: the sketches' own parts (test/unit/scalar/support.ts), a specification.
 * - typmods: numeric(p, s), float(p) and vector(n) admit exactly what PostgreSQL's rules admit, at every integer near
 *   their bounds and every wild argument, and refuse every other argument and arity as MalformedDescription. Oracle:
 *   PostgreSQL's published rules, restated from the published limits (binary32Precision, binary64Precision,
 *   vectorMaxDimensions, the integer carriers' ranges).
 * - spans: a span's width is admitted exactly when it is positive and of its endpoint's base type, and a span's
 *   endpoint is one of the span carriers' endpoints.
 * - closed ids: closedId names the roster, keeps the closed relation and its declared handle order, one identity per
 *   roster and another per name; and every forgery of a closed relation, each named by the one rule it breaks, is
 *   refused.
 *
 * Features: as each search names them: the alias and type outcomes, every kind of sketch, admitted and refused, every
 * wild kind, each forgery; for closed ids, one handle and several, two names and one.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): descriptors-float-real-past-24 (float(25) selecting real),
 * descriptors-vector-dims-past-max (a vector of one dimension past pgvector's admitted) and
 * descriptors-repeated-handle-admitted (a roster's repeated handle admitted).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, constant, type Gen, int, option, uniqueArray, weighted } from "@grizzle/testing/gen"
import {
	type Broken,
	corrupted,
	type CorruptedFeature,
	corruptedFeature,
	type Corruption,
	drawnFeature,
	type DrawnFeature,
	lsw,
	passed,
	WILD_KINDS,
	wild
} from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	binary32Precision,
	binary64Precision,
	integerRanges,
	vectorMaxDimensions
} from "#compiler/ir/carriers.ts"
import { decodeDesc, type FieldDesc } from "#compiler/ir/desc.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	Roster
} from "#compiler/ir/scalar.ts"
import {
	contractOf,
	rosterOf,
	sameScalarType,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { carrierSql, type Described, describeField } from "#compiler/scalar/registry.ts"
import { checkNumericTypmod } from "#compiler/scalar/values/decimal.ts"
import { admitVectorDimensions } from "#compiler/scalar/vector.ts"
import { closed } from "#compiler/schema/api.ts"
import { admittedClosedId, writingOf } from "#compiler/schema/relation.ts"
import { assert, defined, nonEmpty, succeeded, throwsRefused } from "#test/support/assert.ts"
import { floatOf } from "#test/support/descriptors.ts"
import { fieldIdentity, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type DescriptorSketch,
	descriptorGen,
	descriptorOf,
	endpointGen,
	isSerial,
	spanCarrierOf,
	spellings,
	typeKeyOf
} from "#test/unit/scalar/support.ts"

/** int4's greatest value, the greatest width an integer endpoint's span admits. */
const int4Greatest = Number(integerRanges.int4[1])

/** Every object's keys in order, at every depth. */
const keyOrder = (value: unknown): unknown =>
	Arr.isArray(value)
		? Arr.map(value, keyOrder)
		: typeof value === "object" && value !== null
			? Arr.map(Record.toEntries(value), ([key, item]) => [key, keyOrder(item)])
			: undefined

const described = (value: unknown): Described =>
	succeeded(describeField(value, SourceLoc("test", [])))
const descOf = (value: unknown): FieldDesc => described(value).desc
const scalarOf = (value: unknown): ScalarType => described(value).scalar
const identityOf = (value: unknown): string => succeeded(fieldIdentity(value))

/**
 * The namespace's descriptors of no typmod: every spelling that is a descriptor itself, and float(p) at every binary
 * precision PostgreSQL admits.
 */
const plainSketches: Arr.NonEmptyReadonlyArray<DescriptorSketch> = nonEmpty(
	[
		...Arr.map(spellings, (name): DescriptorSketch => ({ kind: "spelling", name })),
		...Arr.map(Arr.range(1, binary64Precision.value), (precision): DescriptorSketch => ({
			kind: "float",
			precision
		}))
	],
	"the plain descriptors"
)

/** What two descriptors of the namespace came to. */
type AliasFeature = "one value, two spellings" | "one type, two writings" | "two types"

/** What two drawn descriptors came to. */
type TypeFeature = "one type" | "two types of one kind" | "two types"

/** What a descriptor of each kind of sketch reached. */
type KindFeature = DescriptorSketch["kind"]

const kindFeatures: Arr.NonEmptyReadonlyArray<KindFeature> = [
	"spelling",
	"float",
	"numeric",
	"vector",
	"uuid",
	"closedId",
	"span",
	"contract"
]

describe("alias identity", () => {
	it.effect(
		"makes two spellings one descriptor exactly when they name one type and one writing, and a serial one type with its integer",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/alias-identity",
						/** Every pair of distinct positions, the first below the second. */
						generator: (source) => {
							const i = source.draw(int(0, plainSketches.length - 2))
							const j = source.draw(int(i + 1, plainSketches.length - 1))
							return [
								defined(plainSketches[i], "a descriptor"),
								defined(plainSketches[j], "a descriptor")
							] as const
						},
						literal: Formatter.format,
						limit: (plainSketches.length * (plainSketches.length - 1)) / 2,
						box: "every pair of the pg namespace's descriptors and float(p) at every precision",
						oracle: {
							kind: "specification",
							name: "the SQL type each spelling names, which the catalog suite holds PostgreSQL to, and its writing"
						},
						coverage: requiredInSpace<AliasFeature>([
							"one value, two spellings",
							"one type, two writings",
							"two types"
						]),
						caseHang
					},
					([x, y], c) =>
						Effect.sync(() => {
							const a = descriptorOf(x)
							const b = descriptorOf(y)
							const oneType = typeKeyOf(x) === typeKeyOf(y)
							const oneWriting = writingOf(a).kind === writingOf(b).kind
							const label = `${Formatter.format(x)} and ${Formatter.format(y)}`
							assert.equal(a === b, oneType && oneWriting, label)
							assert.equal(identityOf(a) === identityOf(b), oneType, label)
							assert.equal(Object.isFrozen(a), true, label)
							if (!oneType) {
								c.note("two types")
								return
							}
							c.note(oneWriting ? "one value, two spellings" : "one type, two writings")
							assert.equal(sameScalarType(scalarOf(a), scalarOf(b)), true, label)
							assert.deepEqual(descOf(a), descOf(b), label)
						})
				)
			)
	)

	it.effect("makes two descriptors one type exactly when their parts name one", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/scalar/distinct-types",
					draw: drawn((source) => {
						const x = source.draw(descriptorGen(2))
						return [
							x,
							source.draw(
								weighted([
									[1, constant(x)],
									[2, descriptorGen(2)]
								])
							)
						] as const
					}),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "a type is its SQL type, typmod, roster, endpoint, width and contract name"
					},
					coverage: required<TypeFeature>(["one type", "two types of one kind", "two types"], {
						cases: 300,
						sense: notesOnly
					}),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([x, y], c) =>
					Effect.sync(() => {
						const oneType = typeKeyOf(x) === typeKeyOf(y)
						c.note(oneType ? "one type" : x.kind === y.kind ? "two types of one kind" : "two types")
						assert.equal(
							identityOf(descriptorOf(x)) === identityOf(descriptorOf(y)),
							oneType,
							`${Formatter.format(x)} and ${Formatter.format(y)}`
						)
					})
			)
		)
	)

	it.effect(
		"builds every descriptor's Description through its decoder, and a ScalarType the full decoder makes exactly",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/descriptor-decode",
						draw: drawn(descriptorGen(2)),
						literal: Formatter.format,
						oracle: { kind: "universal", name: "decode ∘ describe = describe, key order kept" },
						coverage: required<KindFeature>(kindFeatures, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							c.note(sketch.kind)
							const field = descriptorOf(sketch)
							const { desc, scalar } = described(field)
							assert.deepEqual(succeeded(decodeDesc("field", desc)), desc)
							const decoded = succeeded(decodeScalarType(scalar))
							assert.deepEqual(decoded, scalar)
							assert.deepEqual(keyOrder(decoded), keyOrder(scalar))
							assert.equal(Object.isFrozen(field), true)
						})
				)
			)
	)
})

/** Every typmod search notes whether the call was admitted or refused, and what each drawn argument was. */
type TypmodFeature = "admitted" | "refused" | DrawnFeature<never>

const isInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value)

/**
 * numerictypmodin's rule: precision 1-numericMaxPrecision and scale numericMinScale-numericMaxScale, both integers and
 * both given: no numeric is without its scale. -0 is the integer 0.
 */
const numericTypmodOf = (
	precision: unknown,
	scale: unknown
): { readonly precision: number; readonly scale: number } | undefined =>
	isInteger(precision) &&
	precision >= 1 &&
	precision <= numericMaxPrecision.value &&
	isInteger(scale) &&
	scale >= numericMinScale.value &&
	scale <= numericMaxScale.value
		? { precision, scale: scale === 0 ? 0 : scale }
		: undefined

describe("typmod validation", () => {
	it.effect(
		"agrees with the carrier's numeric typmod rule on every integer pair, and refuses every other argument and arity",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the numeric typmod rule restated (numericTypmodOf)"
						},
						suite: "unit/scalar/descriptors-7239021",
						draw: drawn(
							(source) =>
								[
									source.draw(
										lsw<number>({
											live: int(-1100, 1100),
											stale: Option.none(),
											wild: WILD_KINDS
										})
									),
									source.draw(
										lsw<number>({
											live: int(-1100, 1100),
											stale: Option.none(),
											wild: WILD_KINDS
										})
									),
									source.draw(int(0, 3))
								] as const
						),
						literal: Formatter.format,
						coverage: required<TypmodFeature | "arity">(
							[
								"admitted",
								"refused",
								"arity",
								...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`)
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
					([dp, ds, arity], c) =>
						Effect.sync(() => {
							c.note(drawnFeature(dp))
							c.note(drawnFeature(ds))
							const p = passed(dp)
							const s = passed(ds)
							if (arity === 0 || arity === 3) {
								c.note("arity")
							}
							const args: ReadonlyArray<unknown> =
								arity === 0 ? [] : arity === 1 ? [p] : arity === 2 ? [p, s] : [p, s, 1]
							const expected = arity === 2 ? numericTypmodOf(p, s) : undefined
							if (expected === undefined) {
								c.note("refused")
								throwsRefused(
									() => pgDescriptors.numeric(...argumentsOf(args)),
									"MalformedDescription"
								)
							} else {
								c.note("admitted")
								const built = pgDescriptors.numeric(...argumentsOf(args))
								assert.deepEqual({ precision: built.precision, scale: built.scale }, expected)
								assert.equal(pgDescriptors.decimal, pgDescriptors.numeric)
								assert.equal(
									identityOf(pgDescriptors.decimal(...argumentsOf(args))),
									identityOf(built)
								)
							}
							if (arity === 2 && dp.kind === "live" && ds.kind === "live") {
								assert.equal(checkNumericTypmod(p, s).ok, expected !== undefined)
							}
						})
				)
			)
	)

	it.effect(
		"selects real for float(1-24) and double precision for float(25-53), and refuses the rest",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/float-typmod",
						draw: drawn(
							lsw<number>({
								live: int(-4, binary64Precision.value + 6),
								stale: Option.none(),
								wild: WILD_KINDS
							})
						),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "PostgreSQL's float(p): real for 1-24, double precision for 25-53, an error otherwise"
						},
						coverage: required<TypmodFeature>(
							[
								"admitted",
								"refused",
								...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`)
							],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnPrecision, c) =>
						Effect.sync(() => {
							c.note(drawnFeature(drawnPrecision))
							const precision = passed(drawnPrecision)
							if (!isInteger(precision) || precision < 1 || precision > binary64Precision.value) {
								c.note("refused")
								throwsRefused(() => floatOf(precision), "MalformedDescription")
							} else {
								c.note("admitted")
								assert.equal(
									floatOf(precision),
									precision <= binary32Precision.value
										? pgDescriptors.real
										: pgDescriptors["double precision"]
								)
							}
						})
				)
			)
	)

	it.effect("admits vector dimensions 1-16000 alone, and refuses the rest", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "pgvector's dimensions, an integer from 1 to vectorMaxDimensions"
					},
					suite: "unit/scalar/vector-dims",
					draw: drawn(
						(source) =>
							[
								source.draw(
									lsw<number>({
										live: int(-2, vectorMaxDimensions.value + 2),
										stale: Option.none(),
										wild: WILD_KINDS
									})
								),
								source.draw(option(array(wild(WILD_KINDS), { min: 1, max: 2 })))
							] as const
					),
					literal: Formatter.format,
					coverage: required<TypmodFeature>(
						[
							"admitted",
							"refused",
							...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`)
						],
						{ cases: 1000, sense: notesOnly }
					),
					kept: [],
					/** text/parse's flags search, the nearest generated neighbour of the replaced examples. */
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([d, extras], c) =>
					Effect.sync(() => {
						c.note(drawnFeature(d))
						const dimensions = passed(d)
						const extra = Option.match(extras, {
							onNone: (): ReadonlyArray<unknown> => [],
							onSome: (values) =>
								Arr.map(values, (value) => passed<never, never>({ kind: "wild", wild: value }))
						})
						if (
							extra.length === 0 &&
							isInteger(dimensions) &&
							dimensions >= 1 &&
							dimensions <= vectorMaxDimensions.value
						) {
							c.note("admitted")
							admitVectorDimensions(dimensions, [])
							assert.equal(pgDescriptors.vector(dimensions).dimensions, dimensions)
						} else {
							c.note("refused")
							throwsRefused(() => admitVectorDimensions(dimensions, extra), "MalformedDescription")
						}
					})
			)
		)
	)

	it.effect(
		"admits a positive span width of the endpoint's base type, and refuses the rest",
		(ctx) =>
			Effect.gen(function* () {
				/**
				 * The widths each span carrier admits, as the README states them: an integer endpoint's are JavaScript
				 * integers from 1 to 2^31 - 1, a bigint endpoint's bigints from 1 to 2^63 - 1.
				 */
				const admits: { readonly [C in "range4" | "range8"]: (width: number | bigint) => boolean } =
					{
						range4: (w) => isInteger(w) && w >= 1 && w <= int4Greatest,
						range8: (w) => typeof w === "bigint" && w >= 1n && w <= integerRanges.int8[1]
					}
				/** Widths of both host kinds around 0 and around each endpoint type's maximum. */
				const widths = weighted<number | bigint>([
					[1, int(-2, 2)],
					[1, int(int4Greatest - 2, int4Greatest + 2)],
					[1, bigint(-2n, 2n)],
					[1, bigint(integerRanges.int8[1] - 2n, integerRanges.int8[1] + 2n)],
					[1, bigint(integerRanges.int4[1] - 2n, integerRanges.int4[1] + 2n)],
					[1, int(Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER)]
				])
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "the README's widths: a positive integer within the endpoint's base type"
							},
							suite: "unit/scalar/span-width",
							draw: drawn(
								(source) =>
									[
										source.draw(endpointGen(2)),
										source.draw(
											lsw<number | bigint>({
												live: widths,
												stale: Option.none(),
												wild: WILD_KINDS
											})
										),
										source.draw(int(1, 3))
									] as const
							),
							literal: Formatter.format,
							coverage: required<TypmodFeature | "endpoint range4" | "endpoint range8">(
								[
									"admitted",
									"refused",
									...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`),
									"endpoint range4",
									"endpoint range8"
								],
								{ cases: 1000, sense: notesOnly }
							),
							kept: [],
							/** text/parse's flags search, the nearest generated neighbour of the replaced examples. */
							runs: 1000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([sketch, d, arity], c) =>
							Effect.sync(() => {
								const carrier = defined(spanCarrierOf(sketch), "an endpoint's span carrier")
								const endpoint = descriptorOf(sketch)
								c.note(`endpoint ${carrier}`)
								c.note(drawnFeature(d))
								const width = passed(d)
								if (arity === 3) {
									c.note("refused")
									throwsRefused(() => spanDescriptor(endpoint, width, 0), "MalformedDescription")
									return
								}
								/** An undefined width is the optional width left out: span(endpoint). */
								const given = arity === 2 ? width : undefined
								if (given === undefined) {
									c.note("admitted")
									assert.equal(spanOf(scalarOf(spanDescriptor(endpoint, given)))?.width, undefined)
								} else if (
									(typeof given === "number" || typeof given === "bigint") &&
									admits[carrier](given)
								) {
									c.note("admitted")
									assert.equal(
										spanOf(scalarOf(spanDescriptor(endpoint, given)))?.width,
										BigInt(given)
									)
								} else {
									c.note("refused")
									throwsRefused(() => spanDescriptor(endpoint, given), "MalformedDescription")
								}
							})
					)
				)
			})
	)
})

describe("span endpoint eligibility", () => {
	/** What an endpoint came to: a span of either carrier, a refusal, or a serial's refusal. */
	type EndpointFeature = "range4" | "range8" | "refused" | "a serial"

	it.effect(
		"admits integer, bigint and contracts over them, as int4range and int8range, and refuses every other endpoint",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/span-endpoints",
						draw: drawn(descriptorGen(2)),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the README's span endpoints: integer or bigint, or a contract over one"
						},
						coverage: required<EndpointFeature>(["range4", "range8", "refused", "a serial"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const endpoint = descriptorOf(sketch)
							const expected = spanCarrierOf(sketch)
							if (expected === undefined) {
								c.note(sketch.kind === "spelling" && isSerial(sketch.name) ? "a serial" : "refused")
								throwsRefused(() => spanDescriptor(endpoint), "UnsupportedOperation")
								return
							}
							c.note(expected)
							const s = spanDescriptor(endpoint)
							assert.equal(scalarOf(s).carrier, expected)
							assert.ok(s.endpoint === endpoint, "the span keeps its endpoint descriptor")
							assert.deepEqual(descOf(s), {
								kind: "span",
								endpoint: descOf(endpoint),
								width: undefined
							})
							assert.ok(scalarOf(endpoint).caps.includes("spanEndpoint"), "an endpoint")
							const contracted = contractOf(defined(spanOf(scalarOf(s)), "the span").endpoint)
							assert.equal(contracted?.name, contractOf(scalarOf(endpoint))?.name)
						})
				)
			)
	)
})

const at = (value: unknown, site: string): ReadonlyArray<Broken<"MalformedDescription">> => [
	{ value, refusal: "MalformedDescription", at: site }
]

describe("closedId", () => {
	/** A closed relation of a name and a roster of distinct handles. */
	const liveClosed = (name: string, handles: Arr.NonEmptyReadonlyArray<string>) =>
		closed(name, handles)

	/** A closed relation: a drawn name, and a drawn roster of distinct handles. */
	const closedGen: Gen<ReturnType<typeof liveClosed>> = (source) =>
		liveClosed(
			source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
			nonEmpty(
				source.draw(
					uniqueArray(matching(regex("^[A-Za-z]{1,6}$")), (item) => item, { min: 1, max: 5 })
				),
				"a roster's handles"
			)
		)

	type ClosedIdFeature = "one handle" | "several handles" | "two names" | "one name twice"

	it.effect("names the roster, keeps the closed relation, and keeps declared handle order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the roster of the drawn name and handles, in declared order (Roster.of)"
					},
					suite: "unit/scalar/closed-id",
					draw: drawn((source) => {
						const name = source.draw(matching(regex("^[A-Z][a-z]{1,8}$")))
						return {
							name,
							other: source.draw(
								weighted([
									[1, constant(name)],
									[1, matching(regex("^[A-Z][a-z]{1,8}$"))]
								])
							),
							handles: source.draw(
								uniqueArray(matching(regex("^[A-Za-z]{1,6}$")), (item) => item, { min: 1, max: 5 })
							)
						}
					}),
					literal: Formatter.format,
					coverage: required<ClosedIdFeature>(
						["one handle", "several handles", "two names", "one name twice"],
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ name, other, handles }, c) =>
					Effect.sync(() => {
						c.note(handles.length === 1 ? "one handle" : "several handles")
						c.note(other === name ? "one name twice" : "two names")
						const [first, ...rest] = handles
						const listed: Arr.NonEmptyReadonlyArray<string> = [defined(first, "a handle"), ...rest]
						const roster = closed(name, listed)
						const field = admittedClosedId(roster)
						assert.equal(field.roster, roster)
						assert.equal(field.sql, carrierSql.code)
						assert.deepEqual(
							descOf(field),
							succeeded(describeField(admittedClosedId(roster), SourceLoc("again", []))).desc
						)
						assert.deepEqual(rosterOf(scalarOf(field)), Roster.of(parsedName(name), listed))
						assert.equal(identityOf(admittedClosedId(roster)), identityOf(field))
						if (other !== name) {
							assert.equal(
								sameScalarType(scalarOf(admittedClosedId(closed(other, listed))), scalarOf(field)),
								false
							)
						}
					})
			)
		)
	)

	/**
	 * The forgeries of a closed relation closedId refuses: each breaks one rule of what a closed relation is (kind
	 * "closed", a nonempty storable name, a nonempty roster of distinct nonempty storable string handles), or is no
	 * closed relation at all.
	 */
	type ClosedRule =
		| "not closed"
		| "empty name"
		| "no handle"
		| "repeated handle"
		| "empty handle"
		| "NUL in a handle"
		| "a non-string handle"
		| "a bare string"
		| "undefined"
	const forgeries: Arr.NonEmptyReadonlyArray<
		Corruption<ReturnType<typeof liveClosed>, "MalformedDescription", ClosedRule>
	> = [
		{
			rule: "not closed",
			from: "wild",
			weight: 1,
			sites: (live) => at({ ...live, kind: "relation" }, "kind")
		},
		{
			rule: "empty name",
			from: "wild",
			weight: 1,
			sites: (live) => at({ ...live, name: "" }, "name")
		},
		{
			rule: "no handle",
			from: "wild",
			weight: 1,
			sites: (live) => at({ ...live, handles: [] }, "handles")
		},
		{
			rule: "repeated handle",
			from: "wild",
			weight: 1,
			sites: (live) => at({ ...live, handles: [...live.handles, ...live.handles] }, "handles")
		},
		{
			rule: "empty handle",
			from: "wild",
			weight: 1,
			sites: (live) => at({ ...live, handles: [...live.handles, ""] }, "handles")
		},
		{
			rule: "NUL in a handle",
			from: "wild",
			weight: 1,
			sites: (live) =>
				at({ ...live, handles: Arr.map(live.handles, (h) => `${h}\u0000`) }, "handles")
		},
		{
			rule: "a non-string handle",
			from: "wild",
			weight: 1,
			sites: (live) => at({ ...live, handles: [...live.handles, 1] }, "handles")
		},
		{
			rule: "a bare string",
			from: "wild",
			weight: 1,
			sites: (live) => at(live.name, "the closed relation")
		},
		{
			rule: "undefined",
			from: "wild",
			weight: 1,
			sites: () => at(undefined, "the closed relation")
		}
	]

	it.effect("refuses anything that is not a closed relation", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the one rule of a closed relation each forgery breaks"
					},
					suite: "unit/scalar/closed-id-forgeries",
					draw: drawn((source) => source.draw(corrupted(source.draw(closedGen), forgeries))),
					literal: Formatter.format,
					coverage: required<CorruptedFeature<ClosedRule>>(
						["live", ...Arr.map(forgeries, (f): CorruptedFeature<ClosedRule> => `wild ${f.rule}`)],
						{ cases: 500, sense: notesOnly }
					),
					kept: [],
					/** Nine rules times the one site each breaks at, and the live relation. */
					runs: 500,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(forged, c) =>
					Effect.sync(() => {
						c.note(corruptedFeature(forged))
						if (forged.kind !== "live") {
							throwsRefused(() => admittedClosedId(forged.value), forged.refusal)
							return
						}
						const field = admittedClosedId(forged.value)
						assert.equal(field.roster, forged.value)
						assert.deepEqual(
							rosterOf(scalarOf(field)),
							Roster.of(parsedName(forged.value.name), forged.value.handles)
						)
					})
			)
		)
	)
})
