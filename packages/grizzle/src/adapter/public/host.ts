import type { Result } from "effect"
import { rowOptions, toResult } from "#adapter/engine.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import {
	type FactsDecoder,
	factsDecoderOver,
	type InsertPreview,
	inForce,
	insertPreviewOver
} from "#compiler/plan/change.ts"
import {
	type AnySchema,
	type CodecFault,
	type CompileError,
	codecTextOver,
	type Decoders,
	type HeadOf,
	type RowEvaluator,
	rowEvaluatorOver,
	rowTextOver,
	type TextedField
} from "#compiler/plan/common.ts"

/**
 * Public barrel: the host's readings of a schema's values, which send no SQL: insertPreview, factsDecoder,
 * rowEvaluator, codecText and rowText. packages/grizzle/src/compile.ts re-exports it, beside lawsOf,
 * lawsByStatement and constraintNamesOf: each compiles the schema it is given, so none is the authoring entry's. Each answers Effect's
 * Result, the one Result a caller reads:
 * the engine computes each answer in its own (core/result.ts) and spells it through toResult (adapter/engine.ts), the
 * PublicResult each takes, where the answer is made, so an item computed where it is first read stays so.
 */

/**
 * insertPreview(schema): the rows `ChangeSet.empty(schema).insertAll(rows)` stores as the first write of an
 * installation holding no row, closed relations aside, with no SQL sent: the schema's law model compiled, as a Result
 * whose error is its CompileError, then each call the write's own binding of its rows before any SQL, by the insert of
 * the families its rows write, compiled where a call first writes them, every writable relation's rows or the refusal
 * that write meets there (engine program/preview.ts). The binding runs under the transport of the wire the write would
 * go over (wire/batch.ts bindFrame), so a call past its message bound is refused as the write is, InputTooLarge.
 */
export const insertPreview = <S extends AnySchema>(
	schema: S
): Result.Result<InsertPreview<S>, CompileError> =>
	toResult(insertPreviewOver(schema, inForce(bindFrame), toResult))

/**
 * factsDecoder(schema): the rows `ChangeSet.empty(schema).insertAll(rows)` takes of one top-level relation, decoded from
 * a value of any shape, a value another process sent among them, by the insert's own admission (engine
 * program/decode.ts): the schema's law model compiled, as a Result whose error is its CompileError, then `decode(K,
 * value)` is the value itself as K's rows, every row admitted as the insert of K's families admits a fact, compiled
 * where K is first decoded and shared with insertPreview's calls, and held to its domains as rowEvaluator holds a row,
 * or the first refusal its rows meet, at its row and field, by the write's fault.
 */
export const factsDecoder = <S extends AnySchema>(
	schema: S
): Result.Result<FactsDecoder<S>, CompileError> => toResult(factsDecoderOver(schema, toResult))

/**
 * rowEvaluator(schema): the host's evaluation of rows of the schema's sources, by the one evaluator grizzle judges a
 * refused write's rows by (engine program/evaluate.ts): the schema compiled once, as a Result whose error is its
 * CompileError, then `evaluate.admit(R, row)` holds a row to its relation's domains once and `evaluate(source,
 * admitted)` is its evaluation as a row of any source of its relation, each item its own Result, computed where it is
 * first read.
 */
export const rowEvaluator = <S extends AnySchema>(
	schema: S
): Result.Result<RowEvaluator<S>, CompileError> => toResult(rowEvaluatorOver(schema, toResult))

/**
 * codecText(field): the one text of each value of the field's type, a function of the value alone, its descriptor
 * read once (engine program/text.ts): bind `const startText = codecText(Node.fields.start)`, then
 * `startText(row.start)` is a Result of the value's text, or the CodecFault of a value its type does not admit.
 */
export const codecText = <V>(
	field: TextedField<V>
): ((value: V) => Result.Result<string, CodecFault>) => codecTextOver(field, toResult)

/**
 * rowText(query): the one text of each row the query delivers, its decoder read once (engine program/text.ts), as a
 * Result whose error is the CompileError of a query no builder can decode: bind `const text = rowText(q)`, then
 * `text(row)` is a Result of the row's text, every column codecText's text of its value, every attachment's children in
 * delivered order, each framed by its length and no JSON, so two rows have one text exactly where they are equal value
 * for value; or the CodecFault of a value its type does not admit. A digest of it keys a found row by its content.
 */
export const rowText = <Q extends Decoders<unknown, unknown>>(
	query: Q
): Result.Result<(row: HeadOf<Q>) => Result.Result<string, CodecFault>, CompileError> =>
	toResult(rowTextOver(query, toResult, rowOptions))
