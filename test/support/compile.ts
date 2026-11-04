import { Array as Arr } from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import { type Budgets, compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { LogicalQuery, StatementSpec } from "#compiler/ir/products.ts"
import type { NodeOf, RelKind, RelNode } from "#compiler/ir/rel.ts"
import type { Env, LowerContext, NodeLowerer } from "#compiler/lower/conservative/context.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import {
	type LowerOptimizedOptions,
	lowerOptimized,
	type OptimizedProgram
} from "#compiler/lower/optimize/pipeline.ts"
import { catalogLowerers } from "#compiler/lower/shapes/catalog/native.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"

import {
	compileQuery,
	type QueryTemplate,
	queryInput,
	querySchema
} from "#compiler/program/compile.ts"

import {
	parseSchemaInput,
	type SchemaArtifacts,
	type SchemaInput,
	schemaArtifacts,
	schemaCatalog
} from "#compiler/program/schema.ts"

import {
	compileWorkload,
	type LoginWorkloads,
	type WorkloadPlan
} from "#compiler/program/workload/compile.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import type { CompileWriteOptions } from "#compiler/write/program/compile.ts"
import { checkedLowering, templateLowering } from "#test/support/oracle/verify/index.ts"

/**
 * A query compiled the way the runtime compiles it, for tests that compile a query directly: its schema's artifacts
 * (installed under `schemaIdent`, with the vector extension in `vectorSchema`, when the test installs under names of
 * its own), for the context, read as rows or a page as the options state; testCompile states the runtime's own, and a
 * test spreads it with what it changes. A query over a role is checked against that role, as the runtime checks it.
 *
 * How a test compiles a query: for a template context, read as rows or a page, its schema installed under
 * `schemaIdent` with the vector extension in `vectorSchema` (undefined: the declared schema's own names, as
 * schemaArtifacts takes them). Every field is stated: testCompile states the runtime's own, and a test spreads it with
 * what it changes.
 */
export interface TestCompileOptions {
	readonly context: TemplateContext
	readonly read: "rows" | "page"
	readonly installation: Identity<"schema"> | undefined
	readonly vectorSchema: string | undefined
}

/** The names a schema's artifacts are compiled under. */
export type TestNaming = Pick<TestCompileOptions, "installation" | "vectorSchema">

/** The runtime's compilation: the snapshot context, rows, the declared schema's own names. */
export const testCompile: TestCompileOptions = {
	context: "snapshot",
	read: "rows",
	installation: undefined,
	vectorSchema: undefined
}

/**
 * The artifacts of `schema`, parsed once as the runtime parses it (parseSchemaInput, idempotent on a parsed input),
 * under the test's naming.
 */
export const testArtifacts = (
	schema: unknown,
	naming: TestNaming
): Result.Result<SchemaArtifacts, CompileError> =>
	Result.flatMap(parseSchemaInput(schema), (input) =>
		schemaArtifacts(input, {
			installation: naming.installation,
			vectorSchema: naming.vectorSchema
		})
	)

/**
 * A schema value parsed as the compiler's entry points take it, a test's fixture schema among them; a value that does
 * not parse fails the test.
 */
export const schemaInputOf = (schema: unknown): SchemaInput => {
	const parsed = parseSchemaInput(schema)
	if (!parsed.ok) {
		throw new Error(`a schema value: ${parsed.error.message}`)
	}
	return parsed.value
}

/**
 * The template of `query` over `schema` (querySchema: undefined is the query's own schema) under `budgets`, the
 * schema parsed here as the compiler's boundary parses a caller's: what a test of a compile budget drives with a
 * drawn Budgets through compileQuery's own parameter.
 */
export const compileTemplateUnder = (
	query: unknown,
	schema: unknown,
	options: TestCompileOptions,
	budgets: Budgets
): Result.Result<QueryTemplate, CompileError> => {
	const named = schema === undefined ? Result.ok(undefined) : parseSchemaInput(schema)
	if (!named.ok) {
		return named
	}
	const input = queryInput(query)
	if (!input.ok) {
		return input
	}
	const source = querySchema(input.value, named.value)
	if (!source.ok) {
		return source
	}
	const artifacts = testArtifacts(source.value.schema, options)
	if (!artifacts.ok) {
		return artifacts
	}
	const template = compileQuery(source.value, {
		context: options.context,
		artifacts: artifacts.value,
		budgets,
		read: options.read
	})
	if (!template.ok) {
		return template
	}
	checkedLowering(templateLowering(template.value, options.context, schemaCatalog(artifacts.value)))
	return template
}

/** The template of `query` over `schema` under production's budgets (compileTemplateUnder). */
export const compileTemplate = (
	query: unknown,
	schema: unknown,
	options: TestCompileOptions
): Result.Result<QueryTemplate, CompileError> =>
	compileTemplateUnder(query, schema, options, compileBudgets)

/**
 * The options a write over reality compiles under, from the schema's artifacts: its installed names written and read,
 * every context's fact held, and the derived relations' keys. What a full role's program over its base compiles to
 * (write/program/compile.ts CompileWriteOptions); a test that writes through a world states the role's.
 */
export const realityWrite = (artifacts: SchemaArtifacts): CompileWriteOptions => ({
	names: artifacts.names,
	reads: artifacts.names,
	claims: { kind: "every" },
	world: { kind: "reality" },
	laws: artifacts.laws,
	derived: artifacts.derived
})

/**
 * Logins' workloads planned the way the generator plans them, over `schema`, against its artifacts under the test's
 * naming, with no world's write filter to plan: a fixture's worlds are full roles, whose filters are true.
 */
export const compileTestWorkload = (
	logins: ReadonlyArray<LoginWorkloads>,
	schema: unknown,
	naming: TestNaming
): Result.Result<WorkloadPlan, CompileError> =>
	Result.flatMap(testArtifacts(schema, naming), (artifacts) =>
		compileWorkload(logins, schema, { artifacts, roles: [] })
	)

/**
 * The optimized program of a checked query, lowered as a query template (program/compile.ts) or a derived relation's
 * definition (physical/derived/definition.ts) lowers it, and checked against the kernel's verification of a lowering
 * (oracle/verify checkedLowering): aligned with the conservative program the same names lower.
 */
export const lowerAligned = (
	query: LogicalQuery,
	kind: "query" | "derivedDefinition",
	options: Omit<LowerOptimizedOptions, "subject">
): Result.Result<OptimizedProgram, CompileError> =>
	Result.flatMap(
		lowerConservative(conservativeInput(query), {
			names: options.names,
			params: query.params,
			subject: { kind: "query" },
			meter: new BudgetMeter(compileBudgets)
		}),
		(conservative) =>
			Result.map(lowerOptimized(query, { ...options, subject: { kind } }), (optimized) => {
				checkedLowering({
					optimized,
					alignment: { kind: "aligned", conservative },
					context: options.context,
					catalog: options.catalog
				})
				return optimized
			})
	)

/**
 * The placeholder texts of a query statement's spec, from the caller's parameter values by declared name, each
 * encoded by the spec's own encoder; every placeholder of a query statement is a declared parameter.
 */
export const paramTexts = (
	spec: StatementSpec,
	params: Readonly<Record<string, unknown>>
): ReadonlyArray<string> =>
	Arr.map(spec.paramSlots, (slot): string => {
		switch (slot.kind) {
			case "scalar":
			case "relation": {
				const encoded = slot.encode(params[slot.param])
				if (!encoded.ok) {
					throw new Error(`encode ${slot.param}: ${encoded.error.message}`)
				}
				return encoded.value
			}
			case "member":
			case "page":
				throw new Error(
					`a query statement's placeholder is a declared parameter, not a ${slot.kind} placeholder`
				)
		}
	})

/** An installation's script as the driver sends it: each statement's text, in install order. */
export const installationSql = (installation: Installation): ReadonlyArray<string> =>
	Arr.map(installation.statements, (statement) => printStatement(statement))

/** The catalog kind table's entry at a node's kind, which the table's mapped type gives that kind's node. */
const catalogLowerer = <K extends RelKind>(node: NodeOf<K>, cx: LowerContext, env: Env): Select => {
	const lower: NodeLowerer<K> = catalogLowerers[node.kind]
	return lower(node, cx, env)
}

/**
 * The catalog lowering as one dispatch (lower/shapes/catalog/native.ts catalogLowerers): a node to its kind's plug-in
 * of the conservative table with the catalog's native targets in place of its refusals of the internal kinds.
 */
export const catalogDispatch = (node: RelNode, cx: LowerContext, env: Env): Select =>
	catalogLowerer(node, cx, env)
