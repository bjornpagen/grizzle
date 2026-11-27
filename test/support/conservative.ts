import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Result as EffectResult } from "effect"
import { readBacks } from "#adapter/apply/readback.ts"
import { toResult } from "#adapter/engine.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import { type CompiledProgram, compiledPageRuntime } from "#adapter/served/forms.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { type ConservativeProgram, conservativeInput } from "#compiler/lower/conservative/types.ts"
import { conservativeStatement } from "#compiler/lower/shapes/index.ts"
import {
	conservativePageArtifact,
	type PageArtifact,
	type PageCompileInput,
	type PageTemplate,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
import { type SpecifiedArtifact, specifiedProgram } from "#compiler/lower/template.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { writeWorldOf } from "#compiler/program/write-world.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import type { EmittedSql } from "#compiler/sql/ast.ts"
import { StatementShare } from "#compiler/write/insert/statement.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import {
	type CompiledWrite,
	type CompileWriteOptions,
	type FamilyPlacement,
	finish,
	newBuilder,
	placeFamily,
	placeReadBack,
	placeStatement,
	uniqueAbortsOf
} from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { writeStandUps } from "#compiler/write/program/stand-up.ts"
import { type ConservativeWrite, realizeConservative } from "#test/support/oracle/write/realize.ts"

/**
 * A query template with its conservative lowering beside its optimized one, as the oracles read both: the checked
 * query lowered with no evidence (lower/conservative), and its statements as the parts of one statement specified as
 * the optimized one is (shapes/index.ts conservativeStatement), which the runtime runs as it runs the optimized one.
 * The compiler builds the optimized artifact alone (program/compile.ts compileQuery).
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
				catchRefusal(() => specifiedProgram(conservativeStatement(conservative), names.codes)),
				(run): OracleTemplate => ({
					...template,
					conservative: [run.statement.spec],
					programs: { ...template.programs, conservative },
					runs: { optimized: template.run, conservative: run }
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
		EffectResult.map(
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
			(artifact) => ({
				runtime: compiledPageRuntime({
					page: {
						order: runtime.page.order,
						comparators: runtime.page.comparators,
						heading: runtime.page.heading,
						artifact
					},
					params: runtime.params,
					codes: artifacts.names.codes,
					spine: servedSpine(desc)
				}),
				artifact
			})
		)
	)

/**
 * The write oracle's baseline of a compiled ChangeSet: `entry` with its program's conservative realization
 * (write/program/compile.ts conservativeWrite) and that realization's read-backs in their place, which an application
 * then runs as it runs the optimized one, its members and read-backs read under the names of the artifacts its role
 * compiled it against (served/role.ts RoleContext `artifacts`); beside it the realization whole, its statements'
 * ASTs among it, which an audit reads.
 */
export const conservativeChange = (
	{ entry, program: compiled }: CompiledProgram,
	{ artifacts }: Pick<RoleContext, "artifacts">
): Result.Result<CompiledProgram, CompileError> =>
	Result.map(
		conservativeWrite(compiled, {
			names: entry.names,
			reads: artifacts.reads,
			world: writeWorldOf(artifacts.world, artifacts.laws)
		}),
		(program) => {
			const servable = servableWrite(program)
			return {
				entry: {
					...entry,
					program: flightOf(servable, entry.names.codes),
					compiled: servable,
					readBacks: readBacks(servable.readBacks, entry.names.codes)
				},
				program
			}
		}
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
		return conservativePageArtifact(input, checkedRoot, page.order, page.comparators)
	})

/**
 * The conservative artifact of a write: its conservative realization's steps (oracle/write/realize.ts), every statement
 * after the one before it, each family statement where its stratum's schedule runs it, as the program placed it
 * (write/program/compile.ts CompiledWrite.placements), and its caller parameters `params` admitted in the statements a
 * call may send first, as the program's are (write/program/admission.ts).
 */
const conservativeArtifact = (
	write: ConservativeWrite,
	codes: Codebook,
	placements: ReadonlyArray<FamilyPlacement>,
	params: CompiledWrite["params"]
): WriteArtifact => {
	const b = newBuilder(codes)
	const after = (): ReadonlyArray<number> =>
		b.statements.length === 0 ? [] : [b.statements.length - 1]
	for (const step of write.steps) {
		const previous = after()
		switch (step.kind) {
			case "family":
				placeFamily(b, placements, step.stratum, step.node, after, { kind: "none" })
				break
			case "readBack":
				placeReadBack(b, step.read, conservativeStatement(step.program), step.admission, previous)
				break
			case "carrier": {
				const result = step.statement.result
				placeStatement(
					b,
					step.statement,
					{
						kind: "carrier",
						carrier: result.carrier,
						stratum: step.stratum,
						casts: step.casts
					},
					previous
				)
				break
			}
			case "action": {
				const { statement, stratum, action, relation } = step
				const result = statement.result
				placeStatement(
					b,
					statement,
					{
						kind: "write",
						stratum,
						action,
						relation: relation.name,
						result,
						needs: statement.needs,
						uniqueAborts: uniqueAbortsOf(
							relation,
							result.kind !== "insert" ? { kind: "other" } : { kind: "probed" }
						)
					},
					previous
				)
				break
			}
			case "check": {
				const { statement } = step
				placeStatement(
					b,
					statement,
					{
						kind: "check",
						stratum: step.stratum,
						entry: statement.result.entry,
						needs: statement.needs
					},
					previous
				)
				break
			}
		}
	}
	return finish(b, write.carriers, write.cx, params)
}

/**
 * The write oracle's baseline of a compiled write: the same program with its conservative realization as the artifact
 * an application runs, and everything read off the artifact read off that one. It rests on no evidence. No compilation
 * builds it: the write oracle does, to run beside the program (test/support/oracle/write).
 */
export const conservativeWrite = (
	program: CompiledWrite,
	options: Pick<CompileWriteOptions, "names" | "reads" | "world">
): Result.Result<CompiledWrite, CompileError> =>
	Result.flatMap(
		realizeConservative(program.frontend, {
			names: options.names,
			reads: options.reads,
			world: options.world,
			share: new StatementShare<EmittedSql>(),
			level: program.level,
			carriers: program.plan.declaring
		}),
		(write) =>
			catchRefusal((): CompiledWrite => {
				const artifact = conservativeArtifact(
					write,
					options.names.codes,
					program.placements,
					program.params
				)
				return {
					...program,
					optimized: artifact.specs,
					certificates: [],
					artifact,
					standUps: writeStandUps(artifact, program.frontend.laws, options.names.schema)
				}
			})
	)
