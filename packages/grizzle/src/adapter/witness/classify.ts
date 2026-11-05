import { Array as Arr } from "effect"
import type { ServerError } from "#adapter/errors/failures.ts"
import {
	type KeyLaws,
	type NativeLaws,
	type RosterDomain,
	reportedOwner
} from "#adapter/witness/keylaw.ts"
import type { DomainName, RelationIdent } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { sqlstateClass, sqlstates } from "#compiler/core/sqlstate.ts"
import { jsonText } from "#compiler/core/trusted.ts"
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
 * report it. `detail` is read only from a write statement's refusal.
 */
type ViolationFields = Pick<
	ServerError,
	"sqlstate" | "constraint" | "schema" | "table" | "dataType" | "detail"
>

/**
 * Classifying one integrity violation or write refusal PostgreSQL reported into the laws it broke, as an outcome names
 * them (types/changeset Law), and its witness, or a concurrent change.
 *
 * The witness of `invariant-rejected` is built only from fields grizzle controls, for a statement or a COMMIT that
 * PostgreSQL refused, in the cases decided here:
 *
 * - SQLSTATE 23000 raised by a write statement's refusal (write/refusal.ts): the law's identifier as the constraint
 *   name and the DETAIL `k[...]`, the refused fact's relation with its values at the law's key fields, each the text of
 *   its column's result codec. The constraint must be a law of this installation; each key text converts through its
 *   column's codec, so the `key` witness carries the key values as the host types them.
 * - SQLSTATE 40Z01 raised by a write statement that met a concurrent change: the DETAIL `a[...]` names the
 *   TransientFailure reason and the relation, one of this installation's, and the outcome is that TransientFailure.
 * - SQLSTATE 42Z01 raised by a query entry's precheck (write/entry/precheck.ts): the entry's name as the constraint name.
 *   The outcome is `outside-world` for that entry, which carries no value.
 * - SQLSTATE 23514 on one of the installation's roster domains, the data type PostgreSQL reports: a roster's code
 *   domain admits exactly its live handles' codes, its bits domain exactly the sets of them, and grizzle's codec
 *   writes only live handles, so no statement grizzle sends can raise it. It is grizzle's own defect, never a law
 *   outcome: the domains are the codes' range proof and discharge no law, and a law over closed relations is a table
 *   CHECK named by its law on its table, which the next case reads.
 * - Any other class 23 SQLSTATE on a native constraint (23505 a key or a partial UNIQUE index, 23503 a foreign key,
 *   23514 a table CHECK, a contract's domain or a text refinement domain, 23P01 a span key) reports the laws its
 *   constraint name maps to under the owner PostgreSQL reports it on, the table, or the data type of a domain
 *   constraint, through the key-law map (keylaw.ts). The map holds native objects only, each under its table or
 *   domain, so a native violation is read under its owner alone. PostgreSQL
 *   states the violating key of a native violation only in its message and DETAIL prose, which for a CHECK holds the
 *   whole failing row with each value cut at 64 bytes, so the witness is `unreported`: the classifier reads neither.
 *   The outcome names exactly the laws the violation breaks wherever what grizzle controls decides them, and every law
 *   the violated object discharges where it cannot:
 *   - one law, for an object that discharges one: a key, a table CHECK, a contract's or a refinement's own domain;
 *   - a domain several columns share (identical definitions are one domain), the laws of the columns it types in the
 *     tables the failing statement writes, which are the only values that statement coerced to it; every column's law
 *     where it writes none of them (a COMMIT, or a statement into a carrier);
 *   - every law merged into one object, a family's axis foreign key carrying several containments: which pair of its
 *     columns failed is in PostgreSQL's DETAIL alone, which the classifier never reads.
 *
 * Every DETAIL read here is grizzle's own text, raised by grizzle's own statement, but it is the
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
 * A violation's meaning as a law outcome, a fact outside a query entry, a concurrent change a write statement met, or a
 * roster domain's refusal of a value grizzle wrote, which is grizzle's defect.
 */
export type Violation =
	| {
			readonly kind: "rejected"
			readonly laws: Arr.NonEmptyReadonlyArray<Law>
			readonly witness: Witness
	  }
	| { readonly kind: "outside"; readonly relation: string }
	| { readonly kind: "aborted"; readonly reason: ConcurrentChange }
	| { readonly kind: "defect"; readonly domain: DomainName; readonly roster: RosterDomain }

/**
 * The hook: a violation's law outcome, or undefined when it is not one, raised by a statement that writes the stored
 * relations `written`, by declared name (none for a COMMIT, a read-back or a statement into a carrier).
 */
export type ViolationClassifier = (
	failure: ViolationFields,
	written: ReadonlyArray<string>
) => Violation | undefined

/** A roster's live codes as its domains admit them, each with its handle, and its holes: `0 "a", 2 "c"; holes 1`. */
const liveCodesText = (roster: RosterDomain): string => {
	const live: Array<string> = []
	const holes: Array<string> = []
	for (const [code, name] of roster.codec.names.entries()) {
		if (name === "") {
			holes.push(String(code))
		} else {
			live.push(`${code} ${jsonText(name)}`)
		}
	}
	return holes.length === 0
		? Arr.join(live, ", ")
		: `${Arr.join(live, ", ")}; holes ${Arr.join(holes, ", ")}`
}

/**
 * The defect a roster domain's violation is, raised at `at`, a statement of grizzle's or its COMMIT: the domain, its
 * roster and the codes it admits, which are every code grizzle's codec writes.
 */
export const rosterDomainDefect = (
	violation: Extract<Violation, { readonly kind: "defect" }>,
	at: string
): Error => {
	const { carrier, codec } = violation.roster
	const admits =
		carrier === "code"
			? `a live handle's code (${liveCodesText(violation.roster)})`
			: `a set of live handles' bits, bit(${codec.size}) with a 0 at every hole (${liveCodesText(violation.roster)})`
	return defect(
		`grizzle writes only live handles, and ${carrier === "code" ? "the code" : "the bits"} domain ${violation.domain} of roster ${codec.roster} admits ${admits}, yet ${at} raised 23514 on it`
	)
}

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
	return witness === undefined ? undefined : { kind: "rejected", laws: [law.described], witness }
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

/**
 * The laws a native violation names (see the header): a domain's, of the columns it types in the tables `written`, when
 * it types any there; every law the object discharges otherwise.
 */
const nativeLaws = (
	native: NativeLaws,
	written: ReadonlySet<RelationIdent>
): Arr.NonEmptyReadonlyArray<Law> => {
	const coerced = new Set(
		Arr.flatMap(native.uses, (use) => (written.has(use.table) ? [use.law] : []))
	)
	const broken = Arr.filter(native.laws, (l) => coerced.has(l.law))
	return Arr.map(Arr.isReadonlyArrayNonEmpty(broken) ? broken : native.laws, (l) => l.described)
}

/** The classifier of one installation's violations (see the header). */
export const violationClassifier =
	(laws: KeyLaws, decoder: KeyDecoder): ViolationClassifier =>
	(failure, written) => {
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
		/**
		 * The reported table or data type names an object of the installation only when the reported schema is the
		 * installation's.
		 */
		const owner = reportedOwner(failure, laws.schema)
		if (failure.sqlstate === sqlstates.checkViolation && owner?.kind === "domain") {
			const roster = laws.rosterDomainOf(owner.name)
			if (roster !== undefined) {
				return { kind: "defect", domain: owner.name, roster }
			}
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
			/** A write statement's refusal, by its DETAIL's tag: no other DETAIL is grizzle's. */
			const refusal = readLawDetail(detail)
			return refusal.kind === "law" ? refusalRejection(law, refusal, decoder) : undefined
		}
		if (owner === undefined) {
			return undefined
		}
		const native = laws.lawsOf(constraint, owner)
		if (native === undefined) {
			return undefined
		}
		return {
			kind: "rejected",
			laws: nativeLaws(native, new Set(Arr.map(written, (relation) => laws.tableOf(relation)))),
			witness: unreportedWitness
		}
	}
