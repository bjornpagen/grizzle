import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	login,
	on,
	pred,
	race,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"

/**
 * den's lease race (README's Races) as the isolation oracle installs it, each a function of its installed name, with its
 * roles and its login `app`. A Step is spawned with its Due instant; a Claim of it is raced at (step, attempt) by a
 * holder the call states, stamped `at` with a `ttl`; a later attempt needs the one before it (pred), and a Finished
 * commit of a step names the Claim it holds. Every claimer names its key, never searching for it.
 *
 * - `leaseShape`, the positive, each role of which generate certifies READ COMMITTED: `spawn(step, at)`;
 *   `claim(step, attempt, holder, at, ttl)`; `claimFenced`, the claim and then the winner's Log, read back at the key
 *   with `holder` the call's own; `reclaim(step, prev, attempt, holder, now, ttl)`, a Claim at `attempt` from the Claim
 *   at `prev` whose `at + ttl` is before `now`; and `commit(step, attempt, holder)`, Finished fenced by its containment
 *   into Claim.
 * - `takeShape`: the claim takes the earliest due Step, a range read of Due a concurrent spawn extends; an `auditor`
 *   copies every Due and every Claim it sees. Forced READ COMMITTED, a take that misses an earlier Due the auditor saw
 *   is a run no serial order explains.
 * - `countShape`: the claim inserts only where no Claim is stored, a count of what it writes: the Claims counted, or 0
 *   by a second rule where none is stored, since an aggregate groups by the other columns of its `find` and over no
 *   matched fact makes no group (README "Queries", aggregate; lower/conservative/group/index.ts). Forced READ
 *   COMMITTED, two claims of two steps both commit.
 * - `unmatchedShape`: the claim races Claim at (step, attempt) and then Logs the Claim at another step, `other`, a read
 *   of another call's row after its write; an `auditor` copies the Claims at both keys. Forced READ COMMITTED, the Log
 *   misses a Claim the auditor saw before the claim committed.
 */
const Instant = contract("Instant", pg.bigint)

const Step = relation("Step", { id: uuid }, ["id"])
const Due = relation("Due", { step: uuid, at: Instant }, ["step"])
const Claim = relation(
	"Claim",
	{ step: uuid, attempt: natural, holder: pg.integer, at: Instant, ttl: pg.bigint },
	["step", "attempt"]
)
const Finished = relation("Finished", { step: uuid, attempt: natural, holder: pg.integer }, [
	"step"
])
const Log = relation("Log", { step: uuid, attempt: natural, holder: pg.integer }, [
	"step",
	"attempt"
])
const Seen = relation("Seen", { step: uuid }, ["step"])
const Took = relation("Took", { step: uuid, attempt: natural }, ["step", "attempt"])

const relations = { Step, Due, Claim, Finished, Log, Seen, Took } as const

/** The lease's schema under `name`: Claim raced, every Claim and Due of a Step, attempts gap-free, a commit's Claim held. */
const leaseSchema = (name: string) =>
	schema(
		name,
		[Step, Due, Claim, Finished, Log, Seen, Took],
		[
			race(Claim),
			contained(on(Claim, "step"), on(Step, "id")),
			contained(on(Due, "step"), on(Step, "id")),
			contained(on(Claim, "step", pred("attempt")), on(Claim, "step", "attempt")),
			contained(on(Finished, "step", "attempt", "holder"), on(Claim, "step", "attempt", "holder"))
		]
	)

type LeaseSchema = ReturnType<typeof leaseSchema>

const spawnerOf = (base: LeaseSchema) =>
	role(base, "spawner", relations, { insert: ["Step", "Due"] })

/** `spawn(step, at)`: a Step and its Due instant. */
const spawnOf = (spawner: ReturnType<typeof spawnerOf>) =>
	ChangeSet.sequence(
		ChangeSet.empty(spawner).insert(
			spawner.relations.Step,
			query(spawner).rule((r) => r.find({ id: r.param("step", uuid) }))
		),
		ChangeSet.empty(spawner).insert(
			spawner.relations.Due,
			query(spawner).rule((r) =>
				r.find({ step: r.param("step", uuid), at: r.param("at", Instant) })
			)
		)
	)

const claimerOf = (base: LeaseSchema) =>
	role(base, "claimer", relations, { insert: ["Claim", "Log"] })
type Claimer = ReturnType<typeof claimerOf>

/** `claim(step, attempt, holder, at, ttl)`: the Claim the call states, raced at its key. */
const claimOf = (claimer: Claimer) =>
	ChangeSet.empty(claimer).insert(
		claimer.relations.Claim,
		query(claimer).rule((r) =>
			r.find({
				step: r.param("step", uuid),
				attempt: r.param("attempt", natural),
				holder: r.param("holder", pg.integer),
				at: r.param("at", Instant),
				ttl: r.param("ttl", pg.bigint)
			})
		)
	)

/** The winner's Log: the Claim at (step, attempt) read back with `holder` the call's own. */
const logMine = (claimer: Claimer) =>
	ChangeSet.empty(claimer).insert(
		claimer.relations.Log,
		query(claimer).rule((r) => {
			const { holder } = v(claimer.relations.Claim, "claim")
			return r
				.match(claimer.relations.Claim, {
					step: r.param("step", uuid),
					attempt: r.param("attempt", natural),
					holder
				})
				.where(r.eq(holder, r.param("holder", pg.integer)))
				.find({ step: r.param("step", uuid), attempt: r.param("attempt", natural), holder })
		})
	)

/** The Log of whichever Claim holds (other, attempt): a read at another key than the one the call raced. */
const logOther = (claimer: Claimer) =>
	ChangeSet.empty(claimer).insert(
		claimer.relations.Log,
		query(claimer).rule((r) => {
			const { holder } = v(claimer.relations.Claim, "claim")
			return r
				.match(claimer.relations.Claim, {
					step: r.param("other", uuid),
					attempt: r.param("attempt", natural),
					holder
				})
				.find({ step: r.param("other", uuid), attempt: r.param("attempt", natural), holder })
		})
	)

export const leaseShape = (name: string) => {
	const base = leaseSchema(name)
	const spawner = spawnerOf(base)
	const claimer = claimerOf(base)
	const committer = role(base, "committer", relations, { insert: ["Finished"] })
	const c = claimer.relations
	const reclaim = ChangeSet.empty(claimer).insert(
		c.Claim,
		query(claimer).rule((r) => {
			const { at, ttl } = v(c.Claim, "before")
			return r
				.match(c.Claim, {
					step: r.param("step", uuid),
					attempt: r.param("prev", natural),
					at,
					ttl
				})
				.where(r.lt(Compute.add(Compute.base(at), ttl), Compute.base(r.param("now", Instant))))
				.find({
					step: r.param("step", uuid),
					attempt: r.param("attempt", natural),
					holder: r.param("holder", pg.integer),
					at: r.param("now", Instant),
					ttl: r.param("ttl", pg.bigint)
				})
		})
	)
	const commit = ChangeSet.empty(committer).insert(
		committer.relations.Finished,
		query(committer).rule((r) =>
			r.find({
				step: r.param("step", uuid),
				attempt: r.param("attempt", natural),
				holder: r.param("holder", pg.integer)
			})
		)
	)
	const workloads = [
		workload(spawner, { spawn: spawnOf(spawner) }),
		workload(claimer, {
			claim: claimOf(claimer),
			claimFenced: ChangeSet.sequence(claimOf(claimer), logMine(claimer)),
			reclaim
		}),
		workload(committer, { commit })
	] as const
	return {
		schema: base,
		roles: { spawner, claimer, committer },
		login: login(base, "app", [spawner, claimer, committer], { workload: workloads })
	}
}

const auditorOf = (base: LeaseSchema) =>
	role(base, "auditor", relations, { insert: ["Seen", "Took"] })

export const takeShape = (name: string) => {
	const base = leaseSchema(name)
	const spawner = spawnerOf(base)
	const claimer = claimerOf(base)
	const auditor = auditorOf(base)
	const c = claimer.relations
	const earliest = query(claimer)
		.rule((r) => {
			const { step, at } = v(c.Due, "due")
			return r
				.match(c.Due, { step, at })
				.where(r.le(at, r.param("now", Instant)))
				.find({ step, at })
		})
		.orderBy(["at", "asc"], ["step", "asc"])
		.take(1)
	const take = ChangeSet.empty(claimer).insert(
		c.Claim,
		query(claimer).rule((r) => {
			const picked = earliest.bind({ now: r.param("now", Instant) })
			const { step } = v(picked, "picked")
			return r.match(picked, { step }).find({
				step,
				attempt: 0n,
				holder: r.param("holder", pg.integer),
				at: r.param("now", Instant),
				ttl: r.param("ttl", pg.bigint)
			})
		})
	)
	const a = auditor.relations
	const audit = ChangeSet.sequence(
		ChangeSet.empty(auditor).insert(
			a.Seen,
			query(auditor).rule((r) => {
				const { step, at } = v(a.Due, "due")
				return r.match(a.Due, { step, at }).find({ step })
			})
		),
		ChangeSet.empty(auditor).insert(
			a.Took,
			query(auditor).rule((r) => {
				const { step, attempt, holder, at, ttl } = v(a.Claim, "claim")
				return r.match(a.Claim, { step, attempt, holder, at, ttl }).find({ step, attempt })
			})
		)
	)
	const workloads = [
		workload(spawner, { spawn: spawnOf(spawner) }),
		workload(claimer, { take }),
		workload(auditor, { audit })
	] as const
	return {
		schema: base,
		roles: { spawner, claimer, auditor },
		login: login(base, "app", [spawner, claimer, auditor], { workload: workloads })
	}
}

export const countShape = (name: string) => {
	const base = leaseSchema(name)
	const spawner = spawnerOf(base)
	const claimer = claimerOf(base)
	const c = claimer.relations
	const claims = query(claimer)
		.rule((r) => {
			const { step, attempt } = v(c.Claim, "claim")
			return r.match(c.Claim, { step, attempt }).find({ n: r.count() })
		})
		.rule((r) => r.where(r.not(c.Claim, {})).find({ n: 0n }))
	const claimAlone = ChangeSet.empty(claimer).insert(
		c.Claim,
		query(claimer).rule((r) => {
			const { n } = v(claims, "claims")
			return r
				.match(claims, { n })
				.where(r.lt(n, 1n))
				.find({
					step: r.param("step", uuid),
					attempt: r.param("attempt", natural),
					holder: r.param("holder", pg.integer),
					at: r.param("at", Instant),
					ttl: r.param("ttl", pg.bigint)
				})
		})
	)
	const workloads = [
		workload(spawner, { spawn: spawnOf(spawner) }),
		workload(claimer, { claimAlone })
	] as const
	return {
		schema: base,
		roles: { spawner, claimer },
		login: login(base, "app", [spawner, claimer], { workload: workloads })
	}
}

export const unmatchedShape = (name: string) => {
	const base = leaseSchema(name)
	const spawner = spawnerOf(base)
	const claimer = claimerOf(base)
	const auditor = auditorOf(base)
	const a = auditor.relations
	const audit = ChangeSet.empty(auditor).insert(
		a.Took,
		query(auditor)
			.rule((r) => {
				const { holder, at, ttl } = v(a.Claim, "claim")
				return r
					.match(a.Claim, {
						step: r.param("step", uuid),
						attempt: r.param("attempt", natural),
						holder,
						at,
						ttl
					})
					.find({ step: r.param("step", uuid), attempt: r.param("attempt", natural) })
			})
			.rule((r) => {
				const { holder, at, ttl } = v(a.Claim, "claim")
				return r
					.match(a.Claim, {
						step: r.param("other", uuid),
						attempt: r.param("attempt", natural),
						holder,
						at,
						ttl
					})
					.find({ step: r.param("other", uuid), attempt: r.param("attempt", natural) })
			})
	)
	const workloads = [
		workload(spawner, { spawn: spawnOf(spawner) }),
		workload(claimer, {
			claim: claimOf(claimer),
			claimOther: ChangeSet.sequence(claimOf(claimer), logOther(claimer))
		}),
		workload(auditor, { audit })
	] as const
	return {
		schema: base,
		roles: { spawner, claimer, auditor },
		login: login(base, "app", [spawner, claimer, auditor], { workload: workloads })
	}
}
