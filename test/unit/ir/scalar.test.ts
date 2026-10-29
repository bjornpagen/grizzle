import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	filter,
	int,
	map,
	oneOf,
	string,
	unicodeScalar,
	weighted
} from "@grizzle/testing/gen"
import {
	type Corrupted,
	type CorruptedFeature,
	type Corruption,
	corruptedFeature
} from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint, double, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { canonicalTag, encode, everyProperty } from "#compiler/core/canonical.ts"
import { ExprId, NodeId, ParamId } from "#compiler/core/ids.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import {
	defaultRevivers,
	isMoneyPayload,
	isVectorPayload,
	MoneyText,
	VectorText
} from "#compiler/ir/carriers.ts"
import { DecimalText, isDecimalLike, isDecimalPayload } from "#compiler/ir/decimal.ts"
import {
	type ExprTable,
	type TypedLiteral,
	literalProblem,
	normalizeExprTable,
	OpId,
	predicateProblems,
	type TableExpr
} from "#compiler/ir/expr.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { baseOf, contractOf, isRefined, type ScalarType } from "#compiler/ir/scalar.ts"
import { compareDecimal, Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert, defined, nonEmpty, refusalLoc, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { plainType, scalarOf, wildcardText } from "#test/support/fixtures/ir/scalar.ts"
import { fail, scalarTypes } from "#test/unit/ir/fixture.ts"

import { regex } from "arkregex"
/** The largest finite 32-bit float. */
const floatMax = 3.4028234663852886e38

/** A decimal's numeric_out text from its units and scale. */
const decimalText = (units: bigint, scale: number): string => {
	const sign = units < 0n ? "-" : ""
	const abs = pipe((units < 0n ? -units : units).toString(), Str.padStart(scale + 1, "0"))
	return scale === 0
		? `${sign}${abs}`
		: `${sign}${Str.slice(0, -scale)(abs)}.${Str.slice(-scale)(abs)}`
}

/**
 * A valid type of every carrier, the serials, and contracts over a plain, a typmod, a roster and a regex base, each the
 * one the registry builds.
 */
const kinds = { Kind: ["Automatic", "Manual"] }
const numeric102 = scalarOf(f.numeric(10, 2), {})
const slugDesc = f.regex("^[a-z]+$", "u")
const validTypes: ReadonlyArray<ScalarType> = [
	plainType("int2"),
	plainType("int4"),
	plainType("int8"),
	scalarOf(f.bigserial, {}),
	scalarOf({ kind: "serial", type: "serial" }, {}),
	plainType("numeric"),
	numeric102,
	scalarOf(f.numeric(5, -2), {}),
	plainType("float4"),
	plainType("float8"),
	plainType("money"),
	plainType("bool"),
	scalarOf(f.uuid, {}),
	wildcardText,
	scalarOf(slugDesc, {}),
	scalarOf(f.closedId("Kind"), kinds),
	scalarOf(f.span(f.integer, undefined), {}),
	scalarOf(f.span(f.bigint, undefined), {}),
	scalarOf({ kind: "vector", dimensions: 3 }, {}),
	scalarOf(f.contract("Cents", f.bigint, undefined), {}),
	scalarOf(f.contract("Price", f.numeric(10, 2), undefined), {}),
	scalarOf(f.contract("Pick", f.closedId("Kind"), undefined), kinds),
	scalarOf(f.contract("Slug", slugDesc, undefined), {})
]

/**
 * Every rule of a consistent scalar type a corruption breaks: a corruption names one of these, so a misspelt rule is a
 * compile error.
 */
type ScalarRule =
	| "text carries its regex metadata"
	| "an enum carries its roster"
	| "a span's endpoint is of its carrier and no serial"
	| "a numeric typmod has a precision 1-1000 and its scale"
	| "a vector has 1-16000 dimensions"
	| "only numeric and vector carry a typmod"
	| "only an integer is a serial"
	| "a contract's carrier is its base's"
	| "a contract is over no serial"
	| "a contract carries its base's typmod and roster"
	| "the carrier is one grizzle stores"

/**
 * One rule of a consistent scalar type, broken at every type it applies to: the refusal names where, the type itself.
 */
const breaks = (
	rule: ScalarRule,
	from: "stale" | "wild",
	applies: (t: ScalarType) => boolean,
	broken: (t: ScalarType) => ReadonlyArray<unknown>
): Corruption<ScalarType, string, ScalarRule> => ({
	rule,
	from,
	sites: (t) =>
		applies(t)
			? Arr.map(broken(t), (value, i) => ({
					value,
					refusal: "scalar type",
					at: `${t.carrier} ${i}`
				}))
			: []
})

const without = (t: ScalarType, key: string): unknown => {
	const fields: Readonly<Record<string, unknown>> = { ...t }
	return Rec.fromEntries(Arr.filter(Rec.toEntries(fields), ([k]) => k !== key))
}

const scalarCorruptions: Arr.NonEmptyReadonlyArray<Corruption<ScalarType, string, ScalarRule>> = [
	breaks(
		"text carries its regex metadata",
		"wild",
		(t) => t.carrier === "text" && contractOf(t) === undefined,
		(t) => [without(t, "text")]
	),
	breaks(
		"an enum carries its roster",
		"wild",
		(t) => t.carrier === "enum" && contractOf(t) === undefined,
		(t) => [without(t, "roster")]
	),
	breaks(
		"a span's endpoint is of its carrier and no serial",
		"stale",
		(t) => t.carrier === "range4" || t.carrier === "range8",
		(t) => [
			{
				...t,
				span: { endpoint: { carrier: t.carrier === "range4" ? "int8" : "int4", caps: t.caps } }
			},
			{
				...t,
				span: {
					endpoint: {
						carrier: t.carrier === "range4" ? "int4" : "int8",
						caps: t.caps,
						serial: "always"
					}
				}
			}
		]
	),
	breaks(
		"a numeric typmod has a precision 1-1000 and its scale",
		"wild",
		(t) => t.carrier === "numeric" && contractOf(t) === undefined,
		(t) => [
			{ ...t, typmod: { scale: 2 } },
			{ ...t, typmod: { precision: 5 } },
			{ ...t, typmod: {} },
			{ ...t, typmod: { precision: 1001, scale: 0 } }
		]
	),
	breaks(
		"a vector has 1-16000 dimensions",
		"wild",
		(t) => t.carrier === "vector",
		(t) => [without(t, "typmod"), { ...t, typmod: { dims: 16001 } }]
	),
	breaks(
		"only numeric and vector carry a typmod",
		"wild",
		(t) =>
			t.carrier === "int2" || t.carrier === "int4" || t.carrier === "int8" || t.carrier === "bool",
		(t) => [{ ...t, typmod: { precision: 3 } }]
	),
	breaks(
		"only an integer is a serial",
		"wild",
		(t) => t.carrier === "text" || t.carrier === "numeric",
		(t) => [{ ...t, serial: "always" }]
	),
	breaks(
		"a contract's carrier is its base's",
		"stale",
		(t) => contractOf(t) !== undefined && t.carrier === "int8",
		(t) => [{ ...t, carrier: "int4" }]
	),
	breaks(
		"a contract is over no serial",
		"stale",
		(t) => contractOf(t) !== undefined && t.carrier === "int8",
		(t) => {
			const contract = contractOf(t)
			return contract === undefined
				? []
				: [
						{
							...t,
							contract: { ...contract, base: { carrier: "int8", caps: t.caps, serial: "always" } }
						}
					]
		}
	),
	breaks(
		"a contract carries its base's typmod and roster",
		"stale",
		(t) => contractOf(t) !== undefined && (t.carrier === "numeric" || t.carrier === "enum"),
		(t) =>
			t.carrier === "numeric"
				? [without(t, "typmod"), { ...t, typmod: { precision: 12, scale: 2 } }]
				: [{ ...t, roster: { closed: "Other", handles: ["x"] } }]
	),
	breaks(
		"the carrier is one grizzle stores",
		"wild",
		(t) => t.carrier === "int8" && contractOf(t) === undefined && !("serial" in t),
		(t) => Arr.map(["timestamptz", "json", "int8[]"], (carrier) => ({ ...t, carrier }))
	)
]

describe("ScalarType", () => {
	it.effect(
		"decodes every valid type of every carrier as itself, and refuses each corruption of one at the type it breaks",
		(ctx) => {
			const cases = [
				...Arr.map(validTypes, (type): Corrupted<ScalarType, string, ScalarRule> => ({
					kind: "live",
					value: type
				})),
				...Arr.flatMap(validTypes, (type) =>
					Arr.flatMap(scalarCorruptions, (c) =>
						Arr.map(c.sites(type), (b): Corrupted<ScalarType, string, ScalarRule> => ({
							kind: c.from,
							rule: c.rule,
							at: b.at,
							value: b.value,
							refusal: b.refusal
						}))
					)
				)
			]
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/scalar-types",
						literal: Formatter.format,
						generator: element(nonEmpty(cases, "the scalar types and their corruptions")),
						limit: 1_000,
						features: features<CorruptedFeature<ScalarRule>>([
							"live",
							...Arr.map(
								scalarCorruptions,
								(c): CorruptedFeature<ScalarRule> => `${c.from} ${c.rule}`
							)
						]),
						caseHang: Duration.minutes(2)
					},
					(c, n) =>
						Effect.sync(() => {
							n.note(corruptedFeature(c))
							const decoded = decodeScalarType(c.value)
							if (c.kind === "live") {
								assert.deepEqual(succeeded(decoded), c.value)
								return
							}
							const error = fail(decoded)
							assert.equal(error.reason._tag, "MalformedDescription", `${c.rule} at ${c.at}`)
							assert.ok(
								formatLoc(refusalLoc(error)) === c.refusal ||
									pipe(formatLoc(refusalLoc(error)), Str.startsWith(`${c.refusal} at`)) ||
									pipe(formatLoc(refusalLoc(error)), Str.startsWith(`${c.refusal}.`)),
								`${c.rule} at ${c.at}: located at ${formatLoc(refusalLoc(error))}, not within ${c.refusal}`
							)
						})
				)
			)
		}
	)
})

const at = (text: string, type: ScalarType) =>
	check({ kind: "numeric", value: succeeded(DecimalText.make(text)) }, type)

const check = (literal: TypedLiteral, type: ScalarType) => literalProblem(literal, type)

/** numeric(p) is numeric(p, 0). */
const numeric = (precision: number, scale: number): ScalarType =>
	scalarOf(f.numeric(precision, scale), {})

describe("literals", () => {
	/**
	 * The types a literal is tried at: every carrier, and contracts over a typmod, a roster and a plain base, whose
	 * values are their base's.
	 */
	const types: Arr.NonEmptyReadonlyArray<ScalarType> = [
		plainType("int2"),
		scalarTypes.int4,
		scalarTypes.int8,
		scalarTypes.numeric,
		numeric102,
		plainType("float4"),
		scalarTypes.float8,
		scalarTypes.money,
		scalarTypes.bool,
		scalarTypes.text,
		scalarTypes.uuid,
		scalarTypes.kind,
		scalarOf(f.span(f.integer, undefined), {}),
		scalarTypes.range8,
		scalarTypes.vector3,
		scalarOf(f.contract("Price", f.numeric(10, 2), undefined), {}),
		scalarOf(f.contract("Pick", f.closedId("Kind"), undefined), { Kind: ["Automatic", "Manual"] }),
		scalarTypes.cents
	]
	const powers = Arr.flatMap(
		Arr.flatMap([15n, 31n, 63n], (b) => [2n ** b, -(2n ** b)]),
		(v) => [v - 1n, v, v + 1n]
	)
	const uuidGen = map(
		(source) => [source.draw(matching(regex("^[0-9a-f]{32}$"))), source.draw(int(0, 2))] as const,
		([hex, form]) => {
			const dashed = `${Str.slice(0, 8)(hex)}-${Str.slice(8, 12)(hex)}-${Str.slice(12, 16)(hex)}-${Str.slice(16, 20)(hex)}-${Str.slice(20)(hex)}`
			return form === 0 ? dashed : form === 1 ? Str.toUpperCase(dashed) : hex
		}
	)
	const literalGen = oneOf<TypedLiteral>([
		map(
			oneOf([element([0n, ...powers]), bigint(-(2n ** 64n), 2n ** 64n)]),
			(value): TypedLiteral => ({ kind: "int", value })
		),
		map(
			oneOf([element([0.5, 0.1, 1e300]), double(-Number.MAX_VALUE, Number.MAX_VALUE)]),
			(value): TypedLiteral => ({ kind: "float", value })
		),
		map(element(["NaN", "Infinity", "-Infinity"] as const), (value): TypedLiteral => ({
			kind: "floatSpecial",
			value
		})),
		(source): TypedLiteral => ({
			kind: "numeric",
			value: succeeded(
				DecimalText.make(
					decimalText(source.draw(bigint(-(10n ** 12n), 10n ** 12n)), source.draw(int(0, 4)))
				)
			)
		}),
		map(bigint(-(2n ** 63n), 2n ** 63n - 1n), (v): TypedLiteral => ({
			kind: "money",
			value: succeeded(MoneyText.of(v))
		})),
		map(boolean, (value): TypedLiteral => ({ kind: "bool", value })),
		map(
			oneOf([
				element(["a\u0000b", "\ud800", "héllo", "x\udc00y"]),
				string(unicodeScalar, { min: 0, max: 6 })
			]),
			(value): TypedLiteral => ({ kind: "text", value })
		),
		map(uuidGen, (value): TypedLiteral => ({ kind: "uuid", value })),
		map(element(["Automatic", "Manual", "Gold", "automatic"]), (handle): TypedLiteral => ({
			kind: "enum",
			handle
		})),
		(source): TypedLiteral => {
			const start = source.draw(oneOf([element(nonEmpty(powers, "the powers")), bigint(-9n, 9n)]))
			return { kind: "span", start, end: start + source.draw(bigint(-9n, 9n)) }
		},
		map(
			weighted([
				[3, array(float(-4, 4), { min: 3, max: 3 })],
				[
					1,
					array(oneOf([element([0, 2 ** -17, 1e9]), float(-floatMax, floatMax)]), {
						min: 1,
						max: 4
					})
				]
			]),
			(xs): TypedLiteral => ({
				kind: "vector",
				value: succeeded(VectorText.of(Float32Array.from(xs)))
			})
		)
	])
	const ranges: Readonly<Partial<Record<ScalarType["carrier"], readonly [bigint, bigint]>>> = {
		int2: [-(2n ** 15n), 2n ** 15n - 1n],
		int4: [-(2n ** 31n), 2n ** 31n - 1n],
		int8: [-(2n ** 63n), 2n ** 63n - 1n],
		range4: [-(2n ** 31n), 2n ** 31n - 1n],
		range8: [-(2n ** 63n), 2n ** 63n - 1n]
	}
	const within = (carrier: ScalarType["carrier"], v: bigint) => {
		const range = ranges[carrier]
		return range !== undefined && v >= range[0] && v <= range[1]
	}
	/**
	 * Whether the literal is a value of the type, by the rules restated: a contract's value is its base's; each literal
	 * kind meets its own carriers only; an integer lies in its carrier's range; a float4 is exactly a float32; NaN and
	 * the infinities are floats; a numeric literal is one numeric(p, s) stores unchanged; text is well-formed UTF-16
	 * without NUL; a uuid is lowercase 8-4-4-4-12 hex; an enum handle is one of its roster's; a span has start < end
	 * within its endpoint carrier; a vector has the type's dimensions and a norm, summed in double, in [2^-16, 2^16].
	 */
	const admits = (literal: TypedLiteral, outer: ScalarType): boolean => {
		const type = baseOf(outer)
		const c = type.carrier
		switch (literal.kind) {
			case "int":
				return (c === "int2" || c === "int4" || c === "int8") && within(c, literal.value)
			case "float":
				return c === "float8" || (c === "float4" && Math.fround(literal.value) === literal.value)
			case "floatSpecial":
				return c === "float4" || c === "float8"
			case "numeric": {
				if (c !== "numeric") {
					return false
				}
				const typmod = type.typmod
				if (typmod === undefined) {
					return true
				}
				const d = Decimal.of(literal.value[canonicalTag]().payload)
				const stored = normalizeNumeric(d, typmod)
				return stored.ok && compareDecimal(stored.value, d) === 0
			}
			case "money":
				return c === "money"
			case "bool":
				return c === "bool"
			case "text":
				return (
					c === "text" && literal.value.isWellFormed() && !Str.includes("\u0000")(literal.value)
				)
			case "uuid":
				return (
					c === "uuid" &&
					regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").test(
						literal.value
					)
				)
			case "enum":
				return c === "enum" && type.roster.handles.includes(literal.handle)
			case "span":
				return (
					literal.start < literal.end &&
					within(c, literal.start) &&
					within(c, literal.end) &&
					Str.startsWith("range")(c)
				)
			case "vector": {
				if (c !== "vector") {
					return false
				}
				const xs = [...literal.value.components]
				const norm = Math.sqrt(Arr.reduce(xs, 0, (sum, x) => sum + x * x))
				return xs.length === type.typmod.dims && norm >= 2 ** -16 && norm <= 2 ** 16
			}
		}
	}
	type LiteralFeature = `${TypedLiteral["kind"]} ${"admitted" | "refused"}` | "under a contract"

	it.effect("admits exactly the literals each type holds, a contract's by its base", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/ir/literal-rules",
					literal: Formatter.format,
					/**
					 * Planted: a literal of each kind whose one type the drawn literals meet a few times a run, admitted
					 * there: a vector of the type's dimensions and a norm inside the bounds, storable text, a lowercase
					 * uuid and a span with start < end.
					 */
					draw: drawn((source) => [source.draw(literalGen), source.draw(element(types))] as const),
					kept: [
						{
							note: "a vector of three components at vector(3)",
							sketch: [
								{ kind: "vector", value: succeeded(VectorText.of(Float32Array.from([1, 2, 2]))) },
								scalarTypes.vector3
							],
							draws: "",
							reaches: ["vector admitted" as const]
						},
						{
							note: "storable text at text",
							sketch: [{ kind: "text", value: "héllo" }, scalarTypes.text],
							draws: "",
							reaches: ["text admitted" as const]
						},
						{
							note: "a lowercase uuid at uuid",
							sketch: [
								{ kind: "uuid", value: "0189a7f2-3c4d-4e5f-8a9b-0c1d2e3f4a5b" },
								scalarTypes.uuid
							],
							draws: "",
							reaches: ["uuid admitted" as const]
						},
						{
							note: "a span of int4 endpoints at a span over integer",
							sketch: [
								{ kind: "span", start: -1n, end: 2n },
								scalarOf(f.span(f.integer, undefined), {})
							],
							draws: "",
							reaches: ["span admitted" as const]
						}
					],
					runs: 3000,
					shrink: completeShrink,
					features: features<LiteralFeature>([
						...Arr.flatMap(
							[
								"int",
								"float",
								"floatSpecial",
								"numeric",
								"money",
								"bool",
								"text",
								"uuid",
								"enum",
								"span",
								"vector"
							] as const,
							(kind): ReadonlyArray<LiteralFeature> => [`${kind} admitted`, `${kind} refused`]
						),
						"under a contract"
					]),
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				([literal, type], c) =>
					Effect.sync(() => {
						const want = admits(literal, type)
						c.note(`${literal.kind} ${want ? "admitted" : "refused"}`)
						if (contractOf(type) !== undefined) {
							c.note("under a contract")
						}
						assert.equal(
							check(literal, type) === undefined,
							want,
							`${literal.kind} at ${type.carrier}`
						)
					})
			)
		)
	)

	describe("numeric literals under a typmod", () => {
		type TypmodFeature =
			| "an infinity refused"
			| "NaN admitted"
			| "a negative scale"
			| "a scale above the precision"
			| "an overflow refused"
			| "a rounding refused"
			| "a value admitted"
		it.effect("admits exactly the values numeric(p, s) stores unchanged", (ctx) => {
			const decimal = (source: Source) =>
				decimalText(source.draw(bigint(-(10n ** 12n), 10n ** 12n)), source.draw(int(0, 8)))
			const special = element(["NaN", "Infinity", "-Infinity"])
			return searched(
				ctx,
				explore(
					{
						suite: "unit/ir/scalar-81",
						literal: Formatter.format,
						draw: drawn(
							(source) =>
								[
									source.draw(
										weighted([
											[9, decimal],
											[1, special]
										])
									),
									source.draw(int(1, 14)),
									source.draw(int(-4, 16))
								] as const
						),
						runs: 2000,
						shrink: completeShrink,
						features: features<TypmodFeature>([
							"an infinity refused",
							"NaN admitted",
							"a negative scale",
							"a scale above the precision",
							"an overflow refused",
							"a rounding refused",
							"a value admitted"
						]),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([text, precision, scale], c) =>
						Effect.sync(() => {
							const d = Decimal.of(text)
							const stored = normalizeNumeric(d, { precision, scale })
							const unchanged = stored.ok && compareDecimal(stored.value, d) === 0
							if (scale < 0) {
								c.note("a negative scale")
							}
							if (scale > precision) {
								c.note("a scale above the precision")
							}
							if (text === "NaN" && unchanged) {
								c.note("NaN admitted")
							}
							if (Str.endsWith("Infinity")(text) && !unchanged) {
								c.note("an infinity refused")
							}
							if (unchanged) {
								c.note("a value admitted")
							} else if (!stored.ok) {
								c.note("an overflow refused")
							} else if (!Str.endsWith("Infinity")(text)) {
								c.note("a rounding refused")
							}
							assert.equal(
								at(text, numeric(precision, scale)) === undefined,
								unchanged,
								`${text} as numeric(${precision},${scale})`
							)
						})
				)
			)
		})
	})
})

/**
 * The fields every predicate expression shares, each defaulted; a kind's own fields, its arguments and its
 * non-null proof among them, are given.
 */
type Shared = "id" | "volatility" | "failure" | "deps"
type PredicateFields = TableExpr extends infer E
	? E extends TableExpr
		? Omit<E, Shared> & Partial<Pick<E, Exclude<Shared, "id">>>
		: never
	: never

const predicateExpr = (id: ExprId, fields: PredicateFields): TableExpr => ({
	id,
	volatility: "immutable",
	failure: "total",
	deps: { params: [], nodes: [] },
	...fields
})

/** The same predicate under arbitrary allocated ids. */
const allocated = (ids: readonly [string, string, string]): ExprTable => {
	const [root, value, zero] = [ExprId(ids[0]), ExprId(ids[1]), ExprId(ids[2])]
	return {
		root,
		exprs: {
			[root]: predicateExpr(root, {
				kind: "op",
				op: OpId("int8ge"),
				args: [value, zero],
				type: scalarTypes.bool,
				nonNull: "strict"
			}),
			[value]: predicateExpr(value, {
				kind: "value",
				type: scalarTypes.int8,
				args: [],
				nonNull: "storage"
			}),
			[zero]: predicateExpr(zero, {
				kind: "literal",
				value: { kind: "int", value: 0n },
				type: scalarTypes.int8,
				args: [],
				nonNull: "literal"
			})
		}
	}
}

/** VALUE >= 0 over int8, in normal form. */
const nonNegative: ExprTable = allocated(["e#0", "e#1", "e#2"])

const contractOver = (predicate: ExprTable): unknown => ({
	carrier: "int8",
	caps: scalarTypes.int8.caps,
	contract: { name: "Cents", base: scalarTypes.int8, predicate }
})

describe("contract predicates", () => {
	const edited = (key: string, patch: (expr: TableExpr) => TableExpr): ExprTable => ({
		...nonNegative,
		exprs: { ...nonNegative.exprs, [key]: patch(defined(nonNegative.exprs[ExprId(key)])) }
	})
	/**
	 * The rules of a contract predicate (expr.ts predicateProblems), each broken once on VALUE >= 0: the table is in
	 * normal form, so its canonical text cannot depend on allocation; its root and every argument resolve, every entry is
	 * reachable and none is its own argument; it reads only VALUE, of the base type, and literals, with no column, no
	 * parameter and no dependency; it is total, immutable and boolean, so no checked cast or domain cast lies in it; its
	 * literals fit the base. A contract decoded with a broken predicate is MalformedDescription.
	 */
	const broken: Arr.NonEmptyReadonlyArray<readonly [string, ExprTable]> = [
		["not in normal form", allocated(["e3", "e1", "e2"])],
		["a missing root", { root: ExprId("missing"), exprs: {} }],
		[
			"a dangling argument",
			edited("e#0", (e) => (e.kind === "op" ? { ...e, args: [ExprId("e#1"), ExprId("e#9")] } : e))
		],
		[
			"an unreachable entry",
			{
				...nonNegative,
				exprs: {
					...nonNegative.exprs,
					[ExprId("e#3")]: { ...defined(nonNegative.exprs[ExprId("e#1")]), id: ExprId("e#3") }
				}
			}
		],
		[
			"a cycle",
			edited("e#2", (e) => ({
				...e,
				kind: "op",
				op: OpId("int8pl"),
				args: [ExprId("e#0")],
				nonNull: "strict"
			}))
		],
		[
			"a column",
			edited("e#1", (e) => ({
				...e,
				kind: "column",
				column: { node: NodeId("n1"), name: "x" },
				args: [],
				nonNull: "storage"
			}))
		],
		[
			"a parameter",
			edited("e#1", (e) => ({
				...e,
				kind: "param",
				param: ParamId("p"),
				role: "compare",
				args: [],
				nonNull: "codec"
			}))
		],
		["a dependency", edited("e#1", (e) => ({ ...e, deps: { params: [ParamId("p")], nodes: [] } }))],
		["VALUE of another type", edited("e#1", (e) => ({ ...e, type: scalarTypes.int4 }))],
		["a root that can fail", edited("e#0", (e) => ({ ...e, failure: "canFail" }))],
		["a stable root", edited("e#0", (e) => ({ ...e, volatility: "stable" }))],
		["a root that is no boolean", edited("e#0", (e) => ({ ...e, type: scalarTypes.int8 }))],
		[
			"a checked cast",
			edited("e#1", (e) => ({
				...e,
				kind: "cast",
				checked: true,
				args: [ExprId("e#2")],
				nonNull: "strict"
			}))
		],
		[
			"a domain cast",
			edited("e#1", (e) => ({ ...e, kind: "domainCast", args: [ExprId("e#2")], nonNull: "strict" }))
		],
		[
			"a literal outside the base",
			edited("e#2", (e) => ({ ...e, value: { kind: "int", value: 1n << 70n } }))
		]
	]
	/** Every spelling of the three entries from a pool of identifiers. */
	const pool = ["e1", "e2", "e3", "e12", "e77", "e90"] as const
	const spellings = filter(
		(source) =>
			[source.draw(element(pool)), source.draw(element(pool)), source.draw(element(pool))] as const,
		([r, v, z]) => new Set([r, v, z]).size === 3,
		1
	)
	type PredicateFeature = `broken: ${string}` | "an allocation normalized"
	type PredicateCase =
		| { readonly kind: "allocated"; readonly ids: readonly [string, string, string] }
		| { readonly kind: "broken"; readonly rule: string; readonly table: ExprTable }

	it.effect(
		"normalizes any allocation to the one table numbered from the root, and refuses every predicate that breaks a rule",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/contract-predicates",
						literal: Formatter.format,
						generator: oneOf<PredicateCase>([
							map(spellings, (ids): PredicateCase => ({ kind: "allocated", ids })),
							map(element(broken), ([rule, table]): PredicateCase => ({
								kind: "broken",
								rule,
								table
							}))
						]),
						limit: 300,
						features: features<PredicateFeature>([
							"an allocation normalized",
							...Arr.map(broken, ([rule]): PredicateFeature => `broken: ${rule}`)
						]),
						caseHang: Duration.minutes(2)
					},
					(c, n) =>
						Effect.sync(() => {
							if (c.kind === "allocated") {
								n.note("an allocation normalized")
								const normal = succeeded(normalizeExprTable(allocated(c.ids)))
								assert.equal(
									succeeded(encode(normal, everyProperty)),
									succeeded(encode(nonNegative, everyProperty))
								)
								assert.deepEqual(predicateProblems(normal, scalarTypes.int8), [])
								const decoded = succeeded(decodeScalarType(contractOver(normal)))
								assert.equal(contractOf(decoded)?.predicate?.root, ExprId("e#0"))
								assert.equal(isRefined(decoded), true)
								return
							}
							n.note(`broken: ${c.rule}`)
							assert.notDeepEqual(predicateProblems(c.table, scalarTypes.int8), [], c.rule)
							assert.equal(
								fail(decodeScalarType(contractOver(c.table))).reason._tag,
								"MalformedDescription",
								c.rule
							)
						})
				)
			)
	)
})

describe("money and vector values", () => {
	it.effect("agree with the owned Money carrier", (ctx) =>
		Effect.gen(function* () {
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/ir/scalar-131",
						literal: Formatter.format,
						draw: drawn(bigint(-(2n ** 63n), 2n ** 63n - 1n)),
						runs: 500,
						shrink: completeShrink,
						features: noFeatures,
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(units) =>
						Effect.sync(() => {
							const payload = Money.of(units)[canonicalTag]().payload
							assert.equal(isMoneyPayload(payload), true)
							assert.equal(succeeded(defaultRevivers.m(payload))[canonicalTag]().payload, payload)
							assert.equal(
								succeeded(encode({ m: succeeded(MoneyText.of(units)) }, everyProperty)),
								`{"m":"~m:${payload}"}`
							)
						})
				)
			)
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/ir/scalar-133",
						literal: Formatter.format,
						draw: drawn(
							oneOf([
								element([
									"0",
									"-1",
									"9223372036854775807",
									"-9223372036854775808",
									"",
									"-",
									"-0",
									"007",
									"1.5",
									"+1",
									" 1",
									"9223372036854775808",
									"1e3"
								]),
								string(codePoint(0x20, 0x7e), { min: 0, max: 22 })
							])
						),
						runs: 1000,
						shrink: completeShrink,
						features: noFeatures,
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							assert.equal(isMoneyPayload(text), Money.fromCanonical(text).ok, text)
							assert.equal(MoneyText.make(text).ok, isMoneyPayload(text), text)
						})
				)
			)
		})
	)

	it.effect("agree with the Vector carrier", (ctx) =>
		Effect.gen(function* () {
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/ir/scalar-177",
						literal: Formatter.format,
						draw: drawn(array(float(-floatMax, floatMax), { min: 1, max: 8 })),
						runs: 500,
						shrink: completeShrink,
						features: noFeatures,
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(components) =>
						Effect.sync(() => {
							const vector = Vector.make(Float32Array.from(components), components.length)
							const payload = succeeded(Vector.canonical(vector))[canonicalTag]().payload
							assert.equal(isVectorPayload(payload), true, payload)
							assert.equal(payload, Vector.componentText(vector))
							assert.equal(succeeded(defaultRevivers.v(payload))[canonicalTag]().payload, payload)
							assert.equal(succeeded(VectorText.of(vector))[canonicalTag]().payload, payload)
							assert.equal(
								succeeded(encode({ v: succeeded(VectorText.of(vector)) }, everyProperty)),
								`{"v":"~v:${payload}"}`
							)
						})
				)
			)
			const near = oneOf([
				element([
					"[1]",
					"[1.0000000116860974e-7]",
					"[]",
					"[-0]",
					"[0.1]",
					"[1, 2]",
					"1,2",
					"[1]@",
					"[1,2]@docs",
					"[NaN]",
					"[Infinity]",
					"[1.0]",
					"[01]"
				]),
				string(codePoint(0x20, 0x7e), { min: 0, max: 12 }),
				map(
					array(
						oneOf<number | string>([
							weighted([
								[8, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
								[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
							]),
							element(["-0", "1.0", "01", " 1", "1e400"])
						]),
						{ min: 0, max: 4 }
					),
					(xs) =>
						`[${Arr.join(
							Arr.map(xs, (x) => String(x)),
							","
						)}]`
				)
			])
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/ir/scalar-179",
						literal: Formatter.format,
						draw: drawn(near),
						runs: 1000,
						shrink: completeShrink,
						features: noFeatures,
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							assert.equal(isVectorPayload(text), Vector.fromCanonical(text).ok, text)
							assert.equal(VectorText.make(text).ok, isVectorPayload(text), text)
						})
				)
			)
		})
	)
})

describe("decimals", () => {
	it.effect(
		"admit only the canonical numeric_out text and the special values, and keep and carry it byte for byte",
		(ctx) => {
			const texts = oneOf([
				(source: Source) =>
					decimalText(source.draw(bigint(-(10n ** 20n), 10n ** 20n)), source.draw(int(0, 6))),
				element([
					"NaN",
					"Infinity",
					"-Infinity",
					"0.0145",
					"-0.0015",
					"",
					"-",
					".",
					"+1",
					"1e",
					"1.2.3",
					" 1",
					"nan",
					"1_000",
					"0x10",
					"123.",
					".5",
					"1e10",
					"1.5E-3",
					"007",
					"-0",
					"-0.00",
					"+Infinity"
				]),
				string(codePoint(0x20, 0x7e), { min: 0, max: 12 })
			])
			return searched(
				ctx,
				explore(
					{
						suite: "unit/ir/decimal-payloads",
						literal: Formatter.format,
						draw: drawn(texts),
						runs: 2000,
						shrink: completeShrink,
						features: features<"a payload" | "a special value" | "no payload">([
							"a payload",
							"a special value",
							"no payload"
						]),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(text, c) =>
						Effect.sync(() => {
							const payload = isDecimalPayload(text)
							assert.equal(payload, Decimal.fromCanonical(text).ok, text)
							const made = DecimalText.make(text)
							assert.equal(made.ok, payload, text)
							if (!payload) {
								c.note("no payload")
								assert.equal(fail(made).reason._tag, "MalformedDescription")
								return
							}
							c.note(
								text === "NaN" || Str.endsWith("Infinity")(text) ? "a special value" : "a payload"
							)
							const d = succeeded(made)
							assert.equal(d[canonicalTag]().payload, text)
							assert.equal(isDecimalLike(d), true)
							assert.equal(succeeded(encode({ d }, everyProperty)), `{"d":"~d:${text}"}`)
						})
				)
			)
		}
	)
})
