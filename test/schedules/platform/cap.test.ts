/**
 * Usage against a spend cap: two to four requests of one workspace in one month, each recorded by its own writer, whose
 * charges together cross the workspace's cap, with the workspace's caps changed while they race.
 *
 * Each request is priced from the platform as the application read it before the race, and the cap law
 * (spendWithinCap) and the containment of every charge in its month's cap decide which are recorded; the harness's
 * oracle explains every outcome by them in some serial order. The caps are the platform's one mutable relation, changed
 * two ways: the fixture's setCap, a put that changes the month's cap in place, and setCaps, one MERGE that puts the
 * months given and removes the workspace's other months, a deletion under the scope it proves (the workspace's caps
 * whose key the given caps do not hold). The workspace holds a cap for a second month too, so a MERGE that keeps one
 * month removes the other: the second month, which nothing spends in, or the race's month, which the requests' charges
 * are contained in, so the MERGE and every request then refuse each other, whichever is second.
 *
 * The swarm adds spend recorded before the race, a cap put, a caps MERGE (keeping both months, removing the second, or
 * removing the spent one), and a request submitted twice by two writers (its keys make the second no-change or refused,
 * never a second charge).
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): laws-le-strict.patch.
 */

import { array, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { fullSwarm, keep, type Swarm, swarm } from "@grizzle/testing/swarm"
import { Array as Arr, Option } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import {
	beforeOf,
	committedOf,
	commonRequired,
	type ExplainedRun,
	explainedIds,
	type Race,
	type RaceFeature,
	raceSuite,
	raceTxns,
	ranOf,
	type WriterChoice,
	writersGen
} from "#test/schedules/platform/support.ts"
import * as W from "#test/schedules/platform/world.ts"
import { defined } from "#test/support/assert.ts"
import { JAN } from "#test/support/platform/generate.ts"
import { platformSpan } from "#test/support/platform/model.ts"

const opFeatures = ["prior spend", "cap put", "caps merge", "duplicate"] as const
type OpFeature = (typeof opFeatures)[number]

/**
 * Which months a caps MERGE keeps: both (the race's month's cap changed), the race's month only, or the second only.
 */
const merges = ["both months", "the race's month", "the second month"] as const
type Merge = (typeof merges)[number]

interface CapSketch {
	/** Each request's charge, 1 to maxCharge micro-dollars. */
	readonly charges: ReadonlyArray<number>
	/** The cap: what the workspace spent before the race plus this, below the requests' total. */
	readonly cap: number
	/** What the workspace spent before the race when the swarm keeps prior spend, 1 to maxPrior. */
	readonly prior: number
	/** The cap a cap change sets: what was spent before plus this, up to the requests' total. */
	readonly capTo: number
	readonly merge: Merge
	readonly ops: Swarm<OpFeature>
	readonly writers: ReadonlyArray<WriterChoice>
}

const maxCharge = 60
const maxPrior = 30
/** The second month's cap, which no request spends against. */
const secondCap = 1_000n

const anyCapSketchGen: Gen<CapSketch> = (source) => {
	const charges = source.draw(array(int(1, maxCharge), { min: 2, max: 4 }))
	const total = Arr.reduce(charges, 0, (a, b) => a + b)
	return {
		charges,
		cap: source.draw(int(0, total - 1)),
		prior: source.draw(int(1, maxPrior)),
		capTo: source.draw(int(0, total)),
		merge: source.draw(element(merges)),
		ops: source.draw(swarm(opFeatures)),
		writers: source.draw(writersGen)
	}
}

/** A race whose caps merge keeps `merge`, with every op on. */
const mergeArm = (merge: Merge): Gen<CapSketch> =>
	map(anyCapSketchGen, (k): CapSketch => ({ ...k, merge, ops: fullSwarm(opFeatures) }))

/**
 * A race's sketch: any, or one in six each a caps merge with every op on, one arm per merge (`merges`): both months,
 * the race's month's cap changed under the requests; only the race's month, which removes the second month, nothing
 * spent in it, under the requests; and only the second month, so a request can meet the month a merge removed. Each
 * merge is an arm of its own, a sixth of the cases, so the label-fixed floor and steered streams reach every one: left
 * to the any arm, which must also keep the merge op in its swarm, the race's month came to about one case in nine, and
 * the floor's 10 cases and the steered phase's 40 missed it.
 */
const capSketchGen: Gen<CapSketch> = weighted([
	[3, anyCapSketchGen],
	...Arr.map(merges, (merge) => [1, mergeArm(merge)] as const)
])

/** Request n's window: a minute apart, each half a minute long, inside the month. */
const windowOf = (n: number) => platformSpan(JAN + 60n * BigInt(n), JAN + 60n * BigInt(n) + 30n)

const resolveCap =
	(k: CapSketch): Gen<Race> =>
	(source) => {
		const on = (feature: OpFeature): boolean => source.draw(keep(k.ops, feature))
		const charges = Arr.map(k.charges, (c) => BigInt(c))
		const prior = on("prior spend") ? BigInt(k.prior) : 0n
		const cap = prior + BigInt(k.cap)
		const base = W.withNextMonth(W.world(cap), secondCap)
		const initial =
			prior === 0n
				? base
				: W.withUsage(base, W.recordOf(base, new Map(), W.request(0, windowOf(0), prior)))
		const priced = Arr.map(charges, (charge, i) => ({
			charge,
			record: W.recordOf(initial, new Map(), W.request(i + 1, windowOf(i + 1), charge))
		}))
		const first = defined(priced[0], "the first request")
		const duplicate = on("duplicate")
		/** The last request submits the first one's record again, when the swarm keeps a duplicate. */
		const requests = Arr.map(priced, (q, i) => (duplicate && i === priced.length - 1 ? first : q))
		const capTo = prior + BigInt(k.capTo)
		const read = [W.limitOf(cap), W.limitIn(W.nextMonth, secondCap)]
		const kept = {
			"both months": [W.limitOf(capTo), W.limitIn(W.nextMonth, secondCap)],
			"the race's month": [W.limitOf(capTo)],
			"the second month": [W.limitIn(W.nextMonth, secondCap)]
		}[k.merge]
		const changes = [
			...(on("cap put") ? [W.capWrite(cap, capTo)] : []),
			...(on("caps merge") ? [W.capsMergeWrite(`caps merge keeping ${k.merge}`, read, kept)] : [])
		]
		const writes = [
			...changes,
			...Arr.map(requests, (q, i) =>
				W.usageWrite(
					duplicate && i === requests.length - 1 ? "usage again" : "usage",
					q.record,
					`request ${i + 1} of ${q.charge}`
				)
			)
		]
		const requestAt = (id: number) =>
			id < changes.length ? undefined : requests[id - changes.length]
		return {
			initial,
			txns: raceTxns(k.writers, writes),
			judge: (e) => judgeCap(e, requestAt, changes.length)
		}
	}

/** What the explained order reached; every outcome the laws decide, the oracle has explained. */
const judgeCap = (
	e: ExplainedRun,
	requestAt: (id: number) => { readonly charge: bigint } | undefined,
	changes: number
): { readonly departure: string | undefined; readonly reached: ReadonlyArray<RaceFeature> } => {
	const reached: Array<RaceFeature> = []
	const committed = committedOf(e)
	if (Option.contains(W.capIn(committed), W.spentIn(committed))) {
		reached.push("planted: the cap is hit exactly")
	}
	for (const id of explainedIds(e)) {
		const observed = ranOf(e, id).observed
		if (observed.kind !== "refused") {
			continue
		}
		const before = beforeOf(e, id)
		const cap = W.capIn(before)
		const q = requestAt(id)
		if (
			q === undefined &&
			id < changes &&
			Arr.some(observed.laws, (law) => law.family === "containment")
		) {
			reached.push("planted: a caps merge refused by the month's charges")
		}
		if (q === undefined) {
			continue
		}
		appendAll(
			reached,
			Option.match(cap, {
				onNone: (): ReadonlyArray<RaceFeature> => [
					"planted: a request refused for the month a merge removed"
				],
				onSome: (limit): ReadonlyArray<RaceFeature> =>
					W.spentIn(before) + q.charge === limit + 1n
						? ["planted: a request one micro over the cap refused"]
						: []
			})
		)
	}
	return { departure: undefined, reached }
}

raceSuite<CapSketch>({
	label: "usage against a spend cap",
	sketch: capSketchGen,
	resolve: resolveCap,
	kept: [],
	required: [
		...commonRequired,
		"law family hit: check",
		"law family hit: containment",
		"planted: the cap is hit exactly",
		"planted: a request one micro over the cap refused",
		"planted: a caps merge refused by the month's charges",
		"planted: a request refused for the month a merge removed",
		"write: cap put",
		"write: caps merge keeping both months",
		"write: caps merge keeping the race's month",
		"write: caps merge keeping the second month",
		"write: usage again",
		"direct refused"
	]
})
