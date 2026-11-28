/**
 * The scalar descriptors (scalar/pg.ts, scalar/registry.ts describeField, schema/relation.ts closedId, contracts and
 * spans), each held to its own definition:
 *
 * - descriptor identity and distinct types: two spellings of the pg namespace are two descriptors of two types, and two
 *   descriptors one type exactly when their parts name one; a
 *   descriptor's Description decodes to itself, keys in order. Oracle: the sketches' own parts (test/support/unit/scalar/support.ts), a specification.
 * - typmods: numeric(p, s) and vector(n) admit exactly what PostgreSQL's rules admit, at every integer near their
 *   bounds and every wild argument, and refuse every other argument and arity as MalformedDescription. Oracle:
 *   PostgreSQL's published rules, restated from the published limits (vectorMaxDimensions, the integer carriers'
 *   ranges).
 * - spans: a span's width is admitted exactly when it is positive and of its endpoint's base type, and a span's
 *   endpoint is one of the span carriers' endpoints.
 * - closed ids: closedId names the roster, keeps the closed relation and its declared handle order, one identity per
 *   roster and another per name; and every forgery of a closed relation, each named by the one rule it breaks, is
 *   refused.
 *
 * Features: as each search names them: the spelling and type outcomes, every kind of sketch, admitted and refused,
 * every wild kind, each forgery; for the typmods, each bound and the integer past it (numeric's precision and scale,
 * vector's least and greatest dimensions), drawn from the bounds half the
 * time beside the wide range; for closed ids, one handle and several, two names and one.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { corruptedFeature, drawnFeature, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { capsOf, Roster, rosterOf, sameScalarType, spanOf } from "#compiler/ir/scalar.ts"
import { admitNumericTypmod } from "#compiler/scalar/pg.ts"
import { carrierSql, describeField } from "#compiler/scalar/registry.ts"
import { checkNumericTypmod } from "#compiler/scalar/values/decimal.ts"
import { vector } from "#compiler/scalar/vector.ts"
import { admitVectorDimensions } from "#compiler/scalar/vector.ts"
import { admittedClosedId, closedBuilder } from "#compiler/schema/relation.ts"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import { spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	descriptorGen,
	descriptorOf,
	spanCarrierOf,
	typeKeyOf
} from "#test/support/unit/scalar/support.ts"
import {
	admits,
	boundsReached,
	type ClosedIdFeature,
	closedIdCaseGen,
	descOf,
	described,
	dimensionBounds,
	type EndpointFeature,
	type ForgeryFeature,
	forgedGen,
	forgeries,
	identityOf,
	isInteger,
	type KindFeature,
	keyOrder,
	kindFeatures,
	type NumericTypmodFeature,
	numericTypmodSpace,
	admittedNumericTypmod,
	plainPairGen,
	precisionBounds,
	type SpanWidthFeature,
	scalarOf,
	scaleBounds,
	spanWidthSpace,
	type TypeFeature,
	type TypmodFeature,
	typePairGen,
	type VectorFeature,
	vectorSpace
} from "#test/unit/scalar/descriptors.fixtures.ts"

/** Two spellings of the pg namespace are two descriptors of two types. */
export const twoSpellingsAreTwoDescriptorsOfTwoTypes = property.exhaust(finite(plainPairGen), {
	box: "every pair of the pg namespace's descriptors",
	needs: {},
	situations: ["two types"] satisfies ReadonlyArray<Reached<"two types">>,
	check:
		(_, c: Case<"two types">) =>
		([x, y]) =>
			Effect.sync(() => {
				const a = descriptorOf(x)
				const b = descriptorOf(y)
				const label = `${Formatter.format(x)} and ${Formatter.format(y)}`
				assert.equal(typeKeyOf(x) === typeKeyOf(y), false, `${label}: one type spelled twice`)
				assert.equal(a === b, false, label)
				assert.equal(identityOf(a) === identityOf(b), false, label)
				assert.equal(Object.isFrozen(a), true, label)
				c.note("two types")
			}),
	oracle: {
		kind: "specification",
		name: "the SQL type each spelling names, which the catalog suite holds PostgreSQL to"
	},
	kept: [],
	kills: [
		{
			file: "packages/text/src/regex/ir.ts",
			original: '\t\tif (body.kind === "never") {',
			replacement: '\t\tif (body.kind !== "never") {',
			why: "Operator mutant 2f8934ec20 at packages/text/src/regex/ir.ts:605 in <module>: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
		}
	]
})

/**
 * Descriptor identity makes two descriptors one type exactly when their parts name one.
 *
 * Budget: its suite's count before the conversion (unit/scalar/distinct-types: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const descriptorIdentityMakesTwoDescriptorsOneTypeExactlyWhenTheirPartsNameOne =
	property.explore(typePairGen, {
		needs: {},
		situations: ["one type", "two types of one kind", "two types"] satisfies ReadonlyArray<
			Reached<TypeFeature>
		>,
		check:
			(_, c: Case<TypeFeature>) =>
			([x, y]) =>
				Effect.sync(() => {
					const oneType = typeKeyOf(x) === typeKeyOf(y)
					c.note(oneType ? "one type" : x.kind === y.kind ? "two types of one kind" : "two types")
					assert.equal(
						identityOf(descriptorOf(x)) === identityOf(descriptorOf(y)),
						oneType,
						`${Formatter.format(x)} and ${Formatter.format(y)}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "a type is its SQL type, typmod, roster, endpoint, width and contract name"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					"\tif (!isInteger(scale) || scale < numericMinScale || scale > numericMaxScale) {",
				replacement:
					"\tif (!isInteger(scale) || scale >= numericMinScale || scale > numericMaxScale) {",
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/decimal.ts:510 in checkNumericTypmod: `<` becomes `>=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Descriptor identity builds every descriptor's Description through its decoder, and a ScalarType the full decoder makes
 * exactly.
 *
 * Budget: its suite's count before the conversion (unit/scalar/descriptor-decode: 1000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const descriptorIdentityBuildsEveryDescriptorsDescriptionThroughItsDecoderAndAScalarTypeTheFullDecoderMakesExactly =
	property.explore(descriptorGen(2), {
		needs: {},
		situations: kindFeatures satisfies ReadonlyArray<Reached<KindFeature>>,
		check: (_, c: Case<KindFeature>) => (sketch) =>
			Effect.sync(() => {
				c.note(sketch.kind)
				const field = descriptorOf(sketch)
				const { desc, scalar } = described(field)
				assert.deepEqual(succeeded(decodeDesc("field", desc)), desc)
				const decoded = succeeded(decodeScalarType(scalar))
				assert.deepEqual(decoded, scalar)
				assert.deepEqual(keyOrder(decoded), keyOrder(scalar))
				assert.equal(Object.isFrozen(field), true)
			}),
		oracle: { kind: "universal", name: "decode ∘ describe = describe, key order kept" },
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar-shape.ts",
				original: '\tif (t.bound !== undefined && carrier !== "numeric") {',
				replacement: '\tif (t.bound === undefined && carrier !== "numeric") {',
				why: "Operator mutant (comparison) at packages/engine/src/ir/scalar-shape.ts:444 in narrow: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Typmod validation agrees with the carrier's numeric typmod rule on every integer pair, and refuses every other
 * argument and arity.
 *
 * Budget: its suite's count before the conversion (unit/scalar/descriptors-7239021: 2000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const typmodValidationAgreesWithTheCarriersNumericTypmodRuleOnEveryIntegerPairAndRefusesEveryOtherArgumentAndArity =
	property.explore(numericTypmodSpace, {
		needs: {},
		situations: [
			"admitted",
			"refused",
			"arity",
			...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`),
			...Arr.map(precisionBounds, (bound) => bound.feature),
			...Arr.map(scaleBounds, (bound) => bound.feature)
		] satisfies ReadonlyArray<Reached<NumericTypmodFeature>>,
		check:
			(_, c: Case<NumericTypmodFeature>) =>
			([dp, ds, arity]) =>
				Effect.sync(() => {
					c.note(drawnFeature(dp))
					c.note(drawnFeature(ds))
					const p = passed(dp)
					const s = passed(ds)
					if (arity === 0 || arity === 3) {
						c.note("arity")
					}
					if (arity === 2) {
						for (const feature of [
							...boundsReached(precisionBounds, dp),
							...boundsReached(scaleBounds, ds)
						]) {
							c.note(feature)
						}
					}
					const [precision, scale, extra] =
						arity === 0
							? [undefined, undefined, []]
							: arity === 1
								? [p, undefined, []]
								: arity === 2
									? [p, s, []]
									: [p, s, [1]]
					const expected = arity === 2 ? admittedNumericTypmod(p, s) : undefined
					if (expected === undefined) {
						c.note("refused")
						throwsRefused(() => admitNumericTypmod(precision, scale, extra), "MalformedDescription")
					} else {
						c.note("admitted")
						assert.deepEqual(admitNumericTypmod(precision, scale, extra), expected)
					}
					if (arity === 2 && dp.kind === "live" && ds.kind === "live") {
						assert.equal(checkNumericTypmod(p, s).ok, expected !== undefined)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the numeric typmod rule restated (numericTypmodOf)"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: '\ttypeof value === "number" && Number.isInteger(value)',
				replacement: '\ttypeof value !== "number" && Number.isInteger(value)',
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/decimal.ts:496 in isInteger: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Typmod validation admits vector dimensions 1-16000 alone, and refuses the rest.
 *
 * Budget: its suite's count before the conversion (unit/scalar/vector-dims: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const typmodValidationAdmitsVectorDimensions116000AloneAndRefusesTheRest = property.explore(
	vectorSpace,
	{
		needs: {},
		situations: [
			"admitted",
			"refused",
			...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`),
			...Arr.map(dimensionBounds, (bound) => bound.feature)
		] satisfies ReadonlyArray<Reached<VectorFeature>>,
		check:
			(_, c: Case<VectorFeature>) =>
			([d, extras]) =>
				Effect.sync(() => {
					c.note(drawnFeature(d))
					for (const feature of boundsReached(dimensionBounds, d)) {
						c.note(feature)
					}
					const dimensions = passed(d)
					const extra = Option.match(extras, {
						onNone: (): ReadonlyArray<unknown> => [],
						onSome: (values) =>
							Arr.map(values, (value) => passed<never, never>({ kind: "wild", wild: value }))
					})
					if (
						extra.length === 0 &&
						isInteger(dimensions) &&
						dimensions >= 1 &&
						dimensions <= vectorMaxDimensions
					) {
						c.note("admitted")
						admitVectorDimensions(dimensions, [])
						assert.equal(vector(dimensions).dimensions, dimensions)
					} else {
						c.note("refused")
						throwsRefused(() => admitVectorDimensions(dimensions, extra), "MalformedDescription")
					}
				}),
		oracle: {
			kind: "specification",
			name: "pgvector's dimensions, an integer from 1 to vectorMaxDimensions"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/vector.ts",
				original: "\t\tdimensions > vectorMaxDimensions",
				replacement: "\t\tdimensions > vectorMaxDimensions + 1",
				why: "vector admits one dimension past pgvector's greatest; the typmods property fails."
			}
		]
	}
)

/**
 * Typmod validation admits a positive range width of the endpoint's base type, and refuses the rest.
 *
 * Budget: its suite's count before the conversion (unit/scalar/span-width: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const typmodValidationAdmitsAPositiveSpanWidthOfTheEndpointsBaseTypeAndRefusesTheRest =
	property.explore(spanWidthSpace, {
		needs: {},
		situations: [
			"admitted",
			"refused",
			...Arr.map(WILD_KINDS, (kind): TypmodFeature => `wild ${kind}`),
			"endpoint range4",
			"endpoint range8"
		] satisfies ReadonlyArray<Reached<SpanWidthFeature>>,
		check:
			(_, c: Case<SpanWidthFeature>) =>
			([sketch, d, arity]) =>
				Effect.sync(() => {
					const carrier = defined(spanCarrierOf(sketch), "an endpoint's span carrier")
					const endpoint = descriptorOf(sketch)
					c.note(`endpoint ${carrier}`)
					c.note(drawnFeature(d))
					const width = passed(d)
					if (arity === 3) {
						c.note("refused")
						throwsRefused(() => spanDescriptor(endpoint, width, 0), "MalformedDescription")
						return
					}
					/** An undefined width is the optional width left out: span(endpoint). */
					const given = arity === 2 ? width : undefined
					if (given === undefined) {
						c.note("admitted")
						assert.equal(spanOf(scalarOf(spanDescriptor(endpoint, given)))?.width, undefined)
					} else if (
						(typeof given === "number" || typeof given === "bigint") &&
						admits[carrier](given)
					) {
						c.note("admitted")
						assert.equal(spanOf(scalarOf(spanDescriptor(endpoint, given)))?.width, BigInt(given))
					} else {
						c.note("refused")
						throwsRefused(() => spanDescriptor(endpoint, given), "MalformedDescription")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the README's widths: a positive integer within the endpoint's base type"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/subset.ts",
				original:
					'subset.kind === "done" ||\n\t\t\tthis.#configs\n\t\t\t\t.closure(subset.configs, { atStart: subset.initial, atEnd: true })\n\t\t\t\t.some((c) => this.#configs.state(c) === this.nfa.accept)',
				replacement: 'subset.kind === "done"',
				why: "Census mutant 5e0a3b3402 (packages/text/src/regex/subset.ts, SearchSubsets acceptsAtEnd), restated on the counting automaton's configurations: a text accepts only once a match was found before its end, never at its end; the property fails (the census, lane TESTPOLICY2; restated by lane TEXTSPEC)."
			}
		]
	})

/**
 * Span endpoint eligibility admits integer, bigint and contracts over them, as int4range and int8range, and refuses
 * every other endpoint.
 *
 * Budget: its suite's count before the conversion (unit/scalar/span-endpoints: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const spanEndpointEligibilityAdmitsIntegerBigintAndContractsOverThemAsInt4rangeAndInt8rangeAndRefusesEveryOtherEndpoint =
	property.explore(descriptorGen(2), {
		needs: {},
		situations: ["range4", "range8", "refused"] satisfies ReadonlyArray<Reached<EndpointFeature>>,
		check: (_, c: Case<EndpointFeature>) => (sketch) =>
			Effect.sync(() => {
				const endpoint = descriptorOf(sketch)
				const expected = spanCarrierOf(sketch)
				if (expected === undefined) {
					c.note("refused")
					throwsRefused(() => spanDescriptor(endpoint), "UnsupportedOperation")
					return
				}
				c.note(expected)
				const s = spanDescriptor(endpoint)
				assert.equal(scalarOf(s).carrier, expected)
				assert.ok(s.endpoint === endpoint, "the span keeps its endpoint descriptor")
				assert.deepEqual(descOf(s), {
					kind: "span",
					endpoint: descOf(endpoint),
					width: undefined
				})
				assert.ok(capsOf(scalarOf(endpoint)).includes("spanEndpoint"), "an endpoint")
				const contracted = defined(spanOf(scalarOf(s)), "the span").endpoint.contract
				assert.equal(contracted?.name, scalarOf(endpoint).contract?.name)
			}),
		oracle: {
			kind: "specification",
			name: "the README's range endpoints: integer or bigint, or a contract over one"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original: "!table.has(node)",
				replacement: "table.has(node)",
				why: "Operator mutant a7c2d982a7 at packages/text/src/regex/ir.ts:304 in folded: `!table.has(node)` becomes `table.has(node)`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/**
 * ClosedId names the roster, keeps the closed relation, and keeps declared handle order.
 *
 * Budget: its suite's count before the conversion (unit/scalar/closed-id: 100 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const closedIdNamesTheRosterKeepsTheClosedRelationAndKeepsDeclaredHandleOrder =
	property.explore(closedIdCaseGen, {
		needs: {},
		situations: [
			"one handle",
			"several handles",
			"two names",
			"one name twice"
		] satisfies ReadonlyArray<Reached<ClosedIdFeature>>,
		check:
			(_, c: Case<ClosedIdFeature>) =>
			({ name, other, handles }) =>
				Effect.sync(() => {
					c.note(handles.length === 1 ? "one handle" : "several handles")
					c.note(other === name ? "one name twice" : "two names")
					const [first, ...rest] = handles
					const listed: Arr.NonEmptyReadonlyArray<string> = [defined(first, "a handle"), ...rest]
					const roster = closedBuilder(name, listed, "ordered", [])
					const field = admittedClosedId(roster)
					assert.equal(field.roster, roster)
					assert.equal(field.sql, carrierSql.code)
					assert.deepEqual(
						descOf(field),
						succeeded(describeField(admittedClosedId(roster), SourceLoc("again", []))).desc
					)
					assert.deepEqual(
						rosterOf(scalarOf(field)),
						Roster.of(parsedName(name), "ordered", listed)
					)
					assert.equal(identityOf(admittedClosedId(roster)), identityOf(field))
					if (other !== name) {
						assert.equal(
							sameScalarType(
								scalarOf(admittedClosedId(closedBuilder(other, listed, "ordered", []))),
								scalarOf(field)
							),
							false
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the roster of the drawn name and handles, in declared order (Roster.of)"
		},
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"\ta === b ||\n\t(a.contract === undefined || b.contract === undefined\n\t\t? a.contract === undefined && b.contract === undefined && samePlain(a, b)\n\t\t: a.carrier === b.carrier &&\n\t\t\ta.contract.name === b.contract.name &&\n\t\t\tsameScalarType(a.contract.base, b.contract.base))",
				replacement: "\ttrue",
				why: "Operator mutant (boolean-return) at packages/engine/src/ir/scalar.ts:876 in sameScalarType: `a === b ||\n\t(a.carrier === b.carrier &&\n\t\tsameOrder(a.caps, b.caps) &&\n\t\tsameCon` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * ClosedId refuses anything that is not a closed relation.
 *
 * Budget: its suite's count before the conversion (unit/scalar/closed-id-forgeries: 500 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const closedIdRefusesAnythingThatIsNotAClosedRelation = property.explore(forgedGen, {
	needs: {},
	situations: [
		"live",
		...Arr.map(forgeries, (f): ForgeryFeature => `wild ${f.rule}`)
	] satisfies ReadonlyArray<Reached<ForgeryFeature>>,
	check: (_, c: Case<ForgeryFeature>) => (forged) =>
		Effect.sync(() => {
			c.note(corruptedFeature(forged))
			if (forged.kind !== "live") {
				throwsRefused(() => admittedClosedId(forged.value), forged.refusal)
				return
			}
			const field = admittedClosedId(forged.value)
			assert.equal(field.roster, forged.value)
			assert.deepEqual(
				rosterOf(scalarOf(field)),
				Roster.of(parsedName(forged.value.name), forged.value.order, forged.value.handles)
			)
		}),
	oracle: {
		kind: "specification",
		name: "the one rule of a closed relation each forgery breaks"
	},
	budget: { runs: 500, steered: 0 },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/schema/relation.ts",
			original: "\t\tif (utf8Length(h) > handleMaxBytes) {",
			replacement: "\t\tif (utf8Length(h) <= handleMaxBytes) {",
			why: "Operator mutant (comparison) at packages/engine/src/schema/relation.ts:623 in handleList: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
		},
		{
			file: "packages/engine/src/scalar/closed-id.ts",
			original: "\tconst stated = rosterOrders.find((o) => o === order)\n",
			replacement: '\tconst stated = rosterOrders.find((o) => o === order) ?? "ordered"\n',
			why: "closedId reads a look-alike of no roster order as an ordered roster's; the forgery of no roster order is admitted."
		}
	]
})
