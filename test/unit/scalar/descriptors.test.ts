import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { element, int, map, oneOf, uniqueArray } from "@grizzle/testing/gen"
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
	WILD_KINDS
} from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc, type FieldDesc } from "#compiler/ir/desc.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { numericMaxPrecision, numericMaxScale, numericMinScale } from "#compiler/ir/scalar.ts"
import {
	contractOf,
	rosterOf,
	sameScalarType,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { admittedClosedId } from "#compiler/scalar/closed-id.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { carrierSql, type Described, describeField } from "#compiler/scalar/registry.ts"
import { bigserial, serial, smallserial } from "#compiler/scalar/serial.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { checkNumericTypmod } from "#compiler/scalar/values/decimal.ts"
import { admitVectorDimensions } from "#compiler/scalar/vector.ts"
import { closed } from "#compiler/schema/api.ts"
import { assert, defined, lacks, nonEmpty, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	contractDescriptor,
	fieldIdentity,
	spanDescriptor
} from "#test/support/fixtures/descriptors.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"

import { regex } from "arkregex"
import { argumentsOf } from "#test/support/list.ts"
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

/** Every spelling of one PostgreSQL type, canonical name first. */
const aliasGroups = [
	["smallint", [pgDescriptors.smallint, pgDescriptors.int2]],
	["integer", [pgDescriptors.integer, pgDescriptors.int, pgDescriptors.int4]],
	["bigint", [pgDescriptors.bigint, pgDescriptors.int8]],
	[
		"real",
		[pgDescriptors.real, pgDescriptors.float4, ...Arr.makeBy(24, (i) => pgDescriptors.float(i + 1))]
	],
	[
		"double precision",
		[
			pgDescriptors["double precision"],
			pgDescriptors.float8,
			pgDescriptors.float,
			...Arr.makeBy(29, (i) => pgDescriptors.float(i + 25))
		]
	],
	["boolean", [pgDescriptors.boolean, pgDescriptors.bool]],
	["smallserial", [pgDescriptors.smallserial, pgDescriptors.serial2, smallserial]],
	["serial", [pgDescriptors.serial, pgDescriptors.serial4, serial]],
	["bigserial", [pgDescriptors.bigserial, pgDescriptors.serial8, bigserial]]
] as const satisfies ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>

describe("alias identity", () => {
	it.effect(
		"makes every spelling of a type one descriptor, one Description and one ScalarType",
		(ctx) =>
			Effect.gen(function* () {
				const spellings = Arr.flatMap(aliasGroups, ([name, group]) => {
					const [first, ...rest] = group
					return Arr.map(rest, (alias) => ({ name, first, alias }))
				})
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/scalar/alias-identity",
							generator: element(nonEmpty(spellings, "the aliases")),
							literal: Formatter.format,
							limit: spellings.length,
							coverage: requiredInSpace<(typeof aliasGroups)[number][0]>(
								Arr.map(aliasGroups, ([name]) => name)
							),
							caseHang
						},
						({ name, first, alias }, c) =>
							Effect.sync(() => {
								c.note(name)
								assert.equal(alias, first, name)
								assert.equal(identityOf(alias), identityOf(first), name)
								assert.equal(sameScalarType(scalarOf(alias), scalarOf(first)), true, name)
							})
					)
				)
			})
	)

	it.effect("keeps distinct types distinct", (ctx) =>
		Effect.gen(function* () {
			const distinct: ReadonlyArray<unknown> = [
				pgDescriptors.smallint,
				pgDescriptors.integer,
				pgDescriptors.bigint,
				pgDescriptors.numeric(5, 2),
				pgDescriptors.numeric(5, 3),
				pgDescriptors.numeric(6, 2),
				pgDescriptors.real,
				pgDescriptors["double precision"],
				pgDescriptors.money,
				pgDescriptors.boolean,
				pgDescriptors.smallserial,
				pgDescriptors.serial,
				pgDescriptors.bigserial,
				uuidDescriptor,
				pgDescriptors.vector(3),
				pgDescriptors.vector(4),
				pgDescriptors.vector(2),
				pgDescriptors.vector(16000),
				spanDescriptor(pgDescriptors.integer),
				spanDescriptor(pgDescriptors.bigint),
				spanDescriptor(pgDescriptors.bigint, 15n)
			]
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/distinct-types",
						/** Every pair of distinct positions, the first below the second. */
						generator: (source) => {
							const i = source.draw(int(0, distinct.length - 2))
							return [i, source.draw(int(i + 1, distinct.length - 1))] as const
						},
						literal: Formatter.format,
						limit: (distinct.length * (distinct.length - 1)) / 2,
						coverage: requiredInSpace<"a pair">(["a pair"]),
						caseHang
					},
					([i, j], c) =>
						Effect.sync(() => {
							c.note("a pair")
							assert.notEqual(identityOf(distinct[i]), identityOf(distinct[j]), `${i} and ${j}`)
						})
				)
			)
		})
	)

	it.effect(
		"builds every descriptor's Description through its decoder, and a ScalarType the full decoder makes exactly",
		(ctx) =>
			Effect.gen(function* () {
				const fields = nonEmpty<unknown>(
					[
						...Arr.flatMap(aliasGroups, ([, group]): ReadonlyArray<unknown> => group),
						pgDescriptors.numeric(1000, -1000),
						pgDescriptors.numeric(1, 1000),
						pgDescriptors.money,
						uuidDescriptor,
						pgDescriptors.vector(16000),
						pgDescriptors.vector(2),
						spanDescriptor(pgDescriptors.int4),
						spanDescriptor(pgDescriptors.int8, 1n),
						spanDescriptor(pgDescriptors.integer, 2147483647),
						admittedClosedId({ kind: "closed", name: "Kind", handles: ["Automatic", "Manual"] }),
						contractDescriptor("Price", pgDescriptors.numeric(10, 2)),
						contractDescriptor(
							"Pick",
							admittedClosedId({ kind: "closed", name: "Kind", handles: ["Automatic", "Manual"] })
						),
						contractDescriptor("Ticks", contractDescriptor("Instant", pgDescriptors.bigint)),
						spanDescriptor(contractDescriptor("Instant", pgDescriptors.bigint), 5n),
						contractDescriptor("Window", spanDescriptor(pgDescriptors.int4))
					],
					"the descriptors"
				)
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/scalar/descriptor-decode",
							generator: element(fields),
							literal: Formatter.format,
							limit: fields.length,
							coverage: requiredInSpace<"a descriptor">(["a descriptor"]),
							caseHang
						},
						(field, c) =>
							Effect.sync(() => {
								c.note("a descriptor")
								const { desc, scalar } = described(field)
								assert.deepEqual(succeeded(decodeDesc("field", desc)), desc)
								const decoded = succeeded(decodeScalarType(structuredClone(scalar)))
								assert.deepEqual(decoded, scalar)
								assert.deepEqual(keyOrder(decoded), keyOrder(scalar))
								assert.equal(Object.isFrozen(field), true)
							})
					)
				)
				assert.equal(Object.isFrozen(pgDescriptors), true)
			})
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

/** How many arguments a numeric call passes: none, the precision, both, or a third. */
type Arity = 0 | 1 | 2 | 3

describe("typmod validation", () => {
	it.effect(
		"agrees with the carrier's numeric typmod rule on every integer pair, and refuses every other argument and arity",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
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
									source.draw(element<Arity>([2, 1, 0, 3]))
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
				exhaust(
					{
						suite: "unit/scalar/float-typmod",
						generator: oneOf<unknown>([int(-4, 59), element<unknown>([1.5, Number.NaN, "24"])]),
						literal: Formatter.format,
						/** The space: 64 integers and 3 other arguments. */
						limit: 67,
						coverage: requiredInSpace<"admitted" | "refused">(["admitted", "refused"]),
						caseHang
					},
					(precision, c) =>
						Effect.sync(() => {
							if (!isInteger(precision) || precision < 1 || precision > 53) {
								c.note("refused")
								throwsRefused(() => pgDescriptors.float(precision), "MalformedDescription")
							} else {
								c.note("admitted")
								assert.equal(
									pgDescriptors.float(precision),
									precision <= 24 ? pgDescriptors.real : pgDescriptors["double precision"]
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
					suite: "unit/scalar/vector-dims",
					draw: drawn(
						(source) =>
							[
								source.draw(
									lsw<number>({
										live: int(-2, 16_002),
										stale: Option.none(),
										wild: WILD_KINDS
									})
								),
								source.draw(
									element<ReadonlyArray<unknown>>([
										[],
										[{ space: "S" }],
										[{ space: "S", metric: "l2" }],
										[{}],
										["S"]
									])
								)
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
				([d, extra], c) =>
					Effect.sync(() => {
						c.note(drawnFeature(d))
						const dimensions = passed(d)
						if (
							extra.length === 0 &&
							isInteger(dimensions) &&
							dimensions >= 1 &&
							dimensions <= 16000
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
				 * Each endpoint with its width's host kind and its type's maximum: integer's widths are JavaScript integers up to
				 * 2^31 - 1, bigint's are bigints up to 2^63 - 1.
				 */
				const endpoints: Arr.NonEmptyReadonlyArray<{
					readonly name: "integer" | "bigint"
					readonly endpoint: unknown
					readonly admits: (width: number | bigint) => boolean
				}> = [
					{
						name: "integer",
						endpoint: pgDescriptors.integer,
						admits: (w) => isInteger(w) && w >= 1 && w <= 2 ** 31 - 1
					},
					{
						name: "bigint",
						endpoint: pgDescriptors.bigint,
						admits: (w) => typeof w === "bigint" && w >= 1n && w <= 2n ** 63n - 1n
					}
				]
				/** Widths of both host kinds around 0 and around each endpoint type's maximum. */
				const widths = oneOf<number | bigint>([
					int(-2, 2),
					int(2 ** 31 - 3, 2 ** 31 + 1),
					bigint(-2n, 2n),
					bigint(2n ** 63n - 3n, 2n ** 63n + 1n),
					bigint(2n ** 31n - 3n, 2n ** 31n + 1n),
					int(2 ** 53 - 3, 2 ** 53 - 1)
				])
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/scalar/span-width",
							draw: drawn(
								(source) =>
									[
										source.draw(element(endpoints)),
										source.draw(
											lsw<number | bigint>({
												live: widths,
												stale: Option.none(),
												wild: WILD_KINDS
											})
										),
										source.draw(element<2 | 1 | 3>([2, 1, 3]))
									] as const
							),
							literal: Formatter.format,
							coverage: required<TypmodFeature | "endpoint integer" | "endpoint bigint">(
								[
									"admitted",
									"refused",
									...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`),
									"endpoint integer",
									"endpoint bigint"
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
						([e, d, arity], c) =>
							Effect.sync(() => {
								c.note(`endpoint ${e.name}`)
								c.note(drawnFeature(d))
								const width = passed(d)
								if (arity === 3) {
									c.note("refused")
									throwsRefused(() => spanDescriptor(e.endpoint, width, 0), "MalformedDescription")
									return
								}
								/** An undefined width is the optional width left out: span(endpoint). */
								const given = arity === 2 ? width : undefined
								if (given === undefined) {
									c.note("admitted")
									assert.equal(
										spanOf(scalarOf(spanDescriptor(e.endpoint, given)))?.width,
										undefined
									)
								} else if (
									(typeof given === "number" || typeof given === "bigint") &&
									e.admits(given)
								) {
									c.note("admitted")
									assert.equal(
										spanOf(scalarOf(spanDescriptor(e.endpoint, given)))?.width,
										BigInt(given)
									)
								} else {
									c.note("refused")
									throwsRefused(() => spanDescriptor(e.endpoint, given), "MalformedDescription")
								}
							})
					)
				)
			})
	)
})

describe("span endpoint eligibility", () => {
	const Cents = contractDescriptor("Cents", pgDescriptors.bigint, (v: ScalarTerm) => v.ge(0n))
	const Day = contractDescriptor("Day", pgDescriptors.integer)
	const Small = contractDescriptor("Small", pgDescriptors.smallint)

	it.effect(
		"admits integer, bigint and contracts over them, as int4range and int8range, and refuses every other endpoint",
		(ctx) =>
			Effect.gen(function* () {
				const eligible: Arr.NonEmptyReadonlyArray<readonly [unknown, "range4" | "range8"]> = [
					[pgDescriptors.integer, "range4"],
					[pgDescriptors.int, "range4"],
					[pgDescriptors.int4, "range4"],
					[pgDescriptors.bigint, "range8"],
					[pgDescriptors.int8, "range8"],
					[Cents, "range8"],
					[Day, "range4"],
					[contractDescriptor("Outer", Cents), "range8"]
				]
				const ineligible: Arr.NonEmptyReadonlyArray<unknown> = [
					pgDescriptors.numeric(10, 2),
					pgDescriptors.decimal(10, 0),
					pgDescriptors.real,
					pgDescriptors.float(30),
					pgDescriptors["double precision"],
					pgDescriptors.boolean,
					uuidDescriptor,
					pgDescriptors.vector(3),
					Small,
					spanDescriptor(pgDescriptors.integer),
					admittedClosedId({ kind: "closed", name: "K", handles: ["a"] })
				]
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/scalar/span-endpoints",
							generator: oneOf<readonly [unknown, "range4" | "range8" | "refused"]>([
								element(eligible),
								map(element(ineligible), (e): readonly [unknown, "refused"] => [e, "refused"])
							]),
							literal: Formatter.format,
							limit: eligible.length + ineligible.length,
							coverage: requiredInSpace<"range4" | "range8" | "refused">([
								"range4",
								"range8",
								"refused"
							]),
							caseHang
						},
						([endpoint, expected], c) =>
							Effect.sync(() => {
								c.note(expected)
								if (expected === "refused") {
									throwsRefused(() => spanDescriptor(endpoint), "UnsupportedOperation")
									return
								}
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
			})
	)
})

describe("serial family", () => {
	it.effect(
		"is a generation declaration over its integer type, discriminated from IntegerLike",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/serials",
						generator: element<
							readonly [
								(
									| typeof pgDescriptors.smallserial
									| typeof pgDescriptors.serial
									| typeof pgDescriptors.bigserial
								),
								"int2" | "int4" | "int8",
								unknown
							]
						>([
							[pgDescriptors.smallserial, "int2", pgDescriptors.smallint] as const,
							[pgDescriptors.serial, "int4", pgDescriptors.integer] as const,
							[pgDescriptors.bigserial, "int8", pgDescriptors.bigint] as const
						]),
						literal: Formatter.format,
						limit: 3,
						coverage: requiredInSpace<"int2" | "int4" | "int8">(["int2", "int4", "int8"]),
						caseHang
					},
					([field, carrier, plain], c) =>
						Effect.sync(() => {
							c.note(carrier)
							assert.equal(field.generated, "always")
							const t = scalarOf(field)
							assert.ok("serial" in t)
							assert.equal(t.serial, "always")
							assert.equal(t.carrier, carrier)
							lacks(t.caps, "spanEndpoint")
							assert.ok(!("serial" in scalarOf(plain)), "the plain type is no serial")
							assert.notEqual(identityOf(field), identityOf(plain))
						})
				)
			)
	)
})

const at = (value: unknown, site: string): ReadonlyArray<Broken<"MalformedDescription">> => [
	{ value, refusal: "MalformedDescription", at: site }
]

describe("closedId", () => {
	const Kind = closed("Kind", ["Manual", "Automatic"])

	it.effect("names the roster, keeps the closed relation, and keeps declared handle order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/scalar/closed-id",
					draw: drawn((source) => ({
						name: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
						other: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
						handles: source.draw(
							uniqueArray(
								matching(regex("^[A-Za-z]{1,6}$")),
								(item) => item,
								{ min: 1, max: 5 },
								20
							)
						)
					})),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ name, other, handles }) =>
					Effect.sync(() => {
						const [first, ...rest] = handles
						const listed: Arr.NonEmptyReadonlyArray<string> = [defined(first, "a handle"), ...rest]
						const roster = closed(name, listed)
						const field = admittedClosedId(roster)
						assert.equal(field.roster, roster)
						assert.equal(field.sql, carrierSql.enum)
						assert.deepEqual(
							descOf(field),
							succeeded(describeField(admittedClosedId(roster), SourceLoc("again", []))).desc
						)
						assert.deepEqual(rosterOf(scalarOf(field)), {
							closed: parsedName(name),
							handles: listed
						})
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
		Corruption<typeof Kind, "MalformedDescription", ClosedRule>
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
					suite: "unit/scalar/closed-id-forgeries",
					draw: drawn(corrupted(Kind, forgeries)),
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
						assert.equal(field.roster, Kind)
						assert.deepEqual(rosterOf(scalarOf(field)), {
							closed: parsedName(Kind.name),
							handles: Kind.handles
						})
					})
			)
		)
	)
})
