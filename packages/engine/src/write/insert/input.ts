import type { ParamId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { contextAdmits } from "#compiler/ir/evidence.ts"
import { type KeyProof, keyIn } from "#compiler/ir/keys.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	arraysSource,
	columnIn,
	columnType,
	emptyEnv,
	outputNames,
	relationColumns
} from "#compiler/lower/conservative/context.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { Expr, FromItem, Select } from "#compiler/sql/ast.ts"
import {
	arrays,
	cast,
	col,
	columnDefinition,
	derived,
	distinctCoreWhen,
	sameTypeRef,
	select,
	target,
	unitTargets
} from "#compiler/sql/build.ts"
import { type Carrier, carrierField, carrierScan } from "#compiler/write/carriers/carriers.ts"
import type { FieldColumns } from "#compiler/write/defined.ts"
import {
	type InputColumnType,
	isSerialField,
	keyFirst,
	type KeyPart,
	type Made,
	ownBuild,
	rowType,
	type Shared,
	type Sharing,
	unrefined,
	type WriteContext,
	writeValue
} from "#compiler/write/insert/statement.ts"

/** How a statement over `inputs` is built under `key` in `memo` (`Sharing`): its own when it reads a
 * described member, shared otherwise. */
export const inputSharing = <B>(
	memo: Shared<Made<B>>,
	inputs: ReadonlyArray<WriteInput>,
	key: ReadonlyArray<KeyPart>
): Sharing<B> =>
	inputs.some((i) => i.kind === "described") ? ownBuild : { kind: "shared", memo, key }

/**
 * Why no two distinct rows of an input share a primary key value, so the same-key check is elided: the codec's host
 * normalization of a relation parameter, an array or a collected Stream; a proof that the member's key columns are a
 * key of it; or nothing proved.
 */
export type KeyUniqueness =
	| { readonly kind: "normalized" }
	| { readonly kind: "proved"; readonly proof: KeyProof }
	| { readonly kind: "unproved" }

/** What the input's evidence proves about it, beyond what its form guarantees. */
export interface InputProof {
	/** The input holds no repeated row: SELECT DISTINCT is elided. */
	readonly distinct: boolean
	readonly keyUnique: KeyUniqueness
}

/** Whether an input's rows are unique on its primary key, by any of the reasons. */
export const keyUniqueBy = (u: KeyUniqueness): boolean => u.kind !== "unproved"

/** Nothing proved: the statement deduplicates the input and checks it for same-key pairs. */
export const unproved: InputProof = Object.freeze({
	distinct: false,
	keyUnique: { kind: "unproved" } as const
})

/** A host-normalized relation parameter, an array or a collected Stream, is both distinct and key-unique by the codec. */
const normalized: InputProof = Object.freeze({
	distinct: true,
	keyUnique: { kind: "normalized" } as const
})

export type WriteInput =
	| RelationInput
	| { readonly kind: "carrier"; readonly carrier: Carrier; readonly proof: InputProof }
	| { readonly kind: "described"; readonly node: RelNode; readonly proof: InputProof }

/** An input a second statement reads again: a relation parameter or a carrier. A described member read inline is the
 * one statement's that reads it, so a member two statements read is carried. */
export type RereadInput = Exclude<WriteInput, { readonly kind: "described" }>

/** A relation parameter: the slot's facts, its columns in key-first order, so every statement reading it declares its
 * arrays alike. */
export interface RelationInput {
	readonly kind: "relation"
	readonly slot: ParamId
	readonly relation: string
	readonly heading: Heading
}

/** The relation input of the slot `slot` whose facts carry `heading`, of `relation`: built once, with its slot
 * (`MemberSlot.input`), and a slot is one action's, so the plan and the conservative realization read one input, and the
 * statements each builds over it are one request (`StatementShare`). */
export const relationInput = (
	slot: ParamId,
	heading: Heading,
	relation: RelationInfo
): RelationInput =>
	Object.freeze({
		kind: "relation",
		slot,
		relation: relation.name,
		heading: keyFirst(relation).flatMap((f) => heading.filter((c) => c.name === f.name))
	})

/** The enumerated input whose emptiness lets the runtime skip a statement over `input`: a relation parameter's slot;
 * a carrier or a described member is no enumerated input. */
export const skipWhenEmptyOf = (input: WriteInput): ParamId | undefined =>
	input.kind === "relation" ? input.slot : undefined

/** What the statement may rely on: a relation input everything, any other input its proof. */
export const inputGuarantees = (input: WriteInput): InputProof =>
	input.kind === "relation" ? normalized : input.proof

/** The fields an input carries: a slot's heading, a carrier's, or a described member's head. */
export const inputHeading = (input: WriteInput): Heading => {
	switch (input.kind) {
		case "relation":
			return input.heading
		case "carrier":
			return input.carrier.heading
		case "described":
			return input.node.heading
	}
}

/** One input read for a statement: the query that projects `fields`, and each projected column's type. */
interface InputRead {
	readonly select: Select
	readonly types: ReadonlyArray<InputColumnType>
}

/** How a statement reads its input as a query (readInput), each column cast into its field's type inside the read as
 * `into` says, so the input holds the facts as they are written. A member column typed only compatibly with its field,
 * such as a numeric with another typmod, changes value under that cast, so every comparison the statement makes over
 * the input, SELECT DISTINCT, the same-key check, the ORDER BY, the inserted marker c7, an exact or a displacing
 * deletion and D EXCEPT A, must read it after the cast, never before.
 *
 * - input: the statement's input CTE, its fields in order under the statement's scan alias (r0), a relation
 *   parameter's array columns named after the CTE's columns (r1(c1, c2, c3) reads r0(c1, c2, c3)), so `fields`
 *   covers the parameter's heading;
 * - except: an addition a deletion excepts, under a fresh alias, a relation parameter's arrays following its
 *   heading as given with fresh names, so every statement that reads one relation parameter declares its columns in
 *   one order. */
type ReadOptions =
	| {
			readonly kind: "input"
			readonly fields: ReadonlyArray<LawField>
			readonly distinct: boolean
			readonly alias: string
			readonly keys: FieldColumns<string>
			readonly into: CastInto
	  }
	| { readonly kind: "except"; readonly fields: ReadonlyArray<LawField>; readonly into: CastInto }

/** How an input is read as the facts of its fields' relation, field by field. */
interface CastInto {
	/** write: into the column's type, a contract's or a refinement's domain included, as an insert writes it
	 * (`writeValue`). compare: into the column's base type with its typmod only, the cast that
	 * can change a value, for a deletion, which only compares the input against stored facts: a value outside a
	 * domain cannot be stored, so it matches no fact instead of raising the domain's check. */
	readonly as: "write" | "compare"
}

/** One input value read as a fact of the relation, and its SQL type after the cast (CastInto). */
const castInto = (
	w: WriteContext,
	value: Expr,
	from: InputColumnType,
	to: ScalarType,
	as: CastInto["as"],
	at: string
): { readonly value: Expr; readonly type: InputColumnType } => {
	if (as === "write") {
		return {
			value: writeValue(w, value, from, to, at),
			type: { type: to, sqlType: w.cx.typeRef(to, at) }
		}
	}
	/** A domain value compares as its base, so only a base type or typmod that differs is cast. */
	const toBase = w.cx.baseTypeRef(to)
	const fromBase = w.cx.baseTypeRef(from.type)
	return {
		value: sameTypeRef(fromBase, toBase) ? value : cast(value, toBase),
		type: { type: to, sqlType: toBase }
	}
}

/** Where an input's columns are read from: under the statement's scan alias with a relation parameter's array columns
 * named after its input CTE's columns, under the statement's scan alias with fresh names, or under a fresh alias with
 * fresh names. */
type Naming =
	| { readonly kind: "named"; readonly alias: string; readonly keys: FieldColumns<string> }
	| { readonly kind: "aliased"; readonly alias: string }
	| { readonly kind: "fresh" }

/** One field of an input as read, uncast. */
interface FieldRead {
	readonly field: string
	readonly value: Expr
	readonly type: InputColumnType
}

/** The FROM item that reads an input, and how it reads a field by its name; a relation parameter's array columns are
 * named after the input CTE's columns (`Naming`), in the statement's field order. */
const inputColumns = (
	w: WriteContext,
	input: WriteInput,
	naming: Naming,
	at: string
): { readonly from: FromItem; readonly read: (field: string) => FieldRead } => {
	const heading = inputHeading(input)
	/** A statement reads the fields of its relation the input carries: a slot's and a carrier's heading are the relation's
	 * (less a generated addition's serial fields), and a described member's head is, which the checker holds it to
	 * (`checkMemberHeading`). */
	const typeOf = (field: string) => columnType(heading, field)
	const aliasOf = (origin: Parameters<WriteContext["cx"]["relationAlias"]>[0]): string =>
		naming.kind === "fresh" ? w.cx.relationAlias(origin) : naming.alias
	switch (input.kind) {
		case "relation": {
			const origin = { kind: "param", param: input.slot } as const
			const base = (type: ScalarType) => w.cx.baseTypeRef(type)
			const slots = w.cx.member(
				input.slot,
				input.relation,
				() =>
					naming.kind === "named"
						? naming.keys.pairs.map((p) => {
								const type = columnType(input.heading, p.field.name)
								return {
									name: p.field.name,
									type,
									definition: columnDefinition(p.column, base(type))
								}
							})
						: relationColumns(input.heading, () => w.cx.supply.column(origin), base),
				at
			)
			const alias = aliasOf(origin)
			const columnOf = new Map(slots[0].columns.map((c) => [c.name, c] as const))
			return {
				from: arrays(arraysSource(slots), alias),
				read: (field) => {
					const { definition } = columnIn(columnOf, field)
					return {
						field,
						value: col(alias, definition.name),
						type: { type: typeOf(field), sqlType: definition.type }
					}
				}
			}
		}
		case "carrier": {
			const alias = aliasOf({ kind: "internal", purpose: "carrier scan" })
			return {
				from: carrierScan(input.carrier, alias),
				read: (field) => {
					const type = typeOf(field)
					return {
						field,
						value: col(alias, carrierField(input.carrier, field).column),
						type: { type, sqlType: w.cx.typeRef(type, at) }
					}
				}
			}
		}
		case "described": {
			const node = input.node
			const lowered = w.cx.lower(node, emptyEnv)
			/** Read as a derived table under the statement's scan alias when it allocated one (r0), otherwise a fresh one. */
			const origin = { kind: "node", node: node.id } as const
			const named = w.cx.freshColumns(outputNames(node.heading), origin)
			const columnOf = new Map(named.map((n) => [n.name, n.column] as const))
			const alias = aliasOf(origin)
			return {
				from: derived(
					lowered,
					alias,
					named.map((n) => n.column),
					false
				),
				read: (field) => {
					return {
						field,
						value: col(alias, columnIn(columnOf, field)),
						type: { type: typeOf(field), sqlType: undefined }
					}
				}
			}
		}
	}
}

/** Reads an input as a query of its fields (ReadOptions).
 *
 * How a write statement reads its member.
 *
 * A member reaches a write statement in one of three forms, and the form decides what the statement must do itself:
 *
 * - relation: an enumerated member (an array, or a Stream collected on the host), read through its arrays,
 *   `(SELECT pg_catalog.unnest($n::<base type>[]) AS c1, ...) AS r0`, one placeholder per column (sql/print.ts). The
 *   host codec owns its set property and its null ban: it deduplicates complete facts and refuses same-key conflicts,
 *   so "the input is a set without a DISTINCT and the statement never sees a null", and the statement has no
 *   same-key check of its own. Each array's element type is its column's base type, and its column names are
 *   recorded in the statement's member slots.
 * - carrier: a transaction-scoped carrier (carriers/), which nobody normalized on the host.
 * - described: a member described by a query, a node of the write DAG, lowered as a leading CTE of the statement.
 *   It is evaluated once: the check and the INSERT both reference it, so PostgreSQL materializes it once and both
 *   read the same rows.
 *
 * A carrier or a described member is read through SELECT DISTINCT, and an insert gates its arbiter INSERT with the
 * same-key check, unless the input's evidence proves it distinct, or unique on the primary key, which elides the
 * corresponding step. The conservative realization never supplies a proof;
 * keyUniqueByEvidence reads one from the write DAG's immediate-evidence keys, and distinctByEvidence one from the
 * physical keys of the member as the optimized artifact lowers it.
 *
 * A read of no field, the generated class of a target whose every carried field is serial, is the unit relation: it
 * reads the unit marker, one row of no field for each fact the input holds, `SELECT DISTINCT true FROM
 * pg_catalog.generate_series(1::bigint, $n::bigint) AS r0` for a relation parameter, $n its count, so its input CTE
 * lists no column and an insert over it assigns none. */
export const readInput = (
	w: WriteContext,
	input: WriteInput,
	options: ReadOptions,
	at: string
): InputRead => {
	const { from, read: readField } = inputColumns(
		w,
		input,
		options.kind === "input"
			? { kind: "named", alias: options.alias, keys: options.keys }
			: { kind: "fresh" },
		at
	)
	const into = options.into
	const read = options.fields.map((field) => {
		const r = readField(field.name)
		return castInto(w, r.value, r.type, rowType(field), into.as, at)
	})
	const targets = isNonEmpty(read) ? mapNonEmpty(read, (r) => target(r.value)) : unitTargets
	return {
		select: select(
			distinctCoreWhen(options.kind === "input" && options.distinct, targets, [from], undefined)
		),
		types: read.map((r) => r.type)
	}
}

/** Reads an input under a fresh alias, uncast: the FROM item and each field as read, for a statement that only compares
 * them, a query entry's precheck. */
export const readInputFields = (
	w: WriteContext,
	input: WriteInput,
	at: string
): { readonly from: FromItem; readonly read: (field: string) => FieldRead } =>
	inputColumns(w, input, { kind: "fresh" }, at)

/** Scans one field of an input under the statement's scan alias, uncast: the FROM item and the field's value as read. */
export const scanInput = (
	w: WriteContext,
	input: WriteInput,
	field: string,
	alias: string,
	at: string
): { readonly from: FromItem; readonly read: FieldRead } => {
	const { from, read } = inputColumns(w, input, { kind: "aliased", alias }, at)
	return { from, read: read(field) }
}

/** The proof that a described member is unique on the primary key `key` by the write DAG's evidence: some logical key
 * of its node, its proof holding in the transaction context (`step` 6), is a subset of `key` by a column of each of its
 * classes (ir/keys.ts keyIn), so two distinct rows
 * agreeing on `key` would agree on that key; or nothing proved. This is the proof that a described member projects a
 * key of a stored relation.
 *
 * The logical keys describe the member's values before the statement casts them into the relation's types, and a
 * member column typed only compatibly changes value under that cast, such as numeric(12,4) into numeric(10,2), where
 * 1.001 and 1.002 both become 1.00. So a logical key proves the cast member unique only when every one of
 * its columns already has its field's base type and typmod, so the cast cannot change it; a contract's or a
 * refinement's domain only checks a value and never changes it. Otherwise the proof does not hold and the same-key
 * check stays: an elision fires only with its evidence. */
export const keyUniqueByEvidence = (node: RelNode, relation: RelationInfo): KeyUniqueness => {
	const key = relation.primaryKey
	for (const k of node.meta.logicalKeys) {
		if (
			k.kind === "proved" &&
			contextAdmits("transaction", k.proof.context) &&
			keyIn(k.proof, (f) => key.includes(f) && castKeeps(node.heading, relation, f)) !== undefined
		) {
			return { kind: "proved", proof: k.proof }
		}
	}
	return { kind: "unproved" }
}

/** Whether casting a member column into its field cannot change a value: the column already has the field's base type
 * and typmod, a contract's or a refinement's domain only checking a value. */
const castKeeps = (heading: Heading, relation: RelationInfo, field: string): boolean => {
	const column = heading.find((c) => c.name === field)
	const into = relation.heading.find((c) => c.name === field)
	return (
		column !== undefined &&
		into !== undefined &&
		sameScalarType(unrefined(column.type), unrefined(into.type))
	)
}

/** Whether a described member holds no repeated row, so its read needs no SELECT DISTINCT.
 * The proof is physical, not logical: the member is lowered under the write's duplicate-elimination
 * placement (`writeFacts`), and some physical key of its rows as realized there, such as the primary
 * key of a stored relation it projects, lies within its fields that every read keeps: the fields other than serial
 * ones, which a generated addition does not read, whose cast into the relation cannot change a value, so two rows
 * distinct before the cast stay distinct after it. Without such a key the read keeps its DISTINCT. */
export const distinctByEvidence = (
	facts: ShapeFacts,
	node: RelNode,
	relation: RelationInfo
): boolean => {
	if (!contextAdmits("transaction", node.meta.context)) {
		return false
	}
	const kept = node.heading
		.map((c) => c.name)
		.filter(
			(f) =>
				!relation.fields.some((r) => r.name === f && isSerialField(r)) &&
				castKeeps(node.heading, relation, f)
		)
	return facts.keyedBy(node, kept)
}
