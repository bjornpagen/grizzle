import { Array as Arr, Data, Effect, Option, Record as Rec, Result } from "effect"
import { theoryRole } from "#adapter/connection/role.ts"
import { typedContext, type TypedContext } from "#adapter/db/claims.ts"
import type { RoleContext, RoleInput, SliceArtifacts } from "#adapter/db/context.ts"
import type { ChangeVariants, WorkloadForm } from "#adapter/db/workload.ts"
import { fromEngine, rowOptions } from "#adapter/engine.ts"
import { compileChangeForm, compileReadForm, compileRowsForm } from "#adapter/served/forms.ts"
import { installationWitness } from "#adapter/witness/index.ts"
import type { LawsAbove } from "#adapter/witness/keylaw.ts"
import { type ChangeSetValue, fillContexts } from "#compiler/plan/change.ts"
import {
	type AnyWorkload,
	baseArtifacts,
	type BindContext,
	type BuiltSchema,
	catchRefusal,
	type Codebook,
	codeNames,
	type CompileError,
	Engine,
	levelSchema,
	type LoginDesc,
	malformedDescription,
	ownBuiltLogin,
	type Owned,
	ownedEntry,
	type OwnedLogin,
	type OwnedRole,
	parseBuiltSchema,
	parseSchemaInput,
	type ProgramDesc,
	roleArtifacts,
	type SchemaArtifacts,
	SourceLoc
} from "#compiler/plan/common.ts"
import { keyQuery, templateFor, workloadState } from "#compiler/plan/read.ts"
import {
	type PlanBasis,
	planBasis,
	type RoleProgram,
	type Slice,
	sliceOf,
	type SnapshotDerived,
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
export class WorkloadRefused extends Data.TaggedError("WorkloadRefused")<{
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
	derived: SnapshotDerived,
	slice: Slice
): Engine.Result<LayerArtifacts, CompileError> =>
	layerOver(slice, (sliced) =>
		Engine.flatMap(
			planBasis(base, codes, sliced, derived.closed, derived.textDomains, {
				kind: "recorded",
				cycles: derived.fkCycles
			}),
			artifactsOver
		)
	)

/** A built login owned over its base's Owned, which login(...) held each of its roles to. */
export const ownLoginOver = (
	login: BuiltLogin,
	base: Owned
): Engine.Result<OwnedLogin, CompileError> => ownBuiltLogin(login.desc, base)

/** A login's role value parsed, with the owned role of its login of its name, refused when it is no role of it. */
const roleOf = (
	name: string,
	value: unknown,
	owned: OwnedLogin
): Effect.Effect<{ readonly input: RoleInput; readonly owned: OwnedRole }, WorkloadRefused> =>
	Effect.gen(function* () {
		const input = yield* Effect.mapError(fromEngine(parseSchemaInput(value)), roleRefused(name))
		const ownedRole =
			input.kind === "role"
				? Arr.findFirst(owned.roles, (r) => r.name === input.desc.name)
				: Option.none()
		if (input.kind !== "role" || Option.isNone(ownedRole)) {
			return yield* roleRefused(name)(
				malformedDescription(loc, "a login's role built by role(...)")
			)
		}
		return { input, owned: ownedRole.value }
	})

/** A program of a workload, as the login's compile reads it (program/workload/value.ts). */
type WorkloadProgram = NonNullable<ReturnType<typeof workloadState>>["programs"][number]

/**
 * The programs of the login's workloads that run on a role, in the workloads' order, each one's programs in its record's
 * order: a workload over the role is the role's own, and a workload over the base or a level of it runs on a full
 * role, whose levels hold the base (program/schema.ts levelSchema), and on no partial one. A workload value no
 * workload(...) built is refused.
 */
const programsOn = (
	role: RoleInput,
	workloads: ReadonlyArray<AnyWorkload>
): Result.Result<ReadonlyArray<WorkloadProgram>, CompileError> =>
	Result.gen(function* () {
		const running: Array<ReadonlyArray<WorkloadProgram>> = []
		for (const workload of workloads) {
			const state = workloadState(workload)
			if (state === undefined) {
				return yield* Result.fail(malformedDescription(loc, "a workload built by workload(...)"))
			}
			const over = state.schema
			const runs =
				over.kind === "role" ? over.value === role.value : levelSchema(over, role, loc).ok
			if (runs) {
				running.push(state.programs)
			}
		}
		return Arr.flatten(running)
	})

/**
 * The slice of a login's workloads (schema/reach.ts sliceOf): every program of them over each role of the login it runs
 * on (programsOn). A role value no role(...) built, or a workload value no workload(...) built, is refused, as compiling
 * the login's roles refuses it.
 */
export const workloadSlice = (
	login: BuiltLogin,
	owned: OwnedLogin
): Effect.Effect<Slice, WorkloadRefused> =>
	Effect.gen(function* () {
		const programs: Array<RoleProgram> = []
		for (const { name, value } of login.roles) {
			const role = yield* roleOf(name, value, owned)
			const running = yield* Effect.mapError(
				Effect.fromResult(programsOn(role.input, login.workload)),
				roleRefused(name)
			)
			for (const program of running) {
				programs.push({ role: role.owned, program: program.desc })
			}
		}
		return sliceOf(owned.base, programs)
	})

/**
 * The variants of `changes` over the fill contexts `undecided`, the contexts after them already decided to hold or
 * lack a fact, `holding` those that hold one, in the fill contexts' order. The last undecided context splits first and
 * each split compiles its lacking side first, so the forms compile in the order of the subsets of the fill contexts
 * counted with the first context as the lowest digit.
 */
const changeVariants = (
	role: RoleContext,
	changes: ChangeSetValue,
	undecided: ReadonlyArray<string>,
	holding: ReadonlyArray<string>
): Result.Result<ChangeVariants, CompileError> => {
	if (!Arr.isReadonlyArrayNonEmpty(undecided)) {
		return Result.map(
			compileChangeForm(role, changes, changes.reads, new Set(holding)),
			(form): ChangeVariants => ({ kind: "form", form })
		)
	}
	const context = Arr.lastNonEmpty(undecided)
	const before = Arr.initNonEmpty(undecided)
	return Result.gen(function* () {
		const lacking = yield* changeVariants(role, changes, before, holding)
		const held = yield* changeVariants(role, changes, before, [context, ...holding])
		return { kind: "split", context, holding: held, lacking }
	})
}

/** The form of one program of a role's workload, compiled for the role. */
const programForm = (
	role: RoleContext,
	owned: OwnedRole,
	program: WorkloadProgram
): Result.Result<WorkloadForm, CompileError> => {
	switch (program.kind) {
		case "query":
		case "ordered": {
			const query = program.value
			return Result.map(
				compileRowsForm(role, query, () => query.rows),
				(form): WorkloadForm => ({ name: program.name, kind: "read", form })
			)
		}
		case "paged": {
			const query = program.value
			return Result.map(
				compileReadForm(role, query, () => query.rows),
				(form): WorkloadForm => ({ name: program.name, kind: "paged", form })
			)
		}
		case "key": {
			const target = program.target
			const fact = target.relation.fact
			return Result.map(
				compileRowsForm(role, keyQuery(role.schema.value, target), () => fact),
				(form): WorkloadForm => ({ name: program.name, kind: "key", fields: target.fields, form })
			)
		}
		case "changeSet": {
			const fill = fillContexts(owned.writes, program.desc.changeSet)
			return Result.map(
				changeVariants(role, program.value, fill, []),
				(variants): WorkloadForm => ({ name: program.name, kind: "change", variants })
			)
		}
	}
}

/**
 * The workload of a role: every program of the login's workloads that runs on the role (programsOn), compiled once for
 * the role. A program that does not compile for the role is WorkloadRefused naming it, and so is a workload value no
 * workload(...) built, naming none.
 */
const compileRoleWorkload = (
	name: string,
	role: RoleContext,
	owned: OwnedRole,
	workloads: ReadonlyArray<AnyWorkload>
): Result.Result<ReadonlyArray<WorkloadForm>, WorkloadRefused> =>
	Result.gen(function* () {
		const forms: Array<WorkloadForm> = []
		const running = yield* Result.mapError(programsOn(role.schema, workloads), roleRefused(name))
		for (const program of running) {
			forms.push(
				yield* Result.mapError(
					programForm(role, owned, program),
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
	readonly value: object
	readonly theory: string
	readonly contexts: ReadonlyArray<TypedContext>
	readonly workload: ReadonlyArray<WorkloadForm>
}

/**
 * One role of the login, parsed, its artifacts read over the login's (program/schema.ts roleArtifacts) and the programs
 * of the login's workloads over it compiled, its decoders bound under `bind`: a role or program that does not compile is
 * WorkloadRefused. A program compiles against the role's artifacts over the login's slice when that slice holds its own
 * (schema/reach.ts within), and else against the role's artifacts over its own slice: either reads, of each relation the
 * program names, exactly what the installation's law model states.
 */
const layerRole = (
	name: string,
	value: unknown,
	owned: OwnedLogin,
	layer: LayerArtifacts,
	workload: ReadonlyArray<AnyWorkload>,
	bind: BindContext,
	above: LawsAbove
): Effect.Effect<LayerRole, WorkloadRefused> =>
	Effect.gen(function* () {
		const refused = roleRefused(name)
		const { input, owned: ownedRole } = yield* roleOf(name, value, owned)
		if (typeof value !== "object" || value === null) {
			return yield* refused(malformedDescription(loc, "a login's role built by role(...)"))
		}
		const artifacts = yield* Effect.mapError(
			fromEngine(roleArtifacts(ownedRole, layer.artifacts)),
			refused
		)
		const theory = theoryRole(artifacts)
		if (theory === undefined) {
			return yield* refused(malformedDescription(loc, "a login's role built by role(...)"))
		}
		const own: SliceArtifacts = { artifacts, witness: installationWitness(artifacts, above) }
		const programArtifacts = (
			program: ProgramDesc
		): Engine.Result<SliceArtifacts, CompileError> => {
			const slice = sliceOf(owned.base, [{ role: ownedRole, program }])
			return within(slice, layer.slice)
				? Engine.ok(own)
				: Engine.map(
						Engine.flatMap(layer.over(slice), (base) => roleArtifacts(ownedRole, base)),
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
		const forms = yield* Effect.fromResult(compileRoleWorkload(name, role, ownedRole, workload))
		return { ...role, value, theory, contexts, workload: forms }
	})

/**
 * Every role of a login, each parsed, its artifacts read over the login's artifacts `layer` and every program of the
 * login's workloads over it compiled (layerRole): the one compilation of a login's programs, which `grizzle generate`
 * commits and `grizzle check` compares. Nothing here owns or installs the base again: the login is owned over the base's
 * Owned (ownLoginOver) and every role reads the one installation. A role or program that does not compile is
 * WorkloadRefused. Every role reads the one installation's codes, so the roles share one bind context, each roster's
 * names in code order.
 */
export const loginRoles = (
	login: BuiltLogin,
	owned: OwnedLogin,
	layer: LayerArtifacts,
	above: LawsAbove
): Effect.Effect<ReadonlyArray<LayerRole>, WorkloadRefused> => {
	const bind: BindContext = { options: rowOptions, names: codeNames(layer.artifacts.names.codes) }
	return Effect.forEach(login.roles, ({ name, value }) =>
		layerRole(name, value, owned, layer, login.workload, bind, above)
	)
}
