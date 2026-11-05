/**
 * An enumerated relation parameter at or below this many facts travels as a VALUES list of typed literals.
 *
 * Every constant of this module is one of grizzle's fixed thresholds, read where it decides, or a limit of PostgreSQL or
 * V8 that grizzle states where it applies. None is configurable, and none is digested: no fingerprint or snapshot
 * depends on them, since a change of a constant is a change of grizzle. A function that decides a threshold takes it as
 * its own parameter where a test drives that decision with a smaller value; production passes the constant.
 */
export const valuesMaxRows = 16

/**
 * Above valuesMaxRows, one jsonb_to_recordset parameter up to this many facts, a Stream member's collected facts
 * included. A larger input is refused before any SQL is sent.
 */
export const recordsetMaxRows = 100_000

/** A bound parent set at or below this size takes the correlated LATERAL form. */
export const lateralParentMax = 256

/** An attachment with at most this many fields may be fused into its parent statement. */
export const attachFuseMaxFields = 4

/** A sub-query referenced at least this many times in one snapshot is shared. */
export const cteShareMinRefs = 2

/**
 * A membership of declared closed facts whose terms (its facts times the columns it binds, at least one) are at most
 * this many is rewritten into native constant membership (lower/optimize/finite); a larger one keeps its VALUES join.
 */
export const finiteMembershipMaxTerms = 64

/** Recursion: the bounded unrolling depth, and the admitted termination-certificate state estimate. */
export const recursionUnrollMax = 4
export const recursionMaxStates = 1_000_000

/** The regex AST size a pattern may reach, and PostgreSQL's explicit repetition limit. */
export const regexMaxNodes = 512
export const regexMaxRepeat = 255

/** The compiler's budgets, in the order a meter reports them. */
export const budgetKinds = ["nodes"] as const
export type BudgetKind = (typeof budgetKinds)[number]

/** The compiler's resource bounds per compilation; exceeding one is a source-located ResourceBound (budget.ts). */
export type Budgets = Readonly<Record<BudgetKind, number>>
export const compileBudgets: Budgets = Object.freeze({
	nodes: 10_000
})

/** The session pool: a short idle timeout, a floor of one session, a maximum above one. */
export const poolBounds = Object.freeze({ idleTimeoutMs: 5_000, min: 1, max: 10 })

/** Page sizes above this are refused. */
export const pageMaxSize = 1_000

/** A cursor token above this many bytes is a CursorError. */
export const cursorMaxBytes = 1_024

/**
 * The longest string V8 builds, in UTF-16 code units: a statement, drafted file, snapshot.json, meta.json or canonical
 * text that would be longer is refused as ResourceBound (stringLength) before it is built, where building it would
 * throw RangeError "Invalid string length". It is String::kMaxLength on a 64-bit platform, which node:buffer's
 * constants.MAX_STRING_LENGTH reports (test/unit/core/lines.test.ts reads it).
 *
 * @limitKind published
 * @owner V8 14.6, Node 26.13.0's JavaScript engine
 * @unit UTF-16 code units
 * @scope one JavaScript string
 * @constraint compile-time constant
 * @source https://github.com/nodejs/node/blob/v26.13.0/deps/v8/include/v8-primitive.h#L127 "internal::kApiSystemPointerSize == 4 ? (1 << 28) - 16 : (1 << 29) - 24;"
 * @verified 2026-11-04
 */
export const maxStringLength = 2 ** 29 - 24

/**
 * The most columns one table of PostgreSQL holds: a stored relation's table with the tag columns added to it, a view, a
 * materialized view and a write program's carrier, each refused as ResourceBound (tableColumns) where it is emitted,
 * since PostgreSQL refuses the statement with 54011, "tables can have at most 1600 columns". A column the table once
 * held and dropped counts too, which a migration cannot see: PostgreSQL refuses such an ADD COLUMN itself.
 *
 * @limitKind published
 * @owner PostgreSQL 19
 * @unit columns
 * @scope one table, view or materialized view, its dropped columns included
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/access/htup_details.h#L48 "#define MaxHeapAttributeNumber	1600"
 * @verified 2026-11-04
 */
export const tableMaxColumns = 1_600

/**
 * The most entries one select list holds, a SELECT's target list or a RETURNING list, each refused as ResourceBound
 * (selectList) where it is printed, since PostgreSQL refuses a longer one with 54011, "target lists can have at most
 * 1664 entries" (src/backend/parser/parse_node.c free_parsestate).
 *
 * @limitKind published
 * @owner PostgreSQL 19
 * @unit entries
 * @scope one target list of one query level
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/access/htup_details.h#L34 "#define MaxTupleAttributeNumber 1664"
 * @verified 2026-11-04
 */
export const selectMaxEntries = 1_664

/**
 * PostgreSQL's MaxAllocSize, the largest chunk its allocator hands out, which bounds the messages a backend reads.
 *
 * @limitKind published
 * @owner PostgreSQL 19
 * @unit bytes
 * @scope one allocation of a backend
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/utils/memutils.h#L40 "#define MaxAllocSize	((Size) 0x3fffffff)"
 * @verified 2026-11-04
 */
const maxAllocSize = 0x3fff_ffff

/**
 * The longest message a PostgreSQL backend reads from a client, its length word included: a Query or Parse message
 * holding a statement, or a Bind message. A longer one is "invalid message length" (src/backend/libpq/pqcomm.c
 * pq_getmessage), after which the backend ends the connection, so a statement whose text is longer, in UTF-8 bytes, is
 * refused as ResourceBound (statementBytes) when it is printed.
 *
 * @limitKind derived
 * @owner PostgreSQL 19's frontend/backend protocol
 * @unit bytes
 * @scope one message, as its Int32 length counts it, itself included
 * @derivation maxAllocSize less one: PQ_LARGE_MESSAGE_LIMIT, "#define PQ_LARGE_MESSAGE_LIMIT	(MaxAllocSize - 1)"
 * (https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/libpq/libpq.h#L34), the limit SocketBackend
 * (src/backend/tcop/postgres.c) reads Query, Parse and Bind messages under
 */
export const messageMaxBytes = maxAllocSize - 1

/**
 * The most placeholders one statement binds: a Bind message counts its parameter values in an unsigned 16-bit field,
 * and the count must be the statement's highest `$n` ("bind message supplies %d parameters, but prepared statement
 * \"%s\" requires %d"), so a statement of more is refused as ResourceBound (statementParams) when it is printed.
 *
 * @limitKind published
 * @owner PostgreSQL 19's frontend/backend protocol
 * @unit placeholders
 * @scope one statement
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/tcop/postgres.c#L1734 "numParams = pq_getmsgint(input_message, 2);"
 * @verified 2026-11-04
 */
export const statementMaxParams = 2 ** 16 - 1
