import { Effect, type Option, Result } from "effect"
import { changeHandle, type ChangeForm } from "#adapter/apply/index.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { changeOps, readOps, refreshOps, rowsOps } from "#adapter/db/db.ts"
import { type CompiledOps, refreshHandle, typedCompiled } from "#adapter/db/ops.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { poolExecutor } from "#adapter/reader/executor.ts"
import { readKeyValues, unreadableArguments } from "#adapter/reader/params.ts"
import { type ReadForm, readHandle, type RowsForm, rowsHandle } from "#adapter/reader/reader.ts"
import type { NonEmptyReadonlyArray, ParamMap } from "#compiler/plan/common.ts"
import type { ServedRefreshTarget } from "#compiler/plan/serve.ts"

/**
 * A ChangeSet of a role's workloads compiled for every set of the contexts its compilation depends on (fillContexts)
 * that may hold a fact: a decision over those contexts, each split by whether the Db's claims hold a fact of it, whose
 * leaves are the forms compiled for the contexts the path holds.
 */
export type ChangeVariants =
	| { readonly kind: "form"; readonly form: ChangeForm<unknown> }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: ChangeVariants
			readonly lacking: ChangeVariants
	  }

/**
 * One program of a login's workloads, compiled once by the layer for one role: a query or ordered query, read for its
 * rows; an ordered query that pages (paged), with its page template; a key, whose lookup query reads by the key's
 * values; or a ChangeSet, compiled for each set of its fill contexts that may hold a fact, since a write into a query
 * entry compiles for the contexts the Db's claims hold (write/frontend/entry.ts).
 */
export type WorkloadForm = { readonly name: string } & (
	| { readonly kind: "read"; readonly form: RowsForm<unknown> }
	| { readonly kind: "paged"; readonly form: ReadForm<unknown> }
	| {
			readonly kind: "key"
			readonly fields: ReadonlyArray<string>
			readonly form: RowsForm<unknown>
	  }
	| { readonly kind: "change"; readonly variants: ChangeVariants }
	| { readonly kind: "refresh"; readonly targets: NonEmptyReadonlyArray<ServedRefreshTarget> }
)

/** A workload program's handle never ends: it lives as long as the layer that compiled it. */
const alwaysLive = (): boolean => true

/** A key's get: the caller's values read once at the boundary (reader/params.ts readKeyValues), then the lookup's get. */
const keyOps = (
	ctx: DbContext,
	fields: ReadonlyArray<string>,
	form: RowsForm<unknown>
): CompiledOps<unknown> => {
	const read = rowsOps(rowsHandle(poolExecutor(ctx), form, alwaysLive))
	return {
		...read,
		get: (values: ParamMap): Effect.Effect<Option.Option<unknown>, ReadError> => {
			const bound = readKeyValues(fields, values, unreadableArguments())
			return Result.isFailure(bound) ? Effect.fail(bound.failure) : read.get(bound.success)
		}
	}
}

/** The form of a ChangeSet a Db runs: the one compiled for the fill contexts the Db's claims hold a fact of. */
const variantOf = (ctx: DbContext, variants: ChangeVariants): ChangeForm<unknown> => {
	switch (variants.kind) {
		case "form":
			return variants.form
		case "split":
			return variantOf(ctx, ctx.claims.has(variants.context) ? variants.holding : variants.lacking)
	}
}

/**
 * The record of a Db's workload handles: each program the layer compiled for the Db's role, under its name, its
 * operations db.compile's (db.ts CompiledOps), run on the Db's pool. A ChangeSet runs its variant for the Db's claims.
 */
export const workloadHandles = (ctx: DbContext, forms: ReadonlyArray<WorkloadForm>): object => {
	const handles: Record<string, object> = {}
	for (const w of forms) {
		switch (w.kind) {
			case "read":
				handles[w.name] = typedCompiled(rowsOps(rowsHandle(poolExecutor(ctx), w.form, alwaysLive)))
				break
			case "paged":
				handles[w.name] = typedCompiled(
					readOps(readHandle(ctx, poolExecutor(ctx), w.form, alwaysLive))
				)
				break
			case "key":
				handles[w.name] = typedCompiled(keyOps(ctx, w.fields, w.form))
				break
			case "change":
				handles[w.name] = typedCompiled(
					changeOps(changeHandle(ctx, variantOf(ctx, w.variants), alwaysLive))
				)
				break
			case "refresh":
				handles[w.name] = refreshHandle(refreshOps(ctx, w.targets))
				break
		}
	}
	return Object.freeze(handles)
}
