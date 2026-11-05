import { appendAll } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { fieldNames, type LawField, type RelationInfo, type SpanField } from "#compiler/ir/law.ts"
import type { SerialClass } from "#compiler/ir/write.ts"
import { witnessFields } from "#compiler/laws/model/uniques.ts"
import { rowEq, rowNe, typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Cte, Expr, FromItem, Insert, Select, SelectCore, Target } from "#compiler/sql/ast.ts"

import {
	and,
	asc,
	binary,
	col,
	conjunction,
	continued,
	core,
	countStar,
	cte,
	cteRef,
	cteRefAs,
	eq,
	exists,
	gt,
	join,
	lit,
	ne,
	not,
	notExists,
	select,
	simpleSelect,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { fieldColumns, flatMapNonEmpty } from "#compiler/write/defined.ts"
import { arbiterLaw, type WrittenRelation } from "#compiler/write/frontend/compile.ts"
import { payloadOf, primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import {
	inputGuarantees,
	inputSharing,
	keyUniqueBy,
	readInput,
	skipWhenEmptyOf,
	type WriteInput
} from "#compiler/write/insert/input.ts"

import {
	buildStatement,
	type InsertOf,
	type InsertResult,
	type InsertVariant,
	keyFirst,
	writtenFields,
	type ModifyingStatement,
	type ResultColumn,
	resultText,
	rowType,
	type SpanClassifyResult,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

import {
	buildProbe,
	generatedChecks,
	type Probed,
	type ProbeSql,
	type Requested
} from "#compiler/write/insert/unique.ts"

import {
	type ArmRefusal,
	type ConcurrentChangeTag,
	type RefusalArm,
	type RefusedValue,
	refusalGuard,
	refusalRank
} from "#compiler/write/refusal.ts"
import { explicitSerials } from "#compiler/write/serial/advance.ts"

/** An insert's spec. The statement meets its relation's unique objects (`relationUniques`): an insert of complete facts
 * probes those besides the arbiter, a generated addition every one that reads no field it draws (`generatedChecks`). A
 * conflict witness and a same-key pair raise the law of the relation's primary key, the arbiter's. */
interface InsertSpec {
	readonly relation: WrittenRelation
	readonly serial: SerialClass
	readonly input: WriteInput
	/** The action the insert realizes. On a put's insert half a conflict witness is a concurrent commit at the key after
	 * the put's deletion, which raises PutTargetConflict; a same-key pair still raises the key law. */
	readonly of: InsertOf
}

/** Where an insert raises its probe's refusal (see `buildInsert`): nowhere, when it probes nothing; at the INSERT's gate,
 * the refusal guard over the probe's refusal; or as one of its verdict rows, marked by its object's signed ordinal. */
type ProbeRaise =
	| { readonly kind: "none" }
	| { readonly kind: "gate"; readonly guarded: { readonly cte: Cte; readonly guard: Expr } }
	| { readonly kind: "verdict"; readonly probe: ProbeSql; readonly marker: string }

/** What the classification after an insert reads of the insert's spec. */
type ClassifySpec = Pick<InsertSpec, "relation" | "serial" | "input" | "of">

/** An insert's variant, by its serial class and the relation's shape, with what it reads of the
 * shape: a spanKey insert's span key field, which its classification compares by overlap, and a protocol insert's
 * payload, which its DO SELECT and inserted marker compare. */
export type InsertShape =
	| { readonly variant: "generated" }
	| { readonly variant: "pureSet" }
	| { readonly variant: "spanKey"; readonly span: SpanField }
	| { readonly variant: "protocol"; readonly payload: NonEmptyReadonlyArray<LawField> }

export const insertShape = (relation: RelationInfo, serial: SerialClass): InsertShape => {
	if (serial.kind === "generated") {
		return { variant: "generated" }
	}
	const key = primaryKeyShape(relation)
	if (key.kind === "span") {
		return { variant: "spanKey", span: key.span }
	}
	const payload = payloadOf(relation)
	return payload.kind === "pureSet"
		? { variant: "pureSet" }
		: { variant: "protocol", payload: payload.fields }
}

/** The fields an insert writes: every written field (`writtenFields`), or every one but those a generated addition
 * draws. */
const insertedFields = (relation: RelationInfo, serial: SerialClass): ReadonlyArray<LawField> =>
	serial.kind === "generated"
		? writtenFields(relation).filter((f) => !serial.drawn.includes(f.name))
		: writtenFields(relation)

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The same-key check reports the least key that occurs twice, so the witness never depends on the plan.
 *
 * The probe's refusal: the requested fact, every protocol marker false, and the signed ordinal.
 *
 * The insert protocol and its variants.
 *
 * Set insertion is one statement. For an enumerated member of Task(id, account, kind) keyed by id:
 *
 *   WITH "r1"("c1", "c2", "c3") AS (
 *     SELECT "r0"."c1", "r0"."c2", "r0"."c3" FROM (SELECT pg_catalog.unnest($1::uuid[]) AS "c1", ...) AS "r0"
 *   ),
 *   "r2" AS (
 *     INSERT INTO "work"."task" AS "r3" ("id", "account", "kind")
 *     SELECT "r1"."c1", "r1"."c2", "r1"."c3" FROM "r1" ORDER BY "r1"."c1"
 *     ON CONFLICT ("id") DO SELECT
 *       WHERE ("r3"."account", "r3"."kind") <> (EXCLUDED."account", EXCLUDED."kind")
 *     RETURNING "r3"."id" AS "c4", "r3"."account" AS "c5", "r3"."kind" AS "c6"
 *   ),
 *   "r5"("c4", "c7") AS MATERIALIZED (
 *     SELECT "r2"."c4", ("r2"."c5", "r2"."c6") = ("r1"."c2", "r1"."c3") AS "c7"
 *     FROM "r2" JOIN "r1" ON "r1"."c1" = "r2"."c4"
 *   ),
 *   "r6"(...) AS (<the refusals among r5's rows>)
 *   SELECT "r5"."c4"::text AS "c4" FROM "r5" WHERE NOT EXISTS (SELECT 1 FROM "r6" WHERE "work"."__refuse"(...))
 *
 * RETURNING yields the rows the statement inserted plus the existing rows whose payload differs; an exact repeat
 * returns nothing. These are the verdict rows: c7 true is an inserted fact, c7 false a conflict witness at an occupied
 * key. A verdict row that refuses the write is never returned: the statement raises it through the installation's
 * refusal function, so PostgreSQL aborts the transaction, and the rows the statement returns are
 * the facts it inserted. A conflict witness raises the key law, its witness the key. The outermost SELECT casts its
 * columns to text. The variant is chosen by relation and member shape alone:
 *
 * - Relations with a payload: ON CONFLICT (the key) DO SELECT WHERE the payload differs, as above.
 * - Pure sets, whose primary key is the whole heading: ON CONFLICT (every key column) DO NOTHING RETURNING the key; a
 *   returned key was inserted.
 * - Generated additions, which omit the serial fields their class draws: a plain INSERT ... RETURNING of the complete
 *   row, taking the identity default of each drawn field, with no arbiter, probed at every unique object that reads no
 *   drawn field (see the probe below). A serial field the addition carries, one its entry's filter reads or its fill
 *   fixes, is an explicit serial value, written as it is. Equal generated additions are one: a carried
 *   or described one is read through SELECT DISTINCT over its head. A generated class of no field reads the unit
 *   input and assigns no column, so every column takes its identity: `INSERT INTO ... AS "r3" SELECT FROM "r1"`.
 * - Explicit serial values, complete facts' and those a generated addition carries: OVERRIDING SYSTEM VALUE, because
 *   the column is GENERATED ALWAYS; the sequence advance that follows is serial/.
 * - Carriers and described members, which nobody normalized on the host, read SELECT DISTINCT over the input and gate
 *   the INSERT with a same-key check in the same statement:
 *
 *     r4("c8") AS (SELECT "r1"."c1" FROM "r1" GROUP BY "r1"."c1" HAVING count(*) > 1 ORDER BY "r1"."c1" LIMIT 1),
 *     ... SELECT ... FROM "r1" WHERE NOT EXISTS (SELECT 1 FROM "r4") ORDER BY "r1"."c1" ON CONFLICT ...
 *     SELECT ..., false AS "c9" FROM "r2" JOIN "r1" ON ... UNION ALL SELECT "r4"."c8", false, true FROM "r4"
 *
 *   Two input facts at one key with different payloads leave one such key in r4, the INSERT inserts nothing, and the
 *   only verdict row is that key with c9 true: a same-key conflict within the ChangeSet, which raises the key law on a
 *   put's insert half too. Either step is elided where the input's proof says it is distinct or unique
 *   on the primary key; a pure set needs no same-key check, its key being the whole fact.
 *
 * - Every unique object of the relation besides the arbiter is probed in the same statement, after the
 *   same-key check: a visible occupant, or a pair within an input the host did not refuse, gates the INSERT the same
 *   way and is one more UNION ALL arm of the verdict rows, the requested fact with the object's signed ordinal c10 (0 on
 *   every other row), which raises that object's law; a 23505 or 23P01 the INSERT still raises there is an unseen
 *   occupant, a TransientFailure. A probed statement returns complete facts, which the witness reads from.
 * - A generated addition is probed the same way at every unique object that reads no field it draws, its primary key
 *   among them when that reads none, since it has no arbiter. A refused addition never becomes a fact, so its refusal
 *   is no verdict row: the refusal guard over the probe's refusal is the INSERT's own gate, which raises before
 *   anything is inserted, r1 being nonempty whenever a refusal is found in it. Every 23505 or 23P01 the INSERT still
 *   raises aborts the apply: an unseen occupant (UnseenOccupant), or at an object that reads a drawn field a stored
 *   value its sequence had not passed (GeneratedSerialUnique).
 *
 * ORDER BY the primary key under the fixed collation makes concurrent inserters take new-key locks in one order.
 * Every input value is cast to its column's type where it is not already of that type
 * (`writeValue`), and the cast is inside the input CTE r1, so r1 holds the facts as they are written: a
 * member column typed only compatibly with its field, such as numeric(12,4) into numeric(10,2), can change value under
 * the cast, and SELECT DISTINCT, the same-key check, the ORDER BY and the inserted marker c7 all compare
 * the written facts, never the member's values before the cast. The outer SELECT returns the complete fact, which a
 * read-back of delta.added and the netting of deltas and counts across strata need; a same-key verdict row carries the
 * input's facts at that key, so no column is ever manufactured.
 *
 * A primary key containing a span field is an exclusion constraint,
 * which arbiter inference skips, so ON CONFLICT over its columns fails with 42P10, and PostgreSQL accepts it as an
 * arbiter only by name and only for DO NOTHING. Its insert, keyed relation or pure set alike, is
 *
 *   ... INSERT INTO "s"."booking" AS "r3" (...) SELECT ... FROM "r1" ORDER BY "r1"."c1", "r1"."c2"
 *       ON CONFLICT ON CONSTRAINT "booking__pk" DO NOTHING RETURNING ...
 *
 * whose rows are the facts it inserted, followed by a later statement, buildSpanClassify, that classifies each requested
 * fact it did not insert and raises the refusal it finds, so it returns no row. An occupant the arbiter waited on and
 * saw commit is not in the transaction's snapshot, so the insert meets it as 40001. The classification reads the input
 * again (the arrays, or the carrier the schedule then gives a described member, which has two consumers) and returns
 * the requested facts no equal stored fact accounts for, an inserted fact and an exact repeat both being stored and
 * equal:
 *
 *   WITH "r1"(...) AS (<the input>),
 *   "r5"(<key>, "c8", "c9") AS MATERIALIZED (
 *     SELECT <key>, EXISTS (<a stored fact overlapping it at its scalar key>) AS "c8",
 *            EXISTS (<another requested fact overlapping it at its scalar key>) AS "c9"
 *     FROM "r1" WHERE NOT EXISTS (<an equal stored fact>)
 *   ), "r6"(...) AS (<its refusals>)
 *   SELECT <key as text> FROM "r5" WHERE NOT EXISTS (SELECT 1 FROM "r6" WHERE "s"."__refuse"(...))
 *
 * c9 true is two requested facts the final state cannot both hold, the span key law on a put's insert half too, as the
 * protocol's same-key pair is; else c8 true is the span key law with the requested fact's key as the witness. On a
 * put's insert half c8 reads only a stored fact at another key, with a span unequal
 * to the requested one: the put displaces only the occupants at its own keys, so such a fact is the law there too, as
 * a visible occupant of another unique object is, while a stored fact at the requested key was committed
 * after the put's deletion. Neither marker is an occupant the arbiter met that has since gone or, on a put's insert
 * half, one committed at the put's key after its deletion: a concurrent change, which raises SpanKeyChange and fails
 * the apply with TransientFailure{SpanKeyChange}. A generated addition there stays a plain INSERT, probed at the span key
 * when it reads no field the addition draws.
 *
 * Every transaction is SERIALIZABLE. The arbiter meets an occupant under no snapshot, and
 * PostgreSQL reads it again under the transaction's: SSI sees an exact repeat, which inserts nothing, as a read of the
 * stored fact, and an insert after a concurrent deletion of an occupant the snapshot held as a write into what the
 * deletion read. A transaction that would commit in no serial order with a concurrent one fails with 40001, a
 * TransientFailure.
 *
 * A vector field compares through the extension's qualified operator, and a row comparison that holds one, such as the
 * DO SELECT predicate or c7 over a vector payload, is spelled column by column: PostgreSQL resolves each column
 * operator by name through the search_path, and no login's search_path holds the extension schema. */
export const buildInsert = (
	w: WriteContext,
	spec: InsertSpec
): ModifyingStatement<InsertResult> => {
	const { relation, serial, input } = spec
	const at = `insert ${relation.name}`
	const shape = insertShape(relation, serial)
	const variant: InsertVariant = shape.variant
	const guarantees = inputGuarantees(input)
	const sameKeyCheck = variant === "protocol" && !keyUniqueBy(guarantees.keyUnique)
	const fields = insertedFields(relation, serial)
	const all = keyFirst(relation)
	const pk = relation.primaryFields
	/** Every comparison is at its field's type: a vector, in the payload or in a small key, compares through the
	 * extension's qualified operator, which a bare or row comparison would resolve through the search_path. */
	const typeOf = rowType
	const same = (f: LawField, a: Expr, b: Expr): Expr =>
		typedEq(rowType(f), a, b, w.names.vectorSchema)
	/** The requested facts the probe reads and the objects it probes (`buildProbe`): a generated addition is probed at every
	 * object that reads no field it draws, complete facts at every object besides the arbiter. */
	const probed: { readonly requested: Requested; readonly checks: ReadonlyArray<Probed> } =
		serial.kind === "generated"
			? {
					requested: { kind: "generated", fields },
					checks: generatedChecks(relation.uniques, serial.drawn)
				}
			: {
					requested: { kind: "complete", arbiter: relation.uniques.arbiter },
					checks: relation.uniques.checks
				}
	/** The outer SELECT returns complete facts: a read-back and the netting across strata read them, and a unique
	 * refusal's witness is the requested fact at the object's fields. */
	const outFields = all
	const sharing = inputSharing(w.share.inserts, [input], [relation, serial, input, spec.of])
	return buildStatement(w, sharing, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const r1 = supply.relation(internal("input"))
		const r2 = supply.relation(internal("insert"))
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const r4 = sameKeyCheck ? supply.relation(internal("same-key check")) : undefined
		const inputs = fieldColumns(fields, () => supply.column(internal("input column")))
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		/** The inserted marker, over the payload it compares. */
		const marker =
			shape.variant === "protocol"
				? { column: supply.column(internal("inserted marker")), payload: shape.payload }
				: undefined
		const keys = fieldColumns(r4 === undefined ? [] : pk, () =>
			supply.column(internal("same-key column"))
		)
		const c9 = r4 === undefined ? undefined : supply.column(internal("same-key marker"))
		const read = readInput(
			w,
			input,
			{
				kind: "input",
				fields,
				distinct: !guarantees.distinct,
				alias: scan,
				keys: inputs,
				into: { as: "write" }
			},
			at
		)
		const inCol = (f: LawField): Expr => col(r1, inputs.of(f))
		const retCol = returned.of
		const column = (f: LawField) => w.names.column(relation.name, f.name)
		const ctes: [Cte, ...Array<Cte>] = [cte(r1, inputs.columns, read.select)]
		if (r4 !== undefined) {
			ctes.push(
				cte(r4, keys.columns, {
					...select({
						...core(
							pk.map((f) => target(inCol(f))),
							[cteRef(r1)],
							undefined
						),
						groupBy: pk.map(inCol),
						having: gt(countStar(), lit.int(1, types.integer))
					}),
					orderBy: pk.map((f) => asc(inCol(f))),
					limit: lit.int(1, types.integer)
				})
			)
		}
		/** The unique probe, after every other name: its refusal gates the INSERT as the same-key check does. */
		const probe = buildProbe(w, supply, {
			relation,
			...probed,
			input: r1,
			inputs,
			normalized: input.kind === "relation"
		})
		if (probe !== undefined) {
			appendAll(ctes, probe.ctes)
		}
		/** The probe's arms, one per sign of each object's ordinal (`buildProbe`), the refused fact's values read by
		 * `value` at the object's fields. */
		const probeArms = (
			found: ProbeSql,
			ordinal: Expr,
			value: (f: LawField) => Expr
		): NonEmptyReadonlyArray<RefusalArm> =>
			flatMapNonEmpty(found.checks, (u, i): NonEmptyReadonlyArray<RefusalArm> => {
				const refusal: ArmRefusal = {
					kind: "law",
					law: u.law,
					relation: relation.name,
					key: witnessFields(u).map((f) => ({
						field: f.name,
						expr: value(f),
						type: rowType(f)
					}))
				}
				return [
					{
						rank: refusalRank.uniqueWithin,
						when: eq(ordinal, lit.int(-(i + 1), types.integer)),
						refusal
					},
					{
						rank: refusalRank.uniqueStored,
						when: eq(ordinal, lit.int(i + 1, types.integer)),
						refusal
					}
				]
			})
		/** Where the probe's refusal is raised (see `buildInsert`): at the INSERT's own gate for a generated addition,
		 * whose verdict rows are the complete facts the INSERT made, which a refused addition never becomes; else as a
		 * verdict row marked by its object's signed ordinal, beside the rows of the arms that read what the INSERT
		 * returned. */
		const unique: ProbeRaise =
			probe === undefined
				? { kind: "none" }
				: variant === "generated"
					? {
							kind: "gate",
							guarded: refusalGuard({
								supply,
								schema: w.names.schema,
								verdicts: probe.refusal,
								arms: probeArms(probe, probe.ordinal, probe.refusalCol)
							})
						}
					: { kind: "verdict", probe, marker: supply.column(internal("unique marker")) }
		if (unique.kind === "gate") {
			ctes.push(unique.guarded.cte)
		}
		const cU = unique.kind === "verdict" ? unique.marker : undefined
		const gates = [
			...(r4 === undefined
				? []
				: [notExists(simpleSelect([target(lit.int(1, types.integer))], [cteRef(r4)], undefined))]),
			...(unique.kind === "none"
				? []
				: [unique.kind === "gate" ? unique.guarded.guard : unique.probe.gate])
		]
		/** r1 already holds each value cast into its column's type (`into`), so the INSERT selects it as is. */
		const values = fields.map((f) => target(inCol(f)))
		const source: Select = {
			...simpleSelect(values, [cteRef(r1)], conjunction(gates)),
			orderBy: variant === "generated" ? [] : pk.map((f) => asc(inCol(f)))
		}
		const insert: Insert = {
			kind: "insert",
			with: undefined,
			table: w.names.relation(relation.name),
			alias: r3,
			columns: fields.map(column),
			overriding: explicitSerials(relation, serial).length > 0 ? "SYSTEM VALUE" : undefined,
			source: { kind: "query", query: source },
			onConflict:
				shape.variant === "generated"
					? undefined
					: shape.variant === "spanKey"
						? {
								kind: "constraint",
								constraint: w.names.primaryKey(relation.name),
								action: { kind: "doNothing" }
							}
						: {
								kind: "columns",
								columns: mapNonEmpty(pk, column),
								action:
									shape.variant === "pureSet"
										? { kind: "doNothing" }
										: {
												kind: "doSelect",
												where: rowNe(
													{
														fields: shape.payload,
														typeOf,
														left: (f) => col(r3, column(f)),
														right: (f) => ({ kind: "excluded", column: column(f) })
													},
													w.names.vectorSchema
												)
											}
							},
			returning: all.map((f) => targetAs(col(r3, column(f)), retCol(f)))
		}
		ctes.push(cte(r2, [], insert))
		const columns: ReadonlyArray<ResultColumn> = outFields.map((f) => ({
			name: f.name,
			type: rowType(f)
		}))
		/** The verdict rows (see `buildInsert`): every row r2 returned, then the same-key pair, then the probe's refusal. */
		const factOf = (alias: string, name: (f: LawField) => string): ReadonlyArray<Target> =>
			outFields.map((f) => targetAs(col(alias, name(f)), retCol(f)))
		const zero = cU === undefined ? [] : [targetAs(lit.int(0, types.integer), cU)]
		/** The verdict rows of an insert with a payload marker: the rows r2 returned, marked, and the requests it did not
		 * insert with their markers when a later probe classifies them. */
		const markedBody = (payload: NonNullable<typeof marker>): Select["body"] => {
			const inserted = rowEq(
				{ fields: payload.payload, typeOf, left: (f) => col(r2, retCol(f)), right: inCol },
				w.names.vectorSchema
			)
			const left: SelectCore = core(
				[
					...factOf(r2, retCol),
					targetAs(inserted, payload.column),
					...(c9 === undefined ? [] : [targetAs(lit.bool(false), c9)]),
					...zero
				],
				[
					join(
						cteRef(r2),
						cteRef(r1),
						and(mapNonEmpty(pk, (f) => same(f, inCol(f), col(r2, retCol(f)))))
					)
				],
				undefined
			)
			if (r4 === undefined || c9 === undefined) {
				return left
			}
			const markers = [
				target(lit.bool(false)),
				target(lit.bool(true)),
				...(cU === undefined ? [] : [target(lit.int(0, types.integer))])
			]
			const r4Col = (f: LawField) => col(r4, keys.of(f))
			const right: SelectCore = core(
				[...outFields.map((f) => target(inCol(f))), ...markers],
				[
					join(
						cteRef(r1),
						cteRef(r4),
						and(mapNonEmpty(pk, (f) => same(f, inCol(f), r4Col(f))))
					) satisfies FromItem
				],
				undefined
			)
			return { kind: "setOp", op: "UNION ALL", arms: [left, right] }
		}
		const verdicts: Select["body"] =
			marker === undefined
				? core([...factOf(r2, retCol), ...zero], [cteRef(r2)], undefined)
				: markedBody(marker)
		/** The verdict rows, and the probe's refusal after them when it is one of them. */
		const withRefusal = (refused: SelectCore): Select["body"] =>
			continued("UNION ALL", verdicts, refused)
		const body: Select["body"] =
			unique.kind !== "verdict"
				? verdicts
				: withRefusal(
						core(
							[
								...outFields.map((f) => target(unique.probe.refusalValue(f))),
								...(marker === undefined ? [] : [target(lit.bool(false))]),
								...(c9 === undefined ? [] : [target(lit.bool(false))]),
								target(unique.probe.ordinal)
							],
							[cteRef(unique.probe.refusal)],
							undefined
						)
					)
		const rv = supply.relation(internal("verdicts"))
		const verdictColumns = [
			...outFields.map(retCol),
			...(marker === undefined ? [] : [marker.column]),
			...(c9 === undefined ? [] : [c9]),
			...(cU === undefined ? [] : [cU])
		]
		ctes.push({
			name: rv,
			columns: verdictColumns,
			materialized: "MATERIALIZED",
			query: select(body)
		})
		const verdict = (c: string): Expr => col(rv, c)
		const keyOf = (keyFields: ReadonlyArray<LawField>): ReadonlyArray<RefusedValue> =>
			keyFields.map((f) => ({
				field: f.name,
				expr: verdict(retCol(f)),
				type: rowType(f)
			}))
		const keyLaw = (keyFields: ReadonlyArray<LawField>, law: LawId): ArmRefusal => ({
			kind: "law",
			law,
			relation: relation.name,
			key: keyOf(keyFields)
		})
		const change = (reason: ConcurrentChangeTag): ArmRefusal => ({
			kind: "change",
			reason,
			relation: relation.name,
			constraint: w.names.primaryKey(relation.name),
			key: keyOf(pk)
		})
		/** The arms, each reading exactly the verdict rows its refusal is (see `buildInsert`). */
		const noOrdinal = cU === undefined ? [] : [eq(verdict(cU), lit.int(0, types.integer))]
		const arms: Array<RefusalArm> = []
		if (c9 !== undefined) {
			arms.push({
				rank: refusalRank.sameKey,
				when: verdict(c9),
				refusal: keyLaw(pk, arbiterLaw(relation))
			})
		}
		if (unique.kind === "verdict") {
			appendAll(
				arms,
				probeArms(unique.probe, verdict(unique.marker), (f) => verdict(retCol(f)))
			)
		}
		if (marker !== undefined) {
			arms.push({
				rank: refusalRank.conflict,
				when: and([
					not(verdict(marker.column)),
					...(c9 === undefined ? [] : [not(verdict(c9))]),
					...noOrdinal
				]),
				refusal: spec.of === "put" ? change("PutTargetConflict") : keyLaw(pk, arbiterLaw(relation))
			})
		}
		/** A statement with no arm here refuses nothing after its INSERT: a generated addition, whose probe raises at its
		 * gate, or a pure set or a span key insert with no unique object besides its arbiter. */
		const guarded = isNonEmpty(arms)
			? refusalGuard({ supply, schema: w.names.schema, verdicts: rv, arms })
			: undefined
		if (guarded !== undefined) {
			ctes.push(guarded.cte)
		}
		const result: InsertResult = {
			kind: "insert",
			relation: relation.name,
			variant,
			serial,
			of: spec.of,
			columns,
			fields: fieldNames(outFields),
			key: fieldNames(pk)
		}
		return {
			ast: {
				...simpleSelect(
					outFields.map((f) => targetAs(resultText(verdict(retCol(f)), rowType(f)), retCol(f))),
					[cteRef(rv)],
					guarded?.guard
				),
				with: { ctes, recursive: false }
			},
			role: "member",
			result,
			skipWhenEmpty: skipWhenEmptyOf(input),
			returning: { cte: r2, kind: "added", added: { columns: returned, conditions: [] } }
		}
	})
}

/** The statement that follows a spanKey insert, an insert of every field into a primary key that holds a span, and
 * classifies each requested fact the insert did not insert (see `buildInsert`), `span` the key's span field
 * (InsertShape). A generated addition stays a plain INSERT, its probe its classification. It reads `spec`'s input as the insert does,
 * every field into the relation's column types, so it compares the facts as they were written. */
export const buildSpanClassify = (
	w: WriteContext,
	spec: ClassifySpec,
	span: SpanField
): WriteStatement<SpanClassifyResult> => {
	const { relation, input } = spec
	const at = `classify ${relation.name}`
	const all = keyFirst(relation)
	const pk = relation.primaryFields
	const scalars = pk.filter((f) => f !== span)
	const guarantees = inputGuarantees(input)
	const vectorSchema = w.names.vectorSchema
	const typeOf = rowType
	const sharing = inputSharing(
		w.share.classifications,
		[input],
		[relation, spec.serial, input, spec.of, span]
	)
	return buildStatement(w, sharing, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const r1 = supply.relation(internal("input"))
		const stored = supply.relation(internal(`equal stored ${relation.name}`))
		const occupant = supply.relation(internal(`overlapping stored ${relation.name}`))
		const other = supply.relation(internal("overlapping requested fact"))
		const inputs = fieldColumns(all, () => supply.column(internal("input column")))
		const keys = fieldColumns(pk, () => supply.column(internal("requested key column")))
		const c8 = supply.column(internal("overlap marker"))
		const c9 = supply.column(internal("same-key marker"))
		const read = readInput(
			w,
			input,
			{
				kind: "input",
				fields: all,
				distinct: !guarantees.distinct,
				alias: scan,
				keys: inputs,
				into: { as: "write" }
			},
			at
		)
		const inCol = (alias: string, f: LawField): Expr => col(alias, inputs.of(f))
		const column = (f: LawField) => w.names.column(relation.name, f.name)
		const table = (alias: string): FromItem => ({
			kind: "table",
			table: w.names.relation(relation.name),
			alias
		})
		const same = (f: LawField, a: Expr, b: Expr): Expr => typedEq(rowType(f), a, b, vectorSchema)
		/** A fact at `left` overlapping the requested fact at the same scalar key: equal scalars, overlapping spans. */
		const overlapping = (left: (f: LawField) => Expr): Expr =>
			and(
				appendNonEmpty(
					scalars.map((f) => same(f, left(f), inCol(r1, f))),
					binary("&&", left(span), inCol(r1, span))
				)
			)
		const one = [target(lit.int(1, types.integer))]
		const ctes: [Cte, ...Array<Cte>] = [cte(r1, inputs.columns, read.select)]
		const equalStored = simpleSelect(
			one,
			[table(stored)],
			rowEq(
				{ fields: all, typeOf, left: (f) => col(stored, column(f)), right: (f) => inCol(r1, f) },
				vectorSchema
			)
		)
		/** On a put's insert half, a stored fact at the requested key itself is no law: the put deleted the occupant at
		 * that key, so one there now was committed after the deletion, a concurrent change that aborts the apply. */
		const storedOverlap = simpleSelect(
			one,
			[table(occupant)],
			spec.of === "put"
				? and([
						overlapping((f) => col(occupant, column(f))),
						ne(col(occupant, column(span)), inCol(r1, span))
					])
				: overlapping((f) => col(occupant, column(f)))
		)
		const requestedOverlap = simpleSelect(
			one,
			[cteRefAs(r1, other)],
			and([
				overlapping((f) => inCol(other, f)),
				rowNe(
					{ fields: all, typeOf, left: (f) => inCol(other, f), right: (f) => inCol(r1, f) },
					vectorSchema
				)
			])
		)
		/** The verdict rows: every requested fact no equal stored fact accounts for, each a refusal (see `buildInsert`). */
		const rv = supply.relation(internal("verdicts"))
		ctes.push({
			name: rv,
			columns: [...keys.columns, c8, c9],
			materialized: "MATERIALIZED",
			query: simpleSelect(
				[
					...keys.pairs.map((p) => targetAs(inCol(r1, p.field), p.column)),
					targetAs(exists(storedOverlap), c8),
					targetAs(exists(requestedOverlap), c9)
				],
				[cteRef(r1)],
				notExists(equalStored)
			)
		})
		const keyCol = (f: LawField): Expr => col(rv, keys.of(f))
		const key: ReadonlyArray<RefusedValue> = pk.map((f) => ({
			field: f.name,
			expr: keyCol(f),
			type: rowType(f)
		}))
		const keyLaw: ArmRefusal = {
			kind: "law",
			law: arbiterLaw(relation),
			relation: relation.name,
			key
		}
		const guarded = refusalGuard({
			supply,
			schema: w.names.schema,
			verdicts: rv,
			arms: [
				{ rank: refusalRank.sameKey, when: col(rv, c9), refusal: keyLaw },
				{ rank: refusalRank.conflict, when: and([col(rv, c8), not(col(rv, c9))]), refusal: keyLaw },
				{
					rank: refusalRank.change,
					when: and([not(col(rv, c8)), not(col(rv, c9))]),
					refusal: {
						kind: "change",
						reason: "SpanKeyChange",
						relation: relation.name,
						constraint: w.names.primaryKey(relation.name),
						key
					}
				}
			]
		})
		ctes.push(guarded.cte)
		const result: SpanClassifyResult = { kind: "spanClassify", relation: relation.name }
		return {
			ast: {
				...simpleSelect(
					keys.pairs.map((p) => targetAs(resultText(keyCol(p.field), rowType(p.field)), p.column)),
					[cteRef(rv)],
					guarded.guard
				),
				with: { ctes, recursive: false }
			},
			role: "member",
			result,
			skipWhenEmpty: skipWhenEmptyOf(input)
		}
	})
}
