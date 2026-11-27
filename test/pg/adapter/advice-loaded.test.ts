/**
 * Every session grizzle serves loads pg_plan_advice, the planner module that holds each statement it sends to the plan
 * its compile proved, and a session that does not runs nothing (Law 4): without the library PostgreSQL accepts the
 * advice silently and plans, and replans, every statement by its own costs. Each Db transaction's prologue calls the
 * snapshot guard, whose first refusal is a backend that did not load it (55Z04, physical/ddl/ledger.ts adviceLoaded),
 * so a read or a write on such a session fails with AdviceUnloaded before any statement of it runs; `grizzle migrate`
 * refuses such a session in its survey before anything runs, with AdviceUnloaded, and refuses one whose migration role
 * stores its own session_preload_libraries, which leaves the logins' sessions unknown, with MigratorPreloads. The
 * library is read by the modules the backend loaded, never by a setting: a database that sets
 * pg_plan_advice.feedback_warnings with no library loaded reads the placeholder back, and is refused.
 *
 * Each case, on a fresh clone: the database left so for the sessions opened after it (advice-loaded.fixtures.ts
 * stateSql), by its owner, whom the cluster grants session_preload_libraries: loaded as the test cluster loads every
 * session; unloaded, PostgreSQL's empty list; spoofed, unloaded with the setting a setting-reading check takes for the
 * library; or the migration role's own setting in the database naming it. Then, on a session opened after: shopV1's
 * first migration, or one framed read or write behind the real prologue over the real guard (test/support/flight/model.ts
 * fenceSql, prologueIn).
 *
 * Oracle: the specification (advice-loaded.fixtures.ts expectedOf), and what the case left: a refused migration no
 * schema, a refused write no row.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	adviceCases,
	expectedOf,
	leftOf,
	runCase
} from "#test/pg/adapter/advice-loaded.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A session that did not load pg_plan_advice runs nothing: a Db's flight refuses before its first statement, and deploy before anything runs. */
export const aSessionWithoutPlanAdviceRunsNothing = property.exhaust(finite(adviceCases), {
	box: "shopV1's first migration, a framed read and a framed write, each on a fresh clone's session that loaded pg_plan_advice, loaded none, loaded none under a database setting of the library's, or loaded it by the migration role's own setting",
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [],
	check:
		({ substrate }) =>
		(x) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.map(runCase(x), (ran) =>
						assert.deepEqual(ran, { outcome: expectedOf(x), left: leftOf(x) })
					)
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "a read, a write or a first migration on a session that did not load pg_plan_advice, its settings spoofing it or not, refused before anything ran (AdviceUnloaded), a migration whose role stores its own session_preload_libraries refused so (MigratorPreloads), and every other case run whole, as the schema and the rows it left show"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/ledger.ts",
			original: '\t\t\t\t\t\tnot(adviceLoaded("r2")),\n',
			replacement: "\t\t\t\t\t\tnot(lit.bool(true)),\n",
			why: "The snapshot guard skips its loaded check, so a Db's read and write on a session without pg_plan_advice run, every statement planned by PostgreSQL's costs and the advice ignored; the property fails, the flight run."
		},
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original: "\tif (!adviceLoaded) {\n",
			replacement: "\tif (adviceLoaded && !adviceLoaded) {\n",
			why: "grizzle migrate installs into a database whose sessions do not load pg_plan_advice, every routine's advice accepted unparsed and every Db call then refused; the property fails, the migration applied."
		},
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original: "\tif (Arr.isReadonlyArrayNonEmpty(preloads)) {\n",
			replacement: "\tif (Arr.isReadonlyArrayNonEmpty(preloads) && preloads.length < 0) {\n",
			why: "grizzle migrate takes its own session for the logins' though its role's own session_preload_libraries loads the library where no login's settings would; the property fails, the migration applied."
		}
	]
})
