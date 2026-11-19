/** What the properties of pool.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import { type Focus, invalidFeatures } from "#test/support/worlds/drive/suite.ts"
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
export const pooled: Focus = [
	"open-db",
	"read",
	"apply",
	"close",
	"interrupt",
	"refresh",
	"wild",
	"migrate"
]

/**
 * What a pooled connection shows after each way a transaction ends. While the read of a Db a migration moved past is
 * pending, the suite's lead opens a Db, migrates past it and reads through it (callPastAMigration): a program's own
 * draws seldom take those three moves in that order.
 */
export const required: Situations<WorldFeature> = [
	"connection:shared-by-roles",
	"connection:after-commit",
	"connection:after-no-change",
	"connection:after-invariant-rejected",
	"connection:after-outside-world",
	"connection:after-compile-refused",
	"connection:after-stale-snapshot",
	...invalidFeatures(["token:stale:previous-request", "handle:closed-db", "session:interrupted"])
]
