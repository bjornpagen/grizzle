import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Fence } from "#compiler/analysis/isolation/certify.ts"
import { checkedRoleOver, type CheckedSchema, type RoleWorld } from "#compiler/analysis/schema.ts"
import { type AdmittedQuery, checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { RoleIsolation } from "#compiler/core/certificate.ts"
import { type CompileError, malformedDescription, within } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { type Phases, phased, silentPhases } from "#compiler/core/phase.ts"
import {
	type ClockBinding,
	type ClockSource,
	noClock,
	transactionClock
} from "#compiler/ir/clock.ts"
import { noneWritten, servedQuery } from "#compiler/ir/derived.ts"
import {
	type ChangeSetDesc,
	type WorkloadDesc,
	callsThrough,
	decodeDesc,
	type ProgramDesc,
	type QueryDesc
} from "#compiler/ir/desc.ts"
import type {
	AccessIndexRequest,
	AccessPath,
	ParamDecl,
	ProgramAccess,
	WorkloadAccess
} from "#compiler/ir/products.ts"
import type { RelNode, Rooted, RootedDag } from "#compiler/ir/rel.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import {
	analyzeLogical,
	checkerEvidence,
	type LogicalAnalysis,
	withLogicalMeta
} from "#compiler/logical/annotate.ts"
import {
	type Footprint,
	footprintOf,
	type RouteFacts,
	type Routes,
	routeFacts
} from "#compiler/logical/routes.ts"
import { keyJoinNormalDag } from "#compiler/lower/optimize/eliminate/index.ts"
import { allenNormalDag } from "#compiler/lower/optimize/simplify/allen.ts"
import type { WorkloadPhysical } from "#compiler/physical/access/extension.ts"
import { pathRequest, uniquePaths } from "#compiler/physical/access/paths.ts"
import type { RoleWorldViews } from "#compiler/physical/access/world-views.ts"
import { type ServedTypes, servedTogether, servedTypesOf } from "#compiler/physical/ddl/domains.ts"
import { namedRole } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { RoleCall, RoleCarriers, ServedProgram } from "#compiler/physical/install/extension.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"

import type { SchemaInput } from "#compiler/program/input.ts"
import { certification } from "#compiler/program/isolation/certification.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import {
	type ChangeLogin,
	type ChangeRefused,
	type ReadCommittedRole,
	readCommittedChanges,
	type ServableRole,
	type ServableVariants,
	variantsEntries
} from "#compiler/program/workload/change.ts"
import { type PlannedFrontend, PlannedFrontends } from "#compiler/program/workload/planned.ts"
import { type CompiledRead, compiledRead, readPlansOf } from "#compiler/program/workload/reads.ts"
import { loginRole, programsOn } from "#compiler/program/workload/roles.ts"
import { workloadState } from "#compiler/program/workload/value.ts"
import { inlineWorlds } from "#compiler/program/workload/world.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { ownBuiltRole, type OwnedRole } from "#compiler/schema/own.ts"
import type { ReadPlan } from "#compiler/sql/plan.ts"
import { compileChangeSet, type WriteFrontend } from "#compiler/write/frontend/compile.ts"
import type { ServableWrite } from "#compiler/write/program/served.ts"

interface WorkloadOptions {
	/** The workload schema's artifacts, as the installation the plan extends names them. */
	readonly artifacts: SchemaArtifacts
}

/**
 * One login's workloads, as the migration generator and the layer plan them: the login's name and its workloads,
 * each a workload value (program/workload/value.ts) or a WorkloadDesc over the schema the caller names.
 */
export interface LoginWorkloads {
	readonly login: string
	readonly workloads: ReadonlyArray<unknown>
}

export interface WorkloadPlan extends WorkloadPhysical {
	readonly schemaName: string
	/** Each login's query programs' footprints, by login, then program (WorkloadFootprints). */
	readonly footprints: WorkloadFootprints
	/** The live plan of every footprint (livePlanOf), which snapshot.json records as `live`. */
	readonly live: LivePlan
}

/**
 * The footprint of every query program of each login's workloads (ProgramFootprints), by the login's name: what each
 * read member of the login's served file routes a change by, on every role it runs on (loginPlans).
 */
export type WorkloadFootprints = ReadonlyMap<string, ProgramFootprints>

/** The footprint of each query program of a login's workloads (logical/routes.ts Footprint), by the program's name. */
export type ProgramFootprints = ReadonlyMap<string, Footprint>

/**
 * Whether a login serves a live read, by its programs' footprints `footprints`: its workload plans a live query
 * program, as every live read member does, a query, an ordered query, a paged read and a key's lookup alike, while a
 * ChangeSet and an answered read (a clocked one among them), answered at its call's instant and never
 * watched, plan none. A login that serves one watches, so its installation holds a live source (livePlanOf) and its
 * served file names it (adapter served/project.ts).
 */
export const servesRead = (footprints: ProgramFootprints): boolean => footprints.size > 0

interface ProgramIr {
	/** The program's roots: a query's root, or a ChangeSet's read-backs and laws. */
	readonly roots: ReadonlyArray<RelNode>
	/** The parameters it declares, whose patterns the installation gives a pattern domain each. */
	readonly params: ReadonlyArray<ParamDecl>
}

/**
 * One program's plan, as the database would compile it on the workload schema: the types it is served with, and a
 * query's footprint, read from its one checked IR (queryRead); a ChangeSet's and an answered query's types alone (one
 * read at its call's instant alone, `answered`, a clocked read's among them), since no read subscribes to a write and
 * no change wakes an answered read. What each program reads by index is its served compile's plans' to state
 * (servedWorkload), never its IR's. A ChangeSet over a role is the role's, whose statements write the base's tables.
 */
type ProgramPlan = {
	/**
	 * The types it is served with, read off its declared parameters and the nodes of its checked IR when it is planned
	 * (servedTypesOf): the plan holds them, never the IR, which a workload's plans held every one of until its last
	 * program was planned, each query's whole DAG beside the ChangeSet compiles that came after it (edullm's qti, 1 GB
	 * of the 4 GiB heap at its largest write's compile).
	 */
	readonly served: ServedTypes
} & (
	| { readonly kind: "query"; readonly footprint: Footprint }
	| { readonly kind: "answered" }
	| { readonly kind: "changeSet" }
)

/**
 * A program's plan, and a ChangeSet's front end with the clock binding it was compiled under: the front end its served
 * compile reads again where it is the one that compile builds (planned.ts PlannedFrontends), never the plan's, which
 * holds no IR (ProgramPlan).
 */
type Planned =
	| { readonly kind: "read"; readonly plan: ProgramPlan }
	| {
			readonly kind: "write"
			readonly plan: ProgramPlan
			readonly frontend: WriteFrontend
			readonly clock: ClockBinding
	  }

const programPlan = (
	name: string,
	program: ProgramDesc,
	reads: WorkloadReads,
	clock: ClockBinding
): Result.Result<Planned, CompileError> => {
	switch (program.kind) {
		case "query":
		case "answered": {
			const { kind, query } = program
			return Result.map(queryRead(query, reads, clock), (read): Planned => {
				const served = servedTypesOf(name, read.params, rowsIr(read).roots)
				switch (kind) {
					case "query":
						return {
							kind: "read",
							plan: {
								kind,
								served,
								footprint: installedFootprint(
									reads.artifacts.laws.checked,
									footprintOf(read.dag, read.facts, read.params)
								)
							}
						}
					case "answered":
						return { kind: "read", plan: { kind, served } }
				}
			})
		}
		case "changeSet": {
			const world = reads.world
			return Result.map(
				changeSetIr(
					program.changeSet,
					world.kind === "role" ? world.checked : reads.artifacts.derived.schema,
					reads,
					clock
				),
				({ ir, frontend }): Planned => ({
					kind: "write",
					plan: { kind: "changeSet", served: servedTypesOf(name, ir.params, ir.roots) },
					frontend,
					clock
				})
			)
		}
		case "clocked":
			return programPlan(name, program.program, reads, program.clock)
	}
}

/**
 * A query of a workload over `schema`, read as its plan reads it (queryRead), under the base's artifacts `artifacts`:
 * what a test reads a program's footprint beside.
 */
export const workloadQueryRead = (
	query: QueryDesc,
	schema: SchemaInput,
	artifacts: SchemaArtifacts
): Result.Result<AnalyzedQuery, CompileError> =>
	Result.flatMap(workloadReads(schema, artifacts), (reads) => queryRead(query, reads, noClock))

/**
 * A query program's checked IR, as its access and its footprint are read: over the base, a query over a role reading
 * each world relation's definition (world.ts inlineWorlds), as rows (analyzedQuery).
 */
const queryRead = (
	query: QueryDesc,
	reads: WorkloadReads,
	clock: ClockBinding
): Result.Result<AnalyzedQuery, CompileError> =>
	analyzedQuery(
		reads.world.kind === "role" ? inlineWorlds(query, reads.world.checked) : query,
		reads.artifacts.derived.schema,
		clock
	)

/**
 * What a workload's programs are checked as: reality, or a role with its checked schema. Its programs' plans read the
 * role's world views from their change compiles' artifacts (ArtifactsWorld `role`), so these lower none.
 */
type WorkloadWorld =
	| { readonly kind: "reality" }
	| {
			readonly kind: "role"
			readonly role: OwnedRole
			readonly checked: CheckedSchema<RoleWorld>
	  }

/**
 * What every program of a workload is checked and planned over, read once for the workload: its world, and the base's
 * artifacts (its checked schema, derived analysis and law model).
 */
interface WorkloadReads {
	readonly world: WorkloadWorld
	readonly artifacts: SchemaArtifacts
}

const workloadReads = (
	schema: SchemaInput,
	artifacts: SchemaArtifacts
): Result.Result<WorkloadReads, CompileError> =>
	schema.kind === "role"
		? Result.flatMap(ownBuiltRole(schema.desc, artifacts.owned), (role) =>
				Result.flatMap(namedRole(role, artifacts.names.levels), () =>
					Result.map(checkedRoleOver(role, artifacts.derived.schema), (checked): WorkloadReads => ({
						world: { kind: "role", role, checked },
						artifacts
					}))
				)
			)
		: Result.ok<WorkloadReads>({ world: { kind: "reality" }, artifacts })

/**
 * An analyzed query's IR as its served types are read: its root with every node's logical metadata
 * (logical/annotate.ts), and its parameters.
 */
const rowsIr = (analyzed: AnalyzedQuery): ProgramIr => ({
	roots: [withLogicalMeta(analyzed.dag, analyzed.analysis, (node) => node, new Set()).roots[0]],
	params: analyzed.params
})

/** A query's checked DAG in the normal forms its lowering reads it in, with its logical analysis and parameters. */
export interface AnalyzedQuery {
	/** The query as its lowering reads it (ir/derived.ts servedQuery), checked, before its normal forms. */
	readonly served: AdmittedQuery
	readonly dag: RootedDag
	readonly analysis: LogicalAnalysis<Rooted>
	/** What its footprint reads of each node's logical properties (logical/routes.ts RouteFacts), the rest dropped. */
	readonly facts: ReadonlyMap<RelNode, RouteFacts>
	readonly params: ReadonlyArray<ParamDecl>
}

/**
 * A query checked over `read`, read as rows, in the normal forms its optimized lowering states it in (its
 * filters in Allen normal form, eliminate/index.ts keyJoinNormalDag folding every two occurrences of a stored relation
 * joined on a key into one), with the logical analysis of that DAG under the checker's evidence: what its served types
 * (rowsIr) and a read program's footprint (logical/routes.ts footprintOf) are read from.
 */
const analyzedQuery = (
	query: QueryDesc,
	read: CheckedSchema,
	clock: ClockBinding
): Result.Result<AnalyzedQuery, CompileError> =>
	Result.flatMap(
		checkQuery(read, query, { read: "rows", label: "query", clock, session: CheckSession.own() }),
		(admitted) => {
			/** Its rows as its lowering reads them (ir/derived.ts servedQuery), its stored derived relations by their
			 * tables. */
			const checked = servedQuery(admitted, read.rows(noneWritten))
			return Result.flatMap(allenNormalDag(checked.dag), (allen) =>
				Result.flatMap(keyJoinNormalDag(allen), (dag) => {
					const facts = new Map<RelNode, RouteFacts>()
					return Result.map(
						analyzeLogical(dag, checkerEvidence, {
							kind: "read",
							read: (node, props) => {
								facts.set(node, routeFacts(props))
							}
						}),
						(analysis): AnalyzedQuery => ({
							served: checked,
							dag,
							analysis,
							facts,
							params: checked.params
						})
					)
				})
			)
		}
	)

/**
 * A ChangeSet's IR over its checked schema, planned as if each context held its fact: an addition fills its fixed
 * fields from them; and the front end it is read from, the one the ChangeSet's served variant in which every fill
 * context holds a fact compiles (planned.ts PlannedFrontends).
 */
const changeSetIr = (
	changeSet: ChangeSetDesc,
	read: CheckedSchema,
	reads: WorkloadReads,
	clock: ClockBinding
): Result.Result<{ readonly ir: ProgramIr; readonly frontend: WriteFrontend }, CompileError> => {
	const derived = reads.artifacts.derived
	return Result.map(
		compileChangeSet(read, changeSet, {
			claims: { kind: "every" },
			laws: reads.artifacts.laws,
			derived,
			codes: reads.artifacts.names.codes,
			clock,
			source: transactionClock
		}),
		(frontend) => ({ ir: { roots: frontend.ir.dag.roots, params: frontend.params }, frontend })
	)
}

/**
 * The access of an installation's served programs, what the snapshot records and `grizzle check` compares
 * (deploy/snapshot/build.ts DraftWorkload): each login's programs' paths, every read their bound statements make
 * (physical/install/compile.ts Installation `programAccess`), by login then program in code point order, each path once
 * in canonical order, every login the installation installs among them; and every program's paths once, in canonical
 * order, as the requests the installation's vector schema qualifies, which it asked an index for.
 */
export const servedAccess = (
	installation: Pick<Installation, "worlds" | "programAccess" | "names">
): { readonly access: WorkloadAccess; readonly requests: ReadonlyArray<AccessIndexRequest> } => {
	const byLogin = new Map<string, Map<string, Array<AccessPath>>>(
		installation.worlds.map((w) => [w.name, new Map()] as const)
	)
	for (const p of installation.programAccess) {
		const programs = byLogin.getOrInsertComputed(p.login, () => new Map())
		appendAll(
			programs.getOrInsertComputed(p.program, () => []),
			p.paths
		)
	}
	const access: WorkloadAccess = Object.fromEntries(
		[...byLogin]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(
				([login, programs]) =>
					[
						login,
						Object.fromEntries(
							[...programs]
								.toSorted(([a], [b]) => compareStrings(a, b))
								.map(([program, paths]) => [program, { paths: uniquePaths(paths) }] as const)
						)
					] as const
			)
	)
	return {
		access,
		requests: uniquePaths(installation.programAccess.flatMap((p) => p.paths)).map((path) =>
			pathRequest(path, installation.names.vectorSchema)
		)
	}
}

/**
 * Each role of each login with its world views as its change compile's artifacts hold them (program/schema.ts
 * ArtifactsWorld `role`), which the installation creates from, lowering none again (physical/install/extension.ts
 * InstallExtension `worldViews`), by the login's name and the role's, in that order.
 */
const servedWorldViews = (changes: ServedWorkloadPlan["changes"]): ReadonlyArray<RoleWorldViews> =>
	[...changes]
		.toSorted(([a], [b]) => compareStrings(a, b))
		.flatMap(([login, roles]) =>
			[...roles]
				.toSorted(([a], [b]) => compareStrings(a, b))
				.flatMap(([role, r]): ReadonlyArray<RoleWorldViews> => {
					const world = r.artifacts.world
					return world.kind === "role" ? [{ login, role, views: world.views }] : []
				})
		)

/**
 * Each login's served programs as the installation indexes them (physical/install/extension.ts ServedProgram), by the
 * login's name and the program's, in that order: the plan of each statement its served file may send, every role's
 * and, of a ChangeSet, every variant's (write/program/served.ts ServableWrite `plan`), of a read its read's and its
 * page's (reads.ts readPlansOf).
 */
const servedPrograms = (
	login: string,
	plans: ReadonlyArray<readonly [string, ReadonlyArray<ReadPlan<AccessIndexRequest>>]>
): ReadonlyArray<ServedProgram> => {
	const byProgram = new Map<string, Array<ReadPlan<AccessIndexRequest>>>()
	for (const [program, of] of plans) {
		appendAll(
			byProgram.getOrInsertComputed(program, () => []),
			of
		)
	}
	return [...byProgram]
		.toSorted(([a], [b]) => compareStrings(a, b))
		.map(([program, programPlans]): ServedProgram => ({ login, program, plans: programPlans }))
}

/**
 * A workload input: a workload value, or a WorkloadDesc with the schema it belongs to. A Description carries no content
 * of its schema, only the name it was recorded under, which the schema the caller names must have.
 */
const workloadInput = (
	input: unknown,
	schema: SchemaInput
): Result.Result<{ readonly schema: SchemaInput; readonly desc: WorkloadDesc }, CompileError> => {
	const state = workloadState(input)
	if (state !== undefined) {
		return Result.ok({ schema: state.schema, desc: state.desc })
	}
	/** A workload Description is the caller's value, read once at the builder's boundary before it is decoded. */
	const read = catchCompileError(() => hostArguments("compileWorkload", [input]))
	if (!read.ok) {
		return Result.err(read.error)
	}
	return Result.flatMap(decodeDesc("workload", input), (desc) =>
		baseName(schema) === desc.schema
			? Result.ok({ schema, desc })
			: Result.err(
					malformedDescription(
						SourceLoc("compileWorkload", []),
						`a workload over the schema ${baseName(schema)}, not over ${desc.schema}`
					)
				)
	)
}

/**
 * Why a workload plan refused: one program of a workload, the checker's or its plan's refusal of it, with the workload
 * value it is a member of and its name there, which a login's compile places at the program on a role the workload runs
 * on (adapter/served/compile.ts planRefusal); or the plan itself (a value no workload(...) built, a workload's reads, a
 * role's write filter), its CompileError alone.
 */
export type WorkloadPlanRefused =
	| {
			readonly kind: "program"
			readonly workload: unknown
			readonly program: string
			readonly error: CompileError
	  }
	| { readonly kind: "plan"; readonly error: CompileError }

/** The plan's own refusal, of no one program. */
const planRefused = (error: CompileError): WorkloadPlanRefused => ({ kind: "plan", error })

/** The name of the schema a workload plans: its schema's, or a role's base's. */
const baseName = (schema: SchemaInput): string =>
	schema.kind === "role" ? schema.desc.base.name : schema.desc.name

/**
 * Each program of a login's workloads, by name in code point order, with its plan (ProgramPlan), under the base's
 * artifacts: its access paths and statistics, what the snapshot records for the login and what `grizzle check` compares
 * with it, and a query's footprint.
 *
 * Each program is checked as the database would compile it, against its workload's schema: a query or ordered query by
 * the query checker, a ChangeSet by the write front end, a key by its lookup query. A program's own schema is a level
 * of its workload's by content, whatever name places either (workload() checks it, schema/levels.ts isLevelOf). Its
 * checked IR goes to the access-path extraction (physical/access/extract.ts), which applies the fixed form policy, a
 * query's with its filters in the Allen normal form its optimized lowering states them in
 * (lower/optimize/simplify/allen.ts), so an endpoint comparison between two spans is read as the span relation a GiST
 * index serves; a ChangeSet adds the primary key each written relation's statements match facts on, which its key
 * index serves. A query's footprint is read from the same IR (logical/routes.ts footprintOf): a program over a role
 * reads that role's world relations' definitions, and one over a level runs on full roles alone (roles.ts programsOn),
 * whose relations are the base's, whole, so it reads the base's relations on every role it runs on. A program the
 * checker refuses is refused with its CompileError, at its path in the workload, naming the program and its workload
 * (WorkloadPlanRefused).
 */
const loginPlans = (
	login: string,
	workloads: ReadonlyArray<unknown>,
	schema: SchemaInput,
	artifacts: SchemaArtifacts,
	keep: (planned: PlannedFrontend) => void
): Result.Result<ReadonlyArray<readonly [string, ProgramPlan]>, WorkloadPlanRefused> => {
	const programs: Array<readonly [string, ProgramPlan]> = []
	for (const input of workloads) {
		const planned = workloadPlans(login, input, schema, artifacts, keep)
		if (!planned.ok) {
			return planned
		}
		appendAll(programs, planned.value)
	}
	return Result.ok(programs.toSorted(([a], [b]) => compareStrings(a, b)))
}

/**
 * Each program of one workload with its plan, in its record's order (loginPlans), each ChangeSet's front end over the
 * role its workload runs on handed to `keep` under its key (planned.ts FrontendKey), the one its served compile on that
 * role reads again; a ChangeSet of a workload over a level runs on full roles alone (roles.ts programsOn),
 * whose checked worlds its plan's front end over the base is none of, so none is kept.
 */
const workloadPlans = (
	login: string,
	input: unknown,
	schema: SchemaInput,
	artifacts: SchemaArtifacts,
	keep: (planned: PlannedFrontend) => void
): Result.Result<ReadonlyArray<readonly [string, ProgramPlan]>, WorkloadPlanRefused> => {
	const workload = workloadInput(input, schema)
	if (!workload.ok) {
		return Result.err(planRefused(workload.error))
	}
	const reads = workloadReads(workload.value.schema, artifacts)
	if (!reads.ok) {
		return Result.err(planRefused(reads.error))
	}
	const programs: Array<readonly [string, ProgramPlan]> = []
	for (const [name, program] of Object.entries(workload.value.desc.programs)) {
		const planned = Result.mapError(
			programPlan(name, program, reads.value, noClock),
			(e): WorkloadPlanRefused => ({
				kind: "program",
				workload: input,
				program: name,
				error: within(e, ["programs", name])
			})
		)
		if (!planned.ok) {
			return planned
		}
		const { value } = planned
		const world = reads.value.world
		if (value.kind === "write" && world.kind === "role") {
			keep({
				key: {
					laws: artifacts.laws,
					login,
					role: world.role.name,
					program: name,
					clock: value.clock,
					source: transactionClock
				},
				frontend: value.frontend
			})
		}
		programs.push([name, value.plan])
	}
	return Result.ok(programs)
}

/**
 * `footprint` over the relations it reads as they are installed (analysis/schema.ts CheckedSchema installedAs): each
 * alias of one definition's table under its canonical relation, the one table a change reaches every reader of it
 * through, whichever alias it reads, a field routing where every alias's read fixes it to one parameter.
 */
const installedFootprint = (checked: CheckedSchema, footprint: Footprint): Footprint => {
	const tables = new Map<string, Routes>()
	for (const [relation, routes] of footprint.tables) {
		const installed = checked.installedAs(relation)
		const held = tables.get(installed)
		tables.set(
			installed,
			held === undefined
				? routes
				: new Map([...held].filter(([field, param]) => routes.get(field) === param))
		)
	}
	return { tables: new Map([...tables].toSorted(([a], [b]) => compareStrings(a, b))) }
}

/**
 * The footprint of a program's query, read as its plan reads it (programPlan, logical/routes.ts footprintOf): a query's
 * or a clocked query's, under its clock binding; none for an answered read or a ChangeSet, which no live read routes.
 */
const programFootprint = (
	program: ProgramDesc,
	reads: WorkloadReads,
	clock: ClockBinding
): Result.Result<ReadonlyArray<Footprint>, CompileError> => {
	switch (program.kind) {
		case "query":
			return Result.map(queryRead(program.query, reads, clock), (read) => [
				installedFootprint(
					reads.artifacts.laws.checked,
					footprintOf(read.dag, read.facts, read.params)
				)
			])
		case "answered":
		case "changeSet":
			return Result.ok([])
		case "clocked":
			return programFootprint(program.program, reads, program.clock)
	}
}

/**
 * The footprint of each query program of `login`'s workloads over `schema` (ProgramFootprints), under `artifacts`, as
 * its plan reads them (compileWorkload's `footprints`): what a served file compiled over a snapshot routes its live
 * reads by (adapter/served/compile.ts), whose ChangeSets that compile compiles itself, so no ChangeSet's front end is
 * compiled for its plan, where the whole workload plan compiled each a second time to read no footprint of it. A
 * program the checker refuses is refused as the plan refuses it (WorkloadPlanRefused).
 */
export const loginFootprints = (
	workloads: ReadonlyArray<unknown>,
	schema: SchemaInput,
	artifacts: SchemaArtifacts
): Result.Result<ProgramFootprints, WorkloadPlanRefused> => {
	const footprints = new Map<string, Footprint>()
	for (const input of workloads) {
		const workload = workloadInput(input, schema)
		if (!workload.ok) {
			return Result.err(planRefused(workload.error))
		}
		const reads = workloadReads(workload.value.schema, artifacts)
		if (!reads.ok) {
			return Result.err(planRefused(reads.error))
		}
		for (const [name, program] of Object.entries(workload.value.desc.programs)) {
			const read = programFootprint(program, reads.value, noClock)
			if (!read.ok) {
				return Result.err({
					kind: "program",
					workload: input,
					program: name,
					error: within(read.error, ["programs", name])
				})
			}
			for (const footprint of read.value) {
				footprints.set(name, footprint)
			}
		}
	}
	return Result.ok(new Map([...footprints].toSorted(([a], [b]) => compareStrings(a, b))))
}

/**
 * The live plan of an installation's logins (live/notify.ts LivePlan), the union of `footprints`: none where no login
 * serves a read (servesRead); otherwise every stored relation a footprint reads, authored or derived, each with every
 * field some footprint routes it by, in code point order of relations and of fields.
 */
const livePlanOf = (footprints: WorkloadFootprints): LivePlan => {
	if (![...footprints.values()].some(servesRead)) {
		return { kind: "none" }
	}
	const tables = new Map<string, Set<string>>()
	for (const programs of footprints.values()) {
		for (const footprint of programs.values()) {
			for (const [relation, routes] of footprint.tables) {
				const fields = tables.getOrInsertComputed(relation, () => new Set<string>())
				for (const field of routes.keys()) {
					fields.add(field)
				}
			}
		}
	}
	return {
		kind: "reads",
		tables: [...tables]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareStrings) }))
	}
}

/**
 * The workload compiler: every login's programs checked, the types they are served with, and each query's footprint.
 *
 * compileWorkload reads the schema and the logins' workloads together, as the migration generator does: each login's
 * programs' plans (loginPlans), the types they cast their parameters to, which the installation installs, and each
 * query's footprint, whose union is the installation's live plan (livePlanOf). What a program reads by index is no part
 * of it: the served compile of each program (servedWorkload) binds its statements, and their plans' requests are the
 * only ones the installation asks an index for (physical/install/compile.ts), so a read no index serves is a missed
 * index.
 *
 * The workload installs nothing and gates no execution: a program the checker refuses is refused here with its
 * CompileError, naming the program and its workload (WorkloadPlanRefused), so a broken workload never drafts a
 * migration.
 *
 * The plan of `logins` over `schema`, parsed (program/schema.ts parseSchemaInput), under the options' artifacts.
 */
export const compileWorkload = (
	logins: ReadonlyArray<LoginWorkloads>,
	schema: SchemaInput,
	options: WorkloadOptions
): Result.Result<WorkloadPlan, WorkloadPlanRefused> =>
	workloadPlanned(logins, schema, options, () => undefined, silentPhases)

/**
 * The plan of `logins` over `schema` (compileWorkload), with the front end it compiled of each ChangeSet of a workload
 * over a role (planned.ts PlannedFrontends): what the served compile of the logins over the same basis reads where it
 * would compile that front end again (servedWorkload), so a generate compiles each such ChangeSet's front end once.
 * compileWorkload keeps none, so a plan no served compile follows holds no front end past its program's plan. Each
 * login's programs are a phase reported to `phases` (`workloadLogin`).
 */
export const planWorkload = (
	logins: ReadonlyArray<LoginWorkloads>,
	schema: SchemaInput,
	options: WorkloadOptions,
	phases: Phases
): Result.Result<
	{ readonly plan: WorkloadPlan; readonly frontends: PlannedFrontends },
	WorkloadPlanRefused
> => {
	const frontends: Array<PlannedFrontend> = []
	return Result.map(
		workloadPlanned(
			logins,
			schema,
			options,
			(planned) => {
				frontends.push(planned)
			},
			phases
		),
		(plan) => ({ plan, frontends: new PlannedFrontends(frontends) })
	)
}

/** The plan of `logins` over `schema`, each ChangeSet's front end over a role handed to `keep` with its key, each login's
 * programs reported to `phases`. */
const workloadPlanned = (
	logins: ReadonlyArray<LoginWorkloads>,
	schema: SchemaInput,
	options: WorkloadOptions,
	keep: (planned: PlannedFrontend) => void,
	phases: Phases
): Result.Result<WorkloadPlan, WorkloadPlanRefused> => {
	const { artifacts } = options
	const footprints = new Map<string, ReadonlyMap<string, Footprint>>()
	const served: Array<ServedTypes> = []
	for (const login of [...logins].toSorted((a, b) => compareStrings(a.login, b.login))) {
		const programs = phased(phases, { name: "workloadLogin", of: [login.login] }, () =>
			loginPlans(login.login, login.workloads, schema, artifacts, keep)
		)
		if (!programs.ok) {
			return programs
		}
		appendAll(
			served,
			programs.value.map(([, planned]) => planned.served)
		)
		footprints.set(
			login.login,
			new Map(
				programs.value.flatMap(([name, planned]) =>
					planned.kind === "query" ? [[name, planned.footprint] as const] : []
				)
			)
		)
	}
	return Result.ok({
		schema: artifacts.fingerprint,
		params: servedTogether(served),
		schemaName: baseName(schema),
		footprints,
		live: livePlanOf(footprints)
	})
}

/** A login of the installation as generate compiles it (ChangeLogin), by its name. */
export interface ServedLogin<S extends ParamSource = ParamSource> extends ChangeLogin<S> {
	readonly name: string
}

/**
 * The plan of an installation's logins as generate compiles them: their workloads' plan (compileWorkload), and every
 * role of every login with the ChangeSets of the login's workloads that run on it compiled over the artifacts its
 * login's served file compiles over (change.ts readCommittedChanges), in the form its certificate's level serves, by the
 * login's name, then the role's name in it: what each login's served file projects; and the certificate of each of
 * those roles (program/isolation/certification.ts), the level its writes begin at, which the installation's guards
 * follow (program/install.ts installationOver); the roles whose served ChangeSets fill a carrier; and the
 * fences the certification states
 * (analysis/isolation/certify.ts Fence), each with the roles certified READ COMMITTED that rely on it.
 */
export interface ServedWorkloadPlan<S extends ParamSource = ParamSource> extends WorkloadPlan {
	readonly changes: ReadonlyMap<string, ReadonlyMap<string, ServableRole<Isolation, S>>>
	/** Every read member of every login compiled on each role it runs on (loginReads), by the login's name, then the
	 * role's: what each login's served file projects its reads from. */
	readonly reads: ReadonlyMap<string, ReadonlyMap<string, RoleReads>>
	readonly certification: ReadonlyArray<RoleIsolation>
	/** The roles whose served ChangeSets fill a carrier (servedCarriers), each with its carriers' columns, which the
	 * installation grants EXECUTE on what the CHECKs of those columns' domains call. */
	readonly carriers: ReadonlyArray<RoleCarriers>
	/** The roles whose served programs reach a declared function, each with the function (servedCalls), which the
	 * installation grants EXECUTE on the function. */
	readonly calls: ReadonlyArray<RoleCall>
	readonly fences: ReadonlyArray<Fence>
	/** Every program of every login, its plans each statement its served file may send (servedPrograms), whose reads'
	 * requests the installation asks an index for. */
	readonly programs: ReadonlyArray<ServedProgram>
	/** Every role of every login with its world views (servedWorldViews), which the installation creates them from. */
	readonly worldViews: ReadonlyArray<RoleWorldViews>
}

/**
 * Every read member of a role's workloads compiled for the role, once (reads.ts CompiledRead), by the program's name:
 * what the workload plan reads each read's plans of (readPlansOf) and the role's served form is projected from
 * (adapter/served/login.ts), its served file compiling none again.
 */
export type RoleReads = ReadonlyMap<string, CompiledRead>

/**
 * Every read member of `workload` compiled on each of the roles `roles` that it runs on (programsOn), for the role over
 * its artifacts, its clocked readings counting from `clock` (reads.ts compiledRead), by the role's name, in the roles'
 * order: what the installation asks the indexes of a login's reads for (servedWorkload), before any of them is
 * projected, so the served file each is projected into later resolves every read it makes, and what that served file
 * projects. A read that does not compile on a role is that role's ChangeRefused at the program.
 */
export const loginReads = (
	workload: ReadonlyArray<unknown>,
	roles: ReadonlyMap<string, ServableRole<Isolation, ParamSource>>,
	clock: ClockSource
): Result.Result<ReadonlyMap<string, RoleReads>, ChangeRefused> => {
	const out = new Map<string, RoleReads>()
	for (const [name, role] of roles) {
		const running = programsOn(role.input, workload)
		if (!running.ok) {
			return Result.err({ role: name, program: undefined, error: running.error })
		}
		const reads = new Map<string, CompiledRead>()
		for (const member of running.value) {
			if (member.kind === "changeSet") {
				continue
			}
			const read = compiledRead(member, role.input, role.artifacts, clock)
			if (!read.ok) {
				return Result.err({ role: name, program: member.name, error: read.error })
			}
			reads.set(member.name, read.value)
		}
		out.set(name, reads)
	}
	return Result.ok(out)
}

/** The plans of every read of a login's roles (loginReads), by program: every role's, in the roles' order. */
const readsPlans = (
	reads: ReadonlyMap<string, RoleReads>
): ReadonlyArray<readonly [string, ReadonlyArray<ReadPlan<AccessIndexRequest>>]> =>
	[...reads.values()].flatMap((role) =>
		[...role].map(([program, read]) => [program, readPlansOf(read)] as const)
	)

/** The plans of every ChangeSet of a login's roles `roles`, by program: every variant's of every role's. */
const loginWrites = (
	roles: ReadonlyMap<string, ServableRole>
): ReadonlyArray<readonly [string, ReadonlyArray<ReadPlan<AccessIndexRequest>>]> =>
	[...roles.values()].flatMap((role) =>
		[...role.members].map(
			([program, variants]) =>
				[program, variantsEntries(variants).map((entry) => entry.compiled.plan)] as const
		)
	)

/** The writes of a ChangeSet's variants, every form it may be served in. */
const variantWrites = (variants: ServableVariants): ReadonlyArray<ServableWrite> =>
	variants.kind === "form"
		? [variants.entry.compiled]
		: [...variantWrites(variants.holding), ...variantWrites(variants.lacking)]

/**
 * The roles of `served`, each login's ChangeSets in the forms their certificates serve them by role, any of whose served
 * ChangeSets fill a carrier (ServableWrite `carried`), with the field of each column of every program carrier they
 * fill, in login then role order, whose domains' CHECKs the fills call.
 */
const servedCarriers = (
	served: ReadonlyMap<string, ReadonlyMap<string, ServableRole>>
): ReadonlyArray<RoleCarriers> =>
	[...served].flatMap(([login, roles]) =>
		[...roles].flatMap(([role, changes]): ReadonlyArray<RoleCarriers> => {
			const columns = [...changes.members.values()].flatMap(variantWrites).flatMap((w) => w.carried)
			return columns.length > 0 ? [{ login, role, columns }] : []
		})
	)

/**
 * The definition a statement of `role` evaluates where it reads the relation `relation` by its name, none where a table
 * holds its rows: a derived relation's of the role's base, stored or live alike, or the role's query entry's. The
 * lowering splices a live derived relation's definition into the statement, and a stored one's wherever its table does
 * not serve the read, a write's of one of its holders among them (analysis/schema.ts CheckedSchema serves); and
 * PostgreSQL expands a query entry's view into the statement. Each runs inside the statement as the role.
 */
const definitionsOf =
	(role: OwnedRole) =>
	(relation: string): QueryDesc | undefined => {
		const derived = role.base.relations[relation]
		if (derived?.kind === "derived") {
			return derived.desc.query
		}
		const entry = role.relations[relation]
		return entry?.kind === "world" ? entry.query : undefined
	}

/**
 * The roles of `logins`, each with every declared function the programs of the login's workloads that run on it reach,
 * by its name, in login, role and function order: each a program's Description calls, and each the definition of a
 * relation it reads calls, at any depth through the relations each definition reads (ir/desc.ts callsThrough,
 * `definitionsOf`). PostgreSQL checks EXECUTE against the role that runs a statement on every function the statement
 * evaluates, a view's among them, and a definition spliced into the statement, or a view expanded into it, calls its
 * functions there, a SECURITY DEFINER function's call among them. One reachability decides the grant whatever holds a
 * derived relation's rows: a stored relation's definition is read wherever its table does not serve the read, a
 * write's of one of its holders among them, and calls only immutable functions (analysis/derived/storage.ts), which
 * read no data, so a relation the installation moves between stored and live never moves a grant.
 */
const servedCalls = (
	logins: ReadonlyArray<ServedLogin>
): Result.Result<ReadonlyArray<RoleCall>, ServedWorkloadRefused> => {
	const out: Array<RoleCall> = []
	for (const login of logins) {
		for (const role of login.roles) {
			const running = programsOn(role, login.workload)
			if (!running.ok) {
				return Result.err({ kind: "workload", error: running.error })
			}
			const functions = callsThrough(
				running.value.map((p) => p.desc),
				definitionsOf(loginRole(role, login.named.owned))
			)
			for (const fn of [...functions].toSorted(compareStrings)) {
				out.push({ login: login.name, role: role.desc.name, function: fn })
			}
		}
	}
	return Result.ok(out)
}

/** The plan of the logins refused: the certification of their roles, or a login's change compile. */
export type ServedWorkloadRefused =
	| { readonly kind: "workload"; readonly error: CompileError }
	| { readonly kind: "login"; readonly login: string; readonly refused: ChangeRefused }

/**
 * The plan of `logins` as generate compiles it (ServedWorkloadPlan): `planned`, their workloads' plan under the options'
 * artifacts (compileWorkload), then each login's change members, in the logins' order, each over the artifacts the
 * login's served file compiles over, which serve the plan's parameter types (WorkloadPhysical.params), then every
 * role's certificate over them under the options' artifacts, then each login's reads compiled on every role they run
 * on (loginReads), every program's plans (`programs`) what the installation indexes and every compiled read (`reads`)
 * what the login's served file projects. Each login's change compile, the
 * certification and each login's reads are phases reported to `phases` (`loginChanges`, `certification`,
 * `loginReads`).
 */
export const servedWorkload = <S extends ParamSource>(
	planned: WorkloadPlan,
	logins: ReadonlyArray<ServedLogin<S>>,
	options: WorkloadOptions,
	phases: Phases
): Result.Result<ServedWorkloadPlan<S>, ServedWorkloadRefused> => {
	const changes = new Map<string, ReadonlyMap<string, ReadCommittedRole<S>>>()
	for (const login of logins) {
		const roles = phased(phases, { name: "loginChanges", of: [login.name] }, () =>
			readCommittedChanges(login, phases)
		)
		if (!roles.ok) {
			return Result.err({ kind: "login", login: login.name, refused: roles.error })
		}
		changes.set(login.name, roles.value)
	}
	const calls = servedCalls(logins)
	if (!calls.ok) {
		return calls
	}
	return Result.flatMap(
		Result.mapError(
			phased(phases, { name: "certification", of: [] }, () =>
				certification(options.artifacts, changes)
			),
			(error): ServedWorkloadRefused => ({
				kind: "workload",
				error
			})
		),
		(certified) => {
			const programs: Array<ServedProgram> = []
			const compiledReads = new Map<string, ReadonlyMap<string, RoleReads>>()
			for (const login of [...logins].toSorted((a, b) => compareStrings(a.name, b.name))) {
				const roles = defined(
					certified.served.get(login.name),
					`the certified roles of login ${login.name}, a login it certified`
				)
				const reads = phased(phases, { name: "loginReads", of: [login.name] }, () =>
					loginReads(login.workload, roles, login.clock)
				)
				if (!reads.ok) {
					return Result.err({ kind: "login", login: login.name, refused: reads.error })
				}
				compiledReads.set(login.name, reads.value)
				appendAll(
					programs,
					servedPrograms(login.name, [...loginWrites(roles), ...readsPlans(reads.value)])
				)
			}
			return Result.ok<ServedWorkloadPlan<S>>({
				...planned,
				changes: certified.served,
				reads: compiledReads,
				certification: certified.certificates,
				carriers: servedCarriers(certified.served),
				calls: calls.value,
				fences: certified.fences,
				programs,
				worldViews: servedWorldViews(certified.served)
			})
		}
	)
}

/**
 * How one program of a login's workloads differs from what the snapshot records for the login: a program the snapshot
 * does not record, one it records that the workloads no longer hold, or one whose access paths moved.
 */
export type AccessDrift = { readonly program: string } & (
	| { readonly kind: "unrecorded" }
	| { readonly kind: "gone" }
	| { readonly kind: "moved" }
)

/** Whether two lists hold equal items in the same order. */
const sameList = <A>(
	a: ReadonlyArray<A>,
	b: ReadonlyArray<A>,
	same: (x: A, y: A) => boolean
): boolean =>
	a.length === b.length &&
	a.every((x, i) => {
		const y = b[i]
		return y !== undefined && same(x, y)
	})

const samePath = (a: AccessPath, b: AccessPath): boolean =>
	a.relation === b.relation &&
	a.derived === b.derived &&
	a.method === b.method &&
	a.use === b.use &&
	a.fixed === b.fixed &&
	sameList(a.keys, b.keys, (x, y) => x.field === y.field && x.dir === y.dir)

const sameAccess = (a: ProgramAccess, b: ProgramAccess): boolean =>
	sameList(a.paths, b.paths, samePath)

/**
 * Every program whose access differs from the record, in program name order: the workload's access paths (loginAccess)
 * against those the snapshot recorded for the login, none when the login is no key of it.
 * `grizzle check` reports each, naming the program and saying to run `grizzle generate`.
 */
export const accessDrift = (
	recorded: WorkloadAccess,
	login: string,
	current: Readonly<Record<string, ProgramAccess>>
): ReadonlyArray<AccessDrift> => {
	const before = Object.hasOwn(recorded, login) ? recorded[login] : undefined
	const was: Readonly<Record<string, ProgramAccess>> = before ?? {}
	const names = [...new Set([...Object.keys(was), ...Object.keys(current)])].toSorted(
		compareStrings
	)
	return names.flatMap((program): ReadonlyArray<AccessDrift> => {
		const a = Object.hasOwn(was, program) ? was[program] : undefined
		const b = Object.hasOwn(current, program) ? current[program] : undefined
		if (a === undefined) {
			return b === undefined ? [] : [{ kind: "unrecorded", program }]
		}
		if (b === undefined) {
			return [{ kind: "gone", program }]
		}
		return sameAccess(a, b) ? [] : [{ kind: "moved", program }]
	})
}

/** A drift's sentence, naming the login's program: what `grizzle check`'s finding says. */
export const accessDriftText = (login: string, drift: AccessDrift): string => {
	const program = `program ${login}.${drift.program}`
	switch (drift.kind) {
		case "unrecorded":
			return `${program} is not in snapshot.json`
		case "gone":
			return `snapshot.json records ${program}, which no workload of the login holds`
		case "moved":
			return `${program} reads through other access paths than snapshot.json records`
	}
}
