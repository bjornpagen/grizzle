import * as Result from "@bjornpagen/grizzle-text/base/result"
import { CompileError, prose } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type ClockSource, noClock, transactionClock } from "#compiler/ir/clock.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import {
	compilePageOf,
	type PageTemplate,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
import { readBinding } from "#compiler/program/compile.ts"
import { type ParsedRole, queryInput } from "#compiler/program/input.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { pagePlans, readPlans } from "#compiler/program/served.ts"
import {
	type CompiledTemplate,
	type ExecutionRequest,
	templateFor
} from "#compiler/program/template.ts"
import type { ReadDesc, WorkloadProgram } from "#compiler/program/workload/value.ts"
import { queryState } from "#compiler/query/build/state.ts"
import type { ReadPlan } from "#compiler/sql/plan.ts"

/**
 * How a read member's rows compile (program/template.ts ExecutionRequest): in the snapshot context a served read runs
 * in, as rows, a clocked read's parameters bound to the database's clock, its readings counting from `source`, its
 * login's; any other read binds none and reads no clock, so it compiles under the transaction's clock wherever it is
 * served.
 */
export const rowsRequest = (desc: ReadDesc, source: ClockSource): ExecutionRequest =>
	desc.kind === "clocked"
		? { context: "snapshot", read: "rows", clock: desc.clock, source }
		: { context: "snapshot", read: "rows", clock: noClock, source: transactionClock }

/** How a paged member's page compiles: its ordered query read as pages, which no clock reads. */
export const pageRequest: ExecutionRequest = {
	context: "snapshot",
	read: "page",
	clock: noClock,
	source: transactionClock
}

/** A query compiled for a request, with the artifacts it was compiled against, which its page reads. */
export interface ReadTemplate {
	readonly compiled: CompiledTemplate
	readonly artifacts: SchemaArtifacts
}

/** How a read's query is compiled for a request: against a role and its artifacts (program/template.ts templateFor). */
export type ReadCompile = (
	query: unknown,
	request: ExecutionRequest
) => Result.Result<ReadTemplate, CompileError>

/**
 * A paged member's page: its ordered query compiled for pages by `compile` and its page template compiled over the
 * stated order (lower/shapes/page/compile.ts compilePageOf), or the refusal of a query read inside its attachment, which
 * no page serves; what generate's workload plan reads the plans of and a served file serves.
 */
export const pagedTemplate = (
	query: unknown,
	compile: ReadCompile
): Result.Result<ReadTemplate & { readonly page: PageTemplate }, CompileError> => {
	if ((queryState(query)?.pending.size ?? 0) > 0) {
		return Result.err(
			CompileError.make(
				prose(
					"AttachedPage",
					SourceLoc("page", []),
					"a page over a query read by an attachment: its rules read a parent variable, and a long child list is its own top-level query keyed by the parent"
				)
			)
		)
	}
	return Result.flatMap(compile(query, pageRequest), (read) =>
		Result.map(pageOf(read), (page) => ({ ...read, page }))
	)
}

/** The page template of a query compiled for pages, over the order its Description states (statedOrderOf). */
export const pageOf = (read: ReadTemplate): Result.Result<PageTemplate, CompileError> => {
	const { compiled, artifacts } = read
	/** The location compileQuery checks the template's Description at (program/compile.ts, label "query"). */
	const checkedAt = SourceLoc("query", [])
	return Result.flatMap(statedOrderOf(compiled.desc, checkedAt), (stated) =>
		compilePageOf(compiled.template.programs, {
			stated,
			names: artifacts.reads,
			binding: readBinding(artifacts)
		})
	)
}

/** A read member of a workload: every program but a ChangeSet. */
export type ReadMember = Exclude<WorkloadProgram, { readonly kind: "changeSet" }>

/** A read member that pages none: a query, an ordered query, or a key's lookup. */
export type RowsMember = Exclude<ReadMember, { readonly kind: "paged" }>

/**
 * A read member compiled for a role over its artifacts, once (compiledRead), with the member: its rows' statement
 * (`rows`), a query's, an ordered query's or a key's lookup, and a paged member's page besides (`paged`), its ordered
 * query compiled for pages and its every window (pagedTemplate). What generate's workload plan reads the plans of
 * (readPlansOf), which the installation asks its indexes for, and what the role's served form is projected from
 * (adapter/served/login.ts), advised by the indexes the installation then holds: the snapshot resolves a read's index,
 * and no read compiles again for its served file.
 */
export type CompiledRead =
	| { readonly kind: "rows"; readonly member: RowsMember; readonly rows: ReadTemplate }
	| {
			readonly kind: "paged"
			readonly member: Extract<ReadMember, { readonly kind: "paged" }>
			readonly rows: ReadTemplate
			readonly page: ReadTemplate & { readonly page: PageTemplate }
	  }

/**
 * `member` compiled for `role` over its artifacts `artifacts`, its clocked readings counting from `source` (rowsRequest),
 * as its served form reads it (CompiledRead): a read that does not compile is its CompileError.
 */
export const compiledRead = (
	member: ReadMember,
	role: ParsedRole,
	artifacts: SchemaArtifacts,
	source: ClockSource
): Result.Result<CompiledRead, CompileError> => {
	const compile: ReadCompile = (query, request) =>
		Result.flatMap(queryInput(query), (input) =>
			Result.map(templateFor(input, role, artifacts, request), (compiled) => ({
				compiled,
				artifacts
			}))
		)
	const rowsOf = (rowsMember: RowsMember, query: unknown) =>
		Result.map(compile(query, rowsRequest(rowsMember.desc, source)), (rows): CompiledRead => ({
			kind: "rows",
			member: rowsMember,
			rows
		}))
	switch (member.kind) {
		case "query":
		case "ordered":
			return rowsOf(member, member.value)
		case "key":
			return rowsOf(member, member.query)
		case "paged":
			return Result.flatMap(compile(member.value, rowsRequest(member.desc, source)), (rows) =>
				Result.map(pagedTemplate(member.value, compile), (page): CompiledRead => ({
					kind: "paged",
					member,
					rows,
					page
				}))
			)
	}
}

/**
 * The plan of every statement a compiled read's served form may send (CompiledRead): its rows' (served/forms.ts
 * ServedRead), and a paged member's every window's besides (ServedPage). What the installation asks an index for each
 * read of, so a read no index serves is a missed index of the generate that plans it, and nothing else asks one for it
 * (sql/plan.ts planRequests).
 */
export const readPlansOf = (read: CompiledRead): ReadonlyArray<ReadPlan<AccessIndexRequest>> => {
	switch (read.kind) {
		case "rows":
			return readPlans(read.rows.compiled.template)
		case "paged":
			return [...readPlans(read.rows.compiled.template), ...pagePlans(read.page.page)]
	}
}
