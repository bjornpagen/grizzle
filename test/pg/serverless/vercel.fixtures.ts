/** What the properties of vercel.test.ts read: the shop, the recording hook, the spaces and the login template. */

import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import type { Array as Arr } from "effect"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import { noWorkload, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"

import {
	login,
	relation,
	role,
	schema as schemaOf,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { defaultPool, loginTemplate } from "#test/pg/adapter/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { atDeclaredName, installationOf } from "#test/support/kernel/naming.ts"
import { fromEmpty, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * A shop under the schema `name`, its role `app` and the login `worker` that holds it, and the shop's snapshot.json: a
 * layer of the login logs in as `<name>__worker`, the role the substrate creates for the schema.
 */
export const shopUnder = (name: string) => {
	const shop = schemaOf(name, [relation("Item", { id: Id }, ["id"])], [])
	const app = role(shop, "app", wholeEntriesOf(shop))
	/** The shop's snapshot.json, as an import of it yields: what its login's served file is compiled under. */
	const first = succeeded(
		generate({
			declared: noDeclarations,
			installation: installationOf(shop, atDeclaredName),
			name: "shop",
			timestamp: "20261024000000",
			previous: fromEmpty,
			workload: noWorkload
		}),
		"the shop's first migration"
	)
	const snapshot = snapshotJson(
		succeeded(writeRuntimeSnapshot(first.snapshot, first.derived), "the shop's snapshot.json")
	)
	return { app, worker: login(shop, "worker", [app]), snapshot }
}

/**
 * The real attachDatabasePool behind a hook that records every pool it is handed, in order, as an application passes
 * it: each test records its own.
 */
export const recordedAttach = () => {
	const attached: Array<ConnectionPool> = []
	const attach = (pool: ConnectionPool): void => {
		attached.push(pool)
		attachDatabasePool(pool)
	}
	return { attached, attach, onVercelPool: { ...defaultPool, attachPool: attach } }
}

export type VercelEnvFeature = "url and region" | "url only" | "region only" | "neither"

/** A pool on Vercel: its floor and maximum, and the bursts of leases held at once, each released whole. */
export interface PoolCase {
	readonly min: number
	readonly max: number
	readonly bursts: Arr.NonEmptyReadonlyArray<number>
}

export const poolCaseGen: Gen<PoolCase> = (source) => {
	const max = source.draw(int(1, 3))
	const burst = int(1, max)
	return {
		min: source.draw(int(0, max)),
		max,
		bursts: [source.draw(burst), ...source.draw(array(burst, { min: 0, max: 2 }))]
	}
}

export type VercelPoolFeature =
	| "a burst the pool holds at once"
	| "several bursts"
	| "sessions above the floor closed"
	| "a floor of none"
	| "a burst within the floor"

/** VERCEL_URL and VERCEL_REGION, each set or unset. */
export const envGen: Gen<readonly [boolean, boolean]> = (source) =>
	[source.draw(boolean), source.draw(boolean)] as const

/**
 * The login the environment's and the pool's properties lease from, with the pinned role defaults, as a template
 * (adapter/support.ts loginTemplate), made once per member where each search made it before its cases; no case changes
 * the login, and a case counts its backends in its own clone (support.ts roleBackends).
 */
export const vercelLogin = loginTemplate(import.meta, "vercel server")
