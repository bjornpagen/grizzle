import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { SerialClass } from "#compiler/ir/write.ts"
import {
	cast,
	desc,
	lit,
	provedSelect,
	qualifiedCall,
	sameTypeRef,
	targetAs,
	types
} from "#compiler/sql/build.ts"
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

/** The serial fields an addition of class `serial` carries, key-first as every write statement lists them, each an
 * explicit serial value: inserted OVERRIDING SYSTEM VALUE and followed by its sequence advance. Complete facts carry
 * every serial field of their relation, an insertion's or a put's; a generated addition every one it does not draw. */
export const explicitSerials = (
	relation: RelationInfo,
	serial: SerialClass
): ReadonlyArray<LawField> =>
	keyFirst(relation).filter(
		(f) => isSerialField(f) && (serial.kind === "complete" || !serial.drawn.includes(f.name))
	)

interface AdvanceSpec {
	readonly relation: RelationInfo
	/** The input the explicit-serial insert read, which the advance reads again: its relation parameter or its carrier. */
	readonly input: RereadInput
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The advance of one serial field `field`. A serial field's type is its integer, written by its sequence (its
 * writing, ir/law.ts FieldWriting), so its value casts to the advance function's bigint parameter. */
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
			sqlType !== undefined && sameTypeRef(sqlType, types.bigint)
				? value
				: cast(value, types.bigint)
		const ast = {
			...provedSelect(
				"oneRow",
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

/** One sequence advance per explicit serial field `fields` an addition carries (explicitSerials).
 *
 * Generated identities: the sequence advance after explicit serial values.
 *
 * A serial field is GENERATED ALWAYS AS IDENTITY, and its sequence advances only when the column default is used, so
 * an explicitly supplied value beyond the sequence's position leaves it behind and a later generated value can equal
 * the stored one. An apply that inserts explicit serial values, an addition that supplies them (complete facts, or a
 * generated addition's serial fields its entry's filter reads or its fill fixes) or a put, therefore advances each such
 * sequence past them in the same transaction,
 * with a statement pipelined after the insert that reads the same input: the relation parameter again, or the carrier a
 * described member travels in, since a described member that two statements read is consumed sequentially.
 * One statement per explicit serial field, each calling that field's advance function with the largest value written:
 *
 *   SELECT "work"."__advance_ticket__id"("r0"."c1"::bigint)::text AS "c2"
 *   FROM (SELECT pg_catalog.unnest($1::bigint[]) AS "c1", ...) AS "r0"
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
	spec: AdvanceSpec,
	fields: ReadonlyArray<LawField>
): ReadonlyArray<WriteStatement<SequenceAdvanceResult>> =>
	fields.map((field) => buildSequenceAdvance(w, spec, field))
