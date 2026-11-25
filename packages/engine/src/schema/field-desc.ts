import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { ContractFieldDesc, FieldDesc } from "#compiler/ir/desc.ts"
import {
	isNumericValue,
	languageOctets,
	languageOfText,
	type NumericValueType,
	type ScalarType,
	textPatterns
} from "#compiler/ir/scalar.ts"
import { numericBoundDesc } from "#compiler/scalar/registry.ts"
import type { OwnedContract } from "#compiler/schema/own.ts"

/**
 * The field descriptor of a column type (ir/desc.ts FieldDesc): what a field holding every value of the type is
 * declared as, read by the schema's builders (a record's fields, program/records.ts) and by the derived analysis (a
 * derived relation's heading, analysis/derived/fields.ts inferredFields) alike, so a builder that describes a column
 * loads none of the analysis.
 */

/**
 * A schema's declaration of each contract, by name: its descriptor, or none for a contract the schema does not declare.
 * An owned schema's (ownedContractsByName) and a level's content's (levels.ts SchemaContent contracts) alike.
 */
export type ContractsByName = (name: string) => ContractFieldDesc | undefined

/** The contracts an owned schema declares (own.ts Owned contracts), by name. */
export const ownedContractsByName =
	(contracts: Readonly<Record<string, OwnedContract>>): ContractsByName =>
	(name) =>
		contracts[name]?.desc

/** Why a column type has no field descriptor: a contract the owned schema does not declare. */
export interface Undescribed {
	readonly kind: "undeclared"
	readonly contract: string
}

/**
 * The field descriptor of one column type, the descriptor of a field that holds every value of it and is of it exactly,
 * so its type is the column's again (scalar/registry.ts scalarTypeOf): numeric of no typmod by its bound
 * (numericBoundDesc), a computed numeric's or pg.numeric's, or the descriptor a declaration of the type writes
 * (declaredDescOf). A derived relation's heading is described by it, and so is a stored field of a read's column.
 * `contracts` are the schema's contracts, by name.
 */
export const fieldDescOf = (
	type: ScalarType,
	contracts: ContractsByName
): Result.Result<FieldDesc, Undescribed> =>
	isNumericValue(type) ? Result.ok(numericBoundDesc(type.bound)) : declaredDescOf(type, contracts)

/**
 * The descriptor a declaration of `type` writes. A contract column's descriptor is the schema's own declaration of that
 * contract, so a derived field and a declared field of one contract are one descriptor.
 */
export const declaredDescOf = (
	type: Exclude<ScalarType, NumericValueType>,
	contracts: ContractsByName
): Result.Result<FieldDesc, Undescribed> => {
	const { contract } = type
	if (contract !== undefined) {
		const declared = contracts(contract.name)
		if (declared === undefined) {
			return Result.err({ kind: "undeclared", contract: contract.name })
		}
		return Result.ok(declared)
	}
	switch (type.carrier) {
		case "int2":
			return Result.ok({ kind: "pg", type: "smallint" })
		case "int4":
			return Result.ok({ kind: "pg", type: "integer" })
		case "int8":
			return Result.ok({ kind: "pg", type: "bigint" })
		case "float4":
			return Result.ok({ kind: "pg", type: "real" })
		case "float8":
			return Result.ok({ kind: "pg", type: "double precision" })
		case "money":
			return Result.ok({ kind: "pg", type: "money" })
		case "bool":
			return Result.ok({ kind: "pg", type: "boolean" })
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
			const endpoint = declaredDescOf(type.span.endpoint, contracts)
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
	}
}
