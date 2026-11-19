/**
 * What a facts decoder reads and gives (program/decode.ts factsDecoder), typed off the schema: the rows insertAll takes
 * of one relation, decoded from a value of any shape, or where the insert's own admission refuses them.
 */
import type { Result } from "effect"
import type { CodecFault } from "#compiler/core/errors.ts"
import type { InsertableNameOf, InsertAllRowsOf } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

/** Where in a row a refusal stands: the row's shape, or one of its fields, by name. */
export type RowPlace =
	| { readonly kind: "shape" }
	| { readonly kind: "field"; readonly field: string }

/**
 * Why decode refuses a value, as the insert's own admission refuses it, the first refusal its rows meet:
 * - `RowsRefused`: the value is no array of rows, which insertAll takes under each relation's name;
 * - `ValueRefused`: the row at `row` is refused at `at` by the codec's fault, as the write refuses a fact: a row of
 *   another shape than its relation's addition (`factShape` at its shape, or at a field it lacks), a NULL
 *   (`nullValue`), or a value its field's type does not hold (scalar/values/identity.ts admitValue);
 * - `DomainRefused`: the row at `row` holds at `field` a value outside its type's contract or patterns, which its
 *   domain's CHECK refuses once PostgreSQL stores it, as rowEvaluator's admit refuses it.
 * A nested member's field is named as the write names it, by the field alone, at the row whose nesting holds it.
 */
export type FactsRefused =
	| { readonly _tag: "RowsRefused" }
	| {
			readonly _tag: "ValueRefused"
			readonly row: number
			readonly at: RowPlace
			readonly fault: CodecFault
	  }
	| { readonly _tag: "DomainRefused"; readonly row: number; readonly field: string }

/**
 * A schema's facts decoder (program/decode.ts factsDecoderOver): `decode(K, value)` is the value as the rows insertAll
 * takes of the top-level relation K, the value itself, each row admitted as the insert admits it and held to its
 * domains, or the first refusal its rows meet, as Effect's Result.
 */
export interface FactsDecoder<S extends AnySchema> {
	readonly decode: <K extends InsertableNameOf<S>>(
		relation: K,
		facts: unknown
	) => Result.Result<InsertAllRowsOf<S>[K], FactsRefused>
}
