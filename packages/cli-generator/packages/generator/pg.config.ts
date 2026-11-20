import { pin } from "@bjornpagen/grizzle-pg/pin"
import { localCluster } from "@bjornpagen/testing/pg"

/**
 * The connections one worker of a full run of the package's properties holds at once on the member: a worker that opens
 * the grizzle tier holds its owner session and the tier's twins, two databases of a live source each, with their
 * sessions; every other worker holds none.
 *
 * @limitKind measured
 * @owner the generator's own cluster (pg.config.ts)
 * @unit connections
 * @scope the client backends one runner worker of `toolchain-test run` in packages/generator holds on the member at once
 * @evidence the member's pg_stat_activity and pg_replication_slots, sampled every 0.2 s as the bootstrap superuser
 *   (~/.cache/grizzle-release/CLUSTERPORT-measure/sample2.sh) through a whole `toolchain-test run` of the package, its
 *   samples, output and machine readings in eocg-full.samples, eocg-full.out and eocg-full.machine there
 * @observed 2026-11-19 04:40:57 to 04:50:31 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, 1-minute load 165 to 250 from other lanes; grizzle's
 *   pinned PostgreSQL build as this cluster made it, at PostgreSQL's default 100 connections; Node 26.13.1
 * @workload every property of the package, 101, on 64 workers, the grizzle tier's twins opened on one of them
 * @result 1,274 samples; at most 8 client backends at once, the sampler's own among them, and 2 walsenders and 2
 *   replication slots; no connection refused
 * @decision 7: the most at once without the sampler, all held by the one worker that opened the twins, which is what
 *   any worker that opens them holds; no headroom, and an instant between two samples is unmeasured
 * @revalidate a "too many clients" refusal in a run; a grizzle property that opens more databases or sessions at once
 */
const connectionsPerWorker = 7

/**
 * The sessions on the member outside any worker, one each: the run's collection in the runner's parent, a doctor's,
 * and an operator's psql.
 */
const outsideSessions = ["the run's collection", "the doctor", "an operator's psql"] as const

/**
 * The generator's local cluster, which the grizzle tier's twins are installed in (test/grizzle/twins.ts) and the
 * runner's layer makes and starts the first time a need reaches it (test.config.ts): on port 5444, run by grizzle's
 * pinned PostgreSQL build (grizzle's scripts/pg/pin.env, which `grizzle-pg build` makes), owned by eocg_dev, who may set
 * deadlock_timeout as grizzle's installation does, its template carrying no extension (the tier's login stores no
 * vector), throwaway, one member, its connections sized for a full run and the rest at PostgreSQL's defaults, which the
 * run's 2 walsenders and 2 replication slots at most (connectionsPerWorker's measurement) hold within their 10 each.
 * `toolchain-pg <command>` from this directory reaches it.
 */
export default localCluster({
	port: 5444,
	bin: { kind: "directory", directory: `${pin.GRIZZLE_PG_PREFIX}/bin` },
	owner: "eocg_dev",
	template: "eocg_template",
	extensions: [],
	ownerParameters: ["deadlock_timeout"],
	peerLogins: [],
	durability: "throwaway",
	sizing: {
		kind: "leased",
		family: { kind: "one" },
		connections: { perWorker: connectionsPerWorker, outside: outsideSessions.length },
		replication: { kind: "default" },
		sharedBuffers: { kind: "default" }
	}
})
