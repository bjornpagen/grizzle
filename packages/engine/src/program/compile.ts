import * as Result from "@bjornpagen/grizzle-text/base/result"
import { importLabels, servedDerivations } from "#compiler/analysis/derived/served.ts"
import { clockParams, sourcedParams } from "#compiler/check/clock.ts"
import { type AdmittedQuery, checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ClockBinding, ClockSource } from "#compiler/ir/clock.ts"
import { noneWritten, servedQuery } from "#compiler/ir/derived.ts"
import { isOrderedQuery, type QueryDesc } from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import {
	type CallerParamDecl,
	type ClockParamDecl,
	callerParams,
	clockedParams,
	type LogicalQuery,
	type ProgramArtifacts
} from "#compiler/ir/products.ts"
import type { Heading, RootedDag } from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { analyzeLogical, keptNodes, queryEvidence } from "#compiler/logical/annotate.ts"
import type { ProgramDelivery } from "#compiler/lower/conservative/types.ts"
import {
	lowerOptimized,
	type OptimizedProgram,
	optimizedInput,
	type PageLowering
} from "#compiler/lower/optimize/pipeline.ts"
import { completedPageOrder, statedOrderOf } from "#compiler/lower/shapes/page/compile.ts"

import { type SpecifiedArtifact, specifiedProgram } from "#compiler/lower/template.ts"
import type { QueryInput, SchemaInput } from "#compiler/program/input.ts"
import { programSchema, type SchemaArtifacts } from "#compiler/program/schema.ts"
import type { Owned } from "#compiler/schema/own.ts"

export interface QueryTemplate extends ProgramArtifacts {
	readonly kind: "query" | "ordered"
	/** The public result heading. */
	readonly heading: Heading
	/** The declared parameters a call supplies: every one but those its member binds to the database's clock. */
	readonly params: ReadonlyArray<CallerParamDecl>
	/**
	 * The declared parameters its member binds to the database's clock, which its statement prints as the reading, cast
	 * as a placeholder of each is: none but a clocked read's.
	 */
	readonly clocked: ReadonlyArray<ClockParamDecl>
	/** How the runtime delivers the result. */
	readonly delivery: ProgramDelivery
	/**
	 * The optimized lowering, its statement's AST included, for inspection; and the checked query it lowers, each
	 * attachment judged (rel.ts Attach judged), which a page's order is completed over.
	 */
	readonly programs: {
		readonly optimized: OptimizedProgram
		readonly checked: LogicalQuery
	}
	/**
	 * The optimized artifact as the runtime binds, sends and decodes it: its statement with the spec emitted from it, of
	 * which `optimized` is the spec, and its parts.
	 */
	readonly run: SpecifiedArtifact
	/**
	 * The checked query's DAG annotated under the template's evidence: its context, the schema's containments, its
	 * relations' declared keys and its derived relations' inherited keys. The reader reads the root's cardinality here
	 * (adapter/reader/eligibility.ts); every attachment's delivered type it judges is on the lowered programs' Attach
	 * nodes (ir/rel.ts Attach judged).
	 */
	readonly analyzed: RootedDag
}

/**
 * How a template is read: as rows or as pages. Who reads it is the schema it compiles against: a role's template
 * reads the role's views, and the role's artifacts name them (program/schema.ts).
 */
export interface TemplateReading {
	readonly read: "rows" | "page"
}

export interface CompileQueryOptions extends TemplateReading {
	/** The execution context the template is compiled for. */
	readonly context: TemplateContext
	/**
	 * The parameters the query's served member binds to the database's clock (check/clock.ts clockParams), which the
	 * template's statement prints as the reading itself: none but a clocked read's.
	 */
	readonly clock: ClockBinding
	/**
	 * Where the template's readings of the clock count from (ir/clock.ts ClockSource): a moved clock's declares the
	 * clock's stated instant after the query's own parameters, which a clocked member's call states; the transaction's
	 * for every query a served file serves.
	 */
	readonly source: ClockSource
	/** The schema's artifacts: its installed names, law model and evidence catalog (program/schema.ts). */
	readonly artifacts: SchemaArtifacts
}

/**
 * The schema a query compiles against: for a query value the caller names no schema for, the one it was built over,
 * which a fragment is not, since it installs nothing; otherwise the one the caller names, parsed where it was given,
 * which a query value's own schema or fragment must be a level of, held to a role's owner's rows (programSchema). A
 * bare Description carries no schema
 * and compiles against the named one.
 */
const schemaOfInput = (
	input: QueryInput,
	named: SchemaInput | undefined
): Result.Result<SchemaInput, CompileError> => {
	switch (input.kind) {
		case "built":
			if (named !== undefined) {
				return programSchema(input.schema, named, SourceLoc("compile", []))
			}
			return input.schema.kind === "fragment"
				? Result.err(
						malformedDescription(
							SourceLoc("compile", []),
							"the query's schema: a query over a fragment compiles against a schema that lists the fragment, which the caller names"
						)
					)
				: Result.ok(input.schema)
		case "described":
			return named === undefined
				? Result.err(
						malformedDescription(
							SourceLoc("compile", []),
							"the query's schema: a bare Description carries none, and compiles against a schema the caller names"
						)
					)
				: Result.ok(named)
	}
}

/**
 * A query's Description and the schema it compiles against (schemaOfInput): what compileQuery compiles. querySchema is
 * its one maker, so a compilation never skips the level choice; the caller's value was parsed once, by queryInput.
 */
interface QuerySource {
	readonly desc: QueryDesc
	readonly schema: SchemaInput
}

/**
 * The query's Description and the schema it compiles against (schemaOfInput): the one place the choice is made, which
 * every compilation of the query goes through before compileQuery.
 */
export const querySchema = (
	input: QueryInput,
	schema: SchemaInput | undefined
): Result.Result<QuerySource, CompileError> =>
	Result.map(schemaOfInput(input, schema), (chosen): QuerySource => ({
		desc: input.desc,
		schema: chosen
	}))

/**
 * What a query read by pages is lowered as (lower/optimize/pipeline.ts PageLowering): its ordered result in the order
 * its pages compare by (lower/shapes/page/compile.ts completedPageOrder), which a window's driver is read in, and each
 * relation's unit key fields. A query whose order no page completes is lowered as a query, and the page compiler
 * refuses it with its own reason.
 */
const pageSubject = (
	checked: AdmittedQuery,
	desc: QueryDesc,
	names: PhysicalNames,
	owned: Owned
): PageLowering | { readonly kind: "query" } => {
	const root = checked.dag.roots[0]
	const stated = statedOrderOf(desc, SourceLoc("query", []))
	if (!stated.ok || root.kind !== "OrderedResult") {
		return { kind: "query" }
	}
	const completed = catchRefusal(() =>
		completedPageOrder({ checked, names, stated: stated.value }, root)
	)
	return completed.ok
		? {
				kind: "page",
				order: completed.value.order,
				unitOf: (relation) => owned.unitOf.get(relation)?.fields ?? []
			}
		: { kind: "query" }
}

/**
 * Compiling a query into its template.
 *
 * A template is compiled for one execution context, `snapshot` (Db reads, which may rely on lawful committed-snapshot
 * evidence) or `transaction` (inside a write transaction, as read-backs are, immediate evidence only), and every
 * execution of it runs in that context. It carries the optimized lowering (lower/optimize/pipeline.ts), whose rewrites
 * rest on the evidence the context admits. The conservative lowering, which relies on no evidence at all, is the test
 * kernel's oracle baseline (test/support/oracle/verify), built from the template's checked query there and never here.
 *
 * The template records what it rests on: its certificates, each naming the constraint premises its proof uses and the
 * evidence context it needs, from the schema's catalog (laws/model/catalog.ts evidenceCatalog). No parameter value enters a
 * template.
 *
 * The template of a query's source (querySchema), whose artifacts `options` carries.
 */
export const compileQuery = (
	source: QuerySource,
	options: CompileQueryOptions
): Result.Result<QueryTemplate, CompileError> => {
	const { context, artifacts } = options
	/** The checked schema the query is checked against, its artifacts' own: a role's, over its base, or reality's. */
	const read = artifacts.world.kind === "role" ? artifacts.world.checked : artifacts.derived.schema
	const session = CheckSession.own()
	const checkedQuery = checkQuery(read, source.desc, {
		read: options.read,
		label: "query",
		clock: options.clock,
		session
	})
	if (!checkedQuery.ok) {
		return checkedQuery
	}
	/** The label of each closed import the query's check built, which a served statement holds to its tables
	 * (analysis/derived/served.ts). */
	const imports = importLabels(checkedQuery.value.dag, session)
	const params = clockParams(checkedQuery.value.params, options.clock, "clocked")
	if (!params.ok) {
		return params
	}
	const checked: AdmittedQuery = {
		...checkedQuery.value,
		params: sourcedParams(params.value, options.source)
	}
	const analyzed = analyzeLogical(
		checked.dag,
		{
			context,
			containments: artifacts.laws.theory.evidence.containments,
			keyedViews: true
		},
		keptNodes([])
	)
	if (!analyzed.ok) {
		return analyzed
	}
	/**
	 * The checked query with each attachment judged as the template's analysis judges it (rel.ts Attach judged): what
	 * the lowering takes, so every Attach node of its program carries the delivered type the reader delivers.
	 */
	const judged: AdmittedQuery = { ...checked, dag: analyzed.value.judged }
	/**
	 * The judged query as the lowering reads it (ir/derived.ts servedQuery), which its optimized artifact, its pages
	 * (lower/shapes/page/compile.ts) and its conservative artifact lower: a snapshot read reads each stored derived
	 * relation's table, current at every COMMIT; a read inside a write's transaction reads through its definition each
	 * one whose holders the schema's writes may write, since the transaction may have written what that table's upkeep
	 * replaces only at its COMMIT (analysis/schema.ts CheckedSchema serves, writable).
	 */
	const rows = read.rows(context === "snapshot" ? noneWritten : read.writable)
	const served = servedQuery(judged, rows)
	servedDerivations({
		schema: read,
		rows,
		checked: judged.dag,
		served: served.dag,
		imports,
		member: "a served read"
	})
	/** The query as the optimized lowering takes it (optimizedInput), annotated under the query's evidence, the checker's
	 * with the keys of the views it reads (logical/annotate.ts queryEvidence). */
	const rewritten = optimizedInput(served, queryEvidence)
	if (!rewritten.ok) {
		return rewritten
	}
	const lowered = lowerOptimized(rewritten.value, {
		names: artifacts.reads,
		subject:
			options.read === "page"
				? pageSubject(served, source.desc, artifacts.reads, read.owned)
				: { kind: "query" },
		catalog: evidenceCatalog(artifacts),
		context
	})
	if (!lowered.ok) {
		return lowered
	}
	const optimized = lowered.value
	const run = catchRefusal(() => specifiedProgram(optimized, artifacts.reads.codes))
	if (!run.ok) {
		return run
	}
	const template: QueryTemplate = {
		kind: isOrderedQuery(source.desc) ? "ordered" : "query",
		context,
		optimized: [run.value.statement.spec],
		certificates: optimized.certificates,
		heading: checked.dag.roots[0].heading,
		params: callerParams(checked.params),
		clocked: clockedParams(checked.params),
		delivery: optimized.delivery,
		programs: { optimized, checked: served },
		run: run.value,
		analyzed: analyzed.value.dag
	}
	return Result.ok(template)
}
