import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { canonicalZero, VectorText } from "#compiler/ir/carriers.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import { literalProblem, nativeEqualityKey, type TypedLiteral } from "#compiler/ir/expr.ts"
import {
	baseOf,
	type Capability,
	type Carrier,
	contractOf,
	numericTypmodOf,
	type Roster,
	rosterOf,
	type ScalarType,
	type StorageCarrier,
	textOf,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { noRosters, scalarTypeOf, type TextLookup } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { analyzeText, textInfo } from "#compiler/text/refinement.ts"
import { defined } from "#test/support/assert.ts"
import { toastPair, toastText } from "#test/support/oracle/gen/toast.ts"
import { elementAt } from "#test/support/oracle/pick.ts"

/**
 * Scalar types and small value domains for the oracle generators.
 *
 * The differential harness runs over small generated domains, so that joins, projections, groups and keys collide
 * often, and over the values whose equality and spelling PostgreSQL treats specially: NaN (equal to itself, sorting
 * greatest), signed zero (one value), numeric display scale (1.0 = 1.00), and text beyond the Basic Multilingual Plane
 * (code point order, not UTF-16 order, under C.UTF-8). Every value is a typed Literal of the scalar IR, in its one form,
 * so the fact loader and the conservative lowering print it exactly.
 *
 * A domain is a list of value classes (ValueClass): one value, and the input spellings PostgreSQL reads as that value
 * and may store differently (twinSpellings): "1", "1.0" and "1.000000000000000000000000", or "0" and "-0". A stored
 * value (a fact) is written in one drawn spelling of its class (SpelledValue), and grizzle's answer must not depend on
 * which: a collapsing operator (DISTINCT, UNION, GROUP BY, min, max), a join and every reading over two spellings of one
 * class give one value, which the reference states exactly. So the generators draw spellings freely, at every merge
 * and under every reading, and keep nothing away from one:
 *
 * - "drawn": every stored value picks its own spelling;
 * - "twinned": each fact after a relation's first takes, at every field outside the relation's keys, the value class
 *   of the fact before it, spelled one place further on (facts.ts), so two spellings of one value meet wherever a merge
 *   reads such a field.
 *
 * A comparison operand (a filter literal or parameter, a match constant) is a value, never stored, so it has no
 * spelling.
 *
 * The carriers the generators draw from: every carrier a field can have (carrierDraws), spans over integer and bigint
 * and three-dimensional vectors among them. Contracts and refined text keep their base's carrier.
 */
export const genCarriers = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"bool",
	"uuid",
	"text",
	"enum",
	"range4",
	"range8",
	"vector"
] as const
export type GenCarrier = (typeof genCarriers)[number]

/**
 * Every generated text field is str.regex("^.{0,2}$", "su"): at most two code points of any kind, which admits the
 * whole text domain below (the longest values, "a\u{1F600}" and a decomposed "é", are two code points) and proves a
 * byte bound of 8, so a text field can be a key, a pure set's included (text is bounded by an anchored
 * pattern; the wildcard proves no bound and is UnrepresentableKey).
 */
const genTextSource = "^.{0,2}$"

/** The dimensions of every generated vector. */
export const vectorDimensions = 3
const genTextFlags = "su"

/**
 * The type of a generated column, before it becomes a ScalarType: bare numeric is "numeric", numeric under a typmod
 * "numericTypmod". The extended flavors (carrierDraws) are a contract over bigint, a contract over regex-refined text
 * and unbounded text.
 */
type TypeSpec =
	| {
			readonly carrier: Exclude<
				GenCarrier,
				"numeric" | "enum" | "vector" | "range4" | "range8" | "text" | "uuid"
			>
	  }
	| { readonly carrier: "uuid" | "text" | "longText" | "vector" | "range4" | "range8" }
	| { readonly carrier: "numeric" }
	| { readonly carrier: "numericTypmod"; readonly precision: number; readonly scale: number }
	| {
			readonly carrier: "enum"
			readonly roster: {
				readonly closed: string
				readonly handles: Arr.NonEmptyReadonlyArray<string>
			}
	  }
	| { readonly carrier: "contract"; readonly name: "Tick" | "Code" }

/** The pattern of the refined text the Code contract is over: one or two of a, b and c, a bounded key. */
const codeSource = "^[a-c]{1,2}$"

/**
 * The pattern of unbounded text: any text without a line break, of any length, so no key. It is its own pattern rather
 * than the wildcard (dot-all), which is also the type every text comparison parameter is bound as, so the values a
 * parameter draws stay the generated short text's.
 */
const longTextSource = "^.*$"

const pgNames = {
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	float4: "real",
	float8: "double precision",
	money: "money",
	bool: "boolean"
} as const

/** The field descriptor a spec declares its column with. */
const specDesc = (spec: TypeSpec): FieldDesc => {
	switch (spec.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
			return { kind: "pg", type: pgNames[spec.carrier] }
		case "uuid":
			return { kind: "uuid" }
		case "numeric":
			return { kind: "numeric" }
		case "numericTypmod":
			return { kind: "numeric", precision: spec.precision, scale: spec.scale }
		case "text":
			return { kind: "text", source: genTextSource, flags: genTextFlags }
		case "enum":
			return { kind: "closedId", roster: spec.roster.closed }
		case "contract":
			return spec.name === "Tick"
				? {
						kind: "contract",
						name: "Tick",
						base: { kind: "pg", type: "bigint" },
						predicate: undefined,
						facts: []
					}
				: {
						kind: "contract",
						name: "Code",
						base: { kind: "text", source: codeSource, flags: "u" },
						predicate: undefined,
						facts: []
					}
		case "longText":
			return { kind: "text", source: longTextSource, flags: "u" }
		case "vector":
			return { kind: "vector", dimensions: vectorDimensions }
		case "range4":
			return { kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined }
		case "range8":
			return { kind: "span", endpoint: { kind: "pg", type: "bigint" }, width: undefined }
	}
}

/**
 * The text package's reading of a generated pattern: the canonical metadata the schema compiler gives a str.regex
 * field.
 */
const analyzedText: TextLookup = (source, flags) =>
	Result.map(analyzeText(source, flags, SourceLoc("a generated text field", [])), textInfo)

/**
 * The ScalarType of a spec: the descriptor registry's reading of its field descriptor (scalarTypeOf) under the text
 * package's canonical metadata and the spec's roster, so a generated type is the one the schema compiler and the
 * checker give its field, and the checker's own result types (plainType, commonType) are sameScalarType with the
 * generated ones.
 */
export const scalarOfSpec = (spec: TypeSpec): ScalarType => {
	const roster = spec.carrier === "enum" ? spec.roster : undefined
	const typed = scalarTypeOf(
		specDesc(spec),
		{
			kind: "builder",
			roster: (name) => (roster?.closed === name ? roster.handles : noRosters(name)),
			text: analyzedText
		},
		SourceLoc("a generated field", [])
	)
	if (!typed.ok) {
		throw new Error(`the generated type ${spec.carrier}: ${typed.error.message}`)
	}
	return typed.value
}

/**
 * The type a comparison parameter of `type` is bound as: its base, with no refinement, so
 * the generated text's base is the unrefined text, whose metadata is the canonical wildcard.
 */
export const compareParamType = (type: ScalarType): ScalarType => {
	const base = baseOf(type)
	return base.carrier === "text" ? wildcardText : base
}

/**
 * The type a key field of `type` is declared with: a key must pass the representability check,
 * and bare numeric has no size bound, so a bare numeric key field is numeric(5,2) instead. Every other generated type
 * is representable: fixed-width, an enum, or the bounded generated text. A bare numeric payload field keeps NaN,
 * Infinity and every display scale; numeric(5,2) keeps NaN and 1.0 = 1.00 in keys.
 *
 * Of the extended flavors, unbounded text proves no bound and is keyed as the generated bounded text. A vector of the
 * generated dimensions is a key as it is, its equality pgvector's. A span in a key is a temporal key, its facts never
 * overlapping: only the field a span key marks "span" keeps its range (schema.ts); any other key field drawn as a span
 * takes its endpoint's type.
 */
export const keyFieldType = (type: ScalarType, keep: "span" | "scalar"): ScalarType => {
	if (type.carrier === "numeric" && type.typmod === undefined) {
		return scalarOfSpec({ carrier: "numericTypmod", precision: 5, scale: 2 })
	}
	if (type.carrier === "text" && textFlavor(type) === "long") {
		return scalarOfSpec({ carrier: "text" })
	}
	if (keep === "span" && (type.carrier === "range4" || type.carrier === "range8")) {
		return type
	}
	if (type.carrier === "range4") {
		return scalarOfSpec({ carrier: "int4" })
	}
	if (type.carrier === "range8") {
		return scalarOfSpec({ carrier: "int8" })
	}
	return type
}

/**
 * How the palette reaches a storage carrier: by its type specs, those every population draws (`base`) and those drawn
 * only where a schema configuration asks for the extended flavors (`extended`, schema.ts SchemaLimits.extended), or by
 * the handles of the case's closed rosters, which the palette gains beside its picks (schema.ts resolveSchema).
 */
type CarrierDraw =
	| {
			readonly kind: "specs"
			readonly base: Arr.NonEmptyReadonlyArray<TypeSpec>
			readonly extended: ReadonlyArray<TypeSpec>
	  }
	| { readonly kind: "rosters" }

const only = (spec: TypeSpec): CarrierDraw => ({ kind: "specs", base: [spec], extended: [] })

/**
 * The generators' alphabet: every carrier a field can have (ir/scalar.ts StorageCarrier) with how the palette draws it,
 * so a carrier added there without a draw fails the typecheck. Two numeric typmods let typmod normalization and the
 * typmod-identity of sameScalarType both appear; the extended flavors are a contract over bigint, a contract over
 * regex-refined text and unbounded text with TOAST-sized values. A palette pick names an index of allTypeSpecs: the base
 * specs in this record's order, then the extended ones, so the first base specs keep the indices kept sketches name.
 */
const carrierDraws: { readonly [C in StorageCarrier]: CarrierDraw } = {
	int4: only({ carrier: "int4" }),
	text: {
		kind: "specs",
		base: [{ carrier: "text" }],
		extended: [{ carrier: "contract", name: "Code" }, { carrier: "longText" }]
	},
	numeric: {
		kind: "specs",
		base: [
			{ carrier: "numeric" },
			{ carrier: "numericTypmod", precision: 5, scale: 2 },
			{ carrier: "numericTypmod", precision: 3, scale: 1 }
		],
		extended: []
	},
	int8: {
		kind: "specs",
		base: [{ carrier: "int8" }],
		extended: [{ carrier: "contract", name: "Tick" }]
	},
	float8: only({ carrier: "float8" }),
	bool: only({ carrier: "bool" }),
	uuid: only({ carrier: "uuid" }),
	int2: only({ carrier: "int2" }),
	float4: only({ carrier: "float4" }),
	money: only({ carrier: "money" }),
	range4: only({ carrier: "range4" }),
	range8: only({ carrier: "range8" }),
	vector: only({ carrier: "vector" }),
	enum: { kind: "rosters" }
}

const drawnSpecs = (tier: "base" | "extended"): ReadonlyArray<TypeSpec> =>
	Arr.flatMap(Rec.values(carrierDraws), (draw): ReadonlyArray<TypeSpec> => {
		switch (draw.kind) {
			case "specs":
				return draw[tier]
			case "rosters":
				return []
		}
	})

/** The specs every population draws its columns from, besides the enums of the case's closed rosters. */
export const baseTypeSpecs: ReadonlyArray<TypeSpec> = drawnSpecs("base")

/** Every type spec, the base types first. */
export const allTypeSpecs: ReadonlyArray<TypeSpec> = [...baseTypeSpecs, ...drawnSpecs("extended")]

export const bool: ScalarType = scalarOfSpec({ carrier: "bool" })
export const int4: ScalarType = scalarOfSpec({ carrier: "int4" })
export const int8: ScalarType = scalarOfSpec({ carrier: "int8" })
export const numeric: ScalarType = scalarOfSpec({ carrier: "numeric" })
export const float4: ScalarType = scalarOfSpec({ carrier: "float4" })
export const float8: ScalarType = scalarOfSpec({ carrier: "float8" })
export const money: ScalarType = scalarOfSpec({ carrier: "money" })

export const genCarrierOf = (type: ScalarType): GenCarrier => {
	const carrier = type.carrier
	const drawn = Arr.findFirst(genCarriers, (c) => c === carrier)
	if (Option.isNone(drawn)) {
		throw new Error(`oracle generators do not draw the ${carrier} carrier`)
	}
	return drawn.value
}

/** An enum type's roster, which every enum type the generators draw carries. */
const enumRoster = (type: ScalarType): Roster => defined(rosterOf(type), "an enum type's roster")

export const hasCap = (type: ScalarType, cap: Capability): boolean => type.caps.includes(cap)

/**
 * The field descriptor a column of this type is declared with: aliases normalized, the generated text
 * as str.regex(genTextSource, genTextFlags), an enum as the closedId of its roster.
 */
export const fieldDescOf = (type: ScalarType): FieldDesc => {
	const contract = contractOf(type)
	if (contract !== undefined) {
		return {
			kind: "contract",
			name: contract.name,
			base: fieldDescOf(contract.base),
			predicate: undefined,
			facts: contract.facts
		}
	}
	switch (genCarrierOf(type)) {
		case "int2":
			return { kind: "pg", type: "smallint" }
		case "int4":
			return { kind: "pg", type: "integer" }
		case "int8":
			return { kind: "pg", type: "bigint" }
		case "float4":
			return { kind: "pg", type: "real" }
		case "float8":
			return { kind: "pg", type: "double precision" }
		case "money":
			return { kind: "pg", type: "money" }
		case "bool":
			return { kind: "pg", type: "boolean" }
		case "uuid":
			return { kind: "uuid" }
		case "text": {
			const regex = textOf(type)?.regex
			if (regex === "wildcard") {
				return { kind: "text", source: "^.*$", flags: "su" }
			}
			return regex === undefined
				? { kind: "text", source: genTextSource, flags: genTextFlags }
				: { kind: "text", source: regex.source, flags: regex.flags }
		}
		case "enum":
			return { kind: "closedId", roster: enumRoster(type).closed }
		case "range4":
			return { kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined }
		case "range8":
			return { kind: "span", endpoint: { kind: "pg", type: "bigint" }, width: undefined }
		case "vector":
			return {
				kind: "vector",
				dimensions: defined(vectorTypmodOf(type), "a vector type's dimensions").dims
			}
		case "numeric": {
			const typmod = numericTypmodOf(type)
			if (typmod === undefined) {
				return { kind: "numeric" }
			}
			return { kind: "numeric", precision: typmod.precision, scale: typmod.scale }
		}
	}
}

/**
 * The authored form of a literal of `type` (LiteralOf): a smallint or integer is a JavaScript number and a
 * bigint a bigint, numeric a Decimal, a float a number or the wrapped special value, money a Money, an enum its handle.
 */
export const typedLiteralDesc = (literal: TypedLiteral, type: ScalarType): LiteralDesc => {
	switch (literal.kind) {
		case "int":
			return type.carrier === "int8" ? literal.value : Number(literal.value)
		case "numeric":
		case "money":
		case "vector":
			return literal.value
		case "float":
			return literal.value
		case "floatSpecial":
			return { float: literal.value }
		case "bool":
			return literal.value
		case "text":
		case "uuid":
			return literal.value
		case "enum":
			return literal.handle
		case "span":
			return { span: { start: literal.start, end: literal.end } }
	}
}

const int = (value: bigint): TypedLiteral => ({ kind: "int", value })
const num = (text: string): TypedLiteral => ({ kind: "numeric", value: Decimal.of(text) })
const flt = (value: number): TypedLiteral => ({ kind: "float", value: canonicalZero(value) })
const special = (value: "NaN" | "Infinity" | "-Infinity"): TypedLiteral => ({
	kind: "floatSpecial",
	value
})
/** A double as the IR's literal: a special for NaN and either infinity, a float with the one zero otherwise. */
export const floatLiteralOf = (x: number): TypedLiteral =>
	Number.isNaN(x)
		? special("NaN")
		: x === Number.POSITIVE_INFINITY
			? special("Infinity")
			: x === Number.NEGATIVE_INFINITY
				? special("-Infinity")
				: flt(x)
const cash = (minor: bigint): TypedLiteral => ({ kind: "money", value: Money.of(minor) })
const text = (value: string): TypedLiteral => ({ kind: "text", value })
const uuid = (value: string): TypedLiteral => ({ kind: "uuid", value })
const span = (start: bigint, end: bigint): TypedLiteral => ({ kind: "span", start, end })
const vector = (...components: ReadonlyArray<number>): TypedLiteral => {
	const value = VectorText.of(Float32Array.from(components))
	if (!value.ok) {
		throw new Error(`a generated vector: ${value.error.message}`)
	}
	return { kind: "vector", value: value.value }
}

/** The values of one carrier's classes, each one value in its one form. */
type Classes = ReadonlyArray<TypedLiteral>

const intClasses = (min: bigint, max: bigint): Classes => [
	int(0n),
	int(1n),
	int(-1n),
	int(2n),
	int(3n),
	int(min),
	int(max)
]

/**
 * Value classes before typmod filtering, by carrier, each one value: its input spellings are twinSpellings'. Small values
 * first: shrinking moves a class index toward 0. The plain float classes are dyadic; the edge classes add non-dyadic
 * values whose IEEE sums depend on their order, which grizzle's exact sums do not (scalar/aggregate.ts).
 */
const rawClasses: Readonly<Record<Exclude<GenCarrier, "enum">, Classes>> = {
	int2: intClasses(-32768n, 32767n),
	int4: intClasses(-2147483648n, 2147483647n),
	/**
	 * Besides the bounds, the integers nearest zero no binary64 holds, 2^53 + 1 and its negation, last so shrinking moves
	 * away from them: a host path that takes an int8 through a JavaScript number rounds them silently to another bigint.
	 */
	int8: [...intClasses(-(2n ** 63n), 2n ** 63n - 1n), int(2n ** 53n + 1n), int(-(2n ** 53n + 1n))],
	numeric: [
		num("0"),
		num("1"),
		num("-1"),
		num("2.5"),
		num("10"),
		num("NaN"),
		num("0.1"),
		num("-0.25"),
		num("Infinity"),
		num("-Infinity")
	],
	/**
	 * Besides the small values, the edge of a narrowing into a typmod wider than a float's significant digits
	 * (compute.ts floatEdges): the widest value whose numeric cast fits numeric(7, 0) and numeric(16, 0), and values
	 * whose cast rounds past them, last so shrinking moves away from them.
	 */
	float4: [
		flt(0),
		flt(1),
		flt(-1.5),
		special("NaN"),
		flt(0.25),
		special("Infinity"),
		special("-Infinity"),
		flt(3),
		flt(9999994),
		flt(9999995),
		flt(-9999998)
	],
	float8: [
		flt(0),
		flt(1),
		flt(-1.5),
		special("NaN"),
		flt(0.25),
		special("Infinity"),
		special("-Infinity"),
		flt(3),
		flt(9999999999999994),
		flt(9999999999999996),
		flt(-9999999999999998)
	],
	money: [cash(0n), cash(100n), cash(1n), cash(-250n), cash(99999n)],
	bool: [
		{ kind: "bool", value: false },
		{ kind: "bool", value: true }
	],
	uuid: [
		uuid("00000000-0000-0000-0000-000000000000"),
		uuid("00000000-0000-0000-0000-000000000001"),
		uuid("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
		uuid("ffffffff-ffff-ffff-ffff-ffffffffffff")
	],
	/**
	 * Code point order differs from UTF-16 order between U+E000 and a supplementary character such as U+1F600, whose
	 * lead surrogate U+D83D sorts below U+E000 in UTF-16; C.UTF-8 orders by code point. Case and
	 * a decomposed accent are distinct values: no normalization or folding changes text identity.
	 * Spans in a small window around zero, adjacent, nested, overlapping and equal-bound, and the endpoint type's limits.
	 */
	range4: [
		span(0n, 1n),
		span(1n, 3n),
		span(0n, 3n),
		span(2n, 5n),
		span(-3n, 8n),
		span(5n, 6n),
		span(3n, 4n),
		span(-2147483648n, 2147483647n)
	],
	range8: [
		span(0n, 1n),
		span(1n, 3n),
		span(0n, 3n),
		span(2n, 5n),
		span(-3n, 8n),
		span(5n, 6n),
		span(-(2n ** 63n), 2n ** 63n - 1n)
	],
	/**
	 * Vectors in the cosine domain: unit vectors along each axis and between them, one opposite, one not unit-length.
	 */
	vector: [
		vector(1, 0, 0),
		vector(0, 1, 0),
		vector(0.6, 0.8, 0),
		vector(-1, 0, 0),
		vector(0, 0, 1),
		vector(0.5, 0.5, 0.5),
		vector(3, 4, 0)
	],
	text: [
		text("a"),
		text(""),
		text("b"),
		text("A"),
		text("\u{1F600}"),
		text(""),
		text("é"),
		text("é"),
		text("a\u{1F600}"),
		text("퟿"),
		text("\u{10FFFF}")
	]
}

/**
 * Edge values, appended to a carrier's classes when a configuration asks
 * for them, so shrinking a class index moves away from them: wide numerics and the smallest scale steps; float
 * subnormals, the smallest normal, ±MAX, and non-dyadic values whose IEEE sums depend on their order (0.1, 0.3, ±1e20
 * beside 1); money at and a few steps from its int8 bounds, whose sums leave money's range in some order but not in
 * total; combining-only, zero-width and right-to-left text.
 */
const edgeClasses: Readonly<Partial<Record<Exclude<GenCarrier, "enum">, Classes>>> = {
	numeric: [
		num("99999999999999999999.99999999999999999999"),
		num("0.000000000000000000000000000001"),
		num(`1${Str.repeat(120)("0")}`),
		num("-12345678901234567890123456789.123456789")
	],
	float4: [
		flt(Math.fround(2 ** -149)),
		flt(Math.fround(3.4028234663852886e38)),
		flt(-Math.fround(3.4028234663852886e38)),
		flt(Math.fround(0.1)),
		flt(Math.fround(2 ** -126))
	],
	float8: [
		flt(5e-324),
		flt(Number.MAX_VALUE),
		flt(-Number.MAX_VALUE),
		flt(0.1),
		flt(2.2250738585072014e-308),
		flt(0.3),
		flt(1e20),
		flt(-1e20),
		flt(0.2)
	],
	money: [
		cash(2n ** 63n - 1n),
		cash(-(2n ** 63n)),
		cash(2n ** 62n),
		cash(-(2n ** 62n) - 1n),
		cash(-1n)
	],
	text: [text("\u0301"), text("\u200B"), text("\u05D0\u05D1"), text("\u200F"), text("a\u0301")]
}

/** The values of the Code contract's refined text: one or two of a, b and c. */
const codeClasses: Classes = [text("a"), text("b"), text("ab"), text("c"), text("ca"), text("bb")]

/**
 * Unbounded text: short values, and TOAST-sized incompressible ones stored out of line, two of which share every code
 * point but their last (toast.ts), so equality, order and DISTINCT must read past every chunk to tell them apart.
 */
const [toastA, toastB] = toastPair(0x7a, 6_000)
const longTextClasses: Classes = [
	text("a"),
	text(""),
	text(toastText(0x71, 2_100)),
	text(toastA),
	text(toastB),
	text("b"),
	text(toastText(0x72, 20_000))
]

/** Which text a text type holds: the generated bounded text, the Code refinement, or unbounded text. */
export const textFlavor = (type: ScalarType): "generated" | "code" | "long" => {
	const regex = textOf(baseOf(type))?.regex
	if (regex === undefined || regex === "wildcard") {
		return "generated"
	}
	return regex.source === codeSource
		? "code"
		: regex.source === longTextSource
			? "long"
			: "generated"
}

/** A type's typmod as text, for valueClasses' refusal: a numeric typmod or a vector's dimensions, empty for none. */
const typmodText = (type: ScalarType): string => {
	const numericTypmod = numericTypmodOf(type)
	if (numericTypmod !== undefined) {
		return `${numericTypmod.precision},${numericTypmod.scale}`
	}
	const vectorTypmod = vectorTypmodOf(type)
	return vectorTypmod === undefined ? "" : `${vectorTypmod.dims}`
}

/**
 * The value classes of a type: the raw classes whose value the type holds exactly (a numeric typmod's rounding or
 * overflow and infinity under a typmod refused; literalProblem). An enum has one class per handle, in roster order.
 */
export const valueClasses = (type: ScalarType, edge: boolean): Classes => {
	const carrier = genCarrierOf(type)
	if (carrier === "enum") {
		return Arr.map(enumRoster(type).handles, (handle): TypedLiteral => ({ kind: "enum", handle }))
	}
	const flavor = carrier === "text" ? textFlavor(type) : "plain"
	const drawn =
		flavor === "code"
			? codeClasses
			: flavor === "long"
				? longTextClasses
				: [...rawClasses[carrier], ...(edge ? (edgeClasses[carrier] ?? []) : [])]
	const classes = Arr.filter(drawn, (literal) => literalProblem(literal, type) === undefined)
	if (classes.length === 0) {
		throw new Error(
			`no generated value fits the ${carrier} type (typmod ${typmodText(type)}, ${flavor} text, edge ${edge})`
		)
	}
	return classes
}

/**
 * A carrier's input spellings beside its canonical one: none ("canonical": every input of one value is stored and
 * output as one text), or the twins PostgreSQL reads as the value and stores differently, each a text the type's input
 * function reads. The table is total over the IR's carriers, so a carrier added to ir/scalar.ts without its twins fails
 * the typecheck, and a carrier with one spelling says so.
 */
export type TwinSpellings =
	| { readonly kind: "canonical" }
	| { readonly kind: "twins"; readonly of: (literal: TypedLiteral) => ReadonlyArray<string> }

const canonicalOnly: TwinSpellings = { kind: "canonical" }

/** The fraction paddings a numeric is spelled at past its least scale: one digit, 8, 24 and 40. */
export const numericPaddings: Arr.NonEmptyReadonlyArray<number> = [1, 8, 24, 40]

/** A numeric's one text padded by `k` trailing fractional zeros, which numeric_in stores at that display scale. */
export const paddedText = (text: string, k: number): string =>
	`${Str.includes(".")(text) ? text : `${text}.`}${Str.repeat(k)("0")}`

const floatTwins: TwinSpellings = {
	kind: "twins",
	of: (literal) => (literal.kind === "float" && literal.value === 0 ? ["-0"] : [])
}

export const twinSpellings: { readonly [C in Carrier]: TwinSpellings } = {
	int2: canonicalOnly,
	int4: canonicalOnly,
	int8: canonicalOnly,
	numeric: {
		kind: "twins",
		of: (literal) =>
			literal.kind === "numeric" && literal.value.parts.kind === "finite"
				? Arr.map(numericPaddings, (k) => paddedText(decimalPayload(literal.value), k))
				: []
	},
	float4: floatTwins,
	float8: floatTwins,
	money: canonicalOnly,
	bool: canonicalOnly,
	uuid: canonicalOnly,
	text: canonicalOnly,
	enum: canonicalOnly,
	range4: canonicalOnly,
	range8: canonicalOnly,
	vector: {
		kind: "twins",
		of: (literal) =>
			literal.kind === "vector" && Arr.some(literal.value.components, (x) => x === 0)
				? [
						`[${Arr.join(
							Arr.map(literal.value.components, (x) => (x === 0 ? "-0" : String(x))),
							","
						)}]`
					]
				: []
	},
	exactInteger: canonicalOnly,
	exactMoney: canonicalOnly
}

/** The twin spellings of a value of `type`: the input texts beside its canonical one that store it differently. */
export const twinsOf = (type: ScalarType, literal: TypedLiteral): ReadonlyArray<string> =>
	carrierTwins(baseOf(type).carrier, literal)

/** The twin spellings of a value of `carrier`, by the carrier's row of the twin table. */
export const carrierTwins = (carrier: Carrier, literal: TypedLiteral): ReadonlyArray<string> => {
	const twins = twinSpellings[carrier]
	switch (twins.kind) {
		case "canonical":
			return []
		case "twins":
			return twins.of(literal)
	}
}

/** How a stored value is written: in its canonical form, or as one of its twin input spellings. */
export type Spelled =
	| { readonly kind: "canonical" }
	| { readonly kind: "twin"; readonly text: string }

/** A stored value: its one value, and the spelling it is written in, which no answer may depend on. */
export interface SpelledValue {
	readonly literal: TypedLiteral
	readonly spelling: Spelled
}

const canonicalSpelling: Spelled = { kind: "canonical" }

/** A value written in its canonical form. */
export const canonicallySpelled = (literal: TypedLiteral): SpelledValue => ({
	literal,
	spelling: canonicalSpelling
})

/** A value of `type` in its spelling `sp`, modulo its spellings: 0 the canonical one, then each twin. */
export const spelledAt = (type: ScalarType, literal: TypedLiteral, sp: number): SpelledValue => {
	const twins = twinsOf(type, literal)
	const k = sp % (twins.length + 1)
	return k === 0
		? canonicallySpelled(literal)
		: { literal, spelling: { kind: "twin", text: elementAt(twins, k - 1, "a value's twins") } }
}

/**
 * How the generators spell stored values: "drawn", each stored value its own drawn spelling; "twinned", besides, each
 * fact after a relation's first takes, at every field outside the relation's keys, the value class of the fact before
 * it, spelled one place further on (facts.ts), so two spellings of one value meet wherever a merge reads such a field.
 */
export type SpellingMode = "drawn" | "twinned"

export interface Spelling {
	readonly mode: SpellingMode
	/** Whether values are drawn from the edge classes too (edgeClasses). */
	readonly edge: boolean
}

/**
 * A value before resolution against its column type: a class index and a spelling index, each reduced modulo the
 * type's domain, so every sketch resolves for every type and shrinks toward the first value in its canonical spelling.
 */
export interface ValueSketch {
	readonly cls: number
	readonly sp: number
}

/**
 * The value sketches of the float specials among a float type's classes: NaN, Infinity and -Infinity, each a value the
 * lowerings print as a special literal. A float4 and a float8 type share the classes' layout. A float's -0 is no value:
 * the compute generator reaches it as Compute.neg(0), and a stored value as its twin spelling.
 */
export const floatSpecialSketches: ReadonlyArray<ValueSketch> = Arr.flatMap(
	valueClasses(float8, false),
	(literal, k): ReadonlyArray<ValueSketch> =>
		literal.kind === "floatSpecial" ? [{ cls: k, sp: 0 }] : []
)

/** The value a sketch names among a type's classes. */
export const resolveValue = (
	type: ScalarType,
	sketch: ValueSketch,
	edge: boolean
): TypedLiteral => {
	const classes = valueClasses(type, edge)
	return elementAt(classes, sketch.cls % classes.length, "the value classes")
}

/** The stored value a sketch names: its class's value, in the spelling `sketch.sp` picks. */
export const resolveStored = (type: ScalarType, sketch: ValueSketch, edge: boolean): SpelledValue =>
	spelledAt(type, resolveValue(type, sketch, edge), sketch.sp)

/** A literal's identity under native equality, the identity keys and fact equality use. */
export const literalEqualityKey = (literal: TypedLiteral): string => nativeEqualityKey(literal)

export const literalRowKey = (
	row: ReadonlyArray<TypedLiteral>,
	columns: ReadonlyArray<number>
): string =>
	Arr.join(
		Arr.map(columns, (c) => literalEqualityKey(elementAt(row, c, "a generated row"))),
		"\u0000"
	)
