import { Array as Arr, Effect, Result as EffectResult } from "effect"
import { readBacks } from "#adapter/apply/readback.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { toResult } from "#adapter/engine.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import {
	type CompiledReadValue,
	makeReader,
	type ReaderValue,
	type ReadExecutor,
	type ReadForm,
	readHandle
} from "#adapter/reader/reader.ts"
import { type CompiledEntry, compiledPageRuntime, compileReadForm } from "#adapter/served/forms.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { PageFill, StatementSpec } from "#compiler/ir/products.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	type ConservativeProgram,
	conservativeInput,
	type DeclaredParamSlot,
	flight
} from "#compiler/lower/conservative/types.ts"
import { deliveredAsOptimized, type RelationChoice } from "#compiler/lower/shapes/index.ts"
import {
	artifactStatements,
	assemble,
	conservativeKit,
	type PageArtifact,
	type PageCompileInput,
	type PageTemplate,
	pageShapeOf,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
import {
	type SpecifiedArtifact,
	type SpecifiedForm,
	specifiedStatements
} from "#compiler/lower/template.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { StatementShare } from "#compiler/write/insert/statement.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import {
	type CompiledWrite,
	type CompileWriteOptions,
	type FamilyPlacement,
	finish,
	insertAborts,
	newBuilder,
	place,
	placeFamily,
	placeReadBack,
	uniqueAbortsOf
} from "#compiler/write/program/compile.ts"
import { type ConservativeWrite, realizeConservative } from "#test/support/oracle/write/realize.ts"

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
): EffectResult.Result<
	{ readonly runtime: PageRuntime; readonly artifact: PageArtifact },
	CompileError
> =>
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
				EffectResult.map(
					compiledPageRuntime({
						page: {
							order: runtime.page.order,
							comparators: runtime.page.comparators,
							heading: runtime.page.heading,
							artifact
						},
						params: runtime.params,
						codes: artifacts.names.codes,
						query: runtime.identity.query,
						generation: runtime.identity.generation,
						spine: servedSpine(desc)
					}),
					(served) => ({ runtime: served, artifact })
				)
		)
	)

/** The Db context's compilation, every template running its conservative lowering in its optimized one's place. */
const conservativeCompile =
	(ctx: DbContext): DbContext["compile"] =>
	(input, request) =>
		Result.flatMap(ctx.compile(input, request), ({ compiled, artifacts }) =>
			Result.map(withConservative(compiled.template, artifacts.reads), (oracle) => ({
				compiled: { ...compiled, template: conservativeRunning(oracle) },
				artifacts
			}))
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
					return EffectResult.flatMap(
						toResult(ctx.programArtifacts({ kind: "query", query: page.compiled.desc })),
						({ artifacts }) =>
							EffectResult.map(
								conservativePageRuntime(
									page.runtime,
									page.compiled.template,
									page.compiled.desc,
									artifacts
								),
								({ runtime }): ReadForm<unknown> => ({
									...compiled,
									page: { kind: "compiled", page: { ...page, runtime } }
								})
							)
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
/**
 * The write oracle's baseline of a compiled ChangeSet: `entry` with its program's conservative realization
 * (write/program/compile.ts conservativeWrite) and that realization's read-backs in their place, which an application
 * then runs as it runs the optimized one, its members and read-backs read under the names of the artifacts its role
 * compiled it against (db/context.ts RoleContext.programArtifacts).
 */
export const conservativeChange = (
	entry: CompiledEntry,
	role: Pick<DbContext, "programArtifacts">
): Result.Result<CompiledEntry, CompileError> =>
	Result.flatMap(
		role.programArtifacts({ kind: "changeSet", changeSet: entry.change.desc }),
		({ artifacts }) =>
			Result.map(
				conservativeWrite(entry.program, { names: entry.names, reads: artifacts.reads }),
				(program) => ({
					...entry,
					program,
					readBacks: readBacks(program, entry.names.codes)
				})
			)
	)

/**
 * The conservative lowering of a page compiled from `input` (lower/shapes/page/compile.ts compilePage), its
 * statements lowered over the template's checked query with no evidence, in `page`'s order and comparators: the page
 * oracle's baseline, which no page compiles.
 */
export const conservativePage = (
	input: PageCompileInput,
	page: Pick<PageTemplate, "order" | "comparators">
): Result.Result<PageArtifact, CompileError> =>
	catchRefusal(() => {
		const checkedRoot = input.checked.dag.roots[0]
		if (checkedRoot.kind !== "OrderedResult") {
			throw new Refusal(
				malformedDescription(
					SourceLoc("page compiler", []),
					"a page over an Ordered query, its root an ordered result"
				)
			)
		}
		const shape = pageShapeOf(conservativeKit<PageFill>(input).delivery, checkedRoot)
		return assemble(
			artifactStatements(
				<F extends PageFill>() => conservativeKit<F>(input),
				checkedRoot,
				page.order,
				page.comparators
			),
			{ ...shape, order: page.order }
		)
	})

/**
 * The conservative artifact of a write: its conservative realization's steps (oracle/write/realize.ts), every
 * statement after the one before it, each family statement where its stratum's schedule runs it, as the program placed
 * it (write/program/compile.ts CompiledWrite.placements).
 */
const conservativeArtifact = (
	write: ConservativeWrite,
	codes: Codebook,
	placements: ReadonlyArray<FamilyPlacement>
): WriteArtifact => {
	const b = newBuilder(codes)
	const after = (): ReadonlyArray<number> =>
		b.statements.length === 0 ? [] : [b.statements.length - 1]
	for (const step of write.steps) {
		const previous = after()
		switch (step.kind) {
			case "family":
				placeFamily(b, placements, step.stratum, step.node, after)
				break
			case "readBack":
				placeReadBack(b, step.read, deliveredAsOptimized(step.program), previous)
				break
			case "carrier": {
				const result = step.statement.result
				place(
					b,
					step.statement,
					{
						kind: "carrier",
						carrier: result.carrier,
						step: result.step,
						stratum: step.stratum,
						casts: step.casts
					},
					previous
				)
				break
			}
			case "action": {
				const { statement, stratum, action, relation } = step
				const skip = { skipWhenEmpty: statement.skipWhenEmpty }
				const result = statement.result
				place(
					b,
					statement,
					result.kind === "sequenceAdvance"
						? {
								kind: "advance",
								stratum,
								action,
								relation: relation.name,
								field: result.field,
								...skip
							}
						: {
								kind: "write",
								stratum,
								action,
								relation: relation.name,
								result,
								...skip,
								uniqueAborts: uniqueAbortsOf(
									relation,
									result.kind !== "insert" ? { kind: "other" } : insertAborts(result.serial)
								)
							},
					previous
				)
				break
			}
			case "check": {
				const { statement } = step
				place(
					b,
					statement,
					{
						kind: "check",
						stratum: step.stratum,
						entry: statement.result.entry,
						skipWhenEmpty: statement.skipWhenEmpty
					},
					previous
				)
				break
			}
		}
	}
	return finish(b, write.carriers)
}

/**
 * The write oracle's baseline of a compiled write: the same program with its conservative realization as the artifact
 * an application runs, and everything read off the artifact read off that one. It rests on no evidence. No compilation
 * builds it: the write oracle does, to run beside the program (test/support/oracle/write).
 */
export const conservativeWrite = (
	program: CompiledWrite,
	options: Pick<CompileWriteOptions, "names" | "reads">
): Result.Result<CompiledWrite, CompileError> =>
	Result.flatMap(
		realizeConservative(program.frontend, {
			names: options.names,
			reads: options.reads,
			share: new StatementShare()
		}),
		(write) =>
			catchRefusal((): CompiledWrite => {
				const artifact = conservativeArtifact(write, options.names.codes, program.placements)
				return {
					...program,
					optimized: artifact.specs,
					certificates: [],
					nameMap: artifact.nameMap,
					artifact
				}
			})
	)
