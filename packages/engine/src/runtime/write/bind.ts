import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
/**
 * Binding one application of a write before any SQL is sent (`bindWrite`): its declared parameters admitted, its
 * members normalized, each statement's placeholder values encoded, and its statements' executions in its one flight,
 * from the write's loaded flight and binding alone.
 */
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
import type { Param } from "#compiler/core/wire.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import { familyKey, type GeneratedLaw, type ColumnKey, columnKeyOf } from "#compiler/ir/law.ts"
import { holds, type NeededInput } from "#compiler/ir/needs.ts"
import {
	type FilledRows,
	filledRowsKey,
	type LiteralBound,
	type MessageBound,
	type WriteSlot
} from "#compiler/ir/products.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { runsLargeForm } from "#compiler/runtime/lower/take.ts"
import type {
	CountedFamily,
	FamilyNames,
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
import type { MemberCell, MemberKey, Owner } from "#compiler/runtime/write/draw.ts"
import {
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
	type ServedWriteChoice
} from "#compiler/runtime/write/flight.ts"
import { type Fact, type FillContext, groupReader } from "#compiler/runtime/write/keys.ts"
import {
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
	refilledSlot,
	type SlotData
} from "#compiler/runtime/write/normalize.ts"
import { keyWitness } from "#compiler/runtime/write/outcome.ts"
import {
	type Execution,
	type ExecutionPart,
	executionsOf,
	type NestedCells,
	nestedColumn,
	type NestedPlaceholder,
	type NestedRowBound,
	type NestedSource,
	type PreparedStaged,
	type Unsendable,
	nestedSource
} from "#compiler/runtime/write/staged.ts"
import type { OwnStep } from "#compiler/runtime/write/steps.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import {
	type FilledColumn,
	hostJudgement,
	type JudgedRow,
	type StatedRows
} from "#compiler/runtime/write/witness.ts"
import { hostOfLiteral } from "#compiler/scalar/compute/literal.ts"
import { admitted, compareValues } from "#compiler/scalar/values/identity.ts"
import type { OwnLaw, Witness } from "#compiler/types/changeset/changeset.ts"
import type { SingleAct } from "#compiler/write/frontend/compile.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"

interface BindInputs {
	/** The facts each member slot of the ChangeSet value supplies (`collectInputs`). */
	readonly members: MemberFacts
	/** The declared parameters' values, by name: the caller's, and the values ChangeSet.bind closed under the private
	 * names the Description lists. */
	readonly params: Readonly<Record<string, unknown>>
	/** What one statement carries, which a staged statement's nested rows are cut to (runtime/write/transport.ts
	 * inForce over the wire's Bind frame). */
	readonly transport: Transport
}

/** A row of a nested write that no statement can carry even alone, as its family names it. */
export interface FamilyRowBound {
	readonly _tag: "FamilyRowBound"
	readonly family: FamilyNames
	readonly row: Unsendable
}

export interface BoundWrite {
	readonly kind: "bound"
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
	/** The rows the ChangeSet states as the write fills them (runtime/write/witness.ts StatedRows), which a refusal of
	 * one of its statements judges. */
	readonly stated: StatedRows
	/** The rows the write's statements insert, as this application filled them before any SQL, by stratum
	 * (`InsertedStratum`), each read where it is asked for. */
	readonly inserted: () => ReadonlyArray<InsertedStratum>
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
 * insert slot's facts stated in their relation's own words, an owner's with the counts and ends its fresh fill drew
 * (`slotFacts`), its nested writes' rows (`nestedRowsOf`), and on each counted member the columns of each family a
 * fresh fill drew its group of (`freshMembersOf`), a member of two such families holding both. A query entry's facts,
 * stated in the entry's words, are rows of its target only as the entry's statement maps them, and none of these.
 */
export interface InsertedStratum {
	readonly stratum: StratumAt
	readonly rows: ReadonlyMap<StoredRelationName, ReadonlyArray<InsertedRow>>
}

/**
 * The executions of a statement under `transport`, the message bound of the session that sends them, in the order they
 * are sent (write/program/staged.ts Execution): its one, its `values`, or, where its nested rows' arrays are past the
 * transport's message, its staged form's: its carriers created and filled chunk by chunk, their ANALYZE where the
 * staged statement needs one, then the staged statement (write/program/staged.ts executionsOf). Its rows are every
 * execution's, in order. A nested row no statement or fill carries even alone is its family's FamilyRowBound, before
 * any statement is sent.
 */
export type Chunks = (
	statement: FlightStatement,
	transport: Transport
) => Result.Result<ReadonlyArray<Execution>, EncodingFailure | LiteralBound | FamilyRowBound>

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
 * The fill an application's stated rows are judged at: `drawn`, each owner slot as its insert carries the counts and
 * ends its stratum's appends draw into it (`freshOwners`); or none, before they are drawn, when no write statement is
 * sent.
 */
type StatedFill =
	| { readonly kind: "drawn"; readonly drawn: (slot: ParamId) => NormalizedSlot | undefined }
	| { readonly kind: "unplanned" }

/**
 * What a judged row's columns hold beyond the fields the ChangeSet states: nothing (`stated`); every column a nesting's
 * walk filled (`walk`); or the counts and ends the write draws into an owner's insert (`drawn`).
 */
type ColumnsSource = "stated" | "walk" | "drawn"

const unfilled: FilledColumn = Object.freeze({ kind: "unfilled" })

const unplannedFill: StatedFill = Object.freeze({ kind: "unplanned" })

/** The witness of a refusal no row the ChangeSet states is found breaking. */
const unreportedWitness: Witness = Object.freeze({ kind: "unreported" })

/**
 * What binding one application gives: its bound write; a same-key conflict among its facts, by its key law, the stored
 * relation whose key's constraint refuses it (`relation`, a query entry's target) and its witness, in the words the
 * facts were stated in; or a generated field's refusal.
 */
export type BindResult =
	| BoundWrite
	| {
			readonly kind: "invariant-rejected"
			readonly relation: StoredRelationName
			readonly law: LawId
			readonly described: OwnLaw
			readonly witness: Witness
	  }
	| { readonly kind: "generated-rejected"; readonly rejection: GeneratedRejection }

/** A statement sent inline, whose nested rows, a single statement's none, ride its own Bind message. */
const inline: PreparedStaged = Object.freeze({ kind: "none" })

/**
 * The form a call sends of `statement`, whose inputs `holdsFact` says hold a fact or none, its per-execution choices
 * run as `runsLarge` says: a whole statement's chosen form, where its rows' needs hold, and a single statement's
 * assembled of the units of its chosen form its inputs give rows; none where it sends nothing.
 */
const sentFormOf = (
	statement: FlightStatement,
	runsLarge: (choice: ServedWriteChoice) => boolean,
	holdsFact: (input: NeededInput) => boolean
): FlightForm | undefined => {
	switch (statement.kind) {
		case "whole": {
			const step = statement.step
			return (step.kind === "write" || step.kind === "check") && !holds(step.needs, holdsFact)
				? undefined
				: sentForm(statement, runsLarge)
		}
		case "parted":
			return sentForm(statement, runsLarge).sentFor(holdsFact)
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
): Result.Result<BindResult, EncodingFailure | MessageBound | LiteralBound> => {
	const { binding, prepared, codes } = flight
	/** The declared parameters' values; each relation parameter's distinct fact count, which chooses the form of a
	 * statement whose take its rows bound (`sentForm`). */
	const counted: Array<{ readonly param: ParamId; readonly count: number }> = []
	/** Each relation parameter's input, normalized once for the application: the one set its count and every statement
	 * that binds it read. */
	const relationInputs = new Map<ParamId, NormalizedRelation>()
	const paramValue = (name: string): unknown => inputs.params[name]
	for (const decl of flight.params) {
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
	}
	const normalization = normalizeChangeSet(
		prepared.groups,
		{ fill: prepared.fill, codes, columns: prepared.columns },
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
	/**
	 * A placeholder's text: a declared parameter's host value, by its declared name; the array at its part of a
	 * relation parameter's normalized input or a member slot's normal facts, which its own encoder writes; or the array
	 * of one column of a stratum's nested rows of a relation in their sent layout, as a family statement's rows are
	 * written (order.ts columnArray).
	 */
	const encodeSlot = (
		slot: WriteSlot,
		slotFacts: (slot: ParamId) => NormalizedSlot,
		nestedRows: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>
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
			case "member":
				return slot.encode(slotFacts(slot.slot), slot.part)
			case "nestedRows": {
				const cells = filledCellsOf(nestedRows, slot.stratum, slot.relation, slot.rows)
				return nestedColumn(cells, slot.part, cells.rows)
			}
		}
	}
	/** A counted family's fresh layout at a stratum, which the binding decided for every family a stratum reaches. */
	const freshLayoutAt = (stratum: StratumAt, family: string): LaidLayout =>
		defined(
			binding.fresh.find((f) => f.stratum === stratum)?.fresh.get(family),
			`the fresh layout of family ${family} in stratum ${stratum}`
		)
	/**
	 * A stratum's host-filled rows of `relation` (ir/products.ts FilledRows) as their placeholders carry them: their
	 * layout's column types, and each row's cells in its order (write/program/staged.ts NestedCells): the walk's nested
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
				const layout = freshLayoutAt(stratum, rows.family)
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
	 * row's cells in its order (write/program/staged.ts NestedCells), as the row holds them. */
	const nestedCellsOf = (
		nestedRows: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>,
		stratum: StratumAt,
		relation: StoredRelationName
	): NestedCells => {
		const layout = sentLayout(nestedAt(stratum, relation))
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
	/** A stratum's nested rows of a relation as normalization left them, each as the walk filled it. */
	const normalNestedRows = (
		stratum: StratumAt,
		relation: StoredRelationName
	): ReadonlyArray<NestedRow> => [
		...(normalized.nested.get(stratum)?.get(relation)?.values() ?? [])
	]
	const ctx: FillContext = { codes, evaluate: prepared.evaluate, columns: prepared.columns }
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
	 * states its caller's fields; every other column is, in turn, an owner's count or end as its insert carries it where
	 * the write drew it into the row's facts, else, for an insert, at its empty family's, the walk's value, and otherwise
	 * unfilled. A row whose statement proposes it only where no stored row holds its key is `ifFresh`.
	 */
	const judgedRow = (
		fill: StatedFill,
		relation: StoredRelationName,
		held: (column: ColumnKey) => unknown,
		op: "insert" | "put" | "delete",
		keyed: boolean,
		source: ColumnsSource,
		proposal: Proposal
	): JudgedRow => {
		const judged = judgedOf(relation)
		const stated = Object.freeze(
			Object.fromEntries(
				judged.stated.flatMap((name) => {
					const value = held(columnKeyOf(name))
					return value === undefined ? [] : [[name, value] as const]
				})
			)
		)
		if (fill.kind === "unplanned" || !keyed) {
			return { kind: "known", stated, filled: () => unfilled }
		}
		return {
			kind: proposal === "unstored" ? "ifFresh" : "known",
			stated,
			filled: (column) => {
				const owned = judged.owned.get(column)
				if (owned !== undefined) {
					const drawn = source === "drawn" ? held(column) : undefined
					if (drawn !== undefined) {
						return { kind: "filled", value: drawn }
					}
					return op === "insert" ? emptyOf(owned) : unfilled
				}
				const walked = source === "walk" ? held(column) : undefined
				return walked === undefined ? unfilled : { kind: "filled", value: walked }
			}
		}
	}
	/**
	 * The rows the ChangeSet states as `fill` fills them (witness.ts StatedRows): a slot's facts, an owner slot's as its
	 * insert carries the counts and ends the write draws into it, a query entry's in its own words and none of its
	 * columns filled, since its fields are not its target's; and a stratum's nested rows, which their family's
	 * statements propose every one of.
	 */
	const statedRowsOf = (fill: StatedFill): StatedRows => ({
		slot: (group: GroupData, input: InputData, slot: SlotData) => {
			switch (group.facts.stated.kind) {
				case "entry":
					return factsOf(slot.slot).facts.map((fact): JudgedRow => ({
						kind: "known",
						stated: fact,
						filled: () => unfilled
					}))
				case "relation":
					return ownRows(fill, group, input, slot)
			}
		},
		nested: (stratum: StratumAt, relation: StoredRelationName) => {
			const columns = prepared.columns(relation)
			return normalNestedRows(stratum, relation).map((row) =>
				judgedRow(
					fill,
					relation,
					(column) => row.values[columns.at(column)],
					"insert",
					true,
					"walk",
					"every"
				)
			)
		}
	})
	/**
	 * The rows of a slot stated in its written relation's own words, as `fill` fills them: its facts, an owner slot's as
	 * its insert carries the counts and ends the write draws into it, each as its statement writes it (`judgedRow`); a
	 * retirement's, its groups, its header's key values, which no statement writes as rows, as they are.
	 */
	const ownRows = (
		fill: StatedFill,
		group: GroupData,
		input: InputData,
		slot: SlotData
	): ReadonlyArray<JudgedRow> => {
		const relation = group.relation
		const drawn = fill.kind === "unplanned" ? undefined : fill.drawn(slot.slot)
		const facts = (drawn ?? factsOf(slot.slot)).facts
		const op = input.kind === "single" ? input.act.op : "insert"
		if (op === "retire") {
			return facts.map((fact): JudgedRow => ({
				kind: "known",
				stated: fact,
				filled: () => unfilled
			}))
		}
		const source: ColumnsSource =
			input.kind === "nested" ? "walk" : drawn === undefined ? "stated" : "drawn"
		const { primary } = judgedOf(relation)
		const proposal = defined(
			binding.proposals.get(slot.slot),
			`the proposal of member slot ${slot.slot}`
		)
		return facts.map((fact) =>
			judgedRow(
				fill,
				relation,
				(column) => (Object.hasOwn(fact, column) ? fact[column] : undefined),
				op,
				primary.every((name) => Object.hasOwn(fact, name)),
				source,
				proposal
			)
		)
	}
	/** Where `relation` stands in a nested write of `stratum` that fills its rows (binding.ts NestedAt). */
	const nestedAt = (stratum: StratumAt, relation: StoredRelationName): NestedLayoutData =>
		defined(
			binding.nested.find((n) => n.stratum === stratum)?.layouts.get(relation),
			`the nested layout of ${relation}, a relation a nested write of stratum ${stratum} fills`
		)
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
							statedRowsOf(unplannedFill),
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
		factsOf,
		normalNestedRows,
		(stratum, relation) =>
			cellsReader(codes, prepared.columns(relation), sentLayout(nestedAt(stratum, relation)))
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
	/** A stratum's nested rows of a relation as its statements send them: a nested owner's with the counts and ends its
	 * stratum's appends draw (`freshOwners`). */
	const nestedRowsOf = (
		stratum: StratumAt,
		relation: StoredRelationName
	): ReadonlyArray<NestedRow> =>
		freshlyCounted.value.nested.get(stratum)?.get(relation) ?? normalNestedRows(stratum, relation)
	/** A row of a nested relation no fill carries even alone, as the first family it is a member of names it (binding.ts
	 * Binding rowFamilies). */
	const nestedRowBound = (bound: NestedRowBound): FamilyRowBound => ({
		_tag: "FamilyRowBound",
		family: defined(
			binding.rowFamilies.get(bound.relation),
			`a family whose member is ${bound.relation}, a relation a nested write fills`
		),
		row: bound.row
	})
	/**
	 * Every stratum's nested rows of a relation a statement of the flight sends, by stratum and relation, as each
	 * statement that sends them reads them (staged.ts NestedSource): built once for the write, where a statement first
	 * sends them (`sourceOf`), so no statement builds, writes or measures the cells or a column another statement sends,
	 * and a binding none of whose statements is sent, an insertion preview's (program/preview.ts), encodes none.
	 */
	const sources = new TupleMap<readonly [StratumAt, StoredRelationName, string], NestedSource>()
	const sourceOf = (slot: Extract<WriteSlot, { readonly kind: "nestedRows" }>): NestedSource => {
		const key = [slot.stratum, slot.relation, filledRowsKey(slot.rows)] as const
		const built = sources.get(key)
		if (built !== undefined) {
			return built
		}
		const source = nestedSource(filledCellsOf(nestedRowsOf, slot.stratum, slot.relation, slot.rows))
		sources.set(key, source)
		return source
	}
	/** A member slot's facts as its statements send them: an owner slot's with the counts and ends its fresh fill drew
	 * (`freshOwners`), any other's normal facts. */
	const slotFacts = (slot: ParamId): NormalizedSlot => fresh.get(slot) ?? factsOf(slot)
	/** A statement's placeholder values, each as its executions send it (`encodeSlot`): the member slots' facts and the
	 * strata's nested rows as the write sends them (`slotFacts`, `nestedRowsOf`). */
	const values = (
		statement: FlightStatement
	): Result.Result<ReadonlyArray<Param>, EncodingFailure | LiteralBound> =>
		Result.each(form(statement).paramSlots, (slot) => encodeSlot(slot, slotFacts, nestedRowsOf))
	/**
	 * The executions under `transport` of a statement: its one, or, where its nested rows' arrays are past the
	 * transport's message, its staged form's (`Chunks`); each placeholder of nested rows sends its source as the write
	 * built it (`sourceOf`).
	 */
	const chunks: Chunks = (statement, transport) => {
		const sent = sentForms.get(statement.index)
		if (sent === undefined) {
			return Result.ok([])
		}
		const nested = sent.paramSlots.map((slot): NestedPlaceholder | undefined =>
			slot.kind === "nestedRows" ? { part: slot.part, source: sourceOf(slot) } : undefined
		)
		const executions = executionsOf(
			{ text: sent.text, staged: statement.kind === "whole" ? statement.staged : inline, nested },
			partOf(statement.step),
			(position) =>
				encodeSlot(
					defined(sent.paramSlots[position], "a placeholder of the statement's form"),
					slotFacts,
					nestedRowsOf
				),
			transport
		)
		if (executions.ok) {
			return executions
		}
		const refused = executions.error
		return Result.err(refused._tag === "NestedRowBound" ? nestedRowBound(refused) : refused)
	}
	/**
	 * The reader of a row's primary key texts in `relation`, which its rows are a set by, as a nested row's key is
	 * (NestedRow `key`), from its cells and the texts the write holds of them (cells.ts textAt): each key column's
	 * position and spec worked out once for the relation.
	 */
	const keyReader = (
		relation: StoredRelationName
	): ((values: Cells, texts: Texts) => MemberKey) => {
		const columns = prepared.columns(relation)
		const key = mapNonEmpty(judgedOf(relation).layout.key, (c) => ({
			at: columns.at(c.key),
			spec: carrierSpecOf(c.type, codes)
		}))
		return (cells, texts) =>
			mapNonEmpty(key, (c) => paramOfText(c.spec, textAt(cells, texts, c.at, c.spec)))
	}
	/** Each stratum's inserted rows (`InsertedStratum`), from the sources its statements send. */
	const inserted = (): ReadonlyArray<InsertedStratum> =>
		[...new Set([...binding.groups.map((g) => g.stratum), ...binding.nested.map((n) => n.stratum)])]
			.toSorted((a, b) => a - b)
			.map((stratum): InsertedStratum => {
				/** Each relation's rows, by their key, which the host holds. */
				const keyed = new Map<StoredRelationName, TupleMap<MemberKey, KeyedRow>>()
				/** A row of `relation` at its key: its source's cells themselves, and where another source gave the key cells
				 * before, those cells with this one's over them (`overlaid`). */
				const add = (relation: StoredRelationName, key: MemberKey, filled: Cells): void => {
					const of = keyed.get(relation) ?? new TupleMap<MemberKey, KeyedRow>()
					keyed.set(relation, of)
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
					for (const fact of slotFacts(slot).facts) {
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
							for (const row of nestedRowsOf(stratum, relation)) {
								add(relation, row.key, row.values)
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
						const taken = freshLayoutAt(stratum, familyKey(f.id)).columns.map((c) =>
							memberColumns.at(c.key)
						)
						const keyOf = keyReader(f.member)
						const drawn = new TupleMap<MemberKey, Cells>()
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
		skip,
		form,
		values,
		chunks,
		stated: statedRowsOf({ kind: "drawn", drawn: (slot) => fresh.get(slot) }),
		inserted
	})
}

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

/** Whether a single input's act inserts rows: an insert, never a delete, a put or a retirement. */
const insertsRows = (act: SingleAct): boolean => {
	switch (act.op) {
		case "insert":
			return true
		case "delete":
		case "put":
		case "retire":
			return false
	}
}

/** What a statement of `step` does, as its executions are read (write/program/staged.ts ExecutionPart). */
const partOf = (step: OwnStep): ExecutionPart => {
	switch (step.kind) {
		case "carrier":
			return step.step === "create" ? "create" : "fill"
		case "analyze":
			return "analyze"
		case "write":
		case "check":
		case "single":
		case "familyWrite":
		case "hold":
		case "retire":
		case "admission":
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
 * facts and its nested rows (runtime/write/fill.ts filler): an owner it inserts is fresh, so those are its every member,
 * and the filler reads no stored row. Its own insert carries them, so every CHECK over them and every member's axes meet its final values:
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
	factsOf: (slot: ParamId) => NormalizedSlot,
	nestedOf: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>,
	cellsOf: (
		stratum: StratumAt,
		relation: StoredRelationName
	) => (values: Cells, texts: Texts) => ReadonlyArray<MemberCell>
): Result.Result<FreshCounts, EncodingFailure | FreshGeneratedNull> => {
	const slotsOut = new Map<ParamId, NormalizedSlot>()
	const nestedOut = new Map<StratumAt, Map<StoredRelationName, ReadonlyArray<NestedRow>>>()
	const membersOut = new Map<StratumAt, ReadonlyMap<string, ReadonlyArray<CellRow>>>()
	for (const { stratum: s, appended, counted: reached, fresh: layouts, owners } of fresh) {
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
		const drawnMembers = new Map<string, TupleMap<Owner, ReadonlyArray<CellRow>>>()
		/** Each member of a filled owner's families, as its fill's cells and their texts: its input's, which the fill
		 * starts each member's row from, and every column the fill drew on it. */
		const keepMembers = (
			filled: FilledNode,
			inputs: ReadonlyArray<{ readonly family: string; readonly group: Owner }>
		): void => {
			for (const [place, g] of filled.families.entries()) {
				const input = defined(inputs[place], "the members a filled family was given")
				const groups =
					drawnMembers.get(input.family) ?? new TupleMap<Owner, ReadonlyArray<CellRow>>()
				drawnMembers.set(input.family, groups)
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
						? factsOf(a.slot).facts.map((fact) => ({ values: factCells(columns, fact), texts: [] }))
						: []
				),
				...nestedOf(s, relation)
			]
			appendedMembers.set(relation, read)
			return read
		}
		const counted = reached.filter((f) => membersOf(f.member).length > 0)
		/** Each counted family's appended members' cells, by the group they name. */
		const byGroup = new Map(
			counted.map((f) => {
				const groupOf = groupReader(ctx, f, "member", ctx.columns(f.member))
				const groups = new TupleMap<Owner, Array<CellRow>>()
				for (const member of membersOf(f.member)) {
					const group = groupOf(member.values, member.texts)
					const list = groups.get(group) ?? []
					list.push(member)
					groups.set(group, list)
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
				groupOf: groupReader(ctx, f, "owner", ownerColumns),
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
					position
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
				const current = factsOf(slot)
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
				for (const row of nestedOf(s, owner)) {
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
