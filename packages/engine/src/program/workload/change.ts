import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { MemberFacts, Unformed } from "#compiler/analysis/isolation/facts.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { once } from "#compiler/core/lazy.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Phases, phased, silentPhases } from "#compiler/core/phase.ts"
import type { ClockBinding, ClockSource } from "#compiler/ir/clock.ts"
import type { NamedLogin, NamedRole } from "#compiler/physical/ddl/names.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"
import { type ParsedRole, parseOver } from "#compiler/program/input.ts"
import type { ExtractNames } from "#compiler/program/isolation/extract.ts"
import { compiledFacts, extractNames } from "#compiler/program/isolation/member-facts.ts"
import { programSchema, roleArtifacts, type SchemaArtifacts } from "#compiler/program/schema.ts"
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
	preparedWrite
} from "#compiler/write/program/compile.ts"
import { type ServableWrite, servableWrite } from "#compiler/write/program/served.ts"
import type { FormLack } from "#compiler/write/schedule/plan.ts"

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
	/** The contexts its write was prepared for: those of its variant that hold a fact (write/frontend/entry.ts
	 * EntryClaims `facts`). */
	readonly claims: ReadonlySet<string>
	readonly change: ParsedChangeSet
	readonly clock: ClockBinding
	/** Where its readings of the clock count from (write/program/compile.ts CompileWriteOptions `source`), which a
	 * compile of it again at another level keeps. */
	readonly source: ClockSource
	readonly schema: SchemaFingerprint
	readonly names: WriteNames
}

/**
 * A workload ChangeSet's variants, one entry `E` for each set of its fill contexts that may hold a fact, since a write
 * into a query entry compiles for the contexts a Db's claims hold (write/frontend/entry.ts): one entry with the
 * ChangeSet's reads decoder, or a split on one context into the variants for a Db holding a fact of it and one lacking
 * it. Each entry is compiled (ChangeEntry, CompiledVariants), as certification reads it (CertifiableEntry) or as a
 * served file reads it (ServableEntry, ServableVariants).
 */
export type Variants<E> =
	| { readonly kind: "form"; readonly entry: E; readonly decoder: RowDecoder<unknown> }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: Variants<E>
			readonly lacking: Variants<E>
	  }

/** A workload ChangeSet compiled for each set of its fill contexts that may hold a fact (Variants, ChangeEntry). */
export type CompiledVariants<S extends ParamSource = ParamSource> = Variants<ChangeEntry<S>>

/** `variants` with each entry `f`'s of it, in the same splits. */
export const variantsMap = <A, B>(variants: Variants<A>, f: (entry: A) => B): Variants<B> =>
	variants.kind === "form"
		? Object.freeze({ kind: "form", entry: f(variants.entry), decoder: variants.decoder })
		: Object.freeze({
				kind: "split",
				context: variants.context,
				holding: variantsMap(variants.holding, f),
				lacking: variantsMap(variants.lacking, f)
			})

/** The entries of `variants`, every form of its splits, holding side first. */
export const variantsEntries = <E>(variants: Variants<E>): ReadonlyArray<E> =>
	variants.kind === "form"
		? [variants.entry]
		: [...variantsEntries(variants.holding), ...variantsEntries(variants.lacking)]

/**
 * `variants` with each entry `f`'s of it, in the same splits, holding side first, or the first refusal in that order.
 */
const variantsTraverse = <A, B, E>(
	variants: Variants<A>,
	f: (entry: A) => Result.Result<B, E>
): Result.Result<Variants<B>, E> => {
	switch (variants.kind) {
		case "form":
			return Result.map(f(variants.entry), (entry): Variants<B> =>
				Object.freeze({ kind: "form", entry, decoder: variants.decoder })
			)
		case "split":
			return Result.flatMap(variantsTraverse(variants.holding, f), (holding) =>
				Result.map(variantsTraverse(variants.lacking, f), (lacking): Variants<B> =>
					Object.freeze({ kind: "split", context: variants.context, holding, lacking })
				)
			)
	}
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

/** A workload ChangeSet's variants with each entry servable (Variants, ServableEntry). */
export type ServableVariants<S extends ParamSource = ParamSource> = Variants<ServableEntry<S>>

/**
 * A ChangeSet compiled for a role as certification reads it (readCommittedChanges): its entry servable (ServableEntry),
 * what its served file reads; its isolation facts, extracted from the statements its flight may send as it compiled
 * (program/isolation/member-facts.ts compiledFacts), which is all certification reads of its statements; and the
 * contexts its variant was prepared for, which a compile of it at another level prepares it for again from its value
 * (serializableChanges), where certification leaves its role SERIALIZABLE. A ChangeEntry holds its whole compiled write
 * and its prepared write instead: its artifact, every statement's SQL AST in it, its front end, put choices, schedule,
 * placements and admission, which nothing past its compile reads, so each member's front end dies with its compile.
 */
export interface CertifiableEntry<S extends ParamSource = ParamSource> extends ServableEntry<S> {
	readonly facts: ReadonlyArray<MemberFacts>
	readonly claims: ReadonlySet<string>
}

/**
 * One role of a login with its change members compiled, each a ChangeSet of the login's workloads that runs on it, by
 * the program's name, its variants' entries `E`: compiled (RoleChanges), as certification reads them
 * (CertifiableRole) or as a served file reads them (ServableRole).
 */
interface RoleMembers<L extends Isolation, S extends ParamSource, E> {
	readonly input: ParsedRole
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts<S>
	/** The level every member was compiled for (write/program/compile.ts CompiledWrite `level`), the one the role's
	 * writes run at once served: one per role. */
	readonly level: L
	readonly members: ReadonlyMap<string, Variants<E>>
}

/**
 * One role of a login with its change members compiled: its value parsed, its owned role as the installation named it,
 * its artifacts over its login's, and each ChangeSet of the login's workloads that runs on it, by the program's name,
 * its variants compiled once.
 */
export type RoleChanges<
	L extends Isolation = Isolation,
	S extends ParamSource = ParamSource
> = RoleMembers<L, S, ChangeEntry<S>>

/** One role of a login with its change members as certification reads them (RoleMembers, CertifiableEntry). */
export type CertifiableRole<
	L extends Isolation = Isolation,
	S extends ParamSource = ParamSource
> = RoleMembers<L, S, CertifiableEntry<S>>

/**
 * One role of a login with its change members as its served file reads them (RoleMembers, ServableEntry): what a
 * generate holds of a role once its certification has read its compiled writes.
 */
export type ServableRole<
	L extends Isolation = Isolation,
	S extends ParamSource = ParamSource
> = RoleMembers<L, S, ServableEntry<S>>

/** `entry` as its served file reads it (ServableEntry), its compiled write servable and its prepared write dropped. */
export const servableEntry = <S extends ParamSource>(entry: ChangeEntry<S>): ServableEntry<S> =>
	Object.freeze({
		params: entry.params,
		change: entry.change,
		clock: entry.clock,
		source: entry.source,
		schema: entry.schema,
		names: entry.names,
		compiled: servableWrite(entry.compiled)
	})

/**
 * `entry` of change member `name` as certification reads it (CertifiableEntry): its compiled write servable, its facts
 * extracted read back by `names`, its prepared write kept; its artifact, every statement's AST in it, and everything
 * else its compile built dropped.
 */
const certifiableEntry = <S extends ParamSource>(
	name: string,
	entry: ChangeEntry<S>,
	names: ExtractNames
): CertifiableEntry<S> =>
	Object.freeze({
		...servableEntry(entry),
		facts: compiledFacts(name, entry.compiled, names),
		claims: entry.claims
	})

/** `entry` as its served file reads it once certified (ServableEntry): its facts and its claims dropped. */
const certifiedEntry = <S extends ParamSource>(entry: CertifiableEntry<S>): ServableEntry<S> =>
	Object.freeze({
		params: entry.params,
		change: entry.change,
		clock: entry.clock,
		source: entry.source,
		schema: entry.schema,
		names: entry.names,
		compiled: entry.compiled
	})

/** `role` with each change member's entry `f`'s of it. */
const rolesEntries = <L extends Isolation, S extends ParamSource, A, B>(
	role: RoleMembers<L, S, A>,
	f: (entry: A) => B
): RoleMembers<L, S, B> =>
	Object.freeze({
		input: role.input,
		named: role.named,
		artifacts: role.artifacts,
		level: role.level,
		members: new Map([...role.members].map(([name, v]) => [name, variantsMap(v, f)] as const))
	})

/**
 * `role`, compiled, as its served file reads it (ServableRole): every change member's entry servable, so the role holds
 * none of its compiles' artifacts, front ends, analyses, schedules, placements or prepared writes.
 */
export const servableRole = <L extends Isolation, S extends ParamSource>(
	role: RoleChanges<L, S>
): ServableRole<L, S> => rolesEntries(role, servableEntry)

/** Each of a login's roles, compiled, by its name, as its served file reads it (servableRole). */
export const servableRoles = <L extends Isolation, S extends ParamSource>(
	roles: ReadonlyMap<string, RoleChanges<L, S>>
): ReadonlyMap<string, ServableRole<L, S>> =>
	new Map([...roles].map(([name, role]) => [name, servableRole(role)] as const))

/**
 * `role`, as its certification read it, as its served file reads it (ServableRole): its facts and its prepared writes
 * dropped, which its certification read and nothing after it does.
 */
export const certifiedRole = <L extends Isolation, S extends ParamSource>(
	role: CertifiableRole<L, S>
): ServableRole<L, S> => rolesEntries(role, certifiedEntry)

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
			claims,
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
		claims: entry.claims,
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
 * Why prepared variants have no READ COMMITTED form (write/schedule/plan.ts FormLack): their first form's that has none,
 * in the order their compile meets them (variantsCompiledAt), each form's entry prepared, where it is not yet, just
 * before its form is read, and none prepared past the first form that has none; none where every form has one. The
 * first refusal in that order refuses them all.
 */
const variantsLack = <S extends ParamSource>(
	variants: PreparedVariants<S>
): Result.Result<FormLack | undefined, CompileError> => {
	switch (variants.kind) {
		case "form":
			return Result.map(variants.entry(), (prepared) => prepared.prepared.readCommittedLack)
		case "split":
			return Result.flatMap(variantsLack(variants.lacking), (lacking) =>
				lacking === undefined ? variantsLack(variants.holding) : Result.ok(lacking)
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
 * `compile`, its variants over its fill contexts, each prepared once for every level its role compiles it at and for
 * the read of why it has no READ COMMITTED form (`lack`, variantsLack) before them (PreparedVariants).
 */
interface RoleBase<S extends ParamSource> {
	readonly input: ParsedRole
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts<S>
	readonly programs: ReadonlyArray<{
		readonly name: string
		readonly lack: () => Result.Result<FormLack | undefined, CompileError>
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
			const planned = login.planned.take({
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
					lack: () => variantsLack(variants()),
					compile: (level: Isolation) => variantsCompiledAt(variants(), level)
				}
			]
		})
	})
}

/**
 * `base`'s change members compiled at `level`, or the first that refuses, each member's compile a phase reported to
 * `phases` (`changeSet`), and each entry kept as `keep` makes it as its member compiles, so a member's compile holds
 * only what `keep` keeps of it past the next member's.
 */
const membersAt = <L extends Isolation, S extends ParamSource, E>(
	name: string,
	base: RoleBase<S>,
	level: L,
	phases: Phases,
	keep: (name: string, entry: ChangeEntry<S>) => E
): Result.Result<RoleMembers<L, S, E>, ChangeRefused> => {
	const members = new Map<string, Variants<E>>()
	for (const program of base.programs) {
		const variants = phased(phases, { name: "changeSet", of: [name, program.name] }, () =>
			program.compile(level)
		)
		if (!variants.ok) {
			return Result.err({ role: name, program: program.name, error: variants.error })
		}
		members.set(
			program.name,
			variantsMap(variants.value, (entry) => keep(program.name, entry))
		)
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
	Result.flatMap(roleBase(name, value, login), (base) =>
		membersAt(name, base, level, silentPhases, (_, entry) => entry)
	)

/**
 * One role of a login compiled for READ COMMITTED (`readCommittedChanges`): every change member formed, the role's
 * changes at READ COMMITTED, which certification judges it by and serves where it certifies the role; or some member
 * with no READ COMMITTED form (core/errors.ts NoReadCommittedForm), which no certificate can serve at that level, the
 * role's changes at SERIALIZABLE, the form it is served, beside each such member with the relation it has none for.
 * Each entry is as certification reads it (CertifiableEntry).
 */
export type ReadCommittedRole<S extends ParamSource = ParamSource> =
	| { readonly kind: "formed"; readonly changes: CertifiableRole<"readCommitted", S> }
	| {
			readonly kind: "unformed"
			readonly changes: CertifiableRole<"serializable", S>
			readonly unformed: NonEmptyReadonlyArray<Unformed>
	  }

/**
 * One role of `login` compiled for READ COMMITTED (ReadCommittedRole): each member prepared and read for why it has no
 * READ COMMITTED form (RoleBase `lack`), a phase reported to `phases` (`frontEnd`); then, every member formed, each
 * compiled at READ COMMITTED, or, some member lacking one, each compiled at SERIALIZABLE alone, never at READ COMMITTED,
 * each a phase (`changeSet`, membersAt). A role with a member lacking a form compiled every member at READ COMMITTED
 * first, each formed member's compile thrown away and each lacking one's placed for its refusal (edullm's qti: the
 * learner role's decideStage, 52 s of its 101 s at READ COMMITTED), and then at SERIALIZABLE, every READ COMMITTED
 * compile alive beside it. Each member's entry is kept as certification reads it (CertifiableEntry) as the member
 * compiles, where the role held every compiled write whole, its front end, put choices, schedule, placements and
 * admission, through certification (edullm's qti: 32 compiled writes, 931 MB at certification's start).
 */
const readCommittedRole = <S extends ParamSource>(
	name: string,
	value: unknown,
	login: ChangeLogin<S>,
	phases: Phases
): Result.Result<ReadCommittedRole<S>, ChangeRefused> =>
	Result.flatMap(roleBase(name, value, login), (base) => {
		const unformed: Array<Unformed> = []
		for (const program of base.programs) {
			const lack = phased(phases, { name: "frontEnd", of: [name, program.name] }, () =>
				program.lack()
			)
			if (!lack.ok) {
				return Result.err({ role: name, program: program.name, error: lack.error })
			}
			if (lack.value !== undefined) {
				unformed.push({ member: program.name, relation: lack.value.relation })
			}
		}
		const names = extractNames(base)
		if (!names.ok) {
			return Result.err({ role: name, program: undefined, error: names.error })
		}
		const certifiable = (program: string, entry: ChangeEntry<S>) =>
			certifiableEntry(program, entry, names.value)
		return isNonEmpty(unformed)
			? Result.map(
					membersAt(name, base, "serializable", phases, certifiable),
					(changes): ReadCommittedRole<S> => ({ kind: "unformed", changes, unformed })
				)
			: Result.map(
					membersAt(name, base, "readCommitted", phases, certifiable),
					(changes): ReadCommittedRole<S> => ({ kind: "formed", changes })
				)
	})

/**
 * Every role of a login, by its name in the login, in its order, each with the ChangeSets of the login's workloads that
 * run on it compiled once over its artifacts at `level` (RoleChanges): SERIALIZABLE for a compile no certificate covers;
 * certification compiles for READ COMMITTED through readCommittedChanges, which reads whether each member has a READ
 * COMMITTED form before it compiles any. A role or program that does not compile is ChangeRefused.
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
 * does not compile is ChangeRefused. Each ChangeSet's preparation and its compile are phases reported to `phases`
 * (`frontEnd`, `changeSet`).
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

/**
 * `entry` of change member `name` compiled again at `level`, prepared again from its value over `artifacts`, its role's,
 * for the contexts it was prepared for, as certification reads it (CertifiableEntry), its facts read back by `names`.
 */
const certifiableAt = <S extends ParamSource>(
	name: string,
	entry: CertifiableEntry<S>,
	artifacts: SchemaArtifacts<S>,
	names: ExtractNames,
	level: Isolation
): Result.Result<CertifiableEntry<S>, CompileError> =>
	Result.flatMap(
		preparedParsed(artifacts, entry.change, entry.claims, entry.clock, entry.source),
		(prepared) =>
			Result.map(entryOf(prepared, prepared.prepared.compile(level)), (compiled) =>
				certifiableEntry(name, compiled, names)
			)
	)

/**
 * `role` compiled again for SERIALIZABLE, each entry prepared again from its value, its front end compiled afresh, for
 * the contexts its variant holds a fact of, holding side first: what a login's served file projects for a role its
 * certification leaves SERIALIZABLE, and what that certification then reads of it (program/isolation/certification.ts).
 * No entry keeps its prepared write past its compile (CertifiableEntry), so a role certification never lowers holds
 * none of its front ends, and one it lowers prepares each again.
 */
export const serializableChanges = <S extends ParamSource>(
	role: CertifiableRole<"readCommitted", S>
): Result.Result<CertifiableRole<"serializable", S>, CompileError> => {
	const names = extractNames(role)
	if (!names.ok) {
		return names
	}
	const members = new Map<string, Variants<CertifiableEntry<S>>>()
	for (const [name, variants] of role.members) {
		const lowered = variantsTraverse(variants, (entry) =>
			certifiableAt(name, entry, role.artifacts, names.value, "serializable")
		)
		if (!lowered.ok) {
			return lowered
		}
		members.set(name, lowered.value)
	}
	return Result.ok({ ...role, level: "serializable", members })
}
