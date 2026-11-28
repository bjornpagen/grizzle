/** What the properties of monoid.test.ts read: its spaces, models and helpers. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Result } from "effect"
import { combineRule } from "#compiler/check/fold.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { type MonoidName, monoidNames } from "#compiler/ir/desc.ts"
import { literalProblem, type TypedLiteral } from "#compiler/ir/expr.ts"
import { type CombineBuild, combine, type MonoidSpec, monoidSpecs } from "#compiler/ir/monoid.ts"
import { numericBoundOf, Roster, sameScalarType, type ScalarType } from "#compiler/ir/scalar.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import { AnalyzedPatterns } from "#compiler/text/refinement.ts"
import { succeeded, throwsDefect } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { declaredTypeGen, setTypeGen } from "#test/support/unit/ir/types.ts"

/** The int8 carrier, no contract. */
const int8: ScalarType = { carrier: "int8", caps: capabilitiesOf("int8"), contract: undefined }

/** natural: the builtin contract over int8. */
const natural: ScalarType = {
	carrier: "int8",
	contract: {
		name: succeeded(parseDeclaredName("natural")),
		base: int8,
		predicate: undefined,
		facts: []
	}
}

/** A roster of five codes whose code 2 is a hole: live handles h0, h1, h3, h4 in code order. */
const roster = Roster.of(
	succeeded(parseDeclaredName("Kind")),
	"ordered",
	nonEmpty(["h0", "h1", "h3", "h4"])
)

/** A set over the roster. */
const set: ScalarType = {
	carrier: "bits",
	caps: capabilitiesOf("bits"),
	contract: undefined,
	roster
}

/** A closed id of the roster. */
const code: ScalarType = {
	carrier: "code",
	caps: capabilitiesOf("code"),
	contract: undefined,
	roster,
	only: undefined
}

/** A host value of the box: a bigint, a Set of handles, or a handle or a text. */
type Value = bigint | ReadonlySet<string> | string

/** A handle's code in the roster. */
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
		case "sha256":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "span":
		case "vector":
		case "pattern":
			return assert.fail(`no host value of the box for ${literal.kind}`)
	}
}

/** One value's canonical spelling, so two host values compare by value. */
const spell = (v: Value): string =>
	typeof v === "object" ? `{${Arr.join(Arr.sort([...v], Order.String), ",")}}` : `${v}`

/** Host values' canonical spellings, in order. */
const spellAll = (vs: ReadonlyArray<Value>): string => Arr.join(Arr.map(vs, spell), " ")

/** One case: a monoid over one carrier, its accumulator planes, and two steps. */
export interface LawCase {
	readonly monoid: "count" | "sum" | "or" | "twos" | "maxNatural" | "maxCode" | "concat"
	readonly before: ReadonlyArray<Value>
	readonly x: Value
	readonly y: Value
}

/** The box's naturals: 0 to 4. */
const naturals: ReadonlyArray<bigint> = [0n, 1n, 2n, 3n, 4n]

/** The box's texts: the empty text, two letters, their concatenation and a supplementary-plane character. */
const texts: ReadonlyArray<string> = ["", "a", "b", "ab", "\u{1F600}"]

/** Every subset of the roster's live handles. */
const subsets: ReadonlyArray<ReadonlySet<string>> = Array.from(
	{ length: 2 ** roster.handles.length },
	(_, mask) => new Set(Arr.filter(roster.handles, (_, i) => ((mask >> i) & 1) === 1))
)

/** Every case of the box: a monoid over its carrier, its accumulator planes, and two steps. */
export const patterns: Gen<LawCase> = (s) => {
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

/** A law case's monoid and the carrier it is over. */
const specOf = (
	monoid: LawCase["monoid"]
): { readonly spec: MonoidSpec; readonly carrier: ScalarType } => {
	switch (monoid) {
		case "count":
			return { spec: monoidSpecs.count, carrier: natural }
		case "sum":
			return { spec: monoidSpecs.sum, carrier: natural }
		case "or":
			return { spec: monoidSpecs.or, carrier: set }
		case "twos":
			return { spec: monoidSpecs.twos, carrier: set }
		case "maxNatural":
			return { spec: monoidSpecs.max, carrier: natural }
		case "maxCode":
			return { spec: monoidSpecs.max, carrier: code }
		case "concat":
			return { spec: monoidSpecs.concat, carrier: text }
	}
}

/**
 * The monoid laws at one case: the identity's first step, two steps' commutativity where the monoid states it and
 * concat's associativity, and the set monoids' models.
 */
export const laws = (
	{ monoid, before, x, y }: LawCase,
	c: Case<LawCase["monoid"] | "concat noncommuting">
) =>
	Effect.sync(() => {
		const { spec, carrier } = specOf(monoid)
		assert.ok(spec.admits(carrier), `${spec.name} admits its carrier`)
		const step = (v: Value) =>
			spec.step === "none" ? ({ kind: "one" } as const) : ({ kind: "value", expr: v } as const)
		const run = (planes: ReadonlyArray<Value>, v: Value) =>
			combine(spec, nonEmpty(planes), step(v), host)
		const identity = Arr.map(spec.identity(carrier), hostOf)
		assert.equal(identity.length, spec.planes.length, "an identity per plane")
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

/** Text, refined by nothing. */
const text: ScalarType = {
	carrier: "text",
	caps: capabilitiesOf("text"),
	contract: undefined,
	text: "wildcard"
}

/** What a monoid's construction gives at a carrier: its identity, or the defect it raises where it has none. */
const identityAt = (
	spec: MonoidSpec,
	carrier: ScalarType
): Option.Option<ReadonlyArray<TypedLiteral>> =>
	Result.match(
		Result.try(() => spec.identity(carrier)),
		{
			onSuccess: (identity): Option.Option<ReadonlyArray<TypedLiteral>> => Option.some(identity),
			onFailure: (thrown) => {
				throwsDefect(() => {
					throw thrown
				}, `${spec.name}'s identity at a carrier it refuses is a defect`)
				return Option.none()
			}
		}
	)

/**
 * Whether a monoid's construction is valid at a carrier, judged by the validators it must pass: its identity is one
 * literal per plane, each a value of the carrier (literalProblem), and the CHECK that proves its combine types over a
 * plane of the carrier (check/fold.ts combineRule).
 */
export const constructs = (spec: MonoidSpec, carrier: ScalarType): boolean =>
	Option.match(identityAt(spec, carrier), {
		onNone: () => false,
		onSome: (identity) =>
			identity.length === spec.planes.length &&
			Arr.every(identity, (literal) => literalProblem(literal, carrier) === undefined) &&
			combineRule(spec, carrier, new AnalyzedPatterns()) === undefined
	})

/** Whether a type is natural, the builtin contract count's plane is: its declared descriptor's own type. */
export const isNatural = (t: ScalarType): boolean =>
	sameScalarType(t, scalarOf(naturalDescriptor.desc, {}))

/**
 * What admits answered of a monoid at a carrier, and sum admitting numeric of no typmod, numeric's, as a field or a
 * contract's base declares it.
 */
export type AdmitsFeature = `${MonoidName} admits` | `${MonoidName} refuses` | "sum admits numeric"

/** Whether a carrier is numeric of no typmod, numeric or a contract over it (ir/scalar.ts numericBoundOf). */
export const isPgNumeric = (t: ScalarType): boolean => numericBoundOf(t) !== undefined

/** A monoid, and a declared type it may admit. */
export type AdmitsCase = readonly [MonoidName, ScalarType]

/** Any monoid at any declared type. */
export const admitsCaseGen: Gen<AdmitsCase> = (source) =>
	[source.draw(element(monoidNames)), source.draw(declaredTypeGen)] as const

/** numeric, bare and as a contract's base: numeric of no typmod at numeric's own limits. */
const pgNumericTypes: Arr.NonEmptyReadonlyArray<ScalarType> = [
	scalarOf({ kind: "pg", type: "numeric" }, {}),
	scalarOf(
		{
			kind: "domain",
			name: "Amount",
			base: { kind: "pg", type: "numeric" },
			predicate: undefined,
			facts: []
		},
		{}
	)
]

/** A monoid over sets at a drawn set type. */
const atSet =
	(name: "or" | "twos"): Gen<AdmitsCase> =>
	(source) =>
		[name, source.draw(setTypeGen)] as const

/** sum at numeric, bare or a contract's base. */
const sumAtPgNumeric: Gen<AdmitsCase> = (source) =>
	["sum", source.draw(element(pgNumericTypes))] as const

/**
 * The cases aimed at the carriers declaredTypeGen draws least often: or and twos at a drawn set type, and sum at
 * numeric, one of nine pg types, about one case in 470 at sum.
 */
export const admitsAims: ReadonlyArray<readonly [AdmitsFeature, Gen<AdmitsCase>]> = [
	["or admits", atSet("or")],
	["twos admits", atSet("twos")],
	["sum admits numeric", sumAtPgNumeric]
]
