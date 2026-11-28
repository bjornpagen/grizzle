/**
 * The scalar registry (scalar/registry.ts): capabilities, the ScalarType of a FieldDesc under every environment, a
 * reading's content, literal operands and describeField's admission.
 *
 * - Capabilities: every descriptor's are its carrier's, a contract's its base's. Oracle: the carrier's
 *   capability set, which the catalog suite holds to PostgreSQL's.
 * - Fixtures: every ScalarType another suite's fixture exports is the registry's own build of its FieldDesc. Oracle: the
 *   registry's build, a second implementation of each hand-built fixture type.
 * - Kinds and environments: scalarTypeOf of a descriptor's Description agrees with the descriptor's own ScalarType;
 *   a contract's predicate table comes from the environment. Oracles: the descriptor's own type; the checker's
 *   predicate table.
 * - Content: two readings are canonically equal exactly when their contents are, under any environments. Oracle: the
 *   readings' contents compared apart.
 * - Literal operands: each carrier's literal is the one its host kind states, and every other value is refused by its
 *   fault, never thrown.
 * - describeField reads every descriptor a builder made, numeric among them, and refuses a look-alike, a written field
 *   and every wild value as malformed, at describeField, span and closedId, never throwing.
 *
 * Features: as each search names them; for the predicate table, a bound below, at and above zero.
 */

import { assert, defined, nonEmpty, unorderedEqual } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { drawnFeature, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import {
	type CapabilitySet,
	type Carrier,
	carriers,
	Roster,
	sameScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import { int8 } from "#compiler/scalar/pg.ts"
import {
	bareEnv,
	capabilitiesOf,
	describeField,
	noRosters,
	type ScalarEnv,
	scalarTypeOf
} from "#compiler/scalar/registry.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { admittedClosedId } from "#compiler/schema/relation.ts"
import { faulted, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { contractDescriptor, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import {
	type DescriptorSketch,
	descriptorGen,
	descriptorOf
} from "#test/support/unit/scalar/support.ts"
import { fixtureTypes } from "#test/unit/scalar/registry.dictionary.ts"
import {
	boundarySpace,
	caps,
	type ContentFeature,
	contentCaseGen,
	contentFeatures,
	contentOf,
	type DescribeFeature,
	describes,
	endpoints,
	isWrittenField,
	Kind,
	type LiteralFeature,
	literalCases,
	literalOperandSpace,
	predicateCaseGen,
	predicateTable,
	registryBuild,
	rostersOfSketch,
	scalarOf,
	someFault,
	valueDescriptor
} from "#test/unit/scalar/registry.fixtures.ts"

/**
 * The capabilities a sketch's type has by the rule the registry states: its carrier's, a contract's its base's, and a
 * closed id's of an unordered or a zone roster its carrier's without ordering and minMax, since no handle comes before
 * another.
 */
const carrierCapabilities = (sketch: DescriptorSketch, carrier: Carrier): CapabilitySet => {
	const roster = rosterSketchOf(sketch)
	const native = capabilitiesOf(carrier)
	return roster?.order === "unordered" || roster?.order === "zones"
		? Arr.filter(native, (cap) => cap !== "ordering" && cap !== "minMax")
		: native
}

/** The closed id a sketch's type is, through its contracts; none for any other sketch. */
const rosterSketchOf = (
	sketch: DescriptorSketch
): Extract<DescriptorSketch, { readonly kind: "closedId" }> | undefined =>
	sketch.kind === "closedId"
		? sketch
		: sketch.kind === "contract"
			? rosterSketchOf(sketch.base)
			: undefined

/**
 * The capability registry gives every descriptor its carrier's capabilities, a contract its base's, and
 * a closed id of an unordered roster its carrier's but ordering and minMax.
 *
 * Budget: its suite's count before the conversion (unit/scalar/capabilities: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theCapabilityRegistryGivesEveryDescriptorItsCarriersCapabilitiesAndAContractItsBases =
	property.explore(descriptorGen(2), {
		needs: {},
		situations: ["a contract", "a vector"] satisfies ReadonlyArray<
			Reached<"a contract" | "a vector">
		>,
		check: (_, c: Case<"a contract" | "a vector">) => (sketch) =>
			Effect.sync(() => {
				const field = descriptorOf(sketch)
				const scalar = succeeded(describeField(field, SourceLoc("test", []))).scalar
				unorderedEqual(caps(field), carrierCapabilities(sketch, scalar.carrier))
				if (sketch.kind === "contract") {
					c.note("a contract")
					unorderedEqual(caps(field), caps(descriptorOf(sketch.base)))
				}
				if (scalar.carrier === "vector") {
					c.note("a vector")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a type's capabilities are its carrier's, which the catalog suite holds to PostgreSQL's"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t\tcase "ordered":\n\t\t\treturn capabilitiesOf("code")',
				replacement: '\t\tcase "ordered":\n\t\t\treturn capabilitiesOf("bits")',
				why: "A closed id's ScalarType takes the bits carrier's capabilities; the capabilities property fails."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original:
					'\t\tcase "unordered":\n\t\tcase "zones":\n\t\t\treturn capabilitySet(unorderedCodeCapabilities)',
				replacement:
					'\t\tcase "unordered":\n\t\tcase "zones":\n\t\t\treturn capabilitiesOf("code")',
				why: "An unordered roster's closed id keeps ordering and minMax, so the engine orders by codes its roster says mean nothing; the capabilities property fails."
			}
		]
	})

/** ScalarTypeOf: a FieldDesc to its ScalarType built every type a test fixture exports: each is the registry's type of its FieldDesc, or its computed numeric. */
export const scalarTypeOfAFieldDescToItsScalarTypeBuiltEveryTypeATestFixtureExportsEachIsTheRegistrysTypeOfItsFieldDescOrItsComputedNumeric =
	property.exhaust(finite(word(fixtureTypes)), {
		box: "every ScalarType the IR, conservative-lowering and codec fixtures export, every plain type and the wildcard text",
		needs: {},
		situations: nonEmpty(
			Arr.map(
				Arr.filter(carriers, (c) => c !== "exactInteger" && c !== "exactMoney"),
				(c): `carrier ${Carrier}` => `carrier ${c}`
			),
			"a field's carriers"
		) satisfies ReadonlyArray<Reached<`carrier ${Carrier}`>>,
		check:
			(_, c: Case<`carrier ${Carrier}`>) =>
			([where, t]) =>
				Effect.sync(() => {
					c.note(`carrier ${t.carrier}`)
					assert.equal(sameScalarType(t, registryBuild(t)), true, where)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the registry's own build of each fixture type's FieldDesc"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					'\ttypeof a === "string" || typeof b === "string"\n\t\t? a === b\n\t\t: samePatterns(a.patterns, b.patterns) && a.key === b.key',
				replacement:
					'\ttypeof a === "string" || typeof b === "string"\n\t\t? a !== b\n\t\t: samePatterns(a.patterns, b.patterns) && a.key === b.key',
				why: "Operator mutant (comparison) at packages/engine/src/ir/scalar.ts:851 in sameRegexRef: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"\t\t\treturn a.typmod.precision === b.typmod.precision && a.typmod.scale === b.typmod.scale",
				replacement:
					"\t\t\treturn a.typmod.precision === b.typmod.precision && a.typmod.scale !== b.typmod.scale",
				why: "Two numerics of one typmod are two types (samePlain compares the scales by `!==`), so a numeric(p, s) fixture is not the registry's build of its FieldDesc."
			}
		]
	})

/**
 * ScalarTypeOf: a FieldDesc to its ScalarType reads every descriptor kind, and agrees with the descriptor's own
 * ScalarType.
 *
 * Budget: its suite's count before the conversion (unit/scalar/registry-kinds: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const scalarTypeOfAFieldDescToItsScalarTypeReadsEveryDescriptorKindAndAgreesWithTheDescriptorsOwnScalarType =
	property.explore(descriptorGen(2), {
		needs: {},
		situations: [
			"spelling",
			"numeric",
			"vector",
			"uuid",
			"closedId",
			"span",
			"contract"
		] satisfies ReadonlyArray<Reached<DescriptorSketch["kind"]>>,
		check: (_, c: Case<DescriptorSketch["kind"]>) => (sketch) =>
			Effect.sync(() => {
				c.note(sketch.kind)
				const { desc, scalar } = succeeded(describeField(descriptorOf(sketch), SourceLoc("f", [])))
				const rosters = rostersOfSketch(sketch)
				const env: ScalarEnv = {
					kind: "builder",
					roster: (name) => {
						const roster = rosters.get(name)
						return roster === undefined ? undefined : Roster.of(name, roster.order, roster.handles)
					}
				}
				assert.deepEqual(succeeded(scalarTypeOf(desc, env, SourceLoc("field", []))), scalar)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the descriptor's own ScalarType, against scalarTypeOf of its Description"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\tif (oriented === undefined) {",
				replacement: "\tif (oriented !== undefined) {",
				why: "Operator mutant c4861198b7 at packages/engine/src/scalar/compute/typing.ts:1013 in literalComparison: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/**
 * ScalarTypeOf: a FieldDesc to its ScalarType takes the checker's predicate table from the environment.
 *
 * Budget: its suite's count before the conversion (unit/scalar/predicate-env: 50 independent cases and 48 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const scalarTypeOfAFieldDescToItsScalarTypeTakesTheCheckersPredicateTableFromTheEnvironment =
	property.explore(predicateCaseGen, {
		needs: {},
		situations: [
			"a bound below zero",
			"a bound of zero",
			"a bound above zero"
		] satisfies ReadonlyArray<
			Reached<"a bound below zero" | "a bound of zero" | "a bound above zero">
		>,
		check:
			(_, c: Case<"a bound below zero" | "a bound of zero" | "a bound above zero">) =>
			({ name, bound }) =>
				Effect.sync(() => {
					c.note(
						bound < 0n
							? "a bound below zero"
							: bound === 0n
								? "a bound of zero"
								: "a bound above zero"
					)
					const Branded = contractDescriptor(name, int8, (v: ScalarTerm) =>
						computeCore.ge(v, bound)
					)
					const { desc } = succeeded(describeField(Branded, SourceLoc(name, [])))
					const base = succeeded(describeField(int8, SourceLoc("bigint", []))).scalar
					const identity = defined(
						succeeded(scalarTypeOf(desc, bareEnv, SourceLoc("field", []))).contract
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
								contractPredicate: predicateTable
							},
							SourceLoc("field", [])
						)
					)
					assert.deepEqual(typed.contract?.predicate, table)
					assert.deepEqual(succeeded(decodeScalarType(structuredClone(typed))), typed)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the checker's predicate table over the base"
		},
		budget: { runs: 50, steered: 48 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: "\t\t? a.contract === undefined && b.contract === undefined && samePlain(a, b)",
				replacement: "\t\t? a.contract !== b.contract",
				why: "Operator mutant (comparison) at packages/engine/src/ir/scalar.ts:835 in sameContract: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * ScalarTypeOf builds each type from its content gives each Description its own content, frozen, canonically equal to
 * an equal content's and apart from a different one's.
 *
 * Budget: its suite's count before the conversion (unit/scalar/content: 200 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const scalarTypeOfBuildsEachTypeFromItsContentGivesEachDescriptionItsOwnContentFrozenCanonicallyEqualToAnEqualContentsAndApartFromADifferentOnes =
	property.explore(contentCaseGen, {
		needs: {},
		situations: contentFeatures satisfies ReadonlyArray<Reached<ContentFeature>>,
		check:
			(_, c: Case<ContentFeature>) =>
			([envs, descs]) =>
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
							const same = canonicalEquals(x.content, y.content)
							c.note(same ? "equal contents" : "different contents")
							assert.equal(
								canonicalEquals(x.type, y.type),
								same,
								`${x.at} and ${y.at}: canonically equal exactly when their contents are`
							)
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the readings' contents, compared apart from their text"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: '\tif (root !== undefined && baseOf(root.type).carrier !== "bool") {',
				replacement: '\tif (root !== undefined && baseOf(root.type).carrier === "bool") {',
				why: "Operator mutant (comparison) at packages/engine/src/ir/expr.ts:1239 in predicateProblems: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * LiteralDescFor: literal operands adopt the base's host type returns the literal each carrier's host kind states, and
 * refuses every other value by its fault, never throwing.
 *
 * Budget: its suite's count before the conversion (unit/scalar/literal-desc: 3000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const literalDescForLiteralOperandsAdoptTheBasesHostTypeReturnsTheLiteralEachCarriersHostKindStatesAndRefusesEveryOtherValueByItsFaultNeverThrowing =
	property.explore(literalOperandSpace, {
		needs: {},
		situations: [
			...Arr.flatMap(literalCases, (c): Arr.NonEmptyReadonlyArray<LiteralFeature> => [
				`${c.carrier} literal`,
				`${c.carrier} refused`
			]),
			...Arr.map(WILD_KINDS, (kind): LiteralFeature => `wild ${kind}`),
			"vector snapshot at build",
			"a negative zero"
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check:
			(_, c: Case<LiteralFeature>) =>
			([carrier, d]) =>
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
							c.note("a negative zero")
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
				}),
		oracle: { kind: "specification", name: "each carrier's host kind, judged per carrier" },
		budget: { runs: 3000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/literal.ts",
				original: "\t\t\tif (value === Number.NEGATIVE_INFINITY) {",
				replacement: "\t\t\tif (value !== Number.NEGATIVE_INFINITY) {",
				why: "Operator mutant (comparison) at packages/engine/src/scalar/literal.ts:68 in hostLiteral: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * DescribeField reads every descriptor a builder made, numeric among them, and a written field as the descriptor its
 * values are of, a place as natural, and refuses a look-alike and every wild value as malformed, at describeField, span
 * and closedId.
 *
 * Budget: its suite's count before the conversion (unit/scalar/describe-field: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const describeFieldReadsEveryDescriptorABuilderMadeAndAWrittenFieldAsItsValueTypeAndRefusesALookAlikeAndEveryWildValueAsMalformedAtDescribeFieldSpanAndClosedId =
	property.explore(boundarySpace, {
		needs: {},
		situations: [
			"live",
			"a written field, read as its value type",
			"stale look-alike",
			...Arr.map(WILD_KINDS, (kind): DescribeFeature => `wild ${kind}`),
			"boundary describeField",
			"boundary span",
			"boundary closedId"
		] satisfies ReadonlyArray<Reached<DescribeFeature>>,
		check:
			(_, c: Case<DescribeFeature>) =>
			([d, boundary]) =>
				Effect.sync(() => {
					c.note(drawnFeature(d))
					c.note(`boundary ${boundary}`)
					if (d.kind === "live" && isWrittenField(d.value)) {
						c.note("a written field, read as its value type")
					}
					const x = passed(d)
					switch (boundary) {
						case "describeField": {
							const result = describeField(x, SourceLoc("a drawn descriptor", []))
							if (d.kind === "live") {
								assert.deepEqual(
									succeeded(result).desc,
									succeeded(
										describeField(valueDescriptor(d.value), SourceLoc("its value type", []))
									).desc,
									"a descriptor is read as the descriptor its values are of"
								)
								return
							}
							refused(result, "MalformedDescription")
							return
						}
						case "span":
							if (d.kind !== "live") {
								throwsRefused(() => spanDescriptor(x), "MalformedDescription")
							} else if (endpoints.includes(valueDescriptor(d.value))) {
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
										roster: Kind.name,
										only: undefined
									}
								)
							} else {
								throwsRefused(() => admittedClosedId(x), "MalformedDescription")
							}
							return
					}
				}),
		oracle: {
			kind: "specification",
			name: "a descriptor a builder made, against every look-alike and wild value"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original:
					"\treturn written === undefined ? ownedText.get(value)?.described : registeredField(written)\n",
				replacement: "\treturn ownedText.get(value)?.described\n",
				why: "A field of a writing of its own is no descriptor, the old refusal: a place passed where a descriptor is asked, edullm's param over ItemSession's place, is refused rather than read as natural, and the live written-field case fails."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t\treturn Result.err(malformedDescription(loc, "a field descriptor"))',
				replacement: '\t\tthrow malformedDescription(loc, "a field descriptor")',
				why: "describeField throws at a value that is no record instead of refusing it; the describeField admission property fails."
			}
		]
	})
