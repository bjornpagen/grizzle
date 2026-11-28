/**
 * Scalar types and their literal and payload grammars (ir/scalar.ts, ir/scalar-shape.ts, ir/expr.ts, ir/carriers.ts,
 * ir/decimal.ts).
 *
 * - Types: every generated type decodes as itself, and a corruption of one, stale or wild, is refused within the type
 *   it breaks. Oracle: universal, decode ∘ build = id, and each rule's refusal under the type's label.
 * - Literals: each type admits exactly the literals it holds, a contract's by its base, and numeric(p, s) exactly the
 *   values it stores unchanged. Oracle: each literal domain restated as a checker.
 * - Contract predicates: any allocation of a predicate normalizes to the one table numbered from the root, and every
 *   predicate broken at one rule is refused. Oracle: the normal form and each rule a table keeps.
 * - Payloads: the IR's money, vector and decimal payload grammars agree with the carriers that write and revive them.
 *   Oracle: the carriers as second implementations.
 *
 * Features: live and every corruption; each literal kind admitted and refused, under a contract; each numeric
 * situation; an allocation normalized and each broken rule; negative and unsigned counts, payloads and non-payloads,
 * one and several components, special values.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import {
	aimed,
	array,
	codePoint,
	element,
	finite,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { corrupted, type CorruptedFeature, corruptedFeature } from "@bjornpagen/testing/lsw"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { bigint, float } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, String as Str } from "effect"
import { canonicalTag, encode, everyProperty } from "#compiler/core/canonical.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { isMoneyPayload, isVectorPayload, MoneyText, VectorText } from "#compiler/ir/carriers.ts"
import { DecimalText, isDecimalLike, isDecimalPayload } from "#compiler/ir/decimal.ts"
import { predicateProblems } from "#compiler/ir/expr.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { compareDecimal, Numeric, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { placeOf, refusalLoc, succeeded } from "#test/support/assert.ts"
import { normalizeExprTable } from "#test/support/fixtures/ir/scalar.ts"
import { fail, scalarTypes } from "#test/support/unit/ir/fixture.ts"
import { scalarTypeGen } from "#test/support/unit/ir/types.ts"
import {
	admits,
	admittedAims,
	allocated,
	at,
	broken,
	check,
	contractOver,
	decimal,
	floatMax,
	literalCaseGen,
	type LiteralFeature,
	nonNegative,
	numeric,
	type PredicateCase,
	type PredicateFeature,
	scalarCorruptions,
	type ScalarRule,
	special,
	spellings,
	texts,
	type TypmodCase,
	type TypmodFeature,
	typmodBoundary
} from "#test/unit/ir/scalar.fixtures.ts"

/**
 * ScalarType decodes every generated type as itself, and refuses each corruption of one at the type it breaks.
 *
 * Budget: 500 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:233 at 8cad5bce, its runs and its coverage's cases).
 */
export const scalarTypeDecodesEveryGeneratedTypeAsItselfAndRefusesEachCorruptionOfOneAtTheTypeItBreaks =
	property.explore(
		(source) => source.draw(corrupted(source.draw(scalarTypeGen), scalarCorruptions)),
		{
			needs: {},
			budget: { runs: 500, steered: 2000 },
			situations: [
				"live",
				...Arr.map(scalarCorruptions, (c): CorruptedFeature<ScalarRule> => `${c.from} ${c.rule}`)
			] satisfies ReadonlyArray<Reached<CorruptedFeature<ScalarRule>>>,
			check: (_, n: Case<CorruptedFeature<ScalarRule>>) => (c) =>
				Effect.sync(() => {
					n.note(corruptedFeature(c))
					const decoded = decodeScalarType(c.value)
					if (c.kind === "live") {
						assert.deepEqual(succeeded(decoded), c.value)
						return
					}
					const error = fail(decoded)
					assert.equal(error.reason._tag, "MalformedDescription", `${c.rule} at ${c.at}`)
					assert.equal(
						placeOf(refusalLoc(error)).label,
						c.refusal,
						`${c.rule} at ${c.at}: located within the type it breaks`
					)
				}),
			oracle: {
				kind: "universal",
				name: "decode ∘ build = id, and each rule's refusal at the type"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/scalar-shape.ts",
					original: "\tif (typmod.dims > vectorMaxDimensions) {",
					replacement: "\tif (typmod.dims > vectorMaxDimensions + 1) {",
					why: "A vector type one dimension past vectorMaxDimensions decodes; the types property fails."
				}
			]
		}
	)

/**
 * Literals admits exactly the literals each type holds, a contract's by its base.
 *
 * Budget: 3000 runs and 3000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:490 at 8cad5bce, its runs and its coverage's cases).
 */
export const literalsAdmitsExactlyTheLiteralsEachTypeHoldsAContractsByItsBase = property.explore(
	aimed(literalCaseGen, admittedAims),
	{
		needs: {},
		budget: { runs: 3000, steered: 3000 },
		situations: [
			"under a contract",
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
					"handle",
					"handles",
					"span",
					"vector"
				] as const,
				(kind): ReadonlyArray<LiteralFeature> => [`${kind} admitted`, `${kind} refused`]
			)
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check:
			(_, c: Case<LiteralFeature>) =>
			([literal, type]) =>
				Effect.sync(() => {
					const want = admits(literal, type)
					c.note(`${literal.kind} ${want ? "admitted" : "refused"}`)
					if (type.contract !== undefined) {
						c.note("under a contract")
					}
					assert.equal(
						check(literal, type) === undefined,
						want,
						`${literal.kind} at ${type.carrier}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "each type's literal domain as a checker, a contract's its base's"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/ir/scalar.test.ts#literalsAdmitsExactlyTheLiteralsEachTypeHoldsAContractsByItsBase:-:b.0.0.1.0.3.0.3.f"
				),
				reason: "a vector of three components at vector(3)",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/ir/scalar.test.ts#literalsAdmitsExactlyTheLiteralsEachTypeHoldsAContractsByItsBase:-:6.0.2.9"
				),
				reason: "storable text at text",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/ir/scalar.test.ts#literalsAdmitsExactlyTheLiteralsEachTypeHoldsAContractsByItsBase:-:7.0.1.8.9.a.7.f.2.3.c.4.d.4.e.5.f.8.a.9.b.0.c.1.d.2.e.3.f.4.a.5.b.0.a"
				),
				reason: "a lowercase uuid at uuid",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/ir/scalar.test.ts#literalsAdmitsExactlyTheLiteralsEachTypeHoldsAContractsByItsBase:-:a.1.2.5.d"
				),
				reason: "a span of int4 endpoints at a span over integer",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: '\t\t\tif (carrier === "float8") {',
				replacement: '\t\t\tif (carrier === "float8" || carrier === "float4") {',
				why: "A float literal of a float4 type is admitted whether or not it is a float32 value; the literals property fails."
			}
		]
	}
)

/**
 * Literals numeric literals under a typmod admits exactly the values numeric(p, s) stores unchanged.
 *
 * Budget: 2000 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:596 at 8cad5bce, its runs and its coverage's cases).
 */
export const literalsNumericLiteralsUnderATypmodAdmitsExactlyTheValuesNumericPSStoresUnchanged =
	property.explore(
		weighted<TypmodCase>([
			[
				5,
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
			],
			[1, typmodBoundary]
		]),
		{
			needs: {},
			budget: { runs: 2000, steered: 2000 },
			situations: [
				"an infinity refused",
				"NaN admitted",
				"a negative scale",
				"a scale above the precision",
				"an overflow refused",
				"a rounding refused",
				"a value admitted"
			] satisfies ReadonlyArray<Reached<TypmodFeature>>,
			check:
				(_, c: Case<TypmodFeature>) =>
				([text, precision, scale]) =>
					Effect.sync(() => {
						const d = Numeric.of(text)
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
					}),
			oracle: {
				kind: "specification",
				name: "numeric(p, s) stores a value unchanged exactly when it needs no rounding at s and fits p digits"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/expr.ts",
					original: "\t\t\treturn units >= 10n ** BigInt(precision)",
					replacement: "\t\t\treturn units > 10n ** BigInt(precision)",
					why: "A numeric literal of exactly 10^p units at numeric(p, s) is admitted; the literals property fails."
				}
			]
		}
	)

/** Contract predicates normalizes any allocation to the one table numbered from the root, and refuses every predicate that breaks a rule. */
export const contractPredicatesNormalizesAnyAllocationToTheOneTableNumberedFromTheRootAndRefusesEveryPredicateThatBreaksARule =
	property.exhaust(
		finite(
			oneOf<PredicateCase>([
				map(spellings, (ids): PredicateCase => ({ kind: "allocated", ids })),
				map(element(broken), ([rule, table]): PredicateCase => ({
					kind: "broken",
					rule,
					table
				}))
			])
		),
		{
			needs: {},
			situations: [
				"an allocation normalized",
				...Arr.map(broken, ([rule]): PredicateFeature => `broken: ${rule}`)
			] satisfies ReadonlyArray<Reached<PredicateFeature>>,
			check: (_, n: Case<PredicateFeature>) => (c) =>
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
						assert.equal(decoded.contract?.predicate?.root, ExprId("e#0"))
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
				}),
			oracle: {
				kind: "specification",
				name: "the normal form numbered from the root, and each rule a predicate table keeps"
			},
			box: "every spelling of the predicate's three entries by distinct identifiers of the pool, and every predicate broken at one rule",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/expr.ts",
					original: `\tfor (const id of dangling) {\n\t\tif (id !== table.root) {\n\t\t\tproblems.push(\`an argument named \${id} in the predicate table\`)\n\t\t}\n\t}\n`,
					replacement: "",
					why: "A contract predicate naming an argument its table lacks is admitted; the contract predicates property fails."
				}
			]
		}
	)

/**
 * Money and vector values agree with the owned Money carrier.
 *
 * Budget: 500 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:902 at 8cad5bce, its runs and its coverage's cases).
 */
export const moneyAndVectorValuesAgreeWithTheOwnedMoneyCarrier = property.explore(
	bigint(-(2n ** 63n), 2n ** 63n - 1n),
	{
		needs: {},
		budget: { runs: 500, steered: 100 },
		situations: ["a negative count", "a count of no sign"] satisfies ReadonlyArray<
			Reached<"a negative count" | "a count of no sign">
		>,
		check: (_, c: Case<"a negative count" | "a count of no sign">) => (units) =>
			Effect.sync(() => {
				c.note(units < 0n ? "a negative count" : "a count of no sign")
				const payload = Money.of(units)[canonicalTag]().payload
				assert.equal(isMoneyPayload(payload), true)
				assert.equal(defined(MoneyText.parse(payload))[canonicalTag]().payload, payload)
				assert.equal<string>(
					succeeded(encode({ m: defined(MoneyText.parse(String(units))) }, everyProperty)),
					`{"m":"~m:${payload}"}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the IR's money payload grammar beside the Money carrier that wrote it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: `if (typeof part === "string") {\n\t\treturn \`\${part.length}:\${part}\`\n\t}`,
				replacement: "{}",
				why: `Operator mutant 796b83318f at packages/engine/src/core/identity.ts:173 in encodePart: \`if (typeof part === "string") {   return \`\${part.length}:\${part}\`  }\` becomes \`{}\`; the property fails (the census, lane TESTPOLICY2).`
			}
		]
	}
)

/**
 * Money and vector values agree with the owned Money carrier's reviver.
 *
 * Budget: 1000 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:902 at 8cad5bce, its runs and its coverage's cases).
 */
export const moneyAndVectorValuesAgreeWithTheOwnedMoneyCarriersReviver = property.explore(
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
		map(bigint(-(10n ** 17n), 10n ** 17n), (units) =>
			units < 0n ? `-0${String(-units)}` : `0${String(units)}`
		),
		string(codePoint(0x20, 0x7e), { min: 0, max: 22 })
	]),
	{
		needs: {},
		budget: { runs: 1000, steered: 200 },
		situations: ["a payload", "no payload"] satisfies ReadonlyArray<
			Reached<"a payload" | "no payload">
		>,
		check: (_, c: Case<"a payload" | "no payload">) => (text) =>
			Effect.sync(() => {
				const payload = isMoneyPayload(text)
				c.note(payload ? "a payload" : "no payload")
				assert.equal(payload, Money.fromCanonical(text).ok, text)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the IR's money payload grammar (isMoneyPayload) beside the reviver (Money.fromCanonical)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/carriers.ts",
				original:
					'\tif (digits.length > 1 && digits.startsWith("0")) {\n\t\treturn undefined\n\t}\n',
				replacement: "",
				why: "A money payload with a leading zero is admitted; the payloads property fails."
			}
		]
	}
)

/**
 * Money and vector values agree with the Vector carrier.
 *
 * Budget: 500 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:989 at 8cad5bce, its runs and its coverage's cases).
 */
export const moneyAndVectorValuesAgreeWithTheVectorCarrier = property.explore(
	array(float(-floatMax, floatMax), { min: 1, max: 8 }),
	{
		needs: {},
		budget: { runs: 500, steered: 100 },
		situations: ["one component", "several components"] satisfies ReadonlyArray<
			Reached<"one component" | "several components">
		>,
		check: (_, c: Case<"one component" | "several components">) => (components) =>
			Effect.sync(() => {
				c.note(components.length === 1 ? "one component" : "several components")
				const vector = Vector.make(Float32Array.from(components), components.length)
				const payload = succeeded(Vector.canonical(vector))[canonicalTag]().payload
				assert.equal(isVectorPayload(payload), true, payload)
				assert.equal(payload, Vector.componentText(vector))
				assert.equal(defined(VectorText.parse(payload))[canonicalTag]().payload, payload)
				assert.equal(succeeded(VectorText.of(vector))[canonicalTag]().payload, payload)
				assert.equal<string>(
					succeeded(encode({ v: succeeded(VectorText.of(vector)) }, everyProperty)),
					`{"v":"~v:${payload}"}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the IR's vector text (VectorText) beside the Vector carrier's canonical form and component text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/carriers.ts",
				original: `\t\treturn \`[\${this.components.map(String).join(",")}]\``,
				replacement: `\t\treturn \`[\${this.components.map(String).join(", ")}]\``,
				why: "A vector's text is written with a space after each comma; the payloads property fails."
			}
		]
	}
)

/**
 * Decimals admit only the canonical numeric_out text and the special values, and keep and carry it byte for byte.
 *
 * Budget: 2000 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/scalar.test.ts:1031 at 8cad5bce, its runs and its coverage's cases).
 */
export const decimalsAdmitOnlyTheCanonicalNumericOutTextAndTheSpecialValuesAndKeepAndCarryItByteForByte =
	property.explore(texts, {
		needs: {},
		budget: { runs: 2000, steered: 2000 },
		situations: ["a payload", "a special value", "no payload"] satisfies ReadonlyArray<
			Reached<"a payload" | "a special value" | "no payload">
		>,
		check: (_, c: Case<"a payload" | "a special value" | "no payload">) => (text) =>
			Effect.sync(() => {
				assert.equal(isDecimalPayload(text), Numeric.fromCanonical(text).ok, text)
				const d = DecimalText.parse(text)
				if (d === undefined) {
					c.note("no payload")
					return
				}
				c.note(text === "NaN" || Str.endsWith("Infinity")(text) ? "a special value" : "a payload")
				assert.equal(d[canonicalTag]().payload, text)
				assert.equal(isDecimalLike(d), true)
				assert.equal<string>(succeeded(encode({ d }, everyProperty)), `{"d":"~d:${text}"}`)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the IR's decimal payload grammar (isDecimalPayload) beside the reviver (Numeric.fromCanonical)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/decimal.ts",
				original: '\t\t\tif (i === fracStart || text[i - 1] === "0") {',
				replacement: "\t\t\tif (i === fracStart) {",
				why: "A decimal payload with a trailing fractional zero is admitted; the payloads property fails."
			}
		]
	})
