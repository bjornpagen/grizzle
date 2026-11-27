import { Array as Arr, Data, Effect, Record as Rec, Result } from "effect"
import { typedContext, type TypedContext } from "#adapter/db/claims.ts"
import type { ChangeVariants, WorkloadForm } from "#adapter/db/workload.ts"
import { fromEngine, rowOptions, toResult } from "#adapter/engine.ts"
import {
	boundChangeForm,
	compileReadForm,
	compileRowsForm,
	runtimeEntry
} from "#adapter/served/forms.ts"
import { installationWitness } from "#adapter/served/refusals.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import type { InstallationWitness } from "#adapter/witness/index.ts"
import type { LawsAbove } from "#adapter/witness/keylaw.ts"
import {
	type ChangeRefused,
	loginChanges,
	loginRole,
	noPlannedFrontends,
	programsOn,
	readCalled,
	type RoleChanges,
	type ServableRole,
	servableRoles,
	type ServableVariants,
	type WorkloadProgram
} from "#compiler/plan/change.ts"
import {
	type AnyWorkload,
	baseArtifacts,
	type BaseInput,
	type BindContext,
	type BuiltSchema,
	catchRefusal,
	type ClockSource,
	type Codebook,
	codeNames,
	type CompileError,
	defect,
	Engine,
	type InstalledArtifacts,
	type InstalledSource,
	type Isolation,
	type LoginDesc,
	malformedDescription,
	type NamedLogin,
	namedRole,
	noClock,
	noServedTypes,
	ownBuiltLogin,
	type Owned,
	ownedEntry,
	type OwnedLogin,
	type ParamSource,
	parseBuiltSchema,
	type ParsedRole,
	parseRole,
	type QueryDesc,
	type SchemaArtifacts,
	type ServedTypes,
	SourceLoc,
	stemOf,
	transactionClock,
	type WorldStem
} from "#compiler/plan/common.ts"
import type { IndexResolver } from "#compiler/plan/migration.ts"
import { templateFor } from "#compiler/plan/read.ts"
import {
	type CompileFacts,
	footprintOf,
	servedImportsOf,
	type PlanBasis,
	planBasis,
	type RealityReading,
	type RoleProgram
} from "#compiler/plan/serve.ts"

/**
 * One login's compile: every program of its workloads compiled for every role it runs on, what `grizzle generate`
 * commits as the login's served workload and `grizzle check` compiles again to compare. Compile time only: no runtime
 * module imports it.
 *
 * A login's compile refused: the role it was compiling, by its name in the login, the program of the login's workloads
 * that refused, none where the role's own artifacts, contexts or theory did, and the compiler's refusal.
 */
class WorkloadRefused extends Data.TaggedError("WorkloadRefused")<{
	readonly role: string
	readonly program: string | undefined
	readonly error: CompileError
}> {
	override get message(): string {
		const at =
			this.program === undefined
				? `role ${this.role}`
				: `program ${this.program} on role ${this.role}`
		return `${at} does not compile: ${this.error.message}`
	}
}

const loc = SourceLoc("login compile", [])

/**
 * The PostgreSQL role a Db of the role the artifacts were compiled for enters, as the artifacts compiled for it name it
 * (physical/ddl/names.ts worldNames); undefined for artifacts of reality. Every session of a login's pool logs in as
 * the login's role, and each of a Db's transactions enters its own role's by its prologue.
 */
const theoryRole = (artifacts: SchemaArtifacts): string | undefined =>
	artifacts.world.kind === "role" ? artifacts.world.names.role : undefined

/** A role's refusal of its own, before any program of it compiled. */
const roleRefused =
	(role: string) =>
	(error: CompileError): WorkloadRefused =>
		new WorkloadRefused({ role, program: undefined, error })

/**
 * A login as its compile reads it, every value of it read once, where the login was given: its Description; its base,
 * parsed (program/input.ts BaseInput); its roles, each parsed (program/input.ts ParsedRole), in its order, each by its
 * Description's name, which is its name in the login; its workloads; the parameter types it serves beside its workloads'
 * programs' (`stated`); and the relation values its base lists, which the records its served file carries hang off
 * (program/records.ts servedRecordsOf). A login value enters by builtLogin, its workloads as login(...) admitted them,
 * which held each role to the base, by content (schema/world.ts admitLogin); a login read from its Description has its
 * base read from its Owned, its roles read from theirs (program/input.ts roleOfDesc), no workload and no relation
 * value. Every role is compiled over the base the login's compilation owns once.
 */
export interface LoginInput {
	readonly desc: LoginDesc
	readonly base: BaseInput
	readonly roles: ReadonlyArray<ParsedRole>
	readonly workload: ReadonlyArray<AnyWorkload>
	/**
	 * The parameter types the login's workload plan serves beside the ones its programs state (physical/ddl/domains.ts
	 * ServedTypes), which the draft's plan serves as its programs' (cli/generate.ts plannedLogins): none for a login
	 * value, whose every served type a program of its workloads states. The one test addition left: an oracle case's
	 * query's parameter domains, its pattern domains and the contracts outside its base, since the case's query is a
	 * checked DAG, which no workload value holds (test/support/oracle/install/drafted.ts oraclePlanUnder).
	 */
	readonly stated: ServedTypes
	readonly relations: ReadonlyArray<unknown>
}

/**
 * A login value login(...) built, read once where it is given (LoginInput), beside its base's built schema, which owns
 * the base once, and the stems the configuration holds to its role prefix: its own, and each role's, by its name in the
 * login, in its order.
 */
export interface BuiltLogin extends LoginInput {
	readonly base: BuiltSchema
	readonly stem: WorldStem
	readonly stems: ReadonlyArray<{ readonly name: string; readonly stem: WorldStem }>
}

/** The built login a value is, undefined for a value login(...) did not build. */
export const builtLogin = (value: unknown): BuiltLogin | undefined => {
	const entry = ownedEntry(value, "login")
	if (entry === undefined) {
		return undefined
	}
	const base = parseBuiltSchema(entry.value.base, loc)
	const listed = Rec.toEntries(entry.value.roles)
	const roles = Arr.map(listed, ([, r]) => parseRole(r.role, loc))
	return base.ok && Arr.every(roles, (r) => r.ok)
		? {
				desc: entry.desc,
				stem: stemOf(entry.value),
				base: base.value,
				roles: Arr.map(roles, (r) => r.value),
				stems: Arr.map(listed, ([name, r]) => ({ name, stem: stemOf(r.role) })),
				workload: entry.value.workload,
				stated: noServedTypes,
				relations: Rec.values(entry.value.base.relations)
			}
		: undefined
}

/**
 * The artifacts of a base over its plan's basis (physical/install/plan.ts PlanBasis), under its own installation, its
 * programs' parameters cast to the types `params` gives (program/schema.ts baseArtifacts): planned from the workload
 * generate plans the installation from, or recorded by the snapshot a served compile reads.
 */
export const artifactsOver = <S extends ParamSource>(
	basis: PlanBasis,
	params: S
): Engine.Result<SchemaArtifacts<S>, CompileError> => baseArtifacts(basis, params)

/**
 * The artifacts of a login's base, its law model compiled under the installation's codes `codes` and the facts
 * `derived` its snapshot records (physical/install/plan.ts planBasis): the closed relations' constant names, so no
 * closed relation's cells are packed, and the foreign key graph's cycles; its checked schema read as `reading` says,
 * within the installation where generate holds the installation's reading (engine analysis/schema.ts RealityReading),
 * so each level holds the installation's analysis by reference; its programs' parameters cast to the types `params`
 * gives (artifactsOver). What every program of the login compiles against, read through its role's views.
 */
export const artifactsUnder = (
	base: Owned,
	codes: Codebook,
	derived: CompileFacts,
	params: InstalledSource,
	reading: RealityReading,
	served: ReadonlySet<QueryDesc>
): Engine.Result<InstalledArtifacts, CompileError> =>
	Engine.flatMap(
		planBasis(
			base,
			codes,
			derived.closed,
			derived.textDomains,
			derived.library,
			{
				kind: "recorded",
				cycles: derived.fkCycles,
				references: derived.references,
				judged: derived.judged
			},
			reading,
			served
		),
		(basis) => artifactsOver(basis, params)
	)

/** A login owned over its base's Owned, which its roles are held to (login(...) held a built login's). */
export const ownLoginOver = (
	login: LoginInput,
	base: Owned
): Engine.Result<OwnedLogin, CompileError> => ownBuiltLogin(login.desc, base)

/**
 * What a login's workloads reach, over every program of them on each role of the login it runs on (programsOn): their
 * footprint, the relations they name (schema/reach.ts footprintOf), and their served imports, the closed imports the
 * installation serving them admits as stored canonical relations (schema/reach.ts servedImportsOf). A workload value no
 * workload(...) built is refused, as compiling the login's roles refuses it.
 */
export const workloadReach = (
	login: LoginInput,
	owned: OwnedLogin
): Effect.Effect<
	{ readonly footprint: ReadonlySet<string>; readonly served: ReadonlySet<QueryDesc> },
	WorkloadRefused
> =>
	Effect.gen(function* () {
		const programs: Array<RoleProgram> = []
		for (const role of login.roles) {
			const running = yield* Effect.mapError(
				fromEngine(programsOn(role, login.workload)),
				roleRefused(role.desc.name)
			)
			const ownedRole = loginRole(role, owned)
			for (const program of running) {
				programs.push({ role: ownedRole, program: program.desc })
			}
		}
		return { footprint: footprintOf(owned.base, programs), served: servedImportsOf(programs) }
	})

/**
 * A ChangeSet's variants as its login's change compile made them (program/workload/change.ts loginChanges), each entry
 * with its runtime's entry built over it, under the codes and witness decoding of the role's artifacts and its bind
 * context (served/forms.ts runtimeEntry), and its reads decoder bound to its read-backs' layout: a decoder that cannot
 * bind is the ChangeSet's CompileError. A split's lacking side binds first, the order its variants compiled in.
 */
const layerVariants = (
	role: RoleContext,
	witness: InstallationWitness,
	variants: ServableVariants<InstalledSource>
): Result.Result<ChangeVariants, CompileError> => {
	if (variants.kind === "form") {
		const entry = runtimeEntry(
			variants.entry,
			role.artifacts.names.codes,
			witness,
			role.bind,
			role.resolve
		)
		return Result.map(boundChangeForm(entry, variants.decoder), (form): ChangeVariants => ({
			kind: "form",
			form
		}))
	}
	return Result.gen(function* () {
		const lacking = yield* layerVariants(role, witness, variants.lacking)
		const holding = yield* layerVariants(role, witness, variants.holding)
		return { kind: "split", context: variants.context, holding, lacking }
	})
}

/**
 * The form of one program of a role's workload, compiled for the role: a ChangeSet's from its variants as the login's
 * change compile made them, `changes`, the role's members, whose witness decoding is `witness`.
 */
const programForm = (
	role: RoleContext,
	changes: ServableRole<Isolation, InstalledSource>,
	witness: InstallationWitness,
	program: WorkloadProgram
): Result.Result<WorkloadForm, CompileError> => {
	switch (program.kind) {
		case "query":
		case "ordered": {
			const query = program.value
			const desc = program.desc
			/** A clocked read's binding, read at the role's clock; any other read binds none and reads no clock. */
			const compiled =
				desc.kind === "clocked"
					? compileRowsForm(role, query, () => query.rows, desc.clock, role.clock)
					: compileRowsForm(role, query, () => query.rows, noClock, transactionClock)
			return Result.map(compiled, (form): WorkloadForm => ({
				name: program.name,
				kind: "read",
				called: readCalled(desc),
				form
			}))
		}
		case "paged": {
			const query = program.value
			return Result.map(
				compileReadForm(role, query, () => query.rows),
				(form): WorkloadForm => ({
					name: program.name,
					kind: "paged",
					called: readCalled(program.desc),
					form
				})
			)
		}
		case "key": {
			const target = program.target
			const fact = target.relation.fact
			return Result.map(
				compileRowsForm(role, program.query, () => fact, noClock, transactionClock),
				(form): WorkloadForm => ({
					name: program.name,
					kind: "key",
					called: readCalled(program.desc),
					fields: target.fields,
					form
				})
			)
		}
		case "changeSet": {
			const compiled = changes.members.get(program.name)
			if (compiled === undefined) {
				defect(`the change compile of program ${program.name}, which runs on its role`)
			}
			return Result.map(layerVariants(role, witness, compiled), (variants): WorkloadForm => ({
				name: program.name,
				kind: "change",
				variants
			}))
		}
	}
}

/**
 * The workload of a role: every program of the login's workloads that runs on the role (programsOn), compiled once for
 * the role, its ChangeSets' variants its login's change compile's, `changes`. A program that does not compile for the
 * role is WorkloadRefused naming it, and so is a workload value no workload(...) built, naming none.
 */
const compileRoleWorkload = (
	name: string,
	role: RoleContext,
	changes: ServableRole<Isolation, InstalledSource>,
	witness: InstallationWitness,
	workloads: ReadonlyArray<AnyWorkload>
): Result.Result<ReadonlyArray<WorkloadForm>, WorkloadRefused> =>
	Result.gen(function* () {
		const forms: Array<WorkloadForm> = []
		const running = yield* Result.mapError(
			toResult(programsOn(role.schema, workloads)),
			roleRefused(name)
		)
		for (const program of running) {
			forms.push(
				yield* Result.mapError(
					programForm(role, changes, witness, program),
					(error) => new WorkloadRefused({ role: name, program: program.name, error })
				)
			)
		}
		return forms
	})

/**
 * The contexts the role declares (schema/own.ts OwnedRole.contexts), their fields typed against the base, each
 * with its codec under the installation's codes: a contract or roster a context names is the base's.
 */
const typedContexts = (
	artifacts: SchemaArtifacts
): Engine.Result<ReadonlyArray<TypedContext>, CompileError> => {
	const world = artifacts.world
	const contexts = world.kind === "role" ? Rec.values(world.role.contexts) : []
	const checked = artifacts.derived.schema
	return catchRefusal(() =>
		Arr.map(contexts, (context) =>
			typedContext(
				context,
				(field) => checked.fieldType(field, SourceLoc(`context ${context.name}`, [])),
				artifacts.names.codes
			)
		)
	)
}

/**
 * One role of a login, compiled: its compilation context (db/context.ts RoleContext), the role parsed where its login
 * was read among it; the PostgreSQL role a Db of it enters; the contexts it declares, typed, which a token's claims
 * decode through; and the programs of the login's workloads over it, compiled.
 */
export interface LayerRole extends RoleContext {
	/** The level its writes begin at, the one its change members were compiled for (program/workload/change.ts
	 * RoleChanges `level`): its served form records it and its writes are projected at it. */
	readonly isolation: Isolation
	readonly theory: string
	readonly contexts: ReadonlyArray<TypedContext>
	readonly workload: ReadonlyArray<WorkloadForm>
}

/**
 * One role of the login, parsed, and its artifacts read over the login's as its login's change compile read them,
 * `changes` (program/workload/change.ts RoleChanges), and the programs of the login's workloads over it compiled,
 * its ChangeSets' variants the change compile's, its decoders bound under `bind`: a role or program that does not
 * compile is WorkloadRefused. Every program compiles against the role's artifacts, which read, of each relation the
 * program names, exactly what the installation's law model states.
 */
const layerRole = (
	name: string,
	changes: ServableRole<Isolation, InstalledSource>,
	workload: ReadonlyArray<AnyWorkload>,
	bind: BindContext,
	above: LawsAbove,
	clock: ClockSource,
	resolve: IndexResolver
): Effect.Effect<LayerRole, WorkloadRefused> =>
	Effect.gen(function* () {
		const refused = roleRefused(name)
		const { input, artifacts } = changes
		const theory = theoryRole(artifacts)
		if (theory === undefined) {
			return yield* refused(malformedDescription(loc, "a login's role built by role(...)"))
		}
		const role: RoleContext = {
			schema: input,
			declared: input.desc.base.name,
			role: input.desc,
			artifacts,
			compile: (query, request) =>
				Engine.map(templateFor(query, input, artifacts, request), (compiled) => ({
					compiled,
					artifacts
				})),
			witness: installationWitness(artifacts, above),
			bind,
			clock,
			resolve
		}
		const contexts = yield* Effect.mapError(fromEngine(typedContexts(artifacts)), refused)
		const forms = yield* Effect.fromResult(
			compileRoleWorkload(name, role, changes, role.witness, workload)
		)
		return { ...role, isolation: changes.level, theory, contexts, workload: forms }
	})

/** A login's change compile refused, as its compile names a refusal (WorkloadRefused). */
const changeRefused = (refused: ChangeRefused): WorkloadRefused => new WorkloadRefused(refused)

/**
 * `owned`'s roles named under the installation of `artifacts` (physical/ddl/names.ts namedRole), each in the login's
 * order: a role whose PostgreSQL role does not fit is refused as that role's, before any of the login compiles.
 */
const namedOver = (
	owned: OwnedLogin,
	artifacts: SchemaArtifacts
): Effect.Effect<NamedLogin, WorkloadRefused> =>
	Effect.map(
		Effect.forEach(owned.roles, (role) =>
			Effect.mapError(fromEngine(namedRole(role, artifacts.names.levels)), roleRefused(role.name))
		),
		(roles): NamedLogin => ({ owned, roles })
	)

/**
 * Every role of a login, each named under the login's artifacts `artifacts` (namedOver) and then with its change members
 * compiled over them at `level`, their readings of the clock counting from `clock` (program/workload/change.ts
 * loginChanges), by its name in the login: what the login's compile reads of each role (plannedLoginRoles).
 */
export const loginChangesOver = <L extends Isolation, S extends ParamSource>(
	login: LoginInput,
	owned: OwnedLogin,
	artifacts: SchemaArtifacts<S>,
	level: L,
	clock: ClockSource
): Effect.Effect<ReadonlyMap<string, RoleChanges<L, S>>, WorkloadRefused> =>
	Effect.flatMap(namedOver(owned, artifacts), (named) =>
		Effect.mapError(
			fromEngine(
				loginChanges(
					{
						roles: login.roles,
						workload: login.workload,
						named,
						artifacts,
						clock,
						planned: noPlannedFrontends
					},
					level
				)
			),
			changeRefused
		)
	)

/**
 * Every role of a login, each read over the login's artifacts `artifacts` with its change members as `changes` compiled
 * them (loginChangesOver), and every program of the login's workloads over it compiled (layerRole): the one compilation
 * of a login's programs, which `grizzle generate` commits and `grizzle check` compares. Nothing here owns or installs
 * the base again: the login is owned over the base's Owned (ownLoginOver) and every role reads the one installation. A
 * role or program that does not compile is WorkloadRefused. Every role reads the one installation's codes, so the roles
 * share one bind context, each roster's names in code order.
 */
export const plannedLoginRoles = (
	login: LoginInput,
	changes: ReadonlyMap<string, ServableRole<Isolation, InstalledSource>>,
	artifacts: InstalledArtifacts,
	above: LawsAbove,
	clock: ClockSource,
	resolve: IndexResolver
): Effect.Effect<ReadonlyArray<LayerRole>, WorkloadRefused> => {
	const bind: BindContext = { options: rowOptions, names: codeNames(artifacts.names.codes) }
	return Effect.forEach(login.roles, (parsed) => {
		const name = parsed.desc.name
		const role = changes.get(name)
		if (role === undefined) {
			defect(`the change compile of role ${name}, a role of its login`)
		}
		return layerRole(name, role, login.workload, bind, above, clock, resolve)
	})
}

/**
 * Every role of a login compiled over the login's artifacts `artifacts` (plannedLoginRoles), its change members compiled
 * over them first at SERIALIZABLE (loginChangesOver), the level of a compile no certificate covers, every reading of the
 * clock the transaction's, as generate compiles it.
 */
export const loginRoles = (
	login: LoginInput,
	owned: OwnedLogin,
	artifacts: InstalledArtifacts,
	above: LawsAbove,
	resolve: IndexResolver
): Effect.Effect<ReadonlyArray<LayerRole>, WorkloadRefused> =>
	Effect.flatMap(
		loginChangesOver(login, owned, artifacts, "serializable", transactionClock),
		(changes) =>
			plannedLoginRoles(login, servableRoles(changes), artifacts, above, transactionClock, resolve)
	)
