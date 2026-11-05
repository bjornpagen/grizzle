import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, sketched } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	uniqueArray
} from "@grizzle/testing/gen"
import {
	type Drawn,
	drawnFeature,
	type DrawnFeature,
	lsw,
	passed,
	type Stale,
	WILD_KINDS
} from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { declaredDescOf } from "#compiler/analysis/derived/fields.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { hasProperties } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc, LiteralDesc, PgScalarName } from "#compiler/ir/desc.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import {
	type Carrier,
	carriers,
	contractOf,
	isNumericValue,
	numericBoundOf,
	type NumericValueType,
	RegexKey,
	type Roster,
	rosterOf,
	type ScalarType,
	sameScalarType,
	spanOf,
	type TextInfo,
	textOf
} from "#compiler/ir/scalar.ts"
import { str } from "#compiler/public/text.ts"
import { admittedClosedId } from "#compiler/scalar/closed-id.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import {
	bareEnv,
	capabilitiesOf,
	describeField,
	literalDescFor,
	noRosters,
	noText,
	numericValue,
	type ScalarEnv,
	scalarTypeOf,
	type TextLookup
} from "#compiler/scalar/registry.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { closed } from "#compiler/schema/api.ts"
import {
	assert,
	contains,
	defined,
	faulted,
	nonEmpty,
	refused,
	succeeded,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import { contractDescriptor, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import {
	isPlainCarrier,
	plainType,
	scalarOf as registryTypeOf,
	wildcardText
} from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { types as codecTypes } from "#test/unit/codec/support.ts"
import { cursorCodecTypes as cursorTypes } from "#test/unit/cursor/support.ts"
import { scalarTypes as irFixtureTypes } from "#test/unit/ir/fixture.ts"
import {
	E as conservativeEndpoints,
	T as conservativeTypes
} from "#test/unit/lower/conservative/fixtures.ts"
import { decimalText, plantedStringGen } from "#test/unit/values/support.ts"

import { regex } from "arkregex"
const caps = (field: unknown) => succeeded(describeField(field, SourceLoc("test", []))).scalar.caps

describe("the capability registry", () => {
	it.effect("gives a serial and a contract their base's, and every vector its distance", (ctx) =>
		Effect.gen(function* () {
			type CapsCase =
				| { readonly kind: "serial"; readonly field: unknown; readonly base: unknown }
				| { readonly kind: "contract"; readonly field: unknown; readonly base: unknown }
				| { readonly kind: "vector"; readonly field: unknown }
			/** A serial field's type is its integer's: how a field is written changes none of what its type can do. */
			const cases: Arr.NonEmptyReadonlyArray<CapsCase> = [
				{ kind: "serial", field: pgDescriptors.smallserial, base: pgDescriptors.smallint },
				{ kind: "serial", field: pgDescriptors.serial, base: pgDescriptors.integer },
				{ kind: "serial", field: pgDescriptors.bigserial, base: pgDescriptors.bigint },
				...Arr.map(
					[
						pgDescriptors.smallint,
						pgDescriptors.integer,
						pgDescriptors.bigint,
						pgDescriptors.numeric(9, 2),
						pgDescriptors.money,
						pgDescriptors.boolean,
						uuidDescriptor,
						str.regex("^a$", "u")
					],
					(base): CapsCase => ({
						kind: "contract",
						field: contractDescriptor("Branded", base),
						base
					})
				),
				...Arr.map([1, 3, 16000], (d): CapsCase => ({
					kind: "vector",
					field: pgDescriptors.vector(d)
				})),
				{ kind: "vector", field: contractDescriptor("Unit", pgDescriptors.vector(3)) }
			]
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/capabilities",
						generator: element(cases),
						literal: Formatter.format,
						limit: cases.length,
						coverage: requiredInSpace<CapsCase["kind"]>(["serial", "contract", "vector"]),
						caseHang
					},
					(cs, c) =>
						Effect.sync(() => {
							c.note(cs.kind)
							switch (cs.kind) {
								case "serial":
								case "contract":
									unorderedEqual(caps(cs.field), caps(cs.base))
									return
								case "vector":
									contains(caps(cs.field), "vectorDistance")
									assert.deepEqual(
										Arr.intersection(caps(cs.field), [
											"sum",
											"avg",
											"hashing",
											"gist",
											"expressionIndex"
										]),
										[],
										"a vector sums, averages, hashes, indexes by GiST and by expression nowhere"
									)
									return
							}
						})
				)
			)
		})
	)
})

/**
 * The predicate table the checker lowers a contract's predicate to: contractPredicateTable over the base, its fields
 * typed by the registry and its regex membership the reference evaluator's.
 */
const predicateTable = (
	predicate: ExprDesc,
	base: ScalarType,
	name: string,
	facts: ReadonlyArray<Fact>
) =>
	contractPredicateTable(predicate, base, name, facts, {
		loc: SourceLoc(`contract ${name}`, []),
		fieldType: (desc, location) => scalarTypeOf(desc, bareEnv, location),
		regexMember: patternMember
	})

/**
 * The ScalarTypes the test fixture modules export (the IR fixture's, the conservative lowering's, the codec's and the
 * cursor's), every plain type and the canonical wildcard text, each beside where it comes from.
 */
const fixtureTypes = nonEmpty<readonly [string, ScalarType]>(
	[
		...Arr.map(
			Rec.toEntries(irFixtureTypes),
			([name, t]) => [`ir/fixture.ts T.${name}`, t] as const
		),
		...Arr.map(
			Rec.toEntries(conservativeEndpoints),
			([name, t]) => [`lower/conservative/fixtures.ts E.${name}`, t] as const
		),
		...Arr.map(
			Rec.toEntries(conservativeTypes),
			([name, t]) => [`lower/conservative/fixtures.ts T.${name}`, t] as const
		),
		...Arr.map(
			Rec.toEntries(codecTypes),
			([name, t]) => [`codec/support.ts types.${name}`, t] as const
		),
		...Arr.map(
			Rec.toEntries(cursorTypes),
			([name, t]) => [`cursor/support.ts types.${name}`, t] as const
		),
		...Arr.map(
			Arr.filter(carriers, isPlainCarrier),
			(c) => [`plainType(${c})`, plainType(c)] as const
		),
		["wildcardText", wildcardText]
	],
	"the fixture types"
)

/**
 * The FieldDesc the registry reads `t` from: the derived analysis's inverse (declaredDescOf), but for a contract, which
 * a schema declares by name over its base's FieldDesc (identity ignores the predicate), and a span over such an
 * endpoint.
 */
const fieldDescFor = (t: Exclude<ScalarType, NumericValueType>): FieldDesc => {
	const contract = contractOf(t)
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
	if (s !== undefined && contractOf(s.endpoint) !== undefined) {
		return { kind: "span", endpoint: fieldDescFor(s.endpoint), width: s.width }
	}
	return succeeded(declaredDescOf(t, {}))
}

/**
 * The registry's own build of `t`: the type of the FieldDesc a declaration of it writes (fieldDescFor), or, for a
 * computed numeric, which no declaration states, numericValue's of its bound.
 */
const registryBuild = (t: ScalarType): ScalarType =>
	isNumericValue(t) ? numericValue(t.bound) : registryTypeOf(fieldDescFor(t), rostersOf(t))

/** The roster an environment holds under the declared name `name`, as the registry builds a closedId's. */
const envRoster = (env: ScalarEnv, name: string): Roster => {
	const closed = parsedName(name)
	return { closed, handles: defined(env.roster(closed), name) }
}

/** The roster the registry resolves `t`'s closedId by: its own, or none. */
const rostersOf = (t: ScalarType): Readonly<Record<string, Arr.NonEmptyReadonlyArray<string>>> => {
	const roster = rosterOf(t)
	return roster === undefined ? {} : { [roster.closed]: roster.handles }
}

describe("scalarTypeOf: a FieldDesc to its ScalarType", () => {
	it.effect(
		"built every type a test fixture exports: each is the registry's type of its FieldDesc, or its computed numeric",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/fixtures-are-registry",
						generator: element(fixtureTypes),
						literal: Formatter.format,
						/**
						 * The space is the fixtures' types, listed above: every one of them, once, of every carrier a field can
						 * have, which the exact arithmetic carriers never are.
						 */
						limit: fixtureTypes.length,
						coverage: requiredInSpace<`carrier ${Carrier}`>(
							nonEmpty(
								Arr.map(
									Arr.filter(carriers, (c) => c !== "exactInteger" && c !== "exactMoney"),
									(c): `carrier ${Carrier}` => `carrier ${c}`
								),
								"a field's carriers"
							)
						),
						caseHang
					},
					([where, t], c) =>
						Effect.sync(() => {
							c.note(`carrier ${t.carrier}`)
							assert.equal(sameScalarType(t, registryBuild(t)), true, where)
						})
				)
			)
	)

	it.effect("reads every descriptor kind, and agrees with the descriptor's own ScalarType", (ctx) =>
		Effect.gen(function* () {
			const fields: Arr.NonEmptyReadonlyArray<unknown> = [
				pgDescriptors.smallint,
				pgDescriptors.numeric(9, 2),
				pgDescriptors.serial,
				uuidDescriptor,
				pgDescriptors.vector(5),
				spanDescriptor(pgDescriptors.bigint, 3n),
				contractDescriptor("Cents", pgDescriptors.bigint, (v: ScalarTerm) => v.ge(0n))
			]
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/registry-kinds",
						generator: element(fields),
						literal: Formatter.format,
						limit: fields.length,
						coverage: requiredInSpace<"a descriptor">(["a descriptor"]),
						caseHang
					},
					(field, c) =>
						Effect.sync(() => {
							c.note("a descriptor")
							const { desc, scalar } = succeeded(describeField(field, SourceLoc("f", [])))
							assert.deepEqual(
								succeeded(scalarTypeOf(desc, bareEnv, SourceLoc("field", []))),
								scalar
							)
						})
				)
			)
		})
	)

	it.effect(
		"resolves a closedId roster through the environment, and refuses an unknown one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/roster-env",
						draw: drawn((source) => ({
							name: source.draw(matching(regex("^[A-Z][a-z]{1,6}$"))),
							other: source.draw(matching(regex("^[A-Z][a-z]{1,6}$"))),
							handles: source.draw(
								uniqueArray(
									matching(regex("^[A-Za-z]{1,5}$")),
									(item) => item,
									{ min: 1, max: 4 },
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
							const listed = nonEmpty(handles, "a drawn roster of at least one handle")
							const held = { closed: parsedName(name), handles: listed }
							const env = {
								kind: "builder",
								roster: (n: string) => (n === name ? listed : undefined),
								text: noText
							} as const
							assert.deepEqual(
								rosterOf(
									succeeded(
										scalarTypeOf({ kind: "closedId", roster: name }, env, SourceLoc("field", []))
									)
								),
								held
							)
							if (other !== name) {
								refused(
									scalarTypeOf({ kind: "closedId", roster: other }, env, SourceLoc("field", [])),
									"MalformedDescription"
								)
							}
						})
				)
			)
	)

	it.effect(
		"takes a pattern's metadata from the environment's text analysis, and refuses one outside any",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/text-env",
						draw: drawn((source) => ({
							source: source.draw(element(["^.*$", "^[a-z]*$", "^.+$", ""])),
							flags: source.draw(element(["u" as const, "su" as const])),
							lengthBound: source.draw(int(1, 1000))
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
					({ source, flags, lengthBound }) =>
						Effect.sync(() => {
							refused(
								scalarTypeOf({ kind: "text", source, flags }, bareEnv, SourceLoc("field", [])),
								"MalformedDescription"
							)
							const info = {
								regex: { source, flags, key: RegexKey(`${flags} ${source}`) },
								lengthBound,
								byteBound: 4 * lengthBound
							}
							const canonical = succeeded(
								scalarTypeOf(
									{ kind: "text", source, flags },
									{ kind: "builder", roster: noRosters, text: () => Result.ok(info) },
									SourceLoc("field", [])
								)
							)
							assert.deepEqual(textOf(canonical), info)
						})
				)
			)
	)

	it.effect("takes the checker's predicate table from the environment", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/scalar/predicate-env",
					draw: drawn((source) => ({
						name: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
						bound: source.draw(bigint(-100n, 100n))
					})),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 50,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ name, bound }) =>
					Effect.sync(() => {
						const Branded = contractDescriptor(name, pgDescriptors.bigint, (v: ScalarTerm) =>
							v.ge(bound)
						)
						const { desc } = succeeded(describeField(Branded, SourceLoc(name, [])))
						const base = succeeded(
							describeField(pgDescriptors.bigint, SourceLoc("bigint", []))
						).scalar
						const identity = defined(
							contractOf(succeeded(scalarTypeOf(desc, bareEnv, SourceLoc("field", []))))
						)
						assert.equal<string>(identity.name, name)
						assert.equal(sameScalarType(identity.base, base), true)
						assert.equal(identity.predicate, undefined)
						const table = succeeded(predicateTable(defined(Branded.predicate), base, name, []))
						const typed = succeeded(
							scalarTypeOf(
								desc,
								{
									kind: "schema",
									roster: noRosters,
									text: noText,
									contractPredicate: predicateTable
								},
								SourceLoc("field", [])
							)
						)
						assert.deepEqual(contractOf(typed)?.predicate, table)
						assert.deepEqual(succeeded(decodeScalarType(structuredClone(typed))), typed)
					})
			)
		)
	)
})

/**
 * A reading's content is what its Description states under its environment: two readings, under any environments, are
 * canonically equal when their contents are equal, and never when they differ. The draws come from small spaces, so
 * near contents meet: a numeric typmod's scale, a text pattern's proved bounds, a roster's handles, a span's width, a
 * contract's name or base.
 */
type ContentFeature = "equal contents" | "different contents" | `kind ${FieldDesc["kind"]}`

/** A contract predicate over a bigint VALUE. */
const nonNegative: ExprDesc = defined(
	contractDescriptor("Cents", pgDescriptors.bigint, (v: ScalarTerm) => v.ge(0n)).predicate,
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

const readingDescGen: Gen<FieldDesc> = oneOf([
	pgGen,
	(source) => ({
		kind: "numeric" as const,
		precision: source.draw(element([9, 10])),
		scale: source.draw(element([2, 3]))
	}),
	constant<FieldDesc>({ kind: "uuid" }),
	(source) => ({
		kind: "text" as const,
		source: source.draw(element(["^.*$", "^[a-z]*$"])),
		flags: source.draw(element(["u" as const, "su" as const]))
	}),
	map(element(["Kind", "Mode"]), (roster): FieldDesc => ({ kind: "closedId", roster })),
	map(element(["Kind", "Mode"]), (roster): FieldDesc => ({ kind: "bits", roster })),
	map(element([3, 4]), (dimensions): FieldDesc => ({ kind: "vector", dimensions })),
	(source) => ({
		kind: "span" as const,
		endpoint: source.draw(endpointGen),
		width: source.draw(element([undefined, 2n, 3n]))
	}),
	(source) => ({
		kind: "contract" as const,
		name: source.draw(element(["Cents", "Euros"])),
		base: source.draw(endpointGen),
		predicate: undefined,
		facts: []
	}),
	(source) => ({
		kind: "contract" as const,
		name: source.draw(element(["Cents", "Euros"])),
		base: source.draw(constant<FieldDesc>({ kind: "pg", type: "bigint" })),
		predicate: nonNegative,
		facts: []
	})
])

/**
 * An environment: a roster of one or two handles under every name, and every pattern but the explicit wildcard with
 * drawn proved bounds; a schema's builds a contract's predicate table, a builder's none.
 */
const readingEnvGen: Gen<ScalarEnv> = map(
	(source) => ({
		schema: source.draw(boolean),
		handles: source.draw(element<Arr.NonEmptyReadonlyArray<string>>([["a"], ["a", "b"]])),
		bounds: source.draw(
			element<
				| { readonly lengthBound: undefined; readonly byteBound: undefined }
				| { readonly lengthBound: number; readonly byteBound: number }
			>([
				{ lengthBound: undefined, byteBound: undefined },
				{ lengthBound: 4, byteBound: 8 },
				{ lengthBound: 8, byteBound: 8 }
			])
		)
	}),
	({ schema, handles, bounds }): ScalarEnv => {
		const roster = () => handles
		const text: TextLookup = (source, flags) =>
			Result.ok(
				source === "^.*$" && flags === "su"
					? { regex: "wildcard", lengthBound: undefined, byteBound: undefined }
					: { regex: { source, flags, key: RegexKey(`${flags} ${source}`) }, ...bounds }
			)
		return schema
			? { kind: "schema", roster, text, contractPredicate: predicateTable }
			: { kind: "builder", roster, text }
	}
)

/** The carrier of each pg type. */
const pgCarrier = {
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	real: "float4",
	"double precision": "float8",
	money: "money",
	boolean: "bool"
} as const satisfies Readonly<Record<PgScalarName, Carrier>>

/** Asserts that `t` is a plain value type of `carrier`: its capabilities, and no typmod, refinement or contract. */
const plain = (t: ScalarType, carrier: Carrier, at: string): void => {
	assert.equal(t.carrier, carrier, at)
	assert.deepEqual(t.caps, capabilitiesOf(carrier), at)
	const fields: Readonly<Record<string, unknown>> = { ...t }
	assert.deepEqual(Arr.sort(Rec.keys(fields), Order.String), ["caps", "carrier", "contract"], at)
	assert.equal(contractOf(t), undefined, at)
}

/** Asserts that `t` is what `desc` states under `env`, field by field, read through the type's accessors. */
const describes = (t: ScalarType, desc: FieldDesc, env: ScalarEnv, at: string): void => {
	switch (desc.kind) {
		case "pg":
			plain(t, pgCarrier[desc.type], at)
			return
		case "numeric":
			assert.equal(t.carrier, "numeric", at)
			assert.deepEqual(
				"typmod" in t ? t.typmod : "none",
				{ precision: desc.precision, scale: desc.scale },
				at
			)
			assert.deepEqual(numericBoundOf(t), undefined, at)
			return
		case "uuid":
			plain(t, "uuid", at)
			return
		case "text":
			assert.deepEqual(textOf(t), succeeded(env.text(desc.source, desc.flags)), at)
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
		case "span": {
			const s = defined(spanOf(t), at)
			assert.equal(s.width, desc.width, at)
			describes(s.endpoint, desc.endpoint, env, `${at} endpoint`)
			return
		}
		case "contract": {
			const c = defined(contractOf(t), at)
			assert.equal<string>(c.name, desc.name, at)
			assert.equal(
				c.predicate === undefined,
				env.kind === "builder" || desc.predicate === undefined,
				at
			)
			describes(c.base, desc.base, env, `${at} base`)
			return
		}
	}
}

/** A reading's content as plain data: exactly what `describes` holds its type to. */
type Content =
	| { readonly kind: "plain"; readonly carrier: Carrier }
	| {
			readonly kind: "numeric"
			readonly typmod: { readonly precision: number; readonly scale: number }
	  }
	| { readonly kind: "text"; readonly text: TextInfo }
	| { readonly kind: "closedId"; readonly roster: Roster }
	| { readonly kind: "bits"; readonly roster: Roster }
	| { readonly kind: "vector"; readonly dims: number }
	| { readonly kind: "span"; readonly endpoint: Content; readonly width: bigint | undefined }
	| {
			readonly kind: "contract"
			readonly name: string
			readonly base: Content
			readonly predicate: boolean
	  }

/** The content of reading `desc` under `env`. */
const contentOf = (desc: FieldDesc, env: ScalarEnv): Content => {
	switch (desc.kind) {
		case "pg":
			return { kind: "plain", carrier: pgCarrier[desc.type] }
		case "numeric":
			return { kind: "numeric", typmod: { precision: desc.precision, scale: desc.scale } }
		case "uuid":
			return { kind: "plain", carrier: "uuid" }
		case "text":
			return { kind: "text", text: succeeded(env.text(desc.source, desc.flags)) }
		case "closedId":
			return { kind: "closedId", roster: envRoster(env, desc.roster) }
		case "bits":
			return { kind: "bits", roster: envRoster(env, desc.roster) }
		case "vector":
			return { kind: "vector", dims: desc.dimensions }
		case "span":
			return { kind: "span", endpoint: contentOf(desc.endpoint, env), width: desc.width }
		case "contract":
			return {
				kind: "contract",
				name: desc.name,
				base: contentOf(desc.base, env),
				predicate: env.kind === "schema" && desc.predicate !== undefined
			}
	}
}

describe("scalarTypeOf builds each type from its content", () => {
	it.effect(
		"gives each Description its own content, frozen, canonically equal to an equal content's and apart from a different one's",
		(ctx) =>
			Effect.gen(function* () {
				const situations: Arr.NonEmptyReadonlyArray<ContentFeature> = [
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
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/scalar/content",
							/** Two environments and up to eight readings under them, each Description read under both. */
							draw: drawn(
								(source) =>
									[
										source.draw(
											(source) => [source.draw(readingEnvGen), source.draw(readingEnvGen)] as const
										),
										source.draw(array(readingDescGen, { min: 1, max: 8 }))
									] as const
							),
							literal: Formatter.format,
							coverage: required<ContentFeature>(situations, { cases: 200, sense: notesOnly }),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([envs, descs], c) =>
							Effect.sync(() => {
								const read = Arr.flatMap(descs, (desc, i) =>
									Arr.map(envs, (env, e) => {
										const at = `reading ${i} under environment ${e}`
										const type = succeeded(scalarTypeOf(desc, env, SourceLoc(at, [])))
										c.note(`kind ${desc.kind}`)
										describes(type, desc, env, at)
										assert.ok(Object.isFrozen(type), `${at} is frozen`)
										return { type, content: contentOf(desc, env), at }
									})
								)
								for (const [i, x] of read.entries()) {
									for (const y of read.slice(i + 1)) {
										const same = canonicalEquals(x.content, y.content, everyProperty)
										c.note(same ? "equal contents" : "different contents")
										assert.equal(
											canonicalEquals(x.type, y.type, everyProperty),
											same,
											`${x.at} and ${y.at}: canonically equal exactly when their contents are`
										)
									}
								}
							})
					)
				)
			})
	)
})

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

type LiteralFeature =
	| `${LiteralCarrier} ${"literal" | "refused"}`
	| DrawnFeature<never>
	| "vector snapshot at build"
	| "negative zero normalized"

type Verdict =
	| { readonly kind: "literal"; readonly literal: LiteralDesc }
	| { readonly kind: "fault"; readonly fault: ValueFault }
	| { readonly kind: "a fault of the vocabulary" }

interface LiteralCase {
	readonly carrier: LiteralCarrier
	readonly type: ScalarType
	readonly live: Gen<unknown>
	readonly judge: (value: unknown) => Verdict
}

const literalOf = (value: LiteralDesc): Verdict => ({ kind: "literal", literal: value })
const faultOf = (fault: ValueFault): Verdict => ({ kind: "fault", fault })
const someFault: Verdict = { kind: "a fault of the vocabulary" }

const scalarOf = (field: unknown): ScalarType =>
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

/** real and double precision: a JavaScript number, -0 written 0, the specials wrapped. */
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
	return literalOf(value === 0 ? 0 : value)
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

const Kind = closed("Kind", ["Manual", "Automatic"])
const handles: ReadonlyArray<string> = Kind.handles
const int8Values = bigint(-(2n ** 63n), 2n ** 63n - 1n)

const vectorCase: LiteralCase = {
	carrier: "vector(2)",
	type: scalarOf(pgDescriptors.vector(2)),
	live: oneOf<unknown>([
		map(array(element([1, 2, 0, -3, 0.5, Number.NaN]), { min: 1, max: 3 }), (xs) =>
			Float32Array.from(xs)
		),
		constant([1])
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

const literalCases: Arr.NonEmptyReadonlyArray<LiteralCase> = [
	{
		carrier: "int2",
		type: scalarOf(pgDescriptors.smallint),
		live: oneOf<unknown>([int(-32768, 32767), element<unknown>([-0, 0.5, 1e300, 1n])]),
		judge: integerJudge
	},
	{
		carrier: "int4",
		type: scalarOf(pgDescriptors.integer),
		live: oneOf<unknown>([
			int(-(2 ** 31), 2 ** 31 - 1),
			element<unknown>([-0, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, 1n])
		]),
		judge: integerJudge
	},
	{
		carrier: "int8",
		type: scalarOf(pgDescriptors.bigint),
		live: oneOf<unknown>([int8Values, constant(1)]),
		judge: bigintJudge
	},
	{
		carrier: "numeric",
		type: scalarOf(pgDescriptors.numeric(9, 2)),
		live: oneOf<unknown>([
			decimalText,
			element<unknown>(["1.50", "1e", "0x10", " 1", "NaN", Decimal.of("0.062"), 2n, 1])
		]),
		judge: numericJudge
	},
	{
		carrier: "float4",
		type: scalarOf(pgDescriptors.real),
		live: oneOf<unknown>([
			double(-Number.MAX_VALUE, Number.MAX_VALUE),
			element<unknown>([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0, "1"])
		]),
		judge: floatJudge
	},
	{
		carrier: "float8",
		type: scalarOf(pgDescriptors["double precision"]),
		live: oneOf<unknown>([
			double(-Number.MAX_VALUE, Number.MAX_VALUE),
			element<unknown>([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0, "1"])
		]),
		judge: floatJudge
	},
	{
		carrier: "money",
		type: scalarOf(pgDescriptors.money),
		live: oneOf<unknown>([map(int8Values, (n) => Money.of(n)), constant(5n)]),
		judge: (value) => (value instanceof Money ? literalOf(value) : faultOf("moneyType"))
	},
	{
		carrier: "bool",
		type: scalarOf(pgDescriptors.boolean),
		live: oneOf<unknown>([boolean, constant(0)]),
		judge: (value) => (typeof value === "boolean" ? literalOf(value) : faultOf("boolType"))
	},
	{
		carrier: "uuid",
		type: scalarOf(uuidDescriptor),
		live: oneOf<unknown>([
			uuid(4),
			map(uuid(4), (u) => Str.toUpperCase(u)),
			element([
				"not-a-uuid",
				"a0eebc999c0b4ef8bb6d6bb9bd380a11",
				"{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}"
			])
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
		live: oneOf<unknown>([
			(source) => ({
				start: source.draw(int(-(2 ** 31), 2 ** 31 - 1)),
				end: source.draw(int(-(2 ** 31), 2 ** 31 - 1))
			}),
			element<unknown>([
				{ start: 1.5, end: 3 },
				{ start: 1, end: 2 ** 53 },
				{ start: 1n, end: 2n },
				{ start: 1, end: 2, x: 3 }
			])
		]),
		judge: spanJudge(isSafeInteger)
	},
	{
		carrier: "span over int8",
		type: scalarOf(spanDescriptor(pgDescriptors.bigint)),
		live: oneOf<unknown>([
			(source) => ({ start: source.draw(int8Values), end: source.draw(int8Values) }),
			element<unknown>([
				{ start: 1, end: 2 },
				{ start: 1n, end: 2n, x: 3n }
			])
		]),
		judge: spanJudge(isBigInt)
	},
	vectorCase,
	{
		carrier: "contract Cents",
		type: scalarOf(contractDescriptor("Cents", pgDescriptors.bigint)),
		live: oneOf<unknown>([int8Values, constant(1)]),
		judge: bigintJudge
	}
]

describe("literalDescFor: literal operands adopt the base's host type", () => {
	it.effect(
		"returns the literal each carrier's host kind states, and refuses every other value by its fault, never throwing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/literal-desc",
						/**
						 * Planted: a live vector of two finite components at vector(2), which the drawn buffers are a few times
						 * a run among the carriers' values.
						 */
						draw: sketched(
							(source) => {
								const carrier = source.draw(element(literalCases))
								const others = nonEmpty(
									Arr.filter(literalCases, (o) => o !== carrier),
									"the other carriers"
								)
								return [
									carrier,
									source.draw(
										lsw<unknown>({
											live: oneOf<unknown>([
												carrier.live,
												(again) => again.draw(again.draw(element(others)).live)
											]),
											stale: Option.none(),
											wild: WILD_KINDS
										})
									)
								] as const
							},
							(x) => x
						),
						literal: Formatter.format,
						coverage: required<LiteralFeature>(
							[
								...Arr.flatMap(literalCases, (c): Arr.NonEmptyReadonlyArray<LiteralFeature> => [
									`${c.carrier} literal`,
									`${c.carrier} refused`
								]),
								...Arr.map(WILD_KINDS, (kind): LiteralFeature => `wild ${kind}`),
								"vector snapshot at build",
								"negative zero normalized"
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [
							{
								note: "a vector of the type's dimensions",
								sketch: [vectorCase, { kind: "live", value: Float32Array.from([3, -0.5]) }],
								draws: "",
								reaches: ["vector(2) literal" as const, "vector snapshot at build" as const]
							}
						],
						/** values/identity.test.ts's admission search over the same carriers. */
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([carrier, d], c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							const value = passed(d)
							const verdict =
								d.kind === "wild" && d.wild.kind === "proxy" ? someFault : carrier.judge(value)
							const result = literalDescFor(carrier.type, value)
							c.note(`${carrier.carrier} ${result.ok ? "literal" : "refused"}`)
							if (verdict.kind === "literal") {
								assert.deepEqual(succeeded(result), verdict.literal)
								if (Object.is(value, -0)) {
									c.note("negative zero normalized")
								}
							} else if (verdict.kind === "fault") {
								faulted(result, verdict.fault)
							} else {
								assert.ok(!result.ok && isValueFault(result.error))
							}
							if (
								carrier.carrier !== "vector(2)" ||
								verdict.kind !== "literal" ||
								!(value instanceof Float32Array)
							) {
								return
							}
							/**
							 * A vector literal is the buffer's components when it was built: writing the buffer later leaves it as it was.
							 */
							const buffer = Float32Array.from(value)
							const built = succeeded(literalDescFor(carrier.type, buffer))
							buffer.fill(7)
							assert.deepEqual(built, verdict.literal)
							c.note("vector snapshot at build")
						})
				)
			)
	)
})

/**
 * The descriptor boundary: describeField reads a descriptor a builder made, span takes one as its endpoint, and closedId
 * takes a closed relation. A copy of a descriptor's members (a look-alike), pg.numeric itself, the builder whose
 * precision and scale a caller left undeclared, and any wild value are no descriptor: MalformedDescription at
 * describeField and span; any wild value is no closed relation: MalformedDescription at closedId. A live descriptor is
 * read; span builds over integer, bigint and contracts over them, and refuses any other endpoint by its capability;
 * closedId builds the closed relation's handle descriptor.
 */
type Boundary = "describeField" | "span" | "closedId"
type NoDescriptor = "look-alike" | "numeric builder"
type DescribeFeature = DrawnFeature<NoDescriptor> | `boundary ${Boundary}`

const Cents = contractDescriptor("Cents", pgDescriptors.bigint)
const Day = contractDescriptor("Day", pgDescriptors.integer)
const endpoints: Arr.NonEmptyReadonlyArray<object> = [
	pgDescriptors.integer,
	pgDescriptors.bigint,
	Cents,
	Day
]
const descriptors: Arr.NonEmptyReadonlyArray<object> = [
	...endpoints,
	pgDescriptors.smallint,
	pgDescriptors.numeric(9, 2),
	pgDescriptors.numeric(1000, -1000),
	pgDescriptors.real,
	pgDescriptors["double precision"],
	pgDescriptors.money,
	pgDescriptors.boolean,
	pgDescriptors.serial,
	uuidDescriptor,
	pgDescriptors.vector(3),
	spanDescriptor(pgDescriptors.bigint),
	spanDescriptor(pgDescriptors.integer, 7),
	admittedClosedId(Kind),
	str.regex("^a$")
]

/**
 * A descriptor (live, a look-alike or wild) for describeField and span, or a closed relation (live Kind, or wild) for
 * closedId.
 */
const boundaryCaseGen: Gen<readonly [Drawn<object, NoDescriptor>, Boundary]> = oneOf([
	(source) =>
		[
			source.draw(
				lsw<object, NoDescriptor>({
					live: element(descriptors),
					stale: Option.some(
						oneOf([
							map(element(descriptors), (field): Stale<object, NoDescriptor> => ({
								value: { ...field },
								from: "look-alike"
							})),
							constant<Stale<object, NoDescriptor>>({
								value: pgDescriptors.numeric,
								from: "numeric builder"
							})
						])
					),
					wild: WILD_KINDS
				})
			),
			source.draw(element<Boundary>(["describeField", "span"]))
		] as const,
	(source) =>
		[
			source.draw(
				lsw<object, NoDescriptor>({ live: constant(Kind), stale: Option.none(), wild: WILD_KINDS })
			),
			source.draw(constant<Boundary>("closedId"))
		] as const
])

describe("describeField", () => {
	it.effect(
		"reads every descriptor a builder made, and refuses a look-alike, the undeclared numeric builder and every wild value as malformed, at describeField, span and closedId",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/describe-field",
						draw: drawn(boundaryCaseGen),
						literal: Formatter.format,
						coverage: required<DescribeFeature>(
							[
								"live",
								"stale look-alike",
								"stale numeric builder",
								...Arr.map(WILD_KINDS, (kind): DescribeFeature => `wild ${kind}`),
								"boundary describeField",
								"boundary span",
								"boundary closedId"
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
					([d, boundary], c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							c.note(`boundary ${boundary}`)
							const x = passed(d)
							switch (boundary) {
								case "describeField": {
									const result = describeField(x, SourceLoc("a drawn descriptor", []))
									if (d.kind === "live") {
										assert.equal(result.ok, true)
									} else {
										refused(result, "MalformedDescription")
									}
									return
								}
								case "span":
									if (d.kind !== "live") {
										throwsRefused(() => spanDescriptor(x), "MalformedDescription")
									} else if (endpoints.includes(d.value)) {
										assert.ok(spanOf(scalarOf(spanDescriptor(x))) !== undefined, "a span")
									} else {
										throwsRefused(() => spanDescriptor(x), "UnsupportedOperation")
									}
									return
								case "closedId":
									if (d.kind === "live") {
										assert.deepEqual(
											succeeded(describeField(admittedClosedId(x), SourceLoc("closedId", []))).desc,
											{
												kind: "closedId",
												roster: Kind.name
											}
										)
									} else {
										throwsRefused(() => admittedClosedId(x), "MalformedDescription")
									}
									return
							}
						})
				)
			)
	)
})
