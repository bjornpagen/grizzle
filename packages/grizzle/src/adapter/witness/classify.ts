import type { ServerError } from "#adapter/errors/failures.ts"
import { type KeyLaws, reportedOwner } from "#adapter/witness/keylaw.ts"
import { sqlstateClass, sqlstates } from "#compiler/core/sqlstate.ts"
import type { DescribedLaw } from "#compiler/physical/install/compile.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import type { KeyDecoder } from "#compiler/write/program/outcome.ts"
import {
	type ConcurrentChange,
	type LawDetail,
	readChangeDetail,
	readLawDetail
} from "#compiler/write/refusal.ts"

/**
 * The ErrorResponse fields a violation is classified by: the identity fields PostgreSQL reports and grizzle controls
 * (errors/failures.ts ServerError, whose message the classifier never reads), each undefined when the server did not
 * report it. `detail` is read only from a law function or a write statement's refusal.
 */
type ViolationFields = Pick<
	ServerError,
	"sqlstate" | "constraint" | "schema" | "table" | "dataType" | "detail"
>

/**
 * Classifying one integrity violation or write refusal PostgreSQL reported into the law it broke, as an outcome names
 * it (types/changeset Law), and its witness, or a concurrent change.
 *
 * The witness of `invariant-rejected` is built only from fields grizzle controls, for a statement or a COMMIT that
 * PostgreSQL refused, in the cases decided here:
 *
 * - SQLSTATE 23000 raised by a write statement's refusal (write/refusal.ts): the law's identifier as the constraint
 *   name and the DETAIL `k[...]`, the refused fact's relation with its values at the law's key fields, each the text of
 *   its column's result codec. The constraint must be a law of this installation; each key text converts through its
 *   column's codec, so the `key` witness carries the key values as the host types them.
 * - SQLSTATE 23000 from a residual law's function. It raises with the law's identifier as its constraint name and
 *   a DETAIL in DetailCodec listing the violating fact's key columns only, its `key` witness, or withholding them when
 *   the raising role does not hold the violating relation whole, its `withheld` witness (laws/model/detail.ts). The constraint
 *   must be a residual law of this installation: the DETAIL is converted through that law's own codec, which only a
 *   residual law has (write/program/outcome.ts witnessDecoder), never through a codec chosen by the DETAIL's shape, and
 *   each key text through its column's result codec. The two DETAILs are told
 *   apart by their tag, never by the law: one law can raise both (a capacity of at most one is a partial unique index a
 *   write statement probes and a residual existence law).
 * - SQLSTATE 40Z01 raised by a write statement that met a concurrent change: the DETAIL `a[...]` names the
 *   TransientFailure reason and the relation, one of this installation's, and the outcome is that TransientFailure.
 * - SQLSTATE 42Z01 raised by a query entry's precheck (write/entry/precheck.ts): the entry's name as the constraint name.
 *   The outcome is `outside-world` for that entry, which carries no value.
 * - Any other class 23 SQLSTATE on a native constraint (23505 a key or a partial UNIQUE index, 23503 a foreign key,
 *   23514 a table CHECK or a domain constraint, 23P01 a span key) reports the law its constraint name maps to under
 *   the owner PostgreSQL reports it on, the table, or the data type of a domain constraint, through the key-law map
 *   (keylaw.ts). The map holds native objects only, each under its table or domain, and a law function reports no
 *   owner, so a native violation is read under its owner alone. PostgreSQL states the violating key of a native
 *   violation only in its message and DETAIL prose, which for a CHECK holds the whole failing row, so the witness is
 *   `unreported`: the classifier reads neither.
 *
 * Every DETAIL read here is grizzle's own text, raised by grizzle's own statement or law function, but it is the
 * database's answer: one the installation's encoding does not read is never a guess at a law or a reason, it is the
 * operational failure below.
 *
 * Everything else is not a law outcome, and the classifier answers `undefined` for the caller to map onto an
 * operational failure (an ExecutionFailure carrying the server's report): a SQLSTATE outside class 23, a violation
 * without a constraint name, a constraint no law of this installation names under the reported owner, a violation
 * reported in another schema than the installation's, a 23000 whose constraint is not a law the DETAIL's encoding
 * admits, and a DETAIL this installation's encoding does not read: none where one is raised, or one naming a relation,
 * field, law or reason that is not the installation's. Among the SQLSTATEs outside class 23 is the 21Z01 a read-back
 * statement raises when an attachment breaks the delivered type its evidence proved (write/refusal.ts): the database's
 * answer contradicting a proof, before COMMIT, so the write commits nothing and fails with the server's report, as a
 * read fails with it (wire/batch.ts asReadFailure). Aborts PostgreSQL raises itself (40001, 40P01, a unique violation
 * the failing statement lists as an abort) are decided before this classifier is consulted
 * (packages/grizzle/src/adapter/outcomes transientFailureOf).
 *
 * The classifier is the hook the transaction outcome mapping consumes (packages/grizzle/src/adapter/outcomes classifyServerError, whose
 * context every write entry fills from the layer's witness, packages/grizzle/src/adapter/apply/compile.ts): its answers are exactly that
 * mapping's `rejected` and `aborted` cases (ViolationClassifier), and `undefined` is its ExecutionFailure.
 *
 * A violation's meaning as a law outcome, a fact outside a query entry, or a concurrent change a write statement met.
 */
export type Violation =
	| { readonly kind: "rejected"; readonly law: Law; readonly witness: Witness }
	| { readonly kind: "outside"; readonly relation: string }
	| { readonly kind: "aborted"; readonly reason: ConcurrentChange }

/** The hook: a violation's law outcome, or undefined when it is not one. */
export type ViolationClassifier = (failure: ViolationFields) => Violation | undefined

/** The witness of a violation whose key PostgreSQL states only in its message. */
const unreportedWitness: Witness = Object.freeze({ kind: "unreported" })

/**
 * The rejection of `law` by a write statement's refusal, from its DETAIL; undefined when the DETAIL names a relation,
 * field or key value that is not this installation's.
 */
const refusalRejection = (
	law: DescribedLaw,
	refusal: Extract<LawDetail, { readonly kind: "law" }>,
	decoder: KeyDecoder
): Violation | undefined => {
	const witness = decoder.fromRefusal(refusal.relation, refusal.key)
	return witness === undefined ? undefined : { kind: "rejected", law: law.described, witness }
}

/**
 * The rejection of a residual law from its function's DetailCodec DETAIL: its key, or `withheld` when the law function
 * withheld it from a role that does not hold the violating relation whole; undefined when `law` has no function, whose
 * codec the decoder reads the DETAIL through, or for a DETAIL that codec does not read.
 */
const residualRejection = (
	law: DescribedLaw,
	detail: string,
	decoder: KeyDecoder
): Violation | undefined => {
	const witness = decoder.fromDetail(detail, law.law)
	return witness === undefined ? undefined : { kind: "rejected", law: law.described, witness }
}

/**
 * A concurrent change a write statement raised: its reason, at a relation of this installation; undefined for a DETAIL
 * that names no reason a write statement raises, or none.
 */
const concurrentChange = (detail: string | undefined): Violation | undefined => {
	const read = detail === undefined ? undefined : readChangeDetail(detail)
	return read === undefined
		? undefined
		: { kind: "aborted", reason: { _tag: read.reason, relation: read.relation } }
}

/** The classifier of one installation's violations (see the header). */
export const violationClassifier =
	(laws: KeyLaws, decoder: KeyDecoder): ViolationClassifier =>
	(failure) => {
		if (failure.sqlstate === sqlstates.grizzleConcurrentChange) {
			return concurrentChange(failure.detail)
		}
		if (failure.sqlstate === sqlstates.grizzleOutsideWorld) {
			return failure.constraint === undefined
				? undefined
				: { kind: "outside", relation: failure.constraint }
		}
		if (sqlstateClass(failure.sqlstate) !== sqlstateClass(sqlstates.integrityConstraintViolation)) {
			return undefined
		}
		const constraint = failure.constraint
		if (constraint === undefined) {
			return undefined
		}
		if (failure.schema !== undefined && failure.schema !== laws.schema) {
			return undefined
		}
		if (failure.sqlstate === sqlstates.integrityConstraintViolation) {
			const law = laws.raised.get(constraint)
			const detail = failure.detail
			if (law === undefined || detail === undefined) {
				return undefined
			}
			/** A write statement's refusal, by its DETAIL's tag; any other DETAIL is a law function's. */
			const refusal = readLawDetail(detail)
			switch (refusal.kind) {
				case "lawFunction":
					return residualRejection(law, detail, decoder)
				case "law":
					return refusalRejection(law, refusal, decoder)
			}
		}
		/**
		 * The reported table or data type names an object of the installation only when the reported schema is the
		 * installation's.
		 */
		const owner = reportedOwner(failure, laws.schema)
		if (owner === undefined) {
			return undefined
		}
		const native = laws.lawOf(constraint, owner)
		if (native === undefined) {
			return undefined
		}
		return { kind: "rejected", law: native.described, witness: unreportedWitness }
	}
