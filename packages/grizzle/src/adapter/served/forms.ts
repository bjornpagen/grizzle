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
	catchRefusal,
	type CallerParamDecl,
	type Codebook,
	CompileError,
	type InstalledSource,
	noClock,
	type QueryDesc,
	recordsReader,
	type RowDecoder,
	type SchemaArtifacts,
	type SchemaFingerprint
} from "#compiler/plan/common.ts"
import type { Advice, IndexResolver } from "#compiler/plan/migration.ts"
import {
	type CompiledRead,
	type CompiledTemplate,
	pageAdvice,
	pageOf,
	type PageTemplate,
	type QueryTemplate,
	type ReadTemplate,
	servedPage,
	servedSource,
	servedSpine
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
 * ChangeSet's change form, each projected for one role (adapter/served/login.ts) from what the login's workload plan
 * compiled of it (engine program/workload/compile.ts loginReads, change.ts loginChanges), none compiled here again.
 * Compile time only.
 */

/**
 * A read's rows compiled for `role` (engine program/workload/reads.ts ReadTemplate) as its served file runs them: the
 * template, the program its rows are delivered through (run.ts), whose attachments the analysis describes
 * (analysis.ts), and the codecs of the parameters a call supplies, under the role's codes.
 */
const readArtifactsOf = (role: RoleContext, rows: ReadTemplate): ReadArtifacts => ({
	compiled: rows.compiled,
	program: readProgram(
		servedSource(rows.compiled.template.run),
		servedSpine(rows.compiled.desc),
		role.artifacts.names.codes
	),
	codecs: paramCodecs(rows.compiled.template.params, role.artifacts.names.codes)
})

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
 * The rows form of `query` for `role`, from its rows as the workload plan compiled them for the role (`rows`), read by
 * `decoder`: a decoder that does not bind to their layouts is its CompileError.
 */
export const rowsFormOf = <A>(
	role: RoleContext,
	query: unknown,
	rows: ReadTemplate,
	decoder: () => RowDecoder<A>
): Result.Result<RowsForm<A>, CompileError> =>
	Result.map(bindArtifacts(role, readArtifactsOf(role, rows), decoder), (bound) => ({
		query,
		decoder,
		bound
	}))

/**
 * The read form of a paged member's ordered query for `role`, from its read as the workload plan compiled it for the
 * role (`read`): its rows form (rowsFormOf) and its page served beside them (compiledPageOf).
 */
export const readFormOf = <A>(
	role: RoleContext,
	query: unknown,
	read: Extract<CompiledRead, { readonly kind: "paged" }>,
	decoder: () => RowDecoder<A>
): Result.Result<ReadForm<A>, CompileError> =>
	Result.map(rowsFormOf(role, query, read.rows, decoder), (rows) => ({
		...rows,
		page: compiledPageOf(role, read.page)
	}))

/**
 * A paged member's page as the workload plan compiled it for `role` (engine program/workload/reads.ts pagedTemplate),
 * as its served file serves it: its page read's template, its runtime (pageRuntimeOver) advised by the indexes the
 * role's installation resolves its plans to, and its parameters' codecs, under the role's codes.
 */
const compiledPageOf = (
	role: RoleContext,
	page: ReadTemplate & { readonly page: PageTemplate }
): CompiledPage => ({
	compiled: page.compiled,
	runtime: pageRuntimeOver(page.page, page.compiled, role.artifacts.names.codes, role.resolve),
	codecs: paramCodecs(page.compiled.template.params, role.artifacts.names.codes)
})

/** What a page's template compiles from: the query template compiled with read "page", its Description and artifacts. */
interface PageTemplateInput {
	readonly template: QueryTemplate
	readonly desc: QueryDesc
	readonly artifacts: SchemaArtifacts
	/** How the installation behind `artifacts` resolves each read's index (served/role.ts RoleContext `resolve`). */
	readonly resolve: IndexResolver
}

/** A page's runtime beside the page template it was served from, which a bench's variants rewrite. */
export interface CompiledPageTemplate {
	readonly runtime: PageRuntime
	readonly template: PageTemplate
}

/**
 * The page runtime of a query template compiled for a page, with its compiled page template: its page compiled over
 * the stated order (engine program/workload/reads.ts pageOf), its runtime that page's (pageRuntimeOver).
 */
export const compiledPageTemplateFor = (
	input: PageTemplateInput
): Result.Result<CompiledPageTemplate, CompileError> => {
	const { template, desc, artifacts, resolve } = input
	const compiled = { template, desc }
	return Result.map(toResult(pageOf({ compiled, artifacts })), (page) => ({
		runtime: pageRuntimeOver(page, compiled, artifacts.names.codes, resolve),
		template: page
	}))
}

/**
 * The runtime of `page`, compiled for a query's page read `compiled`: served with its read's parameters and spine under
 * `codes`, its transaction planned under the advice `resolve` gives its plans (engine program/served.ts pageAdvice), a
 * read through an index the installation does not hold thrown as its refusal where the advice resolves it
 * (compiledPageRuntime).
 */
const pageRuntimeOver = (
	page: PageTemplate,
	compiled: CompiledTemplate,
	codes: Codebook,
	resolve: IndexResolver
): PageRuntime =>
	compiledPageRuntime({
		page,
		params: compiled.template.params,
		codes,
		spine: servedSpine(compiled.desc),
		advice: pageAdvice(page, resolve)
	})

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
 * role's artifacts (served/role.ts RoleContext `artifacts`, `witness`): refused as UninstalledIndex where its advice
 * reads through an index the role's snapshot does not hold (deploy/snapshot/served.ts snapshotResolver). */
const writeEntry = (
	role: RoleContext,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Result.Result<CompiledProgram, CompileError> =>
	Result.flatMap(
		toResult(compileParsed(role.artifacts, change, claims, "serializable", noClock, role.clock)),
		(entry) =>
			toResult(
				catchRefusal(() => ({
					entry: runtimeEntry(
						servableEntry(entry),
						role.artifacts.names.codes,
						role.witness,
						role.bind,
						role.resolve
					),
					program: entry.compiled
				}))
			)
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
