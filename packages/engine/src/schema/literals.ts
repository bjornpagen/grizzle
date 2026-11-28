/**
 * The field of a set of head literals: a column whose values are exactly a union's literals at one key (literalsField).
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { end, RegexBuilder, seq, start } from "@bjornpagen/grizzle-text/regex/ir"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { sourceFlags } from "@bjornpagen/grizzle-text/regex/source"
import { literal } from "@bjornpagen/grizzle-text/regex/words"
import type { CellConversion } from "#compiler/core/decoder.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { defineField, type ScalarEnv } from "#compiler/scalar/registry.ts"
import { builderLoc } from "#compiler/schema/protocol.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import type { Carrier } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"

/**
 * The stored field of head literals of several values at one key, a union's arms each writing its own (core/decoder.ts
 * unionColumn), for a query's records (program/records.ts): a field whose values are exactly the literals, over the
 * literals' column, so the read delivers the stored literal's text and the query's decoder reads it as the literal it
 * is. Text literals are a text of the pattern of exactly them (`^(?:a|b)$`, printed from their alternation by grizzle's
 * own grammar, text/regex print.ts printSource); boolean literals, which are both values, are a boolean. A literal of
 * any other type has no field whose values are exactly the literals, so it is refused.
 */
export const literalsField = (
	values: NonEmptyReadonlyArray<unknown>,
	conversion: CellConversion,
	carrier: Carrier,
	env: ScalarEnv,
	at: string
): FieldBase => {
	const loc = builderLoc(at, [])
	switch (conversion.carrier) {
		case "text": {
			const texts = values.map((value) => {
				if (typeof value !== "string") {
					defect("a text literal is a string")
				}
				return value
			})
			const source = printSource(
				seq([start, new RegexBuilder().alt(texts.map(literal)), end]),
				(set) => set
			)
			const { desc } = describeDeclared(regexField<string>(source, [sourceFlags]), loc)
			return defineField({}, carrier.sql, desc, { column: carrier.column }, loc, env)
		}
		case "bool":
			return defineField(
				{},
				carrier.sql,
				{ kind: "pg", type: "bool" },
				{ column: carrier.column },
				loc,
				env
			)
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "sha256":
		case "tsvector":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
		case "exactMoney":
		case "vector":
			throw unsupported(
				SourceLoc(at, []),
				`a stored field whose values are exactly the ${conversion.carrier} literals ${values.map(String).join(", ")}`
			)
	}
}
