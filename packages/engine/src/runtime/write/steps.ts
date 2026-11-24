/**
 * What each statement of a write's flight is, as an application reads its rows: the step a statement realizes (a write
 * action's, a carrier's, a family statement's, a read-back's), the result its rows are read by, and the order of the
 * strata its statements belong to. The compiled artifact (write/program/artifact.ts) places the steps; an application
 * reads them from its loaded write (flight.ts), so nothing here reaches the compiler.
 */
import { indices, maxOf } from "@bjornpagen/grizzle-text/base/array"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { TransientReason } from "#compiler/core/errors.ts"
import type { ConstraintName, EntryName, StoredRelationName } from "#compiler/core/ids.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Needs } from "#compiler/ir/needs.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { RemovedTag } from "#compiler/runtime/write/net.ts"
import type { FamilyPart } from "#compiler/write/family/written.ts"
import type { DeleteResult, InsertResult } from "#compiler/write/insert/statement.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

/** A unique violation at a statement into `relation` that aborts the apply with a TransientFailure of `reason`: a MERGE
 * insert at a key its put targets, or a probed insert's 23505 or 23P01 on a unique object besides its arbiter, raised by
 * an occupant its snapshot did not see. */
export interface UniqueAbort {
	readonly constraint: ConstraintName
	readonly relation: StoredRelationName
	readonly reason: Extract<TransientReason["_tag"], "PutTargetConflict" | "UnseenOccupant">
}

/** The result of a write statement: rows of facts it made present or absent. */
export type WriteStepResult = InsertResult | DeleteResult | PutResult

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
			/** What its rows need of the call's inputs (ir/needs.ts): where they hold no such fact, the runtime sends
			 * neither the statement nor, in a single statement, its part. */
			readonly needs: Needs
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }
	| {
			/**
			 * A carrier's statement: its emptying before a use fills it (`empty`, sql/ast.ts EmptyCarrier), or a fill.
			 * The carrier itself is made once in the session, by its stand-up (flight.ts StandUp), never by a step.
			 */
			readonly kind: "carrier"
			readonly carrier: string
			readonly step: "empty" | "fill"
			/** Its stratum, none for a carrier around the strata. */
			readonly stratum: StratumAt | undefined
			/** What its statement casts into a stored relation's types (CarrierCasts). */
			readonly casts: CarrierCasts
	  }
	| { readonly kind: "readBack"; readonly name: string }
	| AdmissionStep
	| {
			readonly kind: "check"
			readonly stratum: StratumAt
			readonly entry: EntryName
			/** What the facts it checks need of the call's inputs: where they hold none, it is not sent. */
			readonly needs: Needs
	  }
	| {
			readonly kind: "single"
			readonly stratum: StratumAt
			readonly parts: ReadonlyArray<WritePart>
			/** Every part's unique aborts: each part writes its own relation, so a violation names its part's constraint. */
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }
	| FamilyWriteStep

/**
/**
 * The admission of a write's caller parameters (write/admission/statement.ts): the first statement of its flight, before
 * every stratum, so PostgreSQL refuses a parameter outside its type as it binds it, before any statement of the write
 * runs. It belongs to no stratum, and its one row carries nothing to decode.
 */
export interface AdmissionStep {
	readonly kind: "admission"
}

/**
 * A stratum's family additions or removals as one statement (write/family/additions.ts, removals.ts), or its deletes of
 * whole units (write/delete/unit.ts): its rows are each part's
 * behind the part's tag, as a single statement's are, each part's facts of its relation as its result says, a recount's
 * an owner's key, counts and ends after and before. It is sent once, and its violations are the family laws' natives,
 * which the installation's classifier names; it aborts nothing.
 */
export interface FamilyWriteStep {
	readonly kind: "familyWrite"
	readonly stratum: StratumAt
	readonly statement: "additions" | "removals" | "unit"
	readonly parts: NonEmptyReadonlyArray<FamilyPart>
}

/** One write action of a single statement: its step, whose rows are the statement's rows tagged with the part's index,
 * each the tag and then the step's `width` columns, the rest of the row padding. */
interface WritePart {
	readonly step: Extract<WriteStep, { readonly kind: "write" }>
	readonly width: number
}

/** What a statement's rows are read as: the relation they are facts of, and their result. */
export type RowsStep = Pick<Extract<WriteStep, { readonly kind: "write" }>, "relation" | "result">

/** The write steps a statement's rows are read as, each with its own rows: a write step's are the statement's, a single
 * statement's and a family write's parts' are its rows of their tag, cut to their width; no other step has rows the
 * outcome reads. */
export const writeRows = (
	step: WriteStep,
	rows: ReadonlyArray<ReadonlyArray<OutputText>>
): ReadonlyArray<{
	readonly step: RowsStep
	readonly rows: ReadonlyArray<ReadonlyArray<OutputText>>
	/** What its rows are (FamilyPart `rows`): facts of its relation, or owners' keys, counts and ends alone, a
	 * recount's, which the outcome tells apart by those columns only. */
	readonly returned: FamilyPart["rows"]
}> => {
	switch (step.kind) {
		case "write":
			return [{ step, rows, returned: "facts" }]
		case "single":
			return step.parts.map((part, tag) => {
				const own = String(tag)
				return {
					step: part.step,
					rows: rows.flatMap((row) => (row[0] === own ? [row.slice(1, 1 + part.width)] : [])),
					returned: "facts"
				}
			})
		case "familyWrite":
			return step.parts.map((part, tag) => {
				const own = String(tag)
				return {
					step: part,
					rows: rows.flatMap((row) => (row[0] === own ? [row.slice(1, 1 + part.width)] : [])),
					returned: part.rows
				}
			})
		case "carrier":
		case "readBack":
		case "check":
		case "admission":
			return []
	}
}

/** The step of a statement of the write program's own: every step but a read-back's. */
export type OwnStep = Exclude<WriteStep, { readonly kind: "readBack" }>

/** The stratum a step belongs to, none for a carrier around the strata, a read-back's statement and the admission. */
const stratumOf = (step: WriteStep): StratumAt | undefined => {
	switch (step.kind) {
		case "readBack":
		case "admission":
			return undefined
		case "carrier":
		case "write":
		case "check":
		case "single":
		case "familyWrite":
			return step.stratum
	}
}

/**
 * What a step's statement reaches when it runs: stored state, a relation or carrier it reads or writes, a lock it
 * takes; or the call's parameters alone, the admission (write/admission/statement.ts), which
 * binds and checks them, reads no relation and writes nothing. A statement that reaches only parameters commutes with
 * every other transaction: the certifier reads no fact of it (program/isolation/certification.ts flightStatements), and
 * a race takes it as no step of its own (test/pg/isolation/support/race.ts callStatements).
 */
export type StepReach = "state" | "parameters"

/** What a step's statement reaches (StepReach), by its kind, so a new kind of step is classified where it is added. */
export const reachOf = (step: WriteStep): StepReach => {
	switch (step.kind) {
		case "admission":
			return "parameters"
		case "readBack":
		case "carrier":
		case "write":
		case "check":
		case "single":
		case "familyWrite":
			return "state"
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
