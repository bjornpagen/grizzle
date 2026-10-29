import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { SerialClass } from "#compiler/ir/write.ts"
import {
	cast,
	desc,
	lit,
	qualifiedCall,
	simpleSelect,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { printType } from "#compiler/sql/print.ts"
import { type RereadInput, scanInput, skipWhenEmptyOf } from "#compiler/write/insert/input.ts"
import {
	buildStatement,
	ownBuild,
	type SequenceAdvanceResult,
	isSerialField,
	keyFirst,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

/** Whether an addition's facts carry explicit serial values: complete facts of a relation with serial fields, an
 * insertion's or a put's. Those are inserted OVERRIDING SYSTEM VALUE and followed by the sequence advance. */
export const carriesSerial = (relation: RelationInfo, serial: SerialClass): boolean =>
	serial === "complete" && relation.serial.length > 0

interface AdvanceSpec {
	readonly relation: RelationInfo
	/** The input the explicit-serial insert read, which the advance reads again: its relation parameter or its carrier. */
	readonly input: RereadInput
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The advance of one serial field `field`. A serial field is typed by its serial declaration (`SerialType`), over an
 * integer carrier, so its value casts to the advance function's bigint parameter. */
export const buildSequenceAdvance = (
	w: WriteContext,
	spec: AdvanceSpec,
	field: LawField
): WriteStatement<SequenceAdvanceResult> => {
	const { relation, input } = spec
	const at = `sequence advance ${relation.name}.${field.name}`
	return buildStatement(w, ownBuild, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const { from, read } = scanInput(w, input, field.name, scan, at)
		const value = read.value
		const advance = w.names.advance(relation.name, field.name)
		const output = supply.column(internal("advance"))
		const sqlType = read.type.sqlType
		const argument =
			sqlType !== undefined && printType(sqlType) === printType(types.bigint)
				? value
				: cast(value, types.bigint)
		const ast = {
			...simpleSelect(
				[
					targetAs(
						cast(qualifiedCall(advance.schema, advance.name, [argument]), types.text),
						output
					)
				],
				[from],
				undefined
			),
			orderBy: [desc(value)],
			limit: lit.int(1, types.integer)
		}
		return {
			ast,
			role: "setval",
			result: { kind: "sequenceAdvance", relation: relation.name, field: field.name },
			skipWhenEmpty: skipWhenEmptyOf(input)
		}
	})
}

/** The serial fields of a relation in the order their advances run: key-first, as every write statement lists them. */
export const serialOrder = (relation: RelationInfo): ReadonlyArray<LawField> =>
	keyFirst(relation).filter(isSerialField)

/** One sequence advance per serial field of the relation.
 *
 * Generated identities: the sequence advance after explicit serial values.
 *
 * A serial field is GENERATED ALWAYS AS IDENTITY, and its sequence advances only when the column default is used, so
 * an explicitly supplied value beyond the sequence's position leaves it behind and a later generated value can equal
 * the stored one. An apply that inserts explicit serial values, an addition that supplies them or a put,
 * whose members are complete facts, therefore advances each sequence past them in the same transaction,
 * with a statement pipelined after the insert that reads the same input: the relation parameter again, or the carrier a
 * described member travels in, since a described member that two statements read is consumed sequentially.
 * One statement per serial field, each calling that field's advance function with the largest value written:
 *
 *   SELECT "work"."__advance_ticket__id"("r0"."c1"::bigint)::text AS "c2"
 *   FROM jsonb_to_recordset($1::jsonb) AS "r0"("c1" bigint, ...)
 *   ORDER BY "r0"."c1" DESC
 *   LIMIT 1
 *
 * The advance function is the installation's: it moves the sequence to the value given only
 * when that is at least the next value the sequence would generate, never back, and returns nothing. It runs as the
 * owner, so a role that writes the relation holds EXECUTE on it and no privilege on the sequence: it can neither read
 * the sequence's position, which counts every fact ever generated, the ones outside its world included, nor set it
 * back or ahead for the other logins that draw from it.
 *
 * Advancing past every input value is safe: an exact repeat is already stored, a conflict rolls the transaction back,
 * and a put that re-inserts a stored key normally finds the sequence past it, so the call changes nothing. setval is
 * not rolled back with an aborted transaction, which only leaves a gap. The function's name comes from the installed
 * names (the snapshot's). A serial value of smallint or integer type is cast to bigint, the function's parameter type,
 * so no implicit coercion is emitted. */
export const buildSequenceAdvances = (
	w: WriteContext,
	spec: AdvanceSpec
): ReadonlyArray<WriteStatement<SequenceAdvanceResult>> =>
	serialOrder(spec.relation).map((field) => buildSequenceAdvance(w, spec, field))
