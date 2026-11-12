/**
 * What each statement of a write's flight is, as an application reads its rows: the step a statement realizes (a write
 * action's, a carrier's, a family statement's, a read-back's), the result its rows are read by, and the order of the
 * strata its statements belong to. The compiled artifact (write/program/artifact.ts) places the steps; an application
 * reads them from its loaded write (flight.ts), so nothing here reaches the compiler.
 */
import { indices, maxOf } from "#compiler/core/array.ts"
import type { TransientReason } from "#compiler/core/errors.ts"
import type { ConstraintName, EntryName, ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { RemovedTag } from "#compiler/runtime/write/net.ts"
import type { FamilyStatement } from "#compiler/write/family/order.ts"
import type { FamilySql } from "#compiler/write/family/statements.ts"
import type { FamilyPart } from "#compiler/write/family/written.ts"
import type {
	DeleteResult,
	InsertResult,
	SpanClassifyResult
} from "#compiler/write/insert/statement.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

/** A unique violation at a statement into `relation` that aborts the apply with a TransientFailure of `reason`: a
 * generated addition's own insert on a key holding its serial field, a MERGE insert at a key its put targets, or a
 * probed insert's 23505 or 23P01 on a unique object besides its arbiter, raised by an occupant its snapshot did not see. */
export interface UniqueAbort {
	readonly constraint: ConstraintName
	readonly relation: StoredRelationName
	readonly reason: Extract<
		TransientReason["_tag"],
		"GeneratedSerialUnique" | "PutTargetConflict" | "UnseenOccupant"
	>
}

/** The result of a write statement: rows of facts it made present or absent, or a span classification's, which raises
 * or returns no row. */
export type WriteStepResult = InsertResult | DeleteResult | PutResult | SpanClassifyResult

/** The tag of each fact a deletion's rows make absent: a delete member's, or the occupants a put displaced. */
export const removedTag = (result: DeleteResult): RemovedTag =>
	result.mode === "exact" ? "delete" : "displaced"

/**
 * What a carrier's statement casts into a stored relation's types: an action's member, which its fill writes into a
 * carrier typed by the action's relation's columns, so the fill casts the facts the action writes, a domain's CHECK
 * among the casts; nothing for a carrier's creation, a shared sub-query's fill, a snapshot or a delta.
 */
export type CarrierCasts =
	| { readonly kind: "member"; readonly relation: StoredRelationName; readonly stratum: StratumAt }
	| { readonly kind: "none" }

export type WriteStep =
	| {
			readonly kind: "write"
			readonly stratum: StratumAt
			/** The action's index in its stratum (ir.strata[stratum].actions). */
			readonly action: number
			readonly relation: StoredRelationName
			readonly result: WriteStepResult
			/** The enumerated input whose emptiness lets the runtime skip the statement, none for a statement of no
			 * enumerated input. */
			readonly skipWhenEmpty: ParamId | undefined
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }
	| {
			readonly kind: "carrier"
			readonly carrier: string
			readonly step: "create" | "fill"
			/** Its stratum, none for a carrier around the strata. */
			readonly stratum: StratumAt | undefined
			/** What its statement casts into a stored relation's types (CarrierCasts). */
			readonly casts: CarrierCasts
	  }
	| {
			readonly kind: "analyze"
			readonly carriers: ReadonlyArray<string>
			readonly stratum: StratumAt | undefined
	  }
	| {
			readonly kind: "advance"
			readonly stratum: StratumAt
			readonly action: number
			readonly relation: StoredRelationName
			readonly field: string
			readonly skipWhenEmpty: ParamId | undefined
	  }
	| { readonly kind: "readBack"; readonly name: string }
	| HoldStep
	| {
			readonly kind: "check"
			readonly stratum: StratumAt
			readonly entry: EntryName
			readonly skipWhenEmpty: ParamId | undefined
	  }
	| {
			readonly kind: "single"
			readonly stratum: StratumAt
			readonly parts: ReadonlyArray<WritePart>
			/** Every part's unique aborts: each part writes its own relation, so a violation names its part's constraint. */
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }
	| FamilyStep
	| FamilyWriteStep

/**
 * A retirable unit's hold of the groups a write states (write/hold/statement.ts), by its header: before the first
 * statement of the write that touches the unit, wherever that stands among the strata and the read-backs after them,
 * so it belongs to no stratum. Its one row carries nothing to decode, and a group it finds absent or retired is a
 * refusal the refusal function raises on the fence of the unit's first body.
 */
export interface HoldStep {
	readonly kind: "hold"
	readonly header: StoredRelationName
}

/**
 * A stratum's family additions or removals as one statement (write/family/additions.ts): its rows are each part's
 * behind the part's tag, as a single statement's are, each part's facts of its relation as its result says, a recount's
 * an owner's key, counts and ends after and before. It is sent once, and its violations are the family laws' natives,
 * which the installation's classifier names; it aborts nothing.
 */
export interface FamilyWriteStep {
	readonly kind: "familyWrite"
	readonly stratum: StratumAt
	readonly statement: "additions" | "removals"
	readonly parts: NonEmptyReadonlyArray<FamilyPart>
}

/**
 * The statements of one kind of one family of a stratum's nested writes (write/family/statements.ts): its text is
 * sent once per chunk of its plan's statements of that kind (write/family/order.ts plan), each chunk binding its own
 * arrays (bind.ts BoundWrite chunks), and its rows are every chunk's, in order. It writes `relation`, the family's
 * member, or its owner for a count, and its rows are facts as `result` says, as a write step's are. A chunk's violation
 * is a family law's native, which the installation's classifier names; it aborts nothing.
 */
export interface FamilyStep {
	readonly kind: "family"
	readonly stratum: StratumAt
	/** What its statements write: a member relation's rows, or a family's owners' counts. */
	readonly target:
		| { readonly kind: "rows"; readonly relation: StoredRelationName }
		| { readonly kind: "owners"; readonly family: FamilyId }
	readonly statement: FamilyStatement["kind"]
	/** The relation its rows are facts of: the member relation, or the counted family's owner. */
	readonly relation: StoredRelationName
	readonly result: FamilySql["result"]
}

/** One write action of a single statement: its step, whose rows are the statement's rows tagged with the part's index,
 * each the tag and then the step's `width` columns, the rest of the row padding. */
interface WritePart {
	readonly step: Extract<WriteStep, { readonly kind: "write" }>
	readonly width: number
}

/** What a statement's rows are read as: the relation they are facts of, and their result. */
export type RowsStep = Pick<Extract<WriteStep, { readonly kind: "write" }>, "relation" | "result">

/** The write steps a statement's rows are read as, each with its own rows: a write step's and a family step's are the
 * statement's, a single statement's parts' are its rows of their tag, cut to their width; no other step has rows the
 * outcome reads. */
export const writeRows = (
	step: WriteStep,
	rows: ReadonlyArray<ReadonlyArray<OutputText>>
): ReadonlyArray<{
	readonly step: RowsStep
	readonly rows: ReadonlyArray<ReadonlyArray<OutputText>>
	/** Whether its rows are owners' keys, counts and ends alone, a recount's, which the outcome tells apart by those
	 * columns only. */
	readonly counts: boolean
}> => {
	switch (step.kind) {
		case "write":
			return [{ step, rows, counts: false }]
		case "family":
			return [{ step, rows, counts: step.statement === "count" }]
		case "single":
			return step.parts.map((part, tag) => {
				const own = String(tag)
				return {
					step: part.step,
					rows: rows.flatMap((row) => (row[0] === own ? [row.slice(1, 1 + part.width)] : [])),
					counts: false
				}
			})
		case "familyWrite":
			return step.parts.map((part, tag) => {
				const own = String(tag)
				return {
					step: part,
					rows: rows.flatMap((row) => (row[0] === own ? [row.slice(1, 1 + part.width)] : [])),
					counts: part.rows === "counts"
				}
			})
		case "carrier":
		case "analyze":
		case "advance":
		case "readBack":
		case "check":
		case "hold":
			return []
	}
}

/** The step of a statement of the write program's own: every step but a read-back's. */
export type OwnStep = Exclude<WriteStep, { readonly kind: "readBack" }>

/** The stratum a step belongs to, none for a carrier around the strata, a read-back's statement and a hold. */
export const stratumOf = (step: WriteStep): StratumAt | undefined => {
	switch (step.kind) {
		case "readBack":
		case "hold":
			return undefined
		case "carrier":
		case "analyze":
			return step.stratum
		case "write":
		case "advance":
		case "check":
		case "single":
		case "family":
		case "familyWrite":
			return step.stratum
	}
}

/** Per stratum, up to the last any statement names, the statements in it, in their order. */
export const byStratum = <S extends { readonly step: WriteStep }>(
	statements: ReadonlyArray<S>
): ReadonlyArray<ReadonlyArray<S>> => {
	const placed = statements.flatMap((statement) => {
		const stratum = stratumOf(statement.step)
		return stratum === undefined ? [] : [{ stratum, statement }]
	})
	return indices(
		maxOf(
			placed.map((p) => p.stratum + 1),
			0
		)
	).map((s) => placed.filter((p) => p.stratum === s).map((p) => p.statement))
}
