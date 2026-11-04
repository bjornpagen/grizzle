import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { recordsetMaxRows } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import { type ParsedChangeSet, parseChangeSet } from "#compiler/write/changeset/value.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"

/** A ChangeSet value as db.apply parses it where it enters: one the builders made always parses. */
export const parsedChange = (changes: unknown): ParsedChangeSet =>
	defined(parseChangeSet(changes), "a ChangeSet value the builders made parses as one")

/**
 * The program of a ChangeSet compiled for a Db of a role under the contexts its claims hold a fact of, with no
 * PostgreSQL, as adapter/apply/compile.ts writeEntry compiles it: against the role's artifacts (the declared schema's
 * own names), in the role's world. Its refusal is the CompileError db.apply raises before any SQL.
 */
export const offlineCompile = (
	role: BuiltRole,
	change: ParsedChangeSet,
	claims: ReadonlySet<string>
): Engine.Result<CompiledWrite, CompileError> => {
	const artifacts = succeeded(testArtifacts(role, testCompile), "the role's artifacts")
	const world = artifacts.world
	if (world.kind !== "role") {
		return assert.fail("a role's artifacts hold its world")
	}
	return compileWrite(world.checked, change.desc, {
		names: artifacts.names,
		reads: artifacts.reads,
		claims: { kind: "facts", present: claims },
		world: { kind: "role", names: world.names },
		laws: artifacts.laws,
		derived: artifacts.derived
	})
}

/**
 * A compiled write's inputs bound as db.apply binds them before any SQL: the ChangeSet's facts collected, normalized
 * and encoded for the program's slots. Its failure is the host's refusal of the facts: an encoder's, an input past its
 * bound, or a CompileError.
 */
export const offlineBind = (
	program: CompiledWrite,
	change: ParsedChangeSet
): Effect.Effect<ReturnType<typeof bindWrite>> =>
	Effect.map(
		Effect.orDie(collectInputs(program.frontend, change.inputs, recordsetMaxRows)),
		(members) => bindWrite(program, { members, params: {} })
	)
