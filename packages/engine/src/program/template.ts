import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { ClockBinding } from "#compiler/ir/clock.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import {
	compileQuery,
	type QueryInput,
	type QueryTemplate,
	querySchema,
	type TemplateReading
} from "#compiler/program/compile.ts"
import type { SchemaArtifacts, SchemaInput } from "#compiler/program/schema.ts"

/**
 * One execution's request: the context it runs in, how the template is read, and the parameters its member binds to the
 * database's clock (program/compile.ts CompileQueryOptions clock).
 */
export interface ExecutionRequest extends TemplateReading {
	readonly context: TemplateContext
	readonly clock: ClockBinding
}

/** A query compiled for an execution request: its Description and its template. */
export interface CompiledTemplate {
	/** The query's Description, decoded once from the caller's value. */
	readonly desc: QueryDesc
	readonly template: QueryTemplate
}

/**
 * The template of `query` over `schema`, whose artifacts the caller holds (a DbLayer computes each role's once, when it
 * is built), compiled for `request`, whose context every execution of it runs in. Every call compiles: grizzle keeps no
 * cache of templates, and a caller that runs a program again keeps its compiled form itself (the workload, db.compile).
 */
export const templateFor = (
	query: QueryInput,
	schema: SchemaInput,
	artifacts: SchemaArtifacts,
	request: ExecutionRequest
): Result.Result<CompiledTemplate, CompileError> =>
	Result.flatMap(querySchema(query, schema), (source) =>
		Result.map(
			compileQuery(source, {
				context: request.context,
				artifacts,
				read: request.read,
				clock: request.clock
			}),
			(template): CompiledTemplate => ({ desc: source.desc, template })
		)
	)
