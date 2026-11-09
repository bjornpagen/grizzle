import { Array as Arr, Effect, Result as EffectResult } from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import { toResult } from "#adapter/engine.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { type PageRuntime, pageRuntimeOf } from "#adapter/page/template.ts"
import { attachmentHeads } from "#adapter/reader/analysis.ts"
import {
	compileReadForm,
	type CompiledReadValue,
	makeReader,
	type ReaderValue,
	type ReadExecutor,
	type ReadForm,
	readHandle
} from "#adapter/reader/reader.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	type ConservativeProgram,
	conservativeInput,
	type DeclaredParamSlot,
	flight
} from "#compiler/lower/conservative/types.ts"
import { deliveredAsOptimized, type RelationChoice } from "#compiler/lower/shapes/index.ts"
import { conservativePage, statedOrderOf } from "#compiler/lower/shapes/page/compile.ts"
import {
	type SpecifiedArtifact,
	type SpecifiedForm,
	specifiedStatements
} from "#compiler/lower/template.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"

/**
 * A query template with its conservative lowering beside its optimized one, as the oracles read both: the checked
 * query lowered with no evidence (lower/conservative), its statements specified as the optimized ones are, and read as
 * optimized statements. The compiler builds the optimized artifact alone (program/compile.ts compileQuery).
 */
export type OracleTemplate = QueryTemplate & {
	readonly conservative: ReadonlyArray<StatementSpec>
	readonly programs: QueryTemplate["programs"] & { readonly conservative: ConservativeProgram }
	readonly runs: { readonly optimized: SpecifiedArtifact; readonly conservative: SpecifiedArtifact }
}

/** `template` with its conservative lowering under `names`, the names its artifacts read under. */
export const withConservative = (
	template: QueryTemplate,
	names: PhysicalNames
): Result.Result<OracleTemplate, CompileError> => {
	const checked = template.programs.checked
	return Result.flatMap(
		lowerConservative(conservativeInput(checked), {
			names,
			params: checked.params,
			subject: { kind: "query" }
		}),
		(conservative) =>
			Result.map(
				specifiedStatements(
					deliveredAsOptimized<RelationChoice, SpecifiedForm, DeclaredParamSlot>(conservative)
						.roots,
					names.codes
				),
				(roots): OracleTemplate => ({
					...template,
					conservative: Arr.map(flight(roots), (run) => run.spec),
					programs: { ...template.programs, conservative },
					runs: {
						optimized: template.run,
						conservative: { delivery: conservative.delivery, roots }
					}
				})
			)
	)
}

/**
 * The template that runs `oracle`'s conservative artifact where it ran its optimized one: what a differential reads
 * through the runtime to run the conservative side.
 */
export const conservativeRunning = (oracle: OracleTemplate): QueryTemplate => ({
	...oracle,
	optimized: oracle.conservative,
	run: oracle.runs.conservative
})

/**
 * The page runtime that pages `runtime`'s query through the page oracle's baseline: the page `template` compiles to
 * (adapter/page/template.ts pageTemplateFor), its artifact lowered conservatively (conservativePage), every other part
 * of the runtime as it was built.
 */
export const conservativePageRuntime = (
	runtime: PageRuntime,
	template: QueryTemplate,
	desc: QueryDesc,
	artifacts: SchemaArtifacts
): EffectResult.Result<PageRuntime, CompileError> =>
	EffectResult.flatMap(toResult(statedOrderOf(desc, SourceLoc("query", []))), (stated) =>
		EffectResult.flatMap(
			toResult(
				conservativePage(
					{
						checked: template.programs.checked,
						optimized: template.programs.optimized,
						stated,
						names: artifacts.reads
					},
					runtime.page
				)
			),
			(artifact) =>
				pageRuntimeOf({
					page: { ...runtime.page, artifact },
					params: runtime.params,
					codes: artifacts.names.codes,
					query: runtime.identity.query,
					generation: runtime.identity.generation,
					spine: attachmentHeads(desc)
				})
		)
	)

/** The Db context's compilation, every template running its conservative lowering in its optimized one's place. */
export const conservativeCompile =
	(ctx: DbContext): DbContext["compile"] =>
	(input, request) =>
		Result.flatMap(ctx.compile(input, request), (prepared) =>
			Result.map(
				withConservative(prepared.template, ctx.artifacts.reads),
				(oracle): CompiledTemplate => ({ ...prepared, template: conservativeRunning(oracle) })
			)
		)

/**
 * The reader of `ctx`'s Db that reads every query through its conservative lowering and every page through its
 * conservative page artifact, on `executor`: a reader of the Db as makeReader builds it, over the Db's compilation run
 * conservatively (conservativeCompile), each page's runtime template swapped for the page oracle's baseline
 * (conservativePageRuntime) where a page is compiled, for a direct page and a compiled handle's alike.
 */
export const conservativeReader = (ctx: DbContext, executor: ReadExecutor): ReaderValue => {
	const conservative: DbContext = { ...ctx, compile: conservativeCompile(ctx) }
	const reader: ReaderValue = makeReader(conservative, executor)
	const handleOf = (query: unknown): Effect.Effect<CompiledReadValue, CompileError> =>
		Effect.suspend(() => {
			if (!isQueryValue(query) && !isOrderedValue(query)) {
				return Effect.die(new Error("a conservative read of a value no query builder made"))
			}
			const form = EffectResult.flatMap(
				compileReadForm(conservative, query, () => query.rows),
				(compiled): EffectResult.Result<ReadForm<unknown>, CompileError> => {
					const source = compiled.page
					if (source.kind === "query") {
						return EffectResult.succeed(compiled)
					}
					const page = source.page
					return EffectResult.map(
						conservativePageRuntime(
							page.runtime,
							page.compiled.template,
							page.compiled.desc,
							ctx.artifacts
						),
						(runtime): ReadForm<unknown> => ({
							...compiled,
							page: { kind: "compiled", page: { ...page, runtime } }
						})
					)
				}
			)
			return Effect.map(Effect.fromResult(form), (f): CompiledReadValue =>
				readHandle(conservative, executor, f, () => true)
			)
		})
	return {
		...reader,
		compile: handleOf,
		page: (query, params, request) =>
			Effect.flatMap(
				Effect.mapError(handleOf(query), (reason) => new ReadFailure({ reason })),
				(handle) => handle.page(params, request)
			)
	}
}
