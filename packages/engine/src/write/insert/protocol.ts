import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { LawId } from "#compiler/core/ids.ts"
import { factEq, factFieldEq, typedEq } from "#compiler/ir/compare.ts"
import type { Stamped } from "#compiler/ir/instant.ts"
import { fieldNames, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { witnessFields } from "#compiler/laws/model/uniques.ts"
import { namesOrUnit } from "#compiler/runtime/lower/tree.ts"
import type {
	Cte,
	Expr,
	FromItem,
	FromSource,
	Insert,
	OnConflict,
	Select,
	SetCore,
	StatementText,
	Target
} from "#compiler/sql/ast.ts"
import { namedBody, type NameSupply } from "#compiler/sql/naming.ts"

import {
	and,
	asc,
	col,
	conjunction,
	continuedAll,
	cte,
	cteRef,
	cteRefAs,
	eq,
	join,
	lit,
	ne,
	not,
	provedCore,
	provedSelect,
	select,
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
	inputNeeds,
	inputStated,
	inputSharing,
	keyGeneratedRead,
	keyUniqueBy,
	noSharedKey,
	readInput,
	sameKeyCte,
	uncarriedKeyGenerations,
	type WriteInput
} from "#compiler/write/insert/input.ts"
import { stampedInput } from "#compiler/write/insert/stamp.ts"

import {
	buildStatement,
	type InsertOf,
	type InsertResult,
	type InsertVariant,
	keyFirst,
	keyOrderedSource,
	type ModifyingStatement,
	proposalOf,
	requestedValue,
	type ResultColumn,
	returnedColumn,
	returnedRows,
	type Returning,
	rowType,
	startOf,
	type WriteContext,
	type StatementWriting,
	writtenFields
} from "#compiler/write/insert/statement.ts"

import {
	buildProbe,
	type EveryObject,
	type Probed,
	probeArms,
	type ProbeSql,
	type Requested
} from "#compiler/write/insert/unique.ts"
import {
	atFields,
	type MetAccess,
	metAtObject,
	type Equal,
	metFound,
	metNarrowed,
	metRow,
	metRowsOf,
	probeKey,
	storedAt
} from "#compiler/write/probe.ts"

import type { ConcurrentChangeTag } from "#compiler/runtime/write/refusal.ts"
import {
	type ArmRefusal,
	type RefusedValue,
	refusalRank,
	type SourcedArm,
	sourcedRefusalGuard
} from "#compiler/write/refusal.ts"

/** An insert's spec. The statement meets its relation's unique objects (`relationUniques`): it probes those besides the
 * arbiter. A conflict witness and a same-key pair raise the law of the relation's primary key, the arbiter's. */
interface InsertSpec {
	readonly relation: WrittenRelation
	readonly input: WriteInput
	/** The action the insert realizes. On a put's insert half a conflict witness is a concurrent commit at the key after
	 * the put's first statement, its deletion or a family owner's UPDATE, which raises PutTargetConflict; a same-key pair
	 * still raises the key law. */
	readonly of: InsertOf
	/** The instant fields its rows leave out, each stamped by its clock (write/insert/stamp.ts); none for an insert that
	 * states every one, and for a put's insert half, which states every one. */
	readonly stamps: ReadonlyArray<Stamped>
}

/** Where an insert raises its probe's refusal (see `buildInsert`): nowhere, when it probes nothing; or as one of its
 * verdict rows, marked by its object's signed ordinal. */
type ProbeRaise =
	| { readonly kind: "none" }
	| { readonly kind: "verdict"; readonly probe: ProbeSql; readonly marker: string }

/** An insert's variant, by the relation's shape and what its facts state, with what it reads of the shape: a protocol
 * insert's payload, which its verdict rows compare. */
type InsertShape =
	| { readonly variant: "pureSet" }
	| { readonly variant: "spanKey" }
	| { readonly variant: "protocol"; readonly payload: NonEmptyReadonlyArray<LawField> }

/** The shape of an insert of complete facts that state `stated` (input.ts inputStated): its payload is every field they
 * state beside the key, in heading order, the caller's (frontend/targets.ts payloadOf) and a nested owner's sequences'
 * counts and ends, which its facts state with the members they nest; a pure set where they state none. */
const insertShape = (relation: RelationInfo, stated: Heading): InsertShape => {
	const key = primaryKeyShape(relation)
	if (key.kind === "span") {
		return { variant: "spanKey" }
	}
	const payload = relation.heading.filter(
		(f) => !relation.primaryFields.includes(f) && stated.some((c) => c.name === f.name)
	)
	return isNonEmpty(payload) ? { variant: "protocol", payload } : { variant: "pureSet" }
}

/**
 * Whether an insert realizing `of` into `relation` writes a met side, the stored facts its insertion met and did not
 * refuse (`delta.met`): an insertion that arbitrates at its scalar primary key, the protocol or a pure set whatever its
 * facts state. A put's insert half meets only its own no-change or a concurrent change, and a span primary key's
 * exclusion constraint takes only ON CONFLICT DO NOTHING ON CONSTRAINT, so no statement tells a fact it met from one it
 * made. The insert statement's Returning is read from it, and so is every plan that asks which statement writes a met
 * side.
 */
export const writesMet = (relation: WrittenRelation, of: InsertOf): boolean =>
	of === "insert" && primaryKeyShape(relation).kind !== "span"

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

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** No stored row of `relation` holds the requested fact's value at `key`, its insert's arbiter key, read at `requested`:
 * NOT EXISTS over the probe of `relation` at that key (probe.ts storedAt), each key field compared at its type. */
const storedAbsent = (
	w: WriteContext,
	supply: NameSupply,
	relation: WrittenRelation,
	key: NonEmptyReadonlyArray<LawField>,
	requested: (f: LawField) => Expr
): Expr => not(storedAt(w, supply, relation.name, atFields(w, relation.name, key, requested), []))

/**
 * What a verdict row of an arbitrated insert is (see `buildInsert`), by its class, the verdict column's value: a fact
 * the INSERT inserted; a stored fact it met and did not refuse, an insertion's met side; the arbiter key law's conflict
 * witness; a concurrent change on a put's insert half; a conflict at the i-th other unique object of an insert
 * arbitrating every object, `other + i`; a met row of such an insert that no snapshot shows, the statement's defect; or
 * a row a marker of its own raises, a same-key pair's or the probe's, which no class arm and no side reads.
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
 * - `returned`: ON CONFLICT at its arbiter's scalar key DO SELECT, with no WHERE, so RETURNING yields each stored row
 *   the arbiter met, an exact repeat, a
 *   conflict or a race's occupant, beside each row the INSERT inserted, told apart by `old`: PostgreSQL 19 returns the
 *   existing row as OLD for a DO SELECT row and an all-NULL OLD for an inserted one (nodeModifyTable.c
 *   ExecOnConflictSelect and ExecInsert's ExecProcessReturning). The unique pre-check waits for an occupant's writer,
 *   and ExecOnConflictSelect fetches the occupant under SnapshotAny; below a transaction snapshot it checks no
 *   visibility (ExecCheckTupleVisible), so at READ COMMITTED it returns a row committed after the statement's snapshot,
 *   on the first try. At SERIALIZABLE a met row the transaction snapshot cannot see raises 40001, and SSI sees the met
 *   row as read: the unique pre-check fetches the conflicting tuple again under the query's snapshot before it returns
 *   the conflict (execIndexing.c check_exclusion_or_unique_constraint, REL_19_0 :928-932),
 *   so the statement reads the met row no second time. Every other unique object is probed under the statement's
 *   snapshot (unique.ts buildProbe). It is every insert's form at a scalar arbiter key but `every`'s;
 * - `every`: complete facts at SERIALIZABLE into a relation every native object of which is a unique object, ON CONFLICT
 *   DO NOTHING with no target, so every unique and exclusion object arbitrates and a conflicting row in flight sends the
 *   insert back to its pre-check, never to a 23505 or 23P01. A row its transaction snapshot cannot see raises 40001
 *   (nodeModifyTable.c ExecCheckTupleVisible), so every stored row it met is visible. The INSERT proposes a CTE of its
 *   own, every gate in it, and each row of it the INSERT did not return, a met row (sql/ast.ts FromSource `metRows`), is
 *   classified by the stored rows its arbitration met (`met`) at the arbiter and then at each other object, read under
 *   the snapshot: a complete proposal reads no stored row for a fact it inserts; a placeholder's gate is a probe at its
 *   key.
 *
 * Complete facts into a primary key holding a span take `every` alone: an exclusion constraint arbitrates an INSERT by
 * ON CONFLICT ON CONSTRAINT DO NOTHING only, so no form at a scalar key tells a requested fact it met from one it made.
 * At READ COMMITTED such an insert has no form (write/schedule/plan.ts readCommittedLack, NoReadCommittedForm).
 */
type Arbitration =
	| { readonly kind: "returned"; readonly payload: ReadonlyArray<LawField> }
	| { readonly kind: "every"; readonly objects: Extract<EveryObject, { readonly kind: "named" }> }

const arbitrationOf = (
	w: WriteContext,
	relation: WrittenRelation,
	shape: InsertShape
): Arbitration => {
	if (w.level === "serializable" && relation.uniques.every.kind === "named") {
		return { kind: "every", objects: relation.uniques.every }
	}
	switch (shape.variant) {
		case "spanKey":
			defect(
				`an insert of complete facts into ${relation.name}, whose primary key holds a span, that arbitrates no object but every one: write/schedule/plan.ts readCommittedLack refuses it at READ COMMITTED`
			)
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
 * RETURNING. The outermost SELECT casts its columns to text. Into a role's query entry an insert runs only at
 * SERIALIZABLE: every arbiter key it meets has a key probe in the entry's precheck (insert/unique.ts RelationUniques.probes),
 * and the isolation certifier reads a call of such a probe as a read it states no fact of
 * (program/isolation/extract.ts, a schema function no names clear), so no role that inserts through a query entry is
 * certified READ COMMITTED. The precheck refuses, on its key's
 * law, a fact outside the entry at a requested key that the transaction's snapshot holds; one committed after the
 * snapshot fails the call with 40001 before PostgreSQL judges the stored row by any policy (nodeModifyTable.c
 * ExecOnConflictSelect, PostgreSQL 19: the row's visibility, then the SELECT policy, then the WHERE), a
 * SerializationFailure whose retry's precheck refuses the fact on the key's law. The variant is chosen by relation and
 * member shape alone (`shapeOf`), the
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
 * A primary key containing a span field is an exclusion constraint, which arbiter inference skips, so ON CONFLICT over
 * its columns fails with 42P10, and PostgreSQL accepts it as an arbiter only by name and only for DO NOTHING. An insert
 * of complete facts into it arbitrates every object at SERIALIZABLE (Arbitration `every`), the span key among them,
 * probed for the requested pairs overlapping within the input, and its met rows are classified: one at the key's own
 * span, an exact repeat or the key law, or on a put's insert half a concurrent change, SpanKeyChange; one at another
 * overlapping span, the key law. At READ COMMITTED it has no form (write/schedule/plan.ts readCommittedLack).
 *
 * Under a transaction snapshot every stored row an insert meets is read under that snapshot, so SSI sees an exact
 * repeat, which inserts nothing, as a read of the stored fact: `every`'s met rows by their met read, and `returned`'s by
 * PostgreSQL's own read of the conflicting tuple under the query's snapshot (execIndexing.c
 * check_exclusion_or_unique_constraint, REL_19_0 :928-932). An insert after a concurrent deletion of an
 * occupant the snapshot held is a write into what the deletion read.
 * A transaction that would commit in no serial order with a concurrent one fails with 40001, a TransientFailure.
 *
 * A vector field compares through the extension's qualified operator, and a row comparison that holds one, such as the
 * verdict's comparison over a vector payload, is spelled column by column: PostgreSQL resolves each column
 * operator by name through the search_path, and no login's search_path holds the extension schema. */
export const buildInsert = <T extends StatementText>(
	w: StatementWriting<T>,
	spec: InsertSpec
): ModifyingStatement<InsertResult, T> => {
	const { relation, input } = spec
	const at = `insert ${relation.name}`
	const shape = insertShape(relation, inputStated(input))
	const variant: InsertVariant = shape.variant
	const guarantees = inputGuarantees(input)
	const sameKeyCheck = variant === "protocol" && !keyUniqueBy(guarantees.keyUnique)
	const written = writtenFields(relation)
	const proposes = proposalOf(relation)
	const arbitration = arbitrationOf(w, relation, shape)
	const meets = writesMet(relation, spec.of)
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
	/** The instant fields the rows leave out, which the insert stamps and so reads beside the carried ones from the
	 * stamped input (write/insert/stamp.ts). */
	const stamped = (f: LawField): boolean => spec.stamps.some((s) => s.field.name === f.name)
	/** The key generations the input leaves out, which its read computes over the fields it carries (input.ts
	 * keyGeneratedRead), so the insert reads each fact's whole key. */
	const generations = uncarriedKeyGenerations(relation, written.filter(carries))
	const fields = written.filter((f) => carries(f) || stamped(f) || generations.includes(f))
	const starts = written
		.filter((f) => !carries(f) && !stamped(f) && !generations.includes(f))
		.map((f) => ({
			field: f,
			value: defined(
				startOf(w.names, f),
				`the start of ${relation.name}.${f.name}, a written field its input does not carry`
			)
		}))
	const all = keyFirst(relation)
	/** The key the insert meets stored facts at and the law a conflict there raises, its arbiter's: the primary key's. */
	const pk = relation.primaryFields
	const pkLaw = arbiterLaw(relation)
	/** Every comparison is at its field's type: a vector, in the payload or in a small key, compares through the
	 * extension's qualified operator, which a bare or row comparison would resolve through the search_path. */
	const typeOf = rowType
	const same = (f: LawField, a: Expr, b: Expr): Expr => typedEq(rowType(f), a, b, w.names)
	const integer = (n: number): Expr => lit.int(n, types.integer)
	/** The requested facts the probe reads and the objects it probes (`buildProbe`): every object besides the arbiter. */
	const probed: { readonly requested: Requested; readonly checks: ReadonlyArray<Probed> } = {
		requested: { kind: "complete", arbiter: relation.uniques.arbiter },
		checks: relation.uniques.checks
	}
	/** The outer SELECT returns complete facts: a read-back and the netting across strata read them, and a unique
	 * refusal's witness is the requested fact at the object's fields. */
	const outFields = all
	const sharing = inputSharing(w.share.inserts, [input], [relation, input, spec.of])
	return buildStatement(w, sharing, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const r1 = supply.relation(internal("input"))
		const r2 = supply.relation(internal("insert"))
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const r4 = sameKeyCheck ? supply.relation(internal("same-key check")) : undefined
		const inputs = fieldColumns(fields, () => supply.column(internal("input column")))
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		/** The verdict column (`verdictClass`), each verdict row's class. */
		const cV = supply.column(internal("verdict"))
		/** The met marker of a `returned` insert's RETURNING: whether OLD is a stored row, so the row is one the arbiter met. */
		const metMark =
			arbitration.kind === "returned" ? supply.column(internal("met marker")) : undefined
		const keys = fieldColumns(r4 === undefined ? [] : pk, () =>
			supply.column(internal("same-key column"))
		)
		const c9 = r4 === undefined ? undefined : supply.column(internal("same-key marker"))
		/** The fields the input carries, under their input columns: what its read names, the stamped ones apart, which
		 * the stamped input adds (write/insert/stamp.ts). */
		const carriedFields = fields.filter(carries)
		const carriedInputs = fieldColumns(carriedFields, (f) => inputs.of(f))
		const read = readInput(
			w,
			input,
			{
				kind: "input",
				fields: carriedFields,
				alias: scan,
				keys: carriedInputs,
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
		const [firstStamp, ...moreStamps] = spec.stamps
		/** The input's read with the key generations it leaves out (keyGeneratedRead), under `name`. */
		const generated = (name: string, columns: FieldColumns<string>): readonly [Cte, Cte] =>
			keyGeneratedRead(w, supply, relation, read.select, carriedInputs, { name, columns })
		/** The fields the read holds before any stamp: the carried ones and the key generations computed over them. */
		const readFields = [...carriedFields, ...generations]
		const readCtes = ((): [Cte, ...Array<Cte>] => {
			if (firstStamp === undefined) {
				return isNonEmpty(generations)
					? [...generated(r1, inputs)]
					: [cte(r1, namedBody(read.select, namesOrUnit(inputs.columns)))]
			}
			const stamps: NonEmptyReadonlyArray<Stamped> = [firstStamp, ...moreStamps]
			const out = { name: r1, fields, columns: inputs }
			if (!isNonEmpty(generations)) {
				const [stampedRead, ...stampCtes] = stampedInput(
					w,
					supply,
					read.select,
					carriedFields,
					stamps,
					out
				)
				return [stampedRead, ...stampCtes]
			}
			const keyed = supply.relation(internal("keyed input"))
			const keyedColumns = fieldColumns(readFields, (f) => inputs.of(f))
			const [scanned, withKeys] = generated(keyed, keyedColumns)
			const reread = select(
				provedCore(
					"keyed",
					readFields.map((f) => target(col(keyed, keyedColumns.of(f)))),
					[cteRef(keyed)],
					undefined
				)
			)
			return [scanned, withKeys, ...stampedInput(w, supply, reread, readFields, stamps, out)]
		})()
		const ctes: [Cte, ...Array<Cte>] = readCtes
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
			rows: "set",
			occupants: arbitration.kind === "every" ? "met" : "probed"
		})
		if (probe !== undefined) {
			appendAll(ctes, probe.ctes)
		}
		/** Where the probe's refusal is raised (see `buildInsert`): as a verdict row marked by its object's signed ordinal,
		 * beside the rows of the arms that read what the INSERT returned. */
		const unique: ProbeRaise =
			probe === undefined
				? { kind: "none" }
				: { kind: "verdict", probe, marker: supply.column(internal("unique marker")) }
		const cU = unique.kind === "verdict" ? unique.marker : undefined
		/** Into a family owner, only the requested facts no row stores (`proposalOf`). */
		const unstored = proposes === "unstored" ? [storedAbsent(w, supply, relation, pk, inCol)] : []
		const gates = [
			...(r4 === undefined ? [] : [noSharedKey(r4)]),
			...(unique.kind === "none" ? [] : [unique.probe.gate]),
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
		const source =
			proposed === undefined
				? keyOrderedSource(
						supply,
						provedSelect(
							"keyed",
							[...fields.map((f) => target(inCol(f))), ...starts.map((s) => target(s.value))],
							[cteRef(r1)],
							conjunction(gates)
						),
						mapNonEmpty(pk, (f) => asc(inCol(f)))
					)
				: keyOrderedSource(
						supply,
						provedSelect(
							"keyed",
							[...fields, ...starts.map((s) => s.field)].map((f) =>
								target(col(proposed.name, proposed.columns.of(f)))
							),
							[cteRef(proposed.name)],
							undefined
						),
						mapNonEmpty(pk, (f) => asc(col(proposed.name, proposed.columns.of(f))))
					)
		/** How the INSERT meets its occupants (Arbitration): at `returned` its DO SELECT selects every one. */
		const conflictOf = (): OnConflict | undefined => {
			switch (arbitration.kind) {
				case "every":
					return { kind: "every", action: { kind: "doNothing" } }
				case "returned":
					return {
						kind: "columns",
						columns: mapNonEmpty(pk, column),
						action: { kind: "doSelect", where: undefined }
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
			source,
			onConflict: conflictOf(),
			returning: [
				...all.map((f) => targetAs(col(r3, column(f)), retCol(f))),
				...(metMark === undefined ? [] : [targetAs(metMarked, metMark)])
			]
		}
		ctes.push(cte(r2, insert))
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
								when: factEq({ fields: payload, typeOf, left: stored, right: inCol }, w.names),
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
						...outFields.map((f) => targetAs(requested(f), retCol(f))),
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
		 * NULL, else classed against the request. A met row is read no second time: at SERIALIZABLE PostgreSQL records
		 * the read of the conflicting tuple under the query's snapshot itself (execIndexing.c
		 * check_exclusion_or_unique_constraint, REL_19_0 :928-932), and no met row is one this statement
		 * wrote, since its one INSERT proposes each arbiter key once (the input read DISTINCT or proved distinct, and the
		 * same-key pair's gate). Then the withheld stored facts and the same-key pair.
		 */
		const returnedBody = (
			payload: ReadonlyArray<LawField>,
			cv: string,
			mark: string
		): Select["body"] => {
			const left: SetCore = provedCore(
				"keyed",
				[
					...factOf(r2, retCol),
					targetAs(
						metClass(payload, (f) => col(r2, retCol(f)), [
							{ when: not(col(r2, mark)), result: integer(verdictClass.inserted) }
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
			/**
			 * The met rows found once (sql/ast.ts FromSource `metRows`), into a MATERIALIZED CTE of their own, which the
			 * classes and the delivered stored facts each read: the window sorts the proposed and returned rows once for
			 * the statement, where each reader's own met rows sorted them again, every column of every proposed row twice.
			 */
			const searched = metRowsOf(w, supply, {
				insert: r2,
				proposed: from.name,
				columns: mapNonEmpty(all, (f) => ({ column: from.columns.of(f), returned: retCol(f) })),
				key: mapNonEmpty(pk, (f) => ({
					field: f,
					column: from.columns.of(f),
					returned: retCol(f)
				}))
			})
			const rm = supply.relation(internal("met rows found"))
			ctes.push({
				...cte(
					rm,
					select(
						provedCore(
							"keyed",
							mapNonEmpty(all, (f) => target(col(searched.alias, from.columns.of(f)))),
							[searched.source],
							undefined
						)
					)
				),
				materialized: "MATERIALIZED"
			})
			const metRows = (): { readonly source: FromSource; readonly alias: string } => {
				const alias = supply.relation(internal("met rows"))
				return { alias, source: cteRefAs(rm, alias) }
			}
			const met = metRows()
			const metValue = (f: LawField): Expr => col(met.alias, from.columns.of(f))
			const found = (access: MetAccess, equal: ReadonlyArray<Equal>): Expr =>
				metFound(w, supply, relation.name, access, equal)
			const atArbiter = metAtObject(w, relation.name, primary, met.alias, from.columns.of)
			const storedField = (inner: string) => (f: LawField) => col(inner, column(f))
			const statedFields = inputStated(input)
			const compared = all.filter(
				(f) => !primary.equal.includes(f) && statedFields.some((c) => c.name === f.name)
			)
			/**
			 * An exact repeat at the arbiter: the stored row there equal to the met row at every field it states. A scalar key
			 * reaches one row, over which the equalities are checked (probe.ts Equal), so the key alone chooses the index; a span
			 * key reaches every row overlapping the met row's span, so the equalities narrow the read itself.
			 */
			const repeatAt = (
				access: MetAccess
			): { readonly access: MetAccess; readonly equal: ReadonlyArray<Equal> } =>
				primary.kind === "span"
					? {
							access: metNarrowed(access, (inner) =>
								compared.map((f) =>
									factFieldEq(
										rowType(f),
										storedField(inner)(f),
										col(access.rows, from.columns.of(f)),
										w.names
									)
								)
							),
							equal: []
						}
					: {
							access,
							equal: compared.map((f): Equal => ({
								column: column(f),
								value: col(access.rows, from.columns.of(f)),
								type: rowType(f)
							}))
						}
			const repeated = repeatAt(atArbiter)
			const keyed: NonEmptyReadonlyArray<{ readonly when: Expr; readonly result: Expr }> =
				spec.of === "put" && primary.kind === "span"
					? [
							{
								when: found(
									metNarrowed(atArbiter, (inner) => [
										ne(storedField(inner)(primary.span), metValue(primary.span))
									]),
									[]
								),
								result: integer(verdictClass.conflict)
							},
							{ when: found(atArbiter, []), result: integer(verdictClass.change) }
						]
					: [{ when: found(atArbiter, []), result: integer(differing) }]
			const classes = [
				{ when: found(repeated.access, repeated.equal), result: integer(verdictClass.met) },
				...keyed,
				...objects.others.map((u, i) => ({
					when: found(metAtObject(w, relation.name, u, met.alias, from.columns.of), []),
					result: integer(verdictClass.other + i)
				}))
			]
			const [first, ...rest] = classes
			const rk = supply.relation(internal("met classes"))
			ctes.push({
				...cte(
					rk,
					namedBody(
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
						),
						[...outFields.map(retCol), cv]
					)
				),
				materialized: "MATERIALIZED"
			})
			/** The stored facts an insertion met and did not refuse, each read where its arbitration met it (probe.ts
			 * metRow) under the transaction snapshot, so each is the stored fact itself: an exact repeat, or, where a
			 * differing occupant is met (occupantVerdict), any occupant of its key. */
			const delivered = metRows()
			const deliveredAt = metAtObject(w, relation.name, primary, delivered.alias, from.columns.of)
			const reached =
				differing === verdictClass.met ? { access: deliveredAt, equal: [] } : repeatAt(deliveredAt)
			const stored = metRow(w, supply, relation.name, reached.access, mapNonEmpty(all, column))
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
					conjunction(
						reached.equal.map((e) => factFieldEq(e.type, stored.at(e.column), e.value, w.names))
					)
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
						cV
					)
				case "returned":
					return returnedBody(
						arbitration.payload,
						cV,
						defined(metMark, "the met marker of an insert its arbiter returns")
					)
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
								target(integer(verdictClass.raised)),
								...(c9 === undefined ? [] : [target(lit.bool(false))]),
								target(unique.probe.ordinal)
							],
							[cteRef(unique.probe.refusal)],
							undefined
						)
					)
		const rv = supply.relation(internal("verdicts"))
		ctes.push({
			name: rv,
			materialized: "MATERIALIZED",
			query: select(body)
		})
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
		if (arbitration.kind === "every") {
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
		/** The arms the statement refuses by after its INSERT, its arbiter key's conflict among them. */
		const guarded = isNonEmpty(arms) ? sourcedRefusalGuard(supply, w.names.schema, arms) : undefined
		if (guarded !== undefined) {
			ctes.push(guarded.cte)
		}
		const result: InsertResult = {
			kind: "insert",
			relation: relation.name,
			variant,
			of: spec.of,
			proposes,
			columns,
			fields: fieldNames(outFields),
			key: fieldNames(relation.primaryFields)
		}
		const inserted = [eq(verdict(cV), integer(verdictClass.inserted))]
		/** Each side of the rows the statement returns (statement.ts Returning): the verdict rows of each class. */
		const returning: Returning = meets
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
			needs: inputNeeds(input),
			returning
		}
	})
}
