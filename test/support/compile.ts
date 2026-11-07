import { Array as Arr, Option } from "effect"
import {
	type NormalizedRelation,
	parameterNormalizer,
	positionalColumns
} from "#compiler/codec/recordset.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { type Codebook, emptyCodebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { LogicalQuery, ParamDecl, StatementSpec } from "#compiler/ir/products.ts"
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
import { type Owned, own, ownRole, rostersOf } from "#compiler/schema/own.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import type { CompileWriteOptions } from "#compiler/write/program/compile.ts"
import { checkedLowering, templateLowering } from "#test/support/oracle/verify/index.ts"

/**
 * The codes a test compiles a schema's artifacts under: a fresh installation's, each roster's handles numbered by
 * position (ir/codes.ts firstCodebook over the schema's rosters), or an installation's own, which a migrated one with a
 * hole or a re-added handle needs, since codes are history and no schema alone determines them.
 */
export type TestCodes =
	| { readonly kind: "first" }
	| { readonly kind: "installed"; readonly codes: Codebook }

/** A fresh installation's codes, whatever schema they are drawn for. */
export const firstCodes: TestCodes = { kind: "first" }

/** An installation's own codes: what a test that installed or migrated the schema compiles under. */
export const installedCodes = (codes: Codebook): TestCodes => ({ kind: "installed", codes })

/**
 * A query compiled the way the runtime compiles it, for tests that compile a query directly: its schema's artifacts
 * (installed under `installation`, with the vector extension in `vectorSchema`, under the codes `codes` names, when the
 * test installs under names and codes of its own), for the context, read as rows or a page as the options state;
 * testCompile states the runtime's own for a fresh installation, and a test spreads it with what it changes. A query
 * over a role is checked against that role, as the runtime checks it. Every field is stated.
 */
export interface TestCompileOptions {
	readonly context: TemplateContext
	readonly read: "rows" | "page"
	readonly installation: Identity<"schema"> | undefined
	readonly vectorSchema: string | undefined
	readonly codes: TestCodes
}

/** The names and codes a schema's artifacts are compiled under. */
export type TestNaming = Pick<TestCompileOptions, "installation" | "vectorSchema" | "codes">

/** The runtime's compilation of a fresh installation: the snapshot context, rows, the declared schema's own names. */
export const testCompile: TestCompileOptions = {
	context: "snapshot",
	read: "rows",
	installation: undefined,
	vectorSchema: undefined,
	codes: firstCodes
}

/** The schema an input's artifacts are computed over, owned: a role's base, or the schema itself. */
const ownedOf = (input: SchemaInput): Result.Result<Owned, CompileError> => {
	switch (input.kind) {
		case "owned":
			return Result.ok(input.owned)
		case "role":
			return Result.map(ownRole(input.desc), (role) => role.base)
		case "built":
		case "desc":
			return own(input.desc)
	}
}

/** The codebook `codes` names for `input`'s schema: the installation's own, or a fresh installation's of its rosters. */
export const codebookFor = (
	input: SchemaInput,
	codes: TestCodes
): Result.Result<Codebook, CompileError> =>
	codes.kind === "installed"
		? Result.ok(codes.codes)
		: Result.map(ownedOf(input), (owned) => firstCodebook(rostersOf(owned)))

/**
 * The artifacts of `schema`, parsed once as the runtime parses it (parseSchemaInput, idempotent on a parsed input),
 * under the test's naming.
 */
export const testArtifacts = (
	schema: unknown,
	naming: TestNaming
): Result.Result<SchemaArtifacts, CompileError> =>
	Result.flatMap(parseSchemaInput(schema), (input) =>
		Result.flatMap(codebookFor(input, naming.codes), (codes) =>
			schemaArtifacts(input, {
				installation: naming.installation,
				vectorSchema: naming.vectorSchema,
				codes
			})
		)
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
 * The template of `query` over `schema` (querySchema: undefined is the query's own schema), the schema parsed here as
 * the compiler's boundary parses a caller's.
 */
export const compileTemplate = (
	query: unknown,
	schema: unknown,
	options: TestCompileOptions
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
		read: options.read
	})
	if (!template.ok) {
		return template
	}
	checkedLowering(templateLowering(template.value, options.context, schemaCatalog(artifacts.value)))
	return template
}

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
			subject: { kind: "query" }
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
 * What a statement's relation placeholders are normalized under (paramTexts): the declared parameters of the template or
 * write program it belongs to, and the codes that template was compiled under.
 */
export interface Declared {
	readonly params: ReadonlyArray<ParamDecl>
	readonly codes: Codebook
}

/**
 * The declarations of `template`, compiled from `query` over `schema` (undefined: the query's own) under `naming`
 * (compileTemplate): its declared parameters, and the codebook its schema's artifacts were compiled under.
 */
export const declaredOf = (
	template: QueryTemplate,
	query: unknown,
	schema: unknown,
	naming: TestNaming
): Declared => {
	const named = schema === undefined ? Result.ok(undefined) : parseSchemaInput(schema)
	const codes = Result.flatMap(named, (parsed) =>
		Result.flatMap(queryInput(query), (input) =>
			Result.flatMap(querySchema(input, parsed), (source) =>
				Result.flatMap(parseSchemaInput(source.schema), (input) => codebookFor(input, naming.codes))
			)
		)
	)
	if (!codes.ok) {
		throw new Error(`the codes of a compiled template: ${codes.error.message}`)
	}
	return { params: template.params, codes: codes.value }
}

/**
 * The declarations of a statement whose template declares no relation parameter, only scalar ones: paramTexts then
 * refuses a relation placeholder loudly, never encoding it under a guessed heading or codebook.
 */
export const scalarsOnly: Declared = { params: [], codes: emptyCodebook }

/** Whether a value is iterated by the runtime iteration protocol: an object with an iterator method. */
const isIterable = (value: unknown): value is Iterable<unknown> =>
	typeof value === "object" &&
	value !== null &&
	Symbol.iterator in value &&
	typeof value[Symbol.iterator] === "function"

/**
 * The placeholder texts of a query statement's spec, from the caller's parameter values by declared name, each
 * encoded by the spec's own encoder; every placeholder of a query statement is a declared parameter. A relation
 * parameter's input is normalized once, under its declared heading (codec/recordset.ts parameterNormalizer), as an
 * execution normalizes it, and each of its placeholders writes its own array of that one set.
 */
export const paramTexts = (
	spec: StatementSpec,
	params: Readonly<Record<string, unknown>>,
	declared: Declared
): ReadonlyArray<string> => {
	const normalized = new Map<ParamId, NormalizedRelation>()
	/** The relation parameter `param`'s input, normalized the first time a placeholder asks for it. */
	const relationInput = (param: ParamId): NormalizedRelation => {
		const known = normalized.get(param)
		if (known !== undefined) {
			return known
		}
		const decl = Option.getOrUndefined(
			Arr.findFirst(declared.params, (d) => d.id === param && d.kind === "relation")
		)
		if (decl?.kind !== "relation") {
			throw new Error(`encode ${param}: no relation parameter of that name is declared`)
		}
		const value = params[decl.name]
		if (!isIterable(value)) {
			throw new Error(`encode ${param}: a relation parameter's input is an iterable of facts`)
		}
		const normal = parameterNormalizer({
			relation: decl.name,
			slot: { kind: "slot", name: decl.name },
			columns: positionalColumns(decl.heading),
			codes: declared.codes
		})(value)
		if (!normal.ok) {
			throw new Error(`encode ${param}: ${normal.error.message}`)
		}
		normalized.set(param, normal.value)
		return normal.value
	}
	return Arr.map(spec.paramSlots, (slot): string => {
		switch (slot.kind) {
			case "scalar": {
				const encoded = slot.encode(params[slot.param])
				if (!encoded.ok) {
					throw new Error(`encode ${slot.param}: ${encoded.error.message}`)
				}
				return encoded.value
			}
			case "relation": {
				const encoded = slot.encode(relationInput(slot.param), slot.part)
				if (!encoded.ok) {
					throw new Error(
						`encode ${slot.param}: column ${encoded.error.column} past ${encoded.error.limit}`
					)
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
}

/** An installation's script as the driver sends it: each statement's text, in install order. */
export const installationSql = (installation: Installation): ReadonlyArray<string> =>
	Arr.map(installation.statements, (statement) => printStatement(statement))

/** The catalog kind table's entry at a node's kind, which the table's mapped type gives that kind's node. */
const catalogLowerer = <K extends RelKind>(
	node: NodeOf<K>,
	cx: LowerContext,
	env: Env
): OperandSelect => {
	const lower: NodeLowerer<K> = catalogLowerers[node.kind]
	return lower(node, cx, env)
}

/**
 * The catalog lowering as one dispatch (lower/shapes/catalog/native.ts catalogLowerers): a node to its kind's plug-in
 * of the conservative table with the catalog's native targets in place of its refusals of the internal kinds.
 */
export const catalogDispatch = (node: RelNode, cx: LowerContext, env: Env): OperandSelect =>
	catalogLowerer(node, cx, env)
