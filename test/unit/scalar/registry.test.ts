/**
 * The scalar registry (scalar/registry.ts): capabilities, the ScalarType of a FieldDesc under every environment, a
 * reading's content, literal operands and describeField's admission.
 *
 * - Capabilities: every descriptor's are its carrier's, a serial's and a contract's their base's. Oracle: the carrier's
 *   capability set, which the catalog suite holds to PostgreSQL's.
 * - Fixtures: every ScalarType another suite's fixture exports is the registry's own build of its FieldDesc. Oracle: the
 *   registry's build, a second implementation of each hand-built fixture type.
 * - Kinds and environments: scalarTypeOf of a descriptor's Description agrees with the descriptor's own ScalarType;
 *   a closedId's roster resolves through the environment, an unknown one refused; a text's metadata is read off the
 *   language its Description carries; a contract's predicate table comes from the environment. Oracles: the
 *   descriptor's own type; the drawn roster; the patterns' carried text; the checker's predicate table.
 * - Content: two readings are canonically equal exactly when their contents are, under any environments. Oracle: the
 *   readings' contents compared apart.
 * - Literal operands: each carrier's literal is the one its host kind states, and every other value is refused by its
 *   fault, never thrown.
 * - describeField reads every descriptor a builder made, and refuses a look-alike, the undeclared numeric builder and
 *   every wild value as malformed, at describeField, span and closedId, never throwing.
 *
 * Features: as each search names them; for the roster environment, a roster resolved and an unknown roster refused;
 * for text, each language kind; for the predicate table, a bound below, at and above zero.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { drawnFeature, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import {
	type Carrier,
	carriers,
	contractOf,
	Roster,
	rosterOf,
	sameScalarType,
	spanOf,
	type TextLanguage,
	textOf
} from "#compiler/ir/scalar.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
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
import {
	assert,
	defined,
	faulted,
	nonEmpty,
	refused,
	succeeded,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import { contractDescriptor, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { fixtureTypes } from "#test/unit/scalar/registry.dictionary.ts"
import {
	boundarySpace,
	caps,
	carriedText,
	type ContentFeature,
	contentCaseGen,
	contentFeatures,
	contentOf,
	type DescribeFeature,
	describes,
	endpoints,
	Kind,
	type LiteralFeature,
	literalCases,
	literalOperandSpace,
	predicateCaseGen,
	predicateTable,
	registryBuild,
	rosterCaseGen,
	rostersOfSketch,
	scalarOf,
	someFault,
	textCaseGen
} from "#test/unit/scalar/registry.fixtures.ts"
import {
	type DescriptorSketch,
	descriptorGen,
	descriptorOf,
	isSerial
} from "#test/unit/scalar/support.ts"

/** The capability registry gives every descriptor its carrier's capabilities, a serial and a contract their base's. */
export const theCapabilityRegistryGivesEveryDescriptorItsCarriersCapabilitiesASerialAndAContractTheirBases =
	property.explore(descriptorGen(2), {
		needs: {},
		situations: ["a serial", "a contract", "a vector"] satisfies ReadonlyArray<
			Reached<"a serial" | "a contract" | "a vector">
		>,
		check: (_, c: Case<"a serial" | "a contract" | "a vector">) => (sketch) =>
			Effect.sync(() => {
				const field = descriptorOf(sketch)
				const scalar = succeeded(describeField(field, SourceLoc("test", []))).scalar
				unorderedEqual(caps(field), capabilitiesOf(scalar.carrier))
				if (sketch.kind === "contract") {
					c.note("a contract")
					unorderedEqual(caps(field), caps(descriptorOf(sketch.base)))
				}
				if (sketch.kind === "spelling" && isSerial(sketch.name)) {
					c.note("a serial")
				}
				if (scalar.carrier === "vector") {
					c.note("a vector")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a type's capabilities are its carrier's, which the catalog suite holds to PostgreSQL's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t\t\t\t\tcaps: capabilitiesOf("code"),',
				replacement: '\t\t\t\t\tcaps: capabilitiesOf("bits"),',
				why: "A closed id's ScalarType takes the bits carrier's capabilities; the capabilities property fails."
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
		kills: []
	})

/** ScalarTypeOf: a FieldDesc to its ScalarType reads every descriptor kind, and agrees with the descriptor's own ScalarType. */
export const scalarTypeOfAFieldDescToItsScalarTypeReadsEveryDescriptorKindAndAgreesWithTheDescriptorsOwnScalarType =
	property.explore(descriptorGen(2), {
		needs: {},
		situations: [
			"spelling",
			"float",
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
						const handles = rosters.get(name)
						return handles === undefined ? undefined : Roster.of(name, handles)
					}
				}
				assert.deepEqual(succeeded(scalarTypeOf(desc, env, SourceLoc("field", []))), scalar)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the descriptor's own ScalarType, against scalarTypeOf of its Description"
		},
		kept: [],
		kills: []
	})

/** ScalarTypeOf: a FieldDesc to its ScalarType resolves a closedId roster through the environment, and refuses an unknown one. */
export const scalarTypeOfAFieldDescToItsScalarTypeResolvesAClosedIdRosterThroughTheEnvironmentAndRefusesAnUnknownOne =
	property.explore(rosterCaseGen, {
		needs: {},
		situations: ["a roster resolved", "an unknown roster refused"] satisfies ReadonlyArray<
			Reached<"a roster resolved" | "an unknown roster refused">
		>,
		check:
			(_, c: Case<"a roster resolved" | "an unknown roster refused">) =>
			({ name, other, handles }) =>
				Effect.sync(() => {
					c.note("a roster resolved")
					const listed = nonEmpty(handles, "a drawn roster of at least one handle")
					const held = Roster.of(parsedName(name), listed)
					const env = {
						kind: "builder",
						roster: (n: string) => (n === name ? Roster.of(parsedName(n), listed) : undefined)
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
						c.note("an unknown roster refused")
						refused(
							scalarTypeOf({ kind: "closedId", roster: other }, env, SourceLoc("field", [])),
							"MalformedDescription"
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the drawn roster, under its declared name alone"
		},
		kept: [],
		kills: []
	})

/** ScalarTypeOf: a FieldDesc to its ScalarType reads a pattern's metadata off the language its Description carries, under every environment. */
export const scalarTypeOfAFieldDescToItsScalarTypeReadsAPatternsMetadataOffTheLanguageItsDescriptionCarriesUnderEveryEnvironment =
	property.explore(textCaseGen, {
		needs: {},
		situations: ["language every", "language refined"] satisfies ReadonlyArray<
			Reached<`language ${TextLanguage["kind"]}`>
		>,
		check:
			(_, c: Case<`language ${TextLanguage["kind"]}`>) =>
			({ patterns, language, env }) =>
				Effect.sync(() => {
					c.note(`language ${language.kind}`)
					const typed = succeeded(
						scalarTypeOf(
							{ kind: "text", patterns, bytes: undefined, language },
							env,
							SourceLoc("field", [])
						)
					)
					assert.deepEqual(textOf(typed), carriedText(patterns, language))
				}),
		oracle: {
			kind: "specification",
			name: "the text the patterns and their language carry (carriedText)"
		},
		kept: [],
		kills: []
	})

/** ScalarTypeOf: a FieldDesc to its ScalarType takes the checker's predicate table from the environment. */
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
								contractPredicate: predicateTable
							},
							SourceLoc("field", [])
						)
					)
					assert.deepEqual(contractOf(typed)?.predicate, table)
					assert.deepEqual(succeeded(decodeScalarType(structuredClone(typed))), typed)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the checker's predicate table over the base"
		},
		kept: [],
		kills: []
	})

/** ScalarTypeOf builds each type from its content gives each Description its own content, frozen, canonically equal to an equal content's and apart from a different one's. */
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
							const same = canonicalEquals(x.content, y.content, everyProperty)
							c.note(same ? "equal contents" : "different contents")
							assert.equal(
								canonicalEquals(x.type, y.type, everyProperty),
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
		kept: [],
		kills: []
	})

/** LiteralDescFor: literal operands adopt the base's host type returns the literal each carrier's host kind states, and refuses every other value by its fault, never throwing. */
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
			"negative zero normalized"
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
				}),
		oracle: { kind: "specification", name: "each carrier's host kind, judged per carrier" },
		kept: [],
		kills: []
	})

/** DescribeField reads every descriptor a builder made, and refuses a look-alike, the undeclared numeric builder and every wild value as malformed, at describeField, span and closedId. */
export const describeFieldReadsEveryDescriptorABuilderMadeAndRefusesALookAlikeTheUndeclaredNumericBuilderAndEveryWildValueAsMalformedAtDescribeFieldSpanAndClosedId =
	property.explore(boundarySpace, {
		needs: {},
		situations: [
			"live",
			"stale look-alike",
			"stale numeric builder",
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
				}),
		oracle: {
			kind: "specification",
			name: "a descriptor a builder made, against every look-alike and wild value"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t\treturn Result.err(malformedDescription(loc, "a field descriptor"))',
				replacement: '\t\tthrow malformedDescription(loc, "a field descriptor")',
				why: "describeField throws at a value that is no record instead of refusing it; the describeField admission property fails."
			}
		]
	})
