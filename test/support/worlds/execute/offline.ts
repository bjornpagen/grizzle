import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import * as Engine from "#compiler/core/result.ts"
import { type BindResult, bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { type ParsedChangeSet, parseChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
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
 * A bind's result, its failure the host's refusal of the facts: an encoder's, or a CompileError. No input a case draws
 * is past the message bound, so a bound there is the case's own error.
 */
export const withinMessage = (
	bound: ReturnType<typeof bindWrite>
): Engine.Result<BindResult, EncodingFailure | CompileError> => {
	if (bound.ok) {
		return bound
	}
	const failure = bound.error
	if (failure._tag === "LiteralBound" || failure._tag === "MessageBound") {
		throw new Error(`a drawn ChangeSet's input refused as too large: ${failure._tag}`)
	}
	return Engine.err(failure)
}

/**
 * A compiled write's inputs bound as db.apply binds them before any SQL: the ChangeSet's facts collected, normalized
 * and encoded for the program's slots (`withinMessage`).
 */
export const offlineBind = (
	program: CompiledWrite,
	change: ParsedChangeSet
): Effect.Effect<Engine.Result<BindResult, EncodingFailure | CompileError>> =>
	Effect.map(collectInputs(program.binding.groups, change.inputs), (members) =>
		withinMessage(
			bindWrite(runnableWrite(program, program.frontend.codes), {
				members,
				params: {},
				transport: inForce(bindFrame)
			})
		)
	)
