import { Result } from "effect"
import type { CompiledChange, WriteEntry } from "#adapter/apply/compile.ts"
import type { ChangeForm } from "#adapter/apply/index.ts"
import { readBacks } from "#adapter/apply/readback.ts"
import { boundReads } from "#adapter/apply/run.ts"
import type { RoleContext } from "#adapter/db/context.ts"
import { toResult } from "#adapter/engine.ts"
import type { CompiledPage, PageSource } from "#adapter/page/page.ts"
import { pageTemplateFor } from "#adapter/page/template.ts"
import { attachmentHeads } from "#adapter/reader/analysis.ts"
import { getEligibility } from "#adapter/reader/eligibility.ts"
import type { Bound, ReadArtifacts, ReadForm, RowsForm } from "#adapter/reader/reader.ts"
import { paramCodecs } from "#adapter/reader/relations.ts"
import { templateProgram } from "#adapter/reader/run.ts"
import { compileWrite, parseChangeSet, type ParsedChangeSet } from "#compiler/plan/change.ts"
import {
	bindGroups,
	CompileError,
	Engine,
	levelSchema,
	malformedDescription,
	parseSchemaInput,
	prose,
	type RowDecoder,
	SourceLoc
} from "#compiler/plan/common.ts"
import { isOrderedValue, queryInput, queryState } from "#compiler/plan/read.ts"

/**
 * The forms of a login's compile: a query's rows form and read form, an ordered query's page template, and a
 * ChangeSet's change form, each compiled for one role (adapter/served/login.ts). Compile time only.
 *
 * The evidence context every read's template is compiled for.
 */
const context = "snapshot"

/**
 * The template of a query compiled for `role` and the program its rows are delivered through (run.ts), whose
 * attachments the analysis describes (analysis.ts), with its parameters' codecs. The caller's value is parsed here, once
 * (program/compile.ts queryInput), and the compiler takes the parsed query.
 */
export const compileArtifacts = (
	role: RoleContext,
	query: unknown
): Result.Result<ReadArtifacts, CompileError> =>
	Result.map(
		toResult(
			Engine.flatMap(queryInput(query), (input) => role.compile(input, { context, read: "rows" }))
		),
		({ compiled }): ReadArtifacts => ({
			compiled,
			program: templateProgram(
				compiled.template,
				attachmentHeads(compiled.desc),
				role.artifacts.names.codes
			),
			codecs: paramCodecs(compiled.template.params, role.artifacts.names.codes)
		})
	)

/**
 * A decoder bound to a compiled read's layouts under `role`'s bind context, once per template and artifact. The decoder
 * is read once the query compiled, since a JavaScript caller's value may be no query.
 */
export const bindArtifacts = <A>(
	role: RoleContext,
	compiled: ReadArtifacts,
	decoder: () => RowDecoder<A>
): Result.Result<Bound<A>, CompileError> =>
	Result.map(toResult(bindGroups(decoder(), compiled.program.layouts, role.bind)), (read) => ({
		compiled,
		read
	}))

/** The rows form of `query` for `role`, its rows read by `decoder`: a query that does not compile is its CompileError. */
export const compileRowsForm = <A>(
	role: RoleContext,
	query: unknown,
	decoder: () => RowDecoder<A>
): Result.Result<RowsForm<A>, CompileError> =>
	Result.gen(function* () {
		const compiled = yield* compileArtifacts(role, query)
		const bound = yield* bindArtifacts(role, compiled, decoder)
		return { query, decoder, bound, eligible: getEligibility(compiled.compiled.template) }
	})

/**
 * The read form of `query` for `role`, its rows read by `decoder` (compileRowsForm) and an ordered query's page
 * template compiled beside them: a query that does not compile is its CompileError.
 */
export const compileReadForm = <A>(
	role: RoleContext,
	query: unknown,
	decoder: () => RowDecoder<A>
): Result.Result<ReadForm<A>, CompileError> =>
	Result.gen(function* () {
		const rows = yield* compileRowsForm(role, query, decoder)
		const page: PageSource = isOrderedValue(query)
			? { kind: "compiled", page: yield* compiledPageTemplate(role, query) }
			: { kind: "query" }
		return { ...rows, page }
	})

/**
 * The page template of an ordered query compiled for a role, or the refusal of a query read inside its attachment, or
 * its CompileError: what a page compiles for its call, and what db.compile and the layer's workload hold for an
 * ordered query.
 */
export const compiledPageTemplate = (
	role: RoleContext,
	query: unknown
): Result.Result<CompiledPage, CompileError> => {
	if ((queryState(query)?.pending.size ?? 0) > 0) {
		return Result.fail(
			CompileError.make(
				prose(
					"AttachedPage",
					SourceLoc("page", []),
					"a page over a query read by an attachment: its rules read a parent variable, and a long child list is its own top-level query keyed by the parent"
				)
			)
		)
	}
	return Result.flatMap(
		toResult(
			Engine.flatMap(queryInput(query), (input) =>
				role.compile(input, {
					context: "snapshot",
					read: "page"
				})
			)
		),
		({ compiled, artifacts }) =>
			Result.map(
				pageTemplateFor({
					template: compiled.template,
					desc: compiled.desc,
					artifacts
				}),
				(runtime): CompiledPage => ({
					compiled,
					runtime,
					codecs: paramCodecs(compiled.template.params, role.artifacts.names.codes)
				})
			)
	)
}

/**
 * The parsed ChangeSet of a value, or the refusal of a value that is not one, or of one built over a schema that is no
 * level of the Db's schema (program/schema.ts levelSchema), before any SQL.
 */
const parsedChange = (
	role: RoleContext,
	changes: unknown
): Result.Result<ParsedChangeSet, CompileError> =>
	Result.gen(function* () {
		const change = parseChangeSet(changes)
		if (change === undefined) {
			return yield* Result.fail(
				malformedDescription(
					SourceLoc("db.apply", []),
					"a ChangeSet value built by ChangeSet.empty, union or sequence"
				)
			)
		}
		const carried = yield* toResult(parseSchemaInput(change.over.value))
		yield* toResult(levelSchema(carried, role.schema, SourceLoc("db.apply", [])))
		return change
	})

/** The program entry of a ChangeSet for a role, compiled now for the contexts `claims` holds a fact of, against the
 * role's artifacts for it (db/context.ts RoleContext.programArtifacts). */
const writeEntry = (
	role: RoleContext,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Result.Result<WriteEntry, CompileError> =>
	Result.flatMap(
		toResult(role.programArtifacts({ kind: "changeSet", changeSet: change.desc })),
		({ artifacts, witness }) => {
			const world = artifacts.world
			return Result.map(
				toResult(
					compileWrite(
						world.kind === "role" ? world.checked : artifacts.derived.schema,
						change.desc,
						{
							names: artifacts.names,
							reads: artifacts.reads,
							claims: { kind: "facts", present: claims },
							world:
								world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
							laws: artifacts.laws,
							derived: artifacts.derived
						}
					)
				),
				(program): WriteEntry => ({
					program,
					schema: artifacts.fingerprint,
					names: artifacts.names,
					violation: witness.classify,
					readBacks: readBacks(program, artifacts.names.codes),
					codecs: paramCodecs(program.params, artifacts.names.codes),
					bind: role.bind
				})
			)
		}
	)

/**
 * A ChangeSet value compiled for a role and the contexts `claims` holds a fact of: a Db's apply compiles it for the
 * Db's claims, and the layer a workload's ChangeSet once for each set of its fill contexts. Its program, compiled now,
 * and the value parsed.
 */
export const compiledWrite = (
	role: RoleContext,
	changes: unknown,
	claims: ReadonlySet<string>
): Result.Result<CompiledChange, CompileError> =>
	Result.flatMap(parsedChange(role, changes), (change) =>
		Result.map(writeEntry(role, change, claims), (entry): CompiledChange => ({
			...entry,
			change
		}))
	)

/** The change form of `changes` for `role` under `claims`: a ChangeSet that does not compile is its CompileError. */
export const compileChangeForm = <R>(
	role: RoleContext,
	changes: unknown,
	decoder: RowDecoder<R>,
	claims: ReadonlySet<string>
): Result.Result<ChangeForm<R>, CompileError> =>
	Result.flatMap(compiledWrite(role, changes, claims), (compiled) =>
		Result.map(boundReads(compiled, decoder), (bound): ChangeForm<R> => ({
			entry: compiled,
			bound
		}))
	)
