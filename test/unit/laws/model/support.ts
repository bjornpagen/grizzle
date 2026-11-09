import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import { own } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	decodedSchema,
	type AuthoredRelationDesc as RelationDesc,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"

const modelResult = (desc: SchemaDesc): Result.Result<LawModel, CompileError> =>
	Result.flatMap(own(decodedSchema(desc)), (owned) =>
		compileLaws(owned, everySlice(owned), { kind: "planned" })
	)

/** Shared helpers for the law model tests: owning a schema description and compiling its laws. */
export const modelOf = (desc: SchemaDesc): LawModel => succeeded(modelResult(desc))

/** A one-level schema over the given relations and statements. */
export const schemaOf = (
	relations: ReadonlyArray<RelationDesc>,
	statements: ReadonlyArray<StatementDesc>,
	name: string
): SchemaDesc => ({
	name,
	relations,
	statements,
	extends: undefined
})
