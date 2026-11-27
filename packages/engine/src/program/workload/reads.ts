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
	return Result.flatMap(statedOrderOf(compiled.desc, SourceLoc("query", [])), (stated) =>
		compilePageOf(compiled.template.programs, {
			stated,
			names: artifacts.reads,
			binding: readBinding(artifacts)
		})
	)
}

/** A read member of a workload: every program but a ChangeSet. */
export type ReadMember = Exclude<WorkloadProgram, { readonly kind: "changeSet" }>

/**
 * The plan of every statement a read member's served form may send, compiled for `role` over its artifacts
 * `artifacts`, its clocked readings counting from `source` (rowsRequest): its read's (served/forms.ts ServedRead), and a
 * paged member's every window's besides (ServedPage). What the installation asks an index for each read of, so a read
 * no index serves is a missed index of the generate that plans it, and nothing else asks one for it (sql/plan.ts
 * planRequests).
 */
export const readMemberPlans = (
	member: ReadMember,
	role: ParsedRole,
	artifacts: SchemaArtifacts,
	source: ClockSource
): Result.Result<ReadonlyArray<ReadPlan<AccessIndexRequest>>, CompileError> => {
	const compile: ReadCompile = (query, request) =>
		Result.flatMap(queryInput(query), (input) =>
			Result.map(templateFor(input, role, artifacts, request), (compiled) => ({
				compiled,
				artifacts
			}))
		)
	switch (member.kind) {
		case "query":
		case "ordered":
			return Result.map(compile(member.value, rowsRequest(member.desc, source)), (read) =>
				readPlans(read.compiled.template)
			)
		case "paged":
			return Result.flatMap(compile(member.value, rowsRequest(member.desc, source)), (rows) =>
				Result.map(pagedTemplate(member.value, compile), (paged) => [
					...readPlans(rows.compiled.template),
					...pagePlans(paged.page)
				])
			)
		case "key":
			return Result.map(compile(member.query, rowsRequest(member.desc, source)), (read) =>
				readPlans(read.compiled.template)
			)
	}
}
