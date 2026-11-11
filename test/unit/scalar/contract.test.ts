/**
 * A contract over a base drawn from the descriptor kinds a contract takes, with a predicate that bounds the value or
 * none: a domain over its base (the base's SQL type, carrier, typmod and capabilities),
 * exposing the caller's base descriptor itself, an unchecked brand constructor returning its argument, one identity per
 * equal declaration and distinct by name, its type compatible across a predicate change; a serial base is refused
 * before the predicate runs, as the one refusal its rule names, and a callback that builds no predicate is malformed.
 *
 * Admission: contract(name, base) builds exactly from a declared name, a descriptor and no argument past the predicate,
 * over Live names near the rule's edges and Wild names and bases of every kind (@grizzle/testing/lsw); everything else
 * is MalformedDescription.
 *
 * Oracles: the base's own description, for what a domain keeps of it; the field identity text, for one identity per
 * declaration; the declared-name rule (parseDeclaredName), for admission.
 *
 * Features: each base with and without a predicate, a serial refused, no predicate built; a live contract, a string
 * name the rule refuses, every wild kind as name and as base, an extra argument.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): contract-serial-predicate-runs-first (a serial's predicate run before
 * it is refused), contract-identity-nameless (a contract's Description without its name) and
 * contract-extra-argument-admitted (one argument past the declaration admitted).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	int,
	map,
	string,
	weighted
} from "@grizzle/testing/gen"
import { lsw, passed, WILD_KINDS, type WildKind } from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { json } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { contractOf, numericTypmodOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { span } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { assert, defined, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	admitContract,
	contractDescriptor,
	fieldIdentity
} from "#test/support/fixtures/descriptors.ts"
import { caseHang } from "#test/support/limits.ts"

import { regex } from "arkregex"
import type { Refused } from "#compiler/core/refusals.ts"
import { argumentsOf } from "#test/support/list.ts"
type BaseName = "integer" | "bigint" | "numeric(p,s)" | "money" | "pattern" | "span"
const baseNames: Arr.NonEmptyReadonlyArray<BaseName> = [
	"integer",
	"bigint",
	"numeric(p,s)",
	"money",
	"pattern",
	"span"
]
const Lower = str.regex("^[a-z]+$", "u")
const IntSpan = span(pgDescriptors.integer)
const baseOfName = (name: BaseName, precision: number): unknown => {
	switch (name) {
		case "integer":
			return pgDescriptors.integer
		case "bigint":
			return pgDescriptors.bigint
		case "numeric(p,s)":
			return pgDescriptors.numeric(precision, Math.floor(precision / 2))
		case "money":
			return pgDescriptors.money
		case "pattern":
			return Lower
		case "span":
			return IntSpan
	}
}

/** A predicate the base's value admits: a comparison of an integer-like value, or none. */
const predicateFor = (
	name: BaseName,
	wanted: boolean
): ((v: ScalarTerm) => { readonly expr: unknown }) | undefined =>
	wanted && (name === "integer" || name === "bigint")
		? (v: ScalarTerm) => v.ge(name === "integer" ? 0 : 0n)
		: undefined

type IdentityFeature =
	| `${BaseName} ${"with" | "without"} a predicate`
	| "serial refused"
	| "no predicate built"

describe("contract identity", () => {
	it.effect(
		"is a domain over its base and its own brand, one identity per equal declaration, distinct by name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the base's own description, and the field identity text of each declaration"
						},
						suite: "unit/scalar/contract-identity",
						draw: drawn((source) => ({
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
						})),
						literal: Formatter.format,
						/** A predicate is built over the integer-like bases, whose value a comparison reads. */
						coverage: required<IdentityFeature>(
							[
								...Arr.map(baseNames, (b): IdentityFeature => `${b} without a predicate`),
								"integer with a predicate",
								"bigint with a predicate",
								"serial refused",
								"no predicate built"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ kind, base: baseName, precision, name, other, value, withPredicate }, c) =>
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
												return v.ge(0)
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
								assert.notEqual(
									succeeded(fieldIdentity(declared)),
									succeeded(fieldIdentity(renamed))
								)
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
						})
				)
			)
	)
})

/**
 * What contract(name, base) admits from a JavaScript caller: a declared name (core/identity.ts parseDeclaredName, the
 * naming door's one rule), a descriptor a builder made, and no argument past the predicate. A live name is drawn near
 * the rule's edges, a name of the rule's characters led by any of them or a printable ASCII string, and a name the wild
 * arm draws is judged by what it is ("anything" may draw a declared name); a wild base is never a descriptor.
 * Everything else is MalformedDescription.
 */
type AdmissionFeature =
	| "live"
	| "a string name the declared-name rule refuses"
	| `wild ${"name" | "base"} ${WildKind}`
	| "extra argument"

const isDeclaredName = (name: unknown): name is string =>
	typeof name === "string" && parseDeclaredName(name).ok

describe("contract admission", () => {
	it.effect(
		"builds exactly from a declared name, a descriptor and no extra argument, and refuses the rest as malformed",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the declared-name rule, and a descriptor a builder made"
						},
						suite: "unit/scalar/contract-admission",
						draw: drawn((source) => ({
							name: source.draw(
								lsw({
									live: weighted([
										[1, matching(regex("^[A-Za-z0-9_]{1,12}$"))],
										[1, string(codePoint(0x20, 0x7e), { min: 1, max: 12 })]
									]),
									stale: Option.none(),
									wild: WILD_KINDS
								})
							),
							base: source.draw(
								lsw<unknown>({
									live: element<unknown>([
										pgDescriptors.bigint,
										pgDescriptors.integer,
										pgDescriptors.numeric(9, 2),
										str.regex("^a$", "u")
									]),
									stale: Option.none(),
									wild: WILD_KINDS
								})
							),
							extra: source.draw(array(json(2), { min: 0, max: 1 }))
						})),
						literal: Formatter.format,
						coverage: required<AdmissionFeature>(
							[
								"live",
								"a string name the declared-name rule refuses",
								...Arr.flatMap(WILD_KINDS, (kind): ReadonlyArray<AdmissionFeature> => [
									`wild name ${kind}`,
									`wild base ${kind}`
								]),
								"extra argument"
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
					({ name, base, extra }, c) =>
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
						})
				)
			)
	)
})
