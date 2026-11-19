/** What the properties of contract.test.ts read: its spaces, models and helpers. */

import {
	aimed,
	array,
	codePoint,
	element,
	type Gen,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { type Drawn, lsw, WILD_KINDS, type WildKind, wild } from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import { type Json, json } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { span } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"

type BaseName = "integer" | "bigint" | "numeric(p,s)" | "money" | "pattern" | "span"

export const baseNames: Arr.NonEmptyReadonlyArray<BaseName> = [
	"integer",
	"bigint",
	"numeric(p,s)",
	"money",
	"pattern",
	"span"
]

const Lower = str.regex("^[a-z]+$", "u")

const IntSpan = span(pgDescriptors.integer)

export const baseOfName = (name: BaseName, precision: number): unknown => {
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
export const predicateFor = (
	name: BaseName,
	wanted: boolean
): ((v: ScalarTerm) => { readonly expr: unknown }) | undefined =>
	wanted && (name === "integer" || name === "bigint")
		? (v: ScalarTerm) => Compute.ge(v, name === "integer" ? 0 : 0n)
		: undefined

export type IdentityFeature =
	| `${BaseName} ${"with" | "without"} a predicate`
	| "a minted base refused"
	| "no predicate built"

/**
 * What contract(name, base) admits from a JavaScript caller: a declared name (core/identity.ts parseDeclaredName, the
 * naming door's one rule), a descriptor a builder made, and no argument past the predicate. A live name is drawn near
 * the rule's edges, a name of the rule's characters led by any of them or a printable ASCII string, and a name the wild
 * arm draws is judged by what it is ("anything" may draw a declared name); a wild base is never a descriptor.
 * Everything else is MalformedDescription.
 */
export type AdmissionFeature =
	| "live"
	| "a string name the declared-name rule refuses"
	| `wild ${"name" | "base"} ${WildKind}`
	| "extra argument"

export const isDeclaredName = (name: unknown): name is string =>
	typeof name === "string" && parseDeclaredName(name).ok

/** A call of contract(name, base): its name, its base, and the arguments past the predicate. */
type AdmissionCase = Readonly<{
	name: Drawn<string, never>
	base: Drawn<unknown, never>
	extra: ReadonlyArray<Json>
}>

/**
 * A contract's name: a live one of the rule's characters or a printable ASCII string, or a wild value of one of
 * `kinds`.
 */
const admissionName = (kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Drawn<string, never>> =>
	lsw({
		live: weighted([
			[1, matching(regex("^[A-Za-z0-9_]{1,12}$"))],
			[1, string(codePoint(0x20, 0x7e), { min: 1, max: 12 })]
		]),
		stale: Option.none(),
		wild: kinds
	})

/** A contract's base: a live descriptor a builder made, or a wild value of one of `kinds`. */
const admissionBase = (kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Drawn<unknown, never>> =>
	lsw<unknown>({
		live: element<unknown>([
			pgDescriptors.bigint,
			pgDescriptors.integer,
			pgDescriptors.numeric(9, 2),
			str.regex("^a$", "u")
		]),
		stale: Option.none(),
		wild: kinds
	})

/** A wild value of `kind` alone. */
const wildOnly = <T>(kind: WildKind): Gen<Drawn<T, never>> =>
	map(wild([kind]), (drawn): Drawn<T, never> => ({ kind: "wild", wild: drawn }))

/** A call of contract(name, base) whose name and base `name` and `base` draw, and up to one argument past it. */
const admissionCaseOf =
	(name: Gen<Drawn<string, never>>, base: Gen<Drawn<unknown, never>>): Gen<AdmissionCase> =>
	(source) => ({
		name: source.draw(name),
		base: source.draw(base),
		extra: source.draw(array(json(2), { min: 0, max: 1 }))
	})

/**
 * Calls of contract(name, base) over live names near the rule's edges, live descriptors, and every wild kind as name and
 * as base, aimed at each wild kind still pending: a name or a base of that kind alone.
 */
export const admissionSpace = aimed<AdmissionCase, AdmissionFeature>(
	admissionCaseOf(admissionName(WILD_KINDS), admissionBase(WILD_KINDS)),
	Arr.flatMap(
		WILD_KINDS,
		(kind): ReadonlyArray<readonly [AdmissionFeature, Gen<AdmissionCase>]> => [
			[`wild name ${kind}`, admissionCaseOf(wildOnly(kind), admissionBase(WILD_KINDS))],
			[`wild base ${kind}`, admissionCaseOf(admissionName(WILD_KINDS), wildOnly(kind))]
		]
	)
)
