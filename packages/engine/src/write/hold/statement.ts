import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import type { Expr, SetOperand, TypeRef } from "#compiler/sql/ast.ts"
import {
	arrayOf,
	asc,
	call,
	cast,
	col,
	core,
	derived,
	operandSelect,
	operandUnionAll,
	provedSelect,
	qualifiedCall,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import type { HeldUnit, StatedGroups } from "#compiler/write/hold/stated.ts"
import { readInputFields } from "#compiler/write/insert/input.ts"
import {
	buildStatement,
	type HoldResult,
	ownBuild,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/**
 * The hold of the groups a write states of a retirable unit, one statement, before the first of the write's statements
 * that touches the unit (write/schedule/plan.ts placeHolds): every group each source states, a member slot's rows at
 * their group's fields and a row of scalar parameters (StatedGroups), each value cast to its key field's column type,
 * one row of the unit's hold function over their arrays, one per key field in key order, aggregated in lockstep:
 *
 *   SELECT "<schema>"."<hold>"(
 *            (pg_catalog.array_agg("r0"."c1" ORDER BY "r0"."c1", "r0"."c2"))::<key 1>[],
 *            (pg_catalog.array_agg("r0"."c2" ORDER BY "r0"."c1", "r0"."c2"))::<key 2>[])::text AS "c3"
 *   FROM (SELECT ... FROM unnest($1, ...) ... UNION ALL SELECT $4::<key 1>, $5::<key 2>) AS "r0"("c1", "c2")
 *
 * The function (physical/ddl/retire.ts addUnitFunctions) takes each group once and locks the open header of each in key
 * order, FOR KEY SHARE, until the transaction ends, so no retirement of a group the write states commits while it runs;
 * and it refuses a group whose header is absent or retired on the fence of the unit's first body, as the refusal
 * function raises a law (write/refusal.ts). A write that states no group locks nothing: array_agg over no row is NULL,
 * which the function reads as no group. Its one row carries nothing to decode.
 */
export const buildHold = (w: WriteContext, held: HeldUnit): WriteStatement<HoldResult> => {
	const { unit } = held
	const at = `hold of ${unit.header}`
	const element = (key: LawField): TypeRef => columnType(w.names, key.type).type
	return buildStatement(w, ownBuild, (supply) => {
		const arm = (stated: StatedGroups): SetOperand => {
			if (stated.kind === "params") {
				return core(
					stated.params.map((p) =>
						target(cast(w.cx.scalarParam(p.id, p.type, at), element(p.key)))
					),
					[],
					undefined
				)
			}
			const { from, read } = readInputFields(w, stated.input, at)
			return core(
				stated.group.map((g) => target(cast(read(g.field).value, element(g.key)))),
				[from],
				undefined
			)
		}
		const groups = supply.relation(internal("held groups"))
		const keyed = mapNonEmpty(unit.key, (key) => ({
			key,
			column: supply.column(internal("held group"))
		}))
		const order = keyed.map((k) => asc(col(groups, k.column)))
		const arrays = keyed.map((k): Expr => {
			const array = arrayOf(element(k.key))
			if (array === undefined) {
				throw defect(`a retirable key field ${unit.header}.${k.key.name} of a type with an array`)
			}
			return cast({ ...call("array_agg", [col(groups, k.column)]), orderBy: order }, array)
		})
		const hold = w.names.hold(unit.header)
		const output = supply.column(internal("hold"))
		const stated = derived(
			operandSelect(operandUnionAll(mapNonEmpty(held.stated, arm))),
			groups,
			keyed.map((k) => k.column),
			false
		)
		return {
			ast: provedSelect(
				"oneRow",
				[targetAs(cast(qualifiedCall(hold.schema, hold.name, arrays), types.text), output)],
				[stated],
				undefined
			),
			role: "setval",
			result: { kind: "hold", header: unit.header },
			skipWhenEmpty: undefined
		}
	})
}
