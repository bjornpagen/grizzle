import { bindFrame } from "#adapter/wire/batch.ts"
import { type InsertPreview, inForce, insertPreviewOver } from "#compiler/plan/change.ts"
import { type AnySchema, type CompileError, Engine } from "#compiler/plan/common.ts"

/**
 * Public barrel: insertPreview. packages/grizzle/src/index.ts re-exports it.
 *
 * insertPreview(schema): the rows `ChangeSet.empty(schema).insertAll(rows)` stores as the first write of an
 * installation holding no row, closed relations aside, with no SQL sent: the schema compiled once, by the compile every
 * write takes, as a Result whose error is its CompileError, then each call the write's own binding of its rows before
 * any SQL, every writable relation's rows or the refusal that write meets there (engine program/preview.ts). The
 * binding runs under the transport of the wire the write would go over (wire/batch.ts bindFrame), so a call past its
 * message bound is refused as the write is, InputTooLarge.
 */
export const insertPreview = <S extends AnySchema>(
	schema: S
): Engine.Result<InsertPreview<S>, CompileError> => insertPreviewOver(schema, inForce(bindFrame))
