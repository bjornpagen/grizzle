import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, derivedRefused } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { type Declarations, fieldDescOf } from "#compiler/schema/field-desc.ts"

/**
 * The inferred field descriptors of a definition's heading, by field name in heading order.
 *
 * Field inference for derived relations.
 *
 * Every term in a definition's head carries its descriptor, so a derived relation's heading needs no restatement: the
 * checker types each head term exactly as PostgreSQL types the expression it lowers to (check/checker.ts), and this
 * module states that type as the field descriptor of it (ir/desc.ts FieldDesc, schema/field-desc.ts fieldDescOf), a
 * computed numeric's among them. The rules it realizes, each pinned by
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
	declared: Declarations
): Result.Result<NonEmptyReadonlyArray<C & { readonly desc: FieldDesc }>, CompileError> => {
	const [first, ...rest] = heading
	const head = describedColumn(relation, first, declared)
	if (!head.ok) {
		return head
	}
	const out: [C & { readonly desc: FieldDesc }, ...Array<C & { readonly desc: FieldDesc }>] = [
		head.value
	]
	for (const c of rest) {
		const described = describedColumn(relation, c, declared)
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
	declared: Declarations
): Result.Result<C & { readonly desc: FieldDesc }, CompileError> => {
	const desc = fieldDescOf(c.type, declared)
	if (!desc.ok) {
		const at = SourceLoc(`derived ${relation} field ${c.name}`, [])
		return Result.err(
			derivedRefused(at, {
				kind: "undeclared",
				relation,
				field: c.name,
				declaration: desc.error
			})
		)
	}
	return Result.ok({ ...c, desc: desc.value })
}
