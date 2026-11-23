import type { ChangeForm } from "#adapter/apply/index.ts"
import type { ReadForm, RowsForm } from "#adapter/reader/reader.ts"
import type { ReadCalled } from "#compiler/plan/change.ts"
import type { NonEmptyReadonlyArray } from "#compiler/plan/common.ts"
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
 * rows, its parameters a clocked member binds bound to the database's clock; an ordered query that pages (paged), with
 * its page template; a key, whose lookup query reads by the key's values, each read called as its Description says
 * (engine program/workload/value.ts readCalled), its level generate's to infer (engine core/isolation.ts
 * ReadIsolation): live, or answered
 * at its call's instant alone, as an answered(...) or a clocked member is; or a ChangeSet, compiled for each set of its
 * fill contexts that may hold a fact, since a write into a query entry compiles for the contexts the Db's claims hold
 * (write/frontend/entry.ts).
 */
export type WorkloadForm = { readonly name: string } & (
	| ({ readonly called: ReadCalled } & (
			| { readonly kind: "read"; readonly form: RowsForm<unknown> }
			| { readonly kind: "paged"; readonly form: ReadForm<unknown> }
			| {
					readonly kind: "key"
					readonly fields: ReadonlyArray<string>
					readonly form: RowsForm<unknown>
			  }
	  ))
	| { readonly kind: "change"; readonly variants: ChangeVariants }
	| { readonly kind: "refresh"; readonly targets: NonEmptyReadonlyArray<ServedRefreshTarget> }
)
