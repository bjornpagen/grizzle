import type { Fence, RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import { checkedRoleOver, type CheckedSchema } from "#compiler/analysis/schema.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchCompileError, compareText } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, within } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type ChangeSetDesc,
	type WorkloadDesc,
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
	StatisticsShape,
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
import { type Footprint, footprintOf } from "#compiler/logical/routes.ts"
import { keyJoinNormalDag } from "#compiler/lower/optimize/eliminate/index.ts"
import { allenNormalDag } from "#compiler/lower/optimize/simplify/allen.ts"
import { type WorkloadPhysical, workloadRequests } from "#compiler/physical/access/extension.ts"
import { extractAccess } from "#compiler/physical/access/extract.ts"
import { uniquePaths } from "#compiler/physical/access/paths.ts"
import { type ParamTypes, paramTypesOf } from "#compiler/physical/ddl/domains.ts"
import { namedRole, type WorldNames, worldNames } from "#compiler/physical/ddl/names.ts"
import type { RoleHold, RoleOfLogin } from "#compiler/physical/install/extension.ts"
import {
	mergeStatistics,
	type StatisticsRequest,
	statisticsKinds
} from "#compiler/physical/statistics/statistics.ts"

import { certification } from "#compiler/program/isolation/certification.ts"
import type { SchemaArtifacts, SchemaInput } from "#compiler/program/schema.ts"
import {
	type ChangeLogin,
	type ChangeRefused,
	type CompiledVariants,
	loginChanges,
	type RoleChanges
} from "#compiler/program/workload/change.ts"
import { workloadState } from "#compiler/program/workload/value.ts"
import { inlineWorlds } from "#compiler/program/workload/world.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { ownBuiltRole, type OwnedRole } from "#compiler/schema/own.ts"
import type { WriteWorld } from "#compiler/write/entry/precheck.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import { createsCarrier } from "#compiler/write/program/artifact.ts"

interface WorkloadOptions {
	/**
	 * The workload schema's artifacts, as the installation the plan extends names them: their vector schema qualifies the
	 * HNSW operator class of `requests`.
	 */
	readonly artifacts: SchemaArtifacts
	/** The roles the installation installs over the schema, whose write filters the plan plans. */
	readonly roles: ReadonlyArray<OwnedRole>
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
 * Whether a login serves a read, by its programs' footprints `footprints`: its workload plans a query program, as every
 * read member does, a query, an ordered query, a paged read and a key's lookup alike, while a ChangeSet, a refresh and a
 * clocked read, answered at its call's instant and never watched, plan none. A login that serves one watches, so its installation holds a live source (livePlanOf) and its served file
 * names it (adapter served/project.ts).
 */
export const servesRead = (footprints: ProgramFootprints): boolean => footprints.size > 0

interface ProgramIr {
	/** The program's roots: a query's root, or a ChangeSet's read-backs and laws. */
	readonly roots: ReadonlyArray<RelNode>
	/** The parameters it declares, whose patterns the installation gives a pattern domain each. */
	readonly params: ReadonlyArray<ParamDecl>
	/** The roots a page may read: an Ordered query's ordered result. */
	readonly pageable: ReadonlyArray<RelNode>
	/** The write targets of a ChangeSet: each written relation's primary key. */
	readonly targets: ReadonlyArray<AccessPath>
}

/**
 * One program's plan, as the database would compile it on the workload schema: a query's access and footprint, both
 * read from its one checked IR (queryRead); a ChangeSet's access alone, since no read subscribes to a write; and a
 * query a clocked member reads at its call's instant (`instant`), its access alone, since no change reaches its answer.
 * A ChangeSet over a role is the role's, whose statements write the base's tables. A parameter a member binds to the
 * database's clock reads as a parameter does: its access paths are the ones a caller's value of it plans.
 */
type ProgramPlan = { readonly params: ReadonlyArray<ParamDecl> } & (
	| { readonly kind: "query"; readonly access: ProgramAccess; readonly footprint: Footprint }
	| { readonly kind: "instant"; readonly access: ProgramAccess }
	| { readonly kind: "changeSet"; readonly access: ProgramAccess }
)

const programPlan = (
	program: ProgramDesc,
	reads: WorkloadReads
): Result.Result<ProgramPlan, CompileError> => {
	switch (program.kind) {
		case "query": {
			const ordered = isOrderedQuery(program.query)
			return Result.map(queryRead(program.query, reads), (read): ProgramPlan => ({
				kind: "query",
				params: read.params,
				access: irAccess(rowsIr(read, ordered)),
				footprint: footprintOf(read.dag, read.analysis, read.params)
			}))
		}
		case "changeSet": {
			const world = reads.world
			return Result.map(
				changeSetIr(
					program.changeSet,
					world.kind === "role" ? world.checked : reads.artifacts.derived.schema,
					reads
				),
				(ir): ProgramPlan => ({ kind: "changeSet", params: ir.params, access: irAccess(ir) })
			)
		}
		case "clocked":
			return Result.map(programPlan(program.program, reads), (plan): ProgramPlan => {
				switch (plan.kind) {
					case "query":
					case "instant":
						return { kind: "instant", params: plan.params, access: plan.access }
					case "changeSet":
						return plan
				}
			})
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
	Result.flatMap(workloadReads(schema, artifacts), (reads) => queryRead(query, reads))

/**
 * A query program's checked IR, as its access and its footprint are read: over the base, a query over a role reading
 * each world relation's definition (world.ts inlineWorlds), as rows (analyzedQuery).
 */
const queryRead = (
	query: QueryDesc,
	reads: WorkloadReads
): Result.Result<AnalyzedQuery, CompileError> =>
	analyzedQuery(
		reads.world.kind === "role" ? inlineWorlds(query, reads.world.checked) : query,
		reads.artifacts.derived.schema,
		"rows",
		"query"
	)

/** What a workload's programs are checked over: reality, or a role over the artifacts' base, with the role's names. */
type WorkloadWorld =
	| { readonly kind: "reality" }
	| {
			readonly kind: "role"
			readonly role: OwnedRole
			readonly checked: CheckedSchema
			readonly names: WorldNames
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
				Result.flatMap(namedRole(role, artifacts.names.levels), (named) =>
					Result.map(checkedRoleOver(role, artifacts.derived.schema), (checked): WorkloadReads => ({
						world: { kind: "role", role, checked, names: worldNames(named, artifacts.names) },
						artifacts
					}))
				)
			)
		: Result.ok<WorkloadReads>({ world: { kind: "reality" }, artifacts })

/**
 * A query's IR over its checked schema, the query read as `reading` names: as rows, or as a write filter's membership,
 * which reads its row (analyzedQuery, then rowsIr).
 */
const checkedQueryIr = (
	query: QueryDesc,
	read: CheckedSchema,
	reading: "rows" | "membership",
	label: string
): Result.Result<ProgramIr, CompileError> =>
	Result.map(analyzedQuery(query, read, reading, label), (analyzed) =>
		rowsIr(analyzed, isOrderedQuery(query))
	)

/**
 * An analyzed query's IR as its access is extracted: its root with every node's logical metadata (logical/annotate.ts),
 * by which a join partner of at most one row, such as a context or a membership's row, binds every probe of the
 * occurrences it joins (physical/access/extract.ts), pageable where an ordered query's root is its ordered result.
 */
const rowsIr = (analyzed: AnalyzedQuery, ordered: boolean): ProgramIr => {
	const root = withLogicalMeta(analyzed.dag, analyzed.analysis, (node) => node).roots[0]
	return {
		roots: [root],
		params: analyzed.params,
		pageable: ordered && root.kind === "OrderedResult" ? [root] : [],
		targets: []
	}
}

/** A query's checked DAG in the normal forms its access is extracted from, with its logical analysis and parameters. */
export interface AnalyzedQuery {
	readonly dag: RootedDag
	readonly analysis: LogicalAnalysis<Rooted>
	readonly params: ReadonlyArray<ParamDecl>
}

/**
 * A query checked over `read`, read as `reading` names, in the normal forms its optimized lowering states it in (its
 * filters in Allen normal form, eliminate/index.ts keyJoinNormalDag folding every two occurrences of a stored relation
 * joined on a key into one), with the logical analysis of that DAG under the checker's evidence: what its access paths
 * (rowsIr) and a read program's footprint (logical/routes.ts footprintOf) are read from.
 */
const analyzedQuery = (
	query: QueryDesc,
	read: CheckedSchema,
	reading: "rows" | "membership",
	label: string
): Result.Result<AnalyzedQuery, CompileError> =>
	Result.flatMap(checkQuery(read, query, { read: reading, label }), (checked) =>
		Result.flatMap(allenNormalDag(checked.dag), (allen) =>
			Result.flatMap(keyJoinNormalDag(allen), (dag) =>
				Result.map(analyzeLogical(dag, checkerEvidence), (analysis): AnalyzedQuery => ({
					dag,
					analysis,
					params: checked.params
				}))
			)
		)
	)

/**
 * A ChangeSet's IR over its checked schema, planned as if each context held its fact: an addition fills its fixed
 * fields from them.
 */
const changeSetIr = (
	changeSet: ChangeSetDesc,
	read: CheckedSchema,
	reads: WorkloadReads
): Result.Result<ProgramIr, CompileError> => {
	const derived = reads.artifacts.derived
	const world = reads.world
	const writeWorld: WriteWorld =
		world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" }
	return Result.map(
		compileChangeSet(read, changeSet, {
			claims: { kind: "every" },
			laws: reads.artifacts.laws,
			derived,
			world: writeWorld,
			codes: reads.artifacts.names.codes
		}),
		(frontend) => {
			/**
			 * Each relation an action writes facts of whose primary key it states: every one but a generated
			 * addition's, whose key its sequences draw.
			 */
			const targeted = new Set(
				frontend.ir.strata.flatMap((s) =>
					s.actions.flatMap((a) =>
						a.op === "insert" && a.serial.kind === "generated" ? [] : [a.relation]
					)
				)
			)
			const targets = frontend.written
				.filter((r) => targeted.has(r.name))
				.map((r): AccessPath => ({
					relation: r.name,
					derived: false,
					method: primaryKeyShape(r).kind === "span" ? "gist" : "btree",
					keys: r.primaryKey.map((field) => ({ field, dir: "asc" as const })),
					use: "write target"
				}))
			return {
				roots: frontend.ir.dag.roots,
				params: frontend.params,
				pageable: [],
				targets
			}
		}
	)
}

/** The access paths and statistics of a program's checked IR. */
const irAccess = (ir: ProgramIr): ProgramAccess => {
	const extraction = extractAccess(ir.roots, { pageable: ir.pageable })
	return {
		paths: uniquePaths([...extraction.paths, ...ir.targets]),
		statistics: extraction.statistics
	}
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
	workloads: ReadonlyArray<unknown>,
	schema: SchemaInput,
	artifacts: SchemaArtifacts
): Result.Result<ReadonlyArray<readonly [string, ProgramPlan]>, WorkloadPlanRefused> => {
	const programs: Array<readonly [string, ProgramPlan]> = []
	for (const input of workloads) {
		const planned = workloadPlans(input, schema, artifacts)
		if (!planned.ok) {
			return planned
		}
		appendAll(programs, planned.value)
	}
	return Result.ok(programs.toSorted(([a], [b]) => compareText(a, b)))
}

/** Each program of one workload with its plan, in its record's order (loginPlans). */
const workloadPlans = (
	input: unknown,
	schema: SchemaInput,
	artifacts: SchemaArtifacts
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
			programPlan(program, reads.value),
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
		programs.push([name, planned.value])
	}
	return Result.ok(programs)
}

/**
 * The access of one role's write filter: the filter query planned over the base as a program of its own, read as a
 * membership, so its row is the one fact it is (schema/entry.ts) and binds every probe of what it joins.
 */
const filterAccess = (
	role: OwnedRole,
	artifacts: SchemaArtifacts
): Result.Result<ReadonlyArray<ProgramAccess>, CompileError> => {
	const out: Array<ProgramAccess> = []
	for (const e of role.writes.values()) {
		if (e.kind !== "rows" || e.writable.filter.kind !== "query") {
			continue
		}
		const label = `write filter ${role.name}.${e.name}`
		const ir = checkedQueryIr(
			e.writable.filter.query,
			artifacts.derived.schema,
			"membership",
			label
		)
		if (!ir.ok) {
			return ir
		}
		out.push(irAccess(ir.value))
	}
	return Result.ok(out)
}

/**
 * The live plan of an installation's logins (live/notify.ts LivePlan), the union of `footprints`: none where no login
 * serves a read (servesRead); otherwise every stored relation a footprint reads, each with every field some footprint
 * routes it by, and every materialized derived relation one reads, in code point order of relations and of fields.
 */
const livePlanOf = (footprints: WorkloadFootprints): LivePlan => {
	if (![...footprints.values()].some(servesRead)) {
		return { kind: "none" }
	}
	const tables = new Map<string, Set<string>>()
	const views = new Set<string>()
	for (const programs of footprints.values()) {
		for (const footprint of programs.values()) {
			for (const [relation, routes] of footprint.tables) {
				const fields = tables.get(relation) ?? new Set<string>()
				for (const field of routes.keys()) {
					fields.add(field)
				}
				tables.set(relation, fields)
			}
			for (const view of footprint.views) {
				views.add(view)
			}
		}
	}
	return {
		kind: "reads",
		tables: [...tables]
			.toSorted(([a], [b]) => compareText(a, b))
			.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareText) })),
		views: [...views].toSorted(compareText)
	}
}

/**
 * The workload compiler: every login's programs' access paths and statistics, merged as physical requests.
 *
 * compileWorkload reads the schema and the logins' workloads together, as the migration generator does: each login's
 * programs' plans (loginPlans), their access, which the snapshot records by login and program, and each query's
 * footprint, whose union is the installation's live plan (livePlanOf). Equal paths of several programs
 * are one request and equal statistics column sets one object, each justified by the workload's access; which programs
 * ask for them, the snapshot's record of each program's access says, so a program edit that moves no index changes no
 * object. A path or statistics request on a derived relation is a request like any other: the installation plans it
 * on the relation's materialized view wherever it installs the view.
 *
 * The workload installs nothing and gates no execution: a program the checker refuses is refused here with its
 * CompileError, naming the program and its workload (WorkloadPlanRefused), so a broken workload never drafts a
 * migration.
 *
 * Beside the programs, the plan holds every installed role's write filters (schema/entry.ts EntryFilter): a policy and
 * each write's precheck evaluate a query entry's filter at every write of it, so its probes into other relations are
 * planned as a program of their own over the base, `write filter <role>.<entry>`. A schema without a workload plans
 * its roles' filters alone.
 *
 * The plan of `logins` over `schema`, parsed (program/schema.ts parseSchemaInput), under the options' artifacts.
 */
export const compileWorkload = (
	logins: ReadonlyArray<LoginWorkloads>,
	schema: SchemaInput,
	options: WorkloadOptions
): Result.Result<WorkloadPlan, WorkloadPlanRefused> => {
	const { artifacts } = options
	const access: Record<string, Readonly<Record<string, ProgramAccess>>> = {}
	const footprints = new Map<string, ReadonlyMap<string, Footprint>>()
	const params: Array<ParamTypes> = []
	for (const login of [...logins].toSorted((a, b) => compareText(a.login, b.login))) {
		const programs = loginPlans(login.workloads, schema, artifacts)
		if (!programs.ok) {
			return programs
		}
		access[login.login] = Object.fromEntries(
			programs.value.map(([name, planned]) => [name, planned.access] as const)
		)
		for (const [name, planned] of programs.value) {
			params.push(paramTypesOf(name, planned.params))
		}
		footprints.set(
			login.login,
			new Map(
				programs.value.flatMap(([name, planned]) =>
					planned.kind === "query" ? [[name, planned.footprint] as const] : []
				)
			)
		)
	}
	const planned: Array<ProgramAccess> = Object.values(access).flatMap((programs) =>
		Object.values(programs)
	)
	for (const role of options.roles.toSorted((a, b) => compareText(a.name, b.name))) {
		const filters = filterAccess(role, artifacts)
		if (!filters.ok) {
			return Result.err(planRefused(filters.error))
		}
		appendAll(planned, filters.value)
	}
	const statistics = mergeStatistics(
		planned.flatMap((p) =>
			p.statistics.map((s: StatisticsShape): StatisticsRequest => ({
				relation: s.relation,
				columns: s.columns,
				kinds: statisticsKinds,
				uses: [s.use]
			}))
		)
	)
	const paths: ReadonlyArray<AccessPath> = uniquePaths(planned.flatMap((p) => p.paths))
	const physical: WorkloadPhysical = {
		schema: artifacts.fingerprint,
		paths,
		statistics,
		params: {
			domains: params.flatMap((p) => p.domains),
			contracts: params.flatMap((p) => p.contracts)
		}
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
export interface ServedLogin extends ChangeLogin {
	readonly name: string
}

/**
 * The plan of an installation's logins as generate compiles them: their workloads' plan (compileWorkload), and every
 * role of every login with the ChangeSets of the login's workloads that run on it compiled over the artifacts its
 * login's served file compiles over (change.ts loginChanges), in the form its certificate's level serves, by the
 * login's name, then the role's name in it: what each login's served file projects; and the certificate of each of
 * those roles (program/isolation/certification.ts), the level its writes begin at, which the installation's guards
 * follow (physical/install/compile.ts installationOver); the roles whose served ChangeSets create a carrier; the roles
 * whose served ChangeSets hold a retirable unit; and the fences the certification states
 * (analysis/isolation/certify.ts Fence), each with the roles certified READ COMMITTED that rely on it.
 */
export interface ServedWorkloadPlan extends WorkloadPlan {
	readonly changes: ReadonlyMap<string, ReadonlyMap<string, RoleChanges>>
	readonly certification: ReadonlyArray<RoleIsolation>
	/** The roles whose served ChangeSets create a carrier (servedCarriers), which the installation grants TEMPORARY on the
	 * database. */
	readonly carriers: ReadonlyArray<RoleOfLogin>
	/** The roles whose served ChangeSets hold a retirable unit, each with the unit's header (servedHolds), which the
	 * installation grants EXECUTE on the unit's hold function. */
	readonly holds: ReadonlyArray<RoleHold>
	readonly fences: ReadonlyArray<Fence>
}

/** Whether a ChangeSet's variants may create a carrier: any variant's flight (write/program/artifact.ts
 * createsCarrier). */
const variantsCreateCarrier = (variants: CompiledVariants): boolean =>
	variants.kind === "form"
		? createsCarrier(variants.entry.compiled.artifact)
		: variantsCreateCarrier(variants.holding) || variantsCreateCarrier(variants.lacking)

/**
 * The roles of `served`, each login's ChangeSets in the forms their certificates serve them by role, any of whose served
 * ChangeSets may create a carrier, in login then role order: the roles a write may refuse for want of TEMPORARY on the
 * database (adapter TemporaryRefused).
 */
const servedCarriers = (
	served: ReadonlyMap<string, ReadonlyMap<string, RoleChanges>>
): ReadonlyArray<RoleOfLogin> =>
	[...served].flatMap(([login, roles]) =>
		[...roles].flatMap(([role, changes]): ReadonlyArray<RoleOfLogin> =>
			[...changes.members.values()].some(variantsCreateCarrier) ? [{ login, role }] : []
		)
	)

/** The headers of the retirable units a ChangeSet's variants hold: any variant's flight's holds (write/hold/statement.ts). */
const variantHolds = (variants: CompiledVariants): ReadonlyArray<string> =>
	variants.kind === "form"
		? variants.entry.compiled.artifact.statements.flatMap((s) =>
				s.step.kind === "hold" ? [s.step.header] : []
			)
		: [...variantHolds(variants.holding), ...variantHolds(variants.lacking)]

/**
 * The roles of `served`, each login's ChangeSets in the forms their certificates serve them by role, with each
 * retirable unit any of their served ChangeSets holds, by its header, in login, role and header order: the roles whose
 * calls execute the unit's hold function.
 */
export const servedHolds = (
	served: ReadonlyMap<string, ReadonlyMap<string, RoleChanges>>
): ReadonlyArray<RoleHold> =>
	[...served].flatMap(([login, roles]) =>
		[...roles].flatMap(([role, changes]): ReadonlyArray<RoleHold> =>
			[...new Set([...changes.members.values()].flatMap(variantHolds))]
				.toSorted(compareText)
				.map((header) => ({ login, role, header }))
		)
	)

/** The plan of the logins refused: the certification of their roles, or a login's change compile. */
export type ServedWorkloadRefused =
	| { readonly kind: "workload"; readonly error: CompileError }
	| { readonly kind: "login"; readonly login: string; readonly refused: ChangeRefused }

/**
 * The plan of `logins` as generate compiles it (ServedWorkloadPlan): `planned`, their workloads' plan under the options'
 * artifacts (compileWorkload), then each login's change members, in the logins' order, each over the artifacts the
 * login's served file compiles over, which serve the plan's parameter types (WorkloadPhysical.params), then every
 * role's certificate over them under the options' artifacts.
 */
export const servedWorkload = (
	planned: WorkloadPlan,
	logins: ReadonlyArray<ServedLogin>,
	options: WorkloadOptions
): Result.Result<ServedWorkloadPlan, ServedWorkloadRefused> => {
	const changes = new Map<string, ReadonlyMap<string, RoleChanges<"readCommitted">>>()
	for (const login of logins) {
		const roles = loginChanges(login, "readCommitted")
		if (!roles.ok) {
			return Result.err({ kind: "login", login: login.name, refused: roles.error })
		}
		changes.set(login.name, roles.value)
	}
	return Result.map(
		Result.mapError(certification(options.artifacts, changes), (error): ServedWorkloadRefused => ({
			kind: "workload",
			error
		})),
		(certified): ServedWorkloadPlan => ({
			...planned,
			changes: certified.served,
			certification: certified.certificates,
			carriers: servedCarriers(certified.served),
			holds: servedHolds(certified.served),
			fences: certified.fences
		})
	)
}

/**
 * How one program of a login's workloads differs from what the snapshot records for the login: a program the snapshot
 * does not record, one it records that the workloads no longer hold, or one whose access paths or statistics moved.
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
	sameList(a.keys, b.keys, (x, y) => x.field === y.field && x.dir === y.dir)

const sameStatistics = (a: StatisticsShape, b: StatisticsShape): boolean =>
	a.relation === b.relation && a.use === b.use && sameList(a.columns, b.columns, (x, y) => x === y)

const sameAccess = (a: ProgramAccess, b: ProgramAccess): boolean =>
	sameList(a.paths, b.paths, samePath) && sameList(a.statistics, b.statistics, sameStatistics)

/**
 * Every program whose access differs from the record, in program name order: the workload's access paths and
 * statistics (loginAccess) against those the snapshot recorded for the login, none when the login is no key of it.
 * `grizzle check` reports each, naming the program and saying to run `grizzle generate`.
 */
export const accessDrift = (
	recorded: WorkloadAccess,
	login: string,
	current: Readonly<Record<string, ProgramAccess>>
): ReadonlyArray<AccessDrift> => {
	const before = Object.hasOwn(recorded, login) ? recorded[login] : undefined
	const was: Readonly<Record<string, ProgramAccess>> = before ?? {}
	const names = [...new Set([...Object.keys(was), ...Object.keys(current)])].toSorted(compareText)
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
			return `${program} reads through other access paths or statistics than snapshot.json records`
	}
}
