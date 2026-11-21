import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Unformed } from "#compiler/analysis/isolation/facts.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { once } from "#compiler/core/lazy.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Phases, phased } from "#compiler/core/phase.ts"
import type { ClockBinding, ClockSource } from "#compiler/ir/clock.ts"
import type { NamedLogin, NamedRole } from "#compiler/physical/ddl/names.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"
import {
	type ParsedRole,
	parseOver,
	programSchema,
	roleArtifacts,
	type SchemaArtifacts
} from "#compiler/program/schema.ts"
import type { PlannedFrontends } from "#compiler/program/workload/planned.ts"
import { loginRole, programsOn } from "#compiler/program/workload/roles.ts"
import { writeWorldOf } from "#compiler/program/write-world.ts"
import { carrierScope } from "#compiler/sql/naming.ts"
import {
	type ChangeSetValue,
	parseChangeSet,
	type ParsedChangeSet
} from "#compiler/write/changeset/value.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { fillContexts } from "#compiler/write/frontend/entry.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import {
	type CompiledWrite,
	type PreparedWrite,
	type PrepareWriteOptions,
	prepareWrite,
	preparedWrite,
	type ServableWrite,
	servableWrite
} from "#compiler/write/program/compile.ts"

/**
 * A ChangeSet compiled for a role: its write program as it compiled, the value parsed whole, the parameters its member
 * binds to the database's clock, the fingerprint of the schema it compiled against and the installed names it read,
 * and where the types its parameters are cast to come from, its artifacts' ParamSource `S` (program/schema.ts
 * SchemaArtifacts `params`), which only an InstalledSource lets run. What a served file projects of it
 * (served/project.ts), and what the shell's runtime entry is built over.
 */
export interface ChangeEntry<S extends ParamSource = ParamSource> extends PreparedEntry<S> {
	readonly compiled: CompiledWrite
}

/**
 * A ChangeSet prepared for a role, before its level: what its entry at every level is compiled from (ChangeEntry), its
 * write prepared once (write/program/compile.ts PreparedWrite), which reads no level.
 */
interface PreparedEntry<S extends ParamSource> {
	readonly params: S
	/** The write its entries compile from at each level, made once (write/program/compile.ts prepareWrite). */
	readonly prepared: PreparedWrite
	readonly change: ParsedChangeSet
	readonly clock: ClockBinding
	/** Where its readings of the clock count from (write/program/compile.ts CompileWriteOptions `source`), which a
	 * compile of it again at another level keeps. */
	readonly source: ClockSource
	readonly schema: SchemaFingerprint
	readonly names: WriteNames
}

/**
 * A workload ChangeSet compiled for each set of its fill contexts that may hold a fact, since a write into a query entry
 * compiles for the contexts a Db's claims hold (write/frontend/entry.ts): one compiled entry with the ChangeSet's reads
 * decoder, or a split on one context into the variants for a Db holding a fact of it and one lacking it.
 */
export type CompiledVariants<S extends ParamSource = ParamSource> =
	| { readonly kind: "form"; readonly entry: ChangeEntry<S>; readonly decoder: RowDecoder<unknown> }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: CompiledVariants<S>
			readonly lacking: CompiledVariants<S>
	  }

/**
 * A ChangeSet compiled for a role as its runtime entry and the served file that holds it read it: its entry with its
 * write servable (write/program/compile.ts ServableWrite), and no prepared write, so none of its compile's front end,
 * analysis, schedule or placement. A ChangeEntry is one, holding those besides.
 */
export interface ServableEntry<S extends ParamSource = ParamSource> {
	readonly params: S
	readonly change: ParsedChangeSet
	readonly clock: ClockBinding
	readonly source: ClockSource
	readonly schema: SchemaFingerprint
	readonly names: WriteNames
	readonly compiled: ServableWrite
}

/** A workload ChangeSet's variants with each entry servable (CompiledVariants, ServableEntry). */
export type ServableVariants<S extends ParamSource = ParamSource> =
	| {
			readonly kind: "form"
			readonly entry: ServableEntry<S>
			readonly decoder: RowDecoder<unknown>
	  }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: ServableVariants<S>
			readonly lacking: ServableVariants<S>
	  }

/**
 * One role of a login with its change members as its served file reads them (RoleChanges, each entry servable): what a
 * generate holds of a role once its certification has read its compiled writes, a RoleChanges being one.
 */
export interface ServableRole<
	L extends Isolation = Isolation,
	S extends ParamSource = ParamSource
> {
	readonly input: ParsedRole
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts<S>
	readonly level: L
	readonly members: ReadonlyMap<string, ServableVariants<S>>
}

/** `entry` servable (ServableEntry): its prepared write and every part of its compiled write past the servable one dropped. */
const servableEntry = <S extends ParamSource>(entry: ServableEntry<S>): ServableEntry<S> =>
	Object.freeze({
		params: entry.params,
		change: entry.change,
		clock: entry.clock,
		source: entry.source,
		schema: entry.schema,
		names: entry.names,
		compiled: servableWrite(entry.compiled)
	})

const servableVariants = <S extends ParamSource>(
	variants: ServableVariants<S>
): ServableVariants<S> =>
	variants.kind === "form"
		? Object.freeze({
				kind: "form",
				entry: servableEntry(variants.entry),
				decoder: variants.decoder
			})
		: Object.freeze({
				kind: "split",
				context: variants.context,
				holding: servableVariants(variants.holding),
				lacking: servableVariants(variants.lacking)
			})

/**
 * `role` as its served file reads it (ServableRole): every change member's entry servable, so the role holds none of its
 * compiles' front ends, analyses, schedules, placements or prepared writes, which its certification read and nothing
 * after it does.
 */
export const servableRole = <L extends Isolation, S extends ParamSource>(
	role: ServableRole<L, S>
): ServableRole<L, S> =>
	Object.freeze({
		input: role.input,
		named: role.named,
		artifacts: role.artifacts,
		level: role.level,
		members: new Map([...role.members].map(([name, v]) => [name, servableVariants(v)] as const))
	})

const applyLoc = SourceLoc("db.apply", [])

/**
 * The parsed ChangeSet of a value, or the refusal of a value that is not one, or of one built over a schema that is no
 * level of the role's, or that reads a relation the role holds scoped other than row by row (program/schema.ts
 * programSchema), before any SQL.
 */
export const parsedChange = (
	role: ParsedRole,
	changes: unknown
): Result.Result<ParsedChangeSet, CompileError> => {
	const change = parseChangeSet(changes)
	if (change === undefined) {
		return Result.err(
			malformedDescription(
				applyLoc,
				"a ChangeSet value built by ChangeSet.empty, union or sequence"
			)
		)
	}
	return Result.flatMap(parseOver(change.over.value), (carried) =>
		Result.map(
			programSchema(carried, role, { kind: "changeSet", changeSet: change.desc }, applyLoc),
			() => change
		)
	)
}

/**
 * A parsed ChangeSet compiled against `artifacts`, a role's or reality's, for the contexts `claims` holds a fact of, to
 * run at `level`, each parameter `clock` names bound to the database's clock, its readings counting from `source`
 * (write/program/compile.ts CompileWriteOptions `clock`, `source`).
 */
export const compileParsed = <S extends ParamSource>(
	artifacts: SchemaArtifacts<S>,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>,
	level: Isolation,
	clock: ClockBinding,
	source: ClockSource
): Result.Result<ChangeEntry<S>, CompileError> =>
	Result.flatMap(preparedParsed(artifacts, change, claims, clock, source), (prepared) =>
		entryOf(prepared, prepared.prepared.compile(level))
	)

/** A parsed ChangeSet prepared against `artifacts` for the contexts `claims` holds a fact of (compileParsed's, before
 * its level). */
const preparedParsed = <S extends ParamSource>(
	artifacts: SchemaArtifacts<S>,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>,
	clock: ClockBinding,
	source: ClockSource
): Result.Result<PreparedEntry<S>, CompileError> =>
	preparedFrom(artifacts, change, claims, clock, source, (schema, options) =>
		prepareWrite(schema, change.desc, options)
	)

/**
 * A parsed ChangeSet prepared against `artifacts` for the contexts `claims` holds a fact of (preparedParsed), its write
 * prepared by `prepare` from the checked schema and options a compile of it reads: compiled from its Description, or
 * over the front end a plan compiled of it (planned.ts PlannedFrontends).
 */
const preparedFrom = <S extends ParamSource>(
	artifacts: SchemaArtifacts<S>,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>,
	clock: ClockBinding,
	source: ClockSource,
	prepare: (
		schema: CheckedSchema,
		options: PrepareWriteOptions
	) => Result.Result<PreparedWrite, CompileError>
): Result.Result<PreparedEntry<S>, CompileError> => {
	const world = artifacts.world
	return Result.map(
		prepare(world.kind === "role" ? world.checked : artifacts.derived.schema, {
			names: artifacts.names,
			reads: artifacts.reads,
			claims: { kind: "facts", present: claims },
			world: writeWorldOf(world, artifacts.laws),
			laws: artifacts.laws,
			derived: artifacts.derived,
			clock,
			source,
			carrierScope: carrierScope(world.kind === "role" ? world.role.name : undefined)
		}),
		(prepared): PreparedEntry<S> => ({
			params: artifacts.params,
			prepared,
			change,
			clock,
			source,
			schema: artifacts.fingerprint,
			names: artifacts.names
		})
	)
}

/** A prepared ChangeSet's entry, its prepared write compiled (write/program/compile.ts PreparedWrite) as `write`. */
const entryOf = <S extends ParamSource>(
	entry: PreparedEntry<S>,
	write: Result.Result<CompiledWrite, CompileError>
): Result.Result<ChangeEntry<S>, CompileError> =>
	Result.map(write, (compiled): ChangeEntry<S> => ({
		params: entry.params,
		prepared: entry.prepared,
		change: entry.change,
		clock: entry.clock,
		source: entry.source,
		schema: entry.schema,
		names: entry.names,
		compiled
	}))

/**
 * The variants of a workload ChangeSet (CompiledVariants) before their level: each form's entry prepared where it is
 * first compiled, at the first level its role reads it at, and held for every level after (PreparedEntry), so a
 * member's front end compiles once for each set of its fill contexts whatever the levels, where each level compiled it
 * again from its value.
 */
type PreparedVariants<S extends ParamSource> =
	| {
			readonly kind: "form"
			readonly entry: () => Result.Result<PreparedEntry<S>, CompileError>
			readonly decoder: RowDecoder<unknown>
	  }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: PreparedVariants<S>
			readonly lacking: PreparedVariants<S>
	  }

/**
 * Where a form's front end comes from: compiled from its ChangeSet's Description, or the front end a workload's plan
 * compiled under every context's claims (planned.ts PlannedFrontends), which only the form in which every fill context
 * holds a fact reads, its claims admitting every entry the ChangeSet writes as the plan's do.
 */
type FrontendSource =
	| { readonly kind: "compiled" }
	| { readonly kind: "planned"; readonly frontend: WriteFrontend }

const compiledFrontend: FrontendSource = Object.freeze({ kind: "compiled" })

/**
 * The variants of `changes` for a role, its value parsed `role` over its artifacts `artifacts`, over the fill contexts
 * `undecided`, the contexts after them already decided to hold or lack a fact, `holding` those that hold one, in the
 * fill contexts' order, each form's entry prepared where it is first read (PreparedVariants), the form in which every
 * context holds one over `frontend`, each other form's front end compiled.
 */
const preparedVariants = <S extends ParamSource>(
	role: ParsedRole,
	artifacts: SchemaArtifacts<S>,
	changes: ChangeSetValue,
	clock: ClockBinding,
	source: ClockSource,
	undecided: ReadonlyArray<string>,
	holding: ReadonlyArray<string>,
	frontend: FrontendSource
): PreparedVariants<S> => {
	const context = undecided.at(-1)
	if (context === undefined) {
		const claims = new Set(holding)
		const entry = once(() =>
			Result.flatMap(parsedChange(role, changes), (change) =>
				frontend.kind === "planned"
					? preparedFrom(artifacts, change, claims, clock, source, (schema, options) =>
							preparedWrite(schema, frontend.frontend, options)
						)
					: preparedParsed(artifacts, change, claims, clock, source)
			)
		)
		return { kind: "form", entry, decoder: changes.reads }
	}
	const before = undecided.slice(0, -1)
	return {
		kind: "split",
		context,
		holding: preparedVariants(
			role,
			artifacts,
			changes,
			clock,
			source,
			before,
			[context, ...holding],
			frontend
		),
		lacking: preparedVariants(
			role,
			artifacts,
			changes,
			clock,
			source,
			before,
			holding,
			compiledFrontend
		)
	}
}

/**
 * Prepared variants compiled at `level`: each split compiles its lacking side first, so the entries compile in the
 * order of the subsets of the fill contexts counted with the first context as the lowest digit, each form's entry
 * prepared, where it is not yet, just before it compiles, and the first refusal in that order refuses them all. Each
 * compile places its write itself (write/program/compile.ts PreparedWrite.compile), so its placement, the deduplication
 * plan and the physical analysis of the write's whole DAG its facts read, dies with the compile: a role's compile held
 * every member's placement until its last member compiled, for a second level only an unformed role reaches
 * (edullm's qti: the learner role's decideStage placement alone ~1.1 GB, every earlier member's beside it).
 */
const variantsCompiledAt = <S extends ParamSource>(
	variants: PreparedVariants<S>,
	level: Isolation
): Result.Result<CompiledVariants<S>, CompileError> => {
	switch (variants.kind) {
		case "form":
			return Result.map(
				Result.flatMap(variants.entry(), (prepared) =>
					entryOf(prepared, prepared.prepared.compile(level))
				),
				(entry): CompiledVariants<S> => ({ kind: "form", entry, decoder: variants.decoder })
			)
		case "split":
			return Result.flatMap(variantsCompiledAt(variants.lacking, level), (lacking) =>
				Result.map(variantsCompiledAt(variants.holding, level), (held): CompiledVariants<S> => ({
					kind: "split",
					context: variants.context,
					holding: held,
					lacking
				}))
			)
	}
}

/**
 * A login as its change members compile: its roles' values by their names in the login, in its order, its workloads,
 * the login owned over its base's Owned with every role named under the installation (physical/ddl/names.ts
 * namedLogin), and the artifacts its served file compiles over, its base's over every relation, which cast its
 * programs' parameters to the types its installation installs (program/schema.ts baseArtifacts). Every role was named
 * before the login compiles, so no change compile meets a role name the installation cannot create.
 */
export interface ChangeLogin<S extends ParamSource = ParamSource> {
	readonly roles: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
	readonly workload: ReadonlyArray<unknown>
	readonly named: NamedLogin
	readonly artifacts: SchemaArtifacts<S>
	/** Where its change members' readings of the clock count from: the transaction's for every served file `grizzle
	 * generate` writes, a moved clock's for a test's (ir/clock.ts ClockSource). */
	readonly clock: ClockSource
	/** The front ends a workload's plan compiled beside it (planned.ts PlannedFrontends): each change member's variant
	 * in which every fill context holds a fact reads its key's there, where its compile would build that one. */
	readonly planned: PlannedFrontends
}

/**
 * One role of a login with its change members compiled: its value parsed, its owned role as the installation named it,
 * its artifacts over its login's, and each ChangeSet of the login's workloads that runs on it, by the program's name,
 * its variants compiled once.
 */
export interface RoleChanges<L extends Isolation = Isolation, S extends ParamSource = ParamSource> {
	readonly input: ParsedRole
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts<S>
	/** The level every member was compiled for (write/program/compile.ts CompiledWrite `level`), the one the role's
	 * writes run at once served: one per role. */
	readonly level: L
	readonly members: ReadonlyMap<string, CompiledVariants<S>>
}

/**
 * A login's change compile refused: the role it was compiling, by its name in the login, the program of the login's
 * workloads that refused, none where the role's own value, artifacts or workloads did, and the compiler's refusal.
 */
export interface ChangeRefused {
	readonly role: string
	readonly program: string | undefined
	readonly error: CompileError
}

/**
 * One role of `login` before its change members compile: its value parsed, its owned role as the installation named it,
 * its artifacts over its login's, and each ChangeSet of the login's workloads that runs on it, compiled at a level by
 * `compile`, its variants over its fill contexts, each prepared once for every level its role compiles it at
 * (PreparedVariants).
 */
interface RoleBase<S extends ParamSource> {
	readonly input: ParsedRole
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts<S>
	readonly programs: ReadonlyArray<{
		readonly name: string
		readonly compile: (level: Isolation) => Result.Result<CompiledVariants<S>, CompileError>
	}>
}

/** One role of `login` before its change members compile (RoleBase). */
const roleBase = <S extends ParamSource>(
	name: string,
	value: unknown,
	login: ChangeLogin<S>
): Result.Result<RoleBase<S>, ChangeRefused> => {
	const refused = (error: CompileError): ChangeRefused => ({
		role: name,
		program: undefined,
		error
	})
	const parsed = loginRole(value, login.named.owned)
	if (!parsed.ok) {
		return Result.err(refused(parsed.error))
	}
	const { input, owned } = parsed.value
	const named = defined(
		login.named.roles.find((r) => r.owned === owned),
		`role ${owned.name} of login ${login.named.owned.name}, which namedLogin named`
	)
	const artifacts = roleArtifacts(named, login.artifacts)
	if (!artifacts.ok) {
		return Result.err(refused(artifacts.error))
	}
	const running = programsOn(input, login.workload)
	if (!running.ok) {
		return Result.err(refused(running.error))
	}
	return Result.ok({
		input,
		named,
		artifacts: artifacts.value,
		programs: running.value.flatMap((program) => {
			if (program.kind !== "changeSet") {
				return []
			}
			const planned = login.planned.everyHolding({
				laws: artifacts.value.laws,
				login: login.named.owned.name,
				role: owned.name,
				program: program.name,
				clock: program.clock,
				source: login.clock
			})
			const variants = once(() =>
				preparedVariants(
					input,
					artifacts.value,
					program.value,
					program.clock,
					login.clock,
					fillContexts(owned.writes, program.desc.changeSet),
					[],
					planned === undefined ? compiledFrontend : { kind: "planned", frontend: planned }
				)
			)
			return [
				{
					name: program.name,
					compile: (level: Isolation) => variantsCompiledAt(variants(), level)
				}
			]
		})
	})
}

/** `base`'s change members compiled at `level` (RoleChanges), or the first that refuses. */
const membersAt = <L extends Isolation, S extends ParamSource>(
	name: string,
	base: RoleBase<S>,
	level: L
): Result.Result<RoleChanges<L, S>, ChangeRefused> => {
	const members = new Map<string, CompiledVariants<S>>()
	for (const program of base.programs) {
		const variants = program.compile(level)
		if (!variants.ok) {
			return Result.err({ role: name, program: program.name, error: variants.error })
		}
		members.set(program.name, variants.value)
	}
	return Result.ok({
		input: base.input,
		named: base.named,
		artifacts: base.artifacts,
		level,
		members
	})
}

/** One role of `login`, its change members compiled at `level` (RoleChanges). */
const roleChanges = <L extends Isolation, S extends ParamSource>(
	name: string,
	value: unknown,
	login: ChangeLogin<S>,
	level: L
): Result.Result<RoleChanges<L, S>, ChangeRefused> =>
	Result.flatMap(roleBase(name, value, login), (base) => membersAt(name, base, level))

/**
 * One role of a login compiled for READ COMMITTED (`readCommittedChanges`): every change member formed, the role's
 * changes at READ COMMITTED, which certification judges it by and serves where it certifies the role; or some member
 * with no READ COMMITTED form (core/errors.ts NoReadCommittedForm), which no certificate can serve at that level, the
 * role's changes at SERIALIZABLE, the form it is served, beside each such member with the relation it has none for.
 */
export type ReadCommittedRole<S extends ParamSource = ParamSource> =
	| { readonly kind: "formed"; readonly changes: RoleChanges<"readCommitted", S> }
	| {
			readonly kind: "unformed"
			readonly changes: RoleChanges<"serializable", S>
			readonly unformed: NonEmptyReadonlyArray<Unformed>
	  }

/** One role of `login` compiled for READ COMMITTED (ReadCommittedRole), each ChangeSet's compile a phase reported to
 * `phases` (`changeSet`). */
/**
 * A role's member compiled for READ COMMITTED (readCommittedRole): its variants; or, where it has no READ COMMITTED form,
 * the relation and the reason alone, the refusal that said so dropped here, in this frame, with the stack it captured,
 * whose frames' closures held its compile's placement, the physical analysis of its write's whole DAG, for as long as
 * the role's loop held the refusal (edullm's qti: the learner role's decideStage, ~1.1 GB, alive through the next
 * member's compile); or any other refusal, which refuses the role.
 */
const readCommittedMember = <S extends ParamSource>(program: {
	readonly name: string
	readonly compile: (level: Isolation) => Result.Result<CompiledVariants<S>, CompileError>
}):
	| { readonly kind: "formed"; readonly variants: CompiledVariants<S> }
	| { readonly kind: "unformed"; readonly unformed: Unformed }
	| { readonly kind: "refused"; readonly error: CompileError } => {
	const variants = program.compile("readCommitted")
	if (variants.ok) {
		return { kind: "formed", variants: variants.value }
	}
	const reason = variants.error.reason
	return reason._tag === "NoReadCommittedForm"
		? {
				kind: "unformed",
				unformed: { member: program.name, relation: reason.relation, why: reason.why }
			}
		: { kind: "refused", error: variants.error }
}

const readCommittedRole = <S extends ParamSource>(
	name: string,
	value: unknown,
	login: ChangeLogin<S>,
	phases: Phases
): Result.Result<ReadCommittedRole<S>, ChangeRefused> =>
	Result.flatMap(roleBase(name, value, login), (base) => {
		const members = new Map<string, CompiledVariants<S>>()
		const unformed: Array<Unformed> = []
		for (const program of base.programs) {
			const compiled = phased(phases, { name: "changeSet", of: [name, program.name] }, () =>
				readCommittedMember(program)
			)
			switch (compiled.kind) {
				case "formed":
					members.set(program.name, compiled.variants)
					break
				case "unformed":
					unformed.push(compiled.unformed)
					break
				case "refused":
					return Result.err({ role: name, program: program.name, error: compiled.error })
			}
		}
		return isNonEmpty(unformed)
			? Result.map(membersAt(name, base, "serializable"), (changes): ReadCommittedRole<S> => ({
					kind: "unformed",
					changes,
					unformed
				}))
			: Result.ok({
					kind: "formed",
					changes: {
						input: base.input,
						named: base.named,
						artifacts: base.artifacts,
						level: "readCommitted",
						members
					}
				})
	})

/**
 * Every role of a login, by its name in the login, in its order, each with the ChangeSets of the login's workloads that
 * run on it compiled once over its artifacts at `level` (RoleChanges): SERIALIZABLE for a compile no certificate covers;
 * certification compiles for READ COMMITTED through readCommittedChanges, which tells a member with no READ COMMITTED
 * form from a refusal. A role or program that does not compile is ChangeRefused.
 */
export const loginChanges = <L extends Isolation, S extends ParamSource>(
	login: ChangeLogin<S>,
	level: L
): Result.Result<ReadonlyMap<string, RoleChanges<L, S>>, ChangeRefused> => {
	const roles = new Map<string, RoleChanges<L, S>>()
	for (const { name, value } of login.roles) {
		const role = roleChanges(name, value, login, level)
		if (!role.ok) {
			return role
		}
		roles.set(name, role.value)
	}
	return Result.ok(roles)
}

/**
 * Every role of a login, by its name in the login, in its order, compiled for READ COMMITTED (ReadCommittedRole): what
 * the installation's certification reads first, and serves a role it certifies READ COMMITTED. A role or program that
 * does not compile for another reason is ChangeRefused. Each ChangeSet's compile is a phase reported to `phases`.
 */
export const readCommittedChanges = <S extends ParamSource>(
	login: ChangeLogin<S>,
	phases: Phases
): Result.Result<ReadonlyMap<string, ReadCommittedRole<S>>, ChangeRefused> => {
	const roles = new Map<string, ReadCommittedRole<S>>()
	for (const { name, value } of login.roles) {
		const role = readCommittedRole(name, value, login, phases)
		if (!role.ok) {
			return role
		}
		roles.set(name, role.value)
	}
	return Result.ok(roles)
}

/** `variants` compiled again at `level`, each form's entry from the write it was prepared as (PreparedEntry), holding
 * side first. */
const variantsAt = <S extends ParamSource>(
	variants: CompiledVariants<S>,
	level: Isolation
): Result.Result<CompiledVariants<S>, CompileError> => {
	switch (variants.kind) {
		case "form":
			return Result.map(
				entryOf(variants.entry, variants.entry.prepared.compile(level)),
				(entry): CompiledVariants<S> => ({
					kind: "form",
					entry,
					decoder: variants.decoder
				})
			)
		case "split":
			return Result.flatMap(variantsAt(variants.holding, level), (held) =>
				Result.map(variantsAt(variants.lacking, level), (lacking): CompiledVariants<S> => ({
					kind: "split",
					context: variants.context,
					holding: held,
					lacking
				}))
			)
	}
}

/**
 * `role`, its change members compiled again at `level` (RoleChanges), each from the write its entry was prepared as,
 * for the contexts its variant holds a fact of.
 */
export const changesAt = <L extends Isolation, S extends ParamSource>(
	role: RoleChanges<Isolation, S>,
	level: L
): Result.Result<RoleChanges<L, S>, CompileError> => {
	const members = new Map<string, CompiledVariants<S>>()
	for (const [name, variants] of role.members) {
		const lowered = variantsAt(variants, level)
		if (!lowered.ok) {
			return lowered
		}
		members.set(name, lowered.value)
	}
	return Result.ok({ ...role, level, members })
}

/**
 * `role` compiled again for SERIALIZABLE (`changesAt`): what a login's served file projects for a role its certification
 * leaves SERIALIZABLE, and what that certification then reads of it (program/isolation/certification.ts).
 */
export const serializableChanges = <S extends ParamSource>(
	role: RoleChanges<"readCommitted", S>
): Result.Result<RoleChanges<"serializable", S>, CompileError> => changesAt(role, "serializable")
