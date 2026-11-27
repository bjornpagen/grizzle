/**
 * Binding one application of a write before any SQL is sent (`bindWrite`): its declared parameters admitted, its
 * members normalized, each statement's placeholder values encoded, and its statements' executions in its one flight,
 * from the write's loaded flight and binding alone.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	type NormalizedRelation,
	parameterNormalizer,
	positionalColumns
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf, paramEncoder, paramOfText } from "#compiler/codec/scalar.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { isIterable } from "#compiler/core/record.ts"
import { type TextsId, TextsMap, textsId } from "#compiler/core/text.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import { familyKey, type GeneratedLaw, type ColumnKey, columnKeyOf } from "#compiler/ir/law.ts"
import { holds, type NeededInput } from "#compiler/ir/needs.ts"
import {
	type CallerParamDecl,
	type DeclaredSlot,
	type FilledRows,
	filledRowsKey,
	type LiteralBound,
	type MessageBound,
	type WriteSlot
} from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { runsLargeForm } from "#compiler/runtime/lower/take.ts"
import type {
	Binding,
	ComputedFields,
	CountedFamily,
	FreshStratum,
	JudgedRelation,
	OwnedColumn
} from "#compiler/runtime/write/binding.ts"
import {
	type CellRow,
	type Cells,
	factCells,
	type Texts,
	textAt
} from "#compiler/runtime/write/cells.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import {
	type Execution,
	type ExecutionPart,
	executionOf,
	type NestedCells,
	nestedColumn,
	type NestedPlaceholder,
	type NestedSource,
	nestedSource
} from "#compiler/runtime/write/executions.ts"
import {
	type CallEvaluator,
	type FilledNode,
	type Filler,
	fillRefusal,
	type GeneratedNull,
	type HostNode
} from "#compiler/runtime/write/fill.ts"
import {
	type FlightForm,
	type FlightStatement,
	type FlightWrite,
	sentForm,
	type ServedWriteChoice,
	sharedWhole
} from "#compiler/runtime/write/flight.ts"
import {
	type Fact,
	type FillContext,
	type Grouped,
	groupReader
} from "#compiler/runtime/write/keys.ts"
import {
	type LaidColumn,
	type LaidLayout,
	type NestedLayoutData,
	type NestedRow,
	cellsReader,
	sentLayout
} from "#compiler/runtime/write/nesting.ts"
import {
	type GroupData,
	type InputData,
	type MemberFacts,
	normalizeChangeSet,
	type NormalizedSlot,
	cuttable,
	refilledSlot,
	slicedSlot,
	type SlotData
} from "#compiler/runtime/write/normalize.ts"
import { keyWitness } from "#compiler/runtime/write/outcome.ts"
import { type OwnStep, sentWhere } from "#compiler/runtime/write/steps.ts"
import type { Batching, Transport } from "#compiler/runtime/write/transport.ts"
import {
	type FilledColumn,
	hostJudgement,
	type JudgedRow,
	type StatedRows,
	type WitnessField
} from "#compiler/runtime/write/witness.ts"
import { type SqlValue, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import { hostOfLiteral } from "#compiler/scalar/compute/literal.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	admitted,
	admitValue,
	compareValues,
	evaluatedValue,
	type HostValue,
	heldValue
} from "#compiler/scalar/values/identity.ts"
import type { DrawnBy, RecordedLaw, Witness } from "#compiler/types/changeset/changeset.ts"
import type { SingleAct } from "#compiler/write/frontend/compile.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"

interface BindInputs {
	/** The facts each member slot of the ChangeSet value supplies (`collectInputs`). */
	readonly members: MemberFacts
	/** The declared parameters' values, by name: the caller's, and the values ChangeSet.bind closed under the private
	 * names the Description lists. */
	readonly params: Readonly<Record<string, unknown>>
	/** What one statement carries, which a statement's batched executions are cut to (runtime/write/transport.ts
	 * inForce over the wire's Bind frame). */
	readonly transport: Transport
}

/**
 * A write's host half as an application binds its rows (`bindRows`): its declared parameters, its binding, the binding's
 * closures and the installation's codes, what a loaded write holds besides its statements (runtime/write/flight.ts
 * FlightWrite).
 */
export type HostBinding = Pick<FlightWrite, "params" | "binding" | "prepared" | "codes">

/** An application's rows bound on the host (`bindRows`), before any statement is written. */
export interface BoundRows {
	readonly kind: "bound"
	/** The rows the ChangeSet states as the write fills them (runtime/write/witness.ts StatedRows), which a refusal of
	 * one of its statements judges. */
	readonly stated: StatedRows
	/** The rows the write's statements insert, as this application filled them before any SQL, by stratum
	 * (`InsertedStratum`), each read where it is asked for. */
	readonly inserted: () => ReadonlyArray<InsertedStratum>
}

export interface BoundWrite extends BoundRows {
	/** The positions of the write's statements the application sends nothing of: their rows need an input that holds no
	 * fact, or, for a single statement, every part's does (ir/needs.ts, runtime/write/parted.ts). */
	readonly skip: ReadonlySet<number>
	/** The form of a statement of the write this application sends (runtime/write/flight.ts sentForm), of the units its
	 * inputs give rows for a single statement: none of a statement it skips. */
	readonly form: (statement: FlightStatement) => FlightForm
	/**
	 * The placeholder values of that form, each a text or a bytes or text column's binary array: none reads another
	 * statement's rows. A relation input's arrays are written once per statement, by the encoder its placeholders share.
	 */
	readonly values: (
		statement: FlightStatement
	) => Result.Result<ReadonlyArray<Param>, EncodingFailure | LiteralBound>
	/** Each statement's executions in the write's one flight (`Chunks`), none of a statement it skips. */
	readonly chunks: Chunks
}

/**
 * A row one stratum's statements insert, whole as the host filled it (BoundWrite `inserted`): `values`, every column
 * the host gives it, as cells of its relation's columns (cells.ts Cells), its caller's fields, the counts and ends the
 * stratum's appends draw on an owner, the fields a nesting's walk draws, each counted family's columns where a fresh
 * fill drew its group, and the law columns among them; and what the SQL gives it instead. `scanned` is each counted
 * family it is a member of whose group no fresh fill drew, the stratum inserting none of its owner, so the family's
 * statement draws its columns past the group's stored members (write/family/additions.ts). A row the host filled whole
 * has none. A group a fresh fill drew that holds stored members is the scan's as the statement runs (additions.ts
 * HostDrawn), so where no row is stored, as in a fresh installation, a row the host filled whole is the row the write
 * stores.
 */
export interface InsertedRow {
	readonly values: Cells
	readonly scanned: ReadonlyArray<CountedFamily>
}

/**
 * The rows one stratum's statements insert (BoundWrite `inserted`), by relation, each row once by its primary key: each
 * insert slot's facts stated in their relation's own words, an owner's with the counts and ends its fresh fill drew,
 * and its nested writes' rows, each as the write sends it (`WriteRows`), and on each counted member the columns of each
 * family a fresh fill drew its group of (`freshMembersOf`), a member of two such families holding both. A query
 * entry's facts, stated in the entry's words, are rows of its target only as the entry's statement maps them, and none
 * of these.
 */
export interface InsertedStratum {
	readonly stratum: StratumAt
	readonly rows: ReadonlyMap<StoredRelationName, ReadonlyArray<InsertedRow>>
}

/**
 * The executions of a statement under `transport`, the message bound of the session that sends them, in the order they
 * are sent (runtime/write/executions.ts Execution): its facts cut into batched executions where its transport bounds
 * them (`batchedExecutions`), or its one, its `values`. Its rows are every execution's, in order.
 */
export type Chunks = (
	statement: FlightStatement,
	transport: Transport
) => Result.Result<ReadonlyArray<Execution>, EncodingFailure | LiteralBound>

/**
 * A write the host refuses before any write statement, filling a row whose generated field has no value
 * (runtime/write/fill.ts GeneratedNull): `invariant-rejected` on the field's law, witnessed as PostgreSQL's NOT NULL
 * refusal of the statement that writes the row is (witness.ts hostJudgement), so the outcome is one whoever finds the
 * NULL.
 */
export interface GeneratedRejection {
	readonly _tag: "GeneratedRejection"
	readonly law: GeneratedLaw
	readonly witness: Witness
}

/**
 * An application's rows of its member slots and nested writes: each member slot's facts, and a stratum's nested rows of
 * a relation, as normalization leaves them or as the write's statements send them.
 */
interface WriteRows {
	readonly slot: (slot: ParamId) => NormalizedSlot
	readonly nested: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>
}

/**
 * The rows an application's stated rows are judged at: `sent`, the rows its statements send, each owner slot's facts
 * and each nested owner's row with the counts and ends its stratum's appends draw into it (`freshOwners`), `drawn` the
 * slots whose facts those are; or `unplanned`, the rows as normalization leaves them, before they are drawn, when no
 * write statement is sent, none of whose columns beyond its stated fields is judged.
 */
type StatedFill =
	| {
			readonly kind: "sent"
			readonly rows: WriteRows
			readonly drawn: (slot: ParamId) => boolean
	  }
	| { readonly kind: "unplanned"; readonly rows: WriteRows }

/**
 * What a judged row's columns hold beyond the fields the ChangeSet states: nothing (`stated`), an owner its stratum
 * inserts holding its counts and ends at its empty families'; every column, as a nesting's walk filled it and its
 * stratum's appends drew a nested owner's counts and ends (`walk`); or the counts and ends the write draws into an
 * owner's insert (`drawn`).
 */
type ColumnsSource = "stated" | "walk" | "drawn"

const unfilled: FilledColumn = Object.freeze({ kind: "unfilled" })

/** The witness of a refusal no row the ChangeSet states is found breaking. */
const unreportedWitness: Witness = Object.freeze({ kind: "unreported" })

/**
 * A binding's refusal before any SQL: a same-key conflict among its facts, by its key law, the stored relation whose
 * key's constraint refuses it (`relation`, a query entry's target) and its witness, in the words the facts were stated
 * in; or a generated field's refusal.
 */
type Rejected =
	| {
			readonly kind: "invariant-rejected"
			readonly relation: StoredRelationName
			readonly law: LawId
			readonly described: RecordedLaw
			readonly witness: Witness
	  }
	| { readonly kind: "generated-rejected"; readonly rejection: GeneratedRejection }

/** What binding one application's rows on the host gives (`bindRows`): its bound rows, or its refusal. */
export type RowsResult = BoundRows | Rejected

/** What binding one application gives (`bindWrite`): its bound write, or its refusal. */
export type BindResult = BoundWrite | Rejected

/**
 * The form a call sends of `statement`, whose inputs `holdsFact` says hold a fact or none, its per-execution choices
 * run as `runsLarge` says: a whole statement's chosen form, where its step sends it (steps.ts sentWhere), and a single
 * statement's assembled of the units of its chosen form its inputs give rows; none where it sends nothing.
 */
const sentFormOf = (
	statement: FlightStatement,
	runsLarge: (choice: ServedWriteChoice) => boolean,
	holdsFact: (input: NeededInput) => boolean
): FlightForm | undefined => {
	switch (statement.kind) {
		case "whole":
			return holds(sentWhere(statement.step), holdsFact)
				? sentForm(statement, runsLarge)
				: undefined
		case "parted":
			return sentForm(statement, runsLarge).sentFor(holdsFact)
	}
}

/** A counted family's fresh layout at a stratum, which `binding` decided for every family a stratum reaches. */
const freshLayoutAt = (binding: Binding, stratum: StratumAt, family: string): LaidLayout =>
	defined(
		binding.fresh.find((f) => f.stratum === stratum)?.fresh.get(family),
		`the fresh layout of family ${family} in stratum ${stratum}`
	)

/** Where `relation` stands in a nested write of `stratum` that fills its rows (binding.ts NestedAt). */
const nestedAt = (
	binding: Binding,
	stratum: StratumAt,
	relation: StoredRelationName
): NestedLayoutData =>
	defined(
		binding.nested.find((n) => n.stratum === stratum)?.layouts.get(relation),
		`the nested layout of ${relation}, a relation a nested write of stratum ${stratum} fills`
	)

/**
 * How `inserted` tells the rows of one relation apart: `held`, by its primary key, every column of which the host fills;
 * or `stamped`, where the database stamps a field of its key, a clock or a place (ir/instant.ts), which no write knows
 * before its statement runs, by the fields the ChangeSet states of each row, so each fact it states is its own row, as
 * its insert sends it, its stamped field unknown until the write.
 */
type InsertedKey =
	| { readonly kind: "held"; readonly columns: NonEmptyReadonlyArray<LaidColumn> }
	| {
			readonly kind: "stamped"
			readonly stated: NonEmptyReadonlyArray<{ readonly key: ColumnKey; readonly type: ScalarType }>
	  }

/** Whether a field of a writing the witness reads is stamped by the database as its statement runs: a clock or a place. */
const isStamped = (writing: WitnessField["writing"]["kind"]): boolean => {
	switch (writing) {
		case "instant":
		case "place":
			return true
		case "caller":
		case "drawn":
		case "accumulated":
		case "generated":
		case "keyGenerated":
			return false
	}
}

/**
 * An application's rows bound on the host (`hostRows`), with what its statements' binding reads of them
 * (`boundStatements`): each relation parameter's normalized input and its distinct fact count, each member slot's
 * normal facts, the rows its statements send, and each counted family's fresh members.
 */
interface HostRows extends BoundRows {
	readonly relationInputs: ReadonlyMap<ParamId, NormalizedRelation>
	readonly counted: ReadonlyArray<{ readonly param: ParamId; readonly count: number }>
	readonly factsOf: (slot: ParamId) => NormalizedSlot
	readonly sentRows: WriteRows
	readonly freshMembersOf: (stratum: StratumAt, family: string) => ReadonlyArray<CellRow>
}

/**
 * The fields of a relation's rows a stratum's call computes (`computedValues`): each the host evaluates at its value, as
 * the field holds it, and each it does not by what supplies it, its term's source (binding.ts ComputedFields).
 */
interface CallFields {
	readonly values: ReadonlyMap<string, HostValue>
	readonly drawn: ReadonlyMap<string, DrawnBy>
}

/** The fields of a relation's rows a stratum computes none of. */
const noneComputed: CallFields = Object.freeze({ values: new Map(), drawn: new Map() })

/**
 * Each stratum's computed fields of each relation it inserts computing some (binding.ts ComputedFields), by stratum and
 * relation (CallFields): each field's term over the call's parameters as their admission holds them, `params`,
 * evaluated once a call, its value the one every row of the call holds there, which the statement that writes them
 * fills; a term the host does not evaluate, one reading the call's clock among them, is the database's to supply, named
 * by its source; and a term NULL, which the field's NOT NULL refuses, neither.
 */
const computedValues = (
	computed: ReadonlyArray<ComputedFields>,
	evaluate: CallEvaluator,
	params: (id: ParamId) => SqlValue | undefined
): ReadonlyMap<StratumAt, ReadonlyMap<StoredRelationName, CallFields>> => {
	const out = new Map<StratumAt, Map<StoredRelationName, CallFields>>()
	for (const { stratum, relation, fields } of computed) {
		const values = new Map<string, HostValue>()
		const drawn = new Map<string, DrawnBy>()
		for (const field of fields) {
			const value = evaluate(field.term, params)
			if (!value.ok) {
				drawn.set(field.name, field.source)
			} else if (value.value !== sqlNull) {
				values.set(field.name, heldValue(field.type, value.value))
			}
		}
		out.getOrInsertComputed(stratum, () => new Map()).set(relation, { values, drawn })
	}
	return out
}

/**
 * Binds one application's rows on the host, before any statement is written: steps 1 and 2 of `bindWrite`, every
 * member's facts admitted and normalized, each counted family's fresh groups drawn and every row the write's statements
 * insert filled, from the write's host half alone (`HostBinding`), its statements unread.
 */
const hostRows = (
	host: HostBinding,
	inputs: BindInputs
): Result.Result<HostRows | Rejected, EncodingFailure | MessageBound | LiteralBound> => {
	const { binding, prepared, codes } = host
	/** The declared parameters' values; each relation parameter's distinct fact count, which chooses the form of a
	 * statement whose take its rows bound (`sentForm`). */
	const counted: Array<{ readonly param: ParamId; readonly count: number }> = []
	/** Each relation parameter's input, normalized once for the application: the one set its count and every statement
	 * that binds it read. */
	const relationInputs = new Map<ParamId, NormalizedRelation>()
	/** Each scalar parameter by its id, which a computed field's term reads (`computedValues`). */
	const scalars = new Map<ParamId, Extract<CallerParamDecl, { readonly kind: "scalar" }>>()
	const paramValue = (name: string): unknown => inputs.params[name]
	for (const decl of host.params) {
		const value = paramValue(decl.name)
		if (decl.kind === "relation") {
			const normalize = parameterNormalizer({
				relation: decl.name,
				slot: { kind: "slot", name: decl.name },
				columns: positionalColumns(decl.heading),
				codes
			})
			if (!isIterable(value)) {
				return Result.err(encodeFailure("factShape", slotPlace(decl.name)))
			}
			const normal = normalize(value)
			if (!normal.ok) {
				return Result.err(normal.error)
			}
			counted.push({ param: decl.id, count: normal.value.count })
			relationInputs.set(decl.id, normal.value)
			continue
		}
		const text = paramEncoder(decl.type, decl.name, codes)(value)
		if (!text.ok) {
			return Result.err(text.error)
		}
		scalars.set(decl.id, decl)
	}
	/** A scalar parameter's value as the call's admission holds it, as the evaluator computes with it, read where a
	 * computed field's term reads it; its encoder admitted it above. */
	const admittedParam = (id: ParamId): SqlValue | undefined => {
		const decl = scalars.get(id)
		if (decl === undefined) {
			return undefined
		}
		const spec = carrierSpecOf(decl.type, codes)
		const read = admitValue(spec, paramValue(decl.name))
		if (!read.ok) {
			defect(`the value of parameter ${decl.name}, which its encoder admitted`)
		}
		return evaluatedValue(
			decl.type,
			spec.carrier === "bytes" && read.value instanceof Uint8Array
				? new AdmittedBytes(read.value)
				: read.value
		)
	}
	const computed = computedValues(binding.computed, prepared.evaluateCall, admittedParam)
	const normalization = normalizeChangeSet(
		prepared.groups,
		{ fill: prepared.fill, codes, columns: prepared.columns },
		prepared.evaluate,
		inputs.members,
		inputs.transport
	)
	if (!normalization.ok) {
		return Result.err(normalization.error)
	}
	const normalized = normalization.value
	if (normalized.kind === "generatedNull") {
		return Result.ok({
			kind: "generated-rejected",
			rejection: {
				_tag: "GeneratedRejection",
				law: normalized.law,
				witness:
					normalized.values === undefined
						? unreportedWitness
						: keyWitness(normalized.law.relation, normalized.values)
			}
		})
	}
	if (normalized.kind === "keyConflict") {
		return Result.ok({
			kind: "invariant-rejected",
			relation: normalized.relation,
			law: normalized.law,
			described: normalized.described,
			witness: normalized.witness
		})
	}
	/** The normal facts of a member slot of the front end: the one site of the fact "normalizeChangeSet normalizes every
	 * slot of the front end", which each statement's member placeholder and skipped input name by id. A statement is
	 * compiled once and sent by every application, so it can hold only the slot's identity, and the facts exist only per
	 * application, in the table normalization builds over the front end's slots: joining the two is an environment
	 * lookup, a key fixed at compile time against a table built at run time, which no type makes total. */
	const factsOf = (slot: ParamId): NormalizedSlot =>
		defined(normalized.slots.get(slot), `the normal facts of member slot ${slot}`)
	/** A stratum's nested rows of a relation as normalization left them, each as the walk filled it. */
	const normalNestedRows = (
		stratum: StratumAt,
		relation: StoredRelationName
	): ReadonlyArray<NestedRow> => normalized.nested.get(stratum)?.get(relation) ?? []
	/** The write's rows as normalization leaves them: each slot's normal facts, each nested row as the walk filled it. */
	const normalRows: WriteRows = { slot: factsOf, nested: normalNestedRows }
	const ctx: FillContext = { codes, evaluate: prepared.evaluate, columns: prepared.columns }
	/** The fields of `relation`'s rows the call computes at `stratum`, each at its value (`computedValues`); none where
	 * the stratum computes none of them. */
	const computedAt = (stratum: StratumAt, relation: StoredRelationName): CallFields =>
		computed.get(stratum)?.get(relation) ?? noneComputed
	/** How `relation`'s stated rows are judged, which the binding decided when the write compiled. */
	const judgedOf = (relation: StoredRelationName): JudgedRelation =>
		defined(binding.judged.get(relation), `the judged relation ${relation}, a written one`)
	/** An owner's count or end while its family is empty: the count 0, each end at its start. */
	const emptyOf = (owned: OwnedColumn): FilledColumn =>
		owned.kind === "count"
			? { kind: "filled", value: 0n }
			: {
					kind: "filled",
					value: hostOfLiteral(owned.type.carrier, owned.start)
				}
	/**
	 * A row of `relation` the ChangeSet states, as its write fills it (witness.ts JudgedRow): `held` each of its columns as
	 * `source` gives it, its value, none where the row holds none, `op` how its statement writes it, `keyed` whether they
	 * hold its whole primary key, and `proposal` which of its facts the statement that writes it proposes
	 * (insert/statement.ts Proposal), an action's INSERT into a family owner only those no stored row holds the key of. It
	 * states its caller's fields; every other column is as `source` gives it: a walked row's every column as it holds it,
	 * a drawn owner's counts and ends as its insert carries them, a stated row's counts and ends, for an insert, at its
	 * empty families'; and otherwise unfilled. A row whose statement proposes it only where no stored row holds its key
	 * is `ifFresh`.
	 */
	const judgedRow = (
		fill: StatedFill,
		relation: StoredRelationName,
		held: (column: ColumnKey) => unknown,
		op: "insert" | "put" | "delete",
		keyed: boolean,
		source: ColumnsSource,
		proposal: Proposal,
		calls: CallFields
	): JudgedRow => {
		const judged = judgedOf(relation)
		/** A field the row states: one the call computes, at the value its term took (`computedValues`), which no row the
		 * host holds holds, or one the row holds. */
		const stated = Object.freeze(
			Object.fromEntries(
				judged.stated.flatMap((name) => {
					const value = calls.values.get(name) ?? held(columnKeyOf(name))
					return value === undefined ? [] : [[name, value] as const]
				})
			)
		)
		if (fill.kind === "unplanned" || !keyed) {
			return { kind: "known", stated, filled: () => unfilled, drawn: calls.drawn }
		}
		/** A column as the row holds it, unfilled where it holds none. */
		const heldColumn = (column: ColumnKey): FilledColumn => {
			const value = held(column)
			return value === undefined ? unfilled : { kind: "filled", value }
		}
		return {
			kind: proposal === "unstored" ? "ifFresh" : "known",
			stated,
			drawn: calls.drawn,
			filled: (column): FilledColumn => {
				const owned = judged.owned.get(column)
				switch (source) {
					case "stated":
						return owned !== undefined && op === "insert" ? emptyOf(owned) : unfilled
					case "drawn":
						return owned === undefined ? unfilled : heldColumn(column)
					case "walk":
						return heldColumn(column)
				}
			}
		}
	}
	/**
	 * The rows the ChangeSet states as `fill` fills them (witness.ts StatedRows), each of its rows: a slot's facts, an
	 * owner slot's as its insert carries the counts and ends the write draws into it, a query entry's in its own words and
	 * none of its columns filled, since its fields are not its target's; and a stratum's nested rows, a nested owner's
	 * with the counts and ends its stratum's appends draw into it, which their family's statements propose every one of.
	 */
	const statedRowsOf = (fill: StatedFill): StatedRows => ({
		slot: (group: GroupData, input: InputData, slot: SlotData) => {
			switch (group.facts.stated.kind) {
				case "entry":
					return fill.rows.slot(slot.slot).facts.map((fact): JudgedRow => ({
						kind: "known",
						stated: fact,
						filled: () => unfilled,
						drawn: noneComputed.drawn
					}))
				case "relation":
					return ownRows(fill, group, input, slot)
			}
		},
		nested: (stratum: StratumAt, relation: StoredRelationName) => {
			const columns = prepared.columns(relation)
			const calls = computedAt(stratum, relation)
			return fill.rows
				.nested(stratum, relation)
				.map((row) =>
					judgedRow(
						fill,
						relation,
						(column) => row.values[columns.at(column)],
						"insert",
						true,
						"walk",
						"every",
						calls
					)
				)
		}
	})
	/**
	 * The rows of a slot stated in its written relation's own words, as `fill` fills them: its facts, an owner slot's as
	 * its insert carries the counts and ends the write draws into it, each as its statement writes it (`judgedRow`).
	 */
	const ownRows = (
		fill: StatedFill,
		group: GroupData,
		input: InputData,
		slot: SlotData
	): ReadonlyArray<JudgedRow> => {
		const relation = group.relation
		const facts = fill.rows.slot(slot.slot).facts
		const op = input.kind === "single" ? input.act.op : "insert"
		const source: ColumnsSource =
			input.kind === "nested"
				? "walk"
				: fill.kind === "sent" && fill.drawn(slot.slot)
					? "drawn"
					: "stated"
		const { primary } = judgedOf(relation)
		const proposal = defined(
			binding.proposals.get(slot.slot),
			`the proposal of member slot ${slot.slot}`
		)
		const calls = computedAt(group.stratum, relation)
		return facts.map((fact) =>
			judgedRow(
				fill,
				relation,
				(column) => (Object.hasOwn(fact, column) ? fact[column] : undefined),
				op,
				primary.every((name) => Object.hasOwn(fact, name) || calls.values.has(name)),
				source,
				proposal,
				calls
			)
		)
	}
	/**
	 * A generated field with no value a stratum's plan filled a row by (runtime/write/fill.ts GeneratedNull) as its
	 * write's refusal: the field's law, witnessed by the first row the ChangeSet states of its relation at `stratum`
	 * whose term has no value, as PostgreSQL's NOT NULL refusal of the statement writing them is (witness.ts
	 * hostJudgement); unreported where the ChangeSet writes no row of the relation.
	 */
	const generatedRejection = (stratum: StratumAt, stop: GeneratedNull): GeneratedRejection => {
		const relation = prepared.witness.tables.get(stop.law.relation)
		const field = relation?.fields.find((f) => f.name === stop.law.field)
		return {
			_tag: "GeneratedRejection",
			law: stop.law,
			witness:
				relation === undefined || field === undefined
					? unreportedWitness
					: hostJudgement(
							prepared.witness,
							statedRowsOf({ kind: "unplanned", rows: normalRows }),
							{ kind: "write", stratum, relations: [relation.name] },
							{ kind: "generated", table: relation.ident, column: field.column }
						).witness
		}
	}
	/**
	 * Each owner slot of a stratum whose family work is one additions statement (write/family/additions.ts), its facts'
	 * counts and ends of each counted family the stratum appends to as the stratum's own appends to the owner draw them,
	 * the owner fresh (`freshOwners`). An owner stored at the fact's key is the insert's exact repeat or its conflict,
	 * which the insert proposes nothing of (insert/statement.ts Proposal), so its stored families are the statement's to
	 * draw.
	 */
	const freshlyCounted = freshOwners(
		ctx,
		prepared.fill,
		binding.fresh,
		normalRows,
		(stratum, relation) =>
			cellsReader(
				codes,
				prepared.columns(relation),
				sentLayout(nestedAt(binding, stratum, relation))
			)
	)
	if (!freshlyCounted.ok) {
		const refusal = freshlyCounted.error
		if (refusal._tag === "EncodingFailure") {
			return Result.err(refusal)
		}
		return Result.ok({
			kind: "generated-rejected",
			rejection: generatedRejection(refusal.stratum, refusal)
		})
	}
	const fresh = freshlyCounted.value.slots
	/** A counted family's fresh groups' members at a stratum, as its fresh fill drew them (`freshOwners`): none where the
	 * stratum inserts no owner of the family's appended members. */
	const freshMembersOf = (stratum: StratumAt, family: string): ReadonlyArray<CellRow> =>
		freshlyCounted.value.members.get(stratum)?.get(family) ?? []
	/**
	 * The write's rows as its statements send them, which its stated rows are judged at: a member slot's facts, an owner
	 * slot's with the counts and ends its fresh fill drew, any other's normal facts; and a stratum's nested rows of a
	 * relation, a nested owner's with the counts and ends its stratum's appends draw (`freshOwners`).
	 */
	const sentRows: WriteRows = {
		slot: (slot) => fresh.get(slot) ?? factsOf(slot),
		nested: (stratum, relation) =>
			freshlyCounted.value.nested.get(stratum)?.get(relation) ?? normalNestedRows(stratum, relation)
	}
	/**
	 * How `inserted` tells the rows of `relation` apart (InsertedKey), worked out once for the relation from the fields
	 * its witness reads it by (witness.ts WitnessField): by its primary key where the host fills every field of it; where
	 * the database stamps one, a clock or a place (ir/instant.ts), by the fields the ChangeSet states of it.
	 */
	const insertedKey = (relation: StoredRelationName): InsertedKey => {
		const judged = judgedOf(relation)
		const fields = defined(
			prepared.witness.tables.get(relation),
			`the witness table of ${relation}, a relation the write inserts`
		).fields
		const fieldOf = (name: string): WitnessField =>
			defined(
				fields.find((f) => f.name === name),
				`the field ${relation}.${name}, which the write inserts`
			)
		const stamps = judged.primary.some((name) => isStamped(fieldOf(name).writing.kind))
		if (!stamps) {
			return { kind: "held", columns: judged.layout.key }
		}
		const stated = judged.stated.map((name) => ({
			key: columnKeyOf(name),
			type: fieldOf(name).type
		}))
		if (!isNonEmpty(stated)) {
			defect(
				`a field ${relation} states besides its key's stamped one, its clock's child or its place's group`
			)
		}
		return { kind: "stamped", stated }
	}
	/**
	 * The reader of a row's key texts in `relation` (`insertedKey`), keyed (core/text.ts TextsId), which its rows are a
	 * set by, as a nested row's key is (NestedRow `keyed`), from its cells and the texts the write holds of them (cells.ts
	 * textAt): each column's position and spec worked out once for the relation.
	 */
	const keyReader = (relation: StoredRelationName): ((values: Cells, texts: Texts) => TextsId) => {
		const columns = prepared.columns(relation)
		const read = insertedKey(relation)
		const key = mapNonEmpty(read.kind === "held" ? read.columns : read.stated, (c) => ({
			at: columns.at(c.key),
			spec: carrierSpecOf(c.type, codes)
		}))
		return (cells, texts) =>
			textsId(key.map((c) => paramOfText(c.spec, textAt(cells, texts, c.at, c.spec))))
	}
	/** Each stratum's inserted rows (`InsertedStratum`), from the sources its statements send. */
	const inserted = (): ReadonlyArray<InsertedStratum> =>
		[...new Set([...binding.groups.map((g) => g.stratum), ...binding.nested.map((n) => n.stratum)])]
			.toSorted((a, b) => a - b)
			.map((stratum): InsertedStratum => {
				/** Each relation's rows, by their key, which the host holds. */
				const keyed = new Map<StoredRelationName, TextsMap<KeyedRow>>()
				/** A row of `relation` at its key: its source's cells themselves, and where another source gave the key cells
				 * before, those cells with this one's over them (`overlaid`). */
				const add = (relation: StoredRelationName, key: TextsId, filled: Cells): void => {
					const of = keyed.getOrInsertComputed(relation, () => new TextsMap<KeyedRow>())
					const row = of.get(key)
					if (row === undefined) {
						of.set(key, { values: filled, scanned: [] })
						return
					}
					row.values = overlaid(row.values, filled)
				}
				const addFacts = (relation: StoredRelationName, slot: ParamId): void => {
					const columns = prepared.columns(relation)
					const keyOf = keyReader(relation)
					for (const fact of sentRows.slot(slot).facts) {
						const filled = factCells(columns, fact)
						add(relation, keyOf(filled, []), filled)
					}
				}
				for (const group of binding.groups) {
					if (group.stratum !== stratum || group.facts.stated.kind !== "relation") {
						continue
					}
					for (const input of group.inputs) {
						switch (input.kind) {
							case "single":
								if (insertsRows(input.act)) {
									addFacts(group.relation, input.slot.slot)
								}
								break
							case "nested":
								addFacts(group.relation, input.slot.slot)
								break
						}
					}
				}
				for (const n of binding.nested) {
					if (n.stratum === stratum) {
						for (const relation of n.layouts.keys()) {
							for (const row of sentRows.nested(stratum, relation)) {
								add(relation, row.keyed, row.values)
							}
						}
					}
				}
				for (const s of binding.fresh) {
					if (s.stratum !== stratum) {
						continue
					}
					for (const f of s.counted) {
						/** The columns the family's statement takes of a member it drew, its fresh layout's beside its key: a
						 * member's own fields, its counts and ends among them where it owns a family, are its other sources'. */
						const memberColumns = prepared.columns(f.member)
						const taken = freshLayoutAt(binding, stratum, familyKey(f.id)).columns.map((c) =>
							memberColumns.at(c.key)
						)
						const keyOf = keyReader(f.member)
						const drawn = new TextsMap<Cells>()
						for (const member of freshMembersOf(stratum, familyKey(f.id))) {
							drawn.set(keyOf(member.values, member.texts), member.values)
						}
						for (const [key, row] of keyed.get(f.member) ?? []) {
							const member = drawn.get(key)
							if (member === undefined) {
								row.scanned.push(f)
								continue
							}
							const merged = row.values.slice()
							for (const at of taken) {
								merged[at] = member[at]
							}
							row.values = merged
						}
					}
				}
				return {
					stratum,
					rows: new Map(
						[...keyed].map(([relation, of]) => [
							relation,
							[...of.values()].map((row): InsertedRow => ({
								values: row.values,
								scanned: row.scanned
							}))
						])
					)
				}
			})
	return Result.ok({
		kind: "bound",
		stated: statedRowsOf({ kind: "sent", rows: sentRows, drawn: (slot) => fresh.has(slot) }),
		inserted,
		relationInputs,
		counted,
		factsOf,
		sentRows,
		freshMembersOf
	})
}

/**
 * Binds one application's rows on the host (`hostRows`): its rows as the write's statements would insert them, or the
 * refusal its binding meets before any SQL, reading the write's host half alone, so a reader of the rows, an insertion
 * preview (program/preview.ts), binds a write it compiled no statement of.
 */
export const bindRows: (
	host: HostBinding,
	inputs: BindInputs
) => Result.Result<RowsResult, EncodingFailure | MessageBound | LiteralBound> = hostRows

/**
 * The statements' half of one application's binding (see `bindWrite`, step 3), over `host`, its rows bound on the host
 * (`hostRows`): the form each statement sends, its placeholder values and its executions.
 */
const boundStatements = (flight: FlightWrite, inputs: BindInputs, host: HostRows): BoundWrite => {
	const { binding, prepared, codes } = flight
	const { relationInputs, counted, factsOf, sentRows, freshMembersOf } = host
	/** Whether an input a statement's rows need holds a fact: a relation parameter by its normalized input's count, a
	 * member slot by its normal facts'. */
	const holdsFact = (input: NeededInput): boolean => {
		switch (input.kind) {
			case "declared":
				return (
					defined(
						relationInputs.get(input.param),
						`the normalized input of relation parameter ${input.param}`
					).count > 0
				)
			case "member":
				return factsOf(input.slot).count > 0
		}
	}
	/** A declared parameter's placeholder's text: its host value, by its declared name, or the array at its part of a
	 * relation parameter's normalized input, which its own encoder writes, whole whatever share an execution carries. */
	const encodeDeclared = (
		slot: DeclaredSlot
	): Result.Result<Param, EncodingFailure | LiteralBound> => {
		switch (slot.kind) {
			case "scalar":
				return slot.encode(inputs.params[slot.param])
			case "relation":
				return slot.encode(
					defined(
						relationInputs.get(slot.param),
						`the normalized input of relation parameter ${slot.param}`
					),
					slot.part
				)
		}
	}
	/**
	 * A placeholder's text: a declared parameter's (`encodeDeclared`), and an admission's, the declared parameter's it
	 * admits; the array at its part of a member slot's facts in `rows`, which its own encoder writes; or the array of one
	 * column of a stratum's nested rows of a relation in `rows`, in their sent layout, as a family statement's rows are
	 * written (order.ts columnArray).
	 */
	const encodeSlot = (
		slot: WriteSlot,
		rows: WriteRows
	): Result.Result<Param, EncodingFailure | LiteralBound> => {
		switch (slot.kind) {
			case "scalar":
			case "relation":
				return encodeDeclared(slot)
			case "admission":
				return encodeDeclared(slot.admits)
			case "member":
				return slot.encode(rows.slot(slot.slot), slot.part)
			case "nestedRows": {
				const cells = filledCellsOf(rows.nested, slot.stratum, slot.relation, slot.rows)
				return nestedColumn(cells, slot.part, cells.rows)
			}
		}
	}
	/**
	 * A stratum's host-filled rows of `relation` (ir/products.ts FilledRows) as their placeholders carry them: their
	 * layout's column types, and each row's cells in its order (runtime/write/executions.ts NestedCells): the walk's nested
	 * rows (`nestedRows`) in their sent layout, or a counted family's fresh groups' members, as the stratum's fresh fill
	 * drew them (`freshOwners`), in the family's fresh layout.
	 */
	const filledCellsOf = (
		nestedRows: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>,
		stratum: StratumAt,
		relation: StoredRelationName,
		rows: FilledRows
	): NestedCells => {
		switch (rows.kind) {
			case "walked":
				return nestedCellsOf(nestedRows, stratum, relation)
			case "fresh": {
				const layout = freshLayoutAt(binding, stratum, rows.family)
				const cellsOf = cellsReader(codes, prepared.columns(relation), layout)
				return {
					relation,
					types: [...layout.key, ...layout.columns].map((c) => c.type),
					rows: freshMembersOf(stratum, rows.family).map((m) => cellsOf(m.values, m.texts))
				}
			}
		}
	}
	/** A stratum's nested rows of `relation` as their placeholders carry them: their sent layout's column types, and each
	 * row's cells in its order (runtime/write/executions.ts NestedCells), as the row holds them. */
	const nestedCellsOf = (
		nestedRows: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>,
		stratum: StratumAt,
		relation: StoredRelationName
	): NestedCells => {
		const layout = sentLayout(nestedAt(binding, stratum, relation))
		return {
			relation,
			types: [...layout.key, ...layout.columns].map((c) => c.type),
			rows: nestedRows(stratum, relation).map((row) => row.cells)
		}
	}
	/** Whether a choice runs its whole-relation form: the relation parameter it reads, counted above, holds more distinct
	 * facts than its threshold. Both forms deliver the same rows, so the count decides only which one is sent. */
	const runsLarge = (choice: ServedWriteChoice): boolean =>
		counted.some((p) => p.param === choice.source.param && runsLargeForm(choice, p.count))
	/**
	 * The form each statement the call sends sends, by its position: a whole statement's chosen form (`sentForm`), where
	 * its rows' needs hold (ir/needs.ts); a single statement's assembled of the units of its chosen form the call's inputs
	 * give rows (runtime/write/parted.ts). A statement of none the call skips.
	 */
	const sentForms = new Map<number, FlightForm>()
	for (const statement of flight.statements) {
		const sent = sentFormOf(statement, runsLarge, holdsFact)
		if (sent !== undefined) {
			sentForms.set(statement.index, sent)
		}
	}
	const skip: ReadonlySet<number> = new Set(
		flight.statements.flatMap(({ index }) => (sentForms.has(index) ? [] : [index]))
	)
	const form = (statement: FlightStatement): FlightForm =>
		defined(
			sentForms.get(statement.index),
			`the form of statement ${statement.index}, which the call sends`
		)
	/**
	 * Every stratum's nested rows of a relation a statement of the flight sends, by stratum and relation, as each
	 * statement that sends them reads them (executions.ts NestedSource): built once for the write, where a statement first
	 * sends them (`sourceOf`), so no statement builds, writes or measures the cells or a column another statement sends,
	 * and a binding none of whose statements is sent, an insertion preview's (program/preview.ts), encodes none.
	 */
	const sources = new TextsMap<NestedSource>()
	const sourceOf = (slot: Extract<WriteSlot, { readonly kind: "nestedRows" }>): NestedSource => {
		const key = filledRowsKey(slot.stratum, slot.relation, slot.rows)
		const built = sources.get(key)
		if (built !== undefined) {
			return built
		}
		const source = nestedSource(
			filledCellsOf(sentRows.nested, slot.stratum, slot.relation, slot.rows)
		)
		sources.set(key, source)
		return source
	}
	/** A statement's placeholder values, each as its executions send it (`encodeSlot`): the member slots' facts and the
	 * strata's nested rows as the write sends them (`sentRows`). */
	const values = (
		statement: FlightStatement
	): Result.Result<ReadonlyArray<Param>, EncodingFailure | LiteralBound> =>
		Result.each(form(statement).paramSlots, (slot) => encodeSlot(slot, sentRows))
	/**
	 * The executions of a statement of member inserts under `batching` (transport.ts Batching), each carrying a share of
	 * every member slot's facts, cut in the slots' order and each slot's canonical order (`batchCuts`), its form the units
	 * of the parts its share gives rows (`sentFormOf`), and every other placeholder whole (`sharedWhole`), its admission's
	 * among them, so each execution's Bind admits every parameter the statement carries: none where the batching is
	 * whole, the statement inserts nothing or reads a relation parameter or nested rows, a slot has a bytes column
	 * (normalize.ts cuttable), or its facts fit one execution, which `chunks` then sends as one. Every share is a call's
	 * facts as host normalization left them: deduplicated, no two of one key, so no execution meets a fact another
	 * inserted at its key, and the deferred constraints and the judge read every execution's rows at COMMIT. Its rows are
	 * every execution's, in order.
	 */
	const batchedExecutions = (
		statement: FlightStatement,
		sent: FlightForm,
		batching: Batching
	): Result.Result<ReadonlyArray<Execution>, EncodingFailure | LiteralBound> | undefined => {
		if (batching.kind === "whole" || !insertsOnly(statement.step)) {
			return undefined
		}
		if (statement.kind === "parted" && !sentForm(statement, runsLarge).cuttable) {
			return undefined
		}
		if (!sent.paramSlots.every((slot) => slot.kind === "member" || sharedWhole(slot))) {
			return undefined
		}
		const members = [
			...new Set(sent.paramSlots.flatMap((slot) => (slot.kind === "member" ? [slot.slot] : [])))
		]
		const normalized = members.map((id) => sentRows.slot(id))
		if (!normalized.every(cuttable)) {
			return undefined
		}
		const cuts = batchCuts(normalized, batching.bytes)
		if (cuts.length < 2) {
			return undefined
		}
		const executions: Array<Execution> = []
		for (const cut of cuts) {
			const shares = new Map(
				members.map((id, i) => {
					const range = defined(cut[i], "a cut's range of each member slot")
					return [
						id,
						slicedSlot(defined(normalized[i], "a member slot's facts"), range.from, range.to)
					] as const
				})
			)
			const rows: WriteRows = {
				slot: (id) => shares.get(id) ?? sentRows.slot(id),
				nested: sentRows.nested
			}
			const holdsShare = (input: NeededInput): boolean =>
				input.kind === "member" && shares.has(input.slot)
					? defined(shares.get(input.slot), "a member slot's share").count > 0
					: holdsFact(input)
			const shareForm = sentFormOf(statement, runsLarge, holdsShare)
			if (shareForm === undefined) {
				continue
			}
			const params = Result.each(shareForm.paramSlots, (slot) => encodeSlot(slot, rows))
			if (!params.ok) {
				return params
			}
			executions.push({ text: shareForm.text, params: params.value, part: partOf(statement.step) })
		}
		return Result.ok(executions)
	}
	/**
	 * The executions under `transport` of a statement (`Chunks`): its batched ones, or its one, each placeholder of
	 * nested rows sending its source as the write built it (`sourceOf`).
	 */
	const chunks: Chunks = (statement, transport) => {
		const sent = sentForms.get(statement.index)
		if (sent === undefined) {
			return Result.ok([])
		}
		const batched = batchedExecutions(statement, sent, transport.batching)
		if (batched !== undefined) {
			return batched
		}
		const nested = sent.paramSlots.map((slot): NestedPlaceholder | undefined =>
			slot.kind === "nestedRows" ? { part: slot.part, source: sourceOf(slot) } : undefined
		)
		return Result.map(
			executionOf(sent.text, nested, partOf(statement.step), (position) =>
				encodeSlot(
					defined(sent.paramSlots[position], "a placeholder of the statement's form"),
					sentRows
				)
			),
			(execution) => [execution]
		)
	}
	return {
		kind: "bound",
		skip,
		form,
		values,
		chunks,
		stated: host.stated,
		inserted: host.inserted
	}
}

/** Normalizes and encodes one application's inputs.
 *
 * Binding one application's inputs to a WriteProgram, before any SQL is sent.
 *
 * 1. Admission of every declared parameter's value, a relation parameter's facts normalized: a value missing or outside
 *    its type is its EncodingFailure, whatever the members hold, so no law the members break answers for an
 *    application its caller did not complete.
 * 2. Host normalization of every enumerated member: admission through each column's exact carrier,
 *    collapse of equal facts, refusal of conflicting additions under a declared key, and netting of additions against
 *    deletions. A conflict is invariant-rejected with the key law before any SQL is sent, once every member is
 *    admitted. A commit is never split, whatever its members' sizes.
 * 3. Each statement's placeholder texts, through the statement's own encoders: a member slot's normalized facts as its
 *    arrays, a declared parameter's value (a ChangeSet.bind value under its private name, or the caller's), and an
 *    attachment's delivered parent keys from its parent statement's rows. A statement whose rows need an input that
 *    holds no fact writes and returns nothing, so it is not sent, nor, of a single statement, a part whose does: the
 *    statement is sent as the units of its other parts (runtime/write/parted.ts), and as none where no part is left. A
 *    column whose array would be longer than one string holds is refused as its LiteralBound, which the shell raises
 *    as InputTooLarge. */
export const bindWrite = (
	flight: FlightWrite,
	inputs: BindInputs
): Result.Result<BindResult, EncodingFailure | MessageBound | LiteralBound> =>
	Result.map(hostRows(flight, inputs), (rows) =>
		rows.kind === "bound" ? boundStatements(flight, inputs, rows) : rows
	)

/** A row `inserted` keys by its primary key, as it builds it: its cells so far, its first source's own until another adds
 * to them, and the families that scan it, still growing. */
interface KeyedRow {
	values: Cells
	readonly scanned: Array<CountedFamily>
}

/** The cells `under` with every cell `over` holds over them: a row of one relation two sources give, the second's
 * columns its own. */
const overlaid = (under: Cells, over: Cells): Cells => {
	const out = under.slice()
	for (const [at, value] of over.entries()) {
		if (value !== undefined) {
			out[at] = value
		}
	}
	return out
}

/** Whether a single input's act inserts rows: an insert, never a delete or a put. */
const insertsRows = (act: SingleAct): boolean => {
	switch (act.op) {
		case "insert":
			return true
		case "delete":
		case "put":
			return false
	}
}

/** Whether every write of `step` inserts: a write step's or each part of a single statement's (batchedExecutions). */
const insertsOnly = (step: OwnStep): boolean => {
	switch (step.kind) {
		case "write":
			return step.result.kind === "insert"
		case "single":
			return step.parts.every((part) => part.step.result.kind === "insert")
		case "carrier":
		case "check":
		case "familyWrite":
			return false
	}
}

/** A range of a member slot's facts, `from` up to `to`, one execution's share of it. */
interface ShareRange {
	readonly from: number
	readonly to: number
}

/** The bytes a fact takes in an execution, as its identity's texts count them: each text's UTF-8 and its end. */
const factBytes = (texts: ReadonlyArray<string>): number => {
	let bytes = 0
	for (const text of texts) {
		bytes += utf8Length(text) + 1
	}
	return bytes
}

/**
 * The executions' cuts of member slots `slots` within `bytes`: each cut a range of every slot, in the slots' order and
 * each slot's facts' canonical order, the facts of a cut together within `bytes` (`factBytes`) but where one fact alone
 * is past it, every fact in exactly one cut.
 */
const batchCuts = (
	slots: ReadonlyArray<NormalizedSlot>,
	bytes: number
): ReadonlyArray<ReadonlyArray<ShareRange>> => {
	const cuts: Array<ReadonlyArray<ShareRange>> = []
	let open: Array<ShareRange> = slots.map(() => ({ from: 0, to: 0 }))
	let held = 0
	let facts = 0
	for (const [i, slot] of slots.entries()) {
		for (const [at, entry] of slot.entries.entries()) {
			const size = factBytes(entry.identity.texts)
			if (facts > 0 && held + size > bytes) {
				cuts.push(open)
				open = slots.map((s, j) => {
					const start = j < i ? s.entries.length : j === i ? at : 0
					return { from: start, to: start }
				})
				held = 0
				facts = 0
			}
			open[i] = { from: defined(open[i], "a cut's range of each member slot").from, to: at + 1 }
			held += size
			facts += 1
		}
	}
	if (facts > 0) {
		cuts.push(open)
	}
	return cuts
}

/** What a statement of `step` does, as its executions are read (runtime/write/executions.ts ExecutionPart). */
const partOf = (step: OwnStep): ExecutionPart => {
	switch (step.kind) {
		case "carrier":
			return "fill"
		case "write":
		case "check":
		case "single":
		case "familyWrite":
			return "statement"
	}
}

/** A generated field with no value an owner's fresh fill read, at the stratum whose owner it fills. */
interface FreshGeneratedNull extends GeneratedNull {
	readonly stratum: StratumAt
}

/**
 * What a fresh fill leaves (`freshOwners`): each owner slot's facts and, by stratum and relation, each nested owner's
 * rows, every one with the counts and ends of its counted families as its stratum's appends to it draw them; and, by
 * stratum and counted family, by its key, the members of its fresh groups as the fill drew them, each its fill's cells
 * and their texts (cells.ts CellRow), its own and every column the family draws on it (binding.ts FreshStratum
 * `fresh`), each group's in key order.
 */
interface FreshCounts {
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	readonly nested: ReadonlyMap<StratumAt, ReadonlyMap<StoredRelationName, ReadonlyArray<NestedRow>>>
	readonly members: ReadonlyMap<StratumAt, ReadonlyMap<string, ReadonlyArray<CellRow>>>
}

/**
 * Each owner a stratum whose family statements run in the call's flight inserts (binding.ts FreshStratum), every row's
 * counts and ends drawn on the host by the filler from the stratum's own appended members naming it, its member slots'
 * facts and its nested rows as normalization leaves them (`normal`; runtime/write/fill.ts filler): an owner it inserts
 * is fresh, so those are its every member, and the filler reads no stored row. Its own insert carries them, so every CHECK over them and every member's axes meet its final values:
 * an owner slot's facts, filled as the ChangeSet's own rows, and a nested owner's rows, filled where the walk stands
 * them (nesting.ts NestedLayout position), whose other columns the walk filled.
 *
 * The fill draws each such group whole, its members with it, and its members are inserted as it drew them: the family's
 * additions statement takes them where the group holds no stored member, and its scan draws every other group
 * (write/family/additions.ts FreshGroups), so each group is drawn by one engine of the one rule (ir/fill.ts FillColumn).
 * A group's members are walked in key order, each key field by its carrier's order (scalar/values/identity.ts
 * compareValues), PostgreSQL's ORDER BY of the member key the scan's slots follow, so the slots, the copies of the count
 * and the folds' planes the host draws are the scan's from slot 0 (test/pg/values/order.test.ts holds the order).
 *
 * A nested owner none of whose families the stratum appends to is filled already, and keeps its walked row: the walk
 * drew its counts and ends at its empty families' values, which no member changes. So the fill runs once for each owner
 * a member names, every family's group readers and key orders worked out once for the stratum.
 */
const freshOwners = (
	ctx: FillContext,
	fill: Filler,
	fresh: ReadonlyArray<FreshStratum>,
	normal: WriteRows,
	cellsOf: (
		stratum: StratumAt,
		relation: StoredRelationName
	) => (values: Cells, texts: Texts) => ReadonlyArray<MemberCell>
): Result.Result<FreshCounts, EncodingFailure | FreshGeneratedNull> => {
	const slotsOut = new Map<ParamId, NormalizedSlot>()
	const nestedOut = new Map<StratumAt, Map<StoredRelationName, ReadonlyArray<NestedRow>>>()
	const membersOut = new Map<StratumAt, ReadonlyMap<string, ReadonlyArray<CellRow>>>()
	for (const { stratum: s, appended, counted: reached, fresh: layouts, owners, left } of fresh) {
		/** The columns of `relation`'s rows the stratum's fills leave to their statements (FreshStratum `left`). */
		const leftOf = (relation: StoredRelationName): ReadonlySet<ColumnKey> =>
			left.get(relation)?.pending ?? new Set()
		/** A counted family's group as the host matches a member to its owner by: every pair but those the call's one
		 * value fills on both sides, which every row of the call holds alike and none the host holds (FreshStratum
		 * `left`). */
		const hostGroup = (f: CountedFamily): Grouped => ({
			group: f.group.filter((g) => !leftOf(f.member).has(columnKeyOf(g.member.name)))
		})
		/** A counted family's fresh layout, which the binding decided for every family the stratum reaches. */
		const layoutOf = (f: CountedFamily): LaidLayout =>
			defined(layouts.get(familyKey(f.id)), `the fresh layout of ${f.owner}.${f.count}`)
		/** Two members' cells in their family's key order, field by field in its carrier's order, each key column's position
		 * and spec worked out once per family. */
		const keyOrder = (f: CountedFamily) => {
			const columns = ctx.columns(f.member)
			const key = layoutOf(f).key.map((c) => ({
				at: columns.at(c.key),
				spec: carrierSpecOf(c.type, ctx.codes)
			}))
			return (a: CellRow, b: CellRow): number => {
				for (const c of key) {
					const order = compareValues(
						c.spec,
						admitted(c.spec, a.values[c.at]),
						admitted(c.spec, b.values[c.at])
					)
					if (order !== 0) {
						return order
					}
				}
				return 0
			}
		}
		/** The members of each group the fill drew, by the family's key and the group, each group once however many of the
		 * stratum's owner rows name it. */
		const drawnMembers = new Map<string, TextsMap<ReadonlyArray<CellRow>>>()
		/** Each member of a filled owner's families, as its fill's cells and their texts: its input's, which the fill
		 * starts each member's row from, and every column the fill drew on it. */
		const keepMembers = (
			filled: FilledNode,
			inputs: ReadonlyArray<{ readonly family: string; readonly group: TextsId }>
		): void => {
			for (const [place, g] of filled.families.entries()) {
				const input = defined(inputs[place], "the members a filled family was given")
				const groups = drawnMembers.getOrInsertComputed(
					input.family,
					() => new TextsMap<ReadonlyArray<CellRow>>()
				)
				groups.set(input.group, g.members)
			}
		}
		/** A relation's appended members' cells and their texts, its slots' facts', then its nested rows', each relation's
		 * read once. */
		const appendedMembers = new Map<StoredRelationName, ReadonlyArray<CellRow>>()
		const membersOf = (relation: StoredRelationName): ReadonlyArray<CellRow> => {
			const known = appendedMembers.get(relation)
			if (known !== undefined) {
				return known
			}
			const columns = ctx.columns(relation)
			const read: ReadonlyArray<CellRow> = [
				...appended.flatMap((a) =>
					a.relation === relation
						? normal
								.slot(a.slot)
								.facts.map((fact) => ({ values: factCells(columns, fact), texts: [] }))
						: []
				),
				...normal.nested(s, relation)
			]
			appendedMembers.set(relation, read)
			return read
		}
		const counted = reached.filter((f) => membersOf(f.member).length > 0)
		/** Each counted family's appended members' cells, by the group they name. */
		const byGroup = new Map(
			counted.map((f) => {
				const groupOf = groupReader(ctx, hostGroup(f), "member", ctx.columns(f.member))
				const groups = new TextsMap<Array<CellRow>>()
				for (const member of membersOf(f.member)) {
					const group = groupOf(member.values, member.texts)
					const list = groups.getOrInsertComputed(group, () => [])
					list.push(member)
				}
				const order = keyOrder(f)
				for (const [group, list] of groups) {
					groups.set(group, list.toSorted(order))
				}
				return [familyKey(f.id), groups] as const
			})
		)
		for (const owner of new Set(counted.map((f) => f.owner))) {
			const families = counted.filter((f) => f.owner === owner)
			/** The counts and ends the fill draws, which the owner's facts and rows carry at their starts. */
			const ownerColumns = ctx.columns(owner)
			/** Each drawn field's position among the owner's columns, by its name. */
			const drawnAt = new Map(
				families
					.flatMap((f) => [f.count, ...f.ends])
					.map((name) => [name, ownerColumns.at(columnKeyOf(name))] as const)
			)
			/** Each family's group readers and appended groups, worked out once per owner relation. */
			const grouped = families.map((f) => ({
				family: f,
				key: familyKey(f.id),
				groupOf: groupReader(ctx, hostGroup(f), "owner", ownerColumns),
				groups: byGroup.get(familyKey(f.id))
			}))
			/** The members each family appends to the owner `row`, by the owner's group in it. */
			const inputsOf = (row: CellRow) =>
				grouped.map((g) => {
					const group = g.groupOf(row.values, row.texts)
					return { family: g.key, group, members: g.groups?.get(group) ?? [] }
				})
			/** An owner's cells with its counts and ends drawn from `inputs`, its appended members, where it stands, or the
			 * fill's refusal: the fill starts from its cells and their texts but those it draws. */
			const filledOf = (row: CellRow, position: FillAt, inputs: ReturnType<typeof inputsOf>) => {
				const values = row.values.slice()
				const texts = row.texts.slice()
				for (const at of drawnAt.values()) {
					values[at] = undefined
					texts[at] = undefined
				}
				const filled = fill(
					{
						relation: owner,
						values,
						texts,
						families: grouped.map((g, i) => ({
							family: g.family.id,
							members: defined(inputs[i], "a family's members").members.map((m): HostNode => ({
								relation: g.family.member,
								values: m.values,
								texts: m.texts,
								families: []
							}))
						}))
					},
					position,
					left
				)
				if (filled.ok) {
					keepMembers(filled.value, inputs)
				}
				return filled
			}
			const refused = (stop: Parameters<typeof fillRefusal>[0]) => {
				const refusal = fillRefusal(stop, slotPlace(owner))
				return refusal._tag === "GeneratedNull"
					? Result.err({ ...refusal, stratum: s })
					: Result.err(refusal)
			}
			const { inserting, nested } = defined(owners.get(owner), `the fresh owner ${owner}`)
			for (const slot of inserting) {
				const current = normal.slot(slot)
				const filledFacts = new Map<Fact, Fact>()
				for (const fact of current.facts) {
					const row: CellRow = { values: factCells(ownerColumns, fact), texts: [] }
					const filled = filledOf(row, { kind: "top" }, inputsOf(row))
					if (!filled.ok) {
						return refused(filled.error.stop)
					}
					const drawn = filled.value.values
					filledFacts.set(
						fact,
						Object.freeze(
							Object.fromEntries(
								Object.entries(fact).map(([name, v]) => {
									const at = drawnAt.get(name)
									return [name, at === undefined ? v : drawn[at]] as const
								})
							)
						)
					)
				}
				slotsOut.set(
					slot,
					refilledSlot(current, (fact) =>
						defined(filledFacts.get(fact), "an owner fact the fill filled")
					)
				)
			}
			if (nested.kind === "at") {
				const rows: Array<NestedRow> = []
				const ownerCells = cellsOf(s, owner)
				for (const row of normal.nested(s, owner)) {
					const inputs = inputsOf(row)
					if (inputs.every((i) => i.members.length === 0)) {
						rows.push(row)
						continue
					}
					const filled = filledOf(row, nested.position, inputs)
					if (!filled.ok) {
						return refused(filled.error.stop)
					}
					const { values: drawn, texts } = filled.value
					rows.push({ ...row, values: drawn, texts, cells: ownerCells(drawn, texts) })
				}
				const byRelation =
					nestedOut.get(s) ?? new Map<StoredRelationName, ReadonlyArray<NestedRow>>()
				byRelation.set(owner, rows)
				nestedOut.set(s, byRelation)
			}
		}
		membersOut.set(
			s,
			new Map(
				[...drawnMembers].map(([family, groups]) => [family, [...groups.values()].flat()] as const)
			)
		)
	}
	return Result.ok({ slots: slotsOut, nested: nestedOut, members: membersOut })
}
