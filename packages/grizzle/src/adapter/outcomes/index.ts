import { Array as Arr, Option } from "effect"
import {
	type ApplyError,
	ExecutionFailure,
	serializationRefusal,
	TransientFailure,
	transientReason
} from "#adapter/errors/execution.ts"
import type { ServerError } from "#adapter/errors/failures.ts"
import type { ApplyOutcome, ApplyOutcomeConstructor } from "#adapter/types/db.ts"
import {
	rosterDomainDefect,
	type ViolationClassifier,
	type WrittenAt
} from "#adapter/witness/classify.ts"
import {
	type FamilyId,
	outcomeKind,
	type Refused,
	type StatementAt,
	type UniqueAbort,
	type Witness,
	type WriteStep
} from "#compiler/plan/change.ts"
import { sqlstates } from "#compiler/plan/common.ts"

/**
 * Mapping what a write transaction's statements and its COMMIT reported onto grizzle's outcomes and errors.
 *
 * Two kinds of result leave a write transaction, and they stay distinct:
 *
 * - an outcome value: `accepted` or `no-change`, with counts and reads, released only after COMMIT succeeded;
 *   `invariant-rejected` with the laws it broke, decided as types/changeset Refused says, and its witness, or `outside-world` naming
 *   the query entry an addition wrote outside of, each reported only after the failing transaction rolled back;
 * - a failure in the error channel: TransientFailure when a concurrent transaction's work met the transaction, the
 *   one retryable error, or an operational failure: EncodingFailure, TransportFailure, ExecutionFailure, or
 *   CommitUnknown.
 *
 * The mapping reads only fields grizzle controls, never PostgreSQL's message or DETAIL prose; a failure the server
 * raised carries its whole report as given (errors/failures.ts ServerError). No outcome but the changes is read from
 * rows: a write statement that detects a refusal raises it (write/refusal.ts), so every refusal
 * arrives as a server error and the transaction is already aborted when the client learns of it.
 *
 * - Refusals a write statement raises: 23000 with a law's identity and a `k` DETAIL, a conflict, a same-key pair or a
 *   unique object's refusal, is `invariant-rejected` with that law and the refused key; 42Z01, a query entry's precheck,
 *   is `outside-world` for the entry it names; 40Z01 with an `a` DETAIL, a concurrent change the statement met, is the
 *   TransientFailure of the reason it names (PutTargetConflict, SpanKeyChange). The installation's violation classifier
 *   converts them (packages/grizzle/src/adapter/witness). A query entry's precheck raises a key a fact outside the entry holds the same
 *   way, on that key's law at the submitted key (write/entry/precheck.ts), so an insert through an entry meets no fact
 *   its role cannot see: a 42501 there is a privilege refusal, an ExecutionFailure like any other.
 * - SQLSTATEs (`transientFailureOf`): 40001 and 40P01 are a TransientFailure; so is a 23505 or 23P01 on a constraint the
 *   failing statement lists as an abort (a generated addition's serial key, a MERGE insert at its put target, a unique
 *   object besides the arbiter, which after the probe only an unseen occupant raises). Every other server error goes
 *   to the installation's violation classifier (packages/grizzle/src/adapter/witness), the one reader of integrity
 *   violations: a violation of class 23 (23505 on a non-arbiter UNIQUE, 23503 on a foreign key, 23514 on a CHECK, a
 *   contract domain or a text refinement domain, 23P01 on a span key) is `invariant-rejected` with the laws its
 *   constraint name maps to through the installation's
 *   key-law map, narrowed by the relations the failing statement writes where a shared domain's columns decide them,
 *   and a 23502 on a generated column the generated field's law; a native violation reports its key only in its
 *   message, so its witness is the host's, the key of a fact the ChangeSet states for the failing statement that breaks
 *   it (write/program/witness.ts hostJudgement), or `unreported` where it states none.
 *   The law model's map (laws/model constraintToLaw) is part of the installation's, which adds the constraints
 *   installer extensions name, such as span storage.
 * - A 23514 on one of the installation's roster domains, a code domain or a bits domain, is grizzle's own defect:
 *   grizzle's codec writes only live handles, which those domains admit, so no statement of grizzle's raises it, and
 *   the classifier claims it as no law. The write dies with the defect, which names where in the flight it was raised,
 *   the domain, and the codes the domain admits.
 * - Anything else is never a law outcome: whatever the classifier does not claim (an integrity violation on a constraint
 *   no law names under its owner, or in another schema, and a DETAIL of grizzle's own the installation's encoding does
 *   not read, none where one is raised among them), and every other SQLSTATE (a partial operation's data exception, a
 *   privilege refusal), is ExecutionFailure with the report; a lost connection before COMMIT was sent is
 *   TransportFailure{stage: "transport"}, a driver failure TransportFailure{stage: "driver"}; a codec's refusal of a
 *   parameter is its EncodingFailure. A result text is PostgreSQL's own output and is converted without a check, so it
 *   never fails: a defect stays a defect (apply/run.ts).
 *
 * The driver's own "retryable" flag is never read, and a COMMIT whose outcome is unknown is CommitUnknown, never a
 * TransientFailure. The outcome values are the public ApplyOutcome's (types/db.ts), their read-backs the records the
 * applied ChangeSet's reads decoder assembles.
 */

/** What one failed statement, or a refused COMMIT, means. */
export type Classified =
	| {
			readonly kind: "rejected"
			readonly refused: Refused
			readonly witness: Witness
	  }
	| { readonly kind: "outside"; readonly relation: string }
	| { readonly kind: "failed"; readonly error: ApplyError }
	| { readonly kind: "defect"; readonly defect: Error }

/**
 * Where in a write's flights the server raised what is classified, by its statement's index across them: a family's
 * read of its stored members, which a write whose plan reads sends first, in a flight of its own in the same
 * transaction; the write statement at `index`, an execution of its step, a family step's chunk; a read-back statement,
 * which follows the write statements; or the COMMIT.
 */
export type FailureOrigin =
	| { readonly kind: "read"; readonly index: number; readonly family: FamilyId }
	| {
			readonly kind: "statement"
			readonly index: number
			readonly step: WriteStep
			/** Which execution of its step it is: 0 for a step sent once, a family step's chunk in its plan's order. */
			readonly chunk: number
	  }
	| { readonly kind: "readBack"; readonly index: number }
	| { readonly kind: "commit" }

interface ClassifyContext {
	/** The installation's decoder of integrity violations (packages/grizzle/src/adapter/witness installationWitness), the layer's. */
	readonly violation: ViolationClassifier
	readonly origin: FailureOrigin
	/**
	 * What a statement wrote, as the classifier reads it: the stored relations it writes or casts into
	 * (write/program/witness.ts statementRelations), and the host's witness of a native refusal at it, over the facts
	 * the application's ChangeSet states for it (hostWitness).
	 */
	readonly statement: (at: StatementAt) => WrittenAt
}

/**
 * The unique violations that are aborts at `origin`: a write statement's own, a single statement's parts'; none at a
 * family's statement, whose additions recount each stored group's owner before they insert at the indexes they draw
 * (write/family/additions.ts), so a concurrent writer of the group meets the owner's row first and fails with 40001, at
 * a flight's other statements, which write no unique object, at a read-back, and at COMMIT, where every unique
 * constraint is immediate and has already been checked.
 */
const uniqueAbortsAt = (origin: FailureOrigin): ReadonlyArray<UniqueAbort> => {
	if (origin.kind !== "statement") {
		return []
	}
	const step = origin.step
	return step.kind === "write" || step.kind === "single" ? step.uniqueAborts : []
}

/** A statement that states no fact the ChangeSet states. */
const unstated: StatementAt = Object.freeze({ kind: "unstated" })

/**
 * What the statement at `origin` states, as the host reads it: a write statement's action, a single statement's parts'
 * actions, at its stratum; a family statement's relation; the fill of an action's member's carrier, which casts the
 * facts the action writes into its relation's types (CarrierCasts); a query entry's precheck, which casts the entry's
 * facts into its target's types; nothing for another carrier's statement, an ANALYZE or a serial advance, a read-back,
 * a family's stored-suffix read, or the COMMIT.
 */
const statementAt = (origin: FailureOrigin): StatementAt => {
	if (origin.kind !== "statement") {
		return unstated
	}
	const step = origin.step
	switch (step.kind) {
		case "write":
			return { kind: "actions", stratum: step.stratum, actions: [step.action] }
		case "single":
			return {
				kind: "actions",
				stratum: step.stratum,
				actions: Arr.map(step.parts, (p) => p.step.action)
			}
		case "family":
			return { kind: "write", stratum: step.stratum, relations: [step.relation] }
		case "familyWrite":
			return {
				kind: "write",
				stratum: step.stratum,
				relations: Arr.dedupe(Arr.map(step.parts, (p) => p.relation))
			}
		case "check":
			return { kind: "precheck", stratum: step.stratum, entry: step.entry }
		case "carrier":
			return step.casts.kind === "member"
				? { kind: "write", stratum: step.casts.stratum, relations: [step.casts.relation] }
				: unstated
		case "analyze":
		case "advance":
		case "readBack":
			return unstated
	}
}

/** What the statement at `origin` wrote, as the classifier reads it (WrittenAt). */
const writtenAt = (context: ClassifyContext): WrittenAt =>
	context.statement(statementAt(context.origin))

/** What a write's step does, as a defect names the statement that raised it. */
const stepText = (step: WriteStep): string => {
	switch (step.kind) {
		case "write":
			return `a write of ${step.relation}`
		case "single":
			return `a single statement writing ${Arr.join(
				Arr.map(step.parts, (p) => p.step.relation),
				", "
			)}`
		case "carrier":
			return `the ${step.step} of carrier ${step.carrier}`
		case "analyze":
			return `the ANALYZE of ${Arr.join(step.carriers, ", ")}`
		case "advance":
			return `the serial advance of ${step.relation}.${step.field}`
		case "readBack":
			return `read-back ${step.name}`
		case "check":
			return `the precheck of entry ${step.entry}`
		case "family":
			return `a family's ${step.statement} of ${step.relation}`
		case "familyWrite":
			return `the family ${step.statement} writing ${Arr.join(
				Arr.dedupe(Arr.map(step.parts, (p) => p.relation)),
				", "
			)}`
	}
}

/** Where `origin` is in its flight, as a defect names it. */
const originText = (origin: FailureOrigin): string => {
	switch (origin.kind) {
		case "read":
			return `the write's statement ${origin.index}, the stored-suffix read of family ${origin.family.owner}.${origin.family.count}`
		case "statement":
			return `the write's statement ${origin.index}, ${stepText(origin.step)}${origin.chunk === 0 ? "" : ` (its execution ${origin.chunk + 1})`}`
		case "readBack":
			return `the write's statement ${origin.index}, a read-back`
		case "commit":
			return "the COMMIT"
	}
}

/**
 * The TransientFailure of a server error, or undefined when it is none: 40001 and 40P01 anywhere, and a unique
 * violation on a constraint the failing statement lists in `uniqueAborts`.
 */
export const transientFailureOf = (
	failure: ServerError,
	uniqueAborts: ReadonlyArray<UniqueAbort>
): TransientFailure | undefined => {
	const serialization = serializationRefusal(failure)
	if (serialization !== undefined) {
		return serialization
	}
	if (
		failure.sqlstate !== sqlstates.uniqueViolation &&
		failure.sqlstate !== sqlstates.exclusionViolation
	) {
		return undefined
	}
	const found = Arr.findFirst(uniqueAborts, (u) => u.constraint === failure.constraint)
	if (Option.isNone(found)) {
		return undefined
	}
	const rule = found.value
	return new TransientFailure({
		reason: transientReason(
			rule.reason === "PutTargetConflict"
				? { _tag: rule.reason, relation: rule.relation }
				: { _tag: rule.reason, relation: rule.relation, constraint: rule.constraint }
		),
		error: failure
	})
}

/**
 * A server error's meaning (see the header): an abort first, then the classifier's law outcome, and otherwise an
 * operational failure.
 */
export const classifyServerError = (failure: ServerError, context: ClassifyContext): Classified => {
	const transient = transientFailureOf(failure, uniqueAbortsAt(context.origin))
	if (transient !== undefined) {
		return { kind: "failed", error: transient }
	}
	const violation = context.violation(failure, writtenAt(context))
	if (violation === undefined) {
		return { kind: "failed", error: new ExecutionFailure({ reason: failure }) }
	}
	switch (violation.kind) {
		case "rejected":
		case "outside":
			return violation
		case "aborted":
			return {
				kind: "failed",
				error: new TransientFailure({ reason: transientReason(violation.reason), error: failure })
			}
		case "defect":
			return { kind: "defect", defect: rosterDomainDefect(violation, originText(context.origin)) }
	}
}

/** The public counts of a WriteProgram's netted outcome: one entry per written relation, in code point order. */
type PublicCounts = Extract<ApplyOutcome<unknown>, { readonly kind: "accepted" }>["counts"]

/** Each entry's counts, as the outcome holds them: its relation and its three counts, frozen. */
const publicCounts = (counts: PublicCounts): PublicCounts =>
	Object.freeze(
		Arr.map(counts, (c) =>
			Object.freeze({ relation: c.relation, added: c.added, deleted: c.deleted, put: c.put })
		)
	)

/**
 * The outcome values, each frozen, built only here: a committed application's, its kind following its counts
 * (delta/net.ts outcomeKind) and its read-backs the record the reads decoder assembled; a rejected application's; and
 * one a query entry refused. The public barrel exports them as ApplyOutcome (public/db.ts).
 */
export const applyOutcome: ApplyOutcomeConstructor = {
	committed: (counts, reads) =>
		outcomeKind(counts) === "accepted"
			? Object.freeze({ kind: "accepted", counts: publicCounts(counts), reads })
			: Object.freeze({ kind: "no-change", reads }),
	invariantRejected: (refused, witness) =>
		Object.freeze({ kind: "invariant-rejected", refused, witness }),
	outsideWorld: (relation) => Object.freeze({ kind: "outside-world", relation })
}
