import type { GeneratedLaw } from "#compiler/analysis/theory/description.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	arrayTexts,
	type NormalizedRelation,
	parameterNormalizer,
	positionalColumns
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf, paramEncoder } from "#compiler/codec/scalar.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { type ReadonlyTupleMap, TupleMap, TupleSet } from "#compiler/core/tuple-map.ts"
import type { OutputText, Param, ParamText } from "#compiler/core/wire.ts"
import { type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import type { FamilyId, LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { LiteralBound, MessageBound, WriteSlot } from "#compiler/ir/products.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { RelationChoice } from "#compiler/lower/shapes/index.ts"
import { runsLargeForm } from "#compiler/lower/shapes/take/index.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { isIterable } from "#compiler/write/defined.ts"
import { compose, type RelationPlanAt, relationDepths } from "#compiler/write/family/compose.ts"
import { decodeChain, decodeRead } from "#compiler/write/family/decode.ts"
import {
	type MemberKey,
	type Owner,
	type Recount,
	type Row,
	rowTexts
} from "#compiler/write/family/draw.ts"
import {
	callerValues,
	countRows,
	type EditedTarget,
	type EditTarget,
	encodedWrite,
	type Fact,
	factKey,
	type FilledRow,
	type FillContext,
	foldRecounts,
	groupOf,
	groupOfOwner,
	keyOf,
	mergeStored,
	ownerGroup,
	ownersOf,
	planEdits,
	type ReadKeys,
	readKeys,
	recountValues,
	refillTree,
	type RelationChanges,
	type StoredFamily,
	type Values
} from "#compiler/write/family/edit.ts"
import {
	type ColumnKey,
	familyKey,
	fieldKey,
	filler,
	fillRefusal,
	type GeneratedNull,
	type HostNode,
	literalHost
} from "#compiler/write/family/fold.ts"
import {
	type NestedLayout,
	type NestedRow,
	rowOfValues,
	sentLayout
} from "#compiler/write/family/nesting.ts"
import {
	columnArray,
	typedColumnArray,
	type FamilyStatement,
	type OwnerWrite,
	type Phase,
	type Plan,
	planOwners,
	planRead,
	planRelation,
	textsOf,
	type Transport,
	type Unsendable
} from "#compiler/write/family/order.ts"
import { patternPositions } from "#compiler/write/family/pattern-order.ts"
import {
	cascade,
	changedColumns,
	copyState,
	dropRow,
	holdRow,
	type RowState,
	rowOf,
	rowsOf,
	writeRow
} from "#compiler/write/family/state.ts"
import {
	type ChainSql,
	endColumns,
	type ReadShape,
	type RowLayout,
	rowLayout
} from "#compiler/write/family/statements.ts"
import type { EnumeratedInput, MemberSlot, SlotGroup } from "#compiler/write/frontend/compile.ts"
import type { FamilyNode } from "#compiler/write/frontend/schedule.ts"
import { isCarried, type Proposal, proposalOf } from "#compiler/write/insert/statement.ts"
import {
	type MemberFacts,
	type NormalizedSlot,
	normalizeChangeSet,
	refilledSlot
} from "#compiler/write/normalize/normalize.ts"
import {
	type ArtifactStatement,
	type SentForm,
	sentForm,
	type WriteArtifact
} from "#compiler/write/program/artifact.ts"
import type { CompiledWrite, EditProgram, RefillProgram } from "#compiler/write/program/compile.ts"
import { keyWitness } from "#compiler/write/program/outcome.ts"
import {
	type FilledColumn,
	hostJudgement,
	type JudgedRow,
	type StatedRows
} from "#compiler/write/program/witness.ts"

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

/** A row of a nested write's family that no statement can carry even alone, as the family names it. */
export interface FamilyRowBound {
	readonly _tag: "FamilyRowBound"
	readonly family: Family
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
	/** The positions of each artifact the runtime may skip: their enumerated member holds no fact. */
	readonly skip: (artifact: WriteArtifact) => ReadonlySet<number>
	/** The form of a statement of an artifact this application sends (`sentForm`). */
	readonly form: (statement: ArtifactStatement) => SentForm
	/**
	 * The placeholder values of that form, each a text or a bytes or text column's binary array: none reads another
	 * statement's rows. A relation input's arrays are written once per statement, by the encoder its placeholders share.
	 */
	readonly values: (
		statement: ArtifactStatement
	) => Result.Result<ReadonlyArray<Param>, EncodingFailure | LiteralBound>
	/** How the application's statements reach the server: one flight, or a read flight first (`Flights`). */
	readonly flights: Flights
}

/**
 * The placeholder texts of each execution of a statement, in the order they are sent: one, its `values`, for every
 * statement but a family step's; a family step's, one per statement of its kind in its family's plan (write/family/
 * order.ts plan), each its rows' arrays, none when the application writes no row of that kind. Every execution sends
 * the statement's one text, and its rows are every execution's, in order. A row no statement carries even alone is its
 * family's FamilyRowBound, and a change an immutable owner's stored family refuses its CompileError (write/family/
 * edit.ts planEdits), before any write statement is sent: the read flight has found the stored groups.
 */
export type Chunks = (
	statement: ArtifactStatement
) => Result.Result<
	ReadonlyArray<ReadonlyArray<Param>>,
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
 * (write/family/fold.ts GeneratedNull): `invariant-rejected` on the field's law, witnessed as PostgreSQL's NOT NULL
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
 * states as that plan fills them (write/program/witness.ts StatedRows), which a refusal of one of them judges.
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
interface StratumFill {
	readonly recounts: ReadonlyMap<string, ReadonlyTupleMap<Owner, Recount>>
	readonly found: RowState
	readonly rows: RowState
}

/**
 * The plan an application's stated rows are judged at: its strata's fills, a stratum absent filling nothing, and
 * `drawn`, each owner slot as its insert carries the counts and ends the write draws into it, the plan's or, where the
 * stratum's family work is one additions statement, the fresh fill's; or none, before the plan is drawn or where it is
 * refused, when no write statement is sent.
 */
type Fill =
	| {
			readonly kind: "planned"
			readonly strata: ReadonlyMap<StratumAt, StratumFill>
			readonly drawn: (slot: ParamId) => NormalizedSlot | undefined
	  }
	| { readonly kind: "unplanned" }

/**
 * What a judged row's columns hold beyond the fields the ChangeSet states: nothing (`stated`); every column a nesting's
 * walk filled (`walk`); or the counts and ends the write draws into an owner's insert (`drawn`).
 */
type ColumnsSource = "stated" | "walk" | "drawn"

const unfilled: FilledColumn = Object.freeze({ kind: "unfilled" })

const unplannedFill: Fill = Object.freeze({ kind: "unplanned" })

/** The witness of a refusal no row the ChangeSet states is found breaking. */
const unreportedWitness: Witness = Object.freeze({ kind: "unreported" })

export type BindResult =
	| BoundWrite
	| {
			readonly kind: "invariant-rejected"
			readonly law: LawId
			readonly described: Law
			readonly witness: Witness
	  }
	| { readonly kind: "generated-rejected"; readonly rejection: GeneratedRejection }

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
	program: CompiledWrite,
	inputs: BindInputs
): Result.Result<BindResult, EncodingFailure | MessageBound | LiteralBound | CompileError> => {
	const { frontend, edits: programEdits } = program
	/** The declared parameters' values; each relation parameter's distinct fact count, which chooses the form of a
	 * statement whose take its rows bound (`sentForm`). */
	const counted: Array<{ readonly param: ParamId; readonly count: number }> = []
	/** Each relation parameter's input, normalized once for the application: the one set its count and every statement
	 * that binds it read. */
	const relationInputs = new Map<ParamId, NormalizedRelation>()
	const paramValue = (name: string): unknown => inputs.params[name]
	for (const decl of program.params) {
		const value = paramValue(decl.name)
		if (decl.kind === "relation") {
			const normalize = parameterNormalizer({
				relation: decl.name,
				slot: { kind: "slot", name: decl.name },
				columns: positionalColumns(decl.heading),
				codes: frontend.codes
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
		const text = paramEncoder(decl.type, decl.name, frontend.codes)(value)
		if (!text.ok) {
			return Result.err(text.error)
		}
	}
	const normalization = normalizeChangeSet(frontend, inputs.members, inputs.transport)
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
			law: normalized.law,
			described: normalized.described,
			witness: keyWitness(normalized.relation, normalized.values)
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
	const skip = (artifact: WriteArtifact): ReadonlySet<number> =>
		new Set(
			artifact.steps.flatMap((step, i) =>
				(step.kind === "write" || step.kind === "advance" || step.kind === "check") &&
				step.skipWhenEmpty !== undefined &&
				holdsNoFact(step.skipWhenEmpty)
					? [i]
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
		nestedRows: (stratum: StratumAt, relation: string) => ReadonlyArray<NestedRow>
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
				const layout = sentLayout(nestedAt(slot.stratum, slot.relation))
				return typedColumnArray(
					slot.relation,
					`column ${slot.part + 1}`,
					defined(
						[...layout.key, ...layout.columns][slot.part],
						"the sent layout's column a nested rows placeholder carries"
					).type,
					nestedRows(slot.stratum, slot.relation).map((row) =>
						defined(
							rowTexts(rowOfValues(frontend.codes, layout, row.values))[slot.part],
							"a nested row holds each column of its sent layout"
						)
					)
				)
			}
		}
	}
	/** Whether a choice runs its whole-relation form: the relation parameter it reads, counted above, holds more distinct
	 * facts than its threshold. Both forms deliver the same rows, so the count decides only which one is sent. */
	const runsLarge = (choice: RelationChoice): boolean =>
		counted.some((p) => p.param === choice.source.param && runsLargeForm(choice, p.count))
	const form = (statement: ArtifactStatement): SentForm => sentForm(statement, runsLarge)
	/** A statement's placeholder texts over `slotFacts`, each member slot's normal facts, and `nestedRows`, each stratum's
	 * nested rows of a relation. */
	const valuesOver =
		(
			slotFacts: (slot: ParamId) => NormalizedSlot,
			nestedRows: (stratum: StratumAt, relation: string) => ReadonlyArray<NestedRow>
		) =>
		(
			statement: ArtifactStatement
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
	const noRows: ReadonlyMap<string, ReadonlyTupleMap<MemberKey, NestedRow>> = new Map()
	/** Each relation's depth among the families, which orders a stratum's relations' statements. */
	const depthOf = relationDepths(frontend.laws.families)
	/** A member relation's row no statement carries even alone, as the first family it is a member of names it. */
	const rowBound = (relation: string, row: Unsendable): FamilyRowBound => ({
		_tag: "FamilyRowBound",
		family: defined(
			frontend.laws.families.find((f) => f.member.name === relation),
			`a family whose member is ${relation}, which a family write writes`
		),
		row
	})
	/** A stratum's nested rows planned, by relation: the rows its nested writes insert, each owner's counts and ends
	 * as its counted families' appends in the stratum left them, each row in its relation's row layout. */
	const nestedPlans = (
		stratum: StratumAt,
		nested: ReadonlyMap<string, ReadonlyTupleMap<MemberKey, NestedRow>>
	): Result.Result<ReadonlyArray<RelationPlanAt>, FamilyRowBound> => {
		const relations: Array<RelationPlanAt> = []
		for (const [relation, rows] of nested) {
			const layout = nestedLayout(stratum, relation)
			const info = defined(
				frontend.schema.relations.get(relation),
				`the stored relation ${relation}, a nested write's`
			)
			const inserts = new TupleMap<MemberKey, Row>()
			for (const [key, r] of rows) {
				inserts.set(key, rowOfValues(ctx.codes, layout, r.values))
			}
			const planned = planRelation(
				{
					relation,
					deletes: new TupleSet<MemberKey>(),
					refills: new TupleMap<MemberKey, Row>(),
					updates: new TupleMap<MemberKey, Row>(),
					inserts
				},
				inputs.transport,
				patternPositions(info, frontend.laws.natives, layout)
			)
			if (!planned.ok) {
				return Result.err(rowBound(relation, planned.error))
			}
			relations.push({ depth: depthOf(relation), plan: planned.value })
		}
		return Result.ok(relations)
	}
	const ctx: FillContext = { codes: frontend.codes, evaluate: frontend.evaluate }
	const factsAt = (slot: ParamId | undefined): ReadonlyArray<Fact> =>
		slot === undefined ? [] : factsOf(slot).facts
	/** The counted family whose count or end `column` of `relation`, its owner, is, with that field. */
	const ownedColumn = (
		relation: RelationInfo,
		column: ColumnKey
	): { readonly family: Family; readonly field: LawField } | undefined => {
		for (const family of frontend.laws.families) {
			if (family.owner.name !== relation.name || isSequence(family)) {
				continue
			}
			for (const field of [family.count, ...endColumns(family)]) {
				if (fieldKey(field.name) === column) {
					return { family, field }
				}
			}
		}
		return undefined
	}
	/** An owner's count or end of `family` while the family is empty: the count 0, each end at its start. */
	const emptyOf = (family: Family, field: LawField): FilledColumn => {
		if (field.name === family.count.name) {
			return { kind: "filled", value: 0n }
		}
		switch (field.writing.kind) {
			case "accumulated":
				return {
					kind: "filled",
					value: literalHost(carrierSpecOf(field.type, frontend.codes), field.writing.start)
				}
			case "caller":
			case "drawn":
			case "serial":
			case "generated":
				throw defect(
					`the end ${family.owner.name}.${field.name} of a counted family, an accumulated field`
				)
		}
	}
	/**
	 * What the stratum's reads found at the key of `relation`'s row `columns`, `key` its key's texts: `stored`, a row
	 * they found; `fresh`, none, the owner of a group a counted family of it recounts, which its read looked up
	 * (order.ts OwnerWrite); `unread`, a row no read looked up, which a stored row may hold.
	 */
	const foundAt = (
		at: StratumFill | undefined,
		relation: RelationInfo,
		columns: Values,
		key: MemberKey
	): "stored" | "fresh" | "unread" => {
		if (at === undefined) {
			return "unread"
		}
		if (rowOf(at.found, relation.name, key) !== undefined) {
			return "stored"
		}
		return frontend.laws.families.some(
			(f) =>
				f.owner.name === relation.name &&
				!isSequence(f) &&
				at.recounts.get(familyKey(f.id))?.has(groupOfOwner(ctx, f, columns)) === true
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
		fill: Fill,
		stratum: StratumAt,
		relation: RelationInfo,
		columns: Values,
		op: "insert" | "put" | "delete",
		key: MemberKey | undefined,
		source: ColumnsSource,
		proposal: Proposal
	): JudgedRow => {
		const stated = Object.freeze(
			Object.fromEntries(
				relation.fields.flatMap((f) => {
					const value = columns.get(fieldKey(f.name))
					return (f.writing.kind === "caller" || f.writing.kind === "serial") && value !== undefined
						? [[f.name, value] as const]
						: []
				})
			)
		)
		if (fill.kind === "unplanned" || key === undefined) {
			return { kind: "known", stated, filled: () => unfilled }
		}
		const at = fill.strata.get(stratum)
		const found = foundAt(at, relation, columns, key)
		const empty = found === "fresh" || (found === "unread" && op === "insert")
		return {
			kind: found === "unread" && proposal === "unstored" ? "ifFresh" : "known",
			stated,
			filled: (column) => {
				const owned = ownedColumn(relation, column)
				const recount =
					owned === undefined
						? undefined
						: at?.recounts
								.get(familyKey(owned.family.id))
								?.get(groupOfOwner(ctx, owned.family, columns))
				if (owned !== undefined && recount !== undefined) {
					return {
						kind: "filled",
						value: recountValues(owned.family, recount).get(owned.field.name)
					}
				}
				const held = at === undefined ? undefined : rowOf(at.rows, relation.name, key)
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
					return empty ? emptyOf(owned.family, owned.field) : unfilled
				}
				return source === "walk" && columns.has(column)
					? { kind: "filled", value: columns.get(column) }
					: unfilled
			}
		}
	}
	/** Which facts of a slot of `stratum` the statement that writes them proposes: its action's INSERT's, by the
	 * relation and serial class it inserts (insert/statement.ts proposalOf); every one for any other, a put's, a
	 * deletion's, or a family member's, which its family's statements write. */
	const proposalAt = (stratum: StratumAt, slot: ParamId): Proposal => {
		for (const action of frontend.ir.strata[stratum]?.actions ?? []) {
			if (action.source.kind !== "described" && action.source.slot === slot) {
				return action.op === "insert" ? proposalOf(action.info.relation, action.serial) : "every"
			}
		}
		return "every"
	}
	/**
	 * The rows the ChangeSet states as `fill` fills them (witness.ts StatedRows): a slot's facts, an owner slot's as its
	 * insert carries the counts and ends the write draws into it, a query entry's in its own words and none of its
	 * columns filled, since its fields are not its target's; and a stratum's nested rows, which their family's
	 * statements propose every one of.
	 */
	const statedRowsOf = (fill: Fill): StatedRows => ({
		slot: (group: SlotGroup, input: EnumeratedInput, slot: MemberSlot) => {
			const relation = group.relation
			if (group.facts.name !== relation.name) {
				return factsOf(slot.slot).facts.map((fact): JudgedRow => ({
					kind: "known",
					stated: fact,
					filled: () => unfilled
				}))
			}
			const drawn = fill.kind === "planned" ? fill.drawn(slot.slot) : undefined
			const facts = (drawn ?? factsOf(slot.slot)).facts
			const source: ColumnsSource =
				input.kind === "nested" ? "walk" : drawn === undefined ? "stated" : "drawn"
			const layout = rowLayout(relation, frontend.laws.families)
			const op = input.kind === "single" ? input.act.op : "insert"
			const proposal = proposalAt(group.stratum, slot.slot)
			return facts.map((fact) => {
				const columns = new Map(
					Object.entries(fact).map(([name, v]) => [fieldKey(name), v] as const)
				)
				const whole = relation.primaryFields.every((f) => columns.has(fieldKey(f.name)))
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
		},
		nested: (stratum: StratumAt, relation: RelationInfo) =>
			[...(normalized.nested.get(stratum)?.get(relation.name)?.values() ?? [])].map((row) =>
				judgedRow(fill, stratum, relation, row.values, "insert", row.key, "walk", "every")
			)
	})
	/** The facts a stratum may insert of `relation`, by every slot of its that inserts (`insertSlots`) but a generated
	 * addition's, whose key does not exist yet, so no member names it, and every row of it a nested write of the
	 * stratum fills, a tree's nodes and a sequence's members, with every column the walk drew. An owner among them is
	 * fresh only where the read finds none stored at its key (write/family/edit.ts planEdits). */
	const insertedOf = (stratum: StratumAt, relation: string): ReadonlyArray<Fact> => [
		...frontend.slots
			.filter((g) => g.stratum === stratum && g.relation.name === relation)
			.flatMap((g) => g.inputs.flatMap(insertSlots))
			.flatMap((slot) => factsOf(slot).facts),
		...[...(normalized.nested.get(stratum)?.get(relation)?.values() ?? [])].map((r) => r.fact)
	]
	/** An edit as one application binds it: its changes, its families' inserted owners, and each family's reads, by
	 * their positions in the read flight. */
	interface BoundEdit {
		readonly program: EditProgram
		readonly changes: RelationChanges
		readonly owners: (family: Family) => ReadonlyTupleMap<Owner, Values>
		readonly reads: ReadonlyArray<{
			readonly family: Family
			readonly shape: ReadShape
			readonly at: ReadonlyArray<number>
		}>
	}
	const reads: Array<ReadStatement> = []
	const edits: Array<BoundEdit> = []
	/** A read no statement carries even alone: the application cannot be sent, which every family step reports. */
	let unreadable: FamilyRowBound | undefined
	for (const editProgram of programEdits) {
		const { edit, target } = editProgram
		/** A member fact as the family planner reads it: the fields its caller states, never the counts and ends its slot
		 * carries for an owner the stratum's additions write in the flight, which the planner draws itself. */
		const stated = (fact: Fact): Fact =>
			Object.freeze(
				Object.fromEntries(
					Object.entries(fact).filter(([name]) =>
						target.relation.fields.some((f) => f.name === name && isCarried(f))
					)
				)
			)
		const changes: RelationChanges = {
			inserts: factsAt(edit.inserts).map(stated),
			puts: factsAt(edit.puts).map(stated),
			deletes: factsAt(edit.deletes),
			nested: [
				...(normalized.nested.get(edit.stratum)?.get(target.relation.name)?.values() ?? [])
			].map((r) => r.values)
		}
		const known = new Map<string, ReadonlyTupleMap<Owner, Values>>()
		const owners = (family: Family): ReadonlyTupleMap<Owner, Values> => {
			const id = familyKey(family.id)
			const had = known.get(id)
			if (had !== undefined) {
				return had
			}
			const found = ownersOf(ctx, family, insertedOf(edit.stratum, family.owner.name))
			known.set(id, found)
			return found
		}
		const familyReads: Array<BoundEdit["reads"][number]> = []
		for (const read of editProgram.reads) {
			const touched = readKeys(ctx, target, read.family, changes)
			const at: Array<number> = []
			if (touched !== undefined) {
				const parts = planRead(
					touched.keys,
					touched.groups,
					{ key: target.layout.key.length, group: read.family.group.length },
					inputs.transport
				)
				if (!parts.ok) {
					unreadable ??= rowBound(target.relation.name, parts.error)
				} else {
					for (const part of parts.value) {
						at.push(reads.length)
						reads.push({
							family: read.family.id,
							sql: read.sql.sql.text,
							params: [
								...readLiterals(target.relation.name, part.keys, target.layout.key.length),
								...readLiterals(target.relation.name, part.groups, read.family.group.length)
							]
						})
					}
				}
			}
			familyReads.push({ family: read.family, shape: read.sql.shape, at })
		}
		edits.push({ program: editProgram, changes, owners, reads: familyReads })
	}
	/** A refill as one application binds it: its program, and each of its reads with its positions in the read flight. */
	interface BoundRefill {
		readonly program: RefillProgram
		readonly reads: ReadonlyArray<{ readonly sql: ChainSql; readonly at: ReadonlyArray<number> }>
	}
	const refills: Array<BoundRefill> = []
	for (const refillProgram of program.refills) {
		const chainReads: Array<BoundRefill["reads"][number]> = []
		for (const [i, sql] of refillProgram.reads.entries()) {
			const read = defined(refillProgram.refill.reads[i], "a refill's read of each chain")
			const root = sql.root
			const keyed = ((): ReadKeys | undefined => {
				if (root.kind === "put") {
					const layout = rowLayout(root.relation, frontend.laws.families)
					const keys = factsOf(root.slot).facts.map((fact) => factKey(ctx, layout, fact))
					return keys.length === 0 ? undefined : { keys, groups: [] }
				}
				const bound = edits.find(
					(e) =>
						e.program.edit.stratum === refillProgram.stratum &&
						e.program.target.relation.name === root.family.member.name
				)
				return bound === undefined
					? undefined
					: readKeys(ctx, bound.program.target, root.family, bound.changes)
			})()
			const widths =
				root.kind === "put"
					? { key: root.relation.primaryFields.length, group: 0 }
					: { key: root.family.member.primaryFields.length, group: root.family.group.length }
			const relation = root.kind === "put" ? root.relation.name : root.family.member.name
			const at: Array<number> = []
			if (keyed !== undefined) {
				const parts = planRead(keyed.keys, keyed.groups, widths, inputs.transport)
				if (!parts.ok) {
					unreadable ??= rowBound(relation, parts.error)
				} else {
					for (const part of parts.value) {
						at.push(reads.length)
						reads.push({
							family: read.kind === "groups" ? read.groups.family.id : read.family.id,
							sql: sql.sql.text,
							params:
								root.kind === "put"
									? readLiterals(relation, part.keys, widths.key)
									: [
											...readLiterals(relation, part.keys, widths.key),
											...readLiterals(relation, part.groups, widths.group)
										]
						})
					}
				}
			}
			chainReads.push({ sql, at })
		}
		refills.push({ program: refillProgram, reads: chainReads })
	}
	/**
	 * A stratum's owner writes with every count of an owner the stratum inserts carried by the owner's own insert row
	 * instead of a count statement: a fresh owner's stored suffix is empty, so the filler knows its
	 * every member, and its insert row then states its final count and ends, which an immediate CHECK over them judges
	 * and every member's axes reference. `refilled` gathers each such owner's insert slot with its facts' counts and
	 * ends replaced (normalize.ts refilledSlot), and `nested` each such owner a nested write of the stratum fills, a
	 * tree's node or a sequence's member, its row's counts and ends replaced; an owner whose insert slot carries no
	 * counts keeps its count statement.
	 */
	const carried = (
		stratum: StratumAt,
		target: EditTarget,
		owners: ReadonlyArray<OwnerWrite>,
		refilled: Map<ParamId, NormalizedSlot>,
		nested: Map<string, TupleMap<MemberKey, NestedRow>>
	): ReadonlyArray<OwnerWrite> =>
		owners.flatMap((write) => {
			const family = defined(
				target.families.find((f) => familyKey(f.family.id) === familyKey(write.family)),
				"an edited relation's family"
			).family
			/** A refill keeps the slot's key check true only while no key reads the fields it draws: a count or an end a
			 * key holds keeps its count statement, which the key law judges at the statement. */
			const drawnFields = [family.count.name, ...endColumns(family).map((f) => f.name)]
			const keyed = family.owner.keyNames.some((k) =>
				k.fields.some((f) => drawnFields.includes(f.name))
			)
			const slots = keyed ? [] : ownerSlots(stratum, family.owner.name)
			const kept = new TupleMap<Owner, Recount>()
			for (const [group, recount] of write.recounts) {
				kept.set(group, recount)
			}
			for (const slot of slots) {
				const current = refilled.get(slot) ?? factsOf(slot)
				const inserted = ownersOf(ctx, family, current.facts)
				const byGroup = new TupleMap<Owner, ReadonlyMap<string, unknown>>()
				for (const [group, recount] of write.recounts) {
					if (!write.stored.has(group) && inserted.has(group)) {
						byGroup.set(group, recountValues(family, recount))
						kept.delete(group)
					}
				}
				if (byGroup.size > 0) {
					refilled.set(
						slot,
						refilledSlot(current, (fact) => {
							const drawnValues = byGroup.get(ownerGroup(ctx, family, fact))
							return drawnValues === undefined
								? fact
								: Object.fromEntries([...Object.entries(fact), ...drawnValues])
						})
					)
				}
			}
			const rows = keyed ? undefined : nested.get(family.owner.name)
			if (rows !== undefined) {
				for (const [key, row] of rows) {
					const group = ownerGroup(ctx, family, row.fact)
					const recount = kept.get(group)
					if (recount !== undefined && !write.stored.has(group)) {
						rows.set(key, recountedRow(family, row, recount))
						kept.delete(group)
					}
				}
			}
			return kept.size > 0 ? [{ family: write.family, recounts: kept, stored: write.stored }] : []
		})
	/** Where `relation` stands in a nested write of `stratum` that fills its rows (nesting.ts NestedLayout). */
	const nestedAt = (stratum: StratumAt, relation: string): NestedLayout => {
		for (const n of frontend.nested) {
			const at = n.stratum === stratum ? n.nesting.layouts.get(relation) : undefined
			if (at !== undefined) {
				return at
			}
		}
		throw defect(
			`the nested layout of ${relation}, a relation a nested write of stratum ${stratum} fills`
		)
	}
	/** The row layout of `relation`, whose rows a nested write of the stratum fills. */
	const nestedLayout = (stratum: StratumAt, relation: string): RowLayout => {
		for (const n of frontend.nested) {
			const at = n.stratum === stratum ? n.nesting.layouts.get(relation) : undefined
			if (at !== undefined) {
				return at.layout
			}
		}
		throw defect(`the row layout of ${relation}, a relation a nested write of the stratum fills`)
	}
	/** A nested owner's row with its count and ends of `family` replaced by its recount's. */
	const recountedRow = (family: Family, row: NestedRow, recount: Recount): NestedRow => {
		const recounted = recountValues(family, recount)
		const rowValues = new Map(row.values)
		for (const [name, value] of recounted) {
			rowValues.set(fieldKey(name), value)
		}
		const fact = Object.freeze(
			Object.fromEntries(
				Object.entries(row.fact).map(([name, v]) => [
					name,
					recounted.has(name) ? recounted.get(name) : v
				])
			)
		)
		return { identity: row.identity, key: row.key, values: rowValues, fact }
	}
	/** The slots of an owner relation in a stratum that carry its counts and ends: a plain insert's or an enumerated
	 * put's that starts them (frontend/compile.ts EnumeratedInput "single"), and a nested insert's. */
	const ownerSlots = (stratum: StratumAt, relation: string): ReadonlyArray<ParamId> =>
		frontend.slots
			.filter((g) => g.stratum === stratum && g.relation.name === relation)
			.flatMap((g) =>
				g.inputs.flatMap((input) =>
					(input.kind === "single" && input.act.op !== "delete" && input.starts.length > 0) ||
					input.kind === "nested"
						? [input.slot.slot]
						: []
				)
			)
	/**
	 * A generated field with no value a stratum's plan filled a row by (write/family/fold.ts GeneratedNull) as its
	 * write's refusal: the field's law, witnessed by the first row the ChangeSet states of its relation at `stratum`
	 * whose term has no value, as PostgreSQL's NOT NULL refusal of the statement writing them is (witness.ts
	 * hostJudgement); unreported where the ChangeSet writes no row of the relation.
	 */
	const generatedRejection = (stratum: StratumAt, stop: GeneratedNull): GeneratedRejection => {
		const relation = frontend.written.find((r) => r.name === stop.law.relation)
		const field = relation?.fields.find((f) => f.name === stop.law.field)
		return {
			_tag: "GeneratedRejection",
			law: stop.law,
			witness:
				relation === undefined || field === undefined
					? unreportedWitness
					: hostJudgement(
							frontend,
							statedRowsOf(unplannedFill),
							{ kind: "write", stratum, relations: [relation.name] },
							{ kind: "generated", table: relation.ident, column: field.column }
						).witness
		}
	}
	/** A plan's refusal as its write's: a generated field with no value as `generatedRejection`, any other as itself. */
	const planRefusal = (
		stratum: StratumAt,
		error: EncodingFailure | CompileError | GeneratedNull
	): EncodingFailure | CompileError | GeneratedRejection =>
		error._tag === "GeneratedNull" ? generatedRejection(stratum, error) : error
	/**
	 * Each stratum's plan from the reads' rows, one array of rows per read in order: its nested rows, and the rows of
	 * every relation its edits write or its refills rewrite, composed by depth with their counts.
	 *
	 * The stratum's rows are planned over one state (family/state.ts): every row its reads found, and the same rows as
	 * its changes leave them, a put's caller fields, every edit's and refill's rows and recounts, each owner axis's
	 * cascade. Each relation's edits and refills are planned against the state the others leave (edit.ts planEdits), a
	 * tree's refill draws its trees again (edit.ts refillTree), and the plan runs again over the state each plan leaves,
	 * once more than the relations and trees it plans, so every value drawn from another plan's is drawn from its final
	 * one: the changes reach one another only along the schema's families, which close no cycle a refill could not order
	 * (analysis/theory/refill.ts).
	 *
	 * Every planned statement is one the stratum's schedule placed a family statement for, which sends it: one the
	 * schedule did not place is a defect, never a statement left unsent.
	 */
	const planned = (
		rows: ReadonlyArray<Raw>
	): Result.Result<
		Planned,
		EncodingFailure | FamilyRowBound | CompileError | GeneratedRejection
	> => {
		const strata = [
			...new Set([
				...frontend.nested.flatMap((n) =>
					familyWrittenInFlight(frontend, n.stratum) ? [] : [n.stratum]
				),
				...edits.map((e) => e.program.edit.stratum),
				...refills.map((r) => r.program.stratum)
			])
		]
		const out = new Map<StratumAt, Plan>()
		const refilled = new Map<ParamId, NormalizedSlot>()
		const fills = new Map<StratumAt, StratumFill>()
		const families = frontend.laws.families
		for (const stratum of strata) {
			/** The stratum's nested rows but those an edit of their relation plans with its own changes. */
			const editedHere = new Set(
				edits
					.filter((e) => e.program.edit.stratum === stratum)
					.map((e) => e.program.target.relation.name)
			)
			const nested = new Map(
				[...(normalized.nested.get(stratum) ?? noRows)].flatMap(([relation, relationRows]) => {
					if (editedHere.has(relation)) {
						return []
					}
					const copy = new TupleMap<MemberKey, NestedRow>()
					for (const [key, row] of relationRows) {
						copy.set(key, row)
					}
					return [[relation, copy] as const]
				})
			)
			const refill = refills.find((r) => r.program.stratum === stratum)
			/** Every row the stratum's reads found, by relation and key. */
			const stored: RowState = new Map()
			/** Each family's stored suffixes, by family key, every read of it as one set. */
			const suffixes = new Map<string, StoredFamily>()
			/** An owner's key texts in its row layout's key order, from its group texts in the family's group order. */
			const ownerKey = (family: Family, owner: Owner): MemberKey =>
				mapNonEmpty(rowLayout(family.owner, families).key, (c) =>
					defined(
						owner[family.group.findIndex((g) => fieldKey(g.owner.name) === c.key)],
						`the owner's key field ${c.key} in its group`
					)
				)
			const holdFamily = (family: Family, read: StoredFamily): void => {
				suffixes.set(familyKey(family.id), mergeStored(suffixes.get(familyKey(family.id)), read))
				for (const g of read.groups.values()) {
					holdRow(
						stored,
						family.owner.name,
						keyOf(ctx, rowLayout(family.owner, families), g.owner),
						g.owner
					)
				}
				for (const m of read.members.values()) {
					holdRow(stored, family.member.name, m.key, m.values)
				}
			}
			const reading = edits.filter((e) => e.program.edit.stratum === stratum)
			for (const bound of reading) {
				for (const read of bound.reads) {
					const decoded = decodeRead(
						ctx,
						bound.program.target,
						read.family,
						read.shape,
						read.at.map((i) => defined(rows[i], `the rows of read ${i}`))
					)
					if (!decoded.ok) {
						return decoded
					}
					holdFamily(read.family, decoded.value)
				}
			}
			/** Each refilled tree's nodes its reads found whole, by family key. */
			const treeNodes = new Map<string, TupleSet<MemberKey>>()
			for (const read of refill?.reads ?? []) {
				const decoded = decodeChain(
					ctx,
					read.sql.shape,
					read.at.map((i) => defined(rows[i], `the rows of read ${i}`))
				)
				if (!decoded.ok) {
					return decoded
				}
				for (const row of decoded.value.rows) {
					holdRow(stored, row.relation, row.key, row.values)
				}
				const end = decoded.value.end
				switch (end.kind) {
					case "suffix":
						holdFamily(end.family, end.stored)
						break
					case "tree": {
						const keys = treeNodes.get(familyKey(end.family.id)) ?? new TupleSet<MemberKey>()
						for (const key of end.keys) {
							keys.add(key)
						}
						treeNodes.set(familyKey(end.family.id), keys)
						break
					}
					case "rows":
						break
				}
			}
			const refilledFamilies = new Set(
				(refill?.program.refill.closure.refills ?? []).map((l) => familyKey(l.id))
			)
			const trees = (refill?.program.refill.closure.refills ?? []).filter((l) =>
				isTreeOf(l, l.member.name)
			)
			/** Each relation the stratum edits or refills, as an edit's target, with its edit where it has one. */
			const units = [
				...reading.map((bound) => ({ target: bound.program.target, bound })),
				...(refill?.program.targets ?? [])
					.filter((target) => !editedHere.has(target.relation.name))
					.map((target) => ({ target, bound: undefined }))
			].toSorted((a, b) => depthOf(b.target.relation.name) - depthOf(a.target.relation.name))
			const current = copyState(stored)
			for (const read of refill?.program.reads ?? []) {
				const root = read.root
				if (root.kind === "put" && !families.some((f) => f.member.name === root.relation.name)) {
					const layout = rowLayout(root.relation, families)
					for (const fact of factsOf(root.slot).facts) {
						writeRow(
							current,
							root.relation,
							factKey(ctx, layout, fact),
							callerValues(root.relation, fact)
						)
					}
				}
			}
			const noChange: RelationChanges = { inserts: [], puts: [], deletes: [], nested: [] }
			/** The owners of `family` the stratum changes, by group texts, each with the columns it changes of it. */
			const changedOwners = (family: Family): ReadonlyTupleMap<Owner, Values> => {
				const layout = rowLayout(family.owner, families)
				const changed = new TupleMap<Owner, Values>()
				for (const [key, row] of rowsOf(current, family.owner.name)) {
					const was = rowOf(stored, family.owner.name, key)
					const delta = was === undefined ? new Map() : changedColumns(ctx, layout, was, row)
					if (delta.size > 0) {
						changed.set(groupOfOwner(ctx, family, row), delta)
					}
				}
				return changed
			}
			/** Each pass draws from what the one before left, so each unit's values are final one pass after every value it
			 * draws from is: the units and trees close no cycle a refill could not order (analysis/theory/refill.ts). */
			const passes = units.length + trees.length + 1
			let plannedUnits: ReadonlyArray<EditedTarget> = []
			for (let pass = 0; pass < passes; pass += 1) {
				cascade(ctx, families, depthOf, stored, current)
				const done: Array<EditedTarget> = []
				for (const { target, bound } of units) {
					const relation = target.relation
					const refreshed = target.families.some((f) =>
						refilledFamilies.has(familyKey(f.family.id))
					)
					const storedOf = new Map(
						target.families.flatMap(({ family }) => {
							const read = suffixes.get(familyKey(family.id))
							return read === undefined ? [] : [[familyKey(family.id), read] as const]
						})
					)
					const edited = planEdits(
						ctx,
						target,
						bound?.changes ?? noChange,
						storedOf,
						(family) => ({
							stated:
								bound?.owners(family) ??
								ownersOf(ctx, family, insertedOf(stratum, family.owner.name)),
							plain: !families.some((f) => f.member.name === family.owner.name),
							recounted: changedOwners(family)
						}),
						{
							current: refreshed
								? rowsOf(current, relation.name)
								: new TupleMap<MemberKey, Values>(),
							refilled: (family) => refilledFamilies.has(familyKey(family.id))
						}
					)
					if (!edited.ok) {
						return Result.err(planRefusal(stratum, edited.error))
					}
					done.push({ target, edited: edited.value })
					const written = edited.value.rows
					for (const key of written.deletes) {
						dropRow(current, relation.name, key)
					}
					for (const row of [
						...written.refills.values(),
						...written.updates.values(),
						...written.inserts.values()
					]) {
						holdRow(current, relation.name, row.key, row.values)
					}
					for (const write of edited.value.owners) {
						const family = defined(
							target.families.find((f) => familyKey(f.family.id) === familyKey(write.family)),
							"a planned relation's family"
						).family
						for (const recount of write.recounts.values()) {
							writeRow(
								current,
								family.owner,
								ownerKey(family, recount.owner),
								new Map(
									[...recountValues(family, recount)].map(
										([name, v]) => [fieldKey(name), v] as const
									)
								)
							)
						}
					}
				}
				for (const tree of trees) {
					const keys = [...(treeNodes.get(familyKey(tree.id)) ?? [])]
					const nodesOf = (state: RowState): ReadonlyTupleMap<MemberKey, Values> => {
						const nodes = new TupleMap<MemberKey, Values>()
						for (const key of keys) {
							const row = rowOf(state, tree.member.name, key)
							if (row !== undefined) {
								nodes.set(key, row)
							}
						}
						return nodes
					}
					const drawn = refillTree(ctx, tree, nodesOf(stored), nodesOf(current))
					if (!drawn.ok) {
						return Result.err(planRefusal(stratum, drawn.error))
					}
					for (const [key, node] of drawn.value) {
						holdRow(current, tree.member.name, key, node)
					}
				}
				plannedUnits = done
			}
			/** The rows of each relation a refill rewrites, by relation and key, each with every value as the stratum
			 * leaves it: an owner's count and ends among them, which its count statement then leaves out. A tree's nodes are
			 * every node whose values its refill changes. */
			const refillRows = new Map<string, TupleMap<MemberKey, FilledRow>>()
			for (const tree of trees) {
				const name = tree.member.name
				const layout = rowLayout(tree.member, families)
				const nodes = refillRows.get(name) ?? new TupleMap<MemberKey, FilledRow>()
				for (const key of treeNodes.get(familyKey(tree.id)) ?? []) {
					const was = rowOf(stored, name, key)
					const now = rowOf(current, name, key)
					if (
						was === undefined ||
						now === undefined ||
						changedColumns(ctx, layout, was, now).size === 0
					) {
						continue
					}
					nodes.set(key, { key: keyOf(ctx, layout, now), values: now })
				}
				refillRows.set(name, nodes)
			}
			const rewritten = plannedUnits.map(({ target, edited }): EditedTarget => {
				const name = target.relation.name
				const rewrites = new TupleMap<MemberKey, FilledRow>()
				for (const [key, row] of refillRows.get(name) ?? []) {
					rewrites.set(key, row)
				}
				for (const [key, row] of edited.rows.refills) {
					rewrites.set(key, {
						key: row.key,
						values: defined(rowOf(current, name, key), "a refilled row its plan holds in the state")
					})
				}
				refillRows.set(name, rewrites)
				return { target, edited: { ...edited, rows: { ...edited.rows, refills: rewrites } } }
			})
			const recounts = new Map<string, TupleMap<Owner, Recount>>()
			for (const { edited } of rewritten) {
				for (const write of edited.owners) {
					const into = recounts.get(familyKey(write.family)) ?? new TupleMap<Owner, Recount>()
					for (const [group, recount] of write.recounts) {
						into.set(group, recount)
					}
					recounts.set(familyKey(write.family), into)
				}
			}
			fills.set(stratum, { recounts, found: stored, rows: current })
			const editedPlans: Array<RelationPlanAt> = []
			const counts: Array<Phase<"count">> = []
			const planRows = (
				relation: RelationInfo,
				layout: RowLayout,
				write: Parameters<typeof encodedWrite>[2]
			): Result.Result<void, FamilyRowBound> => {
				const rowsPlan = planRelation(
					encodedWrite(ctx, layout, write),
					inputs.transport,
					patternPositions(relation, frontend.laws.natives, layout)
				)
				if (!rowsPlan.ok) {
					return Result.err(rowBound(relation.name, rowsPlan.error))
				}
				editedPlans.push({ depth: depthOf(relation.name), plan: rowsPlan.value })
				return Result.ok(undefined)
			}
			for (const [i, edited] of foldRecounts(rewritten).entries()) {
				const { target } = defined(rewritten[i], "a planned edit")
				const rowsPlanned = planRows(target.relation, target.layout, edited.rows)
				if (!rowsPlanned.ok) {
					return rowsPlanned
				}
				for (const owner of carried(stratum, target, edited.owners, refilled, nested)) {
					const family = defined(
						target.families.find((f) => familyKey(f.family.id) === familyKey(owner.family)),
						"an edited relation's family"
					).family
					const carriedByRefill =
						refillRows.get(family.owner.name) ?? new TupleMap<MemberKey, FilledRow>()
					const recounted = [...owner.recounts.values()].filter(
						(r) => !carriedByRefill.has(ownerKey(family, r.owner))
					)
					if (recounted.length === 0) {
						continue
					}
					const phase = planOwners(
						owner.family,
						countRows(ctx, family, recounted),
						inputs.transport
					)
					if (!phase.ok) {
						return Result.err(rowBound(target.relation.name, phase.error))
					}
					counts.push(phase.value)
				}
			}
			for (const tree of trees) {
				const nodes = refillRows.get(tree.member.name) ?? new TupleMap<MemberKey, FilledRow>()
				if (nodes.size === 0 || units.some((u) => u.target.relation.name === tree.member.name)) {
					continue
				}
				const rowsPlanned = planRows(tree.member, rowLayout(tree.member, families), {
					relation: tree.member.name,
					deletes: new TupleSet<MemberKey>(),
					refills: nodes,
					updates: new TupleMap<MemberKey, FilledRow>(),
					inserts: new TupleMap<MemberKey, FilledRow>()
				})
				if (!rowsPlanned.ok) {
					return rowsPlanned
				}
			}
			const relations = nestedPlans(stratum, nested)
			if (!relations.ok) {
				return relations
			}
			const plan = compose([...relations.value, ...editedPlans], counts)
			const placed = defined(frontend.ir.strata[stratum], "a planned stratum").family
			const unsent = plan.flat().find((s) => !placed.some(({ node }) => placedFor(node, s)))
			if (unsent !== undefined) {
				throw defect(
					`a planned ${unsent.kind} of ${unsent.kind === "count" ? `${unsent.family.owner}.${unsent.family.count}` : unsent.relation} in stratum ${stratum}, which no family statement the schedule placed sends`
				)
			}
			out.set(stratum, plan)
		}
		return Result.ok({ plans: out, slots: refilled, fills })
	}
	/**
	 * A planned statement's arrays: its rows' cells, column by column (order.ts columnArray), each literal within the
	 * longest string, each bytes value copied once into its column's binary array, a value its caller changed since
	 * admission refused there.
	 */
	const arraysOf = (
		relation: string,
		statement: FamilyStatement
	): Result.Result<ReadonlyArray<Param>, LiteralBound | EncodingFailure> => {
		const rows = textsOf(statement)
		const width = rows[0]?.length ?? 0
		const arrays: Array<Param> = []
		for (let i = 0; i < width; i += 1) {
			const array = columnArray(
				relation,
				`column ${i + 1}`,
				rows.map((row) => defined(row[i], "a family statement's row holds each of its columns"))
			)
			if (!array.ok) {
				return array
			}
			arrays.push(array.value)
		}
		return Result.ok(arrays)
	}
	/** The chunks of the artifact's statements under the strata's plans: a family step's, one execution per planned
	 * statement of its kind and target; any other's, its one execution. */
	const chunksOf = (
		plans: Result.Result<Planned, EncodingFailure | FamilyRowBound | CompileError>
	): Chunks => {
		const own = valuesOver(
			(slot) =>
				plans.ok
					? (plans.value.slots.get(slot) ?? fresh.get(slot) ?? factsOf(slot))
					: (fresh.get(slot) ?? factsOf(slot)),
			nestedRowsOf
		)
		return (statement) => {
			const step = statement.step
			if (step.kind !== "family") {
				return Result.map(own(statement), (one) => [one])
			}
			if (!plans.ok) {
				return plans
			}
			const target = step.target
			const sent: ReadonlyArray<FamilyStatement> = defined(
				plans.value.plans.get(step.stratum),
				`the plan of stratum ${step.stratum}, which a family statement the schedule placed sends`
			)
				.flat()
				.filter(
					(s) =>
						s.kind === step.statement &&
						(s.kind === "count"
							? target.kind === "owners" && familyKey(s.family) === familyKey(target.family)
							: target.kind === "rows" && s.relation === target.relation)
				)
			const out: Array<ReadonlyArray<Param>> = []
			for (const s of sent) {
				const arrays = arraysOf(step.relation, s)
				if (!arrays.ok) {
					return arrays
				}
				out.push(arrays.value)
			}
			return Result.ok(out)
		}
	}
	/** The write statements under a plan: their chunks, and the stated rows as the plan fills them, none where it is
	 * refused, which sends no write statement. */
	const writtenOf = (
		plans: Result.Result<Planned, EncodingFailure | FamilyRowBound | CompileError>
	): PlanWrites => ({
		chunks: chunksOf(plans),
		stated: statedRowsOf(
			plans.ok
				? {
						kind: "planned",
						strata: plans.value.fills,
						drawn: (slot) => plans.value.slots.get(slot) ?? fresh.get(slot)
					}
				: unplannedFill
		)
	})
	/** The flights of a write that reads nothing, planned now: refused where its plan fills a generated field with no
	 * value, before any statement. */
	const unreadFlights = (): Result.Result<Flights, GeneratedRejection> => {
		const plans = planned([])
		if (plans.ok) {
			return Result.ok({ kind: "write", ...writtenOf(plans) })
		}
		if (plans.error._tag === "GeneratedRejection") {
			return Result.err(plans.error)
		}
		return Result.ok({ kind: "write", ...writtenOf(Result.err(plans.error)) })
	}
	/**
	 * Each owner slot of a stratum whose family work is one additions statement (write/family/additions.ts), its facts'
	 * counts and ends of each counted family the stratum appends to as the stratum's own appends to the owner draw them,
	 * the owner fresh (`freshOwners`). An owner stored at the fact's key is the insert's exact repeat or its conflict,
	 * which the insert proposes nothing of (insert/statement.ts Proposal), so its stored families are the statement's to
	 * draw.
	 */
	const nestedRowsOf = (stratum: StratumAt, relation: string): ReadonlyArray<NestedRow> => [
		...(normalized.nested.get(stratum)?.get(relation)?.values() ?? [])
	]
	const freshlyCounted = freshOwners(frontend, (slot) => factsOf(slot), ownerSlots, nestedRowsOf)
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
	const fresh = freshlyCounted.value
	const flown: Result.Result<Flights, GeneratedRejection> =
		unreadable !== undefined
			? Result.ok({ kind: "write", ...writtenOf(Result.err(unreadable)) })
			: isNonEmpty(reads)
				? Result.ok({
						kind: "read",
						reads,
						writes: (rows) => {
							const plans = planned(rows)
							return plans.ok ? Result.ok(writtenOf(plans)) : plans
						}
					})
				: unreadFlights()
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

/** A read's keys as its placeholders carry them: one array literal per key field, each within the longest string. The
 * read was cut to its transport (order.ts planRead), so every literal fits. */
const readLiterals = (
	relation: string,
	keys: ReadonlyArray<ReadonlyArray<ParamText>>,
	width: number
): ReadonlyArray<ParamText> => {
	const literals = arrayTexts(
		relation,
		Array.from({ length: width }, (_, i) => `key ${i + 1}`),
		keys,
		maxStringLength.value
	)
	if (!literals.ok) {
		throw defect("a read cut to its transport carries every literal it writes")
	}
	return literals.value
}

/** The slots of an enumerated input whose facts may insert their keys: an insert's, a put's (whose insert half inserts
 * each fact no row holds the key of), a nested insert's, and a classed insert's complete one. */
const insertSlots = (input: EnumeratedInput): ReadonlyArray<ParamId> => {
	switch (input.kind) {
		case "single":
			return input.act.op === "delete" ? [] : [input.slot.slot]
		case "nested":
			return [input.slot.slot]
		case "classed":
			return [input.complete.slot]
	}
}

/** Whether a family statement the schedule placed sends a planned one: the count of its family, or the statement of its
 * kind of its member relation. */
const placedFor = (node: FamilyNode, statement: FamilyStatement): boolean =>
	statement.kind === "count"
		? node.kind === "owners" && familyKey(node.family) === familyKey(statement.family)
		: node.kind === "rows" &&
			node.statement === statement.kind &&
			node.relation === statement.relation

/** Each stratum's plan, each owner insert slot whose facts carry the counts and ends its members' appends draw, and
 * what each stratum's plan leaves (`StratumFill`). */
interface Planned {
	readonly plans: ReadonlyMap<StratumAt, Plan>
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	readonly fills: ReadonlyMap<StratumAt, StratumFill>
}

/** A generated field with no value an owner's fresh fill read, at the stratum whose owner it fills. */
interface FreshGeneratedNull extends GeneratedNull {
	readonly stratum: StratumAt
}

/** Whether a stratum's family statements are its additions and removals, computed in SQL within the call's flight
 * (write/family/additions.ts, removals.ts), rather than planned on the host from a read flight. */
const familyWrittenInFlight = (frontend: CompiledWrite["frontend"], stratum: StratumAt): boolean =>
	defined(frontend.ir.strata[stratum], "a stratum").family.some(
		({ node }) => node.kind === "additions" || node.kind === "removals"
	)

/**
 * Each owner slot of a stratum written in the flight (`familyWrittenInFlight`), every fact's counts and ends drawn on
 * the host by the filler from the stratum's own appended members naming it, its member slots' facts and its nested rows
 * (write/family/fold.ts filler): an owner it inserts is fresh, so those are its every member, and the filler reads no
 * stored row. The owner's own insert carries them, so every CHECK over them and every member's axes meet its final
 * values. An owner among the nested rows is drawn by the additions statement that inserts it (write/family/
 * additions.ts).
 */
const freshOwners = (
	frontend: CompiledWrite["frontend"],
	factsOf: (slot: ParamId) => NormalizedSlot,
	ownerSlots: (stratum: StratumAt, relation: string) => ReadonlyArray<ParamId>,
	nestedOf: (stratum: StratumAt, relation: string) => ReadonlyArray<NestedRow>
): Result.Result<ReadonlyMap<ParamId, NormalizedSlot>, EncodingFailure | FreshGeneratedNull> => {
	const slotsOut = new Map<ParamId, NormalizedSlot>()
	const ctx: FillContext = { codes: frontend.codes, evaluate: frontend.evaluate }
	const fill = filler(frontend.laws.theory.fill, frontend.codes, frontend.evaluate)
	for (const [s] of strataAt(frontend.ir.strata)) {
		if (!familyWrittenInFlight(frontend, s)) {
			continue
		}
		const appended = frontend.edits.flatMap((e) =>
			e.stratum === s
				? [e.inserts, e.puts].flatMap((slot) =>
						slot === undefined ? [] : [{ relation: e.relation.name, slot }]
					)
				: []
		)
		/** A relation's appended members' values: its slots' facts', then its nested rows'. */
		const membersOf = (relation: string): ReadonlyArray<ReadonlyMap<ColumnKey, unknown>> => [
			...appended.flatMap((a) =>
				a.relation === relation ? factsOf(a.slot).facts.map(factValues) : []
			),
			...nestedOf(s, relation).map((row) => row.values)
		]
		const counted = frontend.laws.families.filter(
			(f) => !isSequence(f) && membersOf(f.member.name).length > 0
		)
		/** Each counted family's appended members' values, by the group they name. */
		const byGroup = new Map(
			counted.map((f) => {
				const groups = new TupleMap<Owner, Array<ReadonlyMap<ColumnKey, unknown>>>()
				for (const values of membersOf(f.member.name)) {
					const group = groupOf(ctx, f, values)
					const list = groups.get(group) ?? []
					list.push(values)
					groups.set(group, list)
				}
				return [familyKey(f.id), groups] as const
			})
		)
		for (const owner of new Set(counted.map((f) => f.owner.name))) {
			const families = counted.filter((f) => f.owner.name === owner)
			/** The counts and ends the fill draws, which the owner's facts and rows carry at their starts. */
			const drawnNames = new Set(
				families.flatMap((f) => [f.count.name, ...endColumns(f).map((e) => e.name)])
			)
			/** An owner's values with its counts and ends drawn from its appended members, or the fill's refusal. */
			const filledOf = (values: ReadonlyMap<ColumnKey, unknown>) =>
				fill({
					relation: owner,
					values: new Map(
						[...values].filter(([key]) => ![...drawnNames].some((name) => fieldKey(name) === key))
					),
					families: families.map((f) => ({
						family: f.id,
						members: (byGroup.get(familyKey(f.id))?.get(groupOfOwner(ctx, f, values)) ?? []).map(
							(m): HostNode => ({ relation: f.member.name, values: m, families: [] })
						)
					}))
				})
			const refused = (stop: Parameters<typeof fillRefusal>[0]) => {
				const refusal = fillRefusal(stop, slotPlace(owner))
				return refusal._tag === "GeneratedNull"
					? Result.err({ ...refusal, stratum: s })
					: Result.err(refusal)
			}
			for (const slot of ownerSlots(s, owner)) {
				const current = factsOf(slot)
				const filledFacts = new Map<Fact, Fact>()
				for (const fact of current.facts) {
					const filled = filledOf(factValues(fact))
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
		}
	}
	return Result.ok(slotsOut)
}

/** A fact's values by column key. */
const factValues = (fact: Fact): ReadonlyMap<ColumnKey, unknown> =>
	new Map(Object.entries(fact).map(([name, v]) => [fieldKey(name), v] as const))
