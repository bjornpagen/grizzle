import { Array as Arr } from "effect"

/** A test tier: the directories whose tests its Vitest config includes. */
interface Tier {
	readonly roots: ReadonlyArray<string>
}

/**
 * The test tiers. The unit tier (vitest.config.ts) needs no network: the engine's units and the type tier. The network
 * tier (vitest.network.config.ts) talks to the local PostgreSQL cluster: the pg tier and the schedules tier. Each config
 * includes its tier's tests from here.
 */
export const tiers = {
	unit: { roots: ["test/unit/", "test/types/"] },
	network: { roots: ["test/pg/", "test/schedules/"] }
} as const satisfies Readonly<Record<string, Tier>>

/** The files a tier's Vitest config includes: every test under each of its roots. */
export const includeOf = (tier: Tier): ReadonlyArray<string> =>
	Arr.map(tier.roots, (root) => `${root}**/*.test.ts`)
