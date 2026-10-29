import { Array as Arr, Effect, Option, Result } from "effect"
import {
	changeFormMissing,
	changeHandle,
	type ChangeForm,
	compileChangeForm
} from "#adapter/apply/index.ts"
import type { DbContext, RoleContext } from "#adapter/db/context.ts"
import { type CompiledOps, changeOps, readOps, typedCompiled } from "#adapter/db/db.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { readParams, unreadableArguments } from "#adapter/reader/params.ts"
import {
	compileReadForm,
	poolExecutor,
	type ReadForm,
	readFormMissing,
	readHandle
} from "#adapter/reader/reader.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { levelSchema } from "#compiler/program/schema.ts"
import { workloadState } from "#compiler/program/workload/value.ts"
import { keyQuery } from "#compiler/query/build/key.ts"
import type { OwnedRole } from "#compiler/schema/own.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import type { ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { fillContexts } from "#compiler/write/frontend/entry.ts"

/**
 * A ChangeSet of a role's workloads compiled for every set of the contexts its compilation depends on (fillContexts)
 * that may hold a fact: a decision over those contexts, each split by whether the Db's claims hold a fact of it, whose
 * leaves are the forms compiled for the contexts the path holds.
 */
type ChangeVariants =
	| { readonly kind: "form"; readonly form: ChangeForm<unknown> }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: ChangeVariants
			readonly lacking: ChangeVariants
	  }

/**
 * One program of a login's workloads, compiled once by the layer for one role: a query or ordered query, a key, whose
 * lookup query reads by the key's values, or a ChangeSet, compiled for each set of its fill contexts that may hold a
 * fact, since a write into a query entry compiles for the contexts the Db's claims hold (write/frontend/entry.ts).
 */
export type WorkloadForm = { readonly name: string } & (
	| { readonly kind: "read"; readonly form: ReadForm<unknown> }
	| {
			readonly kind: "key"
			readonly fields: ReadonlyArray<string>
			readonly form: ReadForm<unknown>
	  }
	| { readonly kind: "change"; readonly variants: ChangeVariants }
)

const loc = SourceLoc("DbLayer.make", [])

/**
 * The variants of `changes` over the fill contexts `undecided`, the contexts after them already decided to hold or
 * lack a fact, `holding` those that hold one, in the fill contexts' order. The last undecided context splits first and
 * each split compiles its lacking side first, so the forms compile in the order of the subsets of the fill contexts
 * counted with the first context as the lowest digit.
 */
const changeVariants = (
	role: RoleContext,
	changes: ChangeSetValue,
	undecided: ReadonlyArray<string>,
	holding: ReadonlyArray<string>
): Result.Result<ChangeVariants, CompileError> => {
	if (!Arr.isReadonlyArrayNonEmpty(undecided)) {
		return Result.map(
			compileChangeForm(role, changes, changes.reads, new Set(holding)),
			(form): ChangeVariants => ({ kind: "form", form })
		)
	}
	const context = Arr.lastNonEmpty(undecided)
	const before = Arr.initNonEmpty(undecided)
	return Result.gen(function* () {
		const lacking = yield* changeVariants(role, changes, before, holding)
		const held = yield* changeVariants(role, changes, before, [context, ...holding])
		return { kind: "split", context, holding: held, lacking }
	})
}

/**
 * The workload of a role: every program of the login's workloads over the role or a level of it, compiled once for the
 * role (the workloads' order, each one's programs in its record's order). A workload over a role is the role's own; a
 * workload over the base or a level of it runs on a full role, whose levels hold the base (program/schema.ts
 * levelSchema), and on no partial one. A program that does not compile for the role is its CompileError, which fails
 * the layer, and so is a workload value no workload(...) built: the login's workloads are the DbConfig's, read here.
 */
export const compileRoleWorkload = (
	role: RoleContext,
	owned: OwnedRole,
	workloads: ReadonlyArray<AnyWorkload>
): Result.Result<ReadonlyArray<WorkloadForm>, CompileError> =>
	Result.gen(function* () {
		const forms: Array<WorkloadForm> = []
		for (const workload of workloads) {
			const state = workloadState(workload)
			if (state === undefined) {
				return yield* Result.fail(malformedDescription(loc, "a workload built by workload(...)"))
			}
			const over = state.schema
			const runs =
				over.kind === "role"
					? over.value === role.schema.value
					: levelSchema(over, role.schema, loc).ok
			if (!runs) {
				continue
			}
			for (const program of state.programs) {
				switch (program.kind) {
					case "query":
					case "ordered": {
						const query = program.value
						const form = yield* compileReadForm(role, query, () => query.rows)
						forms.push({ name: program.name, kind: "read", form })
						break
					}
					case "key": {
						const target = program.target
						const fact = target.relation.fact
						const form = yield* compileReadForm(
							role,
							keyQuery(role.schema.value, target),
							() => fact
						)
						forms.push({ name: program.name, kind: "key", fields: target.fields, form })
						break
					}
					case "changeSet": {
						const fill = fillContexts(owned.writes, program.desc.changeSet)
						const variants = yield* changeVariants(role, program.value, fill, [])
						forms.push({ name: program.name, kind: "change", variants })
						break
					}
				}
			}
		}
		return forms
	})

/** A workload program's handle never ends: it lives as long as the layer that compiled it. */
const alwaysLive = (): boolean => true

/** The forms of a ChangeSet's variants, its leaves in compilation order. */
const variantForms = (variants: ChangeVariants): ReadonlyArray<ChangeForm<unknown>> =>
	variants.kind === "form"
		? [variants.form]
		: [...variantForms(variants.lacking), ...variantForms(variants.holding)]

/**
 * The capability a role's workload needs that the admitted database lacks, if any: an extension a program's statements
 * name, installed nowhere or in another schema than its compiled names expect. Db.open checks it after admission, so a
 * handle never meets it.
 */
export const workloadMissing = (
	forms: ReadonlyArray<WorkloadForm>,
	installed: ReadonlyMap<string, string>
): Option.Option<string> => {
	for (const w of forms) {
		const missing =
			w.kind === "change"
				? Arr.map(variantForms(w.variants), (form) => changeFormMissing(form, installed))
				: [readFormMissing(w.form, installed)]
		for (const m of missing) {
			if (m !== undefined) {
				return Option.some(m)
			}
		}
	}
	return Option.none()
}

/** A key's get: the caller's values read once at the boundary (reader/params.ts readParams), then the lookup's get. */
const keyOps = (
	ctx: DbContext,
	fields: ReadonlyArray<string>,
	form: ReadForm<unknown>
): CompiledOps<unknown> => {
	const read = readOps(readHandle(ctx, poolExecutor(ctx), form, alwaysLive))
	return {
		...read,
		get: (values: ParamMap): Effect.Effect<Option.Option<unknown>, ReadError> => {
			const bound = readParams(fields, values, unreadableArguments())
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
 * operations db.compile's (db.ts CompiledOps), run on the Db's pool through the program's server statements, named
 * from their texts and kept for the pool's life. A ChangeSet runs its variant for the Db's claims.
 */
export const workloadHandles = (ctx: DbContext, forms: ReadonlyArray<WorkloadForm>): object => {
	const handles: Record<string, object> = {}
	for (const w of forms) {
		switch (w.kind) {
			case "read":
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
		}
	}
	return Object.freeze(handles)
}
