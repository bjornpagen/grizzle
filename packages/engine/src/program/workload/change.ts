import type { RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { ClockBinding } from "#compiler/ir/clock.ts"
import type { NamedLogin, NamedRole } from "#compiler/physical/ddl/names.ts"
import {
	levelSchema,
	type ParsedRole,
	parseOver,
	roleArtifacts,
	type SchemaArtifacts
} from "#compiler/program/schema.ts"
import { loginRole, programsOn } from "#compiler/program/workload/roles.ts"
import {
	type ChangeSetValue,
	parseChangeSet,
	type ParsedChangeSet
} from "#compiler/write/changeset/value.ts"
import { fillContexts } from "#compiler/write/frontend/entry.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { type CompiledWrite, compileClockedWrite } from "#compiler/write/program/compile.ts"

/**
 * A ChangeSet compiled for a role: its write program as it compiled, the value parsed whole, the parameters its member
 * binds to the database's clock, the fingerprint of the schema it compiled against and the installed names it read.
 * What a served file projects of it (served/project.ts), and what the shell's runtime entry is built over.
 */
export interface ChangeEntry {
	readonly compiled: CompiledWrite
	readonly change: ParsedChangeSet
	readonly clock: ClockBinding
	readonly schema: SchemaFingerprint
	readonly names: WriteNames
}

/**
 * A workload ChangeSet compiled for each set of its fill contexts that may hold a fact, since a write into a query entry
 * compiles for the contexts a Db's claims hold (write/frontend/entry.ts): one compiled entry with the ChangeSet's reads
 * decoder, or a split on one context into the variants for a Db holding a fact of it and one lacking it.
 */
export type CompiledVariants =
	| { readonly kind: "form"; readonly entry: ChangeEntry; readonly decoder: RowDecoder<unknown> }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: CompiledVariants
			readonly lacking: CompiledVariants
	  }

const applyLoc = SourceLoc("db.apply", [])

/**
 * The parsed ChangeSet of a value, or the refusal of a value that is not one, or of one built over a schema that is no
 * level of the role's (program/schema.ts levelSchema), before any SQL.
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
		Result.map(levelSchema(carried, role, applyLoc), () => change)
	)
}

/**
 * A parsed ChangeSet compiled against `artifacts`, a role's or reality's, for the contexts `claims` holds a fact of, to
 * run at `level`, each parameter `clock` names bound to the database's clock (write/program/compile.ts
 * compileClockedWrite).
 */
export const compileParsed = (
	artifacts: SchemaArtifacts,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>,
	level: Isolation,
	clock: ClockBinding
): Result.Result<ChangeEntry, CompileError> => {
	const world = artifacts.world
	return Result.map(
		compileClockedWrite(
			world.kind === "role" ? world.checked : artifacts.derived.schema,
			change.desc,
			{
				names: artifacts.names,
				reads: artifacts.reads,
				claims: { kind: "facts", present: claims },
				world: world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
				laws: artifacts.laws,
				derived: artifacts.derived,
				level
			},
			clock
		),
		(compiled): ChangeEntry => ({
			compiled,
			change,
			clock,
			schema: artifacts.fingerprint,
			names: artifacts.names
		})
	)
}

/**
 * The variants of `changes` for a role, its value parsed `role` over its artifacts `artifacts`, over the fill contexts
 * `undecided`, the contexts after them already decided to hold or lack a fact, `holding` those that hold one, in the
 * fill contexts' order. The last undecided context splits first and each split compiles its lacking side first, so the
 * entries compile in the order of the subsets of the fill contexts counted with the first context as the lowest digit.
 */
const changeVariants = (
	role: ParsedRole,
	artifacts: SchemaArtifacts,
	changes: ChangeSetValue,
	clock: ClockBinding,
	level: Isolation,
	undecided: ReadonlyArray<string>,
	holding: ReadonlyArray<string>
): Result.Result<CompiledVariants, CompileError> => {
	const context = undecided.at(-1)
	if (context === undefined) {
		return Result.map(
			Result.flatMap(parsedChange(role, changes), (change) =>
				compileParsed(artifacts, change, new Set(holding), level, clock)
			),
			(entry): CompiledVariants => ({ kind: "form", entry, decoder: changes.reads })
		)
	}
	const before = undecided.slice(0, -1)
	return Result.flatMap(
		changeVariants(role, artifacts, changes, clock, level, before, holding),
		(lacking) =>
			Result.map(
				changeVariants(role, artifacts, changes, clock, level, before, [context, ...holding]),
				(held): CompiledVariants => ({ kind: "split", context, holding: held, lacking })
			)
	)
}

/**
 * A login as its change members compile: its roles' values by their names in the login, in its order, its workloads,
 * the login owned over its base's Owned with every role named under the installation (physical/ddl/names.ts
 * namedLogin), and the artifacts its served file compiles over, its base's over every relation. Every role was named
 * before the login compiles, so no change compile meets a role name the installation cannot create.
 */
export interface ChangeLogin {
	readonly roles: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
	readonly workload: ReadonlyArray<unknown>
	readonly named: NamedLogin
	readonly artifacts: SchemaArtifacts
}

/**
 * One role of a login with its change members compiled: its value parsed, its owned role as the installation named it,
 * its artifacts over its login's, and each ChangeSet of the login's workloads that runs on it, by the program's name,
 * its variants compiled once.
 */
export interface RoleChanges<L extends Isolation = Isolation> {
	readonly input: ParsedRole
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts
	/** The level every member was compiled for (write/program/compile.ts CompiledWrite `level`), the one the role's
	 * writes run at once served: one per role. */
	readonly level: L
	readonly members: ReadonlyMap<string, CompiledVariants>
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

/** One role of `login`, its change members compiled at `level` (RoleChanges). */
const roleChanges = <L extends Isolation>(
	name: string,
	value: unknown,
	login: ChangeLogin,
	level: L
): Result.Result<RoleChanges<L>, ChangeRefused> => {
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
	const members = new Map<string, CompiledVariants>()
	for (const program of running.value) {
		if (program.kind !== "changeSet") {
			continue
		}
		const fill = fillContexts(owned.writes, program.desc.changeSet)
		const variants = changeVariants(
			input,
			artifacts.value,
			program.value,
			program.clock,
			level,
			fill,
			[]
		)
		if (!variants.ok) {
			return Result.err({ role: name, program: program.name, error: variants.error })
		}
		members.set(program.name, variants.value)
	}
	return Result.ok({ input, named, artifacts: artifacts.value, level, members })
}

/**
 * Every role of a login, by its name in the login, in its order, each with the ChangeSets of the login's workloads that
 * run on it compiled once over its artifacts at `level` (RoleChanges): READ COMMITTED for what the installation's
 * certification reads first and serves a role it certifies READ COMMITTED; SERIALIZABLE for a compile no certificate
 * covers. A role or program that does not compile is ChangeRefused.
 */
export const loginChanges = <L extends Isolation>(
	login: ChangeLogin,
	level: L
): Result.Result<ReadonlyMap<string, RoleChanges<L>>, ChangeRefused> => {
	const roles = new Map<string, RoleChanges<L>>()
	for (const { name, value } of login.roles) {
		const role = roleChanges(name, value, login, level)
		if (!role.ok) {
			return role
		}
		roles.set(name, role.value)
	}
	return Result.ok(roles)
}

/** `variants` compiled again at `level`, each form's ChangeSet for the contexts its split path holds a fact of. */
const variantsAt = (
	artifacts: SchemaArtifacts,
	variants: CompiledVariants,
	holding: ReadonlyArray<string>,
	level: Isolation
): Result.Result<CompiledVariants, CompileError> => {
	switch (variants.kind) {
		case "form":
			return Result.map(
				compileParsed(
					artifacts,
					variants.entry.change,
					new Set(holding),
					level,
					variants.entry.clock
				),
				(entry): CompiledVariants => ({ kind: "form", entry, decoder: variants.decoder })
			)
		case "split":
			return Result.flatMap(
				variantsAt(artifacts, variants.holding, [variants.context, ...holding], level),
				(held) =>
					Result.map(
						variantsAt(artifacts, variants.lacking, holding, level),
						(lacking): CompiledVariants => ({
							kind: "split",
							context: variants.context,
							holding: held,
							lacking
						})
					)
			)
	}
}

/**
 * `role`, its change members compiled again at `level` (RoleChanges), each from the ChangeSet it parsed, for the contexts
 * its variant holds a fact of.
 */
export const changesAt = <L extends Isolation>(
	role: RoleChanges,
	level: L
): Result.Result<RoleChanges<L>, CompileError> => {
	const members = new Map<string, CompiledVariants>()
	for (const [name, variants] of role.members) {
		const lowered = variantsAt(role.artifacts, variants, [], level)
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
export const serializableChanges = (
	role: RoleChanges<"readCommitted">
): Result.Result<RoleChanges<"serializable">, CompileError> => changesAt(role, "serializable")
