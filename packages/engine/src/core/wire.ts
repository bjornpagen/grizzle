/**
 * The two texts a value takes between grizzle and PostgreSQL, two types so that neither is ever read as the other:
 *
 * - `ParamText` is what grizzle sends: a parameter's text, which PostgreSQL's input function of the parameter's type
 *   reads. Only an encoder writes one (codec/scalar.ts, and codec/recordset.ts for an array of them), and only the wire
 *   sends one; nothing in grizzle reads one back.
 * - `OutputText` is what PostgreSQL sends back: a result cell's text, its type's output function's. Only the wire
 *   receives one (packages/grizzle/src/adapter/wire/session.ts), and only a reader reads one (codec/read.ts).
 *
 * The two spell one value differently wherever PostgreSQL's input and output forms differ, a set's X and hex digits in
 * and its 0s and 1s out among them, so a reader fed the other form would read another value; no function takes a
 * plain string where either belongs, and neither is assignable to the other.
 */
declare const paramTextBrand: unique symbol
declare const outputTextBrand: unique symbol

/** A parameter's text, as an encoder writes it for PostgreSQL's input function. */
export type ParamText = string & { readonly [paramTextBrand]: true }

/** A result cell's text, as PostgreSQL's output function writes it. */
export type OutputText = string & { readonly [outputTextBrand]: true }

/** A statement's answer rows as PostgreSQL sent them: each row's cells, each its output text. */
export type OutputRows = ReadonlyArray<ReadonlyArray<OutputText>>
