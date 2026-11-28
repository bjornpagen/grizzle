import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Undeclared } from "#compiler/core/causes.ts"
import type { ContractFieldDesc, FieldDesc, VariantFieldDesc } from "#compiler/ir/desc.ts"
import {
	isNumericValue,
	languageOctets,
	languageOfText,
	type NumericValueType,
	type ScalarType,
	textPatterns
} from "#compiler/ir/scalar.ts"
import { numericBoundDesc } from "#compiler/scalar/registry.ts"
import type { Owned } from "#compiler/schema/own.ts"

/**
 * The field descriptor of a column type (ir/desc.ts FieldDesc): what a field holding every value of the type is
 * declared as, read by the schema's builders (a record's fields, program/records.ts) and by the derived analysis (a
 * derived relation's heading, analysis/derived/fields.ts inferredFields) alike, so a builder that describes a column
 * loads none of the analysis.
 */

/**
 * A schema's declarations of the types one declaration names and every field of them holds by that name, a contract and
 * a variant, each by its name: its descriptor, or none for one the schema does not declare. An owned schema's
 * (ownedDeclarations) and a level's content's (levels.ts SchemaContent contracts and variants) alike.
 */
export interface Declarations {
	readonly contract: (name: string) => ContractFieldDesc | undefined
	readonly variant: (name: string) => VariantFieldDesc | undefined
}

/** The contracts and the variants an owned schema declares (own.ts Owned contracts and variants), by name. */
export const ownedDeclarations = (owned: Pick<Owned, "contracts" | "variants">): Declarations => ({
	contract: (name) => owned.contracts[name]?.desc,
	variant: (name) => owned.variants[name]?.desc
})

/**
 * The field descriptor of one column type, the descriptor of a field that holds every value of it and is of it exactly,
 * so its type is the column's again (scalar/registry.ts scalarTypeOf): numeric of no typmod by its bound
 * (numericBoundDesc), a computed numeric's or numeric's, or the descriptor a declaration of the type writes
 * (declaredDescOf). A derived relation's heading is described by it, and so is a stored field of a read's column.
 * `declared` are the schema's contracts and variants, by name.
 */
export const fieldDescOf = (
	type: ScalarType,
	declared: Declarations
): Result.Result<FieldDesc, Undeclared> =>
	isNumericValue(type) ? Result.ok(numericBoundDesc(type.bound)) : declaredDescOf(type, declared)

/** The schema's declaration `found` of the contract or variant `name`, or why there is none. */
const declaration = (
	kind: Undeclared["kind"],
	name: string,
	found: FieldDesc | undefined
): Result.Result<FieldDesc, Undeclared> =>
	found === undefined ? Result.err({ kind, name }) : Result.ok(found)

/**
 * The descriptor a declaration of `type` writes. A contract column's descriptor is the schema's own declaration of that
 * contract, and a variant column's the schema's own declaration of that variant, its arms' checks with it, so a derived
 * field, a stored field of a read's column and a declared field of one contract or one variant are one descriptor,
 * which one declaration per name holds the schema to (own.ts DuplicateIdentity).
 */
export const declaredDescOf = (
	type: Exclude<ScalarType, NumericValueType>,
	declared: Declarations
): Result.Result<FieldDesc, Undeclared> => {
	const { contract } = type
	if (contract !== undefined) {
		return declaration("domain", contract.name, declared.contract(contract.name))
	}
	switch (type.carrier) {
		case "int2":
			return Result.ok({ kind: "pg", type: "int2" })
		case "int4":
			return Result.ok({ kind: "pg", type: "int4" })
		case "int8":
			return Result.ok({ kind: "pg", type: "int8" })
		case "float4":
			return Result.ok({ kind: "pg", type: "float4" })
		case "float8":
			return Result.ok({ kind: "pg", type: "float8" })
		case "money":
			return Result.ok({ kind: "pg", type: "money" })
		case "bool":
			return Result.ok({ kind: "pg", type: "bool" })
		case "uuid":
			return Result.ok({ kind: "uuid" })
		case "bytes":
			return Result.ok({ kind: "bytes" })
		case "sha256":
			return Result.ok({ kind: "sha256" })
		case "date":
			return Result.ok({ kind: "pg", type: "date" })
		case "inet":
			return Result.ok({ kind: "pg", type: "inet" })
		case "cidr":
			return Result.ok({ kind: "pg", type: "cidr" })
		case "numeric":
			return Result.ok({
				kind: "numeric",
				precision: type.typmod.precision,
				scale: type.typmod.scale
			})
		case "text": {
			const language = languageOfText(type.text)
			return Result.ok({
				kind: "text",
				patterns: textPatterns(type.text),
				bytes: languageOctets(language),
				language
			})
		}
		case "code":
			return Result.ok({ kind: "closedId", roster: type.roster.closed, only: type.only })
		case "bits":
			return Result.ok({ kind: "bits", roster: type.roster.closed })
		case "range4":
		case "range8":
		case "rangeDate": {
			const endpoint = declaredDescOf(type.span.endpoint, declared)
			if (!endpoint.ok) {
				return endpoint
			}
			return Result.ok({ kind: "span", endpoint: endpoint.value, width: type.span.width })
		}
		case "vector":
			return Result.ok({ kind: "vector", dimensions: type.typmod.dims })
		case "tsvector":
			return Result.ok({ kind: "search", configuration: type.configuration })
		case "exactInteger":
		case "exactMoney":
			return Result.ok({ kind: "exact", carrier: type.carrier })
		case "variant":
			return declaration("variant", type.variant.name, declared.variant(type.variant.name))
	}
}
