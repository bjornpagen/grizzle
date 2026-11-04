/**
 * An enumerated relation parameter at or below this many facts travels as a VALUES list of typed literals.
 *
 * Every constant of this module is one of grizzle's fixed thresholds, read where it decides. None is configurable,
 * none is measured, and none is digested: no fingerprint or snapshot depends on them, since a change of a
 * constant is a change of grizzle. A function that decides a threshold takes it as its own parameter where a test
 * drives that decision with a smaller value; production passes the constant.
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
 * 2^29 - 24 on Node 24, node:buffer's constants.MAX_STRING_LENGTH). A statement, drafted file, snapshot.json, meta.json
 * or canonical text that would be longer is refused as ResourceBound before it is built.
 */
export const textMaxLength = 2 ** 29 - 24
