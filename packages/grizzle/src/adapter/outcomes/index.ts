import { Array as Arr, Option } from "effect"
import {
	type ApplyError,
	ExecutionFailure,
	serializationRefusal,
	TransientFailure,
	transientReason
} from "#adapter/errors/execution.ts"
import type { ServerError } from "#adapter/errors/failures.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { ViolationClassifier } from "#adapter/witness/classify.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import type { RelationCounts } from "#compiler/write/delta/net.ts"
import type { UniqueAbort } from "#compiler/write/program/artifact.ts"

/**
 * Mapping what a write transaction's statements and its COMMIT reported onto grizzle's outcomes and errors.
 *
 * Two kinds of result leave a write transaction, and they stay distinct:
 *
 * - an outcome value: `accepted` or `no-change`, with counts and reads, released only after COMMIT succeeded;
 *   `invariant-rejected` with the law it broke (types/changeset Law) and its witness, or `outside-world` naming
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
 *   violations: a 23000 from a residual law's function is `invariant-rejected` with that law and the key its DETAIL
 *   lists in DetailCodec; any other violation of class 23 (23505 on
 *   a non-arbiter UNIQUE, 23503 on a foreign key, 23514 on a CHECK, a contract domain or a text refinement domain,
 *   23P01 on a span key) is `invariant-rejected` with the law its constraint name maps to through the installation's
 *   key-law map, its witness `unreported`, because a native violation reports its key only in its message.
 *   The law model's map (laws/model constraintToLaw) is part of the installation's, which adds the constraints
 *   installer extensions name, such as span storage.
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
	| { readonly kind: "rejected"; readonly law: Law; readonly witness: Witness }
	| { readonly kind: "outside"; readonly relation: string }
	| { readonly kind: "failed"; readonly error: ApplyError }

interface ClassifyContext {
	/** The installation's decoder of integrity violations (packages/grizzle/src/adapter/witness installationWitness), the layer's. */
	readonly violation: ViolationClassifier
	/**
	 * The unique violations that are aborts at the statement that failed: none at COMMIT, where every unique constraint
	 * is immediate and has already been checked, and none at a read-back or a refresh, which writes no unique object.
	 */
	readonly uniqueAborts: ReadonlyArray<UniqueAbort>
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
	const transient = transientFailureOf(failure, context.uniqueAborts)
	if (transient !== undefined) {
		return { kind: "failed", error: transient }
	}
	const violation = context.violation(failure)
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
	}
}

/** The public counts of a WriteProgram's netted outcome: one entry per written relation, in code point order. */
type PublicCounts = Extract<ApplyOutcome<unknown>, { readonly kind: "accepted" }>["counts"]

const publicCounts = (counts: ReadonlyArray<RelationCounts>): PublicCounts =>
	Object.freeze(
		Arr.map(counts, (c) =>
			Object.freeze({ relation: c.relation, added: c.added, deleted: c.deleted, put: c.put })
		)
	)

/** The outcome value of a committed application, its read-backs the record the reads decoder assembled. */
export const committedOutcome = <R>(
	kind: "accepted" | "no-change",
	counts: ReadonlyArray<RelationCounts>,
	reads: R
): ApplyOutcome<R> =>
	kind === "accepted"
		? Object.freeze({ kind, counts: publicCounts(counts), reads })
		: Object.freeze({ kind, reads })

/** The outcome value of a rejected application. */
export const rejectedOutcome = <R>(law: Law, witness: Witness): ApplyOutcome<R> =>
	Object.freeze({ kind: "invariant-rejected", law, witness })

/** The outcome value of an application a query entry refused: a fact its addition requested is outside the entry. */
export const outsideOutcome = <R>(relation: string): ApplyOutcome<R> =>
	Object.freeze({ kind: "outside-world", relation })
