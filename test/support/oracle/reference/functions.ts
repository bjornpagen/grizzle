import { Data } from "effect"
import type { Value } from "#test/support/oracle/reference/values.ts"

/**
 * The reference's models of declared functions (schema/function.ts fn), whose bodies PostgreSQL alone runs: a test
 * that installs a function states what its body computes, and the reference evaluates a call of it (ir/rel.ts Call) by
 * the model, so its rows and its refusals are judged against the lowering's.
 *
 * A model's result is what PostgreSQL's would be, NULL wherever PostgreSQL's would hold NULL: a value of the result
 * field, rows of a heading, a set of rows each of which may be NULL, or one row of one; a row holds each of its
 * heading's fields by name, each itself a value, rows or one row. grizzle holds no NULL, so the reference refuses a
 * call where its result holds NULL where the call reads it (CallRefused), as the lowering raises SQLSTATE 22004.
 */
export type ModelResult =
	| { readonly kind: "value"; readonly value: Value | null }
	| { readonly kind: "rows"; readonly rows: ReadonlyArray<ModelRow | null> | null }
	| { readonly kind: "row"; readonly row: ModelRow | null }

/** A row a model returns: each field of its heading by name. */
export type ModelRow = ReadonlyMap<string, ModelResult>

/** Whether a result is NULL: a NULL value, a NULL array of rows, or a NULL row. */
export const isNullResult = (result: ModelResult): boolean => {
	switch (result.kind) {
		case "value":
			return result.value === null
		case "rows":
			return result.rows === null
		case "row":
			return result.row === null
	}
}

/**
 * An argument a call passes its function's model: a value, or rows, each a record of its heading's values by column
 * name, in no order, a set.
 */
export type ModelArg =
	| { readonly kind: "value"; readonly value: Value }
	| { readonly kind: "rows"; readonly rows: ReadonlyArray<ReadonlyMap<string, Value>> }

/** A declared function's model: its result at its arguments, each by its declared name. */
export type DeclaredModel = (args: ReadonlyMap<string, ModelArg>) => ModelResult

/** The models of the declared functions a reference may call, by the function's declared name. */
export type DeclaredModels = ReadonlyMap<string, DeclaredModel>

/** The models of a reference that calls no declared function. */
export const noFunctions: DeclaredModels = new Map()

/**
 * A call's refusal, where its function's result holds NULL where the call reads it: a row holding NULL at a field, a
 * NULL row, or a field's row holding NULL, which the lowering raises with SQLSTATE 22004 (lower/conservative/call).
 */
export class CallRefused extends Data.TaggedError("CallRefused")<{
	readonly function: string
	readonly held: string
}> {
	override get message(): string {
		return `function ${this.function} returned ${this.held}`
	}
}
