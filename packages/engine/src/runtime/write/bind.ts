/**
 * Binding one application of a write before any SQL is sent (`bindWrite`): its declared parameters admitted, its
 * members normalized, each statement's placeholder values encoded, and its statements' flights planned by the write
 * (`RunnableWrite`), from the write's loaded flight and binding alone.
 */
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	type NormalizedRelation,
	parameterNormalizer,
	positionalColumns
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf, paramEncoder } from "#compiler/codec/scalar.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { isIterable } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { OutputText, Param, ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import { type FamilyId, familyKey, type GeneratedLaw } from "#compiler/ir/law.ts"
import type { LiteralBound, MessageBound, WriteSlot } from "#compiler/ir/products.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { runsLargeForm } from "#compiler/runtime/lower/take.ts"
import type {
	Binding,
	FamilyNames,
	FreshStratum,
	JudgedRelation,
	OwnedColumn
} from "#compiler/runtime/write/binding.ts"
import { type MemberKey, type Owner, type Recount, rowTexts } from "#compiler/runtime/write/draw.ts"
import {
	type ColumnKey,
	fieldKey,
	type Filler,
	fillRefusal,
	type GeneratedNull,
	type HostNode,
	literalHost
} from "#compiler/runtime/write/fill.ts"
import {
	type FlightForm,
	type FlightStatement,
	type FlightWrite,
	sentForm,
	type ServedWriteChoice
} from "#compiler/runtime/write/flight.ts"
import {
	type Fact,
	type FillContext,
	groupOf,
	groupOfOwner,
	keyOf,
	type Values,
	valuesOfFact
} from "#compiler/runtime/write/keys.ts"
import {
	type NestedLayoutData,
	type NestedRow,
	rowOfValues,
	sentLayout
} from "#compiler/runtime/write/nesting.ts"
import {
	type GroupData,
	type InputData,
	type MemberFacts,
	normalizeChangeSet,
	type Normalized,
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
	type NestedRowBound
} from "#compiler/runtime/write/staged.ts"
import type { OwnStep } from "#compiler/runtime/write/steps.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import {
	type FilledColumn,
	hostJudgement,
	type JudgedRow,
	type StatedRows
} from "#compiler/runtime/write/witness.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { OwnLaw, Witness } from "#compiler/types/changeset/changeset.ts"
import type { Unsendable } from "#compiler/write/family/order.ts"
import type { RowState } from "#compiler/write/family/state.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"

interface BindInputs {
	/** The facts each member slot of the ChangeSet value supplies (`collectInputs`). */
	readonly members: MemberFacts
	/** The declared parameters' values, by name: the caller's, and the values ChangeSet.bind closed under the private
	 * names the Description lists. */
	readonly params: Readonly<Record<string, unknown>>
	/** What one statement carries, which a family's statements are cut to (write/family/order.ts inForce over the
	 * wire's Bind frame). */
	readonly transport: Transport
}

/** A row of a family write that no statement can carry even alone, as its family names it. */
export interface FamilyRowBound {
	readonly _tag: "FamilyRowBound"
	readonly family: FamilyNames
	readonly row: Unsendable
}

/** A read's rows as PostgreSQL answered them: each cell its output text. */
export type Raw = ReadonlyArray<ReadonlyArray<OutputText>>

export interface BoundWrite {
	readonly kind: "bound"
	/**
	 * The rows the ChangeSet states before its plan is drawn, every column its write fills unfilled: what a refusal the
	 * read flight meets judges, which states none of them.
	 */
	readonly unplanned: StatedRows
	/** The positions of the write's statements the runtime may skip: their enumerated member holds no fact. */
	readonly skip: ReadonlySet<number>
	/** The form of a statement of the write this application sends (runtime/write/flight.ts sentForm). */
	readonly form: (statement: FlightStatement) => FlightForm
	/**
	 * The placeholder values of that form, each a text or a bytes or text column's binary array: none reads another
	 * statement's rows. A relation input's arrays are written once per statement, by the encoder its placeholders share.
	 */
	readonly values: (
		statement: FlightStatement
	) => Result.Result<ReadonlyArray<Param>, EncodingFailure | LiteralBound>
	/** How the application's statements reach the server: one flight, or a read flight first (`Flights`). */
	readonly flights: Flights
}

/**
 * The executions of a statement under `transport`, the message bound of the session that sends them, in the order they
 * are sent (write/program/staged.ts Execution): a family step's one per statement of its kind in its family's plan
 * (write/family/order.ts plan), each its rows' arrays under the statement's one text, none when the application writes
 * no row of that kind; any other statement's its one, its `values`, or, where its nested rows' arrays are past the
 * transport's message, its staged form's: its carriers created and filled chunk by chunk, their ANALYZE where the
 * staged statement needs one, then the staged statement (write/program/staged.ts executionsOf). Its rows are every execution's, in order. A row no
 * statement or fill carries even alone is its family's FamilyRowBound, and a change an immutable owner's stored family
 * refuses its CompileError (write/family/edit.ts planEdits), before any write statement is sent: the read flight has
 * found the stored groups.
 */
export type Chunks = (
	statement: FlightStatement,
	transport: Transport
) => Result.Result<
	ReadonlyArray<Execution>,
	EncodingFailure | LiteralBound | FamilyRowBound | CompileError
>

/** One family's read as one execution sends it (write/family/statements.ts ReadSql): its text and its placeholders' texts. */
export interface ReadStatement {
	/** The family whose stored suffixes it reads, which a failure the read meets is attributed to. */
	readonly family: FamilyId
	readonly sql: EmittedText
	readonly params: ReadonlyArray<ParamText>
}

/**
 * How one application's statements reach the server, in its one transaction:
 * - `write`: one flight of the artifact's statements, when the changeset names no member of any family, so no family
 *   write needs a stored row;
 * - `read`: first a flight of the family reads, one batched SELECT per family of the stored suffixes and the owners'
 *   counts and ends of every touched group, then the artifact's statements, whose family writes `writes` plans from the
 *   reads' rows, one array of rows per read in order. Under SERIALIZABLE a concurrent writer to a group the reads read
 *   meets 40001 at one of the two, and grizzle does not retry.
 */
export type Flights =
	| ({ readonly kind: "write" } & PlanWrites)
	| {
			readonly kind: "read"
			readonly reads: NonEmptyReadonlyArray<ReadStatement>
			readonly writes: (
				rows: ReadonlyArray<Raw>
			) => Result.Result<
				PlanWrites,
				EncodingFailure | FamilyRowBound | CompileError | GeneratedRejection
			>
	  }

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
 * An application's write statements under one plan: each statement's executions (`Chunks`), and the rows the ChangeSet
 * states as that plan fills them (runtime/write/witness.ts StatedRows), which a refusal of one of them judges.
 */
export interface PlanWrites {
	readonly chunks: Chunks
	readonly stated: StatedRows
}

/**
 * What one stratum's plan leaves: each counted family's recounts, by family key, the count and ends each owner whose
 * members the stratum changes ends at; every row its reads found, stored, by relation and key; and every row its reads
 * found and its writes leave.
 */
export interface StratumFill {
	readonly recounts: ReadonlyMap<string, ReadonlyTupleMap<Owner, Recount>>
	readonly found: RowState
	readonly rows: RowState
}

/**
 * The plan an application's stated rows are judged at: `planned`, its strata's fills, a stratum absent filling nothing,
 * and `drawn`, each owner slot as its insert carries the counts and ends the write draws into it, the plan's or, where
 * the stratum's family work is one additions statement, the fresh fill's; `flight`, a write whose family work all runs
 * in its one flight, its fresh fill's `drawn` alone; or none, before the plan is drawn or where it is refused, when no
 * write statement is sent.
 */
export type StatedFill =
	| {
			readonly kind: "planned"
			readonly strata: ReadonlyMap<StratumAt, StratumFill>
			readonly drawn: (slot: ParamId) => NormalizedSlot | undefined
	  }
	| { readonly kind: "flight"; readonly drawn: (slot: ParamId) => NormalizedSlot | undefined }
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

/**
 * What binding one application found before its flights are planned (`FlightsOf`): the transport its statements are
 * cut to, the installation's codes, the write's binding, each stratum's nested rows as normalization left them, each
 * member slot's normal facts, each fresh owner slot's facts with the counts and ends its fill drew, the form of each
 * statement the application sends, the rows it states as a fill fills them (`StatedFill`), a generated field's refusal at a
 * stratum, and the executions of a statement no family step plans, each member slot's facts by `slotFacts`.
 */
export interface Applied {
	readonly transport: Transport
	readonly codes: Codebook
	readonly binding: Binding
	readonly nested: Normalized["nested"]
	readonly factsOf: (slot: ParamId) => NormalizedSlot
	readonly fresh: ReadonlyMap<ParamId, NormalizedSlot>
	readonly form: (statement: FlightStatement) => FlightForm
	readonly statedRowsOf: (fill: StatedFill) => StatedRows
	readonly generatedRejection: (stratum: StratumAt, stop: GeneratedNull) => GeneratedRejection
	readonly statementChunks: (
		statement: FlightStatement,
		transport: Transport,
		slotFacts: (slot: ParamId) => NormalizedSlot
	) => Result.Result<ReadonlyArray<Execution>, EncodingFailure | LiteralBound | FamilyRowBound>
}

/** How a write's statements reach the server (`Flights`), from what binding one application found, or a generated
 * field's refusal before any statement. */
export type FlightsOf = (applied: Applied) => Result.Result<Flights, GeneratedRejection>

/**
 * A write as binding runs it: its flight, loaded under the installation's codes (runtime/write/flight.ts loadWrite),
 * and how its statements reach the server: in its one flight (`servedFlights`), or, for a write whose family work the
 * host plans from a read flight, which no served file holds (served/unserved.ts UnservedMember), as the planner over
 * its compiled write plans them (write/program/bind.ts legacyFlights).
 */
export interface RunnableWrite {
	readonly flight: FlightWrite
	readonly flights: FlightsOf
}

/**
 * The flights of a write whose family work all runs in its one flight (runtime/write/flight.ts ServedWrite), which
 * holds no family step: each statement's executions, an owner slot's facts with the counts and ends its fresh fill
 * drew, and the stated rows as that fill fills them.
 */
const servedFlights: FlightsOf = ({ fresh, factsOf, statementChunks, statedRowsOf }) => {
	const slotFacts = (slot: ParamId): NormalizedSlot => fresh.get(slot) ?? factsOf(slot)
	return Result.ok({
		kind: "write",
		chunks: (statement, transport) => {
			const step = statement.step
			if (step.kind === "family") {
				throw defect(`a family step of stratum ${step.stratum}, which no served write holds`)
			}
			return statementChunks(statement, transport, slotFacts)
		},
		stated: statedRowsOf({ kind: "flight", drawn: (slot) => fresh.get(slot) })
	})
}

/** A served write as binding runs it: its flight, every statement in it (`servedFlights`). */
export const servedRunnable = (flight: FlightWrite): RunnableWrite =>
	Object.freeze({ flight, flights: servedFlights })

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
 *    attachment's delivered parent keys from its parent statement's rows. A statement whose enumerated member holds no
 *    fact produces no statement, so the runtime may skip it. A column whose array would be longer than one string
 *    holds is refused as its LiteralBound, which the shell raises as InputTooLarge. */
export const bindWrite = (
	runnable: RunnableWrite,
	inputs: BindInputs
): Result.Result<BindResult, EncodingFailure | MessageBound | LiteralBound | CompileError> => {
	const flight = runnable.flight
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
		{ fill: prepared.fill, codes },
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
	const holdsNoFact = (slot: ParamId): boolean => factsOf(slot).count === 0
	const skip: ReadonlySet<number> = new Set(
		flight.statements.flatMap(({ step, index }) =>
			(step.kind === "write" || step.kind === "advance" || step.kind === "check") &&
			step.skipWhenEmpty !== undefined &&
			holdsNoFact(step.skipWhenEmpty)
				? [index]
				: []
		)
	)
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
				const cells = nestedCellsOf(nestedRows, slot.stratum, slot.relation)
				return nestedColumn(cells, slot.part, cells.rows)
			}
		}
	}
	/** A stratum's nested rows of `relation` as their placeholders carry them: their sent layout's column types, and each
	 * row's cells in its order (write/program/staged.ts NestedCells). */
	const nestedCellsOf = (
		nestedRows: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>,
		stratum: StratumAt,
		relation: StoredRelationName
	): NestedCells => {
		const layout = sentLayout(nestedAt(stratum, relation))
		return {
			relation,
			types: [...layout.key, ...layout.columns].map((c) => c.type),
			rows: nestedRows(stratum, relation).map((row) =>
				rowTexts(rowOfValues(codes, layout, row.values))
			)
		}
	}
	/** Whether a choice runs its whole-relation form: the relation parameter it reads, counted above, holds more distinct
	 * facts than its threshold. Both forms deliver the same rows, so the count decides only which one is sent. */
	const runsLarge = (choice: ServedWriteChoice): boolean =>
		counted.some((p) => p.param === choice.source.param && runsLargeForm(choice, p.count))
	const form = (statement: FlightStatement): FlightForm => sentForm(statement, runsLarge)
	/** A statement's placeholder texts over `slotFacts`, each member slot's normal facts, and `nestedRows`, each stratum's
	 * nested rows of a relation. */
	const valuesOver =
		(
			slotFacts: (slot: ParamId) => NormalizedSlot,
			nestedRows: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>
		) =>
		(
			statement: FlightStatement
		): Result.Result<ReadonlyArray<Param>, EncodingFailure | LiteralBound> => {
			const out: Array<Param> = []
			for (const slot of form(statement).paramSlots) {
				const encoded = encodeSlot(slot, slotFacts, nestedRows)
				if (!encoded.ok) {
					return Result.err(encoded.error)
				}
				out.push(encoded.value)
			}
			return Result.ok(out)
		}
	const values = valuesOver(factsOf, (stratum, relation) => [
		...(normalized.nested.get(stratum)?.get(relation)?.values() ?? [])
	])
	const ctx: FillContext = { codes, evaluate: prepared.evaluate }
	/** How `relation`'s stated rows are judged, which the binding decided when the write compiled. */
	const judgedOf = (relation: StoredRelationName): JudgedRelation =>
		defined(binding.judged.get(relation), `the judged relation ${relation}, a written one`)
	/** An owner's count or end while its family is empty: the count 0, each end at its start. */
	const emptyOf = (owned: OwnedColumn): FilledColumn =>
		owned.kind === "count"
			? { kind: "filled", value: 0n }
			: {
					kind: "filled",
					value: literalHost(carrierSpecOf(owned.type, codes), owned.start)
				}
	/**
	 * What the stratum's reads found at the key of `relation`'s row `columns`, `key` its key's texts: `stored`, a row
	 * they found; `fresh`, none, the owner of a group a counted family of it recounts, which its read looked up
	 * (order.ts OwnerWrite); `unread`, a row no read looked up, which a stored row may hold.
	 */
	const foundAt = (
		at: StratumFill | undefined,
		relation: StoredRelationName,
		judged: JudgedRelation,
		columns: Values,
		key: MemberKey
	): "stored" | "fresh" | "unread" => {
		if (at === undefined) {
			return "unread"
		}
		if (at.found.get(relation)?.get(key) !== undefined) {
			return "stored"
		}
		return [...judged.owned.values()].some(
			(owned) =>
				at.recounts
					.get(familyKey(owned.family.id))
					?.has(groupOfOwner(ctx, owned.family, columns)) === true
		)
			? "fresh"
			: "unread"
	}
	/**
	 * A row of `relation` the ChangeSet states in `stratum`, as its write fills it (witness.ts JudgedRow): `columns` its
	 * columns as `source` gives them, `op` how its statement writes it, `key` its primary key's texts where they are
	 * known, and `proposal` which of its facts the statement that writes it proposes (insert/statement.ts Proposal), an
	 * action's INSERT into a family owner only those no stored row holds the key of. It states its caller's and serial
	 * fields; every other column is, in turn, a count or an end its stratum's recount draws, the value the plan's rows
	 * hold at its key, unfilled for a row the reads found stored, an owner's count or end as its insert carries it where
	 * the write drew it into the row's facts, else at its empty family's where the reads found none stored or, for an
	 * insert, looked up none, the walk's value, and otherwise unfilled. A row no read looked up that its statement
	 * proposes only where no stored row holds its key is `ifFresh`.
	 */
	const judgedRow = (
		fill: StatedFill,
		stratum: StratumAt,
		relation: StoredRelationName,
		columns: Values,
		op: "insert" | "put" | "delete",
		key: MemberKey | undefined,
		source: ColumnsSource,
		proposal: Proposal
	): JudgedRow => {
		const judged = judgedOf(relation)
		const stated = Object.freeze(
			Object.fromEntries(
				judged.stated.flatMap((name) => {
					const value = columns.get(fieldKey(name))
					return value === undefined ? [] : [[name, value] as const]
				})
			)
		)
		if (fill.kind === "unplanned" || key === undefined) {
			return { kind: "known", stated, filled: () => unfilled }
		}
		const at = fill.kind === "planned" ? fill.strata.get(stratum) : undefined
		const found = foundAt(at, relation, judged, columns, key)
		const empty = found === "fresh" || (found === "unread" && op === "insert")
		return {
			kind: found === "unread" && proposal === "unstored" ? "ifFresh" : "known",
			stated,
			filled: (column) => {
				const owned = judged.owned.get(column)
				const recount =
					owned === undefined
						? undefined
						: at?.recounts
								.get(familyKey(owned.family.id))
								?.get(groupOfOwner(ctx, owned.family, columns))
				if (owned !== undefined && recount !== undefined) {
					return {
						kind: "filled",
						value: owned.kind === "count" ? BigInt(recount.count) : recount.ends.get(owned.name)
					}
				}
				const held = at === undefined ? undefined : at.rows.get(relation)?.get(key)
				if (held?.has(column) === true) {
					return { kind: "filled", value: held.get(column) }
				}
				if (found === "stored") {
					return unfilled
				}
				if (owned !== undefined) {
					if (source === "drawn" && columns.has(column)) {
						return { kind: "filled", value: columns.get(column) }
					}
					return empty ? emptyOf(owned) : unfilled
				}
				return source === "walk" && columns.has(column)
					? { kind: "filled", value: columns.get(column) }
					: unfilled
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
		nested: (stratum: StratumAt, relation: StoredRelationName) =>
			[...(normalized.nested.get(stratum)?.get(relation)?.values() ?? [])].map((row) =>
				judgedRow(fill, stratum, relation, row.values, "insert", row.key, "walk", "every")
			)
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
		const drawn = fill.kind === "unplanned" ? undefined : fill.drawn(slot.slot)
		const facts = (drawn ?? factsOf(slot.slot)).facts
		const source: ColumnsSource =
			input.kind === "nested" ? "walk" : drawn === undefined ? "stated" : "drawn"
		const { layout, primary } = judgedOf(relation)
		const op = input.kind === "single" ? input.act.op : "insert"
		const proposal = defined(
			binding.proposals.get(slot.slot),
			`the proposal of member slot ${slot.slot}`
		)
		return facts.map((fact) => {
			const columns = new Map(Object.entries(fact).map(([name, v]) => [fieldKey(name), v] as const))
			const whole = primary.every((name) => columns.has(fieldKey(name)))
			return judgedRow(
				fill,
				group.stratum,
				relation,
				columns,
				op,
				whole ? keyOf(ctx, layout, columns) : undefined,
				source,
				proposal
			)
		})
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
	const normalNestedRows = (
		stratum: StratumAt,
		relation: StoredRelationName
	): ReadonlyArray<NestedRow> => [
		...(normalized.nested.get(stratum)?.get(relation)?.values() ?? [])
	]
	const freshlyCounted = freshOwners(ctx, prepared.fill, binding.fresh, factsOf, normalNestedRows)
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
	 * The executions under `transport` of a statement no family step plans, each member slot's facts by `slotFacts`: its
	 * one, or, where its nested rows' arrays are past the transport's message, its staged form's (`Chunks`).
	 */
	const statementChunks = (
		statement: FlightStatement,
		transport: Transport,
		slotFacts: (slot: ParamId) => NormalizedSlot
	): Result.Result<ReadonlyArray<Execution>, EncodingFailure | LiteralBound | FamilyRowBound> => {
		const sent = form(statement)
		const sources = new Map<string, NestedCells>()
		const nested = sent.paramSlots.map((slot): NestedPlaceholder | undefined => {
			if (slot.kind !== "nestedRows") {
				return undefined
			}
			const source = `${slot.stratum} ${slot.relation}`
			const cells = sources.get(source) ?? nestedCellsOf(nestedRowsOf, slot.stratum, slot.relation)
			sources.set(source, cells)
			return { part: slot.part, cells }
		})
		const executions = executionsOf(
			{ text: sent.text, staged: statement.staged, nested },
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
	const flown = runnable.flights({
		transport: inputs.transport,
		codes,
		binding,
		nested: normalized.nested,
		factsOf,
		fresh,
		form,
		statedRowsOf,
		generatedRejection,
		statementChunks
	})
	if (!flown.ok) {
		return Result.ok({ kind: "generated-rejected", rejection: flown.error })
	}
	const flights = flown.value
	return Result.ok({
		kind: "bound",
		unplanned: statedRowsOf(unplannedFill),
		skip,
		form,
		values,
		flights
	})
}

/** What a statement of `step` does, as its executions are read (write/program/staged.ts ExecutionPart). */
const partOf = (step: OwnStep): ExecutionPart => {
	switch (step.kind) {
		case "carrier":
			return step.step === "create" ? "create" : "fill"
		case "analyze":
			return "analyze"
		case "write":
		case "advance":
		case "check":
		case "single":
		case "family":
		case "familyWrite":
			return "statement"
	}
}

/** A generated field with no value an owner's fresh fill read, at the stratum whose owner it fills. */
interface FreshGeneratedNull extends GeneratedNull {
	readonly stratum: StratumAt
}

/** What a fresh fill leaves (`freshOwners`): each owner slot's facts and, by stratum and relation, each nested owner's
 * rows, every one with the counts and ends of its counted families as its stratum's appends to it draw them. */
interface FreshCounts {
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	readonly nested: ReadonlyMap<StratumAt, ReadonlyMap<StoredRelationName, ReadonlyArray<NestedRow>>>
}

/**
 * Each owner a stratum whose family statements run in the call's flight inserts (binding.ts FreshStratum), every row's
 * counts and ends drawn on the host by the filler from the stratum's own appended members naming it, its member slots'
 * facts and its nested rows (runtime/write/fill.ts filler): an owner it inserts is fresh, so those are its every member,
 * and the filler reads no stored row. Its own insert carries them, so every CHECK over them and every member's axes meet its final values:
 * an owner slot's facts, filled as the ChangeSet's own rows, and a nested owner's rows, filled where the walk stands
 * them (nesting.ts NestedLayout position), whose other columns the walk filled.
 */
const freshOwners = (
	ctx: FillContext,
	fill: Filler,
	fresh: ReadonlyArray<FreshStratum>,
	factsOf: (slot: ParamId) => NormalizedSlot,
	nestedOf: (stratum: StratumAt, relation: StoredRelationName) => ReadonlyArray<NestedRow>
): Result.Result<FreshCounts, EncodingFailure | FreshGeneratedNull> => {
	const slotsOut = new Map<ParamId, NormalizedSlot>()
	const nestedOut = new Map<StratumAt, Map<StoredRelationName, ReadonlyArray<NestedRow>>>()
	for (const { stratum: s, appended, counted: reached, owners } of fresh) {
		/** A relation's appended members' values: its slots' facts', then its nested rows'. */
		const membersOf = (
			relation: StoredRelationName
		): ReadonlyArray<ReadonlyMap<ColumnKey, unknown>> => [
			...appended.flatMap((a) =>
				a.relation === relation ? factsOf(a.slot).facts.map(valuesOfFact) : []
			),
			...nestedOf(s, relation).map((row) => row.values)
		]
		const counted = reached.filter((f) => membersOf(f.member).length > 0)
		/** Each counted family's appended members' values, by the group they name. */
		const byGroup = new Map(
			counted.map((f) => {
				const groups = new TupleMap<Owner, Array<ReadonlyMap<ColumnKey, unknown>>>()
				for (const values of membersOf(f.member)) {
					const group = groupOf(ctx, f, values)
					const list = groups.get(group) ?? []
					list.push(values)
					groups.set(group, list)
				}
				return [familyKey(f.id), groups] as const
			})
		)
		for (const owner of new Set(counted.map((f) => f.owner))) {
			const families = counted.filter((f) => f.owner === owner)
			/** The counts and ends the fill draws, which the owner's facts and rows carry at their starts. */
			const drawnNames = new Set(families.flatMap((f) => [f.count, ...f.ends]))
			const drawnKeys = new Set([...drawnNames].map(fieldKey))
			/** An owner's values with its counts and ends drawn from its appended members where it stands, or the fill's
			 * refusal. */
			const filledOf = (values: ReadonlyMap<ColumnKey, unknown>, position: FillAt) =>
				fill(
					{
						relation: owner,
						values: new Map([...values].filter(([key]) => !drawnKeys.has(key))),
						families: families.map((f) => ({
							family: f.id,
							members: (byGroup.get(familyKey(f.id))?.get(groupOfOwner(ctx, f, values)) ?? []).map(
								(m): HostNode => ({ relation: f.member, values: m, families: [] })
							)
						}))
					},
					position
				)
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
					const filled = filledOf(valuesOfFact(fact), { kind: "top" })
					if (!filled.ok) {
						return refused(filled.error.stop)
					}
					filledFacts.set(
						fact,
						Object.freeze(
							Object.fromEntries(
								Object.entries(fact).map(([name, v]) => [
									name,
									drawnNames.has(name) ? filled.value.values.get(fieldKey(name)) : v
								])
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
				for (const row of nestedOf(s, owner)) {
					const filled = filledOf(row.values, nested.position)
					if (!filled.ok) {
						return refused(filled.error.stop)
					}
					const drawn = filled.value.values
					rows.push({
						...row,
						values: new Map(
							[...row.values].map(
								([key, v]) => [key, drawnKeys.has(key) ? drawn.get(key) : v] as const
							)
						),
						fact: Object.freeze(
							Object.fromEntries(
								Object.entries(row.fact).map(([name, v]) => [
									name,
									drawnNames.has(name) ? drawn.get(fieldKey(name)) : v
								])
							)
						)
					})
				}
				const byRelation =
					nestedOut.get(s) ?? new Map<StoredRelationName, ReadonlyArray<NestedRow>>()
				byRelation.set(owner, rows)
				nestedOut.set(s, byRelation)
			}
		}
	}
	return Result.ok({ slots: slotsOut, nested: nestedOut })
}
