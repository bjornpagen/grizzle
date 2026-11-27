/** What the properties of registry.test.ts read: its spaces, models and helpers. */

import type { TextBounds } from "@bjornpagen/grizzle-text/regex/dfa"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	lsw,
	type Stale,
	WILD_KINDS,
	type WildKind,
	wild
} from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { bigint, double, uuid } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { hasProperties } from "#compiler/core/record.ts"
import type { ExprDesc, FieldDesc, LiteralDesc, PgScalarName } from "#compiler/ir/desc.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import {
	baseOf,
	capsOf,
	type Carrier,
	type ExactValueCarrier,
	exactDigitsOf,
	isNumericValue,
	numericBoundOf,
	RegexKey,
	Roster,
	type RosterHandles,
	rosterOf,
	type ScalarType,
	spanOf,
	type TextInfo,
	type TextLanguage,
	textOf
} from "#compiler/ir/scalar.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import {
	bareEnv,
	capabilitiesOf,
	describeField,
	numericValue,
	type ScalarEnv,
	scalarTypeOf
} from "#compiler/scalar/registry.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { closed } from "#compiler/schema/api.ts"
import { declaredDescOf } from "#compiler/schema/field-desc.ts"
import {
	accumulatedField,
	admittedClosedId,
	drawnField,
	placeDescriptor
} from "#compiler/schema/relation.ts"
import { succeeded } from "#test/support/assert.ts"
import { contractDescriptor, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import { scalarOf as registryTypeOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { referencePatterns } from "#test/support/oracle/reference/evaluate.ts"
import type { DescriptorSketch } from "#test/unit/scalar/support.ts"
import { numericText, plantedStringGen } from "#test/unit/values/support.ts"

/** A descriptor's capabilities, as describeField reads them. */
export const caps = (field: unknown) =>
	capsOf(succeeded(describeField(field, SourceLoc("test", []))).scalar)

/** The roster lookup of the closed ids a sketch names: each one's order and handles under its name. */
export const rostersOfSketch = (sketch: DescriptorSketch): ReadonlyMap<string, RosterHandles> => {
	switch (sketch.kind) {
		case "closedId":
			return new Map([[sketch.name, { order: sketch.order, handles: sketch.handles }]])
		case "contract":
			return rostersOfSketch(sketch.base)
		case "span":
			return rostersOfSketch(sketch.endpoint)
		case "spelling":
		case "numeric":
		case "vector":
		case "uuid":
			return new Map()
	}
}

/**
 * The predicate table the checker lowers a contract's predicate to: contractPredicateTable over the base, its fields
 * typed by the registry and its regex membership the reference evaluator's.
 */
export const predicateTable = (
	predicate: ExprDesc,
	base: ScalarType,
	name: string,
	facts: ReadonlyArray<Fact>
) =>
	contractPredicateTable(predicate, base, name, facts, {
		loc: SourceLoc(`contract ${name}`, []),
		fieldType: (desc, location) => scalarTypeOf(desc, bareEnv, location),
		patterns: referencePatterns()
	})

/**
 * The FieldDesc the registry reads `t` from: the derived analysis's inverse (declaredDescOf), but for a contract, which
 * a schema declares by name over its base's FieldDesc (identity ignores the predicate), and a span over such an
 * endpoint.
 */
const fieldDescFor = (t: ScalarType): FieldDesc => {
	if (isNumericValue(t)) {
		return { kind: "pg", type: "numeric" }
	}
	const { contract } = t
	if (contract !== undefined) {
		return {
			kind: "contract",
			name: contract.name,
			base: fieldDescFor(contract.base),
			predicate: undefined,
			facts: contract.facts
		}
	}
	const s = spanOf(t)
	if (s?.endpoint.contract !== undefined) {
		return { kind: "span", endpoint: fieldDescFor(s.endpoint), width: s.width }
	}
	return succeeded(declaredDescOf(t, () => undefined))
}

/**
 * The registry's own build of `t`: the type of the FieldDesc a declaration of it writes (fieldDescFor), or, for a
 * computed numeric, which no declaration states, numericValue's of its bound.
 */
export const registryBuild = (t: ScalarType): ScalarType =>
	isNumericValue(t) ? numericValue(t.bound) : registryTypeOf(fieldDescFor(t), rostersOf(t))

/** The roster an environment holds under the declared name `name`, which the registry types a closedId by. */
const envRoster = (env: ScalarEnv, name: string): Roster =>
	defined(env.roster(parsedName(name)), name)

/** The rosters the registry resolves `t` by: a closed id's, or a variant's tag's and its arms' fields'; none for another. */
const rostersOf = (t: ScalarType): Readonly<Record<string, ReadonlyArray<string>>> => {
	const base = baseOf(t)
	if (base.carrier === "variant") {
		return Arr.reduce(
			Arr.flatMap(base.variant.arms, (arm) => Arr.map(arm.fields, (f) => rostersOf(f.type))),
			{ [base.variant.roster.closed]: base.variant.roster.handles },
			(held: Readonly<Record<string, ReadonlyArray<string>>>, more) => ({ ...held, ...more })
		)
	}
	const roster = rosterOf(t)
	return roster === undefined ? {} : { [roster.closed]: roster.handles }
}

/** A contract's name and the bound its predicate holds its bigint value to. */
export const predicateCaseGen = (source: Source) => ({
	name: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
	bound: source.draw(bigint(-100n, 100n))
})

/**
 * A reading's content is what its Description states under its environment: two readings, under any environments, are
 * canonically equal when their contents are equal, and never when they differ. The draws come from small spaces, so
 * near contents meet: a numeric typmod's scale, a text pattern's proved bounds, a roster's handles, a span's width, a
 * contract's name or base.
 */
export type ContentFeature = "equal contents" | "different contents" | `kind ${FieldDesc["kind"]}`

/** The content situations: equal and different contents, and every kind of Description a reading reads. */
export const contentFeatures: Arr.NonEmptyReadonlyArray<ContentFeature> = [
	"equal contents",
	"different contents",
	"kind pg",
	"kind numeric",
	"kind uuid",
	"kind text",
	"kind closedId",
	"kind bits",
	"kind vector",
	"kind span",
	"kind contract"
]

/** A contract predicate over a bigint VALUE. */
const nonNegative: ExprDesc = defined(
	contractDescriptor("Cents", pgDescriptors.bigint, (v: ScalarTerm) => computeCore.ge(v, 0n))
		.predicate,
	"a contract's predicate"
)

const pgGen = map(
	element(["smallint" as const, "integer" as const, "bigint" as const, "boolean" as const]),
	(type) => ({ kind: "pg", type }) as const
)

const endpointGen = map(
	element(["integer" as const, "bigint" as const]),
	(type) => ({ kind: "pg", type }) as const
)

const readingDescGen: Gen<FieldDesc> = weighted([
	[1, pgGen],
	[
		1,
		(source) => ({
			kind: "numeric" as const,
			precision: source.draw(element([9, 10])),
			scale: source.draw(element([2, 3]))
		})
	],
	[1, constant<FieldDesc>({ kind: "uuid" })],
	[
		1,
		(source) => ({
			kind: "text" as const,
			patterns: source.draw(patternsGen(["^.*$", "^[a-z]*$"])),
			bytes: undefined,
			language: source.draw(languageGen)
		})
	],
	[
		1,
		map(element(["Kind", "Mode"]), (roster): FieldDesc => ({
			kind: "closedId",
			roster,
			only: undefined
		}))
	],
	[1, map(element(["Kind", "Mode"]), (roster): FieldDesc => ({ kind: "bits", roster }))],
	[1, map(element([3, 4]), (dimensions): FieldDesc => ({ kind: "vector", dimensions }))],
	[
		1,
		(source) => ({
			kind: "span" as const,
			endpoint: source.draw(endpointGen),
			width: source.draw(element([undefined, 2n, 3n]))
		})
	],
	[
		1,
		(source) => ({
			kind: "contract" as const,
			name: source.draw(element(["Cents", "Euros"])),
			base: source.draw(endpointGen),
			predicate: undefined,
			facts: []
		})
	],
	[
		1,
		(source) => ({
			kind: "contract" as const,
			name: source.draw(element(["Cents", "Euros"])),
			base: source.draw(constant<FieldDesc>({ kind: "pg", type: "bigint" })),
			predicate: nonNegative,
			facts: []
		})
	]
])

/** Two environments and up to eight readings under them, each Description read under both. */
export const contentCaseGen = (source: Source) =>
	[
		source.draw((source) => [source.draw(readingEnvGen), source.draw(readingEnvGen)] as const),
		source.draw(array(readingDescGen, { min: 1, max: 8 }))
	] as const

/**
 * An environment: a roster of one or two handles under every name; a schema's builds a contract's predicate table, a
 * builder's none. Neither resolves a pattern: a text Description carries its language.
 */
const readingEnvGen: Gen<ScalarEnv> = map(
	(source) => ({
		schema: source.draw(boolean),
		handles: source.draw(element<Arr.NonEmptyReadonlyArray<string>>([["a"], ["a", "b"]]))
	}),
	({ schema, handles }): ScalarEnv => {
		const roster = (name: string) => Roster.of(parsedName(name), "ordered", handles)
		return schema
			? { kind: "schema", roster, contractPredicate: predicateTable }
			: { kind: "builder", roster }
	}
)

/** A text's patterns as a Description may carry them: one or two of `sources`, each under drawn flags. */
const patternsGen =
	(sources: Arr.NonEmptyReadonlyArray<string>): Gen<Patterns> =>
	(source) => {
		const pattern: Gen<PatternSource> = (inner) => ({
			source: inner.draw(element(sources)),
			flags: inner.draw(element(["u" as const, "su" as const]))
		})
		return source.draw(boolean)
			? [source.draw(pattern)]
			: [source.draw(pattern), source.draw(pattern)]
	}

/**
 * A language a text Description may carry: every admitted value, or a refined one by a drawn key, enforced as a
 * regex with drawn bounds or none, or as a finite list of members with their bounds.
 */
const languageGen: Gen<TextLanguage> = weighted<TextLanguage>([
	[1, constant<TextLanguage>({ kind: "every" })],
	[
		1,
		(source) => {
			const key = RegexKey(source.draw(element(["k1", "k2"])))
			const bounds = source.draw(
				element<TextBounds | undefined>([
					undefined,
					{ length: 4, bytes: 8 },
					{ length: 8, bytes: 8 }
				])
			)
			return source.draw(boolean)
				? { kind: "refined", key, check: { kind: "regex", ares: ["^x$"], bounds } }
				: {
						kind: "refined",
						key,
						check: { kind: "finite", members: ["x", "yy"], bounds: { length: 2, bytes: 2 } }
					}
		}
	]
])

/**
 * The text refinement a Description of `patterns` carrying `language` states, written out: the wildcard for every
 * value, else the patterns as declared with the language's key and enforcement.
 */
const carriedText = (patterns: Patterns, language: TextLanguage): TextInfo =>
	language.kind === "every" ? "wildcard" : { patterns, key: language.key, check: language.check }

/** What each pg type is: a plain carrier, or numeric of no typmod at numeric's own limits, PostgreSQL's published ones. */
const pgCarrier = {
	smallint: { kind: "plain", carrier: "int2" },
	integer: { kind: "plain", carrier: "int4" },
	bigint: { kind: "plain", carrier: "int8" },
	numeric: {
		kind: "numericValue",
		bound: { digits: numericMaxIntegerDigits, scale: numericMaxFractionDigits }
	},
	real: { kind: "plain", carrier: "float4" },
	"double precision": { kind: "plain", carrier: "float8" },
	money: { kind: "plain", carrier: "money" },
	boolean: { kind: "plain", carrier: "bool" },
	date: { kind: "plain", carrier: "date" },
	inet: { kind: "plain", carrier: "inet" },
	cidr: { kind: "plain", carrier: "cidr" }
} as const satisfies Readonly<Record<PgScalarName, PlainContent | NumericValueContent>>

/** Asserts that `t` is a plain value type of `carrier`: its capabilities, and no typmod, refinement or contract. */
const plain = (t: ScalarType, carrier: Carrier, at: string): void => {
	assert.equal(t.carrier, carrier, at)
	assert.deepEqual(capsOf(t), capabilitiesOf(carrier), at)
	const fields: Readonly<Record<string, unknown>> = { ...t }
	assert.deepEqual(Arr.sort(Rec.keys(fields), Order.String), ["caps", "carrier", "contract"], at)
	assert.equal(t.contract, undefined, at)
}

/** Asserts that `t` is what `desc` states under `env`, field by field, read through the type's accessors. */
export const describes = (t: ScalarType, desc: FieldDesc, env: ScalarEnv, at: string): void => {
	switch (desc.kind) {
		case "pg": {
			const content = pgCarrier[desc.type]
			if (content.kind === "plain") {
				plain(t, content.carrier, at)
				return
			}
			assert.equal(t.carrier, "numeric", at)
			assert.deepEqual("typmod" in t ? t.typmod : "none", undefined, at)
			assert.deepEqual(numericBoundOf(t), content.bound, at)
			assert.deepEqual(capsOf(t), capabilitiesOf("numeric"), at)
			return
		}
		case "numeric":
			assert.equal(t.carrier, "numeric", at)
			assert.deepEqual(
				"typmod" in t ? t.typmod : "none",
				{ precision: desc.precision, scale: desc.scale },
				at
			)
			assert.deepEqual(numericBoundOf(t), undefined, at)
			return
		case "computedNumeric":
			assert.equal(t.carrier, "numeric", at)
			assert.deepEqual("typmod" in t ? t.typmod : "none", undefined, at)
			assert.deepEqual(numericBoundOf(t), desc.bound, at)
			assert.deepEqual(capsOf(t), capabilitiesOf("numeric"), at)
			return
		case "bytes":
			assert.equal(t.carrier, "bytes", at)
			assert.deepEqual(capsOf(t), capabilitiesOf("bytes"), at)
			return
		case "exact":
			assert.equal(t.carrier, desc.carrier, at)
			assert.equal(exactDigitsOf(t), numericMaxIntegerDigits, at)
			assert.deepEqual(capsOf(t), capabilitiesOf(desc.carrier), at)
			return
		case "sha256":
			assert.equal(t.carrier, "sha256", at)
			assert.deepEqual(capsOf(t), capabilitiesOf("sha256"), at)
			return
		case "uuid":
			plain(t, "uuid", at)
			return
		case "text":
			assert.deepEqual(textOf(t), carriedText(desc.patterns, desc.language), at)
			return
		case "pattern":
			assert.equal(textOf(t), "pattern", at)
			return
		case "closedId":
			assert.equal(t.carrier, "code", at)
			assert.deepEqual(rosterOf(t), envRoster(env, desc.roster), at)
			return
		case "bits":
			assert.equal(t.carrier, "bits", at)
			assert.deepEqual(rosterOf(t), envRoster(env, desc.roster), at)
			return
		case "vector":
			assert.deepEqual("typmod" in t ? t.typmod : "none", { dims: desc.dimensions }, at)
			return
		case "search":
			assert.deepEqual("configuration" in t ? t.configuration : "none", desc.configuration, at)
			return
		case "span": {
			const s = defined(spanOf(t), at)
			assert.equal(s.width, desc.width, at)
			describes(s.endpoint, desc.endpoint, env, `${at} endpoint`)
			return
		}
		case "contract": {
			const c = defined(t.contract, at)
			assert.equal<string>(c.name, desc.name, at)
			assert.equal(
				c.predicate === undefined,
				env.kind === "builder" || desc.predicate === undefined,
				at
			)
			describes(c.base, desc.base, env, `${at} base`)
			return
		}
		case "variant": {
			const base = baseOf(t)
			if (base.carrier !== "variant") {
				return assert.fail(`${at}: a variant`)
			}
			assert.equal<string>(base.variant.name, desc.name, at)
			assert.equal<string>(base.variant.roster.closed, desc.roster, at)
			assert.deepEqual<ReadonlyArray<string>>(
				Arr.map(base.variant.arms, (a) => a.handle),
				Arr.map(desc.arms, (a) => a.handle),
				at
			)
			for (const [i, arm] of desc.arms.entries()) {
				const held = defined(base.variant.arms[i], `${at} arm ${arm.handle}`)
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.map(held.fields, (f) => f.name),
					Arr.map(arm.fields, (f) => f.name),
					`${at} arm ${arm.handle}`
				)
				for (const [j, f] of arm.fields.entries()) {
					const field = defined(held.fields[j], `${at} ${arm.handle}.${f.name}`)
					describes(field.type, f.desc, env, `${at} ${arm.handle}.${f.name}`)
				}
			}
			return
		}
	}
}

/** A plain type's content: its carrier. */
interface PlainContent {
	readonly kind: "plain"
	readonly carrier: Carrier
}

/** numeric of no typmod's content: its bound, numeric's own limits for pg.numeric. */
interface NumericValueContent {
	readonly kind: "numericValue"
	readonly bound: { readonly digits: number; readonly scale: number }
}

/** A reading's content as plain data: exactly what `describes` holds its type to. */
type Content =
	| PlainContent
	| NumericValueContent
	| { readonly kind: "bytes" }
	| {
			readonly kind: "numeric"
			readonly typmod: { readonly precision: number; readonly scale: number }
	  }
	| { readonly kind: "exact"; readonly carrier: ExactValueCarrier; readonly digits: number }
	| { readonly kind: "text"; readonly text: TextInfo }
	| { readonly kind: "closedId"; readonly roster: Roster }
	| { readonly kind: "bits"; readonly roster: Roster }
	| { readonly kind: "vector"; readonly dims: number }
	| { readonly kind: "search"; readonly configuration: string }
	| { readonly kind: "span"; readonly endpoint: Content; readonly width: bigint | undefined }
	| {
			readonly kind: "contract"
			readonly name: string
			readonly base: Content
			readonly predicate: boolean
	  }

/** The content of reading `desc` under `env`. */
export const contentOf = (desc: FieldDesc, env: ScalarEnv): Content => {
	switch (desc.kind) {
		case "pg":
			return pgCarrier[desc.type]
		case "numeric":
			return { kind: "numeric", typmod: { precision: desc.precision, scale: desc.scale } }
		case "exact":
			return { kind: "exact", carrier: desc.carrier, digits: numericMaxIntegerDigits }
		case "computedNumeric":
			return { kind: "numericValue", bound: { digits: desc.bound.digits, scale: desc.bound.scale } }
		case "bytes":
			return { kind: "bytes" }
		case "sha256":
			return { kind: "plain", carrier: "sha256" }
		case "uuid":
			return { kind: "plain", carrier: "uuid" }
		case "text":
			return { kind: "text", text: carriedText(desc.patterns, desc.language) }
		case "pattern":
			return { kind: "text", text: "pattern" }
		case "closedId":
			return { kind: "closedId", roster: envRoster(env, desc.roster) }
		case "bits":
			return { kind: "bits", roster: envRoster(env, desc.roster) }
		case "vector":
			return { kind: "vector", dims: desc.dimensions }
		case "search":
			return { kind: "search", configuration: desc.configuration }
		case "span":
			return { kind: "span", endpoint: contentOf(desc.endpoint, env), width: desc.width }
		case "contract":
			return {
				kind: "contract",
				name: desc.name,
				base: contentOf(desc.base, env),
				predicate: env.kind === "schema" && desc.predicate !== undefined
			}
		case "variant":
			throw new Error("no registry case declares a variant")
	}
}

/**
 * literalDescFor: a literal operand adopts the host type of its term's base. One judge per carrier states what it
 * answers for any value, transcribed from the registry's rule (scalar/registry.ts literalDescFor): the literal it
 * returns, the carrier's fault word for the wrong host kind, or, where neither states a word, only that the value is
 * refused by a fault of the vocabulary. Every carrier is handed its own live values, every other carrier's, and every
 * wild kind; a judge never reads a hostile proxy, whose refusal is a fault of the vocabulary.
 */
type LiteralCarrier =
	| "int2"
	| "int4"
	| "int8"
	| "numeric"
	| "float4"
	| "float8"
	| "money"
	| "bool"
	| "uuid"
	| "text"
	| "closed handle"
	| "span over int4"
	| "span over int8"
	| "vector(2)"
	| "contract Cents"

/** What a literal operand reached: its carrier's literal or refusal, its drawn value, a vector's snapshot and -0. */
export type LiteralFeature =
	| `${LiteralCarrier} ${"literal" | "refused"}`
	| DrawnFeature<never>
	| "vector snapshot at build"
	| "a negative zero"

/** What a carrier's judge answers for a value: the literal, the carrier's fault, or some fault of the vocabulary. */
type Verdict =
	| { readonly kind: "literal"; readonly literal: LiteralDesc }
	| { readonly kind: "fault"; readonly fault: ValueFault }
	| { readonly kind: "a fault of the vocabulary" }

/** A carrier a literal operand is typed by: its type, its own live values, and its judge. */
interface LiteralCase {
	readonly carrier: LiteralCarrier
	readonly type: ScalarType
	readonly live: Gen<unknown>
	readonly judge: (value: unknown) => Verdict
}

const literalOf = (value: LiteralDesc): Verdict => ({ kind: "literal", literal: value })
const faultOf = (fault: ValueFault): Verdict => ({ kind: "fault", fault })

/** The verdict that only states a value is refused by a fault of the vocabulary. */
export const someFault: Verdict = { kind: "a fault of the vocabulary" }

/** A descriptor's ScalarType, as describeField reads it. */
export const scalarOf = (field: unknown): ScalarType =>
	succeeded(describeField(field, SourceLoc("literal carrier", []))).scalar

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value)
const isBigInt = (value: unknown): value is bigint => typeof value === "bigint"

/** smallint and integer: a JavaScript integer, -0 written 0; a fraction or an unsafe integer is the wrong host kind. */
const integerJudge = (value: unknown): Verdict =>
	isSafeInteger(value) ? literalOf(value === 0 ? 0 : value) : faultOf("integerType")

/** bigint and a contract over it: a bigint. */
const bigintJudge = (value: unknown): Verdict =>
	isBigInt(value) ? literalOf(value) : faultOf("integerType")

/**
 * numeric: never a JavaScript number; a Decimal as it is, a bigint as its Decimal, and a string parsed as an exact
 * decimal literal is (values/decimal.ts Decimal.parse).
 */
const numericJudge = (value: unknown): Verdict => {
	if (typeof value === "number") {
		return faultOf("decimalNumber")
	}
	if (value instanceof Decimal) {
		return literalOf(value)
	}
	if (isBigInt(value)) {
		return literalOf(Decimal.of(value))
	}
	if (typeof value !== "string") {
		return someFault
	}
	const parsed = Decimal.parse(value)
	return parsed.ok ? literalOf(parsed.value) : faultOf(parsed.error)
}

/** real and double precision: a JavaScript number, the specials, -0 among them, by their words. */
const floatJudge = (value: unknown): Verdict => {
	if (typeof value !== "number") {
		return faultOf("floatType")
	}
	if (Number.isNaN(value)) {
		return literalOf({ float: "NaN" })
	}
	if (value === Number.POSITIVE_INFINITY) {
		return literalOf({ float: "Infinity" })
	}
	if (value === Number.NEGATIVE_INFINITY) {
		return literalOf({ float: "-Infinity" })
	}
	if (Object.is(value, -0)) {
		return literalOf({ float: "-0" })
	}
	return literalOf(value)
}

const hyphenated = regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")

/** A span: exactly `start` and `end`, each of the endpoint's host kind; the order is the checker's. */
const spanJudge =
	(endpoint: (x: unknown) => x is number | bigint) =>
	(value: unknown): Verdict => {
		if (!hasProperties(value) || Arr.isArray(value)) {
			return faultOf("spanType")
		}
		if (Rec.keys(value).length !== 2 || !Rec.has(value, "start") || !Rec.has(value, "end")) {
			return faultOf("spanType")
		}
		if (!("start" in value) || !("end" in value)) {
			return faultOf("spanType")
		}
		const { start, end } = value
		return endpoint(start) && endpoint(end)
			? literalOf({ span: { start, end } })
			: faultOf("spanEndpoint")
	}

/** The closed relation the closed handle carrier and the closedId boundary read. */
export const Kind = closed.ordered("Kind", ["Manual", "Automatic"])
const handles: ReadonlyArray<string> = Kind.handles
const int8Values = bigint(-(2n ** 63n), 2n ** 63n - 1n)

const vectorCase: LiteralCase = {
	carrier: "vector(2)",
	type: scalarOf(pgDescriptors.vector(2)),
	live: weighted<unknown>([
		[
			1,
			map(array(element([1, 2, 0, -3, 0.5, Number.NaN]), { min: 1, max: 3 }), (xs) =>
				Float32Array.from(xs)
			)
		],
		[1, constant([1])]
	]),
	/** A Float32Array of the type's dimensions, the literal its finite components' canonical payload. */
	judge: (value) => {
		if (!(value instanceof Float32Array)) {
			return faultOf("vectorType")
		}
		if (value.length !== 2) {
			return faultOf("vectorDimensions")
		}
		if (!value.every((x) => Number.isFinite(x))) {
			return someFault
		}
		return literalOf(succeeded(Vector.canonical(Vector.make(Float32Array.from(value), 2))))
	}
}

/** Every carrier a literal operand may be typed by, with its own live values and its judge. */
export const literalCases: Arr.NonEmptyReadonlyArray<LiteralCase> = [
	{
		carrier: "int2",
		type: scalarOf(pgDescriptors.smallint),
		live: weighted<unknown>([
			[1, int(-32768, 32767)],
			[1, element<unknown>([-0, 0.5, 1e300, 1n])]
		]),
		judge: integerJudge
	},
	{
		carrier: "int4",
		type: scalarOf(pgDescriptors.integer),
		live: weighted<unknown>([
			[1, int(-(2 ** 31), 2 ** 31 - 1)],
			[1, element<unknown>([-0, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, 1n])]
		]),
		judge: integerJudge
	},
	{
		carrier: "int8",
		type: scalarOf(pgDescriptors.bigint),
		live: weighted<unknown>([
			[1, int8Values],
			[1, constant(1)]
		]),
		judge: bigintJudge
	},
	{
		carrier: "numeric",
		type: scalarOf(pgDescriptors.numeric(9, 2)),
		live: weighted<unknown>([
			[1, numericText],
			[1, element<unknown>(["1.50", "1e", "0x10", " 1", "NaN", Decimal.of("0.062"), 2n, 1])]
		]),
		judge: numericJudge
	},
	{
		carrier: "float4",
		type: scalarOf(pgDescriptors.real),
		live: weighted<unknown>([
			[1, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
			[
				1,
				element<unknown>([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0, "1"])
			]
		]),
		judge: floatJudge
	},
	{
		carrier: "float8",
		type: scalarOf(pgDescriptors["double precision"]),
		live: weighted<unknown>([
			[1, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
			[
				1,
				element<unknown>([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0, "1"])
			]
		]),
		judge: floatJudge
	},
	{
		carrier: "money",
		type: scalarOf(pgDescriptors.money),
		live: weighted<unknown>([
			[1, map(int8Values, (n) => Money.of(n))],
			[1, constant(5n)]
		]),
		judge: (value) => (value instanceof Money ? literalOf(value) : faultOf("moneyType"))
	},
	{
		carrier: "bool",
		type: scalarOf(pgDescriptors.boolean),
		live: weighted<unknown>([
			[1, boolean],
			[1, constant(0)]
		]),
		judge: (value) => (typeof value === "boolean" ? literalOf(value) : faultOf("boolType"))
	},
	{
		carrier: "uuid",
		type: scalarOf(uuidDescriptor),
		live: weighted<unknown>([
			[1, uuid(4)],
			[1, map(uuid(4), (u) => Str.toUpperCase(u))],
			[
				1,
				element([
					"not-a-uuid",
					"a0eebc999c0b4ef8bb6d6bb9bd380a11",
					"{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}"
				])
			]
		]),
		/** The canonical lowercase spelling of the hyphenated form. */
		judge: (value) =>
			typeof value === "string" && hyphenated.test(value)
				? literalOf(Str.toLowerCase(value))
				: faultOf("uuidSyntax")
	},
	{
		carrier: "text",
		type: scalarOf(str.regex("^.*$", "su")),
		live: map(plantedStringGen, (t) => t.value),
		/** Storable text: no NUL, no lone surrogate. */
		judge: (value) =>
			typeof value === "string" && !Str.includes("\u0000")(value) && value.isWellFormed()
				? literalOf(value)
				: someFault
	},
	{
		carrier: "closed handle",
		type: scalarOf(admittedClosedId(Kind)),
		live: element(["Manual", "Automatic", "manual", "", "Other"]),
		/** A handle of the roster. */
		judge: (value) =>
			typeof value === "string" && handles.includes(value) ? literalOf(value) : someFault
	},
	{
		carrier: "span over int4",
		type: scalarOf(spanDescriptor(pgDescriptors.integer)),
		live: weighted<unknown>([
			[
				1,
				(source) => ({
					start: source.draw(int(-(2 ** 31), 2 ** 31 - 1)),
					end: source.draw(int(-(2 ** 31), 2 ** 31 - 1))
				})
			],
			[
				1,
				element<unknown>([
					{ start: 1.5, end: 3 },
					{ start: 1, end: 2 ** 53 },
					{ start: 1n, end: 2n },
					{ start: 1, end: 2, x: 3 }
				])
			]
		]),
		judge: spanJudge(isSafeInteger)
	},
	{
		carrier: "span over int8",
		type: scalarOf(spanDescriptor(pgDescriptors.bigint)),
		live: weighted<unknown>([
			[1, (source) => ({ start: source.draw(int8Values), end: source.draw(int8Values) })],
			[
				1,
				element<unknown>([
					{ start: 1, end: 2 },
					{ start: 1n, end: 2n, x: 3n }
				])
			]
		]),
		judge: spanJudge(isBigInt)
	},
	vectorCase,
	{
		carrier: "contract Cents",
		type: scalarOf(contractDescriptor("Cents", pgDescriptors.bigint)),
		live: weighted<unknown>([
			[1, int8Values],
			[1, constant(1)]
		]),
		judge: bigintJudge
	}
]

/** A literal operand's case: the carrier it is typed by, and the value it is handed. */
type LiteralOperand = readonly [LiteralCase, Drawn<unknown, never>]

/** The other carriers than `carrier`, whose live values `carrier` is handed too. */
const othersOf = (carrier: LiteralCase): Arr.NonEmptyReadonlyArray<LiteralCase> =>
	nonEmpty(
		Arr.filter(literalCases, (o) => o !== carrier),
		"the other carriers"
	)

/** A carrier's case: its own live value or another carrier's, equally often, or a wild value of every kind. */
const operandOf =
	(carrier: LiteralCase): Gen<LiteralOperand> =>
	(source) => {
		const others = othersOf(carrier)
		return [
			carrier,
			source.draw(
				lsw<unknown>({
					live: weighted<unknown>([
						[1, carrier.live],
						[1, (again) => again.draw(again.draw(element(others)).live)]
					]),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			)
		] as const
	}

/** A carrier's case of its own live values, which its literal is drawn among. */
const ownLiveOf =
	(carrier: LiteralCase): Gen<LiteralOperand> =>
	(source) =>
		[carrier, { kind: "live", value: source.draw(carrier.live) }] as const

/** A carrier's case of another carrier's live value, or a wild value: what it refuses most often. */
const foreignOf =
	(carrier: LiteralCase): Gen<LiteralOperand> =>
	(source) => {
		const others = othersOf(carrier)
		return [
			carrier,
			source.draw(
				lsw<unknown>({
					live: (again) => again.draw(again.draw(element(others)).live),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			)
		] as const
	}

/** A wild value of `kind` alone, as a drawn value. */
const wildOnly = <T, From extends string>(kind: WildKind): Gen<Drawn<T, From>> =>
	map(wild([kind]), (drawn): Drawn<T, From> => ({ kind: "wild", wild: drawn }))

/** The carriers a live -0 is a literal of: an integer's, which reads it as 0, and a float's, which keeps its sign. */
const zeroCarriers = nonEmpty(
	Arr.filter(literalCases, (c) => c.judge(-0).kind === "literal"),
	"the carriers of a -0 literal"
)

/**
 * A carrier and a value drawn among its own live values, every other carrier's and every wild kind, aimed at each
 * situation still pending: a carrier's literal at its own live values, its refusal at another's or a wild one, a live
 * vector of two finite components at vector(2) for its literal and its snapshot, a live -0 at a carrier it is a
 * literal of, and a wild value of each kind at any carrier.
 */
export const literalOperandSpace = aimed<LiteralOperand, LiteralFeature>(
	(source) => source.draw(operandOf(source.draw(element(literalCases)))),
	[
		...Arr.flatMap(
			literalCases,
			(c): ReadonlyArray<readonly [LiteralFeature, Gen<LiteralOperand>]> => [
				[`${c.carrier} literal`, ownLiveOf(c)],
				[`${c.carrier} refused`, foreignOf(c)]
			]
		),
		[
			"vector snapshot at build",
			(source) =>
				[
					vectorCase,
					{
						kind: "live",
						value: Float32Array.from(
							source.draw(array(element([1, 2, 0, -3, 0.5]), { min: 2, max: 2 }))
						)
					}
				] as const
		],
		[
			"a negative zero",
			(source) => [source.draw(element(zeroCarriers)), { kind: "live", value: -0 }] as const
		],
		...Arr.map(WILD_KINDS, (kind): readonly [LiteralFeature, Gen<LiteralOperand>] => [
			`wild ${kind}`,
			(source) => [source.draw(element(literalCases)), source.draw(wildOnly(kind))] as const
		])
	]
)

/**
 * The descriptor boundary: describeField reads a descriptor a builder made, pg.numeric itself among them (numeric of no
 * typmod, which is also numeric(p, s)'s constructor), and a field of a writing of its own (drawn, accumulated,
 * or a place) as the descriptor its values are of, a place as natural, one rule for every field, so a
 * parameter typed by one is typed by its value type; span takes one as its endpoint, and closedId takes a closed
 * relation. A copy of a descriptor's members (a look-alike) and any wild value are no descriptor: MalformedDescription
 * at describeField and span; any wild value is no closed relation: MalformedDescription at closedId. A live descriptor
 * is read; span builds over integer, bigint and contracts over them, natural among them, and refuses any other
 * endpoint by its capability; closedId builds the closed relation's handle descriptor.
 */
type Boundary = "describeField" | "span" | "closedId"

/** What a boundary was handed and which boundary it was, and whether a live descriptor was a written field. */
export type DescribeFeature =
	| DrawnFeature<"look-alike">
	| `boundary ${Boundary}`
	| "a written field, read as its value type"

const Cents = contractDescriptor("Cents", pgDescriptors.bigint)
const Day = contractDescriptor("Day", pgDescriptors.integer)

/** The descriptors a span takes as its endpoint. */
export const endpoints: Arr.NonEmptyReadonlyArray<object> = [
	pgDescriptors.integer,
	pgDescriptors.bigint,
	Cents,
	Day,
	naturalDescriptor
]
const descriptors: Arr.NonEmptyReadonlyArray<object> = [
	...endpoints,
	pgDescriptors.smallint,
	pgDescriptors.numeric,
	pgDescriptors.numeric(9, 2),
	pgDescriptors.numeric(1000, -1000),
	pgDescriptors.real,
	pgDescriptors["double precision"],
	pgDescriptors.money,
	pgDescriptors.boolean,
	uuidDescriptor,
	pgDescriptors.vector(3),
	spanDescriptor(pgDescriptors.bigint),
	spanDescriptor(pgDescriptors.integer, 7),
	admittedClosedId(Kind),
	str.regex("^a$")
]

/**
 * A field of each writing of its own a caller may pass where a descriptor is asked, with the descriptor its values are
 * of, which describeField reads it as.
 */
const writtenFields: Arr.NonEmptyReadonlyArray<readonly [object, object]> = [
	[drawnField(naturalDescriptor, []), naturalDescriptor],
	[placeDescriptor, naturalDescriptor],
	[placeDescriptor.by("stage"), naturalDescriptor],
	[accumulatedField(pgDescriptors.integer, 0, []), pgDescriptors.integer]
]

/** The descriptor a live value's values are of: a written field's (writtenFields), or the descriptor itself. */
export const valueDescriptor = (value: object): object =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(writtenFields, ([field]) => field === value),
			([, type]) => type
		),
		() => value
	)

/** Whether a live value is a field of a writing of its own (writtenFields). */
export const isWrittenField = (value: object): boolean =>
	Arr.some(writtenFields, ([field]) => field === value)

/**
 * A descriptor (live, a look-alike or wild) for describeField and span, or a closed relation (live Kind, or wild) for
 * closedId.
 */
const boundaryCaseGen: Gen<readonly [Drawn<object, "look-alike">, Boundary]> = weighted([
	[
		1,
		(source) =>
			[
				source.draw(
					lsw<object, "look-alike">({
						live: weighted([
							[1, element(descriptors)],
							[1, map(element(writtenFields), ([field]) => field)]
						]),
						stale: Option.some(
							map(element(descriptors), (field): Stale<object, "look-alike"> => ({
								value: { ...field },
								from: "look-alike"
							}))
						),
						wild: WILD_KINDS
					})
				),
				source.draw(element<Boundary>(["describeField", "span"]))
			] as const
	],
	[
		1,
		(source) =>
			[
				source.draw(
					lsw<object, "look-alike">({
						live: constant(Kind),
						stale: Option.none(),
						wild: WILD_KINDS
					})
				),
				source.draw(constant<Boundary>("closedId"))
			] as const
	]
])

/**
 * A boundary's case, aimed at each wild kind still pending: a wild value of that kind at any of the three boundaries.
 */
export const boundarySpace = aimed<
	readonly [Drawn<object, "look-alike">, Boundary],
	DescribeFeature
>(
	boundaryCaseGen,
	Arr.map(
		WILD_KINDS,
		(kind): readonly [DescribeFeature, Gen<readonly [Drawn<object, "look-alike">, Boundary]>] => [
			`wild ${kind}`,
			(source) =>
				[
					source.draw(wildOnly(kind)),
					source.draw(element<Boundary>(["describeField", "span", "closedId"]))
				] as const
		]
	)
)
