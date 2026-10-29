import { layer } from "@effect/vitest"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	callPastAMigration,
	docsInstalls,
	drawnRealities,
	type Focus,
	invalidFeatures,
	noCheck,
	programTests,
	type Realize
} from "#test/support/worlds/drive/suite.ts"
import { realizeRace } from "#test/support/worlds/execute/index.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Claims never cross requests on a pooled connection: every login's pool holds one connection, so every Db of a login,
 * whatever its role and claims, runs its transactions on that one connection. Programs interleave Dbs of the roles of
 * one login (the documents installation's signed-out reader and signed-in member, and drawn installations), with
 * their reads and writes ending every way a transaction can: committed, no change, invariant-rejected, outside the
 * world, refused by the compiler, or refused by the fence of a Db a migration moved past. After every action the
 * driver probes each open session's connection: between transactions the pooled connection is idle as the login,
 * holding no role and no claims, exactly as the worlds model expects. Its programs are serial, so no call is in flight
 * when an interrupt comes: the connection after a call interrupted mid-flight is the race suite's
 * (test/schedules/worlds/pooled-roles.test.ts). Its focus holds no direct writer, so a statement after a refused one
 * (invalid:session:after-refusal) is the inductive suite's, whose drawn states hold a direct transaction a refusal
 * aborted (pg/world-model/inductive).
 */
const pooled: Focus = [
	"open-db",
	"read",
	"apply",
	"close",
	"interrupt",
	"refresh",
	"wild",
	"migrate"
]

const onePool: Realize = (install) => realizeRace(install, 1)

/**
 * What a pooled connection shows after each way a transaction ends. While the read of a Db a migration moved past is
 * pending, the suite's lead opens a Db, migrates past it and reads through it (callPastAMigration): a program's own
 * draws seldom take those three moves in that order.
 */
const required: ReadonlyArray<WorldFeature> = [
	"connection:shared-by-roles",
	"connection:after-commit",
	"connection:after-no-change",
	"connection:after-invariant-rejected",
	"connection:after-outside-world",
	"connection:after-compile-refused",
	"connection:after-stale-snapshot",
	...invalidFeatures(["token:stale:previous-request", "handle:closed-db", "session:interrupted"])
]

layer(Substrate.layer, { excludeTestServices: true })(
	"the worlds model: pooled connections",
	(it) => {
		programTests(it, {
			suite: "pg/world-model/pool",
			name: "claims and role never cross requests on a pooled connection, however a transaction ends",
			installs: docsInstalls,
			realize: onePool,
			focus: pooled,
			steps: 10,
			cases: 40,
			required,
			realities: drawnRealities,
			lead: callPastAMigration(required),
			check: noCheck
		})
	}
)
