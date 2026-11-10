import type { RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	levelSchema,
	type ParsedRole,
	parseSchemaInput,
	roleArtifacts,
	type SchemaArtifacts
} from "#compiler/program/schema.ts"
import { loginRole, programsOn } from "#compiler/program/workload/roles.ts"
import type { OwnedLogin, OwnedRole } from "#compiler/schema/own.ts"
import {
	type ChangeSetValue,
	parseChangeSet,
	type ParsedChangeSet
} from "#compiler/write/changeset/value.ts"
import { fillContexts } from "#compiler/write/frontend/entry.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"

/**
 * A ChangeSet compiled for a role: its write program as it compiled, the value parsed whole, the fingerprint of the
 * schema it compiled against and the installed names it read. What a served file projects of it (served/project.ts),
 * and what the shell's runtime entry is built over.
 */
export interface ChangeEntry {
	readonly compiled: CompiledWrite
	readonly change: ParsedChangeSet
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
	return Result.flatMap(parseSchemaInput(change.over.value), (carried) =>
		Result.map(levelSchema(carried, role, applyLoc), () => change)
	)
}

/**
 * A parsed ChangeSet compiled against `artifacts`, a role's or reality's, for the contexts `claims` holds a fact of
 * (write/program/compile.ts compileWrite).
 */
export const compileParsed = (
	artifacts: SchemaArtifacts,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Result.Result<ChangeEntry, CompileError> => {
	const world = artifacts.world
	return Result.map(
		compileWrite(world.kind === "role" ? world.checked : artifacts.derived.schema, change.desc, {
			names: artifacts.names,
			reads: artifacts.reads,
			claims: { kind: "facts", present: claims },
			world: world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived
		}),
		(compiled): ChangeEntry => ({
			compiled,
			change,
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
	undecided: ReadonlyArray<string>,
	holding: ReadonlyArray<string>
): Result.Result<CompiledVariants, CompileError> => {
	const context = undecided.at(-1)
	if (context === undefined) {
		return Result.map(
			Result.flatMap(parsedChange(role, changes), (change) =>
				compileParsed(artifacts, change, new Set(holding))
			),
			(entry): CompiledVariants => ({ kind: "form", entry, decoder: changes.reads })
		)
	}
	const before = undecided.slice(0, -1)
	return Result.flatMap(changeVariants(role, artifacts, changes, before, holding), (lacking) =>
		Result.map(
			changeVariants(role, artifacts, changes, before, [context, ...holding]),
			(held): CompiledVariants => ({ kind: "split", context, holding: held, lacking })
		)
	)
}

/**
 * A login as its change members compile: its roles' values by their names in the login, in its order, its workloads,
 * the login owned over its base's Owned, and the artifacts its served file compiles over, its base's over every
 * relation.
 */
export interface ChangeLogin {
	readonly roles: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
	readonly workload: ReadonlyArray<unknown>
	readonly owned: OwnedLogin
	readonly artifacts: SchemaArtifacts
}

/**
 * One role of a login with its change members compiled: its value parsed, its owned role, its artifacts over its
 * login's, and each ChangeSet of the login's workloads that runs on it, by the program's name, its variants compiled
 * once.
 */
export interface RoleChanges {
	readonly input: ParsedRole
	readonly owned: OwnedRole
	readonly artifacts: SchemaArtifacts
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

/** One role of `login`, its change members compiled (RoleChanges). */
const roleChanges = (
	name: string,
	value: unknown,
	login: ChangeLogin
): Result.Result<RoleChanges, ChangeRefused> => {
	const refused = (error: CompileError): ChangeRefused => ({
		role: name,
		program: undefined,
		error
	})
	const parsed = loginRole(value, login.owned)
	if (!parsed.ok) {
		return Result.err(refused(parsed.error))
	}
	const { input, owned } = parsed.value
	const artifacts = roleArtifacts(owned, login.artifacts)
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
		const variants = changeVariants(input, artifacts.value, program.value, fill, [])
		if (!variants.ok) {
			return Result.err({ role: name, program: program.name, error: variants.error })
		}
		members.set(program.name, variants.value)
	}
	return Result.ok({ input, owned, artifacts: artifacts.value, members })
}

/**
 * Every role of a login, by its name in the login, in its order, each with the ChangeSets of the login's workloads that
 * run on it compiled once over its artifacts (RoleChanges): what the installation's certification reads and the
 * login's served file projects. A role or program that does not compile is ChangeRefused.
 */
export const loginChanges = (
	login: ChangeLogin
): Result.Result<ReadonlyMap<string, RoleChanges>, ChangeRefused> => {
	const roles = new Map<string, RoleChanges>()
	for (const { name, value } of login.roles) {
		const role = roleChanges(name, value, login)
		if (!role.ok) {
			return role
		}
		roles.set(name, role.value)
	}
	return Result.ok(roles)
}
