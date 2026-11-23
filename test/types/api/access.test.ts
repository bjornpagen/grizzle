/**
 * The access agreement (test/support/agreement/access.ts): over drawn logins, Db.open needs a token, DbLayer.make a
 * verify, a workload over a role its declared contexts, and a role's query entries its declared contexts, exactly
 * where the engine's reading of the role needs them. Each login is a block of one program a batch checks disarmed. Oracle: the engine's
 * reading of each drawn role. The witnesses reach every place a role reads a context and every probe under both
 * verdicts.
 */
import { accessCases, accessProgram, accessRequired } from "#test/support/agreement/access.ts"
import { agreement } from "#test/types/batch/agreement.ts"

/**
 * Over drawn logins, Db.open needs a token, DbLayer.make a verify, and a workload over a role its contexts exactly as
 * the engine reads the role. Its budget, 60 runs and the runner's 200 steered cases,
 * is the pre-conversion suite's rotating count (60), restored because it costs no more: at TEST_SEED=777, run beside
 * the runner's default of 150, the whole run's process tree took 74.9 CPU-s against 131.4, every situation reached and
 * every kill killed alike (budgets/access.*.txt) (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets,
 * 2026-11-16, load 470 to 670).
 */
export const access = agreement(accessCases, {
	budget: { runs: 60, steered: 200 },
	situations: accessRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: accessProgram,
	oracle: { kind: "second-implementation", name: "the engine's reading of each drawn role" },
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/types/db.ts",
			original:
				"\tReadsToken<R> extends true ? { readonly token: string } : { readonly token?: string }",
			replacement:
				"\tReadsToken<R> extends true ? { readonly token?: string } : { readonly token?: string }",
			why: "Db.open takes no token for a role that reads a token's context (adapter/types/db.ts TokenOptions); the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original:
				"export type DeclaredContexts<C> = C extends ReadonlyArray<infer X> ? NameOf<X> : never\n",
			replacement:
				"export type DeclaredContexts<C> = C extends ReadonlyArray<infer X> ? never : never\n",
			why: "a role's type declares no context: a program over a full role matching a context it declares, which the engine compiles, is refused."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original: "type EntryContextsWithin<Cx, Declared> = [Cx] extends [Declared]\n",
			replacement: "type EntryContextsWithin<Cx, Declared> = [Cx] extends [Cx]\n",
			why: "a role's type admits a query entry matching a context it does not declare, which role(...) refuses (entryContext): the stray role typechecks."
		},
		{
			file: "packages/engine/src/schema/world.ts",
			original:
				"\t\tconst contextBreak = entryContextBreak(contexts, queryUses(e.query).contexts)\n",
			replacement: "\t\tconst contextBreak = entryContextBreak(contexts, new Map())\n",
			why: "role(...) admits a query entry matching a context the role does not declare, which its type refuses: the stray role builds."
		},
		{
			file: "packages/engine/src/schema/own.ts",
			original:
				"\tfor (const c of [...desc.contexts].toSorted((a, b) => compareStrings(a.name, b.name))) {\n",
			replacement:
				"\tfor (const c of [...desc.contexts].slice(1).toSorted((a, b) => compareStrings(a.name, b.name))) {\n",
			why: "the owned role drops its first declared context from what its Db holds: a program over the base matching it, which the full role's type admits, is OutsideRole."
		}
	]
})
