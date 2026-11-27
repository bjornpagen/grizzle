import { appendAll } from "@bjornpagen/grizzle-text/base/array"
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
import { type ClockBinding, noClock, transactionClock } from "#compiler/ir/clock.ts"
import { noneWritten, servedQuery } from "#compiler/ir/derived.ts"
import {
	type ChangeSetDesc,
	type WorkloadDesc,
	callsThrough,
	decodeDesc,
	isOrderedQuery,
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
import {
	mergeOrder,
	type NodeOf,
	type RelNode,
	type Rooted,
	type RootedDag
} from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import {
	analyzeLogical,
	checkerEvidence,
	type LogicalAnalysis,
	queryEvidence,
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
import { optimizedInput, rewrittenQuery } from "#compiler/lower/optimize/pipeline.ts"
import { allenNormalDag } from "#compiler/lower/optimize/simplify/allen.ts"
import { asItStands, type PageWindow, windowDriver } from "#compiler/lower/shapes/page/driver.ts"
import { leakyEquality } from "#compiler/physical/access/catalog.ts"
import { type WorkloadPhysical, workloadRequests } from "#compiler/physical/access/extension.ts"
import {
	declaredKeys,
	extractAccess,
	keyOrdersOf,
	noWorlds,
	type PagedRoot,
	type WorldView,
	type WorldViews
} from "#compiler/physical/access/extract.ts"
import { uniquePaths } from "#compiler/physical/access/paths.ts"
import { type ServedTypes, servedTogether, servedTypesOf } from "#compiler/physical/ddl/domains.ts"
import { namedRole, worldNames } from "#compiler/physical/ddl/names.ts"
import type { RoleCall, RoleCarriers, ServedProgram } from "#compiler/physical/install/extension.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"

import type { SchemaInput } from "#compiler/program/input.ts"
import { certification } from "#compiler/program/isolation/certification.ts"
import type { ArtifactsWorld, SchemaArtifacts } from "#compiler/program/schema.ts"
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
import { loginRole, programsOn } from "#compiler/program/workload/roles.ts"
import { workloadState } from "#compiler/program/workload/value.ts"
import { inlineWorlds } from "#compiler/program/workload/world.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { ownBuiltRole, type OwnedRole } from "#compiler/schema/own.ts"
import type { ReadPlan } from "#compiler/sql/plan.ts"
import { compileChangeSet, type WriteFrontend } from "#compiler/write/frontend/compile.ts"
import type { ServableWrite } from "#compiler/write/program/served.ts"

interface WorkloadOptions {
	/**
	 * The workload schema's artifacts, as the installation the plan extends names them: their vector schema qualifies the
	 * HNSW operator class of `requests`.
	 */
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
	/** Each login's programs' access, by login, then program: what the snapshot records (snapshot/types.ts). */
	readonly access: WorkloadAccess
	/** The access requests, on stored and derived relations, for the vector schema of the artifacts. */
	readonly requests: ReadonlyArray<AccessIndexRequest>
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
	/** The roots a page may read, an Ordered query's ordered result, each with how its windows read its rows. */
	readonly pageable: ReadonlyArray<PagedRoot>
}

/**
 * One program's plan, as the database would compile it on the workload schema: a query's access and footprint, both
 * read from its one checked IR (queryRead); a ChangeSet's types alone, since no read subscribes to a write and its
 * reads' paths are its served write's plans' (servedPrograms, physical/install/compile.ts programAccess); and an
 * answered query, read at its call's instant alone (`answered`, a clocked read's among them), its access alone, since
 * no change wakes it.
 * A ChangeSet over a role is the role's, whose statements write the base's tables. A parameter a member binds to the
 * database's clock reads as a parameter does: its access paths are the ones a caller's value of it plans.
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
	| { readonly kind: "query"; readonly access: ProgramAccess; readonly footprint: Footprint }
	| { readonly kind: "answered"; readonly access: ProgramAccess }
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
			return Result.flatMap(queryRead(query, reads, clock), (read) =>
				Result.flatMap(accessRead(query, read, reads, clock), (accessed) =>
					Result.map(
						loweredIr(accessed, reads.artifacts, isOrderedQuery(query)),
						(lowered): Planned => {
							const ir = rowsIr(read, isOrderedQuery(query), reads.artifacts)
							const planned = {
								served: servedTypesOf(name, read.params, ir.roots),
								access: irAccess(lowered, reads.artifacts.laws, reads.worlds)
							}
							switch (kind) {
								case "query":
									return {
										kind: "read",
										plan: {
											kind,
											...planned,
											footprint: installedFootprint(
												reads.artifacts.laws.checked,
												footprintOf(read.dag, read.facts, read.params)
											)
										}
									}
								case "answered":
									return { kind: "read", plan: { kind, ...planned } }
							}
						}
					)
				)
			)
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
 * what a test reads a program's footprint and its access beside.
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
 * What every program of a workload is checked and planned over, read once for the workload: its world, and the base's
 * artifacts (its checked schema, derived analysis and law model).
 */
interface WorkloadReads {
	readonly world: ArtifactsWorld
	readonly artifacts: SchemaArtifacts
	/** The role's world relations as the barrier views they are installed as, which a program's access reads beneath. */
	readonly worlds: WorldViews
}

const workloadReads = (
	schema: SchemaInput,
	artifacts: SchemaArtifacts
): Result.Result<WorkloadReads, CompileError> =>
	schema.kind === "role"
		? Result.flatMap(ownBuiltRole(schema.desc, artifacts.owned), (role) =>
				Result.flatMap(namedRole(role, artifacts.names.levels), (named) =>
					Result.flatMap(checkedRoleOver(role, artifacts.derived.schema), (checked) =>
						Result.map(worldViewsOf(checked, artifacts), (worlds): WorkloadReads => ({
							world: { kind: "role", role, checked, names: worldNames(named, artifacts.names) },
							artifacts,
							worlds
						}))
					)
				)
			)
		: Result.ok<WorkloadReads>({ world: { kind: "reality" }, artifacts, worlds: noWorlds })

/**
 * Each world relation of the role `checked` as the security barrier view the installation creates of it
 * (physical/access/extract.ts WorldView): its definition as its view's lowering rewrites it, read as rows the way the
 * view reads them, in the transaction context (physical/ddl/roles.ts worldView, physical/derived/definition.ts
 * lowerDefinition), and its heading's columns of a leaky equality, which no reader's qual passes the barrier on.
 */
const worldViewsOf = (
	checked: CheckedSchema<RoleWorld>,
	artifacts: SchemaArtifacts
): Result.Result<WorldViews, CompileError> => {
	const rows = checked.world.base.rows(checked.writable)
	const views = new Map<string, WorldView>()
	for (const e of checked.entries) {
		if (e.kind !== "world") {
			continue
		}
		const rewritten = Result.flatMap(
			optimizedInput(servedQuery(e.analysis.query, rows), queryEvidence),
			(input) =>
				rewrittenQuery(input, {
					names: artifacts.names,
					subject: { kind: "derivedDefinition" },
					catalog: evidenceCatalog(artifacts),
					context: "transaction"
				})
		)
		if (!rewritten.ok) {
			return rewritten
		}
		const [root] = rewritten.value.dag.roots
		views.set(e.name, {
			root,
			leaky: new Set(root.heading.flatMap((c) => (leakyEquality(c.type) ? [c.name] : [])))
		})
	}
	return Result.ok((relation) => views.get(relation))
}

/**
 * The read a program over a role's access is read off: its query over the role's own checked schema, every world
 * relation a world Base the extraction reads beneath its barrier, as the login's served statement reads the role's
 * views; over reality, the read itself.
 */
const accessRead = (
	query: QueryDesc,
	read: AnalyzedQuery,
	reads: WorkloadReads,
	clock: ClockBinding
): Result.Result<AnalyzedQuery, CompileError> =>
	reads.world.kind === "role" ? analyzedQuery(query, reads.world.checked, clock) : Result.ok(read)

/**
 * An analyzed query's IR as its access is extracted: its root with every node's logical metadata (logical/annotate.ts),
 * by which a join partner of at most one row, such as a context or a membership's row, binds every probe of the
 * occurrences it joins (physical/access/extract.ts), pageable where an ordered query's root is its ordered result.
 */
const rowsIr = (
	analyzed: AnalyzedQuery,
	ordered: boolean,
	artifacts: SchemaArtifacts
): ProgramIr => {
	const root = withLogicalMeta(analyzed.dag, analyzed.analysis, (node) => node, new Set()).roots[0]
	return {
		roots: [root],
		params: analyzed.params,
		pageable:
			ordered && root.kind === "OrderedResult"
				? [{ root, window: servedWindow(root, artifacts) }]
				: []
	}
}

/**
 * How a served page's windows read its rows (lower/shapes/page/driver.ts), as its access is extracted: driven where its
 * root meets the rule in the snapshot context a served read runs in, on the schema's containments, declared and drawn,
 * and its relations' declared keys, the order its pages compare by its ordered result's own.
 */
const servedWindow = (root: NodeOf<"OrderedResult">, artifacts: SchemaArtifacts): PageWindow => {
	const driver = windowDriver(root, mergeOrder(root.orders, root.input.heading), {
		context: "snapshot",
		containments: evidenceCatalog(artifacts).containments,
		unitOf: (relation) => artifacts.owned.unitOf.get(relation)?.fields ?? [],
		keyAmong: (base, fields) => {
			const key = declaredKeys(base).find((k) => k.every((f) => fields.includes(f)))
			return key === undefined
				? undefined
				: { columns: key, grounds: { premises: [], context: "immediate" } }
		}
	})
	return driver === undefined ? asItStands : { kind: "driven", driver }
}

/** A query's checked DAG in the normal forms its access is extracted from, with its logical analysis and parameters. */
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
 * joined on a key into one), with the logical analysis of that DAG under the checker's evidence: what its access paths
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
		(frontend) => ({
			ir: { roots: frontend.ir.dag.roots, params: frontend.params, pageable: [] },
			frontend
		})
	)
}

/**
 * A read's IR as its optimized lowering lowers it (lower/optimize/pipeline.ts rewrittenQuery), what its access is read
 * off: the served query annotated under the query's evidence (optimizedInput), rewritten in the snapshot context a served
 * read runs in, so every decision the access reads (a driven semi-join, a region's chain, a row site) is the one its
 * statement is printed from, over the same nodes; pageable where an ordered query's root is its ordered result.
 */
const loweredIr = (
	read: AnalyzedQuery,
	artifacts: SchemaArtifacts,
	ordered: boolean
): Result.Result<ProgramIr, CompileError> =>
	Result.flatMap(optimizedInput(read.served, queryEvidence), (input) =>
		Result.map(
			rewrittenQuery(input, {
				names: artifacts.reads,
				subject: { kind: "query" },
				catalog: evidenceCatalog(artifacts),
				context: "snapshot"
			}),
			(rewritten): ProgramIr => {
				const [root] = rewritten.dag.roots
				return {
					roots: rewritten.dag.roots,
					params: read.params,
					pageable:
						ordered && root.kind === "OrderedResult"
							? [{ root, window: servedWindow(root, artifacts) }]
							: []
				}
			}
		)
	)

/**
 * `plan` with each served ChangeSet's paths, every read its served write's bound statements make
 * (physical/install/compile.ts Installation `programAccess`), recorded as its access: its programs' access, its paths and
 * its requests, what the snapshot records and `grizzle check` compares.
 */
export const withProgramAccess = (
	plan: WorkloadPlan,
	programs: ReadonlyArray<{
		readonly login: string
		readonly program: string
		readonly paths: ReadonlyArray<AccessPath>
	}>,
	vectorSchema: string
): WorkloadPlan => {
	const access: Record<string, Readonly<Record<string, ProgramAccess>>> = { ...plan.access }
	for (const p of programs) {
		const own = Object.hasOwn(access, p.login) ? access[p.login] : undefined
		const before = own !== undefined && Object.hasOwn(own, p.program) ? own[p.program] : undefined
		access[p.login] = {
			...own,
			[p.program]: { paths: uniquePaths([...(before?.paths ?? []), ...p.paths]) }
		}
	}
	const paths = uniquePaths([...plan.paths, ...programs.flatMap((p) => p.paths)])
	return {
		...plan,
		access,
		paths,
		requests: workloadRequests({ schema: plan.schema, paths, params: plan.params }, vectorSchema)
	}
}

/**
 * Each login's served ChangeSets as the installation indexes them (physical/install/extension.ts ServedProgram), by the
 * login's name and the program's, in that order: the plan of each compile of it its served file sends, every role's
 * and every variant's (write/program/served.ts ServableWrite `plan`).
 */
export const servedPrograms = (
	changes: ServedWorkloadPlan["changes"]
): ReadonlyArray<ServedProgram> =>
	[...changes]
		.toSorted(([a], [b]) => compareStrings(a, b))
		.flatMap(([login, roles]) => {
			const byProgram = new Map<string, Array<ReadPlan<AccessIndexRequest>>>()
			for (const role of roles.values()) {
				for (const [program, variants] of role.members) {
					appendAll(
						byProgram.getOrInsertComputed(program, () => []),
						variantsEntries(variants).map((entry) => entry.compiled.plan)
					)
				}
			}
			return [...byProgram]
				.toSorted(([a], [b]) => compareStrings(a, b))
				.map(([program, plans]): ServedProgram => ({ login, program, plans }))
		})

/**
 * The access paths of a program's IR, each key read in its index's order as the law model `laws` installs it, and each
 * world relation it reads beneath its barrier view (`worlds`).
 */
const irAccess = (ir: ProgramIr, laws: LawModel, worlds: WorldViews): ProgramAccess =>
	extractAccess(ir.roots, {
		pageable: ir.pageable,
		keyOrders: keyOrdersOf(laws.theory.relations),
		worlds
	})

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

/** A program's access as its plan reads it: a read's paths; none of a ChangeSet's, which its served write's plans ask. */
const programAccess = (planned: ProgramPlan): ProgramAccess =>
	planned.kind === "changeSet" ? { paths: [] } : planned.access

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
 * The workload compiler: every login's programs' access paths, merged as physical requests.
 *
 * compileWorkload reads the schema and the logins' workloads together, as the migration generator does: each login's
 * programs' plans (loginPlans), their access, which the snapshot records by login and program, and each query's
 * footprint, whose union is the installation's live plan (livePlanOf). Equal paths of several programs
 * are one request, justified by the workload's access; which programs ask for it, the snapshot's record of each
 * program's access says, so a program edit that moves no index changes no object. A path on a derived relation is a
 * request like any other: the installation plans it on the relation's stored table wherever it installs the table.
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
	const access: Record<string, Readonly<Record<string, ProgramAccess>>> = {}
	const footprints = new Map<string, ReadonlyMap<string, Footprint>>()
	const served: Array<ServedTypes> = []
	for (const login of [...logins].toSorted((a, b) => compareStrings(a.login, b.login))) {
		const programs = phased(phases, { name: "workloadLogin", of: [login.login] }, () =>
			loginPlans(login.login, login.workloads, schema, artifacts, keep)
		)
		if (!programs.ok) {
			return programs
		}
		access[login.login] = Object.fromEntries(
			programs.value.map(([name, planned]) => [name, programAccess(planned)] as const)
		)
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
	const paths: ReadonlyArray<AccessPath> = uniquePaths(
		Object.values(access).flatMap((programs) => Object.values(programs).flatMap((p) => p.paths))
	)
	const physical: WorkloadPhysical = {
		schema: artifacts.fingerprint,
		paths,
		params: servedTogether(served)
	}
	return Result.ok({
		...physical,
		schemaName: baseName(schema),
		access,
		requests: workloadRequests(physical, artifacts.names.vectorSchema),
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
	readonly certification: ReadonlyArray<RoleIsolation>
	/** The roles whose served ChangeSets fill a carrier (servedCarriers), each with its carriers' columns, which the
	 * installation grants EXECUTE on what the CHECKs of those columns' domains call. */
	readonly carriers: ReadonlyArray<RoleCarriers>
	/** The roles whose served programs reach a declared function, each with the function (servedCalls), which the
	 * installation grants EXECUTE on the function. */
	readonly calls: ReadonlyArray<RoleCall>
	readonly fences: ReadonlyArray<Fence>
}

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
 * role's certificate over them under the options' artifacts. Each login's change compile and the certification are
 * phases reported to `phases` (`loginChanges`, `certification`).
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
	return Result.map(
		Result.mapError(
			phased(phases, { name: "certification", of: [] }, () =>
				certification(options.artifacts, changes)
			),
			(error): ServedWorkloadRefused => ({
				kind: "workload",
				error
			})
		),
		(certified): ServedWorkloadPlan<S> => ({
			...planned,
			changes: certified.served,
			certification: certified.certificates,
			carriers: servedCarriers(certified.served),
			calls: calls.value,
			fences: certified.fences
		})
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
