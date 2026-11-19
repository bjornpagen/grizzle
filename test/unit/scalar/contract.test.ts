/**
 * A contract over a base drawn from the descriptor kinds a contract takes, with a predicate that bounds the value or
 * none: a domain over its base (the base's SQL type, carrier, typmod and capabilities),
 * exposing the caller's base descriptor itself, an unchecked brand constructor returning its argument, one identity per
 * equal declaration and distinct by name, its type compatible across a predicate change; a serial base is refused
 * before the predicate runs, as the one refusal its rule names, and a callback that builds no predicate is malformed.
 *
 * Admission: contract(name, base) builds exactly from a declared name, a descriptor and no argument past the predicate,
 * over Live names near the rule's edges and Wild names and bases of every kind (@bjornpagen/testing/lsw); everything else
 * is MalformedDescription.
 *
 * Oracles: the base's own description, for what a domain keeps of it; the field identity text, for one identity per
 * declaration; the declared-name rule (parseDeclaredName), for admission.
 *
 * Features: each base with and without a predicate, a serial refused, no predicate built; a live contract, a string
 * name the rule refuses, every wild kind as name and as base, an extra argument.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, constant, element, int, map, weighted } from "@bjornpagen/testing/gen"
import { passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { json } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { contractOf, numericTypmodOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { assert, defined, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	admitContract,
	contractDescriptor,
	fieldIdentity
} from "#test/support/fixtures/descriptors.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type AdmissionFeature,
	admissionSpace,
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
				weighted<"declaration" | "serial" | "no predicate">([
					[2, constant("declaration")],
					[1, constant("serial")],
					[1, constant("no predicate")]
				])
			),
			base: source.draw(element(baseNames)),
			precision: source.draw(int(2, 30)),
			name: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
			other: source.draw(matching(regex("^[A-Z][a-z]{1,8}$"))),
			/** An object holding any JSON value: its identity, not its content, is what a brand keeps. */
			value: source.draw(map(json(2), (inner) => ({ inner }))),
			withPredicate: source.draw(boolean)
		}),
		{
			needs: {},
			/** A predicate is built over the integer-like bases, whose value a comparison reads. */
			situations: [
				...Arr.map(baseNames, (b): IdentityFeature => `${b} without a predicate`),
				"integer with a predicate",
				"bigint with a predicate",
				"serial refused",
				"no predicate built"
			] satisfies ReadonlyArray<Reached<IdentityFeature>>,
			check:
				(_, c: Case<IdentityFeature>) =>
				({ kind, base: baseName, precision, name, other, value, withPredicate }) =>
					Effect.sync(() => {
						if (kind === "serial") {
							c.note("serial refused")
							let ran = false
							/**
							 * A serial's type is its integer's, so its writing is what refuses it, for the rule the types name
							 * too: a contract is over the serial's value type instead.
							 */
							const refusals = [
								throwsRefused(
									() =>
										contractDescriptor(name, pgDescriptors.serial, (v: ScalarTerm) => {
											ran = true
											return Compute.ge(v, 0)
										}),
									"Refused"
								),
								throwsRefused(() => contractDescriptor(name, pgDescriptors.bigserial), "Refused")
							] as const
							assert.equal(ran, false)
							const serialRule: Refused =
								"a contract is a value domain; a serial is a generation declaration, so use its value type"
							for (const thrown of refusals) {
								assert.equal(
									thrown.reason._tag === "Refused" ? thrown.reason.refusal : undefined,
									serialRule
								)
							}
							return
						}
						if (kind === "no predicate") {
							c.note("no predicate built")
							throwsRefused(
								() => contractDescriptor(name, pgDescriptors.bigint, () => true),
								"MalformedDescription"
							)
							throwsRefused(
								() => contractDescriptor(name, pgDescriptors.bigint, (v: ScalarTerm) => v),
								"MalformedDescription"
							)
							throwsRefused(
								() => admitContract(name, pgDescriptors.bigint, [5]),
								"MalformedDescription"
							)
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
						assert.deepEqual(scalar.caps, described.scalar.caps)
						const info = defined(contractOf(scalar), "the contract")
						assert.equal<string>(info.name, name)
						assert.ok(sameScalarType(info.base, described.scalar))
						assert.equal(declared(value), value)
						assert.ok(Object.isFrozen(declared))
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
					file: "packages/engine/src/ir/scalar.ts",
					original: "\t\t: a.width === b.width && sameScalarType(a.endpoint, b.endpoint)",
					replacement: "\t\t: a.width !== b.width && sameScalarType(a.endpoint, b.endpoint)",
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
			"extra argument"
		] satisfies ReadonlyArray<Reached<AdmissionFeature>>,
		check:
			(_, c: Case<AdmissionFeature>) =>
			({ name, base, extra }) =>
				Effect.sync(() => {
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
						const built = contractDescriptor(n, b, undefined)
						assert.equal(built.name, n)
						assert.equal(b, built.base)
					} else {
						if (name.kind === "live" && base.kind === "live" && extra.length === 0) {
							c.note("a string name the declared-name rule refuses")
						}
						throwsRefused(
							() => contractDescriptor(n, b, undefined, ...argumentsOf(extra)),
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
				original: "\tif (declared === undefined) {",
				replacement: "\tif (!hasProperties(declared)) {",
				why: "An argument past the predicate that is no object is taken for no declaration, so a contract given one is admitted; the admission property fails."
			}
		]
	})
