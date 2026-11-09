import { Array as Arr, Record as Rec, Result } from "effect"
import type { CompiledChange } from "#adapter/apply/compile.ts"
import type { ChangeForm } from "#adapter/apply/index.ts"
import { readBacks } from "#adapter/apply/readback.ts"
import { boundReads } from "#adapter/apply/run.ts"
import { toResult } from "#adapter/engine.ts"
import type { CompiledPage, PageSource } from "#adapter/page/page.ts"
import { type PageRuntime, pageRuntimeOf } from "#adapter/page/template.ts"
import { getEligibility } from "#adapter/reader/eligibility.ts"
import type { Bound, ReadArtifacts, ReadForm, RowsForm } from "#adapter/reader/reader.ts"
import { paramCodecs } from "#adapter/reader/relations.ts"
import { readProgram } from "#adapter/reader/run.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import { vectorExpectations } from "#compiler/plan/catalog.ts"
import {
	compileWrite,
	parseChangeSet,
	type ParsedChangeSet,
	type WriteNames
} from "#compiler/plan/change.ts"
import {
	bindGroups,
	CompileError,
	Engine,
	levelSchema,
	malformedDescription,
	parseSchemaInput,
	type Codebook,
	type ParamDecl,
	prose,
	type QueryDesc,
	type RowDecoder,
	type SchemaArtifacts,
	type SchemaFingerprint,
	SourceLoc
} from "#compiler/plan/common.ts"
import {
	compilePageOf,
	type CursorGeneration,
	isOrderedValue,
	type PageTemplate,
	pageQueryFingerprint,
	type QueryTemplate,
	queryInput,
	queryState,
	servedPage,
	servedSource,
	servedSpine,
	statedOrderOf
} from "#compiler/plan/read.ts"
import type { ServedSpine } from "#compiler/plan/serve.ts"

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
			program: readProgram(
				servedSource(compiled.template.run),
				servedSpine(compiled.desc),
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
 * The semantic generation of a schema's cursors: its fingerprint, and each extension it requires at the version
 * admission verified.
 */
const cursorGeneration = (artifacts: SchemaArtifacts): CursorGeneration => ({
	schema: artifacts.fingerprint,
	extensions: Rec.fromEntries(
		Arr.map(
			vectorExpectations(artifacts.owned, artifacts.names.vectorSchema),
			(e) => [e.extension, e.version] as const
		)
	)
})

/** What a page's template compiles from: the query template compiled with read "page", its Description and artifacts. */
interface PageTemplateInput {
	readonly template: QueryTemplate
	readonly desc: QueryDesc
	readonly artifacts: SchemaArtifacts
}

/**
 * The page runtime template of a query template compiled for a page: its page compiled (lower/shapes/page/compile.ts)
 * over the stated order, served with every statement's spec emitted (engine program/served.ts servedPage) under the
 * ordered query's semantic fingerprint (program/workload/fingerprint.ts) and its schema's cursor generation, and run as
 * a served page runs (page/template.ts pageRuntimeOf).
 */
export const pageTemplateFor = (
	input: PageTemplateInput
): Result.Result<PageRuntime, CompileError> =>
	Result.map(compiledPageTemplateFor(input), (compiled) => compiled.runtime)

/** A page's runtime beside the page template it was served from, which a bench's variants rewrite. */
export interface CompiledPageTemplate {
	readonly runtime: PageRuntime
	readonly template: PageTemplate
}

/** The page runtime of a query template compiled for a page (pageTemplateFor), with its compiled page template. */
export const compiledPageTemplateFor = (
	input: PageTemplateInput
): Result.Result<CompiledPageTemplate, CompileError> => {
	const { template, desc, artifacts } = input
	return Result.gen(function* () {
		/** The location compileQuery checks the template's Description at (program/compile.ts, label "query"). */
		const stated = yield* toResult(statedOrderOf(desc, SourceLoc("query", [])))
		const compiled = yield* toResult(
			compilePageOf(template.programs, { stated, names: artifacts.reads })
		)
		const query = yield* toResult(pageQueryFingerprint(desc, artifacts.fingerprint))
		const runtime = yield* compiledPageRuntime({
			page: compiled,
			params: template.params,
			codes: artifacts.names.codes,
			query,
			generation: cursorGeneration(artifacts),
			spine: servedSpine(desc)
		})
		return { runtime, template: compiled }
	})
}

/** A compiled page and what its runtime is built from: its read's parameters and spine, its codes and cursor identity. */
interface CompiledPageParts {
	readonly page: PageTemplate
	readonly params: ReadonlyArray<ParamDecl>
	readonly codes: Codebook
	readonly query: string
	readonly generation: CursorGeneration
	readonly spine: ServedSpine
}

/**
 * The runtime of a compiled page: served with its statements' specs emitted under its codes (engine program/served.ts
 * servedPage), then run as a served page runs (page/template.ts pageRuntimeOf).
 */
export const compiledPageRuntime = (
	parts: CompiledPageParts
): Result.Result<PageRuntime, CompileError> =>
	Result.flatMap(
		toResult(servedPage(parts.page, parts.codes, parts.query, parts.generation)),
		(page) => pageRuntimeOf({ page, params: parts.params, codes: parts.codes, spine: parts.spine })
	)

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
 * A ChangeSet's program entry as its compile made it: the runtime's entry (apply/compile.ts CompiledChange), the
 * fingerprint of the schema it was compiled against, the installed names it read, and the value parsed whole.
 */
export interface CompiledEntry extends CompiledChange {
	readonly schema: SchemaFingerprint
	readonly names: WriteNames
	readonly change: ParsedChangeSet
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
): Result.Result<CompiledEntry, CompileError> =>
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
				(program) => ({
					program,
					schema: artifacts.fingerprint,
					names: artifacts.names,
					violation: witness.classify,
					readBacks: readBacks(program, artifacts.names.codes),
					codecs: paramCodecs(program.params, artifacts.names.codes),
					bind: role.bind,
					change
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
): Result.Result<CompiledEntry, CompileError> =>
	Result.flatMap(parsedChange(role, changes), (change) => writeEntry(role, change, claims))

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
			bound,
			decoder
		}))
	)
