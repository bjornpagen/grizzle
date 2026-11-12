import { Array as Arr, Data, Effect, Record as Rec, Result } from "effect"
import { typedContext, type TypedContext } from "#adapter/db/claims.ts"
import type { ChangeVariants, WorkloadForm } from "#adapter/db/workload.ts"
import { fromEngine, rowOptions, toResult } from "#adapter/engine.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"
import {
	boundChangeForm,
	compileReadForm,
	compileRowsForm,
	runtimeEntry
} from "#adapter/served/forms.ts"
import { installationWitness } from "#adapter/served/refusals.ts"
import type { RoleContext, SliceArtifacts } from "#adapter/served/role.ts"
import type { InstallationWitness } from "#adapter/witness/index.ts"
import type { LawsAbove } from "#adapter/witness/keylaw.ts"
import {
	type ChangeRefused,
	type CompiledVariants,
	loginChanges,
	loginRole,
	programsOn,
	type RoleChanges,
	type WorkloadProgram
} from "#compiler/plan/change.ts"
import {
	type AnyWorkload,
	baseArtifacts,
	type BindContext,
	type BuiltSchema,
	catchRefusal,
	type Codebook,
	codeNames,
	type CompileError,
	defect,
	Engine,
	type Isolation,
	type LoginDesc,
	malformedDescription,
	type NamedLogin,
	namedRole,
	noClock,
	ownBuiltLogin,
	type Owned,
	ownedEntry,
	type OwnedLogin,
	parseBuiltSchema,
	type ProgramDesc,
	roleArtifacts,
	type SchemaArtifacts,
	SourceLoc
} from "#compiler/plan/common.ts"
import { keyQuery, templateFor } from "#compiler/plan/read.ts"
import {
	type CompileFacts,
	type PlanBasis,
	planBasis,
	type RoleProgram,
	type Slice,
	sliceOf,
	within
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
 * A login value login(...) built, read once where it is given: its Description, its base's built schema, its role
 * values by their names in the login, in its order, and its workloads, as login(...) admitted them. login(...) held each
 * role to the base, by content (schema/world.ts admitLogin), so every role is compiled over the base the login's
 * compilation owns once.
 */
export interface BuiltLogin {
	readonly desc: LoginDesc
	readonly base: BuiltSchema
	readonly roles: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
	readonly workload: ReadonlyArray<AnyWorkload>
}

/** The built login a value is, undefined for a value login(...) did not build. */
export const builtLogin = (value: unknown): BuiltLogin | undefined => {
	const entry = ownedEntry(value, "login")
	if (entry === undefined) {
		return undefined
	}
	const base = parseBuiltSchema(entry.value.base, loc)
	return base.ok
		? {
				desc: entry.desc,
				base: base.value,
				roles: Arr.map(Rec.toEntries(entry.value.roles), ([name, r]) => ({ name, value: r.role })),
				workload: entry.value.workload
			}
		: undefined
}

/**
 * What every program of a login compiles against: a slice (schema/reach.ts Slice), the base's artifacts over it, under
 * its own installation and vector schema (program/schema.ts baseArtifacts), and how the base's artifacts over any other
 * slice are compiled, as those are. A program whose own slice the slice holds compiles against those artifacts, read
 * through its role's views; any other against its own slice's, compiled at its call (layerRole).
 */
export interface LayerArtifacts {
	readonly slice: Slice
	readonly artifacts: SchemaArtifacts
	readonly over: (slice: Slice) => Engine.Result<SchemaArtifacts, CompileError>
}

/** The artifacts of a base over its plan's basis (physical/install/plan.ts PlanBasis), under its own installation. */
export const artifactsOver = (basis: PlanBasis): Engine.Result<SchemaArtifacts, CompileError> =>
	baseArtifacts(basis)

/** The login's artifacts over `slice`, compiled by `over`, which compiles them over any other slice alike. */
export const layerOver = (
	slice: Slice,
	over: (slice: Slice) => Engine.Result<SchemaArtifacts, CompileError>
): Engine.Result<LayerArtifacts, CompileError> =>
	Engine.map(over(slice), (artifacts) => ({ slice, artifacts, over }))

/**
 * The artifacts of a login's base over `slice`, its law model compiled under the installation's codes `codes` and the
 * facts `derived` its snapshot records (physical/install/plan.ts planBasis): the closed relations' constant names, so
 * no closed relation's cells are packed, and the foreign key graph's cycles, so the law model plans only the laws the
 * slice names.
 */
export const artifactsUnder = (
	base: Owned,
	codes: Codebook,
	derived: CompileFacts,
	slice: Slice
): Engine.Result<LayerArtifacts, CompileError> =>
	layerOver(slice, (sliced) =>
		Engine.flatMap(
			planBasis(base, codes, sliced, derived.closed, derived.textDomains, {
				kind: "recorded",
				cycles: derived.fkCycles,
				references: derived.references
			}),
			artifactsOver
		)
	)

/** A built login owned over its base's Owned, which login(...) held each of its roles to. */
export const ownLoginOver = (
	login: BuiltLogin,
	base: Owned
): Engine.Result<OwnedLogin, CompileError> => ownBuiltLogin(login.desc, base)

/**
 * The slice of a login's workloads (schema/reach.ts sliceOf): every program of them over each role of the login it runs
 * on (programsOn), but its refreshes, which read no law. A role value no role(...) built, or a workload value no workload(...) built, is refused, as compiling
 * the login's roles refuses it.
 */
export const workloadSlice = (
	login: BuiltLogin,
	owned: OwnedLogin
): Effect.Effect<Slice, WorkloadRefused> =>
	Effect.gen(function* () {
		const programs: Array<RoleProgram> = []
		for (const { name, value } of login.roles) {
			const role = yield* Effect.mapError(fromEngine(loginRole(value, owned)), roleRefused(name))
			const running = yield* Effect.mapError(
				fromEngine(programsOn(role.input, login.workload)),
				roleRefused(name)
			)
			for (const program of running) {
				if (program.kind !== "refresh") {
					programs.push({ role: role.owned, program: program.desc })
				}
			}
		}
		return sliceOf(owned.base, programs)
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
	variants: CompiledVariants
): Result.Result<ChangeVariants, CompileError> => {
	if (variants.kind === "form") {
		const entry = runtimeEntry(variants.entry, role.artifacts.names.codes, witness, role.bind)
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
	changes: RoleChanges,
	witness: InstallationWitness,
	program: WorkloadProgram
): Result.Result<WorkloadForm, CompileError> => {
	switch (program.kind) {
		case "query":
		case "ordered": {
			const query = program.value
			return Result.map(
				compileRowsForm(role, query, () => query.rows, noClock),
				(form): WorkloadForm => ({
					name: program.name,
					kind: "read",
					deferrable: program.deferrable,
					form
				})
			)
		}
		case "instant": {
			const query = program.value
			return Result.map(
				compileRowsForm(role, query, () => query.rows, program.clock),
				(form): WorkloadForm => ({
					name: program.name,
					kind: "instant",
					deferrable: program.deferrable,
					form
				})
			)
		}
		case "paged": {
			const query = program.value
			return Result.map(
				compileReadForm(role, query, () => query.rows),
				(form): WorkloadForm => ({
					name: program.name,
					kind: "paged",
					deferrable: program.deferrable,
					form
				})
			)
		}
		case "key": {
			const target = program.target
			const fact = target.relation.fact
			return Result.map(
				compileRowsForm(role, keyQuery(role.schema.value, target), () => fact, noClock),
				(form): WorkloadForm => ({
					name: program.name,
					kind: "key",
					deferrable: program.deferrable,
					fields: target.fields,
					form
				})
			)
		}
		case "changeSet": {
			const compiled = changes.members.get(program.name)
			if (compiled === undefined) {
				throw defect(`the change compile of program ${program.name}, which runs on its role`)
			}
			return Result.map(layerVariants(role, witness, compiled), (variants): WorkloadForm => ({
				name: program.name,
				kind: "change",
				variants
			}))
		}
		case "refresh":
			return Result.map(
				refreshTargets(role.role, role.artifacts, program.relations),
				(targets): WorkloadForm => ({
					name: program.name,
					kind: "refresh",
					targets: Arr.map(targets, (t) => ({ relation: t.relation, view: t.view }))
				})
			)
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
	changes: RoleChanges,
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
 * The contexts the role's relations read (schema/own.ts OwnedRole.contexts), their fields typed against the base, each
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
 * One role of a login, compiled: the role value the login holds, its compilation context (db/context.ts RoleContext);
 * the PostgreSQL role a Db of it enters; the contexts its relations read, typed, which a token's claims decode through;
 * and the programs of the login's workloads over it, compiled.
 */
export interface LayerRole extends RoleContext {
	/** The level its writes begin at, the one its change members were compiled for (program/workload/change.ts
	 * RoleChanges `level`): its served form records it and its writes are projected at it. */
	readonly isolation: Isolation
	readonly value: object
	readonly theory: string
	readonly contexts: ReadonlyArray<TypedContext>
	readonly workload: ReadonlyArray<WorkloadForm>
}

/**
 * One role of the login, its value parsed and its artifacts read over the login's as its login's change compile read
 * them, `changes` (program/workload/change.ts RoleChanges), and the programs of the login's workloads over it compiled,
 * its ChangeSets' variants the change compile's, its decoders bound under `bind`: a role or program that does not
 * compile is WorkloadRefused. A program compiles against the role's artifacts over the login's slice when that slice
 * holds its own (schema/reach.ts within), and else against the role's artifacts over its own slice: either reads, of
 * each relation the program names, exactly what the installation's law model states.
 */
const layerRole = (
	name: string,
	value: unknown,
	changes: RoleChanges,
	layer: LayerArtifacts,
	workload: ReadonlyArray<AnyWorkload>,
	bind: BindContext,
	above: LawsAbove
): Effect.Effect<LayerRole, WorkloadRefused> =>
	Effect.gen(function* () {
		const refused = roleRefused(name)
		const { input, named, artifacts } = changes
		const ownedRole = named.owned
		if (typeof value !== "object" || value === null) {
			return yield* refused(malformedDescription(loc, "a login's role built by role(...)"))
		}
		const theory = theoryRole(artifacts)
		if (theory === undefined) {
			return yield* refused(malformedDescription(loc, "a login's role built by role(...)"))
		}
		const own: SliceArtifacts = { artifacts, witness: installationWitness(artifacts, above) }
		const programArtifacts = (
			program: ProgramDesc
		): Engine.Result<SliceArtifacts, CompileError> => {
			const slice = sliceOf(ownedRole.base, [{ role: ownedRole, program }])
			return within(slice, layer.slice)
				? Engine.ok(own)
				: Engine.map(
						Engine.flatMap(layer.over(slice), (base) => roleArtifacts(named, base)),
						(sliced): SliceArtifacts => ({
							artifacts: sliced,
							witness: installationWitness(sliced, above)
						})
					)
		}
		const role: RoleContext = {
			schema: input,
			declared: input.desc.base.name,
			role: input.desc,
			artifacts,
			compile: (query, request) =>
				Engine.flatMap(programArtifacts({ kind: "query", query: query.desc }), (program) =>
					Engine.map(templateFor(query, input, program.artifacts, request), (compiled) => ({
						compiled,
						artifacts: program.artifacts
					}))
				),
			programArtifacts,
			bind
		}
		const contexts = yield* Effect.mapError(fromEngine(typedContexts(artifacts)), refused)
		const forms = yield* Effect.fromResult(
			compileRoleWorkload(name, role, changes, own.witness, workload)
		)
		return { ...role, isolation: changes.level, value, theory, contexts, workload: forms }
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
 * compiled over them at `level` (program/workload/change.ts loginChanges), by its name in the login: what the login's
 * compile reads of each role (plannedLoginRoles).
 */
export const loginChangesOver = <L extends Isolation>(
	login: BuiltLogin,
	owned: OwnedLogin,
	artifacts: SchemaArtifacts,
	level: L
): Effect.Effect<ReadonlyMap<string, RoleChanges<L>>, WorkloadRefused> =>
	Effect.flatMap(namedOver(owned, artifacts), (named) =>
		Effect.mapError(
			fromEngine(
				loginChanges({ roles: login.roles, workload: login.workload, named, artifacts }, level)
			),
			changeRefused
		)
	)

/**
 * Every role of a login, each read over the login's artifacts `layer` with its change members as `changes` compiled
 * them (loginChangesOver), and every program of the login's workloads over it compiled (layerRole): the one compilation
 * of a login's programs, which `grizzle generate` commits and `grizzle check` compares. Nothing here owns or installs
 * the base again: the login is owned over the base's Owned (ownLoginOver) and every role reads the one installation. A
 * role or program that does not compile is WorkloadRefused. Every role reads the one installation's codes, so the roles
 * share one bind context, each roster's names in code order.
 */
export const plannedLoginRoles = (
	login: BuiltLogin,
	changes: ReadonlyMap<string, RoleChanges>,
	layer: LayerArtifacts,
	above: LawsAbove
): Effect.Effect<ReadonlyArray<LayerRole>, WorkloadRefused> => {
	const bind: BindContext = { options: rowOptions, names: codeNames(layer.artifacts.names.codes) }
	return Effect.forEach(login.roles, ({ name, value }) => {
		const role = changes.get(name)
		if (role === undefined) {
			throw defect(`the change compile of role ${name}, a role of its login`)
		}
		return layerRole(name, value, role, layer, login.workload, bind, above)
	})
}

/**
 * Every role of a login compiled over the login's artifacts `layer` (plannedLoginRoles), its change members compiled
 * over them first at SERIALIZABLE (loginChangesOver), the level of a compile no certificate covers.
 */
export const loginRoles = (
	login: BuiltLogin,
	owned: OwnedLogin,
	layer: LayerArtifacts,
	above: LawsAbove
): Effect.Effect<ReadonlyArray<LayerRole>, WorkloadRefused> =>
	Effect.flatMap(loginChangesOver(login, owned, layer.artifacts, "serializable"), (changes) =>
		plannedLoginRoles(login, changes, layer, above)
	)
