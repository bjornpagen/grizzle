import { type CompileError, derivedRefused } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { OwnedContract } from "#compiler/schema/own.ts"
import { wildcardFlags, wildcardSource } from "#compiler/text/refinement.ts"

/** A field type's contract that the owned schema does not declare. */
interface UndeclaredContract {
	readonly contract: string
}

/**
 * The field descriptor of one inferred column type. `contracts` are the owned schema's contracts: a contract column's
 * descriptor is the schema's own declaration of that contract, so a derived field and a declared field of one
 * contract are one descriptor.
 */
export const fieldDescOf = (
	type: ScalarType,
	contracts: Readonly<Record<string, OwnedContract>>
): Result.Result<FieldDesc, UndeclaredContract> => {
	const contract = contractOf(type)
	if (contract !== undefined) {
		const declared = contracts[contract.name]
		if (declared === undefined) {
			return Result.err({ contract: contract.name })
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
		case "numeric": {
			const { typmod } = type
			return Result.ok(
				typmod === undefined
					? { kind: "numeric" }
					: { kind: "numeric", precision: typmod.precision, scale: typmod.scale }
			)
		}
		case "text": {
			const { regex } = type.text
			return Result.ok(
				regex === "wildcard"
					? { kind: "text", source: wildcardSource, flags: wildcardFlags }
					: { kind: "text", source: regex.source, flags: regex.flags }
			)
		}
		case "enum":
			return Result.ok({ kind: "closedId", roster: type.roster.closed })
		case "range4":
		case "range8": {
			const endpoint = fieldDescOf(type.span.endpoint, contracts)
			if (!endpoint.ok) {
				return endpoint
			}
			return Result.ok({ kind: "span", endpoint: endpoint.value, width: type.span.width })
		}
		case "vector":
			return Result.ok({ kind: "vector", dimensions: type.typmod.dims })
	}
}

/**
 * The inferred field descriptors of a definition's heading, by field name in heading order.
 *
 * Field inference for derived relations.
 *
 * Every term in a definition's head carries its descriptor, so a derived relation's heading needs no restatement: the
 * checker types each head term exactly as PostgreSQL types the expression it lowers to (check/checker.ts), and this
 * module states that type as the field descriptor a declaration would have written (ir/desc.ts FieldDesc), the
 * vocabulary of the schema snapshot. The rules it realizes, each pinned by test/unit/derived/fields.test.ts:
 *
 * - `r.count()` is `pg.bigint`;
 * - `r.sum` is the native SUM result type: smallint and integer give bigint, bigint and numeric give numeric, real and
 *   double precision keep their type, money keeps money; `r.mean` is the native AVG result type:
 *   numeric over the integers and numeric, double precision over the floats. A numeric result carries no typmod, since
 *   SUM and AVG do not inherit an input precision or scale;
 * - a contract field, or its `min` or `max`, keeps its brand and its domain; its `sum` or `mean` has its base's result
 *   type;
 * - a regex-refined text field keeps its pattern; a computed text value whose pattern is not preserved has the
 *   canonical wildcard, `^.*$` under `su` (text/refinement.ts);
 * - a closed id keeps its roster;
 * - a serial field read through a definition is a plain integer of its width: generation is a property of the stored
 *   column, not of the value, and a materialized view has no identity column.
 */
export const inferredFields = <C extends HeadingColumn>(
	relation: string,
	heading: NonEmptyReadonlyArray<C>,
	contracts: Readonly<Record<string, OwnedContract>>
): Result.Result<NonEmptyReadonlyArray<C & { readonly desc: FieldDesc }>, CompileError> => {
	const [first, ...rest] = heading
	const head = describedColumn(relation, first, contracts)
	if (!head.ok) {
		return head
	}
	const out: [C & { readonly desc: FieldDesc }, ...Array<C & { readonly desc: FieldDesc }>] = [
		head.value
	]
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
): Result.Result<C & { readonly desc: FieldDesc }, CompileError> => {
	const desc = fieldDescOf(c.type, contracts)
	if (!desc.ok) {
		return Result.err(
			derivedRefused(SourceLoc(`derived ${relation} field ${c.name}`, []), {
				kind: "undeclaredContract",
				relation,
				field: c.name,
				contract: desc.error.contract
			})
		)
	}
	return Result.ok({ ...c, desc: desc.value })
}
