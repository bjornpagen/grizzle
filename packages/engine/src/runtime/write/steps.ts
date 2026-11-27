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
import { always, type Needs } from "#compiler/ir/needs.ts"
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
 * among the casts; nothing for a shared sub-query's fill, a bound input's, a snapshot or a delta.
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
			 * neither the statement nor, in a single statement, its part. The flight's first statement also needs where a
			 * parameter it admits may hold a refused value, where no statement is sent there else
			 * (write/program/admission.ts): its rows are none there. */
			readonly needs: Needs
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }
	| {
			/**
			 * A carrier's fill (write/carriers/carriers.ts carrierStash): the transaction-local settings its columns
			 * travel in, written to its rows. No step makes or empties a carrier: a setting is the transaction's own.
			 */
			readonly kind: "carrier"
			readonly carrier: string
			/** Its stratum, none for a carrier around the strata. */
			readonly stratum: StratumAt | undefined
			/** What its statement casts into a stored relation's types (CarrierCasts). */
			readonly casts: CarrierCasts
	  }
	| { readonly kind: "readBack"; readonly name: string }
	| {
			readonly kind: "check"
			readonly stratum: StratumAt
			readonly entry: EntryName
			/** What the facts it checks need of the call's inputs: where they hold none, it is not sent. The flight's
			 * first statement's also needs its admission's, as a write's does. */
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
			return []
	}
}

/** The step of a statement of the write program's own: every step but a read-back's. */
export type OwnStep = Exclude<WriteStep, { readonly kind: "readBack" }>

/** The stratum a step belongs to, none for a carrier around the strata and a read-back's statement. */
const stratumOf = (step: WriteStep): StratumAt | undefined => {
	switch (step.kind) {
		case "readBack":
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
 * Where a call sends a statement of `step` sent whole: a write's or a check's where its needs hold over the call's
 * inputs (ir/needs.ts holds), any other's in every call. A single statement's is its units' (parted.ts sentUnits).
 */
export const sentWhere = (step: OwnStep): Needs => {
	switch (step.kind) {
		case "write":
		case "check":
			return step.needs
		case "carrier":
		case "single":
		case "familyWrite":
			return always
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
