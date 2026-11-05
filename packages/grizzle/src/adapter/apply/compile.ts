import { Result } from "effect"
import { missingExtension } from "#adapter/admission/expectation.ts"
import { type ReadBacks, readBacks } from "#adapter/apply/readback.ts"
import type { RoleContext } from "#adapter/db/context.ts"
import { toResult } from "#adapter/engine.ts"
import { MissingCapability } from "#adapter/errors/failures.ts"
import { type ParamCodecs, paramCodecs } from "#adapter/reader/relations.ts"
import { type StatementNaming, unnamedNaming } from "#adapter/wire/naming.ts"
import type { ViolationClassifier } from "#adapter/witness/classify.ts"
import type { BindContext } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription, unsupported } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { levelSchema, parseSchemaInput } from "#compiler/program/schema.ts"
import { type ParsedChangeSet, parseChangeSet } from "#compiler/write/changeset/value.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"

/**
 * Compiling a ChangeSet for a role.
 *
 * "A ChangeSet is compiled into the same kind of template: its members are queries, its parameters are theirs plus
 * one internal relation parameter per enumerated member". A ChangeSet value is a sealed Description plus the host
 * inputs of its array and Stream members; the Description alone decides the WriteProgram, compiled against the role it
 * compiles for and the contexts the Db's claims hold a fact of, which a write into a query entry fills from
 * (write/frontend/entry.ts), in the transaction evidence context. Every db.apply compiles its ChangeSet: grizzle keeps
 * no cache of programs, and a caller that applies one again keeps its compiled form itself (the workload, db.compile).
 *
 * A program carries what running it needs besides itself: the installed names it was compiled against (a read-back's
 * statements are rebuilt from them, readback.ts) and the installation's violation classifier (packages/grizzle/src/adapter/witness),
 * which decodes an integrity violation a statement or its COMMIT reports into a law and its witness through the
 * installation's key-law map, a superset of the program's own (outcomes/index.ts). The classifier is the layer's,
 * built once per role when the layer was built (pool/registry.ts).
 */
export interface WriteEntry {
	readonly program: CompiledWrite
	/** The fingerprint of the schema the program was compiled against. */
	readonly schema: SchemaFingerprint
	readonly names: WriteNames
	readonly violation: ViolationClassifier
	/** The program's server statements: none for a program compiled for one apply, its own for db.compile's. */
	readonly naming: StatementNaming
	/** The read-backs of each artifact, ready to run, built with the program. */
	readonly readBacks: ReadBacks
	/** The codecs of the program's declared parameters, which its read-backs read, built with the program. */
	readonly codecs: ParamCodecs
	/** What the ChangeSet's reads decoder binds under besides its layout: the role's (db/context.ts RoleContext). */
	readonly bind: BindContext
}

/**
 * A ChangeSet value compiled for this Db: its program entry, and the value itself as applying it reads it, parsed once
 * where it entered.
 */
export interface CompiledChange extends WriteEntry {
	readonly change: ParsedChangeSet
}

/**
 * The parsed ChangeSet of a value, or the refusal of a value that is not one, or of one built over a schema that is no
 * level of the Db's schema (program/schema.ts levelSchema), before any SQL.
 */
const parsedChange = (
	role: RoleContext,
	changes: unknown
): Result.Result<ParsedChangeSet, CompileError> =>
	Result.gen(function* () {
		const change = parseChangeSet(changes)
		if (change === undefined) {
			return yield* Result.fail(
				malformedDescription(
					SourceLoc("db.apply", []),
					"a ChangeSet value built by ChangeSet.empty, union or sequence"
				)
			)
		}
		const carried = yield* toResult(parseSchemaInput(change.schema))
		yield* toResult(levelSchema(carried, role.schema, SourceLoc("db.apply", [])))
		return change
	})

/** The program entry of a ChangeSet for a role, compiled now for the contexts `claims` holds a fact of. */
const writeEntry = (
	role: RoleContext,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Result.Result<WriteEntry, CompileError> => {
	const world = role.artifacts.world
	return Result.map(
		toResult(
			compileWrite(
				world.kind === "role" ? world.checked : role.artifacts.derived.schema,
				change.desc,
				{
					names: role.artifacts.names,
					reads: role.artifacts.reads,
					claims: { kind: "facts", present: claims },
					world: world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
					laws: role.artifacts.laws,
					derived: role.artifacts.derived
				}
			)
		),
		(program): WriteEntry => ({
			program,
			schema: role.artifacts.fingerprint,
			names: role.artifacts.names,
			violation: role.witness.classify,
			naming: unnamedNaming,
			readBacks: readBacks(program, role.artifacts.names.codes),
			codecs: paramCodecs(program.params, role.artifacts.names.codes),
			bind: role.bind
		})
	)
}

/**
 * A ChangeSet value compiled for a role and the contexts `claims` holds a fact of: a Db's apply compiles it for the
 * Db's claims, and the layer a workload's ChangeSet once for each set of its fill contexts. Its program, compiled now,
 * and the value parsed.
 */
export const compiledWrite = (
	role: RoleContext,
	changes: unknown,
	claims: ReadonlySet<string>
): Result.Result<CompiledChange, CompileError> =>
	Result.flatMap(parsedChange(role, changes), (change) =>
		Result.map(writeEntry(role, change, claims), (entry): CompiledChange => ({
			...entry,
			change
		}))
	)

/**
 * The capability a program needs that the admitted database lacks, found after admission and before any of its SQL is
 * sent: an extension its statements name, installed nowhere or in another schema than its compiled names expect.
 */
export const missingCapability = (
	entry: WriteEntry,
	installed: ReadonlyMap<string, string>
): MissingCapability | undefined => {
	const missing = missingExtension(entry.program.requirements, installed)
	return missing === undefined ? undefined : new MissingCapability({ capability: missing })
}

/** A missing capability as the CompileError db.compile's channel carries. */
export const capabilityRefusal = (missing: MissingCapability): CompileError =>
	unsupported(SourceLoc("db.apply", []), missing.capability)
