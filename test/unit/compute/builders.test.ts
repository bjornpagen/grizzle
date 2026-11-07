import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, oneOf } from "@grizzle/testing/gen"
import {
	type Drawn,
	drawnFeature,
	type DrawnFeature,
	lsw,
	passed,
	WILD_KINDS
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { baseOf, type ScalarType, sameScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { type ScalarTerm, typedTermOf } from "#compiler/scalar/compute/term.ts"
import { exactType } from "#compiler/scalar/compute/types.ts"
import { pgDescriptors as descriptors } from "#compiler/scalar/pg.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	testContract,
	decimal,
	param,
	testPg,
	testSpan,
	type TestField,
	v
} from "#test/unit/compute/support.ts"

const Cents = testContract("Cents", testPg.bigint, (x) => x.ge(0n))
const EpochDay = testContract("EpochDay", testPg.bigint, undefined)

const cents = v("cents", Cents)
const plainBigint = v("b", testPg.bigint)
const int = v("i", testPg.integer)
const flag = v("flag", testPg.boolean)

/** The type a builder registered for a typed term. */
const typeOf = (term: unknown): ScalarType => {
	const t = typedTermOf(term)
	if (t === undefined) {
		return assert.fail("a typed term")
	}
	return t.type
}

/** Whether a term is typed, its type exactly the descriptor's. */
const typed = (term: unknown, of: { readonly scalar: ScalarType }): boolean => {
	const t = typedTermOf(term)
	return t !== undefined && sameScalarType(t.type, of.scalar)
}

/** The CompileError `f` throws: one that returns, or throws anything else, fails the test. */
const throws = (f: () => unknown): CompileError => {
	const caught = catchCompileError(f)
	if (caught.ok) {
		throw new Error("expected a CompileError")
	}
	return caught.error
}

/**
 * The typing rules of the builders (compute/builders.ts, compute/lower.ts), stated over operands of one base, bigint,
 * so no widening between integer types enters: two operands meet only when their nominal types are one (a contract its
 * own contract, a bare base its bare base, Compute.base the explicit way between them); LEAST, GREATEST and a
 * conditional keep that type, a sum is exact, an exact integer one digit past its base's 19, and a comparison is
 * boolean. A conditional is typed by its first branch, a term, never a JavaScript literal or a parameter; the other
 * branch is a term or parameter of that type, or a JavaScript literal of its base's host kind (integer a number, bigint
 * a bigint, numeric a bigint). A span's endpoints are typed by its endpoint descriptor, and its width, the difference of
 * its endpoints, is an exact integer; any other descriptor, or an operand that is no span, is malformed.
 */
type Operand = "cents" | "other cents" | "epoch day" | "bigint" | "based cents"
const operands: Arr.NonEmptyReadonlyArray<Operand> = [
	"cents",
	"other cents",
	"epoch day",
	"bigint",
	"based cents"
]

const termOf: { readonly [O in Operand]: ScalarTerm } = {
	cents,
	"other cents": v("cents2", Cents),
	"epoch day": v("e", EpochDay),
	bigint: plainBigint,
	"based cents": Compute.base(cents)
}

const nominalOf: { readonly [O in Operand]: TestField } = {
	cents: Cents,
	"other cents": Cents,
	"epoch day": EpochDay,
	bigint: testPg.bigint,
	"based cents": testPg.bigint
}
type BinaryOp = "add" | "eq" | "least" | "greatest"
/** The type a binary builder gives its term, or "predicate" for a comparison, a predicate by construction. */
const binary: {
	readonly [B in BinaryOp]: (a: ScalarTerm, b: ScalarTerm) => ScalarType | "predicate"
} = {
	add: (a, b) => typeOf(Compute.add(a, b)),
	eq: (a, b) => {
		Compute.eq(a, b)
		return "predicate"
	},
	least: (a, b) => typeOf(Compute.least(a, b)),
	greatest: (a, b) => typeOf(Compute.greatest(a, b))
}

type FirstBranch =
	| "integer literal"
	| "bigint literal"
	| "numeric literal"
	| "integer column"
	| "cents column"
	| "number"
	| "integer parameter"

type OtherBranch =
	| "number"
	| "bigint"
	| "fraction"
	| "integer parameter"
	| "bigint parameter"
	| "integer column"
	| "cents column"

const firsts: Arr.NonEmptyReadonlyArray<FirstBranch> = [
	"integer literal",
	"bigint literal",
	"numeric literal",
	"integer column",
	"cents column",
	"number",
	"integer parameter"
]

const others: Arr.NonEmptyReadonlyArray<OtherBranch> = [
	"number",
	"bigint",
	"fraction",
	"integer parameter",
	"bigint parameter",
	"integer column",
	"cents column"
]

/** A first branch: a term of its type, a parameter of its declared type among them, or a JavaScript literal, which no first branch may be. */
const firstOf: {
	readonly [F in FirstBranch]: {
		readonly operand: ScalarTerm | number
		readonly term: TestField | undefined
	}
} = {
	"integer literal": { operand: Compute.literal(testPg.integer, 1), term: testPg.integer },
	"bigint literal": { operand: Compute.literal(testPg.bigint, 1n), term: testPg.bigint },
	"numeric literal": {
		operand: Compute.literal(testPg.numeric, decimal("0.5")),
		term: testPg.numeric
	},
	"integer column": { operand: int, term: testPg.integer },
	"cents column": { operand: cents, term: Cents },
	number: { operand: 1, term: undefined },
	"integer parameter": { operand: param("n", testPg.integer), term: testPg.integer }
}

/** The other branch, and the type it meets as a term or parameter, or the host kind it is as a JavaScript literal. */
const otherOf: {
	readonly [O in OtherBranch]: {
		readonly operand: ScalarTerm | number | bigint
		readonly meets:
			| { readonly kind: "typed"; readonly type: TestField }
			| { readonly kind: "host"; readonly host: "number" | "bigint" | "fraction" }
	}
} = {
	number: { operand: 0, meets: { kind: "host", host: "number" } },
	bigint: { operand: 0n, meets: { kind: "host", host: "bigint" } },
	fraction: { operand: 0.5, meets: { kind: "host", host: "fraction" } },
	"integer parameter": {
		operand: param("d", testPg.integer),
		meets: { kind: "typed", type: testPg.integer }
	},
	"bigint parameter": {
		operand: param("b", testPg.bigint),
		meets: { kind: "typed", type: testPg.bigint }
	},
	"integer column": { operand: int, meets: { kind: "typed", type: testPg.integer } },
	"cents column": { operand: cents, meets: { kind: "typed", type: Cents } }
}

/** The JavaScript host kind a literal adopting each first branch's base must be. */
const hostKindOf = (t: TestField): "number" | "bigint" =>
	sameScalarType(baseOf(t.scalar), testPg.integer.scalar) ? "number" : "bigint"

type Endpoint = "cents" | "integer" | "bigint"
const endpointOf: { readonly [E in Endpoint]: TestField } = {
	cents: Cents,
	integer: testPg.integer,
	bigint: testPg.bigint
}

/** A descriptor other than the span's own endpoint: its bare base, or another integer type. */
const wrongEndpointOf: { readonly [E in Endpoint]: TestField } = {
	cents: testPg.bigint,
	integer: testPg.bigint,
	bigint: testPg.integer
}
type SpanFn = "lower" | "upper" | "width"

type BuilderCase =
	| { readonly kind: "binary"; readonly op: BinaryOp; readonly a: Operand; readonly b: Operand }
	| { readonly kind: "cond"; readonly first: FirstBranch; readonly other: OtherBranch }
	| {
			readonly kind: "span"
			readonly fn: SpanFn
			readonly endpoint: Endpoint
			readonly descriptor: "own" | "other"
			readonly operand: "span" | "no span"
	  }

type BuilderFeature =
	| `binary ${BinaryOp} ${"typed" | "refused"}`
	| `cond ${"typed" | "refused"}`
	| `span ${SpanFn} ${"typed" | "refused"}`

describe("Compute builders", () => {
	it.effect("type and refuse operands by the builders' typing rules", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/compute/builder-typing",
					draw: drawn(
						oneOf<BuilderCase>([
							(source) => ({
								kind: "binary",
								op: source.draw(element<BinaryOp>(["add", "eq", "least", "greatest"])),
								a: source.draw(element(operands)),
								b: source.draw(element(operands))
							}),
							(source) => ({
								kind: "cond",
								first: source.draw(element(firsts)),
								other: source.draw(element(others))
							}),
							(source) => ({
								kind: "span",
								fn: source.draw(element<SpanFn>(["lower", "upper", "width"])),
								endpoint: source.draw(element<Endpoint>(["cents", "integer", "bigint"])),
								descriptor: source.draw(element(["own", "other"] as const)),
								operand: source.draw(element(["span", "no span"] as const))
							})
						])
					),
					literal: Formatter.format,
					coverage: required<BuilderFeature>(
						[
							"binary add typed",
							"binary add refused",
							"binary eq typed",
							"binary eq refused",
							"binary least typed",
							"binary least refused",
							"binary greatest typed",
							"binary greatest refused",
							"cond typed",
							"cond refused",
							"span lower typed",
							"span lower refused",
							"span upper typed",
							"span upper refused",
							"span width typed",
							"span width refused"
						],
						{ cases: 600, sense: notesOnly }
					),
					kept: [],
					/**
					 * The rotating stream's sample: each arm is a third of the cases and each outcome of an arm at least a
					 * fifth of those.
					 */
					runs: 600,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(sketch: BuilderCase, c) =>
					Effect.sync(() => {
						switch (sketch.kind) {
							case "binary": {
								const [a, b] = [sketch.a, sketch.b]
								const build = () => binary[sketch.op](termOf[a], termOf[b])
								if (!sameScalarType(nominalOf[a].scalar, nominalOf[b].scalar)) {
									c.note(`binary ${sketch.op} refused`)
									assert.equal(
										throws(build).reason._tag,
										"MalformedDescription",
										`${sketch.op}(${a}, ${b})`
									)
									return
								}
								c.note(`binary ${sketch.op} typed`)
								const built = build()
								if (built === "predicate") {
									return
								}
								const expected =
									sketch.op === "add" ? exactType("exactInteger", 20) : nominalOf[a].scalar
								assert.ok(
									sameScalarType(built, expected),
									`${sketch.op}(${a}, ${b}) typed ${typeLabel(built)}`
								)
								return
							}
							case "cond": {
								const [firstName, otherName] = [sketch.first, sketch.other]
								const [first, other] = [firstOf[firstName], otherOf[otherName]]
								const build = () => Compute.cond(flag, first.operand, other.operand)
								const meets =
									first.term !== undefined &&
									(other.meets.kind === "typed"
										? sameScalarType(other.meets.type.scalar, first.term.scalar)
										: other.meets.host === hostKindOf(first.term))
								if (first.term === undefined || !meets) {
									c.note("cond refused")
									assert.equal(
										throws(build).reason._tag,
										"MalformedDescription",
										`cond(${firstName}, ${otherName})`
									)
									return
								}
								c.note("cond typed")
								assert.equal(typed(build(), first.term), true, `cond(${firstName}, ${otherName})`)
								return
							}
							case "span": {
								const endpoint = endpointOf[sketch.endpoint]
								const operand = sketch.operand === "span" ? v("s", testSpan(endpoint)) : cents
								const descriptor =
									sketch.descriptor === "own" ? endpoint : wrongEndpointOf[sketch.endpoint]
								const build = () => Compute[sketch.fn](operand, descriptor)
								if (sketch.operand === "no span" || sketch.descriptor === "other") {
									c.note(`span ${sketch.fn} refused`)
									assert.equal(throws(build).reason._tag, "MalformedDescription")
									return
								}
								c.note(`span ${sketch.fn} typed`)
								const built = typeOf(build())
								assert.ok(
									sketch.fn === "width"
										? built.carrier === "exactInteger"
										: sameScalarType(built, endpoint.scalar),
									`${sketch.fn} over a span of ${sketch.endpoint}`
								)
								return
							}
						}
					})
			)
		)
	)
})

/**
 * Where a JavaScript caller's value meets Compute: a literal's type and a cast's target, read as descriptors
 * (compute/builders.ts describedField), and a literal's value, read by the registry's literal boundary (Call.literal).
 */
type ComputeSite = "literal type" | "cast target" | "literal value"
type BoundaryFeature = DrawnFeature<never> | `site ${ComputeSite}`

/**
 * A descriptor (live pg.bigint, or wild) at a descriptor site, or a value (a live int8 bigint, or wild) at the literal
 * value.
 */
const boundaryCaseGen: Gen<readonly [Drawn<unknown, never>, ComputeSite]> = oneOf([
	(source) =>
		[
			source.draw(
				lsw<unknown>({
					live: constant<unknown>(descriptors.bigint),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			),
			source.draw(element<ComputeSite>(["literal type", "cast target"]))
		] as const,
	(source) =>
		[
			source.draw(
				lsw<unknown>({
					live: bigint(int8Min.value, int8Max.value),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			),
			"literal value"
		] as const
])

describe("a JavaScript caller's operands", () => {
	it.effect(
		"build from a descriptor and an int8 literal, and refuse every wild descriptor and value as malformed",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/compute/wild-operands",
						draw: drawn(boundaryCaseGen),
						literal: Formatter.format,
						coverage: required<BoundaryFeature>(
							[
								"live",
								...Arr.map(WILD_KINDS, (kind): BoundaryFeature => `wild ${kind}`),
								"site literal type",
								"site cast target",
								"site literal value"
							],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						/**
						 * The rotating stream's sample of fourteen wild kinds beside the live arm at three sites.
						 */
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, site], c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							c.note(`site ${site}`)
							const x = passed(d)
							const build = (): ScalarTerm => {
								switch (site) {
									case "literal type":
										return Compute.literal(x, 1n)
									case "cast target":
										return Compute.cast(int, x)
									case "literal value":
										return Compute.literal(testPg.bigint, x)
								}
							}
							/**
							 * An int8 literal admits exactly a bigint within int8's range (the literal boundary admits any bigint, and
							 * building the term refuses one outside the range): the wild kind bigint-for-number draws both. No wild
							 * value is a descriptor a builder made.
							 */
							const admitted =
								d.kind === "live" ||
								(site === "literal value" &&
									typeof x === "bigint" &&
									x >= int8Min.value &&
									x <= int8Max.value)
							if (admitted) {
								assert.equal(typed(build(), testPg.bigint), true)
							} else {
								assert.equal(throws(build).reason._tag, "MalformedDescription")
							}
						})
				)
			)
	)
})
