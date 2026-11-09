import { Result } from "effect"
import { type ReadBackRuns, readBacks } from "#adapter/apply/readback.ts"
import type { RoleContext } from "#adapter/db/context.ts"
import { toResult } from "#adapter/engine.ts"
import { type ParamCodecs, paramCodecs } from "#adapter/reader/relations.ts"
import type { ViolationClassifier } from "#adapter/witness/classify.ts"
import {
	type CompiledWrite,
	compileWrite,
	parseChangeSet,
	type ParsedChangeSet,
	type WriteNames
} from "#compiler/plan/change.ts"
import {
	type BindContext,
	type CompileError,
	levelSchema,
	malformedDescription,
	parseSchemaInput,
	type SchemaFingerprint,
	SourceLoc
} from "#compiler/plan/common.ts"

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
	/** The read-backs of the program's artifact, ready to run, built with the program. */
	readonly readBacks: ReadBackRuns
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
		const carried = yield* toResult(parseSchemaInput(change.over.value))
		yield* toResult(levelSchema(carried, role.schema, SourceLoc("db.apply", [])))
		return change
	})

/** The program entry of a ChangeSet for a role, compiled now for the contexts `claims` holds a fact of, against the
 * role's artifacts for it (db/context.ts RoleContext.programArtifacts). */
const writeEntry = (
	role: RoleContext,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Result.Result<WriteEntry, CompileError> =>
	Result.flatMap(
		toResult(role.programArtifacts({ kind: "changeSet", changeSet: change.desc })),
		({ artifacts, witness }) => {
			const world = artifacts.world
			return Result.map(
				toResult(
					compileWrite(
						world.kind === "role" ? world.checked : artifacts.derived.schema,
						change.desc,
						{
							names: artifacts.names,
							reads: artifacts.reads,
							claims: { kind: "facts", present: claims },
							world:
								world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
							laws: artifacts.laws,
							derived: artifacts.derived
						}
					)
				),
				(program): WriteEntry => ({
					program,
					schema: artifacts.fingerprint,
					names: artifacts.names,
					violation: witness.classify,
					readBacks: readBacks(program, artifacts.names.codes),
					codecs: paramCodecs(program.params, artifacts.names.codes),
					bind: role.bind
				})
			)
		}
	)

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
