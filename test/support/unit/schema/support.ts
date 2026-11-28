import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { predicateValue } from "#compiler/scalar/compute/term.ts"
import { bool, float4, float8, int2, int4, int8, money, numeric } from "#compiler/scalar/pg.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { vector } from "#compiler/scalar/vector.ts"
import { admittedClosedId } from "#compiler/schema/relation.ts"
import type { RowTerm, rowHelpers } from "#compiler/schema/terms.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed } from "#compiler/types/schema/relation.ts"
import { admitContract, spanDescriptor } from "#test/support/fixtures/descriptors.ts"

/**
 * Typed Live builders for the schema tests over the real descriptors of packages/engine/src/scalar and str.regex, each taking
 * what a builder made, and the one named Wild value, `patternOnly`, a look-alike passed only where a refusal is
 * expected. The schema builders admit a descriptor only by identity (scalar/registry.ts): a value no builder made has
 * no column a builder made, so a look-alike is refused.
 *
 * The row a check's callback receives, typed loosely for tests that pass untyped descriptors: the fields these tests'
 * checks read, beside the helpers.
 */
export type Row = {
	readonly [F in "id" | "account" | "limit" | "maximum" | "label"]: RowTerm
} & typeof rowHelpers

/** The FieldDesc of a descriptor, as the registry reads it. */
export const descOf = (descriptor: FieldBase): FieldDesc => {
	const described = describeField(descriptor, SourceLoc("test descriptor", []))
	if (!described.ok) {
		throw described.error
	}
	return described.value.desc
}

export const rawPg = {
	smallint: int2,
	integer: int4,
	bigint: int8,
	real: float4,
	doublePrecision: float8,
	money: money,
	boolean: bool,
	numericOf: (precision: number, scale: number) => numeric(precision, scale),
	numeric: numeric,
	vector: (dimensions: number) => vector(dimensions)
} as const

/** str.regex over a source known at run time. */
export const regex = (source: string, flags: "u" | "su") => regexField(source, [flags])

/**
 * A text descriptor carrying only its public pattern, as a JavaScript caller might write one: a look-alike, refused.
 */
export const patternOnly = (source: string, flags: "u" | "su") =>
	Object.freeze({ sql: "text", pattern: Object.freeze({ source, flags }) })

export const wildcard = regex("^.*$", "su")

/** A contract whose predicate is the expression `predicate`, as a predicate callback records it. */
export const rawContract = (
	name: string,
	base: FieldBase,
	predicate: OpenExpr
): ReturnType<typeof admitContract> => admitContract(name, base, [() => predicateValue(predicate)])

/** A contract with no predicate: a name over its base. */
export const bareContract = (name: string, base: FieldBase): ReturnType<typeof admitContract> =>
	admitContract(name, base, [])

export const rawClosedId = (roster: AnyClosed) => admittedClosedId(roster)

export const rawSpan = spanDescriptor

/** A domain predicate bounding char_length(VALUE) above, as Text.charLength(v).le(n) records it. */
export const charLengthAtMost = (n: number): OpenExpr => ({
	kind: "compare",
	op: "le",
	left: { kind: "compute", fn: "charLength", args: [{ kind: "value" }] },
	right: { kind: "literal", value: n }
})

/** A domain predicate bounding octet_length(VALUE) above, as Text.octetLength(v).le(n) records it. */
export const octetLengthAtMost = (n: number): OpenExpr => ({
	kind: "compare",
	op: "le",
	left: { kind: "compute", fn: "octetLength", args: [{ kind: "value" }] },
	right: { kind: "literal", value: n }
})
