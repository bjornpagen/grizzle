import { appendAll } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import {
	appendNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { fieldNames, type LawField, type RelationInfo, type SpanField } from "#compiler/ir/law.ts"
import type { SerialClass } from "#compiler/ir/write.ts"
import { witnessFields } from "#compiler/laws/model/uniques.ts"
import { rowEq, rowNe, typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Cte, Expr, FromItem, Insert, Select, SetCore, Target } from "#compiler/sql/ast.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"

import {
	and,
	asc,
	binary,
	col,
	conjunction,
	continuedAll,
	cte,
	cteRef,
	cteRefAs,
	eq,
	exists,
	join,
	lit,
	ne,
	not,
	provedCore,
	provedSelect,
	select,
	simpleSelect,
	target,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { type FieldColumns, fieldColumns } from "#compiler/write/defined.ts"
import { arbiterLaw, type WrittenRelation } from "#compiler/write/frontend/compile.ts"
import { payloadOf, primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import {
	inputGuarantees,
	inputFamily,
	inputStated,
	inputSharing,
	keyUniqueBy,
	noSharedKey,
	readInput,
	sameKeyCte,
	skipWhenEmptyOf,
	type WriteInput
} from "#compiler/write/insert/input.ts"

import {
	buildStatement,
	type InsertOf,
	isCarried,
	type InsertResult,
	type InsertVariant,
	keyFirst,
	proposalOf,
	requestedValue,
	writtenFields,
	type ModifyingStatement,
	type ResultColumn,
	resultText,
	returnedColumn,
	returnedRows,
	rowType,
	type SpanClassifyResult,
	startOf,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

import {
	buildProbe,
	type EveryObject,
	generatedArbiter,
	generatedChecks,
	insertArbitered,
	type Probed,
	type ProbeSql,
	type Requested
} from "#compiler/write/insert/unique.ts"
import {
	atFields,
	atObject,
	type MetAccess,
	metAtObject,
	metFound,
	metNarrowed,
	metRowsOf,
	narrowed,
	probeKey,
	storedAt
} from "#compiler/write/probe.ts"
import type { KeyArbiter } from "#compiler/write/put/choose.ts"

import type { ConcurrentChangeTag } from "#compiler/runtime/write/refusal.ts"
import {
	type ArmRefusal,
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
	 * the put's first statement, its deletion or a family owner's UPDATE, which raises PutTargetConflict; a same-key pair
	 * still raises the key law. */
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

/**
 * Where an insert meets the stored facts it may repeat or conflict with: its ON CONFLICT arbiter's key and the law a
 * conflict there raises. Complete facts meet at the primary key; a generated addition at the first declared key that
 * holds no field it draws (unique.ts generatedArbiter), or nowhere, a plain INSERT, where every key holds one.
 */
interface InsertArbiter {
	readonly key: NonEmptyReadonlyArray<LawField>
	readonly law: LawId
}

/** The arbiter of an insert of class `serial` into `relation` (InsertArbiter). */
const arbiterOf = (
	relation: WrittenRelation,
	serial: SerialClass
): { readonly arbiter: InsertArbiter | undefined; readonly stated: KeyArbiter | undefined } => {
	if (serial.kind === "complete") {
		return {
			arbiter: { key: relation.primaryFields, law: arbiterLaw(relation) },
			stated: undefined
		}
	}
	const stated = generatedArbiter(relation.uniques, serial.drawn)
	return {
		arbiter: stated === undefined ? undefined : { key: stated.equal, law: stated.law },
		stated
	}
}

/**
 * The shape of a generated addition that meets stored facts at `arbiter` (`generatedArbiter`): the insert protocol at
 * that key, its payload the fields the addition writes beside the key, which its DO SELECT compares, or a pure set
 * there where it writes no other; the identity or the default fills each field it draws.
 */
const statedShape = (
	relation: RelationInfo,
	serial: Extract<SerialClass, { readonly kind: "generated" }>,
	arbiter: KeyArbiter
): InsertShape => {
	const payload = insertedFields(relation, serial).filter(
		(f) => isCarried(f) && !arbiter.equal.includes(f)
	)
	return isNonEmpty(payload) ? { variant: "protocol", payload } : { variant: "pureSet" }
}

/** The fields an insert writes: every written field (`writtenFields`), or every one but those a generated addition
 * draws. */
const insertedFields = (relation: RelationInfo, serial: SerialClass): ReadonlyArray<LawField> =>
	serial.kind === "generated"
		? writtenFields(relation).filter((f) => !serial.drawn.includes(f.name))
		: writtenFields(relation)

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** No stored row of `relation` holds the requested fact's value at `key`, its insert's arbiter key, read at `requested`:
 * NOT EXISTS over the probe of `relation` at that key (probe.ts storedAt), each key field compared at its type. */
const storedAbsent = (
	w: WriteContext,
	supply: NameSupply,
	relation: WrittenRelation,
	key: NonEmptyReadonlyArray<LawField>,
	requested: (f: LawField) => Expr
): Expr => not(storedAt(w, supply, relation.name, atFields(w, relation.name, key, requested)))

/**
 * How an insert's INSERT meets the stored rows its requested facts conflict with, by the level its role runs at
 * (statement.ts WriteContext `level`) and the relation's objects, so every insert of a role takes one form:
 * - `key`: ON CONFLICT at its arbiter's key, DO SELECT where the payload differs, so RETURNING yields each conflicting
 *   stored row whatever the statement's snapshot, and every other unique object probed under the statement's snapshot
 *   (unique.ts buildProbe): READ COMMITTED's form; at either level a generated addition's, whose drawn values a request
 *   it does not insert never takes, so no object that reads one could classify it; and at either level an insert into
 *   a relation one of whose native objects is no unique object (unique.ts EveryObject `unnamed`);
 * - `every`: complete facts at SERIALIZABLE into a relation every native object of which is a unique object, ON CONFLICT
 *   DO NOTHING with no target, so every unique and exclusion object arbitrates and a conflicting row in flight sends the
 *   insert back to its pre-check, never to a 23505 or 23P01. A row its transaction snapshot cannot see raises 40001
 *   (nodeModifyTable.c ExecCheckTupleVisible), so every stored row it met is visible. The INSERT proposes a CTE of its
 *   own, every gate in it, and each row of it the INSERT did not return, a met row (sql/ast.ts FromSource `metRows`), is
 *   classified by the stored rows its arbitration met (`met`) at the arbiter and then at each other object: a
 *   complete proposal reads no stored row for a fact it inserts; a placeholder's gate is a probe at its key.
 */
type Arbitration =
	| { readonly kind: "key" }
	| { readonly kind: "every"; readonly objects: Extract<EveryObject, { readonly kind: "named" }> }

const arbitrationOf = (
	w: WriteContext,
	relation: WrittenRelation,
	serial: SerialClass
): Arbitration =>
	w.level === "serializable" &&
	serial.kind === "complete" &&
	relation.uniques.every.kind === "named"
		? { kind: "every", objects: relation.uniques.every }
		: { kind: "key" }

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
 * - A family owner (statement.ts Proposal, `proposalOf`): the INSERT reads only the requested facts no stored row holds
 *   the key of, `WHERE NOT EXISTS (SELECT 1 FROM <relation> s WHERE s.<key> = r1.<key>)`. A proposed row carries every
 *   count and end its input does not carry at its start, and PostgreSQL judges it by every CHECK before the arbiter
 *   meets its key, so a stored owner proposed again would meet a check over an end at that placeholder. For an
 *   insertion, each stored owner at a requested key whose payload differs is a verdict row of its own, the stored row
 *   unmarked, as DO SELECT would have returned it: the key law's conflict witness; an equal one is the exact repeat,
 *   and no row. Those rows are read from the requested facts, `FROM r1 JOIN <relation> s ON s.<key> = r1.<key> WHERE
 *   <the payload differs>`, so each request probes the owner's key and no insertion scans the owner. For a put, the row
 *   at a requested key is the one the put's UPDATE wrote. The arbiter stays for a concurrent commit at the key.
 * - Pure sets, whose primary key is the whole heading: ON CONFLICT (every key column) DO NOTHING RETURNING the key; a
 *   returned key was inserted.
 * - Generated additions, which omit the serial fields their class draws, each taking its identity or its `uuidv7()`
 *   default: where a declared key holds none of those fields and no span, the protocol above at the first such key
 *   (unique.ts generatedArbiter), ON CONFLICT (that key) DO SELECT WHERE the fields it writes beside the key differ, or
 *   DO NOTHING where it writes none, so an exact repeat of a stored fact at every field the addition states changes
 *   nothing and any other occupant of that key is its law's conflict witness, its own refusals, a same-key pair and the
 *   probe's, raised at the INSERT's gate, since a request it refuses never takes the values its relation draws; where
 *   every key holds one, a plain
 *   INSERT ... RETURNING of the complete row with no arbiter, every requested fact a new one, probed at every unique
 *   object that reads no drawn field (see the probe below). A serial field the addition carries, one its entry's filter reads or its fill
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
 * - A generated addition is probed the same way at every unique object that reads no field it draws but its arbiter,
 *   its primary key among them when that reads none and is not the arbiter. A refused addition never becomes a fact, so its refusal
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
 * the requested facts no stored fact equal at every field they state accounts for (input.ts inputStated), an inserted
 * fact and an exact repeat both being stored and equal there, as a family owner's exact repeat is at a scalar key:
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
	const { arbiter, stated } = arbiterOf(relation, serial)
	const shape =
		stated !== undefined && serial.kind === "generated"
			? statedShape(relation, serial, stated)
			: insertShape(relation, serial)
	const variant: InsertVariant = shape.variant
	/** A generated addition's verdict rows are the facts its INSERT made: a request it refuses never takes the values its
	 * relation draws, so its own refusals, a same-key pair and the probe's, are raised at the INSERT's gate. */
	const atGate = serial.kind === "generated"
	const guarantees = inputGuarantees(input)
	const sameKeyCheck = variant === "protocol" && !keyUniqueBy(guarantees.keyUnique)
	const written = insertedFields(relation, serial)
	const proposes = proposalOf(relation, serial, insertArbitered(relation.uniques, serial))
	const arbitration = arbitrationOf(w, relation, serial)
	/** The written fields the input carries, which the insert reads from it, the ones its facts state and the ones its
	 * families draw that its slot carries (input.ts RelationInput), and the rest, each written at its start: a fresh
	 * owner's counts and ends, which a nesting's input and an owner's plain insert carry and no other input does. */
	const carried = [...inputStated(input), ...inputFamily(input)]
	const carries = (f: LawField): boolean => carried.some((c) => c.name === f.name)
	const fields = written.filter(carries)
	const starts = written
		.filter((f) => !carries(f))
		.map((f) => ({
			field: f,
			value: defined(
				startOf(w.names, f),
				`the start of ${relation.name}.${f.name}, a written field its input does not carry`
			)
		}))
	const all = keyFirst(relation)
	/** The key the insert meets stored facts at and the law a conflict there raises, its arbiter's; a plain INSERT's,
	 * which meets none, is the primary key's, which it orders and compares nothing by. */
	const pk = arbiter === undefined ? relation.primaryFields : arbiter.key
	const pkLaw = arbiter === undefined ? arbiterLaw(relation) : arbiter.law
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
					requested:
						stated === undefined
							? { kind: "generated", fields }
							: { kind: "stated", arbiter: stated },
					checks: generatedChecks(relation.uniques, serial.drawn, stated)
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
		/** The inserted marker, over the payload it compares, which tells a row DO SELECT returned from one the INSERT
		 * inserted; or, at `every`, the met class of a verdict row (`classified`), 0 for every row but a met row's. */
		const marker =
			shape.variant === "protocol" && arbitration.kind === "key"
				? { column: supply.column(internal("inserted marker")), payload: shape.payload }
				: undefined
		const cM = arbitration.kind === "every" ? supply.column(internal("met class")) : undefined
		const keys = fieldColumns(r4 === undefined ? [] : pk, () =>
			supply.column(internal("same-key column"))
		)
		const c9 = r4 === undefined || atGate ? undefined : supply.column(internal("same-key marker"))
		const read = readInput(
			w,
			input,
			{
				kind: "input",
				fields,
				alias: scan,
				keys: inputs,
				into: { as: "write" }
			},
			at
		)
		const inCol = (f: LawField): Expr => col(r1, inputs.of(f))
		/** A requested fact's value at every field (statement.ts requestedValue): its input's, a written field's start, and
		 * a generated field's value over them. */
		const requested = requestedValue(w, relation, fields, inCol)
		const retCol = returned.of
		const column = (f: LawField) => w.names.column(relation.name, f.name)
		const ctes: [Cte, ...Array<Cte>] = [cte(r1, inputs.columns, read.select)]
		if (r4 !== undefined) {
			ctes.push(sameKeyCte(r4, r1, pk, keys, inCol))
		}
		/** The unique probe, after every other name: its refusal gates the INSERT as the same-key check does. */
		const probe = buildProbe(w, supply, {
			relation,
			...probed,
			checks:
				arbitration.kind === "every" && arbitration.objects.arbiter.kind === "span"
					? [{ object: arbitration.objects.arbiter, pairs: "statement" }, ...probed.checks]
					: probed.checks,
			input: r1,
			inputs,
			normalized: input.kind === "relation",
			occupants: arbitration.kind === "every" ? "met" : "probed"
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
				: atGate
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
		/** Into a family owner, only the requested facts no row stores (`proposalOf`). */
		const unstored = proposes === "unstored" ? [storedAbsent(w, supply, relation, pk, inCol)] : []
		/** A generated addition's same-key pair raises its arbiter key's law at the gate, its key read from r4. */
		const sharedKey =
			r4 === undefined || !atGate
				? undefined
				: refusalGuard({
						supply,
						schema: w.names.schema,
						verdicts: r4,
						arms: [
							{
								rank: refusalRank.sameKey,
								when: lit.bool(true),
								refusal: {
									kind: "law",
									law: pkLaw,
									relation: relation.name,
									key: pk.map((f) => ({
										field: f.name,
										expr: col(r4, keys.of(f)),
										type: rowType(f)
									}))
								}
							}
						]
					})
		if (sharedKey !== undefined) {
			ctes.push(sharedKey.cte)
		}
		const gates = [
			...(r4 === undefined ? [] : [sharedKey === undefined ? noSharedKey(r4) : sharedKey.guard]),
			...(unique.kind === "none"
				? []
				: [unique.kind === "gate" ? unique.guarded.guard : unique.probe.gate]),
			...unstored
		]
		/**
		 * At `every`, the CTE the INSERT proposes alone (sql/ast.ts FromSource `metRows`): each requested fact the gates
		 * pass, its value at every field, a generated one's included, so a met row is read at any object by its columns.
		 */
		const proposed =
			arbitration.kind === "every"
				? {
						name: supply.relation(internal("proposed")),
						columns: fieldColumns(all, () => supply.column(internal("proposed column")))
					}
				: undefined
		if (proposed !== undefined) {
			ctes.push(
				cte(
					proposed.name,
					proposed.columns.columns,
					provedSelect(
						"keyed",
						all.map((f) => targetAs(requested(f), proposed.columns.of(f))),
						[cteRef(r1)],
						conjunction(gates)
					)
				)
			)
		}
		/** r1 already holds each value cast into its column's type (`into`), so the INSERT selects it as is; at `every`
		 * it selects the proposed CTE's columns alone. */
		const source: Select =
			proposed === undefined
				? {
						...provedSelect(
							"keyed",
							[...fields.map((f) => target(inCol(f))), ...starts.map((s) => target(s.value))],
							[cteRef(r1)],
							conjunction(gates)
						),
						orderBy: variant === "generated" ? [] : pk.map((f) => asc(inCol(f)))
					}
				: {
						...provedSelect(
							"keyed",
							[...fields, ...starts.map((s) => s.field)].map((f) =>
								target(col(proposed.name, proposed.columns.of(f)))
							),
							[cteRef(proposed.name)],
							undefined
						),
						orderBy: pk.map((f) => asc(col(proposed.name, proposed.columns.of(f))))
					}
		const insert: Insert = {
			kind: "insert",
			with: undefined,
			table: w.names.relation(relation.name),
			alias: r3,
			columns: [...fields.map(column), ...starts.map((s) => column(s.field))],
			overriding: explicitSerials(relation, serial).length > 0 ? "SYSTEM VALUE" : undefined,
			source: { kind: "query", query: source },
			onConflict:
				arbitration.kind === "every"
					? { kind: "every", action: { kind: "doNothing" } }
					: shape.variant === "generated"
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
		/** The verdict rows of an insert with a payload marker: the rows r2 returned, marked; for an insertion into a
		 * family owner, each stored owner at a requested key whose payload differs, the row the arbiter's DO SELECT
		 * would have returned had the statement proposed it (`proposalOf`), unmarked, the key law's conflict witness;
		 * and the requests it did not insert with their markers when a later probe classifies them. */
		const markedBody = (payload: NonNullable<typeof marker>): Select["body"] => {
			const inserted = rowEq(
				{ fields: payload.payload, typeOf, left: (f) => col(r2, retCol(f)), right: inCol },
				w.names.vectorSchema
			)
			const left: SetCore = provedCore(
				"keyed",
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
			/**
			 * The stored owners at a requested key whose payload differs, each read by the probe of the owner at a
			 * requested fact's key (probe.ts probeKey), so the statement reads only the owners the call names. Each stored
			 * row is one verdict row: the requests' keys are unique, by the input's proof or, where they are not, by the
			 * same-key gate, without which the same-key refusal ranks first and the statement raises it whatever these rows
			 * are.
			 */
			const conflicts = (): SetCore => {
				const owner = probeKey(
					w,
					supply,
					relation.name,
					atFields(w, relation.name, pk, inCol),
					mapNonEmpty(all, column)
				)
				const stored = (f: LawField): Expr => owner.at(column(f))
				return provedCore(
					"keyed",
					[
						...outFields.map((f) => targetAs(stored(f), retCol(f))),
						targetAs(lit.bool(false), payload.column),
						...(c9 === undefined ? [] : [targetAs(lit.bool(false), c9)]),
						...zero
					],
					[cteRef(r1), owner.source],
					conjunction([
						rowNe(
							{ fields: payload.payload, typeOf, left: stored, right: inCol },
							w.names.vectorSchema
						),
						...(r4 === undefined ? [] : [noSharedKey(r4)])
					])
				)
			}
			const marked: NonEmptyReadonlyArray<SetCore> =
				spec.of === "insert" && proposes === "unstored" ? [left, conflicts()] : [left]
			if (r4 === undefined || c9 === undefined) {
				return unionAll("disjoint", marked)
			}
			const markers = [
				target(lit.bool(false)),
				target(lit.bool(true)),
				...(cU === undefined ? [] : [target(lit.int(0, types.integer))])
			]
			const r4Col = (f: LawField) => col(r4, keys.of(f))
			const right: SetCore = provedCore(
				"keyed",
				[...outFields.map((f) => target(requested(f))), ...markers],
				[
					join(
						cteRef(r1),
						cteRef(r4),
						and(mapNonEmpty(pk, (f) => same(f, inCol(f), r4Col(f))))
					) satisfies FromItem
				],
				undefined
			)
			return unionAll("disjoint", appendNonEmpty(marked, right))
		}
		/**
		 * The met rows at `every` (Arbitration), each row of the proposed CTE r2 did not return (sql/ast.ts FromSource
		 * `metRows`), and each one's met class, read from the stored rows the arbitration met at it (probe.ts metFound),
		 * each object in order:
		 * - 0: an exact repeat, the row met at the arbiter equal to it at every field it states, which changes nothing;
		 * - 1: the arbiter's law, a stored row at its key with another payload, or overlapping it at a span key at another
		 *   span; on a put's insert half at a span key only one at another span;
		 * - 2: a concurrent change on a put's insert half, a stored row at its own key after its deletion,
		 *   PutTargetConflict, or SpanKeyChange at a span key;
		 * - 3 + i: the law of the i-th other unique object of the relation in law order, the first that met it.
		 * Every native object of the relation is one of these objects or held by one (unique.ts EveryObject `named`;
		 * laws/model/uniques.ts beyondPrimary), so the arbitration met each met row at one of them where the statement's
		 * snapshot shows the occupant. A row an earlier INSERT of the same statement wrote is met with no wait and shown by
		 * no snapshot: such a met row takes class -1, the statement's defect (refusal.ts ArmRefusal `defect`). Its CTE's
		 * columns are every field's, by r2's returned names, then the class, `metClass`.
		 */
		const classifyMet = (
			objects: Extract<EveryObject, { readonly kind: "named" }>,
			from: { readonly name: string; readonly columns: FieldColumns<string> },
			metClass: string
		): string => {
			const arbiter = objects.arbiter
			const met = metRowsOf(w, supply, {
				insert: r2,
				proposed: from.name,
				columns: mapNonEmpty(all, (f) => from.columns.of(f)),
				key: mapNonEmpty(pk, (f) => ({ field: f, column: from.columns.of(f), returned: retCol(f) }))
			})
			const metValue = (f: LawField): Expr => col(met.alias, from.columns.of(f))
			const found = (access: MetAccess): Expr => metFound(w, supply, relation.name, access)
			const atArbiter = metAtObject(w, relation.name, arbiter, met.alias, from.columns.of)
			const storedAt = (inner: string) => (f: LawField) => col(inner, column(f))
			const stated = inputStated(input)
			const compared = all.filter(
				(f) => !arbiter.equal.includes(f) && stated.some((c) => c.name === f.name)
			)
			const integer = (n: number) => lit.int(n, types.integer)
			const keyed: NonEmptyReadonlyArray<{ readonly when: Expr; readonly result: Expr }> =
				spec.of === "put" && arbiter.kind === "span"
					? [
							{
								when: found(
									metNarrowed(atArbiter, (inner) => [
										ne(storedAt(inner)(arbiter.span), metValue(arbiter.span))
									])
								),
								result: integer(1)
							},
							{ when: found(atArbiter), result: integer(2) }
						]
					: [{ when: found(atArbiter), result: integer(spec.of === "put" ? 2 : 1) }]
			const classes = [
				{
					when: found(
						metNarrowed(atArbiter, (inner) =>
							compared.map((f) => same(f, storedAt(inner)(f), metValue(f)))
						)
					),
					result: integer(0)
				},
				...keyed,
				...objects.others.map((u, i) => ({
					when: found(metAtObject(w, relation.name, u, met.alias, from.columns.of)),
					result: integer(3 + i)
				}))
			]
			const [first, ...rest] = classes
			const rk = supply.relation(internal("met classes"))
			ctes.push(
				cte(
					rk,
					[...outFields.map(retCol), metClass],
					select(
						provedCore(
							"keyed",
							[
								...outFields.map((f) => target(metValue(f))),
								target({
									kind: "case",
									operand: undefined,
									whens: [defined(first, "a met row's first class"), ...rest],
									else: integer(-1)
								})
							],
							[met.source],
							undefined
						)
					)
				)
			)
			return rk
		}
		/**
		 * The verdict rows at `every` (Arbitration): the rows r2 inserted, the same-key pair, and each met row that is no
		 * exact repeat with its met class, read from the stored rows the arbitration met (`classified`).
		 */
		const metBody = (met: string, metClass: string): Select["body"] => {
			const at = (alias: string) => (f: LawField) => col(alias, retCol(f))
			const left: SetCore = provedCore(
				"keyed",
				[
					...factOf(r2, retCol),
					targetAs(lit.int(0, types.integer), metClass),
					...(c9 === undefined ? [] : [targetAs(lit.bool(false), c9)]),
					...zero
				],
				[cteRef(r2)],
				undefined
			)
			const classified: SetCore = provedCore(
				"keyed",
				[
					...outFields.map((f) => targetAs(at(met)(f), retCol(f))),
					targetAs(col(met, metClass), metClass),
					...(c9 === undefined ? [] : [targetAs(lit.bool(false), c9)]),
					...zero
				],
				[cteRef(met)],
				ne(col(met, metClass), lit.int(0, types.integer))
			)
			/**
			 * An insertion's placeholder proposal withholds each requested fact stored at its key (statement.ts Proposal
			 * `unstored`), so its INSERT never meets one: each one stored there at another stated field is the key law's
			 * conflict witness, read by the probe at its key, as at READ COMMITTED.
			 */
			const stated = inputStated(input)
			const payload = all.filter((f) => !pk.includes(f) && stated.some((c) => c.name === f.name))
			const withheldConflicts = (compared: NonEmptyReadonlyArray<LawField>): SetCore => {
				const owner = probeKey(
					w,
					supply,
					relation.name,
					atFields(w, relation.name, pk, inCol),
					mapNonEmpty(all, column)
				)
				const stored = (f: LawField): Expr => owner.at(column(f))
				return provedCore(
					"keyed",
					[
						...outFields.map((f) => targetAs(stored(f), retCol(f))),
						targetAs(lit.int(1, types.integer), metClass),
						...(c9 === undefined ? [] : [targetAs(lit.bool(false), c9)]),
						...zero
					],
					[cteRef(r1), owner.source],
					conjunction([
						rowNe({ fields: compared, typeOf, left: stored, right: inCol }, w.names.vectorSchema),
						...(r4 === undefined ? [] : [noSharedKey(r4)])
					])
				)
			}
			const withheld: ReadonlyArray<SetCore> =
				spec.of === "insert" && proposes === "unstored" && isNonEmpty(payload)
					? [withheldConflicts(payload)]
					: []
			if (r4 === undefined || c9 === undefined) {
				return unionAll("disjoint", [left, classified, ...withheld])
			}
			const r4Col = (f: LawField) => col(r4, keys.of(f))
			const pair: SetCore = provedCore(
				"keyed",
				[
					...outFields.map((f) => target(requested(f))),
					target(lit.int(0, types.integer)),
					target(lit.bool(true)),
					...(cU === undefined ? [] : [target(lit.int(0, types.integer))])
				],
				[join(cteRef(r1), cteRef(r4), and(mapNonEmpty(pk, (f) => same(f, inCol(f), r4Col(f)))))],
				undefined
			)
			return unionAll("disjoint", [left, classified, ...withheld, pair])
		}
		const verdicts: Select["body"] =
			arbitration.kind === "every" && cM !== undefined && proposed !== undefined
				? metBody(classifyMet(arbitration.objects, proposed, cM), cM)
				: marker === undefined
					? provedCore("keyed", [...factOf(r2, retCol), ...zero], [cteRef(r2)], undefined)
					: markedBody(marker)
		/** The verdict rows, and the probe's refusal after them when it is one of them. */
		const withRefusal = (refused: SetCore): Select["body"] =>
			continuedAll("disjoint", verdicts, refused)
		const body: Select["body"] =
			unique.kind !== "verdict"
				? verdicts
				: withRefusal(
						provedCore(
							"keyed",
							[
								...outFields.map((f) => target(unique.probe.refusalValue(f))),
								...(marker === undefined ? [] : [target(lit.bool(false))]),
								...(cM === undefined ? [] : [target(lit.int(0, types.integer))]),
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
			...(cM === undefined ? [] : [cM]),
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
				refusal: keyLaw(pk, pkLaw)
			})
		}
		if (unique.kind === "verdict") {
			appendAll(
				arms,
				probeArms(unique.probe, verdict(unique.marker), (f) => verdict(retCol(f)))
			)
		}
		if (arbitration.kind === "every" && cM !== undefined) {
			const metClass = (n: number): Expr => eq(verdict(cM), lit.int(n, types.integer))
			arms.push({ rank: refusalRank.conflict, when: metClass(1), refusal: keyLaw(pk, pkLaw) })
			if (spec.of === "put") {
				arms.push({
					rank: refusalRank.change,
					when: metClass(2),
					refusal: change(
						arbitration.objects.arbiter.kind === "span" ? "SpanKeyChange" : "PutTargetConflict"
					)
				})
			}
			for (const [i, u] of arbitration.objects.others.entries()) {
				arms.push({
					rank: refusalRank.uniqueStored,
					when: metClass(3 + i),
					refusal: keyLaw(witnessFields(u), u.law)
				})
			}
			arms.push({
				rank: refusalRank.defect,
				when: metClass(-1),
				refusal: {
					kind: "defect",
					relation: relation.name,
					constraint: w.names.primaryKey(relation.name),
					key: keyOf(pk)
				}
			})
		}
		if (marker !== undefined) {
			arms.push({
				rank: refusalRank.conflict,
				when: and([
					not(verdict(marker.column)),
					...(c9 === undefined ? [] : [not(verdict(c9))]),
					...noOrdinal
				]),
				refusal: spec.of === "put" ? change("PutTargetConflict") : keyLaw(pk, pkLaw)
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
			proposes,
			columns,
			fields: fieldNames(outFields),
			key: fieldNames(relation.primaryFields)
		}
		return {
			ast: {
				...returnedRows(
					"keyed",
					outFields.map((f) => returnedColumn(verdict(retCol(f)), rowType(f), retCol(f))),
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
	const pk = relation.primaryFields
	/** The fields it compares the requested facts at, the ones its input's facts state (input.ts inputStated), its key
	 * among them: never an owner's count or end its slot carries beside them, a family's, which a stored owner holds as
	 * its members leave it and no put of the owner sets. */
	const stated = inputStated(input)
	const all = keyFirst(relation).filter((f) => stated.some((c) => c.name === f.name))
	if (!isNonEmpty(all)) {
		throw defect(`a classification of ${relation.name} whose input carries none of its key`)
	}
	const scalars = pk.filter((f) => f !== span)
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
				alias: scan,
				keys: inputs,
				into: { as: "write" }
			},
			at
		)
		const inCol = (alias: string, f: LawField): Expr => col(alias, inputs.of(f))
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
		const requested = (f: LawField): Expr => inCol(r1, f)
		/** A stored fact equal to the requested one at every field it states, read by the probe at those fields. */
		const equalStored = storedAt(
			w,
			supply,
			relation.name,
			atFields(w, relation.name, all, requested)
		)
		/** On a put's insert half, a stored fact at the requested key itself is no law: the put deleted the occupant at
		 * that key, or an owner's put updated it to the requested fact, which the equal stored fact above accounts for, so
		 * any other one there was committed after the put's own statement, a concurrent change that aborts the apply. */
		const occupant = atObject(w, relation.name, relation.uniques.arbiter, requested)
		const storedOverlap = storedAt(
			w,
			supply,
			relation.name,
			spec.of === "put"
				? narrowed(occupant, (inner) => [
						ne(col(inner, w.names.column(relation.name, span.name)), requested(span))
					])
				: occupant
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
					targetAs(storedOverlap, c8),
					targetAs(exists(requestedOverlap), c9)
				],
				[cteRef(r1)],
				not(equalStored)
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
				...provedSelect(
					"oneRow",
					keys.pairs.map((p) => targetAs(resultText(keyCol(p.field), rowType(p.field)), p.column)),
					[cteRef(rv)],
					guarded.guard
				),
				limit: lit.int(1, types.integer),
				with: { ctes, recursive: false }
			},
			role: "member",
			result,
			skipWhenEmpty: skipWhenEmptyOf(input)
		}
	})
}
