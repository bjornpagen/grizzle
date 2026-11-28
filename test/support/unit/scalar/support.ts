import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	uniqueKeys,
	weighted,
	type Weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { bigint } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { vectorMaxDimensions, integerRanges } from "#compiler/ir/carriers.ts"
import { type RosterOrder, rosterOrders } from "#compiler/ir/scalar.ts"
import { minted } from "#compiler/scalar/minted.ts"
import {
	bool,
	cidr,
	float4,
	float8,
	inet,
	int2,
	int4,
	int8,
	money,
	numeric
} from "#compiler/scalar/pg.ts"
import { isOwnedDescriptor } from "#compiler/scalar/registry.ts"
import { storedSearchDescriptor } from "#compiler/scalar/search.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import { vector } from "#compiler/scalar/vector.ts"
import { admittedClosedId, closedBuilder } from "#compiler/schema/relation.ts"
import { contractDescriptor, spanDescriptor } from "#test/support/fixtures/descriptors.ts"

/**
 * Field descriptors as a JavaScript caller writes them, drawn as sketches over PostgreSQL's plain types: every one that
 * is a descriptor itself, numeric(p, s), vector(n), uuid, a closed id over a drawn
 * roster, a span over a drawn endpoint with or without a width, and a contract over a drawn base. A sketch is what a
 * search prints and shrinks; `descriptorOf` builds the descriptor it names.
 */
export type DescriptorSketch =
	| { readonly kind: "spelling"; readonly name: Spelling }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "vector"; readonly dimensions: number }
	| { readonly kind: "uuid" }
	| {
			readonly kind: "closedId"
			readonly name: string
			readonly order: RosterOrder
			readonly handles: Arr.NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "span"
			readonly endpoint: DescriptorSketch
			readonly width: Option.Option<number | bigint>
	  }
	| { readonly kind: "contract"; readonly name: string; readonly base: DescriptorSketch }

/**
 * PostgreSQL's plain types as the package root exports them, each under its pg_type name, with the constructors
 * numeric(p, s), vector(n) and tsvector(c) and the refusals of the minting types.
 */
export const plainDescriptors = {
	int2,
	int4,
	int8,
	numeric,
	float4,
	float8,
	money,
	bool,
	inet,
	cidr,
	smallserial: minted,
	serial: minted,
	bigserial: minted,
	uuidv7: minted,
	vector,
	tsvector: storedSearchDescriptor
} as const

/** A name of one of PostgreSQL's plain types. */
export type Spelling = keyof typeof plainDescriptors

/** The names of PostgreSQL's plain types whose value is a descriptor itself, not a constructor of one. */
export const spellings: Arr.NonEmptyReadonlyArray<Spelling> = nonEmpty(
	Arr.filter(Rec.keys(plainDescriptors), (name) => isOwnedDescriptor(plainDescriptors[name])),
	"PostgreSQL's plain descriptors"
)

/** The descriptor a spelling names. */
export const spelled = (name: Spelling) =>
	defined(
		Option.getOrUndefined(Option.liftPredicate(plainDescriptors[name], isOwnedDescriptor)),
		`${name} is a descriptor`
	)

/** The descriptor a sketch names, built as a JavaScript caller builds it. */
export const descriptorOf = (sketch: DescriptorSketch): unknown => {
	switch (sketch.kind) {
		case "spelling":
			return spelled(sketch.name)
		case "numeric":
			return numeric(sketch.precision, sketch.scale)
		case "vector":
			return vector(sketch.dimensions)
		case "uuid":
			return uuidDescriptor
		case "closedId":
			return admittedClosedId(closedBuilder(sketch.name, sketch.handles, sketch.order, []))
		case "span":
			return Option.match(sketch.width, {
				onNone: () => spanDescriptor(descriptorOf(sketch.endpoint)),
				onSome: (width) => spanDescriptor(descriptorOf(sketch.endpoint), width)
			})
		case "contract":
			return contractDescriptor(sketch.name, descriptorOf(sketch.base))
	}
}

/**
 * The span carrier a sketch is an endpoint of, by the rule the README states: integer or bigint, or a contract over
 * one, as int4range or int8range, and nothing else is one.
 */
export const spanCarrierOf = (sketch: DescriptorSketch): "range4" | "range8" | undefined => {
	switch (sketch.kind) {
		case "spelling": {
			const sql = spelled(sketch.name).sql
			return sql === "int4" ? "range4" : sql === "int8" ? "range8" : undefined
		}
		case "contract":
			return spanCarrierOf(sketch.base)
		case "numeric":
		case "vector":
		case "uuid":
		case "closedId":
		case "span":
			return undefined
	}
}

/**
 * The type a sketch names, by its parts alone: two descriptors are one type exactly when their keys are equal. A
 * spelling names the SQL type PostgreSQL stores it as (which the catalog suite holds each spelling to), whatever its
 * writing; a typmod, a roster, a width and
 * a contract's name are each part of the type, a roster by its name, its order and its handles in that order, an
 * unordered roster's a set, sorted.
 */
export const typeKeyOf = (sketch: DescriptorSketch): string => {
	switch (sketch.kind) {
		case "spelling":
			return spelled(sketch.name).sql
		case "numeric":
			return `numeric(${sketch.precision},${sketch.scale === 0 ? 0 : sketch.scale})`
		case "vector":
			return `vector(${sketch.dimensions})`
		case "uuid":
			return "uuid"
		case "closedId":
			return `closedId ${sketch.name} ${sketch.order} [${Arr.join(
				sketch.order === "ordered" ? sketch.handles : Arr.sort(sketch.handles, Order.String),
				","
			)}]`
		case "span":
			return `span ${typeKeyOf(sketch.endpoint)} ${Option.match(sketch.width, {
				onNone: () => "unbounded",
				onSome: (width) => String(BigInt(width))
			})}`
		case "contract":
			return `contract ${sketch.name} over ${typeKeyOf(sketch.base)}`
	}
}

const nameGen: Gen<string> = matching(regex("^[A-Z][a-z]{1,8}$"))

const handlesGen: Gen<Arr.NonEmptyReadonlyArray<string>> = map(
	uniqueKeys(matching(regex("^[A-Za-z]{1,6}$")), { min: 1, max: 5 }),
	(handles) => nonEmpty(handles, "a roster's handles")
)

/** A span's width for an endpoint of `carrier`: a number for int4range, a bigint for int8range, near 1 and the end. */
const widthGen = (carrier: "range4" | "range8"): Gen<Option.Option<number | bigint>> => {
	const [, int4Greatest] = integerRanges.int4
	const [, int8Greatest] = integerRanges.int8
	return option(
		carrier === "range4"
			? weighted<number | bigint>([
					[1, int(1, 3)],
					[1, int(Number(int4Greatest) - 2, Number(int4Greatest))]
				])
			: weighted<number | bigint>([
					[1, bigint(1n, 3n)],
					[1, bigint(int8Greatest - 2n, int8Greatest)]
				])
	)
}

/** The spellings an endpoint may be: those spanCarrierOf admits. */
const endpointSpellings = nonEmpty(
	Arr.filter(spellings, (name) => spanCarrierOf({ kind: "spelling", name }) !== undefined),
	"the spellings a span is over"
)

const spellingOf = (names: Arr.NonEmptyReadonlyArray<Spelling>): Gen<DescriptorSketch> =>
	map(element(names), (name): DescriptorSketch => ({ kind: "spelling", name }))

/** A domain named by a drawn name over a base `base` draws. */
const contractOf =
	(base: Gen<DescriptorSketch>): Gen<DescriptorSketch> =>
	(source) => ({
		kind: "contract",
		name: source.draw(nameGen),
		base: source.draw(base)
	})

/** An endpoint a span admits: an integer or bigint spelling, or a contract over one. */
export const endpointGen = (depth: number): Gen<DescriptorSketch> =>
	depth > 0
		? weighted<DescriptorSketch>([
				[3, spellingOf(endpointSpellings)],
				[1, contractOf(endpointGen(depth - 1))]
			])
		: spellingOf(endpointSpellings)

/** A numeric typmod near numerictypmodin's bounds or small. */
const numericGen: Gen<DescriptorSketch> = (source) => ({
	kind: "numeric",
	precision: source.draw(
		weighted([
			[1, int(1, 6)],
			[1, int(numericMaxPrecision - 2, numericMaxPrecision)]
		])
	),
	scale: source.draw(
		weighted([
			[1, int(-2, 6)],
			[1, int(numericMinScale, numericMinScale + 2)],
			[1, int(numericMaxScale - 2, numericMaxScale)]
		])
	)
})

const vectorGen: Gen<DescriptorSketch> = map(
	weighted([
		[1, int(1, 4)],
		[1, int(vectorMaxDimensions - 2, vectorMaxDimensions)]
	]),
	(dimensions): DescriptorSketch => ({ kind: "vector", dimensions })
)

/**
 * A roster's sketch: its name, its order and its handles, a zone roster's each a zone's Area/Location name, its handle
 * under Etc/ (closed.zones admits no name of one component).
 */
const closedIdGen: Gen<DescriptorSketch> = (source) => {
	const order = source.draw(element(rosterOrders))
	const handles = source.draw(handlesGen)
	return {
		kind: "closedId",
		name: source.draw(nameGen),
		order,
		handles: order === "zones" ? Arr.map(handles, (h) => `Etc/${h}`) : handles
	}
}

const spanGen =
	(depth: number): Gen<DescriptorSketch> =>
	(source) => {
		const endpoint = source.draw(endpointGen(depth))
		const carrier = defined(spanCarrierOf(endpoint), "an endpoint's span carrier")
		return { kind: "span", endpoint, width: source.draw(widthGen(carrier)) }
	}

/**
 * A descriptor the namespace admits over the spellings `names`, its contracts nested `depth` deep at most.
 */
const descriptorOver = (
	names: Arr.NonEmptyReadonlyArray<Spelling>,
	depth: number
): Gen<DescriptorSketch> => {
	const leaves: Arr.NonEmptyReadonlyArray<Weighted<DescriptorSketch>> = [
		[4, spellingOf(names)],
		[2, numericGen],
		[2, vectorGen],
		[1, constant<DescriptorSketch>({ kind: "uuid" })],
		[1, closedIdGen],
		[2, spanGen(depth)]
	]
	return depth > 0
		? weighted<DescriptorSketch>([...leaves, [2, contractOf(descriptorOver(spellings, depth - 1))]])
		: weighted<DescriptorSketch>(leaves)
}

/** A descriptor the namespace admits, contracts nested `depth` deep at most. */
export const descriptorGen = (depth: number): Gen<DescriptorSketch> =>
	descriptorOver(spellings, depth)
