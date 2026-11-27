import { Result } from "effect"
import { type CompiledChange, installedEntry, type WriteEntry } from "#adapter/apply/compile.ts"
import type { ChangeForm } from "#adapter/apply/index.ts"
import { readBacks } from "#adapter/apply/readback.ts"
import type { BoundReads } from "#adapter/apply/run.ts"
import { toResult } from "#adapter/engine.ts"
import { type PageRuntime, pageRuntimeOf } from "#adapter/page/template.ts"
import type {
	Bound,
	CompiledPage,
	ReadArtifacts,
	ReadForm,
	RowsForm
} from "#adapter/reader/reader.ts"
import { paramCodecs } from "#adapter/reader/relations.ts"
import { readProgram } from "#adapter/reader/run.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import type { InstallationWitness } from "#adapter/witness/index.ts"
import { paramDomainsOf } from "#compiler/plan/catalog.ts"
import {
	type CompiledWrite,
	compileParsed,
	flightOf,
	parsedChange,
	type ParsedChangeSet,
	type ServableEntry,
	servableEntry,
	type WriteNames,
	writeAdvice
} from "#compiler/plan/change.ts"
import {
	type BindContext,
	bindGroups,
	type CallerParamDecl,
	type ClockBinding,
	type ClockSource,
	type Codebook,
	CompileError,
	Engine,
	type InstalledSource,
	noClock,
	transactionClock,
	prose,
	type QueryDesc,
	recordsReader,
	type RowDecoder,
	type SchemaArtifacts,
	type SchemaFingerprint,
	SourceLoc
} from "#compiler/plan/common.ts"
import type { Advice, IndexResolver } from "#compiler/plan/migration.ts"
import {
	compilePageOf,
	pageAdvice,
	type PageTemplate,
	type QueryTemplate,
	queryInput,
	queryState,
	readBinding,
	servedPage,
	servedSource,
	servedSpine,
	statedOrderOf
} from "#compiler/plan/read.ts"
import type { ServedSpine } from "#compiler/plan/serve.ts"

/**
 * The read-backs of the entry's artifact and `decoder` bound to their layout, once: a layout the decoder cannot bind is
 * the ChangeSet's CompileError.
 */
export const boundReads = <R>(
	entry: WriteEntry,
	decoder: RowDecoder<R>
): Result.Result<BoundReads<R>, CompileError> => {
	const runs = entry.readBacks
	const read = bindGroups(decoder, (form) => recordsReader(form, [runs.layout], entry.bind))
	return read.ok ? Result.succeed({ runs, read: read.value }) : Result.fail(read.error)
}

/**
 * The forms of a login's compile: a query's rows form and read form, an ordered query's page template, and a
 * ChangeSet's change form, each compiled for one role (adapter/served/login.ts). Compile time only.
 *
 * The evidence context every read's template is compiled for.
 */
const context = "snapshot"

/**
 * The template of a query compiled for `role`, with the parameters `clock` binds to the database's clock, its readings
 * of it counting from `source`, and the program its rows are delivered through (run.ts), whose attachments the analysis
 * describes (analysis.ts), with the codecs of the parameters a call supplies. The caller's value is parsed here, once
 * (program/compile.ts queryInput), and the compiler takes the parsed query.
 */
const compileArtifacts = (
	role: RoleContext,
	query: unknown,
	clock: ClockBinding,
	source: ClockSource
): Result.Result<ReadArtifacts, CompileError> =>
	Result.map(
		toResult(
			Engine.flatMap(queryInput(query), (input) =>
				role.compile(input, { context, read: "rows", clock, source })
			)
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
const bindArtifacts = <A>(
	role: RoleContext,
	compiled: ReadArtifacts,
	decoder: () => RowDecoder<A>
): Result.Result<Bound<A>, CompileError> =>
	Result.map(
		toResult(
			bindGroups(decoder(), (form) => recordsReader(form, compiled.program.layouts, role.bind))
		),
		(read) => ({
			compiled,
			read
		})
	)

/**
 * The rows form of `query` for `role`, the parameters `clock` names bound to the database's clock, its readings of it
 * counting from `source`, its rows read by `decoder`: a query that does not compile is its CompileError. A query whose
 * member binds no parameter to the clock reads none, and compiles under the transaction's clock wherever it is served.
 */
export const compileRowsForm = <A>(
	role: RoleContext,
	query: unknown,
	decoder: () => RowDecoder<A>,
	clock: ClockBinding,
	source: ClockSource
): Result.Result<RowsForm<A>, CompileError> =>
	Result.gen(function* () {
		const compiled = yield* compileArtifacts(role, query, clock, source)
		const bound = yield* bindArtifacts(role, compiled, decoder)
		return { query, decoder, bound }
	})

/**
 * The read form of a paged member's ordered query for `role`, its rows read by `decoder` (compileRowsForm) and its
 * page template compiled beside them (compiledPageTemplate): a query that does not compile is its CompileError.
 */
export const compileReadForm = <A>(
	role: RoleContext,
	query: unknown,
	decoder: () => RowDecoder<A>
): Result.Result<ReadForm<A>, CompileError> =>
	Result.gen(function* () {
		const rows = yield* compileRowsForm(role, query, decoder, noClock, transactionClock)
		const page = yield* compiledPageTemplate(role, query)
		return { ...rows, page }
	})

/** What a page's template compiles from: the query template compiled with read "page", its Description and artifacts. */
interface PageTemplateInput {
	readonly template: QueryTemplate
	readonly desc: QueryDesc
	readonly artifacts: SchemaArtifacts
	/** How the installation behind `artifacts` resolves each read's index (served/role.ts RoleContext `resolve`). */
	readonly resolve: IndexResolver
}

/**
 * The page runtime template of a query template compiled for a page: its page compiled (lower/shapes/page/compile.ts)
 * over the stated order, served with every statement's spec emitted (engine program/served.ts servedPage), and run as a
 * served page runs (page/template.ts pageRuntimeOf).
 */
const pageTemplateFor = (input: PageTemplateInput): Result.Result<PageRuntime, CompileError> =>
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
	const { template, desc, artifacts, resolve } = input
	return Result.gen(function* () {
		/** The location compileQuery checks the template's Description at (program/compile.ts, label "query"). */
		const stated = yield* toResult(statedOrderOf(desc, SourceLoc("query", [])))
		const compiled = yield* toResult(
			compilePageOf(template.programs, {
				stated,
				names: artifacts.reads,
				binding: readBinding(artifacts)
			})
		)
		const runtime = compiledPageRuntime({
			page: compiled,
			params: template.params,
			codes: artifacts.names.codes,
			spine: servedSpine(desc),
			advice: pageAdvice(compiled, resolve)
		})
		return { runtime, template: compiled }
	})
}

/** A compiled page and what its runtime is built from: its read's parameters and spine, and its codes. */
interface CompiledPageParts {
	readonly page: PageTemplate
	readonly params: ReadonlyArray<CallerParamDecl>
	readonly codes: Codebook
	readonly spine: ServedSpine
	/** What its transaction is planned under (engine program/served.ts pageAdvice). */
	readonly advice: Advice
}

/**
 * The runtime of a compiled page: served with its statements' specs emitted under its codes (engine program/served.ts
 * servedPage), then run as a served page runs (page/template.ts pageRuntimeOf).
 */
export const compiledPageRuntime = (parts: CompiledPageParts): PageRuntime =>
	pageRuntimeOf({
		page: servedPage(parts.page, parts.codes, parts.advice),
		params: parts.params,
		codes: parts.codes,
		spine: parts.spine
	})

/**
 * The page template of an ordered query compiled for a role, or the refusal of a query read inside its attachment, or
 * its CompileError: what generate's compile of a paged member holds for its ordered query.
 */
const compiledPageTemplate = (
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
					read: "page",
					clock: noClock,
					source: transactionClock
				})
			)
		),
		({ compiled, artifacts }) =>
			Result.map(
				pageTemplateFor({
					template: compiled.template,
					desc: compiled.desc,
					artifacts,
					resolve: role.resolve
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
 * The runtime's entry of a ChangeSet compiled for a role (program/workload/change.ts ChangeEntry), built once over it
 * under the installation's codes `codes`: its program as an application runs it, its read-backs and its parameters'
 * codecs, beside the witness decoding of the artifacts it compiled against, which reads a refusal by its parameters'
 * pattern domains as theirs (InstallationWitness.declaring), and the role's bind context.
 */
export const runtimeEntry = (
	entry: ServableEntry<InstalledSource>,
	codes: Codebook,
	witness: InstallationWitness,
	bind: BindContext,
	resolve: IndexResolver
): CompiledEntry =>
	installedEntry(entry, ({ compiled, schema, names, change }) => ({
		program: flightOf(compiled, codes, writeAdvice(compiled, resolve)),
		compiled,
		schema,
		names,
		witness: witness.declaring(paramDomainsOf(compiled.params)),
		readBacks: readBacks(compiled.readBacks, codes),
		codecs: paramCodecs(compiled.params, codes),
		bind,
		change
	}))

/**
 * A ChangeSet compiled now for a role (compiledWrite): its runtime's entry, which holds its write servable
 * (write/program/compile.ts ServableWrite), and its compiled write whole, with the front end, schedule, placements and
 * put choices a write oracle reads of it.
 */
export interface CompiledProgram {
	readonly entry: CompiledEntry
	readonly program: CompiledWrite
}

/** The program entry of a ChangeSet for a role, compiled now for the contexts `claims` holds a fact of, against the
 * role's artifacts (served/role.ts RoleContext `artifacts`, `witness`). */
const writeEntry = (
	role: RoleContext,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Result.Result<CompiledProgram, CompileError> =>
	Result.map(
		toResult(compileParsed(role.artifacts, change, claims, "serializable", noClock, role.clock)),
		(entry) => ({
			entry: runtimeEntry(
				servableEntry(entry),
				role.artifacts.names.codes,
				role.witness,
				role.bind,
				role.resolve
			),
			program: entry.compiled
		})
	)

/**
 * A ChangeSet value compiled for a role and the contexts `claims` holds a fact of, as a test's Db compiles it for the
 * Db's claims: its runtime's entry and its compiled write whole (CompiledProgram).
 */
export const compiledWrite = (
	role: RoleContext,
	changes: unknown,
	claims: ReadonlySet<string>
): Result.Result<CompiledProgram, CompileError> =>
	Result.flatMap(toResult(parsedChange(role.schema, changes)), (change) =>
		writeEntry(role, change, claims)
	)

/**
 * The change form of a compiled ChangeSet, its reads decoder `decoder` bound to its read-backs' layout (boundReads): a
 * decoder that cannot bind is the ChangeSet's CompileError.
 */
export const boundChangeForm = <R>(
	compiled: CompiledEntry,
	decoder: RowDecoder<R>
): Result.Result<ChangeForm<R>, CompileError> =>
	Result.map(boundReads(compiled, decoder), (bound): ChangeForm<R> => ({
		entry: compiled,
		bound,
		decoder
	}))
