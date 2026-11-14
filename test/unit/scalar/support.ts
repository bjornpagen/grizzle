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
import { Array as Arr, Option, Record as Rec } from "effect"
import {
	integerRanges,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	vectorMaxDimensions
} from "#compiler/ir/carriers.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { isOwnedDescriptor } from "#compiler/scalar/registry.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { closed } from "#compiler/schema/api.ts"
import { admittedClosedId, writingOf } from "#compiler/schema/relation.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import { floatOf } from "#test/support/descriptors.ts"
import { contractDescriptor, spanDescriptor } from "#test/support/fixtures/descriptors.ts"

/**
 * Field descriptors as a JavaScript caller writes them, drawn as sketches over the whole namespace: every spelling of
 * the pg namespace that is a descriptor itself, float(p), numeric(p, s), vector(n), uuid, a closed id over a drawn
 * roster, a span over a drawn endpoint with or without a width, and a contract over a drawn base. A sketch is what a
 * search prints and shrinks; `descriptorOf` builds the descriptor it names.
 */
export type DescriptorSketch =
	| { readonly kind: "spelling"; readonly name: Spelling }
	| { readonly kind: "float"; readonly precision: number }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "vector"; readonly dimensions: number }
	| { readonly kind: "uuid" }
	| {
			readonly kind: "closedId"
			readonly name: string
			readonly handles: Arr.NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "span"
			readonly endpoint: DescriptorSketch
			readonly width: Option.Option<number | bigint>
	  }
	| { readonly kind: "contract"; readonly name: string; readonly base: DescriptorSketch }

/** A name of the pg namespace. */
export type Spelling = keyof typeof pgDescriptors

/** The names of the pg namespace whose value is a descriptor itself, not a constructor of one: every alias. */
export const spellings: Arr.NonEmptyReadonlyArray<Spelling> = nonEmpty(
	Arr.filter(Rec.keys(pgDescriptors), (name) => isOwnedDescriptor(pgDescriptors[name])),
	"the pg namespace's descriptors"
)

/** The descriptor a spelling names. */
export const spelled = (name: Spelling) =>
	defined(
		Option.getOrUndefined(Option.liftPredicate(pgDescriptors[name], isOwnedDescriptor)),
		`pg.${name} is a descriptor`
	)

/** The descriptor a sketch names, built as a JavaScript caller builds it. */
export const descriptorOf = (sketch: DescriptorSketch): unknown => {
	switch (sketch.kind) {
		case "spelling":
			return spelled(sketch.name)
		case "float":
			return floatOf(sketch.precision)
		case "numeric":
			return pgDescriptors.numeric(sketch.precision, sketch.scale)
		case "vector":
			return pgDescriptors.vector(sketch.dimensions)
		case "uuid":
			return uuidDescriptor
		case "closedId":
			return admittedClosedId(closed(sketch.name, sketch.handles))
		case "span":
			return Option.match(sketch.width, {
				onNone: () => spanDescriptor(descriptorOf(sketch.endpoint)),
				onSome: (width) => spanDescriptor(descriptorOf(sketch.endpoint), width)
			})
		case "contract":
			return contractDescriptor(sketch.name, descriptorOf(sketch.base))
	}
}

/** Whether a spelling is a serial: a way of writing its integer, by its sequence. */
export const isSerial = (name: Spelling): boolean => writingOf(spelled(name)).kind === "serial"

/**
 * The span carrier a sketch is an endpoint of, by the rule the README states: integer or bigint, or a contract over
 * one, as int4range or int8range; a serial is a writing and no endpoint, and nothing else is one.
 */
export const spanCarrierOf = (sketch: DescriptorSketch): "range4" | "range8" | undefined => {
	switch (sketch.kind) {
		case "spelling": {
			if (isSerial(sketch.name)) {
				return undefined
			}
			const sql = spelled(sketch.name).sql
			return sql === "integer" ? "range4" : sql === "bigint" ? "range8" : undefined
		}
		case "contract":
			return spanCarrierOf(sketch.base)
		case "float":
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
 * writing; float(p) names real up to binary32's 24 bits and double precision past them; a typmod, a roster, a width and
 * a contract's name are each part of the type.
 */
export const typeKeyOf = (sketch: DescriptorSketch): string => {
	switch (sketch.kind) {
		case "spelling":
			return spelled(sketch.name).sql
		case "float":
			return sketch.precision <= 24 ? "real" : "double precision"
		case "numeric":
			return `numeric(${sketch.precision},${sketch.scale === 0 ? 0 : sketch.scale})`
		case "vector":
			return `vector(${sketch.dimensions})`
		case "uuid":
			return "uuid"
		case "closedId":
			return `closedId ${sketch.name} [${Arr.join(sketch.handles, ",")}]`
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

/** The spellings a contract may brand: every one but a serial, which is a way of writing a field and no type. */
const typeSpellings = nonEmpty(
	Arr.filter(spellings, (name) => !isSerial(name)),
	"the spellings of a type"
)

const spellingOf = (names: Arr.NonEmptyReadonlyArray<Spelling>): Gen<DescriptorSketch> =>
	map(element(names), (name): DescriptorSketch => ({ kind: "spelling", name }))

/** A contract named by a drawn name over a base `base` draws. */
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
			[1, int(numericMaxPrecision.value - 2, numericMaxPrecision.value)]
		])
	),
	scale: source.draw(
		weighted([
			[1, int(-2, 6)],
			[1, int(numericMinScale.value, numericMinScale.value + 2)],
			[1, int(numericMaxScale.value - 2, numericMaxScale.value)]
		])
	)
})

const vectorGen: Gen<DescriptorSketch> = map(
	weighted([
		[1, int(1, 4)],
		[1, int(vectorMaxDimensions.value - 2, vectorMaxDimensions.value)]
	]),
	(dimensions): DescriptorSketch => ({ kind: "vector", dimensions })
)

const closedIdGen: Gen<DescriptorSketch> = (source) => ({
	kind: "closedId",
	name: source.draw(nameGen),
	handles: source.draw(handlesGen)
})

const spanGen =
	(depth: number): Gen<DescriptorSketch> =>
	(source) => {
		const endpoint = source.draw(endpointGen(depth))
		const carrier = defined(spanCarrierOf(endpoint), "an endpoint's span carrier")
		return { kind: "span", endpoint, width: source.draw(widthGen(carrier)) }
	}

/**
 * A descriptor the namespace admits over the spellings `names`, its contracts nested `depth` deep at most; float(p)
 * for every binary precision PostgreSQL admits.
 */
const descriptorOver = (
	names: Arr.NonEmptyReadonlyArray<Spelling>,
	depth: number
): Gen<DescriptorSketch> => {
	const leaves: Arr.NonEmptyReadonlyArray<Weighted<DescriptorSketch>> = [
		[4, spellingOf(names)],
		[2, map(int(1, 53), (precision): DescriptorSketch => ({ kind: "float", precision }))],
		[2, numericGen],
		[2, vectorGen],
		[1, constant<DescriptorSketch>({ kind: "uuid" })],
		[1, closedIdGen],
		[2, spanGen(depth)]
	]
	return depth > 0
		? weighted<DescriptorSketch>([
				...leaves,
				[2, contractOf(descriptorOver(typeSpellings, depth - 1))]
			])
		: weighted<DescriptorSketch>(leaves)
}

/** A descriptor the namespace admits, every spelling a serial among them, contracts nested `depth` deep at most. */
export const descriptorGen = (depth: number): Gen<DescriptorSketch> =>
	descriptorOver(spellings, depth)
