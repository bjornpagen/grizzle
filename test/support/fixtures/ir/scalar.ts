import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateTable, predicateTree } from "#compiler/ir/expr.ts"
import {
	type Carrier,
	type DeclaredType,
	numericBoundOf,
	Roster,
	type ScalarType,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import {
	exactNumericBound,
	valueType,
	wildcardText,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
/**
 * Scalar types for tests, each the one the registry builds (scalar/registry.ts scalarTypeOf): no test states a
 * ScalarType as a literal, so every capability set a test meets is production's. Beside them, what only tests read of
 * scalar types and text refinements: a predicate table's normal form, the plain carriers, the refinement-dropping
 * widening, and a refinement's host NFA membership and language.
 */
import type { PlainCarrier } from "#compiler/scalar/native.ts"
import type { RegexNode } from "#compiler/scalar/regex/ir.ts"
import { matches } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { languageOf, type TextRefinement } from "#compiler/text/refinement.ts"

export { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
export { plainType } from "#compiler/scalar/native.ts"

/**
 * The declared type of `desc`, a closed id's or a set's roster read from `rosters` (roster name to its handles in
 * declared order), a text's language the one its Description carries. A FieldDesc the registry refuses fails the test.
 */
export const scalarOf = (
	desc: FieldDesc,
	rosters: Readonly<Record<string, NonEmptyReadonlyArray<string>>>
): DeclaredType => {
	const env: ScalarEnv = {
		kind: "builder",
		roster: (closed) => {
			const handles = rosters[closed]
			return handles === undefined ? undefined : new Roster(closed, handles)
		}
	}
	const t = scalarTypeOf(desc, env, SourceLoc("a test fixture's scalar type", []))
	if (!t.ok) {
		throw new Error(`the registry refuses a test fixture's type: ${t.error.message}`)
	}
	return t.value
}

/**
 * A contract predicate's table renamed to its normal form (ir/expr.ts predicateTable), unreachable entries dropped. A
 * dangling argument is MalformedDescription.
 */
export const normalizeExprTable = (table: ExprTable): Result.Result<ExprTable, CompileError> =>
	Result.map(predicateTree(table), predicateTable)

const plainCarriers: ReadonlySet<string> = new Set<PlainCarrier>([
	"int2",
	"int4",
	"int8",
	"float4",
	"float8",
	"money",
	"bool",
	"date"
])

/** Whether a carrier is a plain one (scalar/compute/types.ts PlainCarrier), an operation result with no metadata. */
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
		case "text":
		case "uuid":
		case "date":
		case "vector":
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

/** Whether an admitted text value matches a refinement: the host NFA matcher (scalar/regex/nfa.ts) over its IR. */
export const accepts = (refinement: TextRefinement, value: string): boolean =>
	Arr.every(refinement.members, (member) => matches(buildNfa(member.ir), value))

/**
 * The language of a parsed pattern (scalar/regex/parse.ts parsePattern), classified as
 * analyzeText classifies it (text/refinement.ts languageOf): an empty language is the refusal "matches no admitted text
 * value".
 */
export const analyzeLanguage = (ir: RegexNode) => languageOf(ir, buildNfa(ir))
