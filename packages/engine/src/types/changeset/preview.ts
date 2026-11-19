/**
 * What an insertion preview reads and gives (program/preview.ts insertPreview), typed off the schema: the rows
 * `ChangeSet.empty(S).insertAll(rows)` stores as the first write of an installation holding no row, every writable
 * relation's, each row whole but for the fields PostgreSQL generates from it, or the refusal that write meets before
 * any SQL.
 */
import type { Result } from "effect"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { LiteralBound, MessageBound } from "#compiler/ir/products.ts"
import type { InsertAllRowsOf, OwnLaw, Witness } from "#compiler/types/changeset/changeset.ts"
import type { EvaluatedRow } from "#compiler/types/schema/evaluation.ts"
import type { AnySchema, RelationsOf, UnderName } from "#compiler/types/schema/schema.ts"
import type { WritableNameOf } from "#compiler/types/schema/world.ts"

/**
 * Every writable relation of S (WritableNameOf), an empty array where the write stores none of it, and under each its
 * rows as the write stores them: each an EvaluatedRow, every field the relation stores but those PostgreSQL generates,
 * each its codec's host value, a closed id its handle, so `rowEvaluator(S)` evaluates it as it is. A relation's rows
 * are a set: each once, in no order that means anything.
 */
export type PreviewRows<S extends AnySchema> = {
	readonly [N in WritableNameOf<S>]: ReadonlyArray<EvaluatedRow<UnderName<RelationsOf<S>, N>>>
}

/**
 * The call's input refused as the write's own binding refuses it: a value outside its field's type, a fact of another
 * shape than its relation's addition (`factShape`), or an input past a bound of the transport (MessageBound, LiteralBound), which the write meets as InputTooLarge.
 */
interface InputRefused {
	readonly _tag: "InputRefused"
	readonly failure: EncodingFailure | MessageBound | LiteralBound
}

/** Two rows of one relation at one key that differ, refused by the key's law, witnessed by the key's values. */
interface KeyConflict {
	readonly _tag: "KeyConflict"
	readonly law: OwnLaw
	readonly witness: Witness
}

/**
 * A generated field with no value at a row a family's fill reads it of, a closed read at a key its relation lacks,
 * refused by the field's law, witnessed as PostgreSQL's NOT NULL refusal of the row is.
 */
interface GeneratedNull {
	readonly _tag: "GeneratedNull"
	readonly law: Extract<OwnLaw, { readonly kind: "generated" }>
	readonly witness: Witness
}

/**
 * A counted family's member whose owner the call does not insert, which no installation holding no row stores: `law`
 * the family's law, its member's containment in its owner, as lawsOf(S) lists it, so `sameLaw` reads it.
 */
interface OwnerAbsent {
	readonly _tag: "OwnerAbsent"
	readonly law: Extract<OwnLaw, { readonly kind: "family" }>
}

/**
 * What refuses a preview, as it refuses the write before any SQL. A law PostgreSQL judges once the statements run, a
 * check, a containment or a rule over a query, is none of these: the preview gives the rows, which rowEvaluator and
 * the laws judge.
 */
export type PreviewRefusal = InputRefused | KeyConflict | GeneratedNull | OwnerAbsent

/**
 * The preview of an insertion into S (program/preview.ts insertPreviewOver): the rows its write stores, or its refusal,
 * as Effect's Result.
 */
export type InsertPreview<S extends AnySchema> = (
	rows: InsertAllRowsOf<S>
) => Result.Result<PreviewRows<S>, PreviewRefusal>
