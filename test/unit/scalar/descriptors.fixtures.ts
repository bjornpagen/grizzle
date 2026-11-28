/** What the properties of descriptors.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	subset,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import {
	type Broken,
	corrupted,
	type CorruptedFeature,
	type Corruption,
	type Drawn,
	type DrawnFeature,
	lsw,
	WILD_KINDS,
	type Wild,
	wild
} from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { bigint } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Record } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { vectorMaxDimensions, integerRanges } from "#compiler/ir/carriers.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { type RosterOrder, rosterOrders, type ScalarType } from "#compiler/ir/scalar.ts"
import { type Described, describeField } from "#compiler/scalar/registry.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { succeeded } from "#test/support/assert.ts"
import { fieldIdentity } from "#test/support/fixtures/descriptors.ts"
import {
	type DescriptorSketch,
	descriptorGen,
	endpointGen
} from "#test/support/unit/scalar/support.ts"
import { plainSketches } from "#test/unit/scalar/descriptors.dictionary.ts"

/** int4's greatest value, the greatest width an integer endpoint's span admits. */
const int4Greatest = Number(integerRanges.int4[1])

/** Every object's keys in order, at every depth. */
export const keyOrder = (value: unknown): unknown =>
	Arr.isArray(value)
		? Arr.map(value, keyOrder)
		: typeof value === "object" && value !== null
			? Arr.map(Record.toEntries(value), ([key, item]) => [key, keyOrder(item)])
			: undefined

/** What describeField reads a value as. */
export const described = (value: unknown): Described =>
	succeeded(describeField(value, SourceLoc("test", [])))

/** A descriptor's Description. */
export const descOf = (value: unknown): FieldDesc => described(value).desc

/** A descriptor's ScalarType. */
export const scalarOf = (value: unknown): ScalarType => described(value).scalar

/** A descriptor's field identity text. */
export const identityOf = (value: unknown): string => succeeded(fieldIdentity(value))

/** Every pair of distinct plain descriptors, the first before the second in the namespace's order. */
export const plainPairGen = (source: Source) => {
	const [x, y] = source.draw(subset(plainSketches, { min: 2, max: 2 }))
	return [defined(x, "a descriptor"), defined(y, "a descriptor")] as const
}

/** Two descriptors: one drawn twice, one time in three, or two drawn apart. */
export const typePairGen = (source: Source) => {
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
}

/** What two drawn descriptors came to. */
export type TypeFeature = "one type" | "two types of one kind" | "two types"

/** What a descriptor of each kind of sketch reached. */
export type KindFeature = DescriptorSketch["kind"]

export const kindFeatures: Arr.NonEmptyReadonlyArray<KindFeature> = [
	"spelling",
	"numeric",
	"vector",
	"uuid",
	"closedId",
	"span",
	"contract"
]

/** Every typmod search notes whether the call was admitted or refused, and what each drawn argument was. */
export type TypmodFeature = "admitted" | "refused" | DrawnFeature<never>

/**
 * For each wild kind, the case `caseOf` builds around an argument of that kind alone: what a typmod search aims at the
 * kind while no case has drawn it.
 */
const wildAims = <T, A>(
	caseOf: (argument: Gen<Drawn<T, never>>) => Gen<A>
): ReadonlyArray<readonly [TypmodFeature, Gen<A>]> =>
	Arr.map(WILD_KINDS, (kind): readonly [TypmodFeature, Gen<A>] => [
		`wild ${kind}`,
		caseOf(map(wild([kind]), (drawn): Drawn<T, never> => ({ kind: "wild", wild: drawn })))
	])

export const isInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value)

/** An integer at or beside a typmod's bound, and the feature its search notes on reaching it. */
interface Bound<F extends string> {
	readonly feature: F
	readonly value: number
}

/**
 * A typmod's integer argument: half the draws one of its bounds and their neighbours, the rest from `around`, so the
 * search tries every integer near a bound however wide `around` is.
 */
const nearBounds = <F extends string>(
	around: Gen<number>,
	bounds: Arr.NonEmptyReadonlyArray<Bound<F>>
): Gen<number> =>
	weighted<number>([
		[1, around],
		[1, element(Arr.map(bounds, (bound) => bound.value))]
	])

/** The bound features a live argument reached: the bounds it equals. */
export const boundsReached = <F extends string>(
	bounds: ReadonlyArray<Bound<F>>,
	drawnArgument: Drawn<number, never>
): ReadonlyArray<F> =>
	drawnArgument.kind === "live"
		? Arr.map(
				Arr.filter(bounds, (bound) => bound.value === drawnArgument.value),
				(bound) => bound.feature
			)
		: []

/** numeric's precision bounds: none below 1, numericMaxPrecision the greatest. */
export const precisionBounds = [
	{ feature: "precision 0", value: 0 },
	{ feature: "precision 1", value: 1 },
	{ feature: "the greatest precision", value: numericMaxPrecision },
	{ feature: "one past the greatest precision", value: numericMaxPrecision + 1 }
] as const satisfies Arr.NonEmptyReadonlyArray<Bound<string>>

/** numeric's scale bounds: numericMinScale the least and numericMaxScale the greatest. */
export const scaleBounds = [
	{ feature: "one under the least scale", value: numericMinScale - 1 },
	{ feature: "the least scale", value: numericMinScale },
	{ feature: "the greatest scale", value: numericMaxScale },
	{ feature: "one past the greatest scale", value: numericMaxScale + 1 }
] as const satisfies Arr.NonEmptyReadonlyArray<Bound<string>>

/** pgvector's dimension bounds: none below 1, vectorMaxDimensions the greatest, and their neighbours. */
export const dimensionBounds = [
	{ feature: "no dimension", value: 0 },
	{ feature: "one dimension", value: 1 },
	{ feature: "one under the greatest dimensions", value: vectorMaxDimensions - 1 },
	{ feature: "the greatest dimensions", value: vectorMaxDimensions },
	{ feature: "one past the greatest dimensions", value: vectorMaxDimensions + 1 },
	{ feature: "two past the greatest dimensions", value: vectorMaxDimensions + 2 }
] as const satisfies Arr.NonEmptyReadonlyArray<Bound<string>>

/**
 * numerictypmodin's rule: precision 1-numericMaxPrecision and scale numericMinScale-numericMaxScale, both integers and
 * both given: no numeric is without its scale. -0 is the integer 0.
 */
export const admittedNumericTypmod = (
	precision: unknown,
	scale: unknown
): { readonly precision: number; readonly scale: number } | undefined =>
	isInteger(precision) &&
	precision >= 1 &&
	precision <= numericMaxPrecision &&
	isInteger(scale) &&
	scale >= numericMinScale &&
	scale <= numericMaxScale
		? { precision, scale: scale === 0 ? 0 : scale }
		: undefined

/** What a numeric(p, s) call reached: its verdict, each drawn argument, a wrong arity, and each bound. */
export type NumericTypmodFeature =
	| TypmodFeature
	| "arity"
	| (typeof precisionBounds)[number]["feature"]
	| (typeof scaleBounds)[number]["feature"]

/** A numeric(p, s) call whose precision `precision` draws: a scale near its bounds or wild, and how many it passes. */
const numericTypmodCaseOf =
	(precision: Gen<Drawn<number, never>>) =>
	(source: Source): readonly [Drawn<number, never>, Drawn<number, never>, number] =>
		[
			source.draw(precision),
			source.draw(
				lsw<number>({
					live: nearBounds(int(-1100, 1100), scaleBounds),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			),
			source.draw(int(0, 3))
		] as const

/**
 * A numeric(p, s) call: a precision and a scale near their bounds or wild, and how many of them it passes; aimed at
 * each wild kind still pending, a precision of that kind.
 */
export const numericTypmodSpace = aimed<
	readonly [Drawn<number, never>, Drawn<number, never>, number],
	NumericTypmodFeature
>(
	numericTypmodCaseOf(
		lsw<number>({
			live: nearBounds(int(-1100, 1100), precisionBounds),
			stale: Option.none(),
			wild: WILD_KINDS
		})
	),
	wildAims(numericTypmodCaseOf)
)

/** What a vector(n) call reached: its verdict, its drawn dimensions, and each bound. */
export type VectorFeature = TypmodFeature | (typeof dimensionBounds)[number]["feature"]

/** A vector(n) call whose dimensions `dimensions` draws, and wild arguments past them, or none. */
const vectorCaseOf =
	(dimensions: Gen<Drawn<number, never>>) =>
	(source: Source): readonly [Drawn<number, never>, Option.Option<ReadonlyArray<Wild>>] =>
		[
			source.draw(dimensions),
			source.draw(option(array(wild(WILD_KINDS), { min: 1, max: 2 })))
		] as const

/**
 * A vector(n) call: dimensions near their bounds or wild, and wild arguments past them, or none; aimed at each wild
 * kind still pending, dimensions of that kind.
 */
export const vectorSpace = aimed<
	readonly [Drawn<number, never>, Option.Option<ReadonlyArray<Wild>>],
	VectorFeature
>(
	vectorCaseOf(
		lsw<number>({
			live: nearBounds(int(-2, vectorMaxDimensions + 2), dimensionBounds),
			stale: Option.none(),
			wild: WILD_KINDS
		})
	),
	wildAims(vectorCaseOf)
)

/**
 * The widths each span carrier admits, as the README states them: an integer endpoint's are JavaScript
 * integers from 1 to 2^31 - 1, a bigint endpoint's bigints from 1 to 2^63 - 1.
 */
export const admits: { readonly [C in "range4" | "range8"]: (width: number | bigint) => boolean } =
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

/** What a span(endpoint, width) call reached: its verdict, its drawn width, and its endpoint's carrier. */
export type SpanWidthFeature = TypmodFeature | "endpoint range4" | "endpoint range8"

/** A span(endpoint, width) call whose width `width` draws: an endpoint, and how many arguments it passes. */
const spanWidthCaseOf =
	(width: Gen<Drawn<number | bigint, never>>) =>
	(source: Source): readonly [DescriptorSketch, Drawn<number | bigint, never>, number] =>
		[source.draw(endpointGen(2)), source.draw(width), source.draw(int(1, 3))] as const

/**
 * A span(endpoint, width) call: an endpoint, a width near each bound or wild, and how many arguments it passes; aimed at
 * each wild kind still pending, a width of that kind.
 */
export const spanWidthSpace = aimed<
	readonly [DescriptorSketch, Drawn<number | bigint, never>, number],
	SpanWidthFeature
>(
	spanWidthCaseOf(
		lsw<number | bigint>({
			live: widths,
			stale: Option.none(),
			wild: WILD_KINDS
		})
	),
	wildAims(spanWidthCaseOf)
)

/** What an endpoint came to: a span of either carrier, or a refusal. */
export type EndpointFeature = "range4" | "range8" | "refused"

const at = (value: unknown, site: string): ReadonlyArray<Broken<"MalformedDescription">> => [
	{ value, refusal: "MalformedDescription", at: site }
]

/**
 * A closed relation of a name, an order and a roster of distinct handles, a zone roster's each under Etc/, the
 * Area/Location form closed.zones admits.
 */
const liveClosed = (name: string, order: RosterOrder, handles: Arr.NonEmptyReadonlyArray<string>) =>
	closedBuilder(name, order === "zones" ? Arr.map(handles, (h) => `Etc/${h}`) : handles, order, [])

/** A closed relation: a drawn name, a drawn order, and a drawn roster of distinct handles. */
const closedGen: Gen<ReturnType<typeof liveClosed>> = (source) =>
	liveClosed(
		source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
		source.draw(element(rosterOrders)),
		nonEmpty(
			source.draw(uniqueKeys(matching(regex("^[A-Za-z]{1,6}$")), { min: 1, max: 5 })),
			"a roster's handles"
		)
	)

/** What a closedId call reached: one handle or several, its name and another or the same twice. */
export type ClosedIdFeature = "one handle" | "several handles" | "two names" | "one name twice"

/** A closed relation's name, another name or the same, and its handles. */
export const closedIdCaseGen = (source: Source) => {
	const name = source.draw(matching(regex("^[A-Z][a-z]{1,8}$")))
	return {
		name,
		other: source.draw(
			weighted([
				[1, constant(name)],
				[1, matching(regex("^[A-Z][a-z]{1,8}$"))]
			])
		),
		handles: source.draw(uniqueKeys(matching(regex("^[A-Za-z]{1,6}$")), { min: 1, max: 5 }))
	}
}

/**
 * The forgeries of a closed relation closedId refuses: each breaks one rule of what a closed relation is (kind
 * "closed", a nonempty storable name, a roster order, a roster of distinct nonempty storable string handles, none
 * among them),
 * or is no closed relation at all.
 */
export type ClosedRule =
	| "not closed"
	| "no roster order"
	| "empty name"
	| "repeated handle"
	| "empty handle"
	| "NUL in a handle"
	| "a non-string handle"
	| "a bare string"
	| "undefined"

export const forgeries: Arr.NonEmptyReadonlyArray<
	Corruption<ReturnType<typeof liveClosed>, "MalformedDescription", ClosedRule>
> = [
	{
		rule: "not closed",
		from: "wild",
		weight: 1,
		sites: (live) => at({ ...live, kind: "relation" }, "kind")
	},
	{
		rule: "no roster order",
		from: "wild",
		weight: 1,
		sites: (live) => at({ ...live, order: "sorted" }, "order")
	},
	{
		rule: "empty name",
		from: "wild",
		weight: 1,
		sites: (live) => at({ ...live, name: "" }, "name")
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
		sites: (live) => at({ ...live, handles: Arr.map(live.handles, (h) => `${h}\u0000`) }, "handles")
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

/** A closed relation, or one of its forgeries. */
export const forgedGen = (source: Source) =>
	source.draw(corrupted(source.draw(closedGen), forgeries))

/** What a forged closed relation was: live, or the rule it broke. */
export type ForgeryFeature = CorruptedFeature<ClosedRule>
