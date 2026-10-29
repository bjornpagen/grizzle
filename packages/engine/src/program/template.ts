import type { CompileError } from "#compiler/core/errors.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import {
	compileQuery,
	type QueryInput,
	type QueryTemplate,
	querySchema,
	type TemplateReading
} from "#compiler/program/compile.ts"
import { type ArtifactSelection, selectArtifact } from "#compiler/program/context.ts"
import type { SchemaArtifacts, SchemaInput } from "#compiler/program/schema.ts"

/** One execution's request: the context it runs in, and how the template is read. */
export interface ExecutionRequest extends TemplateReading {
	readonly context: TemplateContext
}

/** A query compiled for an execution request: its Description, its template, and the artifact that runs. */
export interface CompiledTemplate {
	/** The query's Description, decoded once from the caller's value. */
	readonly desc: QueryDesc
	readonly template: QueryTemplate
	/** Which artifact runs, and its statements. */
	readonly selection: ArtifactSelection
}

/**
 * The template of `query` over `schema`, whose artifacts the caller holds (a DbLayer computes each role's once, when it
 * is built), compiled for `request` under production's budgets, with the artifact that runs (context.ts). Every call
 * compiles: grizzle keeps no cache of templates, and a caller that runs a program again keeps its compiled form itself
 * (the workload, db.compile).
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
				budgets: compileBudgets,
				read: request.read
			}),
			(template): CompiledTemplate => ({
				desc: source.desc,
				template,
				selection: selectArtifact(template, request.context)
			})
		)
	)
