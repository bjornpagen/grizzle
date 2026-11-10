import { Array as Arr, Option } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { type AdmittedQuery, admitQuery } from "#compiler/check/index.ts"
import {
	type NormalizedRelation,
	parameterNormalizer,
	positionalColumns
} from "#compiler/codec/recordset.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity, parseSchemaName } from "#compiler/core/identity.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Param } from "#compiler/core/wire.ts"
import { type Codebook, emptyCodebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { SchemaDesc as EngineSchemaDesc } from "#compiler/ir/desc.ts"
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
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { type InstallExtension, noCertificates } from "#compiler/physical/install/extension.ts"
import { installBasis } from "#compiler/physical/install/plan.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { textOfParam } from "#test/support/wire.ts"

import {
	compileQuery,
	type QueryTemplate,
	queryInput,
	querySchema
} from "#compiler/program/compile.ts"

import {
	baseArtifacts,
	parseSchemaInput,
	roleArtifacts,
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
import type { Chunks } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import {
	type Owned,
	type OwnedLogin,
	type OwnedRole,
	own,
	ownRole,
	rostersOf
} from "#compiler/schema/own.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import type { CompiledWrite, CompileWriteOptions } from "#compiler/write/program/compile.ts"
import { flightOf } from "#compiler/write/program/served.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { type OracleTemplate, withConservative } from "#test/support/conservative.ts"
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
 * (installed under the allocation `installation`, under the codes `codes` names, when the test installs under names
 * and codes of its own), for the context, read as rows or a page as the options state;
 * testCompile states the runtime's own for a fresh installation, and a test spreads it with what it changes. A query
 * over a role is checked against that role, as the runtime checks it. Every field is stated.
 */
export interface TestCompileOptions {
	readonly context: TemplateContext
	readonly read: "rows" | "page"
	readonly installation: Identity<"schema"> | undefined
	readonly codes: TestCodes
}

/** The names and codes a schema's artifacts are compiled under. */
export type TestNaming = Pick<TestCompileOptions, "installation" | "codes">

/** The runtime's compilation of a fresh installation: the snapshot context, rows, the declared schema's own names. */
export const testCompile: TestCompileOptions = {
	context: "snapshot",
	read: "rows",
	installation: undefined,
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
 * under the test's naming: its declared levels' own schemas, or every level renamed under the allocation
 * `naming.installation` names (allocatedDesc), as the real-install harness installs it.
 */
export const testArtifacts = (
	schema: unknown,
	naming: TestNaming
): Result.Result<SchemaArtifacts, CompileError> =>
	Result.flatMap(parseSchemaInput(schema), (input) =>
		Result.flatMap(codebookFor(input, naming.codes), (codes) =>
			naming.installation === undefined
				? schemaArtifacts(input, { codes })
				: allocatedArtifacts(input, identifierOf(naming.installation), codes)
		)
	)

/** The artifacts of `input` with every level of its schema, a role's base among them, renamed under `allocated`. */
const allocatedArtifacts = (
	input: SchemaInput,
	allocated: string,
	codes: Codebook
): Result.Result<SchemaArtifacts, CompileError> => {
	const over = (owned: Owned) =>
		Result.flatMap(installBasis(owned, codes, everySlice(owned)), baseArtifacts)
	return input.kind === "role"
		? Result.flatMap(
				ownRole({ ...input.desc, base: allocatedDesc(input.desc.base, allocated) }),
				(role) => Result.flatMap(over(role.base), (base) => roleArtifacts(role, base))
			)
		: Result.flatMap(own(allocatedDesc(input.desc, allocated)), over)
}

/**
 * The declared name the level at `depth` of a schema takes under the allocation `allocated`, the substrate's unique name
 * for one installation, the root at depth 0: the root's is the allocation itself, and each level above it is the
 * allocation and its depth, so every level's PostgreSQL schema, and every role over it, is the allocation's alone. A test
 * that rebuilds a level to open it rebuilds it under this name.
 */
export const levelNameAt = (allocated: string, depth: number): string =>
	depth === 0 ? allocated : `${allocated}_${depth}`

/** A description with every level declared under its allocated name (levelNameAt). */
export const allocatedDesc = (desc: EngineSchemaDesc, allocated: string): EngineSchemaDesc => {
	const below = desc.extends === undefined ? undefined : allocatedDesc(desc.extends, allocated)
	const depth = below === undefined ? 0 : depthOf(below) + 1
	return below === undefined
		? { ...desc, name: levelNameAt(allocated, depth) }
		: { ...desc, name: levelNameAt(allocated, depth), extends: below }
}

/** The depth of a description's top level, its root's 0. */
const depthOf = (desc: EngineSchemaDesc): number =>
	desc.extends === undefined ? 0 : depthOf(desc.extends) + 1

/**
 * The PostgreSQL schemas of `levels` allocated under `installation`, the root's first: the root's is the allocation,
 * each level above it the allocation and its depth (levelNameAt).
 */
export const allocatedLevels = (
	installation: Identity<"schema">,
	levels: Arr.NonEmptyReadonlyArray<unknown>
): Arr.NonEmptyReadonlyArray<Identity<"schema">> =>
	Arr.map(levels, (_, depth) => {
		if (depth === 0) {
			return installation
		}
		const name = parseSchemaName(`${identifierOf(installation)}_${depth}`)
		if (!name.ok) {
			throw new Error(
				`the allocated level name of ${installation.display} at ${depth}: ${name.error}`
			)
		}
		return identity.schema(name.value)
	})

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
 * the compiler's boundary parses a caller's, against the artifacts of the schema it reads, computed for this query.
 */
export const compileTemplate = (
	query: unknown,
	schema: unknown,
	options: TestCompileOptions
): Result.Result<OracleTemplate, CompileError> =>
	Result.flatMap(templateSource(query, schema), (source) =>
		Result.flatMap(testArtifacts(source.schema, options), (artifacts) =>
			templateOver(source, artifacts, options)
		)
	)

/**
 * The template of `query` over `schema`, as compileTemplate compiles it, against `artifacts`: the artifacts of the
 * schema it reads (testArtifacts under `options`), which a caller compiling many queries over one fixture schema
 * computes once, as a named value, and passes to each.
 */
export const compileTemplateOver = (
	query: unknown,
	schema: unknown,
	artifacts: SchemaArtifacts,
	options: TestCompileOptions
): Result.Result<OracleTemplate, CompileError> =>
	Result.flatMap(templateSource(query, schema), (source) =>
		templateOver(source, artifacts, options)
	)

/** The query and the schema it reads, `schema` parsed as the compiler's boundary parses a caller's. */
const templateSource = (
	query: unknown,
	schema: unknown
): Result.Result<Parameters<typeof compileQuery>[0], CompileError> => {
	const named = schema === undefined ? Result.ok(undefined) : parseSchemaInput(schema)
	if (!named.ok) {
		return named
	}
	const input = queryInput(query)
	if (!input.ok) {
		return input
	}
	return querySchema(input.value, named.value)
}

/** A query's template against the artifacts of the schema it reads, its lowering checked. */
const templateOver = (
	source: Parameters<typeof compileQuery>[0],
	artifacts: SchemaArtifacts,
	options: TestCompileOptions
): Result.Result<OracleTemplate, CompileError> => {
	const template = Result.flatMap(
		compileQuery(source, {
			context: options.context,
			artifacts,
			read: options.read
		}),
		(compiled) => withConservative(compiled, artifacts.reads)
	)
	if (!template.ok) {
		return template
	}
	checkedLowering(templateLowering(template.value, options.context, schemaCatalog(artifacts)))
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
 * The workload of `logins`, planned beside the write filters of the roles `rolesOf` picks among the installation's
 * logins, as an installer extension compiled when the installation runs it: against the schema installed
 * (InstallBuilder.owned), as `grizzle generate` compiles a workload against the schema it installs, so a harness that
 * installs a subject under its allocated level names installs the workload of that schema (workloadExtension holds a
 * workload to the fingerprint it was compiled against).
 */
const workloadExtensionOver = (
	logins: ReadonlyArray<LoginWorkloads>,
	rolesOf: (installing: ReadonlyArray<OwnedLogin>) => ReadonlyArray<OwnedRole>
): InstallExtension => ({
	contribute: (b) =>
		Result.flatMap(testArtifacts(b.owned.desc, testCompile), (artifacts) =>
			Result.flatMap(
				compileWorkload(logins, b.owned.desc, {
					artifacts,
					roles: rolesOf(b.settings.logins)
				}),
				(plan) => workloadExtension(plan).contribute(b)
			)
		),
	textDomainUses: noTextDomainUses,
	certifies: noCertificates
})

/** The workload of `logins` alone (compileTestWorkload), compiled against the schema the installation installs. */
export const workloadOver = (logins: ReadonlyArray<LoginWorkloads>): InstallExtension =>
	workloadExtensionOver(logins, () => [])

/**
 * The workload of `logins` beside every installed login's write filters, as `grizzle generate` plans a deployment's,
 * compiled against the schema the installation installs.
 */
export const deployedWorkloadOver = (logins: ReadonlyArray<LoginWorkloads>): InstallExtension =>
	workloadExtensionOver(logins, (installing) => Arr.flatMap(installing, (l) => l.roles))

/**
 * A generated query, which no checker handed over, admitted as the optimized lowering takes it (check/index.ts
 * admitQuery): a case the admission rule refuses is refused here, as the checker refuses its description.
 */
export const admitGenerated = (query: LogicalQuery): Result.Result<AdmittedQuery, CompileError> =>
	admitQuery(query, SourceLoc("generated query", []))

/**
 * The optimized program of a query, admitted (`admitGenerated`) and lowered as a query template (program/compile.ts) or a
 * derived relation's definition (physical/derived/definition.ts) lowers it, and checked against the kernel's verification of a lowering
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
			Result.map(
				Result.flatMap(admitGenerated(query), (q) =>
					lowerOptimized(q, { ...options, subject: { kind } })
				),
				(optimized) => {
					checkedLowering({
						optimized,
						alignment: { kind: "aligned", conservative },
						context: options.context,
						catalog: options.catalog
					})
					return optimized
				}
			)
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
 * The placeholders of a query statement's spec, each as its statement binds it, a text or a binary parameter
 * (core/wire.ts Param), from the caller's parameter values by declared name, each encoded by the spec's own encoder;
 * every placeholder of a query statement is a declared parameter. A relation parameter's input is normalized once,
 * under its declared heading (codec/recordset.ts parameterNormalizer), as an execution normalizes it, and each of its
 * placeholders writes its own array of that one set: a text or bytes column's as a binary array.
 */
export const paramValues = (
	spec: Pick<StatementSpec, "paramSlots">,
	params: Readonly<Record<string, unknown>>,
	declared: Declared
): ReadonlyArray<string | Param> => {
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
		const normal = parameterNormalizer(
			{
				relation: decl.name,
				slot: { kind: "slot", name: decl.name },
				columns: positionalColumns(decl.heading),
				codes: declared.codes
			},
			new CompilePatterns()
		)(value)
		if (!normal.ok) {
			throw new Error(`encode ${param}: ${normal.error.message}`)
		}
		normalized.set(param, normal.value)
		return normal.value
	}
	return Arr.map(spec.paramSlots, (slot): string | Param => {
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
			case "nestedRows":
			case "page":
				throw new Error(
					`a query statement's placeholder is a declared parameter, not a ${slot.kind} placeholder`
				)
		}
	})
}

/**
 * The placeholder texts of a query statement's spec (paramValues), for a test that sends every placeholder as text: a
 * binary one has no text, and reading one is the test's own error (textOfParam).
 */
export const paramTexts = (
	spec: Pick<StatementSpec, "paramSlots">,
	params: Readonly<Record<string, unknown>>,
	declared: Declared
): ReadonlyArray<string> =>
	Arr.map(paramValues(spec, params, declared), (param) =>
		typeof param === "string" ? param : textOfParam(param)
	)

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

/**
 * The items of the array a stratum's family additions statement carries column `part` of a relation's nested rows in
 * (write/family/nesting.ts sentLayout), as its one execution sends it: the rows, in the order the walk filled them.
 */
export const nestedRowsColumn = (
	program: CompiledWrite,
	chunks: Chunks,
	relation: string,
	part: number
): ReadonlyArray<string> => {
	for (const statement of flightOf(program, program.frontend.codes).statements) {
		const at = Arr.findFirstIndex(
			statement.form.paramSlots,
			(s) => s.kind === "nestedRows" && s.relation === relation && s.part === part
		)
		if (Option.isSome(at)) {
			const [execution] = succeeded(chunks(statement, inForce(bindFrame)))
			return Arr.map(
				readArrayLiteral(
					textOfParam(
						defined(execution?.params[at.value], `column ${part} of ${relation}'s nested rows`)
					)
				),
				(item) => {
					if (item === null) {
						throw new Error(`a NULL among ${relation}'s nested rows`)
					}
					return item
				}
			)
		}
	}
	throw new Error(`no statement carries ${relation}'s nested rows`)
}
