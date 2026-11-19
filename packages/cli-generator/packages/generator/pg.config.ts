import { pin } from "@bjornpagen/grizzle-pg/pin"
import { localCluster } from "@bjornpagen/testing/pg"

/**
 * The generator's local cluster, which the grizzle tier's twins are installed in (test/grizzle/twins.ts) and the
 * runner's layer makes and starts the first time a need reaches it (test.config.ts): on port 5444, run by grizzle's
 * pinned PostgreSQL build (grizzle's scripts/pg/pin.env, which `grizzle-pg build` makes), owned by eocg_dev, its
 * template carrying no extension (the tier's login stores no vector), throwaway, one member, every count at
 * PostgreSQL's default. `toolchain-pg <command>` from this directory reaches it.
 *
 * The defaults are measured to hold: the member's pg_stat_activity and pg_replication_slots, sampled every 0.2 s as the
 * bootstrap superuser (~/.cache/grizzle-release/CLUSTERPORT-measure/sample2.sh) through a whole `toolchain-test run` of
 * the package (101 properties on 64 workers, 2026-11-19 04:40:57 to 04:50:31 UTC, cassowary at a 1-minute load of 165
 * to 250, its samples in eocg-full.samples there), held at most 8 client backends, 2 walsenders and 2 replication
 * slots at once, against PostgreSQL's 100 connections and 10 of each: the runner opened the tier's twins on one worker,
 * and each worker that opens them holds two twins, a live source each. A run that opens them on more than five workers
 * would run out of slots, and is the measure's revalidation, with a "too many clients" refusal.
 */
export default localCluster({
	port: 5444,
	bin: { kind: "directory", directory: `${pin.GRIZZLE_PG_PREFIX}/bin` },
	owner: "eocg_dev",
	template: "eocg_template",
	extensions: [],
	peerLogins: [],
	durability: "throwaway",
	family: { kind: "one" },
	sizing: {
		connections: { kind: "default" },
		replication: { kind: "default" },
		sharedBuffers: { kind: "default" }
	}
})
