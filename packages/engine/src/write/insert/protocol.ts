import { appendAll } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { rowEq, rowNe, typedEq } from "#compiler/ir/compare.ts"
import { fieldNames, type LawField, type RelationInfo, type SpanField } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { SerialClass } from "#compiler/ir/write.ts"
import { witnessFields } from "#compiler/laws/model/uniques.ts"
import type {
	Cte,
	Expr,
	FromItem,
	Insert,
	OnConflict,
	Select,
	SetCore,
	Target
} from "#compiler/sql/ast.ts"
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
	notExists,
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
import { primaryKeyShape } from "#compiler/write/frontend/targets.ts"
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
	type Returning,
	resultText,
	returnedColumn,
	returnedRows,
	rowType,
	type SpanClassifyResult,
	startOf,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

import { type EntryMembership, membershipOf } from "#compiler/write/entry/precheck.ts"
import {
	buildProbe,
	type EveryObject,
	generatedArbiter,
	generatedChecks,
	insertArbitered,
	type Probed,
	probeArms,
	probeGuard,
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
	metRow,
	metRowsOf,
	narrowed,
	probeKey,
	storedAt
} from "#compiler/write/probe.ts"
import type { KeyArbiter } from "#compiler/write/put/choose.ts"

import type { ConcurrentChangeTag } from "#compiler/runtime/write/refusal.ts"
import {
	type ArmRefusal,
	type RefusedValue,
	refusalGuard,
	refusalRank,
	type SourcedArm,
	sourcedRefusalGuard
} from "#compiler/write/refusal.ts"
import { explicitSerials } from "#compiler/write/serial/advance.ts"

/** Whose stored facts an insert's arbiter may return: every one where the role holds its relation whole; or, into a
 * role's query entry, under row security, only those the entry's membership holds (precheck.ts membershipOf), which
 * its ON CONFLICT DO SELECT selects before PostgreSQL checks the SELECT policy against a conflicting row
 * (nodeModifyTable.c ExecOnConflictSelect: the WHERE, then WCO_RLS_CONFLICT_CHECK), so a stored fact outside the
 * entry is never returned and never raises 42501. */
export type InsertEntry =
	| { readonly kind: "whole" }
	| { readonly kind: "entry"; readonly membership: EntryMembership }

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
	readonly entry: InsertEntry
}

/** Where an insert raises its probe's refusal (see `buildInsert`): nowhere, when it probes nothing; at the INSERT's gate,
 * the refusal guard over the probe's refusal; or as one of its verdict rows, marked by its object's signed ordinal. */
type ProbeRaise =
	| { readonly kind: "none" }
	| { readonly kind: "gate"; readonly guarded: { readonly cte: Cte; readonly guard: Expr } }
	| { readonly kind: "verdict"; readonly probe: ProbeSql; readonly marker: string }

/** What the classification after an insert reads of the insert's spec. */
type ClassifySpec = Pick<InsertSpec, "relation" | "serial" | "input" | "of">

/** An insert's variant, by its serial class, the relation's shape and what its facts state, with what it reads of the
 * shape: a spanKey insert's span key field, which its classification compares by overlap, and a protocol insert's
 * payload, which its verdict rows compare. */
type InsertShape =
	| { readonly variant: "generated" }
	| { readonly variant: "pureSet" }
	| { readonly variant: "spanKey"; readonly span: SpanField }
	| { readonly variant: "protocol"; readonly payload: NonEmptyReadonlyArray<LawField> }

/** The shape of an insert of complete facts that state `stated` (input.ts inputStated): its payload is every field they
 * state beside the key, in heading order, the caller's (frontend/targets.ts payloadOf) and a nested owner's sequences'
 * counts and ends, which its facts state with the members they nest; a pure set where they state none. */
const insertShape = (relation: RelationInfo, stated: Heading): InsertShape => {
	const key = primaryKeyShape(relation)
	if (key.kind === "span") {
		return { variant: "spanKey", span: key.span }
	}
	const payload = relation.heading.filter(
		(f) => !relation.primaryFields.includes(f) && stated.some((c) => c.name === f.name)
	)
	return isNonEmpty(payload) ? { variant: "protocol", payload } : { variant: "pureSet" }
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
 * that key, its payload the fields the addition writes beside the key, which its verdict rows compare, or a pure set
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

/** The shape of an insert of class `serial` into `relation` whose facts state `stated` (input.ts inputStated): a
 * generated addition's at its stated arbiter (`statedShape`), a plain INSERT where it has none, and complete facts' by
 * the relation and what they state (`insertShape`). */
const shapeOf = (relation: WrittenRelation, serial: SerialClass, stated: Heading): InsertShape => {
	if (serial.kind === "complete") {
		return insertShape(relation, stated)
	}
	const arbiter = generatedArbiter(relation.uniques, serial.drawn)
	return arbiter === undefined ? { variant: "generated" } : statedShape(relation, serial, arbiter)
}

/**
 * Whether an insert of class `serial` realizing `of` into `relation` writes a met side, the stored facts its insertion
 * met and did not refuse (`delta.met`): an insertion that arbitrates at a scalar key, the protocol or a pure set
 * whatever its facts state, complete facts at a scalar primary key and a generated addition at its stated arbiter. A
 * put's insert half meets only its own no-change or a concurrent change, a plain INSERT meets nothing, and a span
 * primary key's exclusion constraint takes only ON CONFLICT DO NOTHING ON CONSTRAINT, so no statement tells a fact it
 * met from one it made. The insert statement's Returning is read from it, and so is every plan that asks which
 * statement writes a met side.
 */
export const writesMet = (relation: WrittenRelation, serial: SerialClass, of: InsertOf): boolean =>
	of === "insert" &&
	(serial.kind === "complete"
		? primaryKeyShape(relation).kind !== "span"
		: generatedArbiter(relation.uniques, serial.drawn) !== undefined)

/**
 * The verdict of a stored fact an insert meets at its arbiter key that differs from the requested fact at a field it
 * states, by its relation and the action it realizes: an insertion into a raced relation (ir/law.ts Inserts `race`)
 * meets it, the row its key's first insertion holds; any other insertion's is the arbiter key law's conflict witness,
 * which refuses the write; and a put's insert half's a concurrent commit at the key after its deletion,
 * PutTargetConflict, raced or not, since a put asserts its row.
 */
const occupantVerdict = (insert: {
	readonly relation: WrittenRelation
	readonly of: InsertOf
}): "conflict" | "met" =>
	insert.of === "insert" && insert.relation.inserts === "race" ? "met" : "conflict"

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
 * What a verdict row of an arbitrated insert is (see `buildInsert`), by its class, the verdict column's value: a fact
 * the INSERT inserted; a stored fact it met and did not refuse, an insertion's met side; the arbiter key law's conflict
 * witness; a concurrent change on a put's insert half; a conflict at the i-th other unique object of an insert
 * arbitrating every object, `other + i`; a met row no snapshot shows, the statement's defect; or a row a marker of its
 * own raises, a same-key pair's or the probe's, which no class arm and no side reads.
 */
const verdictClass = {
	inserted: 0,
	met: 1,
	conflict: 2,
	change: 3,
	other: 4,
	defect: -1,
	raised: -2
} as const

/**
 * How an insert's INSERT meets the stored rows its requested facts conflict with, by the level its role runs at
 * (statement.ts WriteContext `level`), the relation's objects and the insert's shape, so every insert of a role takes
 * one form:
 * - `returned`: ON CONFLICT at its arbiter's scalar key DO SELECT, with no WHERE (an entry's membership for an insert
 *   into a query entry, `InsertEntry`), so RETURNING yields each stored row the arbiter met, an exact repeat, a
 *   conflict or a race's occupant, beside each row the INSERT inserted, told apart by `old`: PostgreSQL 19 returns the
 *   existing row as OLD for a DO SELECT row and an all-NULL OLD for an inserted one (nodeModifyTable.c
 *   ExecOnConflictSelect and ExecInsert's ExecProcessReturning). The unique pre-check waits for an occupant's writer,
 *   and ExecOnConflictSelect fetches the occupant under SnapshotAny; below a transaction snapshot it checks no
 *   visibility (ExecCheckTupleVisible), so at READ COMMITTED it returns a row committed after the statement's snapshot,
 *   on the first try. At SERIALIZABLE a met row the transaction snapshot cannot see raises 40001, and since that fetch
 *   takes no SIRead lock (predicate.c SerializationNeededForRead refuses a non-MVCC snapshot), each met row is read
 *   again at its key under the snapshot, so SSI sees the read. Every other unique object is probed under the
 *   statement's snapshot (unique.ts buildProbe). It is every insert's form at a scalar arbiter key but `every`'s;
 * - `every`: complete facts at SERIALIZABLE into a relation every native object of which is a unique object, ON CONFLICT
 *   DO NOTHING with no target, so every unique and exclusion object arbitrates and a conflicting row in flight sends the
 *   insert back to its pre-check, never to a 23505 or 23P01. A row its transaction snapshot cannot see raises 40001
 *   (nodeModifyTable.c ExecCheckTupleVisible), so every stored row it met is visible. The INSERT proposes a CTE of its
 *   own, every gate in it, and each row of it the INSERT did not return, a met row (sql/ast.ts FromSource `metRows`), is
 *   classified by the stored rows its arbitration met (`met`) at the arbiter and then at each other object, read under
 *   the snapshot: a complete proposal reads no stored row for a fact it inserts; a placeholder's gate is a probe at its
 *   key;
 * - `constraint`: into a primary key holding a span, ON CONFLICT ON CONSTRAINT DO NOTHING, the one form an exclusion
 *   constraint arbitrates, followed by its classification (`buildSpanClassify`);
 * - `none`: a plain INSERT, a generated addition every declared key of which holds a field it draws.
 */
type Arbitration =
	| { readonly kind: "returned"; readonly payload: ReadonlyArray<LawField> }
	| { readonly kind: "every"; readonly objects: Extract<EveryObject, { readonly kind: "named" }> }
	| { readonly kind: "constraint" }
	| { readonly kind: "none" }

const arbitrationOf = (
	w: WriteContext,
	relation: WrittenRelation,
	serial: SerialClass,
	shape: InsertShape
): Arbitration => {
	if (
		w.level === "serializable" &&
		serial.kind === "complete" &&
		relation.uniques.every.kind === "named"
	) {
		return { kind: "every", objects: relation.uniques.every }
	}
	switch (shape.variant) {
		case "generated":
			return { kind: "none" }
		case "spanKey":
			return { kind: "constraint" }
		case "pureSet":
			return { kind: "returned", payload: [] }
		case "protocol":
			return { kind: "returned", payload: shape.payload }
	}
}

/** The same-key check reports the least key that occurs twice, so the witness never depends on the plan.
 *
 * The probe's refusal: the requested fact, the verdict class `raised`, and the signed ordinal.
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
 *     RETURNING "r3"."id" AS "c4", "r3"."account" AS "c5", "r3"."kind" AS "c6", (old."id" = new."id") IS TRUE AS "c7"
 *   ),
 *   "r5"("c4", "c5", "c6", "c8") AS MATERIALIZED (
 *     SELECT "r2"."c4", "r2"."c5", "r2"."c6",
 *            CASE WHEN NOT "r2"."c7" THEN 0 WHEN ("r2"."c5", "r2"."c6") = ("r1"."c2", "r1"."c3") THEN 1 ELSE 2 END
 *     FROM "r2" JOIN "r1" ON "r1"."c1" = "r2"."c4"
 *   ),
 *   "r6"(...) AS (<the refusals among r5's rows>)
 *   SELECT "r5"."c4"::text AS "c4", ... FROM "r5" WHERE NOT EXISTS (SELECT 1 FROM "r6" WHERE "work"."__refuse"(...))
 *     AND "r5"."c8" = 0
 *
 * RETURNING yields every row the INSERT inserted and every stored row its arbiter met (Arbitration `returned`), c7
 * false on an inserted row, whose OLD is all NULL, and true on a met one, whose OLD is the stored row. These are the
 * verdict rows, each of one class (`verdictClass`): an inserted fact; a met fact equal to the request at every field it
 * states, an exact repeat; or one that differs there, which `occupantVerdict` judges: an insertion's conflict witness at
 * an occupied key, which raises the key law, its witness the key; a put's insert half's concurrent change. A verdict
 * row that refuses the write is never returned: the statement raises it through the installation's refusal function, so
 * PostgreSQL aborts the transaction. The statement's own rows are the facts it inserted (class `inserted`), which its
 * outcome and counts read, and its Returning reads them as the added side and an insertion's met rows as the met side
 * (`writesMet`), so no reader of its rows takes a fact it met for one it made: the verdict CTE is the one reader of
 * RETURNING. The outermost SELECT casts its columns to text. At SERIALIZABLE the class of a met row first asks that the
 * transaction snapshot see the stored row at its key, a read SSI tracks (`returned`), and a met row it cannot see is
 * the statement's defect, as `every`'s. Into a role's query entry the DO SELECT selects only an occupant the entry's
 * membership holds (InsertEntry), and each request the INSERT neither inserted nor returned is refused by its key, a
 * row of a CTE of its own that the refusal guard reads beside the verdict rows, as an occupant that differs is and
 * never as met: a stored fact outside the entry holds its key, committed after the entry's precheck, which a retry's
 * precheck refuses on that key's law. The variant is chosen by relation and member shape alone (`shapeOf`), the
 * payload being every field the facts state beside the key (input.ts inputStated): the caller's, and a nested owner's
 * sequences' counts and ends, which its facts state with the members they nest, so an owner inserted again with
 * another sequence differs:
 *
 * - Facts with a payload: ON CONFLICT (the key) DO SELECT, as above.
 * - A family owner (statement.ts Proposal, `proposalOf`): the INSERT reads only the requested facts no stored row holds
 *   the key of, `WHERE NOT EXISTS (SELECT 1 FROM <relation> s WHERE s.<key> = r1.<key>)`. A proposed row carries every
 *   count and end its input does not carry at its start, and PostgreSQL judges it by every CHECK before the arbiter
 *   meets its key, so a stored owner proposed again would meet a check over an end at that placeholder. For an
 *   insertion, each stored owner at a requested key is a verdict row of its own, the stored row, classed as DO SELECT
 *   would have returned it: an exact repeat where its payload is the request's, else what `occupantVerdict` judges.
 *   Those rows are read from the requested facts, `FROM r1 JOIN <relation> s ON s.<key> = r1.<key>`, so each request
 *   probes the owner's key and no insertion scans the owner. For a put, the row at a requested key is the one the put's
 *   UPDATE wrote. The arbiter stays for a concurrent commit at the key.
 * - Pure sets, whose facts state their key alone: ON CONFLICT (every key column) DO SELECT, every row it met an exact
 *   repeat.
 * - Generated additions, which omit the serial fields their class draws, each taking its identity or its `uuidv7()`
 *   default: where a declared key holds none of those fields and no span, the protocol above at the first such key
 *   (unique.ts generatedArbiter), ON CONFLICT (that key) DO SELECT, its payload the fields it writes beside the key, so
 *   an exact repeat of a stored fact at every field the addition states changes nothing and is met whole, its drawn
 *   fields the stored fact's, and any other occupant of that key is its law's conflict witness; its own refusals, a
 *   same-key pair and the probe's, are raised at the INSERT's gate, since a request it refuses never takes the values
 *   its relation draws. Where every key holds one, a plain INSERT ... RETURNING of the complete row with no arbiter,
 *   every requested fact a new one, probed at every unique object that reads no drawn field (see the probe below). A
 *   serial field the addition carries, one its entry's filter reads or its fill fixes, is an explicit serial value,
 *   written as it is. Equal generated additions are one: a carried or described one is read through SELECT DISTINCT
 *   over its head. A generated class of no field reads the unit input and assigns no column, so every column takes its
 *   identity: `INSERT INTO ... AS "r3" SELECT FROM "r1"`.
 * - Explicit serial values, complete facts' and those a generated addition carries: OVERRIDING SYSTEM VALUE, because
 *   the column is GENERATED ALWAYS; the sequence advance that follows is serial/.
 * - Carriers and described members, which nobody normalized on the host, read SELECT DISTINCT over the input and gate
 *   the INSERT with a same-key check in the same statement:
 *
 *     r4("c9") AS (SELECT "r1"."c1" FROM "r1" GROUP BY "r1"."c1" HAVING count(*) > 1 ORDER BY "r1"."c1" LIMIT 1),
 *     ... SELECT ... FROM "r1" WHERE NOT EXISTS (SELECT 1 FROM "r4") ORDER BY "r1"."c1" ON CONFLICT ...
 *     SELECT ..., false AS "c10" FROM "r2" JOIN "r1" ON ... UNION ALL SELECT "r4"."c9", -2, true FROM "r4"
 *
 *   Two input facts at one key with different payloads leave one such key in r4, the INSERT inserts nothing, and the
 *   only verdict row is that key with c10 true: a same-key conflict within the ChangeSet, which raises the key law on a
 *   put's insert half too. Either step is elided where the input's proof says it is distinct or unique
 *   on the primary key; a pure set needs no same-key check, its key being the whole fact.
 *
 * - Every unique object of the relation besides the arbiter is probed in the same statement, after the
 *   same-key check: a visible occupant, or a pair within an input the host did not refuse, gates the INSERT the same
 *   way and is one more UNION ALL arm of the verdict rows, the requested fact with the object's signed ordinal c11 (0 on
 *   every other row), which raises that object's law; a 23505 or 23P01 the INSERT still raises there is an unseen
 *   occupant, a TransientFailure. A probed statement returns complete facts, which the witness reads from.
 * - A generated addition is probed the same way at every unique object that reads no field it draws but its arbiter,
 *   its primary key among them when that reads none and is not the arbiter. A refused addition never becomes a fact, so
 *   its refusal is no verdict row: the refusal guard over the probe's refusal is the INSERT's own gate, which raises
 *   before anything is inserted, r1 being nonempty whenever a refusal is found in it. Every 23505 or 23P01 the INSERT
 *   still raises aborts the apply: an unseen occupant (UnseenOccupant), or at an object that reads a drawn field a
 *   stored value its sequence had not passed (GeneratedSerialUnique).
 *
 * ORDER BY the primary key under the fixed collation makes concurrent inserters take new-key locks in one order.
 * Every input value is cast to its column's type where it is not already of that type
 * (`writeValue`), and the cast is inside the input CTE r1, so r1 holds the facts as they are written: a
 * member column typed only compatibly with its field, such as numeric(12,4) into numeric(10,2), can change value under
 * the cast, and SELECT DISTINCT, the same-key check, the ORDER BY and the verdict's comparison all compare
 * the written facts, never the member's values before the cast. The outer SELECT returns the complete fact, which a
 * read-back of delta.added and the netting of deltas and counts across strata need; a same-key verdict row carries the
 * input's facts at that key, so no column is ever manufactured. A met row is the stored fact itself, as RETURNING or
 * the met read delivers it, never the request it repeats.
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
 * Under a transaction snapshot every stored row an insert meets is read under that snapshot, so SSI sees an exact
 * repeat, which inserts nothing, as a read of the stored fact: `every`'s met rows by their met read, and `returned`'s by
 * the read that classes each, since the arbiter itself fetches the occupant under SnapshotAny, which takes no SIRead
 * lock. An insert after a concurrent deletion of an occupant the snapshot held is a write into what the deletion read.
 * A transaction that would commit in no serial order with a concurrent one fails with 40001, a TransientFailure.
 *
 * A vector field compares through the extension's qualified operator, and a row comparison that holds one, such as the
 * verdict's comparison over a vector payload, is spelled column by column: PostgreSQL resolves each column
 * operator by name through the search_path, and no login's search_path holds the extension schema. */
export const buildInsert = (
	w: WriteContext,
	spec: InsertSpec
): ModifyingStatement<InsertResult> => {
	const { relation, serial, input } = spec
	const at = `insert ${relation.name}`
	const { arbiter, stated } = arbiterOf(relation, serial)
	const shape = shapeOf(relation, serial, inputStated(input))
	const variant: InsertVariant = shape.variant
	/** A generated addition's verdict rows are the facts its INSERT made: a request it refuses never takes the values its
	 * relation draws, so its own refusals, a same-key pair and the probe's, are raised at the INSERT's gate. */
	const atGate = serial.kind === "generated"
	const guarantees = inputGuarantees(input)
	const sameKeyCheck = variant === "protocol" && !keyUniqueBy(guarantees.keyUnique)
	const written = insertedFields(relation, serial)
	const proposes = proposalOf(relation, serial, insertArbitered(relation.uniques, serial))
	const arbitration = arbitrationOf(w, relation, serial, shape)
	const meets = writesMet(relation, serial, spec.of)
	/** The class of a stored fact the insert meets at its arbiter key that differs from the request at a stated field
	 * (`occupantVerdict`). */
	const differing =
		occupantVerdict(spec) === "met"
			? verdictClass.met
			: spec.of === "put"
				? verdictClass.change
				: verdictClass.conflict
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
	const same = (f: LawField, a: Expr, b: Expr): Expr => typedEq(rowType(f), a, b, w.names)
	const integer = (n: number): Expr => lit.int(n, types.integer)
	/** The requested facts the probe reads and the objects it probes (`buildProbe`): a generated addition is probed at every
	 * object that reads no field it draws, complete facts at every object besides the arbiter. */
	const probed: { readonly requested: Requested; readonly checks: ReadonlyArray<Probed> } =
		serial.kind === "generated"
			? {
					requested:
						stated === undefined ? { kind: "none", fields } : { kind: "stated", arbiter: stated },
					checks: generatedChecks(relation.uniques, serial.drawn, stated)
				}
			: {
					requested: { kind: "complete", arbiter: relation.uniques.arbiter },
					checks: relation.uniques.checks
				}
	/** The outer SELECT returns complete facts: a read-back and the netting across strata read them, and a unique
	 * refusal's witness is the requested fact at the object's fields. */
	const outFields = all
	const sharing = inputSharing(
		w.share.inserts,
		[input],
		[
			relation,
			serial,
			input,
			spec.of,
			spec.entry.kind === "entry" ? spec.entry.membership.entry : spec.entry.kind
		]
	)
	return buildStatement(w, sharing, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const r1 = supply.relation(internal("input"))
		const r2 = supply.relation(internal("insert"))
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const r4 = sameKeyCheck ? supply.relation(internal("same-key check")) : undefined
		const inputs = fieldColumns(fields, () => supply.column(internal("input column")))
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		/** The verdict column (`verdictClass`), each verdict row's class, of an insert that meets stored facts at a scalar key or
		 * at every object; none for a plain INSERT or a span key's, every row of which is a fact it inserted. */
		const cV =
			arbitration.kind === "returned" || arbitration.kind === "every"
				? supply.column(internal("verdict"))
				: undefined
		/** The met marker of a `returned` insert's RETURNING: whether OLD is a stored row, so the row is one the arbiter met. */
		const metMark =
			arbitration.kind === "returned" ? supply.column(internal("met marker")) : undefined
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
					? [
							{
								object: arbitration.objects.arbiter,
								pairs: "statement",
								witness: spec.of === "insert" ? "requestedAnew" : "every"
							},
							...probed.checks
						]
					: probed.checks,
			input: r1,
			inputs,
			normalized: input.kind === "relation",
			occupants: arbitration.kind === "every" ? "met" : "probed"
		})
		if (probe !== undefined) {
			appendAll(ctes, probe.ctes)
		}
		/** Where the probe's refusal is raised (see `buildInsert`): at the INSERT's own gate for a generated addition,
		 * whose verdict rows are the complete facts the INSERT made, which a refused addition never becomes; else as a
		 * verdict row marked by its object's signed ordinal, beside the rows of the arms that read what the INSERT
		 * returned. */
		const unique: ProbeRaise =
			probe === undefined
				? { kind: "none" }
				: atGate
					? { kind: "gate", guarded: probeGuard(w, supply, relation.name, probe) }
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
		/** How the INSERT meets its occupants (Arbitration): at `returned` its DO SELECT selects every one, or into a query
		 * entry those the entry's membership holds. */
		const conflictOf = (): OnConflict | undefined => {
			switch (arbitration.kind) {
				case "every":
					return { kind: "every", action: { kind: "doNothing" } }
				case "none":
					return undefined
				case "constraint":
					return {
						kind: "constraint",
						constraint: w.names.primaryKey(relation.name),
						action: { kind: "doNothing" }
					}
				case "returned":
					return {
						kind: "columns",
						columns: mapNonEmpty(pk, column),
						action: {
							kind: "doSelect",
							where:
								spec.entry.kind === "entry"
									? membershipOf(w, spec.entry.membership, (f) => col(r3, column(f)))
									: undefined
						}
					}
			}
		}
		/** Whether OLD is a stored row: `old.k = new.k` over the arbiter key's first field, which no key leaves NULL, is
		 * NULL on a row the INSERT inserted, whose OLD is all NULL, and true on one its DO SELECT met. */
		const [firstKey] = pk
		const metMarked: Expr = {
			kind: "isTrue",
			expr: same(
				firstKey,
				{ kind: "returning", side: "old", column: column(firstKey) },
				{ kind: "returning", side: "new", column: column(firstKey) }
			)
		}
		const insert: Insert = {
			kind: "insert",
			with: undefined,
			table: w.names.relation(relation.name),
			alias: r3,
			columns: [...fields.map(column), ...starts.map((s) => column(s.field))],
			overriding: explicitSerials(relation, serial).length > 0 ? "SYSTEM VALUE" : undefined,
			source: { kind: "query", query: source },
			onConflict: conflictOf(),
			returning: [
				...all.map((f) => targetAs(col(r3, column(f)), retCol(f))),
				...(metMark === undefined ? [] : [targetAs(metMarked, metMark)])
			]
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
		const notPaired = c9 === undefined ? [] : [targetAs(lit.bool(false), c9)]
		/** The class of a stored fact met for a request (`verdictClass`), its fields read by `stored`, beyond the classes `first`
		 * settles: an exact repeat, equal to the request at every field of `payload`, is met, and any other is `differing`
		 * (occupantVerdict). */
		const metClass = (
			payload: ReadonlyArray<LawField>,
			stored: (f: LawField) => Expr,
			first: ReadonlyArray<{ readonly when: Expr; readonly result: Expr }>
		): Expr => {
			const repeat =
				isNonEmpty(payload) && differing !== verdictClass.met
					? [
							{
								when: rowEq({ fields: payload, typeOf, left: stored, right: inCol }, w.names),
								result: integer(verdictClass.met)
							}
						]
					: []
			const whens = [...first, ...repeat]
			const otherwise = integer(isNonEmpty(repeat) ? differing : verdictClass.met)
			return isNonEmpty(whens)
				? { kind: "case", operand: undefined, whens, else: otherwise }
				: otherwise
		}
		/**
		 * An insertion's placeholder proposal withholds each requested fact stored at its key (statement.ts Proposal
		 * `unstored`), so its INSERT never meets one: each one stored there is a verdict row of its own, the stored row
		 * read by the probe at its key (probe.ts probeKey) under the statement's snapshot, classed as DO SELECT would
		 * have classed it. Each stored row is one verdict row: the requests' keys are unique, by the input's proof or,
		 * where they are not, by the same-key gate, without which the same-key refusal ranks first and the statement raises
		 * it whatever these rows are.
		 */
		const withheld = (payload: ReadonlyArray<LawField>, cv: string): ReadonlyArray<SetCore> => {
			if (spec.of !== "insert" || proposes !== "unstored") {
				return []
			}
			const owner = probeKey(
				w,
				supply,
				relation.name,
				atFields(w, relation.name, pk, inCol),
				mapNonEmpty(all, column)
			)
			const stored = (f: LawField): Expr => owner.at(column(f))
			return [
				provedCore(
					"keyed",
					[
						...outFields.map((f) => targetAs(stored(f), retCol(f))),
						targetAs(metClass(payload, stored, []), cv),
						...notPaired,
						...zero
					],
					[cteRef(r1), owner.source],
					conjunction(r4 === undefined ? [] : [noSharedKey(r4)])
				)
			]
		}
		/** The same-key pair, the requested facts at the one key two of them hold with different payloads (`r4`), its
		 * class `raised` and its own marker true. */
		const paired = (cv: string): ReadonlyArray<SetCore> => {
			if (r4 === undefined || c9 === undefined) {
				return []
			}
			const r4Col = (f: LawField) => col(r4, keys.of(f))
			return [
				provedCore(
					"keyed",
					[
						...outFields.map((f) => target(requested(f))),
						targetAs(integer(verdictClass.raised), cv),
						targetAs(lit.bool(true), c9),
						...zero
					],
					[
						join(
							cteRef(r1),
							cteRef(r4),
							and(mapNonEmpty(pk, (f) => same(f, inCol(f), r4Col(f))))
						) satisfies FromItem
					],
					undefined
				)
			]
		}
		/**
		 * The verdict rows at `returned` (Arbitration): each row r2 returned beside its request, inserted where OLD is all
		 * NULL, else classed against the request; at SERIALIZABLE a met row first asks the transaction snapshot to show the
		 * stored row at its key, a read SSI tracks, which a row an earlier INSERT of the statement wrote fails, the
		 * statement's defect. Then the withheld stored facts and the same-key pair.
		 */
		const returnedBody = (
			payload: ReadonlyArray<LawField>,
			cv: string,
			mark: string
		): Select["body"] => {
			const seen =
				w.level === "serializable"
					? [
							{
								when: not(
									storedAt(
										w,
										supply,
										relation.name,
										atFields(w, relation.name, pk, (f) => col(r2, retCol(f)))
									)
								),
								result: integer(verdictClass.defect)
							}
						]
					: []
			const left: SetCore = provedCore(
				"keyed",
				[
					...factOf(r2, retCol),
					targetAs(
						metClass(payload, (f) => col(r2, retCol(f)), [
							{ when: not(col(r2, mark)), result: integer(verdictClass.inserted) },
							...seen
						]),
						cv
					),
					...notPaired,
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
			return unionAll("disjoint", [left, ...withheld(payload, cv), ...paired(cv)])
		}
		/**
		 * The met rows at `every` (Arbitration), each row of the proposed CTE r2 did not return (sql/ast.ts FromSource
		 * `metRows`), and each one's class, read from the stored rows the arbitration met at it (probe.ts metFound),
		 * each object in order:
		 * - met: an exact repeat, the row met at the arbiter equal to it at every field it states, which changes nothing;
		 * - the arbiter's: a stored row at its key with another payload, `differing` (occupantVerdict), or overlapping it at
		 *   a span key at another span, the key law; on a put's insert half at a span key only one at another span;
		 * - change: a concurrent change on a put's insert half, a stored row at its own key after its deletion,
		 *   PutTargetConflict, or SpanKeyChange at a span key;
		 * - other + i: the law of the i-th other unique object of the relation in law order, the first that met it.
		 * Every native object of the relation is one of these objects or held by one (unique.ts EveryObject `named`;
		 * laws/model/uniques.ts beyondPrimary), so the arbitration met each met row at one of them where the statement's
		 * snapshot shows the occupant. A row an earlier INSERT of the same statement wrote is met with no wait and shown by
		 * no snapshot: such a met row takes the class defect, the statement's defect (refusal.ts ArmRefusal `defect`). Its
		 * CTE's columns are every field's, by r2's returned names, then the class. It is MATERIALIZED, so its classes are
		 * computed over the met rows alone: a filter on the class pushed below the met rows' anti-join would read the stored
		 * rows for every fact the INSERT inserted.
		 */
		const classifyMet = (
			objects: Extract<EveryObject, { readonly kind: "named" }>,
			from: { readonly name: string; readonly columns: FieldColumns<string> },
			cv: string
		): { readonly classified: string; readonly met: SetCore } => {
			const primary = objects.arbiter
			const metRows = () =>
				metRowsOf(w, supply, {
					insert: r2,
					proposed: from.name,
					columns: mapNonEmpty(all, (f) => from.columns.of(f)),
					key: mapNonEmpty(pk, (f) => ({
						field: f,
						column: from.columns.of(f),
						returned: retCol(f)
					}))
				})
			const met = metRows()
			const metValue = (f: LawField): Expr => col(met.alias, from.columns.of(f))
			const found = (access: MetAccess): Expr => metFound(w, supply, relation.name, access)
			const atArbiter = metAtObject(w, relation.name, primary, met.alias, from.columns.of)
			const storedField = (inner: string) => (f: LawField) => col(inner, column(f))
			const statedFields = inputStated(input)
			const compared = all.filter(
				(f) => !primary.equal.includes(f) && statedFields.some((c) => c.name === f.name)
			)
			/** An exact repeat at the arbiter: the stored row there equal to the met row at every field it states. */
			const repeated = (access: MetAccess): MetAccess =>
				metNarrowed(access, (inner) =>
					compared.map((f) => same(f, storedField(inner)(f), col(access.rows, from.columns.of(f))))
				)
			const keyed: NonEmptyReadonlyArray<{ readonly when: Expr; readonly result: Expr }> =
				spec.of === "put" && primary.kind === "span"
					? [
							{
								when: found(
									metNarrowed(atArbiter, (inner) => [
										ne(storedField(inner)(primary.span), metValue(primary.span))
									])
								),
								result: integer(verdictClass.conflict)
							},
							{ when: found(atArbiter), result: integer(verdictClass.change) }
						]
					: [{ when: found(atArbiter), result: integer(differing) }]
			const classes = [
				{ when: found(repeated(atArbiter)), result: integer(verdictClass.met) },
				...keyed,
				...objects.others.map((u, i) => ({
					when: found(metAtObject(w, relation.name, u, met.alias, from.columns.of)),
					result: integer(verdictClass.other + i)
				}))
			]
			const [first, ...rest] = classes
			const rk = supply.relation(internal("met classes"))
			ctes.push({
				...cte(
					rk,
					[...outFields.map(retCol), cv],
					select(
						provedCore(
							"keyed",
							[
								...outFields.map((f) => target(metValue(f))),
								target({
									kind: "case",
									operand: undefined,
									whens: [defined(first, "a met row's first class"), ...rest],
									else: integer(verdictClass.defect)
								})
							],
							[met.source],
							undefined
						)
					)
				),
				materialized: "MATERIALIZED"
			})
			/** The stored facts an insertion met and did not refuse, each read where its arbitration met it (probe.ts
			 * metRow) under the transaction snapshot, so each is the stored fact itself: an exact repeat, or, where a
			 * differing occupant is met (occupantVerdict), any occupant of its key. */
			const delivered = metRows()
			const deliveredAt = metAtObject(w, relation.name, primary, delivered.alias, from.columns.of)
			const stored = metRow(
				w,
				supply,
				relation.name,
				differing === verdictClass.met ? deliveredAt : repeated(deliveredAt),
				mapNonEmpty(all, column)
			)
			return {
				classified: rk,
				met: provedCore(
					"keyed",
					[
						...outFields.map((f) => targetAs(stored.at(column(f)), retCol(f))),
						targetAs(integer(verdictClass.met), cv),
						...notPaired,
						...zero
					],
					[delivered.source, stored.source],
					undefined
				)
			}
		}
		/**
		 * The verdict rows at `every` (Arbitration): the rows r2 inserted, an insertion's met rows (`writesMet`), each met
		 * row that is no met row with its class, read from the stored rows the arbitration met (`classified`), the withheld
		 * stored facts and the same-key pair.
		 */
		const everyBody = (
			objects: Extract<EveryObject, { readonly kind: "named" }>,
			from: { readonly name: string; readonly columns: FieldColumns<string> },
			cv: string
		): Select["body"] => {
			const { classified, met } = classifyMet(objects, from, cv)
			const left: SetCore = provedCore(
				"keyed",
				[
					...factOf(r2, retCol),
					targetAs(integer(verdictClass.inserted), cv),
					...notPaired,
					...zero
				],
				[cteRef(r2)],
				undefined
			)
			const refused: SetCore = provedCore(
				"keyed",
				[
					...outFields.map((f) => targetAs(col(classified, retCol(f)), retCol(f))),
					targetAs(col(classified, cv), cv),
					...notPaired,
					...zero
				],
				[cteRef(classified)],
				ne(col(classified, cv), integer(verdictClass.met))
			)
			const statedFields = inputStated(input)
			const payload = all.filter(
				(f) => !pk.includes(f) && statedFields.some((c) => c.name === f.name)
			)
			return unionAll("disjoint", [
				left,
				...(meets ? [met] : []),
				refused,
				...withheld(payload, cv),
				...paired(cv)
			])
		}
		const verdictRows = (): Select["body"] => {
			switch (arbitration.kind) {
				case "every":
					return everyBody(
						arbitration.objects,
						defined(proposed, "the CTE an insert arbitrating every object proposes"),
						defined(cV, "the verdict column of an insert arbitrating every object")
					)
				case "returned":
					return returnedBody(
						arbitration.payload,
						defined(cV, "the verdict column of an insert its arbiter returns"),
						defined(metMark, "the met marker of an insert its arbiter returns")
					)
				case "none":
				case "constraint":
					return provedCore("keyed", [...factOf(r2, retCol), ...zero], [cteRef(r2)], undefined)
			}
		}
		const verdicts = verdictRows()
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
								...(cV === undefined ? [] : [target(integer(verdictClass.raised))]),
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
			...(cV === undefined ? [] : [cV]),
			...(c9 === undefined ? [] : [c9]),
			...(cU === undefined ? [] : [cU])
		]
		ctes.push({
			name: rv,
			columns: verdictColumns,
			materialized: "MATERIALIZED",
			query: select(body)
		})
		/**
		 * Into a query entry, the requests the INSERT neither inserted nor returned, each by its key: a stored fact the
		 * entry's membership does not hold occupies it (InsertEntry), committed after the entry's precheck, and the
		 * request is refused as an occupant that differs is, never met. A CTE of its own, since a generated addition's
		 * request holds no value of a field it draws.
		 */
		const unmet =
			spec.entry.kind === "entry" && arbitration.kind === "returned"
				? {
						name: supply.relation(internal("unreturned requests")),
						columns: fieldColumns(pk, () => supply.column(internal("unreturned key column")))
					}
				: undefined
		if (unmet !== undefined) {
			ctes.push(
				cte(
					unmet.name,
					unmet.columns.columns,
					provedSelect(
						"keyed",
						pk.map((f) => targetAs(inCol(f), unmet.columns.of(f))),
						[cteRef(r1)],
						conjunction([
							...gates,
							notExists(
								simpleSelect(
									[target(integer(1))],
									[cteRef(r2)],
									and(mapNonEmpty(pk, (f) => same(f, inCol(f), col(r2, retCol(f)))))
								)
							)
						])
					)
				)
			)
		}
		const verdict = (c: string): Expr => col(rv, c)
		const keyOf = (keyFields: ReadonlyArray<LawField>, valueOf: (f: LawField) => Expr) =>
			keyFields.map((f): RefusedValue => ({
				field: f.name,
				expr: valueOf(f),
				type: rowType(f)
			}))
		const keyLaw = (
			keyFields: ReadonlyArray<LawField>,
			law: LawId,
			valueOf: (f: LawField) => Expr
		): ArmRefusal => ({
			kind: "law",
			law,
			relation: relation.name,
			key: keyOf(keyFields, valueOf)
		})
		const change = (reason: ConcurrentChangeTag, valueOf: (f: LawField) => Expr): ArmRefusal => ({
			kind: "change",
			reason,
			relation: relation.name,
			constraint: w.names.primaryKey(relation.name),
			key: keyOf(pk, valueOf)
		})
		const verdictAt = (f: LawField): Expr => verdict(retCol(f))
		/** The arms, each reading exactly the rows its refusal is (see `buildInsert`). */
		const fromVerdicts = cteRef(rv)
		const arms: Array<SourcedArm> = []
		if (c9 !== undefined) {
			arms.push({
				from: fromVerdicts,
				rank: refusalRank.sameKey,
				when: verdict(c9),
				refusal: keyLaw(pk, pkLaw, verdictAt)
			})
		}
		if (unique.kind === "verdict") {
			appendAll(
				arms,
				probeArms(relation.name, unique.probe.checks, verdict(unique.marker), verdictAt).map(
					(a) => ({
						...a,
						from: fromVerdicts
					})
				)
			)
		}
		if (cV !== undefined) {
			const classIs = (n: number): Expr => eq(verdict(cV), integer(n))
			const changeReason: ConcurrentChangeTag =
				arbitration.kind === "every" && arbitration.objects.arbiter.kind === "span"
					? "SpanKeyChange"
					: "PutTargetConflict"
			arms.push({
				from: fromVerdicts,
				rank: refusalRank.conflict,
				when: classIs(verdictClass.conflict),
				refusal: keyLaw(pk, pkLaw, verdictAt)
			})
			if (spec.of === "put") {
				arms.push({
					from: fromVerdicts,
					rank: refusalRank.change,
					when: classIs(verdictClass.change),
					refusal: change(changeReason, verdictAt)
				})
			}
			if (arbitration.kind === "every") {
				for (const [i, u] of arbitration.objects.others.entries()) {
					arms.push({
						from: fromVerdicts,
						rank: refusalRank.uniqueStored,
						when: classIs(verdictClass.other + i),
						refusal: keyLaw(witnessFields(u), u.law, verdictAt)
					})
				}
			}
			if (arbitration.kind === "every" || w.level === "serializable") {
				arms.push({
					from: fromVerdicts,
					rank: refusalRank.defect,
					when: classIs(verdictClass.defect),
					refusal: {
						kind: "defect",
						relation: relation.name,
						constraint: w.names.primaryKey(relation.name),
						key: keyOf(pk, verdictAt)
					}
				})
			}
		}
		if (unmet !== undefined) {
			const unmetAt = (f: LawField): Expr => col(unmet.name, unmet.columns.of(f))
			arms.push({
				from: cteRef(unmet.name),
				rank: spec.of === "put" ? refusalRank.change : refusalRank.conflict,
				when: lit.bool(true),
				refusal:
					spec.of === "put" ? change("PutTargetConflict", unmetAt) : keyLaw(pk, pkLaw, unmetAt)
			})
		}
		/** A statement with no arm here refuses nothing after its INSERT: a generated addition, whose probe raises at its
		 * gate, or a pure set or a span key insert with no unique object besides its arbiter. */
		const guarded = isNonEmpty(arms) ? sourcedRefusalGuard(supply, w.names.schema, arms) : undefined
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
		const inserted = cV === undefined ? [] : [eq(verdict(cV), integer(verdictClass.inserted))]
		/** Each side of the rows the statement returns (statement.ts Returning): the verdict rows of each class, where
		 * they carry one; else every row its INSERT returned, a fact it inserted. */
		const returning: Returning =
			cV === undefined
				? { cte: r2, kind: "added", added: { columns: returned, conditions: [] } }
				: meets
					? {
							cte: rv,
							kind: "insertion",
							added: { columns: returned, conditions: inserted },
							met: { columns: returned, conditions: [eq(verdict(cV), integer(verdictClass.met))] }
						}
					: { cte: rv, kind: "added", added: { columns: returned, conditions: inserted } }
		return {
			ast: {
				...returnedRows(
					"keyed",
					outFields.map((f) => returnedColumn(verdictAt(f), rowType(f), retCol(f))),
					[cteRef(rv)],
					conjunction([...(guarded === undefined ? [] : [guarded.guard]), ...inserted])
				),
				with: { ctes, recursive: false }
			},
			role: "member",
			result,
			skipWhenEmpty: skipWhenEmptyOf(input),
			returning
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
	 * among them: never a count or end its slot carries beside them that its facts do not state, a counted family's or a
	 * put's, which a stored owner holds as its members leave it and no put of the owner sets. */
	const stated = inputStated(input)
	const all = keyFirst(relation).filter((f) => stated.some((c) => c.name === f.name))
	if (!isNonEmpty(all)) {
		throw defect(`a classification of ${relation.name} whose input carries none of its key`)
	}
	const scalars = pk.filter((f) => f !== span)
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
		const same = (f: LawField, a: Expr, b: Expr): Expr => typedEq(rowType(f), a, b, w.names)
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
					w.names
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
