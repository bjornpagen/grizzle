/**
 * Scalar types for tests, each the one the registry builds (scalar/registry.ts scalarTypeOf): no test states a
 * ScalarType as a literal, so every capability set a test meets is production's. Beside them, what only tests read of
 * scalar types and text refinements: a predicate table's normal form, the plain carriers, the refinement-dropping
 * widening, and a refinement's host NFA membership and language.
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import type { RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { Array as Arr, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateTable, predicateTree } from "#compiler/ir/expr.ts"
import { admitSpelling, knownOf, type PatternValue } from "#compiler/ir/pattern.ts"
import {
	type Carrier,
	type DeclaredType,
	numericBoundOf,
	Roster,
	type RosterOrder,
	type ScalarType,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import {
	exactNumericBound,
	valueType,
	wildcardText,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
import type { PlainCarrier } from "#compiler/scalar/native.ts"
import { type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { TextRefinement } from "#compiler/text/refinement.ts"

export { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
export { plainType } from "#compiler/scalar/native.ts"

/**
 * The declared type of `desc`, a closed id's or a set's roster read from `rosters` (roster name to its handles in
 * declared order), a text's language the one its Description carries. A FieldDesc the registry refuses fails the test.
 */
export const scalarOf = (
	desc: FieldDesc,
	rosters: Readonly<Record<string, ReadonlyArray<string>>>
): DeclaredType => {
	const env: ScalarEnv = {
		kind: "builder",
		roster: (closed) => {
			const handles = rosters[closed]
			return handles === undefined ? undefined : Roster.of(closed, "ordered", handles)
		}
	}
	const t = scalarTypeOf(desc, env, SourceLoc("a test fixture's scalar type", []))
	if (!t.ok) {
		throw new Error(`the registry refuses a test fixture's type: ${t.error.message}`)
	}
	return t.value
}

/**
 * A closed id of the roster `closed` of `order` over `handles`, as the registry types one: an unordered roster's has no
 * ordering and no minMax capability.
 */
export const closedIdTypeOf = (
	closed: string,
	order: RosterOrder,
	handles: NonEmptyReadonlyArray<string>
): DeclaredType => {
	const env: ScalarEnv = {
		kind: "builder",
		roster: (name) => (name === closed ? Roster.of(name, order, handles) : undefined)
	}
	const t = scalarTypeOf(
		{ kind: "closedId", roster: closed, only: undefined },
		env,
		SourceLoc("a test fixture's closed id", [])
	)
	if (!t.ok) {
		throw new Error(`the registry refuses a test fixture's closed id: ${t.error.message}`)
	}
	return t.value
}

/**
 * A contract predicate's table renamed to its normal form (ir/expr.ts predicateTable), unreachable entries dropped. A
 * dangling argument is MalformedDescription.
 */
export const normalizeExprTable = (table: ExprTable): Result.Result<ExprTable, CompileError> =>
	Result.map(predicateTree(table), predicateTable)

/** Each plain carrier (scalar/native.ts PlainCarrier), stated once a carrier, so a new one is a case to state here. */
const plainCarriers: ReadonlySet<Carrier> = new Set(
	Rec.keys({
		int2: true,
		int4: true,
		int8: true,
		float4: true,
		float8: true,
		money: true,
		bool: true,
		date: true,
		inet: true,
		cidr: true,
		sha256: true
	} satisfies { readonly [C in PlainCarrier]: true })
)

/** Whether a carrier is a plain one (scalar/native.ts PlainCarrier), an operation result with no metadata. */
export const isPlainCarrier = (carrier: Carrier): carrier is PlainCarrier =>
	plainCarriers.has(carrier)

/**
 * The exact carrier an integer or money type widens into, and the integer digits its values are below: a plain
 * carrier's range, an exact type's own bound.
 */
const exactWidening = (
	t: ScalarType
): { readonly into: "exactInteger" | "exactMoney"; readonly digits: number } | undefined => {
	switch (t.carrier) {
		case "int2":
			return { into: "exactInteger", digits: 5 }
		case "int4":
			return { into: "exactInteger", digits: 10 }
		case "int8":
			return { into: "exactInteger", digits: 19 }
		case "money":
			return { into: "exactMoney", digits: 17 }
		case "exactInteger":
		case "exactMoney":
			return { into: t.carrier, digits: t.digits }
		case "bool":
		case "code":
		case "bits":
		case "float4":
		case "float8":
		case "numeric":
		case "range4":
		case "range8":
		case "rangeDate":
		case "bytes":
		case "sha256":
		case "text":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "vector":
		case "tsvector":
			return undefined
	}
}

/**
 * Whether `to` is `from`'s value type with only refinements dropped that PostgreSQL never checks on the way: a contract
 * (its base), a numeric typmod (plain numeric), a text refinement (wildcard text), a span's fixed width, a binary
 * coercible cast, total and immutable; or an integer or money value lifted into the exact carrier of its family that
 * holds every one of its values, an exact conversion.
 */
export const widensTo = (from: ScalarType, to: ScalarType): boolean => {
	const v = valueType(from)
	if (sameScalarType(to, v) || sameScalarType(to, withoutSpanWidth(v))) {
		return true
	}
	const exact = exactWidening(v)
	if (exact !== undefined && (to.carrier === "exactInteger" || to.carrier === "exactMoney")) {
		return to.carrier === exact.into && to.digits >= exact.digits
	}
	if (v.carrier === "numeric") {
		const from = exactNumericBound(v)
		const into = numericBoundOf(to)
		return (
			from !== undefined &&
			into !== undefined &&
			into.digits >= from.digits &&
			into.scale >= from.scale
		)
	}
	if (v.carrier === "text") {
		return sameScalarType(to, wildcardText)
	}
	return false
}

/** Whether an admitted text value matches a refinement: the host matcher (scalar/regex/match.ts) of its IR's NFA. */
export const accepts = (refinement: TextRefinement, value: string): boolean =>
	Arr.every(refinement.members, (member) => Matcher.of(buildNfa(member.ir)).matches(value))

/**
 * The language of a parsed pattern (scalar/regex/parse.ts parsePattern) as analyzeText knows it (ir/pattern.ts
 * knownOf): its canonical automaton within the DFA bounds, of no state for the empty language, which analyzeText
 * refuses, or its structure past them.
 */
export const analyzeLanguage = (ir: RegexNode) => knownOf(minimalDfa(buildNfa(ir), regexDfaLimits))

/**
 * The pattern value of `spelling` (ir/pattern.ts admitSpelling), admitted and its language's key computed as
 * every pattern literal's is: what a test's Text.matches literal or guard holds. A spelling its admission refuses fails the
 * test.
 */
export const spelled = (spelling: string): PatternValue => {
	const value = admitSpelling(spelling)
	if (!value.ok) {
		throw new Error(`a test's pattern its admission admits: /${spelling}/u`)
	}
	return value.value
}
