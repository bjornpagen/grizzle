import { Option } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"

/**
 * How an operation under measurement ended, by cause, for the contention gates' lock waits, deadlock rate and
 * transient failure rate by reason.
 *
 * The cause is read from the SQLSTATE PostgreSQL answered with, never from prose or a driver's "retryable" flag:
 * - serialization (40001) and deadlock (40P01) are transient; which failures an operation retries is grizzle's own
 *   classification of a TransientFailure, which load.ts applies (packages/grizzle/src/adapter/outcomes transientFailureOf);
 * - a residual law function raises integrity_constraint_violation (23000) with the law's identity as the constraint
 *   name at COMMIT;
 * - the native constraints keep their own classes: unique (23505), foreign key (23503), check (23514), exclusion
 *   (23P01), not null (23502);
 * - anything else is `other`, with its SQLSTATE kept.
 */
const outcomeCauses = [
	"serialization",
	"deadlock",
	"lawViolation",
	"uniqueViolation",
	"foreignKeyViolation",
	"checkViolation",
	"exclusionViolation",
	"notNullViolation",
	"other"
] as const

export type OutcomeCause = (typeof outcomeCauses)[number]

/**
 * The SQLSTATEs with a cause of their own: grizzle's law refusal, the transient ones grizzle classifies, and the native
 * constraints'. not_null_violation (23502) is no condition grizzle branches on, so it is spelled here.
 */
const causeBySqlstate: ReadonlyMap<string, Exclude<OutcomeCause, "other">> = new Map([
	[sqlstates.serializationFailure, "serialization"],
	[sqlstates.deadlockDetected, "deadlock"],
	[sqlstates.integrityConstraintViolation, "lawViolation"],
	[sqlstates.uniqueViolation, "uniqueViolation"],
	[sqlstates.foreignKeyViolation, "foreignKeyViolation"],
	[sqlstates.checkViolation, "checkViolation"],
	[sqlstates.exclusionViolation, "exclusionViolation"],
	["23502", "notNullViolation"]
])

export const causeOf = (sqlstate: string): OutcomeCause => causeBySqlstate.get(sqlstate) ?? "other"

/** The constraint PostgreSQL named in the error, or none. */
export type Constraint =
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "none" }

/**
 * A failure, by where in a transaction it was raised: at BEGIN, at a statement (by its label), at the deferred checks
 * forced before COMMIT, or by COMMIT itself.
 */
export type FailedOutcome =
	| {
			readonly kind: "failed"
			readonly at: "statement"
			readonly statement: string
			readonly sqlstate: string
			readonly cause: OutcomeCause
			readonly constraint: Constraint
	  }
	| {
			readonly kind: "failed"
			readonly at: "begin" | "deferredChecks" | "commit"
			readonly sqlstate: string
			readonly cause: OutcomeCause
			readonly constraint: Constraint
	  }

export type Outcome =
	| { readonly kind: "committed" }
	| { readonly kind: "rolledBack" }
	| FailedOutcome

const fieldsOf = (
	error: unknown
): Option.Option<{
	readonly sqlstate: string
	readonly cause: OutcomeCause
	readonly constraint: Constraint
}> =>
	Option.map(Option.fromUndefinedOr(pgErrorFields(error)), (fields) => ({
		sqlstate: fields.code,
		cause: causeOf(fields.code),
		constraint: Option.match(Option.fromUndefinedOr(fields.constraint), {
			onNone: (): Constraint => ({ kind: "none" }),
			onSome: (name): Constraint => ({ kind: "named", name })
		})
	}))

/**
 * The failed outcome of `error` raised at the statement labelled `statement`, or none when it carries no PostgreSQL
 * error (a transport failure, which a measurement treats as a defect rather than a sample).
 */
export const failedAtStatement = (
	error: unknown,
	statement: string
): Option.Option<FailedOutcome> =>
	Option.map(fieldsOf(error), (fields): FailedOutcome => ({
		kind: "failed",
		at: "statement",
		statement,
		...fields
	}))

/** The failed outcome of `error` raised at `at`, or none when it carries no PostgreSQL error. */
export const failedAt = (
	error: unknown,
	at: "begin" | "deferredChecks" | "commit"
): Option.Option<FailedOutcome> =>
	Option.map(fieldsOf(error), (fields): FailedOutcome => ({ kind: "failed", at, ...fields }))

/** An outcome's key in a tally: `committed`, `rolledBack`, or the failure's cause. */
export type OutcomeKey = "committed" | "rolledBack" | OutcomeCause

export const outcomeKey = (outcome: Outcome): OutcomeKey =>
	outcome.kind === "failed" ? outcome.cause : outcome.kind
