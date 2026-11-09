/**
 * The two texts a value takes between grizzle and PostgreSQL, two types so that neither is ever read as the other:
 *
 * - `ParamText` is what grizzle sends: a parameter's text, which PostgreSQL's input function of the parameter's type
 *   reads. Only an encoder writes one (codec/scalar.ts, and codec/recordset.ts for an array of them), and only the wire
 *   sends one; nothing in grizzle reads one back. A bytes or text column's array is sent in binary instead, a
 *   `ParamBinary` (codec/bytea.ts), which PostgreSQL's receive function reads: the column's type chooses it, never the
 *   array's size.
 * - `OutputText` is what PostgreSQL sends back: a result cell's text, its type's output function's. Only the wire
 *   receives one (packages/grizzle/src/adapter/wire/session.ts), and only a reader reads one (codec/read.ts). No
 *   column's text is a bytes value's: a bytes column travels in chunks, which its statement's delivery assembles into
 *   the value itself, a `Cell` (codec/delivery.ts).
 *
 * The two spell one value differently wherever PostgreSQL's input and output forms differ, a set's X and hex digits in
 * and its 0s and 1s out among them, so a reader fed the other form would read another value; no function takes a
 * plain string where either belongs, and neither is assignable to the other.
 */
declare const paramTextBrand: unique symbol
declare const outputTextBrand: unique symbol

/** A parameter's text, as an encoder writes it for PostgreSQL's input function. */
export type ParamText = string & { readonly [paramTextBrand]: true }

declare const paramBinaryBrand: unique symbol

/**
 * A parameter's binary value, as an encoder writes it for PostgreSQL's receive function, in the array binary format
 * (codec/bytea.ts): a bytes column's bytea[], or a text column's text[] of its values' UTF-8 bytes, chosen by the
 * column's type. The driver sends it with format code 1, since it is a Uint8Array.
 */
export type ParamBinary = Uint8Array<ArrayBuffer> & { readonly [paramBinaryBrand]: true }

/** What one placeholder carries: its text, or a bytes or text column's binary array. */
export type Param = ParamText | ParamBinary

/** A result cell's text, as PostgreSQL's output function writes it. */
export type OutputText = string & { readonly [outputTextBrand]: true }

/** A statement's answer rows as PostgreSQL sent them: each row's cells, each its output text. */
export type OutputRows = ReadonlyArray<ReadonlyArray<OutputText>>

/**
 * One cell of a delivered row: a column's output text, or a bytes column's value, assembled from the chunks its
 * statement delivered into a fresh array over a buffer of its own (codec/delivery.ts). A text column's cell is never a
 * value and a bytes column's never a text.
 */
export type Cell = OutputText | Uint8Array<ArrayBuffer>

/** A statement's rows as its delivery assembles them: each row's cells, in its statement's output order. */
export type AssembledRows = ReadonlyArray<ReadonlyArray<Cell>>
