import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, derivedRefused } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc, InferredFieldDesc } from "#compiler/ir/desc.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import {
	isNumericValue,
	languageOctets,
	languageOfText,
	type NumericValueType,
	type ScalarType,
	textPatterns
} from "#compiler/ir/scalar.ts"
import type { OwnedContract } from "#compiler/schema/own.ts"

/** Why a column type has no field descriptor: a contract the owned schema does not declare. */
interface Undescribed {
	readonly kind: "undeclared"
	readonly contract: string
}

/**
 * The field descriptor of one inferred column type: a computed numeric's bound, or the descriptor a declaration of the
 * type writes (declaredDescOf). `contracts` are the owned schema's contracts.
 */
export const fieldDescOf = (
	type: ScalarType,
	contracts: Readonly<Record<string, OwnedContract>>
): Result.Result<InferredFieldDesc, Undescribed> =>
	isNumericValue(type)
		? Result.ok({ kind: "computedNumeric", bound: type.bound })
		: declaredDescOf(type, contracts)

/**
 * The descriptor a declaration of `type` writes. A contract column's descriptor is the schema's own declaration of that
 * contract, so a derived field and a declared field of one contract are one descriptor.
 */
export const declaredDescOf = (
	type: Exclude<ScalarType, NumericValueType>,
	contracts: Readonly<Record<string, OwnedContract>>
): Result.Result<FieldDesc, Undescribed> => {
	const { contract } = type
	if (contract !== undefined) {
		const declared = contracts[contract.name]
		if (declared === undefined) {
			return Result.err({ kind: "undeclared", contract: contract.name })
		}
		return Result.ok(declared.desc)
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

/**
 * The inferred field descriptors of a definition's heading, by field name in heading order.
 *
 * Field inference for derived relations.
 *
 * Every term in a definition's head carries its descriptor, so a derived relation's heading needs no restatement: the
 * checker types each head term exactly as PostgreSQL types the expression it lowers to (check/checker.ts), and this
 * module states that type as the field descriptor a declaration would have written (ir/desc.ts FieldDesc), or as the
 * computed numeric no declaration writes (ir/desc.ts InferredFieldDesc). The rules it realizes, each pinned by
 * test/unit/derived/fields.test.ts:
 *
 * - `r.count()` is `natural`, which every schema holds (schema/own.ts #collectFields; test/unit/check/count.test.ts);
 * - `r.sum` is numeric over the integers and numeric, the result type of the bigint and numeric SUM it lowers to (a
 *   sum over smallint or integer is summed as bigint, scalar/aggregate.ts `widened`), and real and double precision
 *   keep their type; money gives exact money, an exactMoney field (the amounts summed cast to numeric), and integer or
 *   money arithmetic its exact integer or exact money, a field of any size of it (ir/desc.ts FieldDesc exact), its view
 *   column the head's own type, bigint of at most 18 digits and numeric otherwise, which every read of the view types
 *   it by; `r.mean` is the native AVG result type:
 *   numeric over the integers and numeric, double precision over the floats. A numeric result carries no typmod, since
 *   SUM and AVG do not inherit an input precision or scale, but the bound its definition proves (ir/scalar.ts
 *   NumericBound), which every read of the field then has;
 * - a contract field, or its `min` or `max`, keeps its brand and its domain; its `sum` or `mean` has its base's result
 *   type;
 * - a regex-refined text field keeps its patterns; a computed text value whose patterns are not preserved has the
 *   canonical wildcard, `^.*$` under `su` (ir/scalar.ts wildcardPattern);
 * - a closed id keeps its roster.
 */
export const inferredFields = <C extends HeadingColumn>(
	relation: string,
	heading: NonEmptyReadonlyArray<C>,
	contracts: Readonly<Record<string, OwnedContract>>
): Result.Result<NonEmptyReadonlyArray<C & { readonly desc: InferredFieldDesc }>, CompileError> => {
	const [first, ...rest] = heading
	const head = describedColumn(relation, first, contracts)
	if (!head.ok) {
		return head
	}
	const out: [
		C & { readonly desc: InferredFieldDesc },
		...Array<C & { readonly desc: InferredFieldDesc }>
	] = [head.value]
	for (const c of rest) {
		const described = describedColumn(relation, c, contracts)
		if (!described.ok) {
			return described
		}
		out.push(described.value)
	}
	return Result.ok(out)
}

/** A column of a derived relation's heading with its inferred field descriptor. */
const describedColumn = <C extends HeadingColumn>(
	relation: string,
	c: C,
	contracts: Readonly<Record<string, OwnedContract>>
): Result.Result<C & { readonly desc: InferredFieldDesc }, CompileError> => {
	const desc = fieldDescOf(c.type, contracts)
	if (!desc.ok) {
		const at = SourceLoc(`derived ${relation} field ${c.name}`, [])
		return Result.err(
			derivedRefused(at, {
				kind: "undeclaredContract",
				relation,
				field: c.name,
				contract: desc.error.contract
			})
		)
	}
	return Result.ok({ ...c, desc: desc.value })
}
