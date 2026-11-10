import { type AdmittedQuery, checkQuery } from "#compiler/check/index.ts"
import { catchCompileError, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeDesc, isOrderedQuery, type QueryDesc } from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { ProgramArtifacts, LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type { Heading, RootedDag } from "#compiler/ir/rel.ts"
import { analyzeLogical, queryEvidence } from "#compiler/logical/annotate.ts"
import { flight, type ProgramDelivery } from "#compiler/lower/conservative/types.ts"

import {
	lowerOptimized,
	type OptimizedProgram,
	optimizedInput
} from "#compiler/lower/optimize/pipeline.ts"

import {
	type SpecifiedArtifact,
	type SpecifiedForm,
	type SpecifiedStatement,
	specifiedStatements,
	statementSpec
} from "#compiler/lower/template.ts"
import {
	levelSchema,
	parseSchemaInput,
	type SchemaArtifacts,
	type SchemaInput,
	schemaCatalog
} from "#compiler/program/schema.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { publicDesc, queryState } from "#compiler/query/build/state.ts"
import { declaredSlotOf } from "#compiler/runtime/lower/slots.ts"
import { mapTree } from "#compiler/runtime/lower/tree.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"

export interface QueryTemplate extends ProgramArtifacts {
	readonly kind: "query" | "ordered"
	/** The public result heading. */
	readonly heading: Heading
	readonly params: ReadonlyArray<ParamDecl>
	/** How the runtime delivers the result. */
	readonly delivery: ProgramDelivery
	/**
	 * The optimized lowering, its statements' ASTs included, for inspection, an optimized statement's large form holding
	 * its spec; and the checked query it lowers, each attachment judged (rel.ts Attach judged), which a page's order is
	 * completed over.
	 */
	readonly programs: {
		readonly optimized: OptimizedProgram<SpecifiedForm>
		readonly checked: LogicalQuery
	}
	/**
	 * The optimized artifact as the runtime binds, sends and decodes it: its statements, each with the spec emitted from
	 * it, of which `optimized` is the specs.
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
	/** The schema's artifacts: its installed names, law model and evidence catalog (program/schema.ts). */
	readonly artifacts: SchemaArtifacts
}

/**
 * A query as the compiler takes it, parsed once at the facade that received it (queryInput): a query or ordered value
 * the builder made over a schema or a role, with that value parsed (program/schema.ts parseSchemaInput); or a bare
 * Description, which carries none and compiles against the schema the caller names.
 */
export type QueryInput =
	| { readonly kind: "built"; readonly desc: QueryDesc; readonly schema: SchemaInput }
	| { readonly kind: "described"; readonly desc: QueryDesc }

/**
 * The parse of a caller's query value, the one door from `unknown`: the Description of a query or ordered value with
 * the schema it was built over, or a QueryDesc given directly. A value the builder did not make is the caller's, read
 * once at the builder's boundary (query/build/host.ts hostArguments) before it is decoded, so one whose reading throws
 * is refused as MalformedDescription, never a defect.
 */
export const queryInput = (query: unknown): Result.Result<QueryInput, CompileError> => {
	const built = queryState(query)
	if (built !== undefined) {
		return Result.flatMap(
			catchCompileError(() => publicDesc(built, "query")),
			(desc) =>
				Result.map(parseSchemaInput(built.schema.over.value), (schema): QueryInput => ({
					kind: "built",
					desc,
					schema
				}))
		)
	}
	return Result.flatMap(
		catchCompileError(() => hostArguments("compile", [query])),
		() =>
			Result.map(decodeDesc("query", query), (desc): QueryInput => ({ kind: "described", desc }))
	)
}

/**
 * The schema a query compiles against: for a query value the caller names no schema for, the one it was built over;
 * otherwise the one the caller names, parsed where it was given, which a query value's own schema must be a level of
 * (levelSchema). A bare Description carries no schema and compiles against the named one.
 */
const schemaOfInput = (
	input: QueryInput,
	named: SchemaInput | undefined
): Result.Result<SchemaInput, CompileError> => {
	switch (input.kind) {
		case "built":
			return named === undefined
				? Result.ok(input.schema)
				: levelSchema(input.schema, named, SourceLoc("compile", []))
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
 * Compiling a query into its template.
 *
 * A template is compiled for one execution context, `snapshot` (Db reads, which may rely on lawful committed-snapshot
 * evidence) or `transaction` (inside a write transaction, as read-backs are, immediate evidence only), and every
 * execution of it runs in that context. It carries the optimized lowering (lower/optimize/pipeline.ts), whose rewrites
 * rest on the evidence the context admits. The conservative lowering, which relies on no evidence at all, is the test
 * kernel's oracle baseline (test/support/oracle/verify), built from the template's checked query there and never here.
 *
 * The template records what it rests on: its certificates, each naming the constraint premises its proof uses and the
 * evidence context it needs, from the schema's catalog (program/schema.ts schemaCatalog). No parameter value enters a
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
	const checkedQuery = checkQuery(read, source.desc, { read: options.read, label: "query" })
	if (!checkedQuery.ok) {
		return checkedQuery
	}
	const checked = checkedQuery.value
	const analyzed = analyzeLogical(checked.dag, {
		context,
		containments: artifacts.laws.theory.evidence.containments,
		keyedViews: true
	})
	if (!analyzed.ok) {
		return analyzed
	}
	/**
	 * The checked query with each attachment judged as the template's analysis judges it (rel.ts Attach judged): what
	 * the lowering takes, so every Attach node of its program carries the delivered type the reader delivers.
	 */
	const judged: AdmittedQuery = { ...checked, dag: analyzed.value.judged }
	/**
	 * The query as the optimized lowering takes it (optimizedInput), annotated under the query's evidence, the
	 * checker's with the keys of the views it reads (logical/annotate.ts queryEvidence).
	 */
	const rewritten = optimizedInput(judged, queryEvidence)
	if (!rewritten.ok) {
		return rewritten
	}
	const lowered = lowerOptimized(rewritten.value, {
		names: artifacts.reads,
		subject: { kind: "query" },
		catalog: schemaCatalog(artifacts),
		context
	})
	if (!lowered.ok) {
		return lowered
	}
	const optimized = lowered.value
	const codes = artifacts.reads.codes
	const optimizedSpecs = specifiedStatements(optimized.roots, codes)
	if (!optimizedSpecs.ok) {
		return optimizedSpecs
	}
	/** Each statement's large form with the spec emitted from it. */
	const specified = catchRefusal(() =>
		mapTree(optimizedSpecs.value, ({ statement: s, spec }): SpecifiedStatement => {
			const forms = s.forms
			if (forms.kind === "one") {
				return { statement: { ...s, forms }, spec }
			}
			const large = statementSpec(forms.large, declaredSlotOf(codes, new CompilePatterns()))
			if (!large.ok) {
				throw new Refusal(large.error)
			}
			return {
				statement: {
					...s,
					forms: { ...forms, large: { statement: forms.large, spec: large.value } }
				},
				spec
			}
		})
	)
	if (!specified.ok) {
		return specified
	}
	const template: QueryTemplate = {
		kind: isOrderedQuery(source.desc) ? "ordered" : "query",
		context,
		optimized: flight(specified.value).map((run) => run.spec),
		certificates: optimized.certificates,
		heading: checked.dag.roots[0].heading,
		params: checked.params,
		delivery: optimized.delivery,
		programs: {
			optimized: { ...optimized, roots: mapTree(specified.value, (run) => run.statement) },
			checked: judged
		},
		run: { delivery: optimized.delivery, roots: specified.value },
		analyzed: analyzed.value.dag
	}
	return Result.ok(template)
}
