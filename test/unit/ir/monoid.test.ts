/**
 * The closed monoids (ir/monoid.ts): each one's combine and identity against the monoid laws, and its carriers.
 *
 * - The laws, universal: from the identity, one step is the step's value alone; two steps commute, so a fold over a
 *   counted family, whose order is hidden, has one value, for every monoid that says it is commutative; concat's two
 *   steps are one step of their concatenation, its associativity, and the box holds two steps it does not commute,
 *   so its flag is no lie; or's step is idempotent; and twos holds, after two steps, the codes both of them set (the
 *   two-plane model), so a set stepped twice is twice.
 * - The combine is evaluated over host values: bigints for count, sum and max over natural, Sets of handles for or and
 *   twos, handles in roster order for max over a closed id, and strings for concat.
 * - `admits`, by the specification: sum refuses the floats, or and twos refuse every carrier but a set, and max refuses
 *   every carrier with no least value.
 *
 * The box, exhausted: accumulators and steps over naturals 0 to 4, over every subset of a five-code roster with a
 * hole (a twos state's twos plane within its ones plane, as every fold's is), over its live codes, and over five texts:
 * the empty text, two letters, their concatenation and a supplementary-plane character.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { type CombineBuild, type MonoidSpec, monoids } from "#compiler/ir/monoid.ts"
import type { Roster, ScalarType } from "#compiler/ir/scalar.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const int8: ScalarType = { carrier: "int8", caps: capabilitiesOf("int8"), contract: undefined }
const natural: ScalarType = {
	...int8,
	contract: {
		name: succeeded(parseDeclaredName("natural")),
		base: { carrier: "int8", caps: capabilitiesOf("int8"), contract: undefined },
		predicate: undefined,
		facts: []
	}
}
/** A roster of five codes whose code 2 is a hole: live handles h0, h1, h3, h4 in code order. */
const roster: Roster = {
	closed: succeeded(parseDeclaredName("Kind")),
	handles: nonEmpty(["h0", "h1", "h3", "h4"])
}
const set: ScalarType = { carrier: "bits", caps: capabilitiesOf("bits"), roster }
const code: ScalarType = {
	carrier: "code",
	caps: capabilitiesOf("code"),
	contract: undefined,
	roster
}

/** A host value of the box: a bigint, a Set of handles, or a handle or a text. */
type Value = bigint | ReadonlySet<string> | string

const rank = (handle: string): number => roster.handles.indexOf(handle)

/** The combine's operations over host values, and its one, as the database computes them. */
const host: CombineBuild<Value> = {
	one: 1n,
	apply: (fn, left, right) => {
		switch (fn) {
			case "add":
				return typeof left === "bigint" && typeof right === "bigint"
					? left + right
					: assert.fail(fn)
			case "union":
				return typeof left === "object" && typeof right === "object"
					? new Set([...left, ...right])
					: assert.fail(fn)
			case "intersection":
				return typeof left === "object" && typeof right === "object"
					? new Set(Arr.filter([...left], (h) => right.has(h)))
					: assert.fail(fn)
			case "greatest":
				if (typeof left === "bigint" && typeof right === "bigint") {
					return left > right ? left : right
				}
				return typeof left === "string" && typeof right === "string"
					? rank(left) >= rank(right)
						? left
						: right
					: assert.fail(fn)
			case "concat":
				return typeof left === "string" && typeof right === "string"
					? `${left}${right}`
					: assert.fail(fn)
		}
	}
}

/** A literal identity as its host value. */
const hostOf = (literal: TypedLiteral): Value => {
	switch (literal.kind) {
		case "int":
			return literal.value
		case "handles":
			return new Set(literal.handles)
		case "handle":
			return literal.handle
		case "text":
			return literal.value
		case "numeric":
		case "float":
		case "floatSpecial":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "span":
		case "vector":
			return assert.fail(`no host value of the box for ${literal.kind}`)
	}
}

/** One value's canonical spelling, so two host values compare by value. */
const spell = (v: Value): string =>
	typeof v === "object" ? `{${Arr.join(Arr.sort([...v], Order.String), ",")}}` : `${v}`

const spellAll = (vs: ReadonlyArray<Value>): string => Arr.join(Arr.map(vs, spell), " ")

/** One case: a monoid over one carrier, its accumulator planes, and two steps. */
interface Pattern {
	readonly monoid: "count" | "sum" | "or" | "twos" | "maxNatural" | "maxCode" | "concat"
	readonly before: ReadonlyArray<Value>
	readonly x: Value
	readonly y: Value
}

const naturals: ReadonlyArray<bigint> = [0n, 1n, 2n, 3n, 4n]
const texts: ReadonlyArray<string> = ["", "a", "b", "ab", "\u{1F600}"]
const subsets: ReadonlyArray<ReadonlySet<string>> = Array.from(
	{ length: 2 ** roster.handles.length },
	(_, mask) => new Set(Arr.filter(roster.handles, (_, i) => ((mask >> i) & 1) === 1))
)

const patterns: Gen<Pattern> = (s) => {
	const monoid = s.draw(
		element(["count", "sum", "or", "twos", "maxNatural", "maxCode", "concat"] as const)
	)
	const pick = <A>(values: ReadonlyArray<A>): A =>
		values[s.draw(int(0, values.length - 1))] ?? assert.fail("a value")
	switch (monoid) {
		case "count":
			return { monoid, before: [pick(naturals)], x: 1n, y: 1n }
		case "sum":
		case "maxNatural":
			return { monoid, before: [pick(naturals)], x: pick(naturals), y: pick(naturals) }
		case "or":
			return { monoid, before: [pick(subsets)], x: pick(subsets), y: pick(subsets) }
		case "twos": {
			const ones = pick(subsets)
			const twos = pick(Arr.filter(subsets, (t) => Arr.every([...t], (h) => ones.has(h))))
			return { monoid, before: [ones, twos], x: pick(subsets), y: pick(subsets) }
		}
		case "maxCode":
			return {
				monoid,
				before: [pick(roster.handles)],
				x: pick(roster.handles),
				y: pick(roster.handles)
			}
		case "concat":
			return { monoid, before: [pick(texts)], x: pick(texts), y: pick(texts) }
	}
}

const specOf = (
	monoid: Pattern["monoid"]
): { readonly spec: MonoidSpec; readonly carrier: ScalarType } => {
	switch (monoid) {
		case "count":
			return { spec: monoids.count, carrier: natural }
		case "sum":
			return { spec: monoids.sum, carrier: natural }
		case "or":
			return { spec: monoids.or, carrier: set }
		case "twos":
			return { spec: monoids.twos, carrier: set }
		case "maxNatural":
			return { spec: monoids.max, carrier: natural }
		case "maxCode":
			return { spec: monoids.max, carrier: code }
		case "concat":
			return { spec: monoids.concat, carrier: text }
	}
}

/**
 * The monoid laws at one case: the identity's first step, two steps' commutativity where the monoid states it and
 * concat's associativity, and the set monoids' models.
 */
const laws = (
	{ monoid, before, x, y }: Pattern,
	c: Case<Pattern["monoid"] | "concat noncommuting">
) =>
	Effect.sync(() => {
		const { spec, carrier } = specOf(monoid)
		assert.ok(spec.admits(carrier), `${spec.name} admits its carrier`)
		const step = (v: Value) =>
			spec.step === "none" ? ({ kind: "one" } as const) : ({ kind: "value", expr: v } as const)
		const run = (planes: ReadonlyArray<Value>, v: Value) =>
			spec.combine(nonEmpty(planes), step(v), host)
		const identity = Arr.map(spec.identity(carrier), hostOf)
		assert.equal(identity.length, spec.planes, "an identity per plane")
		const first = run(identity, x)
		const alone: ReadonlyArray<Value> =
			monoid === "count" ? [1n] : monoid === "twos" ? [x, new Set<string>()] : [x]
		assert.equal(spellAll(first), spellAll(alone), "from the identity, one step is the step alone")
		if (spec.commutative) {
			assert.equal(
				spellAll(run(run(before, x), y)),
				spellAll(run(run(before, y), x)),
				"two steps commute"
			)
		} else {
			assert.equal(
				spellAll(run(run(before, x), y)),
				spellAll(run(before, host.apply("concat", x, y))),
				"two steps are one step of their concatenation"
			)
			if (spellAll(run(run(before, x), y)) !== spellAll(run(run(before, y), x))) {
				c.note("concat noncommuting")
			}
		}
		if (monoid === "or") {
			assert.equal(
				spellAll(run(run(before, x), x)),
				spellAll(run(before, x)),
				"or's step is idempotent"
			)
		}
		if (monoid === "twos") {
			const [ones, twos = assert.fail("twos has two planes")] = run(run(identity, x), y)
			const both = Arr.filter(
				roster.handles,
				(h) => typeof x === "object" && typeof y === "object" && x.has(h) && y.has(h)
			)
			assert.equal(spell(twos), spell(new Set(both)), "twos holds the codes two steps set")
			assert.equal(spell(ones), spell(host.apply("union", x, y)), "ones holds every code set")
		}
		c.note(monoid)
	})

const float8: ScalarType = {
	carrier: "float8",
	caps: capabilitiesOf("float8"),
	contract: undefined
}
const text: ScalarType = {
	carrier: "text",
	caps: capabilitiesOf("text"),
	contract: undefined,
	text: { regex: "wildcard", lengthBound: undefined, byteBound: undefined }
}
const numeric: ScalarType = {
	carrier: "numeric",
	caps: capabilitiesOf("numeric"),
	typmod: { precision: 10, scale: 2 },
	contract: undefined
}

/** A carrier the box names, and the monoids the specification admits it to. */
interface Admission {
	readonly name: CarrierName
	readonly type: ScalarType
	readonly admitted: ReadonlyArray<MonoidSpec["name"]>
}

type CarrierName =
	| "natural"
	| "bigint"
	| "numeric(10,2)"
	| "double precision"
	| "text"
	| "a set"
	| "a closed id"

const carriers: readonly [Admission, ...Array<Admission>] = [
	{ name: "natural", type: natural, admitted: ["count", "sum", "max"] },
	{ name: "bigint", type: int8, admitted: ["sum", "max"] },
	{ name: "numeric(10,2)", type: numeric, admitted: ["sum"] },
	{ name: "double precision", type: float8, admitted: [] },
	{ name: "text", type: text, admitted: ["concat"] },
	{ name: "a set", type: set, admitted: ["or", "twos"] },
	{ name: "a closed id", type: code, admitted: ["max"] }
]

describe("the closed monoids", () => {
	it.effect("keep the monoid laws on every admitted carrier", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/monoid",
					generator: patterns,
					literal: Formatter.format,
					limit: 5 + 125 + 125 + 4096 + 81 * 256 + 64 + 125,
					coverage: requiredInSpace<Pattern["monoid"] | "concat noncommuting">([
						"count",
						"sum",
						"or",
						"twos",
						"maxNatural",
						"maxCode",
						"concat",
						"concat noncommuting"
					]),
					caseHang,
					box: "naturals 0 to 4, every subset of a five-code roster with a hole, its live codes, five texts",
					oracle: { kind: "universal", name: "the monoid laws and the two-plane model" }
				},
				laws
			)
		)
	)

	it.effect("admit exactly the carriers the specification names", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/monoid-admits",
					generator: element(carriers),
					literal: (c: Admission) => c.name,
					limit: carriers.length,
					coverage: requiredInSpace<CarrierName>([
						"natural",
						"bigint",
						"numeric(10,2)",
						"double precision",
						"text",
						"a set",
						"a closed id"
					]),
					caseHang,
					box: "every carrier of the box",
					oracle: { kind: "specification", name: "each monoid's admitted carriers" }
				},
				(carrier: Admission, c: Case<CarrierName>) =>
					Effect.sync(() => {
						for (const spec of [
							monoids.count,
							monoids.sum,
							monoids.or,
							monoids.twos,
							monoids.max,
							monoids.concat
						]) {
							assert.equal(
								spec.admits(carrier.type),
								carrier.admitted.includes(spec.name),
								`${spec.name} over ${carrier.name}`
							)
						}
						c.note(carrier.name)
					})
			)
		)
	)
})
