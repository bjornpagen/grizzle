import { Array as Arr, Data, Effect, Result } from "effect"
import { changeCall } from "#adapter/apply/collect.ts"
import { hostInputs, inputApplyError, runWrite } from "#adapter/apply/run.ts"
import { dbChangeFrame, type ServedDbContext } from "#adapter/db/context.ts"
import { fromEngine } from "#adapter/engine.ts"
import { type ApplyError, ExecutionFailure, TransportFailure } from "#adapter/errors/execution.ts"
import { applyOutcome } from "#adapter/outcomes/index.ts"
import { boundReads, type CompiledEntry } from "#adapter/served/forms.ts"
import { artifactsOver, builtLogin, loginRoles, ownLoginOver } from "#adapter/served/login.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	Engine,
	levelChain,
	noParamContracts,
	ownBuilt,
	type RowDecoder
} from "#compiler/plan/common.ts"
import { everySlice, planBasis, servedSnapshot } from "#compiler/plan/serve.ts"
import type { AnyLoginRole } from "#compiler/types/schema/world.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"

/**
 * A role's compilation context as the one compile `grizzle generate` commits reads it, for the suites that compile a
 * program at run time and run its compiled form on a served Db (the write oracle's optimized and conservative
 * realizations): what a served Db never holds, since it runs only the programs its served file carries.
 *
 * A role whose login no login(...) built, or that its login does not hold, is a defect of the suite's setup.
 */
export class RoleSetupError extends Data.TaggedError("RoleSetupError")<{ readonly what: string }> {}

/**
 * `role` as the one compile `grizzle generate` commits reads it (adapter/served/compile.ts snapshotServedEntry): its
 * login's base owned, the snapshot `installed` reached read over the base's level as that compile reads it, the
 * installation's artifacts planned from what the snapshot records over every relation, and the login's roles compiled
 * over them (adapter/served/login.ts loginRoles), its own workload left out.
 */
export const servedRoleContext = (
	installed: Installed,
	role: AnyLoginRole
): Effect.Effect<RoleContext, CompileError | RoleSetupError> =>
	Effect.gen(function* () {
		const login = builtLogin(role.login)
		if (login === undefined) {
			return yield* new RoleSetupError({ what: "a role of no login login(...) built" })
		}
		const base = yield* fromEngine(ownBuilt(login.base))
		const owned = yield* fromEngine(ownLoginOver(login, base))
		const snapshot = yield* fromEngine(
			servedSnapshot(
				snapshotValue(installed.snapshot, installed.installation),
				levelChain(login.base.desc).length - 1
			)
		)
		const slice = everySlice(owned.base)
		const artifacts = yield* fromEngine(
			Engine.flatMap(
				planBasis(
					owned.base,
					snapshot.codes,
					slice,
					snapshot.derived.closed,
					snapshot.derived.textDomains,
					{
						kind: "recorded",
						cycles: snapshot.derived.fkCycles,
						references: snapshot.derived.references
					}
				),
				(basis) => artifactsOver(basis, noParamContracts)
			)
		)
		const roles = yield* Effect.mapError(
			loginRoles(
				{ ...login, workload: [] },
				owned,
				{ slice, artifacts, over: () => Engine.ok(artifacts) },
				lawsAbove(snapshot)
			),
			(refused) => refused.error
		)
		const found = Arr.findFirst(roles, (r) => r.role.name === role.role.name)
		return found._tag === "Some"
			? found.value
			: yield* new RoleSetupError({ what: `the login holds no role ${role.role.name}` })
	})

/**
 * One application of a compiled ChangeSet on a served Db's context, its read-backs decoded by `decoder`: its inputs
 * readied on the host, a same-key pair the host already refuses answered as invariant-rejected before any SQL, else its
 * one transaction on a session of the Db's pool, as a served change member's once runs its loaded entry
 * (adapter/db/handles.ts changeApplication). The write oracle runs its optimized and conservative realizations through
 * it, each compiled at run time.
 */
export const runEntry = <R>(
	ctx: ServedDbContext,
	entry: CompiledEntry,
	params: unknown,
	decoder: RowDecoder<R>
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.gen(function* () {
		const reads = boundReads(entry, decoder)
		if (Result.isFailure(reads)) {
			return yield* new ExecutionFailure({ reason: reads.failure })
		}
		const inputs = yield* Effect.mapError(
			Effect.flatMap(changeCall(entry, params), (call) => hostInputs(entry, call)),
			inputApplyError
		)
		if (inputs.kind === "rejected") {
			return applyOutcome.invariantRejected(
				{ kind: "every", laws: [inputs.refused] },
				inputs.witness
			)
		}
		return yield* Effect.scoped(
			Effect.flatMap(
				Effect.mapError(ctx.pool.lease, (reason) => new TransportFailure({ reason })),
				(session) =>
					runWrite(
						session,
						dbChangeFrame(ctx, entry.program.flight.exclusion),
						entry,
						inputs,
						reads.success
					)
			)
		)
	})
