/**
 * Scalar types for tests, each the one the registry builds (scalar/registry.ts scalarTypeOf): no test states a
 * ScalarType as a literal, so every capability set a test meets is production's. Beside them, what only tests read of
 * scalar types and text refinements: a predicate table's normal form, the plain carriers, the refinement-dropping
 * widening, and a refinement's host NFA membership and language.
 */
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateTable, predicateTree } from "#compiler/ir/expr.ts"
import { type Carrier, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	type PlainCarrier,
	plainType,
	valueType,
	wildcardText,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
import type { RegexNode } from "#compiler/scalar/regex/ir.ts"
import { buildNfa, matches } from "#compiler/scalar/regex/nfa.ts"
import { type ScalarEnv, scalarTypeOf, type TextLookup } from "#compiler/scalar/registry.ts"
import {
	analyzeText,
	languageOf,
	type TextRefinement,
	textInfo,
	type textLimits
} from "#compiler/text/refinement.ts"

export { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"

/**
 * The text metadata the schema reading gives a pattern (analysis/schema.ts): the text package's canonical analysis under
 * the policy in force, so a fixture's regex carries the bounds production proves.
 */
const canonicalText: TextLookup = (source, flags) =>
	Result.map(analyzeText(source, flags, SourceLoc("a test fixture's pattern", [])), textInfo)

/**
 * The ScalarType of `desc`, an enum's roster read from `rosters` (closed relation name to its handles in declared
 * order). A FieldDesc the registry refuses fails the test.
 */
export const scalarOf = (
	desc: FieldDesc,
	rosters: Readonly<Record<string, NonEmptyReadonlyArray<string>>>
): ScalarType => {
	const env: ScalarEnv = {
		kind: "builder",
		roster: (closed) => rosters[closed],
		text: canonicalText
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
	"numeric",
	"float4",
	"float8",
	"money",
	"bool"
])

/** Whether a carrier is a plain one (scalar/compute/types.ts PlainCarrier), an operation result with no metadata. */
export const isPlainCarrier = (carrier: Carrier): carrier is PlainCarrier =>
	plainCarriers.has(carrier)

/**
 * Whether `to` is `from`'s value type with only refinements dropped that PostgreSQL never checks on the way: a contract
 * (its base), a numeric typmod (plain numeric), a text refinement (wildcard text), a span's fixed width. A cast between
 * the two is binary coercible: total and immutable.
 */
export const widensTo = (from: ScalarType, to: ScalarType): boolean => {
	const v = valueType(from)
	if (sameScalarType(to, v) || sameScalarType(to, withoutSpanWidth(v))) {
		return true
	}
	if (v.carrier === "numeric") {
		return sameScalarType(to, plainType("numeric"))
	}
	if (v.carrier === "text") {
		return sameScalarType(to, wildcardText)
	}
	return false
}

/** Whether an admitted text value matches a refinement: the host NFA matcher (scalar/regex/nfa.ts) over its IR. */
export const accepts = (refinement: TextRefinement, value: string): boolean =>
	matches(buildNfa(refinement.ir), value)

/**
 * The language of a parsed pattern (scalar/regex/parse.ts parsePattern under the same limits), classified as
 * analyzeText classifies it (text/refinement.ts languageOf): an empty language is the refusal "matches no admitted text
 * value".
 */
export const analyzeLanguage = (ir: RegexNode, limits: ReturnType<typeof textLimits>) =>
	languageOf(ir, buildNfa(ir), limits)
