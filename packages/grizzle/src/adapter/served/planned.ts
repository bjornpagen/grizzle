/**
 * The bound of the pg_stat_statements entries one call of each program of a login makes, under the installation its
 * snapshot records (engine program/planned.ts): each role's read members by their statements' forms, each change member
 * by the most entries a call of any of its variants makes. A login's test reads it beside the served file its compile
 * projects (public/compile.ts plannedQueriesOf), as it reads the compile, never recomputing what generate planned.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	dedupeNonEmpty,
	extendNonEmpty,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import { Array as Arr, Order } from "effect"
import type { SnapshotCompiled } from "#adapter/served/compile.ts"
import { servableRoles, variantsEntries } from "#compiler/plan/change.ts"
import type { SqlStatement } from "#compiler/plan/common.ts"
import {
	enterQuery,
	type PlannedCall,
	type PlannedQueries,
	plannedQueries,
	readCall,
	writeCall
} from "#compiler/plan/migration.ts"
import type { CompiledTemplate } from "#compiler/plan/read.ts"

export type { PlannedQueries } from "#compiler/plan/migration.ts"

/** Each role of a login, by its name, each member of its workload by its name with its bound (PlannedQueries). */
export type PlannedLogin = ReadonlyMap<string, ReadonlyMap<string, PlannedQueries>>

/** Every form of a read template's statement: its own, and its whole-relation form where a choice picks one. */
const statementsOf = (compiled: CompiledTemplate): ReadonlyArray<SqlStatement> => {
	const statement = compiled.template.run.statement
	return statement.forms.kind === "chosen"
		? [statement.ast, statement.forms.large.statement.ast]
		: [statement.ast]
}

/** The greater of two bounds: a declared function's on either side, every such function of both, is no bound. */
const greater = (a: PlannedQueries, b: PlannedQueries): PlannedQueries => {
	if (a.kind === "declared") {
		return b.kind === "declared"
			? {
					kind: "declared",
					functions: sortNonEmpty(
						dedupeNonEmpty(extendNonEmpty(a.functions, b.functions)),
						Order.String
					)
				}
			: a
	}
	if (b.kind === "declared") {
		return b
	}
	return a.queries >= b.queries ? a : b
}

/**
 * The bound of each program of `compiled`, a login compiled under its snapshot alone (served/compile.ts
 * snapshotCompiled), by role and member: a read's one statement, each of its forms reached; a paged read's bound and
 * page statements, a call sending either; a change member's greatest over its variants.
 */
export const plannedLogin = (compiled: SnapshotCompiled): PlannedLogin => {
	const graph = compiled.snapshot.derived.planned
	const changes = servableRoles(compiled.changes)
	return new Map(
		Arr.map(compiled.roles, (role) => {
			const prologue = enterQuery(role.artifacts.names.schema)
			const bound = (call: PlannedCall): PlannedQueries => plannedQueries(graph, prologue, call)
			const members = changes.get(role.role.name)?.members
			const planned = Arr.map(role.workload, (form): readonly [string, PlannedQueries] => {
				switch (form.kind) {
					case "read":
					case "key":
						return [form.name, bound(readCall(statementsOf(form.form.bound.compiled.compiled), 1))]
					case "paged":
						return [
							form.name,
							bound(
								readCall(
									[
										...statementsOf(form.form.bound.compiled.compiled),
										...statementsOf(form.form.page.compiled)
									],
									2
								)
							)
						]
					case "change": {
						const variants = defined(
							members?.get(form.name),
							`the compiled variants of change member ${form.name}`
						)
						const [first, ...rest] = variantsEntries(variants)
						const head = defined(first, `a variant of change member ${form.name}`)
						return [
							form.name,
							Arr.reduce(rest, bound(writeCall(head.compiled)), (most, entry) =>
								greater(most, bound(writeCall(entry.compiled)))
							)
						]
					}
				}
			})
			return [role.role.name, new Map(planned)] as const
		})
	)
}
