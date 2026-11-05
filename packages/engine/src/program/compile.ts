import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { catchCompileError, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Budgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import { decodeDesc, isOrderedQuery, type QueryDesc } from "#compiler/ir/desc.ts"
import { contextAdmits, type TemplateContext } from "#compiler/ir/evidence.ts"
import type { ProgramArtifacts, LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type { Heading, RootedDag } from "#compiler/ir/rel.ts"
import { analyzeLogical, queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	type ConservativeProgram,
	conservativeInput,
	type DeclaredParamSlot,
	flight,
	mapTree,
	type ProgramDelivery
} from "#compiler/lower/conservative/types.ts"

import {
	lowerOptimized,
	type OptimizedProgram,
	optimizedInput
} from "#compiler/lower/optimize/pipeline.ts"

import { deliveredAsOptimized, type RelationChoice } from "#compiler/lower/shapes/index.ts"

import {
	declaredSlotOf,
	type SpecifiedArtifact,
	type SpecifiedForm,
	type SpecifiedStatement,
	specifiedStatements,
	statementSpec,
	templateNameMap
} from "#compiler/lower/template.ts"
import { queryExtensionPremise } from "#compiler/physical/vector/premise.ts"
import {
	levelSchema,
	parseSchemaInput,
	type SchemaArtifacts,
	type SchemaInput,
	schemaCatalog
} from "#compiler/program/schema.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import {
	isOrderedValue,
	isQueryValue,
	queryValueDesc,
	queryValueSchema
} from "#compiler/query/build/query.ts"

export interface QueryTemplate extends ProgramArtifacts {
	readonly kind: "query" | "ordered"
	/** The public result heading. */
	readonly heading: Heading
	readonly params: ReadonlyArray<ParamDecl>
	/** The weakest execution context whose evidence covers every certificate of the optimized artifact. */
	readonly requiredContext: TemplateContext
	/** How the runtime delivers the result, the same for both artifacts. */
	readonly delivery: ProgramDelivery
	/**
	 * Both lowered programs, their statements' ASTs included, for per-execution VALUES specialization
	 * and inspection; an optimized statement's large form holds its spec.
	 */
	readonly programs: {
		readonly optimized: OptimizedProgram<SpecifiedForm>
		readonly conservative: ConservativeProgram
		readonly checked: LogicalQuery
	}
	/**
	 * Each artifact as the runtime binds, sends and decodes it: its statements, each with the spec emitted from it, of
	 * which `optimized` and `conservative` are the specs, a conservative statement read as an optimized one.
	 */
	readonly runs: {
		readonly optimized: SpecifiedArtifact
		readonly conservative: SpecifiedArtifact
	}
	/**
	 * The checked query's DAG annotated under the template's evidence: its context, the schema's containments, its
	 * relations' declared keys and its derived relations' inherited keys. The reader reads the root's cardinality and
	 * every attachment's delivered type here (adapter/reader/analysis.ts).
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
	/**
	 * The resource bounds one meter holds the whole compilation to: core/policy.ts compileBudgets in production, a smaller
	 * one where a test drives a bound.
	 */
	readonly budgets: Budgets
}

/**
 * A query as the compiler takes it, parsed once at the facade that received it (queryInput): a query or ordered value
 * the builder made over a schema, with that schema parsed (program/schema.ts parseSchemaInput); or a bare Description,
 * or a query value rebuilt from one without a schema, which carries none and compiles against the schema the caller
 * names.
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
	if (isQueryValue(query) || isOrderedValue(query)) {
		return Result.flatMap(
			catchCompileError(() => queryValueDesc(query)),
			(desc) => {
				if (desc === undefined) {
					return Result.err(
						malformedDescription(SourceLoc("compile", []), "a query value the builder made")
					)
				}
				const carried = queryValueSchema(query)
				return carried === undefined
					? Result.ok<QueryInput>({ kind: "described", desc })
					: Result.map(parseSchemaInput(carried), (schema): QueryInput => ({
							kind: "built",
							desc,
							schema
						}))
			}
		)
	}
	return Result.flatMap(
		catchCompileError(() => hostArguments("compile", [query])),
		() =>
			Result.map(decodeDesc("query", query), (desc): QueryInput => ({ kind: "described", desc }))
	)
}

/** The weakest execution context that admits every certificate's evidence context. */
const certificatesContext = (certificates: ReadonlyArray<Certificate>): TemplateContext =>
	certificates.every((c) => contextAdmits("transaction", c.context)) ? "transaction" : "snapshot"

/**
 * The conservative artifact, charged to the compilation's meter: each statement's text at that statement (exceeding a
 * compiler resource bound yields a source-located error).
 */
const conservativeArtifact = (
	checked: LogicalQuery,
	artifacts: SchemaArtifacts,
	meter: BudgetMeter
): Result.Result<ConservativeProgram, CompileError> => {
	const lowering = new BudgetMeter({
		fields: meter.limit("fields"),
		params: meter.limit("params"),
		variants: meter.limit("variants"),
		sqlBytes: Number.MAX_SAFE_INTEGER
	})
	const at = (path: ReadonlyArray<string | number>): SourceLoc =>
		SourceLoc("conservative artifact", path)
	for (const kind of ["fields", "params", "variants"] as const) {
		lowering.charge(kind, meter.used(kind), at([]))
	}
	return Result.flatMap(
		lowerConservative(conservativeInput(checked), {
			names: artifacts.reads,
			params: checked.params,
			subject: { kind: "query" },
			meter: lowering
		}),
		(program) => {
			for (const [i, s] of flight(program.roots).entries()) {
				const charged = meter.chargeSql(s.sql.text, at(["statements", i, s.role.kind]))
				if (!charged.ok) {
					return Result.err(charged.error)
				}
			}
			return Result.ok(program)
		}
	)
}

/**
 * The schema a query compiles against: for a query value the caller names no schema for, the one it was built over;
 * otherwise the one the caller names, parsed where it was given, which a query value's own schema must be a level of
 * (levelSchema). A bare Description, or a query rebuilt from one, carries no schema and compiles against the named one.
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
							"the query's schema: a query rebuilt from its Description without one, or a bare Description, compiles against a schema the caller names"
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
 * Compiling a query into its template: two artifacts per template.
 *
 * A template is compiled for one execution context, `snapshot` (Db reads, which may rely on lawful committed-snapshot
 * evidence) or `transaction` (inside a write transaction, as read-backs are, immediate evidence only). It
 * carries two artifacts of the same query: the optimized lowering (lower/optimize/pipeline.ts), whose rewrites rest on
 * the evidence the context admits, and the conservative lowering, the oracle baseline that relies on no evidence at
 * all. Both lower one query to one delivery, so whichever runs decodes the same public result (the test kernel's
 * verification checks their alignment, test/support/oracle/verify). An execution context weaker
 * than the one a template was compiled for runs its conservative artifact, or the caller recompiles (context.ts).
 *
 * The template records what it rests on: its certificates, each naming the constraint premises its proof uses, from the
 * schema's catalog (program/schema.ts schemaCatalog); and the evidence context its certificates need. No parameter
 * value enters a template.
 *
 * The template of a query's source (querySchema), whose artifacts `options` carries.
 */
export const compileQuery = (
	source: QuerySource,
	options: CompileQueryOptions
): Result.Result<QueryTemplate, CompileError> => {
	const { context, artifacts } = options
	/** One meter bounds the whole compilation: the checker and both artifacts. */
	const meter = new BudgetMeter(options.budgets)
	/** The checked schema the query is checked against, its artifacts' own: a role's, over its base, or reality's. */
	const read = artifacts.world.kind === "role" ? artifacts.world.checked : artifacts.derived.schema
	const checkedQuery = checkQuery(read, source.desc, {
		read: options.read,
		meter,
		label: "query"
	})
	if (!checkedQuery.ok) {
		return checkedQuery
	}
	const checked = checkedQuery.value
	const conservativeArtifactOf = conservativeArtifact(checked, artifacts, meter)
	if (!conservativeArtifactOf.ok) {
		return conservativeArtifactOf
	}
	const conservative = conservativeArtifactOf.value
	/**
	 * The query as the optimized lowering takes it (optimizedInput), annotated under the query's evidence, the
	 * checker's with the keys of the views it reads (logical/annotate.ts queryEvidence). The conservative artifact keeps
	 * the checked DAG.
	 */
	const rewritten = optimizedInput(checked, queryEvidence)
	if (!rewritten.ok) {
		return rewritten
	}
	const analyzed = analyzeLogical(checked.dag, {
		context,
		containments: artifacts.laws.theory.evidence.containments,
		keyedViews: true
	})
	if (!analyzed.ok) {
		return analyzed
	}
	const lowered = lowerOptimized(rewritten.value, {
		names: artifacts.reads,
		subject: { kind: "query" },
		catalog: schemaCatalog(artifacts),
		context,
		meter
	})
	if (!lowered.ok) {
		return lowered
	}
	const optimized = lowered.value
	const optimizedSpecs = specifiedStatements(optimized.roots, {
		kind: "metered",
		meter,
		artifact: "optimized"
	})
	if (!optimizedSpecs.ok) {
		return optimizedSpecs
	}
	const conservativeRuns = specifiedStatements(
		deliveredAsOptimized<RelationChoice, SpecifiedForm, DeclaredParamSlot>(conservative).roots,
		{ kind: "metered", meter, artifact: "conservative" }
	)
	if (!conservativeRuns.ok) {
		return conservativeRuns
	}
	/** Each statement's large form with the spec emitted from it, charged as the optimized artifact's variants. */
	const specified = catchRefusal(() =>
		mapTree(optimizedSpecs.value, ({ statement: s, spec }, i): SpecifiedStatement => {
			const forms = s.forms
			if (forms.kind === "one") {
				return { statement: { ...s, forms }, spec }
			}
			const large = statementSpec(
				forms.large,
				{ kind: "metered", meter, artifact: "optimized variant" },
				i,
				declaredSlotOf
			)
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
	const extensionPremise = queryExtensionPremise(
		checked.dag,
		checked.params,
		artifacts.reads.vectorSchema
	)
	const template: QueryTemplate = {
		kind: isOrderedQuery(source.desc) ? "ordered" : "query",
		context,
		optimized: flight(specified.value).map((run) => run.spec),
		conservative: flight(conservativeRuns.value).map((run) => run.spec),
		requirements: {
			schema: artifacts.fingerprint,
			extensions: extensionPremise.extensions,
			extensionSchemas: extensionPremise.extensionSchemas
		},
		certificates: optimized.certificates,
		nameMap: templateNameMap(flight(optimized.roots)),
		diagnostics: optimized.diagnostics,
		heading: checked.dag.roots[0].heading,
		params: checked.params,
		requiredContext: certificatesContext(optimized.certificates),
		delivery: optimized.delivery,
		programs: {
			optimized: { ...optimized, roots: mapTree(specified.value, (run) => run.statement) },
			conservative,
			checked
		},
		runs: {
			optimized: { delivery: optimized.delivery, roots: specified.value },
			conservative: { delivery: conservative.delivery, roots: conservativeRuns.value }
		},
		analyzed: analyzed.value.dag
	}
	return Result.ok(template)
}
