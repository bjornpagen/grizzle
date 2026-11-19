import { StoredRelationName } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { always } from "#compiler/ir/needs.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import type { Expr, ObjectName, SetOperand, TypeRef } from "#compiler/sql/ast.ts"
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
import type { HeldUnit, RetiredUnit, StatedGroups, WriteUnit } from "#compiler/write/hold/stated.ts"
import { readInputFields } from "#compiler/write/insert/input.ts"
import {
	buildStatement,
	type HoldResult,
	ownBuild,
	type RetireResult,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/**
 * A call of a retirable unit's function over the groups a write states, one statement: its hold, before the first of
 * the write's statements that touches the unit (write/schedule/plan.ts placeHolds); or its retirement, in the stratum
 * whose retire members state its groups. Every group each source states, a member slot's rows at their group's fields
 * and a row of scalar parameters (StatedGroups), each value cast to its key field's column type, is one row of the
 * function's call over their arrays, one per key field in key order, aggregated in lockstep:
 *
 *   SELECT "<schema>"."<hold | retire>"(
 *            (pg_catalog.array_agg("r0"."c1" ORDER BY "r0"."c1", "r0"."c2"))::<key 1>[],
 *            (pg_catalog.array_agg("r0"."c2" ORDER BY "r0"."c1", "r0"."c2"))::<key 2>[])::text AS "c3"
 *   FROM (SELECT ... FROM unnest($1, ...) ... UNION ALL SELECT $4::<key 1>, $5::<key 2>) AS "r0"("c1", "c2")
 *
 * The functions (physical/ddl/retire.ts addUnitFunctions) take each group once. The hold locks the open header of each
 * in key order, FOR KEY SHARE, until the transaction ends, so no retirement of a group the write states commits while it
 * runs, and refuses a group whose header is absent or retired on the fence of the unit's first body, as the refusal
 * function raises a law (write/refusal.ts); its one row carries nothing to decode. The retirement locks the open header
 * of each FOR UPDATE, so it waits for every call that holds one, then removes the groups' rows and sets their headers'
 * retirement field, and its one row is its counts, the groups it retired, then each body's rows it removed, in body
 * order, one bigint array (RetireResult). A write that states no group touches nothing: array_agg over no row is NULL,
 * which each function reads as no group, and a retirement of none counts nothing.
 */
const buildUnitCall = <R extends HoldResult | RetireResult>(
	w: WriteContext,
	unit: WriteUnit,
	stated: NonEmptyReadonlyArray<StatedGroups>,
	unitCall: UnitCall<R>
): WriteStatement<R> => {
	const at = `${unitCall.result.kind} of ${unit.header}`
	const element = (key: LawField): TypeRef => fieldColumnType(w.names, key.type).type
	return buildStatement(w, ownBuild, (supply) => {
		const arm = (groups: StatedGroups): SetOperand => {
			if (groups.kind === "params") {
				return core(
					groups.params.map((p) =>
						target(cast(w.cx.scalarParam(p.id, p.type, at), element(p.key)))
					),
					[],
					undefined
				)
			}
			const { from, read } = readInputFields(w, groups.input, at)
			return core(
				groups.group.map((g) => target(cast(read(g.field).value, element(g.key)))),
				[from],
				undefined
			)
		}
		const relation = supply.relation(internal(`${unitCall.result.kind} groups`))
		const keyed = mapNonEmpty(unit.key, (key) => ({
			key,
			column: supply.column(internal(`${unitCall.result.kind} group`))
		}))
		const order = keyed.map((k) => asc(col(relation, k.column)))
		const arrays = keyed.map((k): Expr => {
			const array = arrayOf(element(k.key))
			if (array === undefined) {
				throw defect(`a retirable key field ${unit.header}.${k.key.name} of a type with an array`)
			}
			return cast({ ...call("array_agg", [col(relation, k.column)]), orderBy: order }, array)
		})
		const fn = unitCall.name(w.names, unit.header)
		const output = supply.column(internal(unitCall.result.kind))
		const groups = derived(
			operandSelect(operandUnionAll(mapNonEmpty(stated, arm))),
			relation,
			keyed.map((k) => k.column),
			false
		)
		return {
			ast: provedSelect(
				"oneRow",
				[targetAs(cast(qualifiedCall(fn.schema, fn.name, arrays), types.text), output)],
				[groups],
				undefined
			),
			role: "call",
			result: unitCall.result,
			needs: always
		}
	})
}

/** Which of a unit's functions a call is, as its statement names it and reads its row (`buildUnitCall`). */
interface UnitCall<R extends HoldResult | RetireResult> {
	readonly name: (names: WriteContext["names"], header: string) => ObjectName
	readonly result: R
}

/** The hold of the groups a write states of `held`'s unit (`buildUnitCall`). */
export const buildHold = (w: WriteContext, held: HeldUnit): WriteStatement<HoldResult> =>
	buildUnitCall(w, held.unit, held.stated, {
		name: (names, header) => names.hold(header),
		result: { kind: "hold", header: held.unit.header }
	})

/** The retirement of the groups a stratum's retire members state of `retired`'s unit (`buildUnitCall`). */
export const buildRetire = (w: WriteContext, retired: RetiredUnit): WriteStatement<RetireResult> =>
	buildUnitCall(w, retired.unit, retired.stated, {
		name: (names, header) => names.retire(header),
		result: {
			kind: "retire",
			header: retired.unit.header,
			bodies: [...retired.unit.bodies.keys()].map(StoredRelationName)
		}
	})
