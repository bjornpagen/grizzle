/**
 * PostgreSQL's MaxAllocSize, the largest chunk its allocator hands out, which bounds the messages a backend reads.
 *
 * Every constant of this module is one of grizzle's fixed thresholds, read where it decides, or a limit of PostgreSQL
 * or V8 that grizzle states where it applies. None is configurable, none is measured, and none is digested: no
 * fingerprint or snapshot depends on them, since a change of a constant is a change of grizzle. A function that decides
 * a threshold takes it as its own parameter where a test drives that decision with a smaller value; production passes
 * the constant.
 *
 * @limitKind published
 * @owner PostgreSQL 19
 * @unit bytes
 * @scope one allocation of a backend
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/utils/memutils.h#L40 "#define MaxAllocSize	((Size) 0x3fffffff)"
 * @verified 2026-11-04
 */
const maxAllocSize = 0x3fff_ffff

/**
 * The longest message a PostgreSQL backend reads from a client, as the message's Int32 length counts it, itself
 * included: a Bind message, which carries one execution's parameters, among them. A longer one is "invalid message
 * length" (src/backend/libpq/pqcomm.c pq_getmessage), after which the backend ends the connection without an
 * ErrorResponse, so a statement whose Bind message would be longer is refused on the host as InputTooLarge before its
 * flight is sent (the shell's wire/batch.ts).
 *
 * @limitKind published
 * @owner PostgreSQL 19
 * @unit bytes
 * @scope one message from client to server, a Bind message's parameters included
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/libpq/libpq.h#L34 "#define PQ_LARGE_MESSAGE_LIMIT	(MaxAllocSize - 1)"
 * @verified 2026-11-04
 */
export const messageMaxBytes = maxAllocSize - 1

/** A bound parent set at or below this size takes the correlated LATERAL form. */
export const lateralParentMax = 256

/** An attachment with at most this many fields may be fused into its parent statement. */
export const attachFuseMaxFields = 4

/** A sub-query referenced at least this many times in one snapshot is shared. */
export const cteShareMinRefs = 2

/** Recursion: the bounded unrolling depth, and the admitted termination-certificate state estimate. */
export const recursionUnrollMax = 4
export const recursionMaxStates = 1_000_000

/** The regex AST size a pattern may reach, and PostgreSQL's explicit repetition limit. */
export const regexMaxNodes = 512
export const regexMaxRepeat = 255

/** The compiler's budgets, in the order a meter reports them. */
export const budgetKinds = ["nodes", "fields", "sqlBytes", "params", "variants"] as const
export type BudgetKind = (typeof budgetKinds)[number]

/**
 * The compiler's resource bounds per compilation; exceeding one is a source-located ResourceBound (budget.ts). The
 * parameter bound is PostgreSQL's protocol limit: a Bind message counts its parameters in 16 bits.
 */
export type Budgets = Readonly<Record<BudgetKind, number>>
export const compileBudgets: Budgets = Object.freeze({
	nodes: 10_000,
	fields: 10_000,
	sqlBytes: 1024 * 1024,
	params: 65_535,
	variants: 64
})

/** The session pool: a short idle timeout, a floor of one session, a maximum above one. */
export const poolBounds = Object.freeze({ idleTimeoutMs: 5_000, min: 1, max: 10 })

/** Page sizes above this are refused. */
export const pageMaxSize = 1_000

/** A cursor token above this many bytes is a CursorError. */
export const cursorMaxBytes = 1_024

/**
 * The longest text grizzle builds as one string, in UTF-16 code units: V8's longest string (String::kMaxLength,
 * 2^29 - 24 on Node 26, node:buffer's constants.MAX_STRING_LENGTH). A statement, drafted file, snapshot.json, meta.json
 * or canonical text that would be longer is refused as ResourceBound before it is built.
 */
export const textMaxLength = 2 ** 29 - 24
