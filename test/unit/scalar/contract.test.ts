/**
 * A contract over a base drawn from the descriptor kinds a contract takes, with a predicate that bounds the value or
 * none: a domain over its base (the base's SQL type, carrier, typmod and capabilities),
 * exposing the caller's base descriptor itself, a frozen descriptor that makes no value, one identity per equal
 * declaration and distinct by name, its type compatible across a predicate change; a base of the serial family is
 * refused before the predicate runs, as grizzle mints no ids, and a callback that builds no predicate is malformed.
 *
 * Admission: contract()(name, base) builds exactly from no value at its first call, a declared name, a descriptor and no
 * argument past the predicate,
 * over Live names near the rule's edges and Wild names and bases of every kind (@bjornpagen/testing/lsw); everything else
 * is MalformedDescription.
 *
 * Oracles: the base's own description, for what a domain keeps of it; the field identity text, for one identity per
 * declaration; the declared-name rule (parseDeclaredName), for admission.
 *
 * Features: each base with and without a predicate, a minted base refused, no predicate built; a live contract, a string
 * name the rule refuses, every wild kind as name and as base, an extra argument.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, constant, element, int, weighted } from "@bjornpagen/testing/gen"
import { passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect } from "effect"
import { clockParams } from "#compiler/check/clock.ts"
import { admitHostKey, hostMintOf } from "#compiler/core/brand.ts"
import { columnForm } from "#compiler/core/decoder.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import { capsOf, numericTypmodOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { mintedRefusal } from "#compiler/scalar/minted.ts"
import { minted } from "#compiler/scalar/minted.ts"
import { int8 } from "#compiler/scalar/pg.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	admitContract,
	contractCall,
	contractDescriptor,
	fieldIdentity
} from "#test/support/fixtures/descriptors.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type AdmissionFeature,
	admissionSpace,
	clockBinds,
	clockedMade,
	clockKeysVerdict,
	type HeldFeature,
	heldKeys,
	heldSpace,
	heldTarget,
	heldTargets,
	type KeyCase,
	type KeyFeature,
	keySpace,
	type MintFeature,
	mintMade,
	mintPositions,
	mintSpace,
	mintTargetsOf,
	mintsVerdict,
	mintVerdictOf,
	resultFunction,
	resultShapes,
	baseNames,
	baseOfName,
	type IdentityFeature,
	isDeclaredName,
	predicateFor
} from "#test/unit/scalar/contract.fixtures.ts"

/**
 * Contract identity is a domain over its base and its own brand, one identity per equal declaration, distinct by name.
 *
 * Budget: its suite's count before the conversion (unit/scalar/contract-identity: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const contractIdentityIsADomainOverItsBaseAndItsOwnBrandOneIdentityPerEqualDeclarationDistinctByName =
	property.explore(
		(source) => ({
			kind: source.draw(
				weighted<"declaration" | "minted" | "no predicate">([
					[2, constant("declaration")],
					[1, constant("minted")],
					[1, constant("no predicate")]
				])
			),
			base: source.draw(element(baseNames)),
			precision: source.draw(int(2, 30)),
			name: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
			other: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
			withPredicate: source.draw(boolean)
		}),
		{
			needs: {},
			/** A predicate is built over the integer-like bases, whose value a comparison reads. */
			situations: [
				...Arr.map(baseNames, (b): IdentityFeature => `${b} without a predicate`),
				"integer with a predicate",
				"bigint with a predicate",
				"a minted base refused",
				"no predicate built"
			] satisfies ReadonlyArray<Reached<IdentityFeature>>,
			check:
				(_, c: Case<IdentityFeature>) =>
				({ kind, base: baseName, precision, name, other, withPredicate }) =>
					Effect.sync(() => {
						if (kind === "minted") {
							c.note("a minted base refused")
							let ran = false
							/**
							 * A spelling of the serial family is no descriptor, so a contract over it is refused by the model's own
							 * rule, as the field is, before its predicate runs.
							 */
							const refusals = [
								throwsRefused(
									() =>
										contractDescriptor(name, minted, (v: ScalarTerm) => {
											ran = true
											return computeCore.ge(v, 0)
										}),
									"Refused"
								),
								throwsRefused(() => contractDescriptor(name, minted), "Refused")
							] as const
							assert.equal(ran, false)
							const mintedRule: Refused = mintedRefusal
							for (const thrown of refusals) {
								assert.equal(
									thrown.reason._tag === "Refused" ? thrown.reason.refusal : undefined,
									mintedRule
								)
							}
							return
						}
						if (kind === "no predicate") {
							c.note("no predicate built")
							throwsRefused(
								() => contractDescriptor(name, int8, () => true),
								"MalformedDescription"
							)
							throwsRefused(
								() => contractDescriptor(name, int8, (v: ScalarTerm) => v),
								"MalformedDescription"
							)
							throwsRefused(() => admitContract(name, int8, [5]), "MalformedDescription")
							return
						}
						const base = baseOfName(baseName, precision)
						const predicate = predicateFor(baseName, withPredicate)
						c.note(`${baseName} ${predicate === undefined ? "without" : "with"} a predicate`)
						const make = (n: string) =>
							predicate === undefined
								? admitContract(n, base, [])
								: admitContract(n, base, [predicate])
						const declared = make(name)
						const described = succeeded(describeField(base, SourceLoc("base", [])))
						assert.equal(declared.sql, described.sql)
						assert.equal(declared.name, name)
						assert.ok(declared.base === base, "the caller's base descriptor itself")
						const { scalar } = succeeded(describeField(declared, SourceLoc(name, [])))
						assert.equal(scalar.carrier, described.scalar.carrier)
						assert.deepEqual(numericTypmodOf(scalar), numericTypmodOf(described.scalar))
						assert.deepEqual(capsOf(scalar), capsOf(described.scalar))
						const info = defined(scalar.contract, "the contract")
						assert.equal<string>(info.name, name)
						assert.ok(sameScalarType(info.base, described.scalar))
						assert.ok(Object.isFrozen(declared))
						assert.deepEqual(
							columnForm(declared.column),
							columnForm(described.column),
							"a contract's column reads a cell as its base's does, its host type a claim with no runtime form"
						)
						/** Equal declarations are one identity; another name is another contract, over one base or not. */
						const again = make(name)
						assert.equal(succeeded(fieldIdentity(declared)), succeeded(fieldIdentity(again)))
						assert.notEqual(succeeded(fieldIdentity(declared)), succeeded(fieldIdentity(base)))
						if (other !== name) {
							const renamed = make(other)
							assert.notEqual(succeeded(fieldIdentity(declared)), succeeded(fieldIdentity(renamed)))
							assert.equal(
								sameScalarType(
									scalar,
									succeeded(describeField(renamed, SourceLoc(other, []))).scalar
								),
								false
							)
						}
						if (predicate !== undefined) {
							const unpredicated = admitContract(name, base, [])
							assert.notEqual(
								succeeded(fieldIdentity(declared)),
								succeeded(fieldIdentity(unpredicated))
							)
							assert.ok(
								sameScalarType(
									scalar,
									succeeded(describeField(unpredicated, SourceLoc(name, []))).scalar
								)
							)
						}
					}),
			oracle: {
				kind: "specification",
				name: "the base's own description, and the field identity text of each declaration"
			},
			budget: { runs: 300, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/decoder.ts",
					original:
						'\tconst claim = nominal<A, H>()\n\tswitch (base.kind) {\n\t\tcase "convert":\n\t\t\treturn convertColumn(base.conversion)',
					replacement:
						'\tconst claim = nominal<A, H>()\n\tswitch (base.kind) {\n\t\tcase "convert":\n\t\t\treturn convertColumn({ carrier: "text" })',
					why: "A contract's converted column reads its cell as text, so a read of a contract over an integer, a numeric or money delivers its text, never its base's value; its column is no longer its base's and the property fails."
				},
				{
					file: "packages/engine/src/core/decoder.ts",
					original:
						'\t\tcase "text":\n\t\t\treturn Object.freeze({ ...builtMark, kind: "text" })\n\t\tcase "constant":\n\t\t\treturn constants(\n\t\t\t\tmapNonEmpty(base.values, (value) => claim(value)),',
					replacement:
						'\t\tcase "text":\n\t\t\treturn convertColumn({ carrier: "int4" })\n\t\tcase "constant":\n\t\t\treturn constants(\n\t\t\t\tmapNonEmpty(base.values, (value) => claim(value)),',
					why: "A contract over a pattern's text reads its cell as an integer, so a read delivers no text it was written as; its column is no longer its base's and the property fails."
				},
				{
					file: "packages/engine/src/ir/scalar.ts",
					original: "\t\t\t\ta.span.width === b.span.width &&",
					replacement: "\t\t\t\ta.span.width !== b.span.width &&",
					why: "Operator mutant (comparison) at packages/engine/src/ir/scalar.ts:868 in sameSpan: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/**
 * Contract admission builds exactly from a declared name, a descriptor and no extra argument, and refuses the rest as
 * malformed.
 *
 * Budget: its suite's count before the conversion (unit/scalar/contract-admission: 1000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const contractAdmissionBuildsExactlyFromADeclaredNameADescriptorAndNoExtraArgumentAndRefusesTheRestAsMalformed =
	property.explore(admissionSpace, {
		needs: {},
		situations: [
			"live",
			"a string name the declared-name rule refuses",
			...Arr.flatMap(WILD_KINDS, (kind): ReadonlyArray<AdmissionFeature> => [
				`wild name ${kind}`,
				`wild base ${kind}`
			]),
			"extra argument",
			"a value at the first call"
		] satisfies ReadonlyArray<Reached<AdmissionFeature>>,
		check:
			(_, c: Case<AdmissionFeature>) =>
			({ first, name, base, extra }) =>
				Effect.sync(() => {
					if (first.length > 0) {
						c.note("a value at the first call")
						throwsRefused(() => contractCall(...argumentsOf(first)), "MalformedDescription")
					}
					/** The second call, past a first call that takes no value, judged whatever the first was given. */
					const second = contractCall()
					if (name.kind === "wild") {
						c.note(`wild name ${name.wild.kind}`)
					}
					if (base.kind === "wild") {
						c.note(`wild base ${base.wild.kind}`)
					}
					if (extra.length > 0) {
						c.note("extra argument")
					}
					const n = passed(name)
					const b = passed(base)
					if (isDeclaredName(n) && base.kind === "live" && extra.length === 0) {
						c.note("live")
						const built = second(n, b, undefined)
						assert.equal(built.name, n)
						assert.equal(b, built.base)
					} else {
						if (name.kind === "live" && base.kind === "live" && extra.length === 0) {
							c.note("a string name the declared-name rule refuses")
						}
						throwsRefused(
							() => second(n, b, undefined, ...argumentsOf(extra)),
							"MalformedDescription"
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the declared-name rule, and a descriptor a builder made"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/contract.ts",
				original: "\tif (first.length > 0) {",
				replacement: "\tif (first.length > 1) {",
				why: "A value at the first call, the spelling contract(name, base) of a contract that made its own values, is taken for no value, so the first call admits it and hands back the second; the admission property fails."
			},
			{
				file: "packages/engine/src/scalar/contract.ts",
				original: "\tif (declared === undefined) {",
				replacement: "\tif (!hasProperties(declared)) {",
				why: "An argument past the predicate that is no object is taken for no declaration, so a contract given one is admitted; the admission property fails."
			}
		]
	})

/** What a key case reaches: its kind, a wild one's by the kind of value. */
const keyFeatureOf = (k: KeyCase): KeyFeature => {
	switch (k.kind) {
		case "own":
			return "an own key"
		case "registered":
			return "a registered key"
		case "wild":
			return `a wild key ${k.wild.kind}`
	}
}

/** A key's value as the caller hands it: its own symbol, a registered one by its name, or the wild value itself. */
const keyOf = (k: KeyCase): unknown => {
	switch (k.kind) {
		case "own":
			return Symbol(k.name)
		case "registered":
			return Symbol.for(k.name)
		case "wild":
			return passed({ kind: "wild", wild: k.wild })
	}
}

/**
 * A mint takes only its module's own key: a symbol no registry holds is admitted and its mint returns every value as it
 * is; a registered symbol, which any module reads by its name, is refused by the rule the types name, and anything
 * else is no key.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aMintTakesOnlyItsModulesOwnKeyAndReturnsEveryValueAsItIs = property.explore(keySpace, {
	needs: {},
	situations: [
		"an own key",
		"a registered key",
		...Arr.map(WILD_KINDS, (kind): KeyFeature => `a wild key ${kind}`)
	] satisfies ReadonlyArray<Reached<KeyFeature>>,
	check: (_, c: Case<KeyFeature>) => (k: KeyCase) =>
		Effect.sync(() => {
			c.note(keyFeatureOf(k))
			const key = keyOf(k)
			if (typeof key === "symbol" && Symbol.keyFor(key) === undefined) {
				admitHostKey(key, "mintOf key")
				const probe = { key }
				assert.ok(hostMintOf(key)(probe) === probe, "a mint returns its value as it is")
				return
			}
			if (typeof key === "symbol") {
				const thrown = throwsRefused(() => admitHostKey(key, "mintOf key"), "Refused")
				const rule: Refused =
					"a host's key is a unique symbol: its module's own Symbol(name), never a registered one, which any module reads"
				assert.equal(thrown.reason._tag === "Refused" ? thrown.reason.refusal : undefined, rule)
				return
			}
			throwsRefused(() => admitHostKey(key, "mintOf key"), "MalformedDescription")
		}),
	oracle: {
		kind: "specification",
		name: "a key is a symbol of its module's own, which no registry holds"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/brand.ts",
			original: "\tif (Symbol.keyFor(key) !== undefined) {",
			replacement: '\tif (Symbol.keyFor(key) === "") {',
			why: "A registered symbol, which any module reads by its name, is admitted as a key, so any module mints the values of a contract over it; the property fails at a registered key."
		},
		{
			file: "packages/engine/src/core/brand.ts",
			original: '\tif (typeof key !== "symbol") {',
			replacement: '\tif (typeof key === "number") {',
			why: "A value that is no symbol, a string or an object, passes for a key, so a JavaScript caller's mint over it is made; the property fails at a wild key."
		}
	]
})

/** The rule a clock bound to a contract over another consumer's contract is refused by. */
const clockRule: Refused =
	"clocked binds only parameters of the program whose values are bigints: int8, natural, or one consumer's contract over either, under its key"

/** The rule a registered key is refused by, at mintOf and at every database-side mint. */
const hostKeyRule: Refused =
	"a host's key is a unique symbol: its module's own Symbol(name), never a registered one, which any module reads"

/**
 * A mint the database makes, a cast, a drawn field or an accumulated field, into a consumer's contract takes its key,
 * one symbol no registry holds, as mintOf does: a registered one is refused by the rule the types name, and none, two
 * or a value that is no symbol is malformed. Into natural or bigint, which no consumer owns, it takes no key, and any
 * is malformed. The key's kind is judged, never whose it is, which the types judge (types/fields MintKey).
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDatabaseMintIntoAConsumersContractTakesItsKeyAndIntoAnyOtherTypeNone =
	property.explore(mintSpace, {
		needs: {},
		situations: [
			...Arr.flatMap(mintPositions, (position) =>
				Arr.map(mintTargetsOf(position), (target): MintFeature => `${position} into ${target}`)
			),
			"no key",
			"one key",
			"two keys"
		] satisfies ReadonlyArray<Reached<MintFeature>>,
		check: (_, c: Case<MintFeature>) => (m) =>
			Effect.sync(() => {
				c.note(`${m.position} into ${m.target}`)
				c.note(m.keys.length === 0 ? "no key" : m.keys.length === 1 ? "one key" : "two keys")
				const keys = Arr.map(m.keys, keyOf)
				const verdict = mintVerdictOf(m, keys)
				if (verdict === "made") {
					mintMade(m, keys)
					return
				}
				const thrown = throwsRefused(() => mintMade(m, keys), verdict)
				if (verdict === "Refused") {
					assert.equal(
						thrown.reason._tag === "Refused" ? thrown.reason.refusal : undefined,
						hostKeyRule
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a consumer's contract's values are made in the database under its key alone, every other type's under none"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/contract.ts",
				original: "\tif (rest.length !== levels) {",
				replacement: "\tif (rest.length < levels) {",
				why: "A mint into a consumer's contract takes more keys than its chain holds, so a caller's second key is taken where none belongs; the property fails at two keys."
			},
			{
				file: "packages/engine/src/scalar/contract.ts",
				original:
					"const isOwnedName = (name: string): boolean => name !== naturalName && name !== instantName",
				replacement: "const isOwnedName = (name: string): boolean => name !== instantName",
				why: "natural, grizzle's own, is taken for a consumer's contract, so a mint into it asks a key no module holds; the property fails at natural."
			},
			{
				file: "packages/engine/src/scalar/contract.ts",
				original: "\t\tif (rest.length > 0) {",
				replacement: "\t\tif (rest.length > 1) {",
				why: "A mint into natural or bigint takes a key no consumer owns and ignores it; the property fails at one key into a type no consumer owns."
			},
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original: "\tadmitMintKey(\n\t\tfield.scalar,\n\t\tkey,",
				replacement: "\tadmitMintKey(\n\t\tfield.scalar,\n\t\t[],",
				why: "A cast reads no key it is handed, so a cast into a consumer's contract under its key is refused and one into natural under a key is made; the property fails at a cast."
			},
			{
				file: "packages/engine/src/schema/relation.ts",
				original: '\tadmitMintKey(\n\t\tdescribed.scalar,\n\t\trest,\n\t\tbuilderLoc("drawn", []),',
				replacement:
					'\tadmitMintKey(\n\t\tdescribed.scalar,\n\t\t[],\n\t\tbuilderLoc("drawn", []),',
				why: "A drawn field reads no key it is handed, so one of a consumer's contract under its key is refused; the property fails at a drawn field."
			},
			{
				file: "packages/engine/src/schema/relation.ts",
				original:
					'\tadmitMintKey(\n\t\tdescribed.scalar,\n\t\trest,\n\t\tbuilderLoc("accumulated", []),',
				replacement:
					'\tadmitMintKey(\n\t\tdescribed.scalar,\n\t\t[],\n\t\tbuilderLoc("accumulated", []),',
				why: "An accumulated field reads no key it is handed, so one of a consumer's contract under its key is refused; the property fails at an accumulated field."
			}
		]
	})

/**
 * A clock reading bound to a parameter, and a declared function's result, make a consumer's contract's values under its
 * keys alone. A clock binds a parameter of bigint, natural or one consumer's contract over either, and refuses a
 * contract over another consumer's, whose two keys its member's one would not make; a clocked member is handed nothing
 * or a record of keys by the names its binding binds, each a symbol no registry holds. A declared function whose result
 * holds a consumer's contract at any depth, a value, rows, one row, rows of rows or a variant's arm, is handed a record
 * of exactly those contracts' keys by their names, and one whose result holds none is handed nothing. A registered key
 * is refused by the rule the types name, anything else malformed. Whose each key is, the types judge.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aClockOrADeclaredFunctionMakesAConsumersContractsValuesUnderItsKeysAlone =
	property.explore(heldSpace, {
		needs: {},
		situations: [
			...Arr.map(heldTargets, (t): HeldFeature => `a clock of ${t}`),
			...Arr.map(heldKeys, (k): HeldFeature => `clock keys ${k}`),
			...Arr.flatMap(resultShapes, (shape) =>
				Arr.map(heldTargets, (t): HeldFeature => `${shape} of ${t}`)
			),
			...Arr.map(heldKeys, (k): HeldFeature => `mints ${k}`)
		] satisfies ReadonlyArray<Reached<HeldFeature>>,
		check: (_, c: Case<HeldFeature>) => (h) =>
			Effect.sync(() => {
				switch (h.kind) {
					case "clock": {
						c.note(`a clock of ${h.target}`)
						const type = succeeded(
							describeField(heldTarget(h.target), SourceLoc("clocked parameter", [])),
							"the target is a descriptor"
						)
						const params: ReadonlyArray<ParamDecl> = [
							{ id: ParamId("now"), name: "now", kind: "scalar", type: type.scalar }
						]
						const bound = clockParams(params, { now: "millis" }, "clocked")
						assert.equal(bound.ok, clockBinds(h.target), "a clock binds the parameter by the rule")
						if (!bound.ok) {
							assert.equal(
								bound.error.reason._tag === "Refused" ? bound.error.reason.refusal : undefined,
								clockRule
							)
						}
						return
					}
					case "clock keys": {
						c.note(`clock keys ${h.keys}`)
						const verdict = clockKeysVerdict(h.keys)
						if (verdict === "made") {
							clockedMade(h.keys)
							return
						}
						const thrown = throwsRefused(() => clockedMade(h.keys), verdict)
						if (verdict === "Refused") {
							assert.equal(
								thrown.reason._tag === "Refused" ? thrown.reason.refusal : undefined,
								hostKeyRule
							)
						}
						return
					}
					case "result": {
						c.note(`${h.shape} of ${h.target}`)
						c.note(`mints ${h.mints}`)
						const verdict = mintsVerdict(h.target, h.mints)
						if (verdict === "made") {
							resultFunction(h)
							return
						}
						const thrown = throwsRefused(() => resultFunction(h), verdict)
						if (verdict === "Refused") {
							assert.equal(
								thrown.reason._tag === "Refused" ? thrown.reason.refusal : undefined,
								hostKeyRule
							)
						}
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "a clock and a declared function's result make a consumer's contract's values under its keys alone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/clock.ts",
				original:
					"const isReadingType = (t: ScalarType): t is Int8Type => isInt8Type(t) && ownedLevels(t) <= 1",
				replacement: "const isReadingType = (t: ScalarType): t is Int8Type => isInt8Type(t)",
				why: "A clock binds a contract over another consumer's contract, whose values its member's one key would not make; the property fails at a clock of a contract over a consumer's."
			},
			{
				file: "packages/engine/src/program/workload/value.ts",
				original: "\t\tObject.keys(keys).some((name) => !Object.hasOwn(binding, name))",
				replacement: '\t\tObject.keys(keys).some((name) => name === "")',
				why: "A clocked member takes a key by a name its binding binds no parameter of; the property fails at one too many."
			},
			{
				file: "packages/engine/src/schema/function.ts",
				original:
					'\t\tObject.keys(record).toSorted(compareCodePoints).join("\\n") !== names.join("\\n")',
				replacement: "\t\tObject.keys(record).length === 0",
				why: "A declared function takes mints that name a contract its result holds none of; the property fails at one too many."
			},
			{
				file: "packages/engine/src/schema/function.ts",
				original:
					"\t\t\treturn [...new Set(t.heading.flatMap((field) => ownedNames(field.type)))].toSorted(",
				replacement: "\t\t\treturn [...new Set(t.heading.flatMap(() => []))].toSorted(",
				why: "A declared function's rows or row of a consumer's contract are read as holding none, so its body makes the contract's values with no key and its keys are refused; the property fails at rows and one row of a contract."
			},
			{
				file: "packages/engine/src/scalar/contract.ts",
				original:
					'\t\tif (d.kind === "contract" && isOwnedName(d.name) && !names.includes(d.name)) {',
				replacement:
					'\t\tif (d === desc && d.kind === "contract" && isOwnedName(d.name) && !names.includes(d.name)) {',
				why: "Only a result's own contract is read, never its base's or a variant arm's, so a contract over a consumer's and a variant's arm take too few keys; the property fails there."
			}
		]
	})
