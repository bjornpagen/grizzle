/** What the properties of random.test.ts read: its guide files and what its programs reach by construction. */
import type { Situations } from "@bjornpagen/testing/features"
import { Array as Arr } from "effect"
import { drawnNameFeatures } from "#test/support/worlds/generate/names.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

export const guide: Arr.NonEmptyReadonlyArray<string> = [
	"packages/engine/src/schema/world.ts",
	"packages/engine/src/physical/ddl/roles.ts",
	"packages/grizzle/src/adapter/db/claims.ts",
	"packages/grizzle/src/adapter/db/open.ts",
	"packages/grizzle/src/adapter/admission/drift.ts",
	"packages/grizzle/src/adapter/admission/roles.ts",
	"packages/engine/src/write/entry/precheck.ts"
]

/**
 * What every population of random programs reaches by construction: each invariant the driver holds whose triggering
 * actions the swarm draws in nearly every program (an open, a write, a commit, a migration, a catalog change, a Db's
 * transaction, a delete); each feature of the names a generated installation draws from the kernel dictionary
 * (generate/names.ts), each in at least one case in eight; and a base object or a role entry named after a PostgreSQL
 * type under the installation's schemas first on its owner's search path, about one case in five. Left out:
 * no-hidden-value, which needs an action to meet a fact outside the actor's world, as the reality and the actor happen
 * to give it (once to thrice in 48 cases of the model's own run of the suite), and is the errors suite's to require.
 */
export const situations: Situations<WorldFeature> = [
	["grizzle-first path", "catalog-type name"],
	...Arr.map(drawnNameFeatures, (feature): WorldFeature => `name:${feature}`),
	"invariant:laws-hold",
	"invariant:claims-end-with-transaction",
	"invariant:role-ends-with-transaction",
	"invariant:login-isolation",
	"invariant:deleted-means-gone",
	"invariant:least-privilege"
]

/** The program steps a case runs at most after its lead. */
export const steps = 12
