/** What the properties of cap.test.ts read: its spaces, models and helpers. */

import { array, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { fullSwarm, keep, type Swarm, swarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Option } from "effect"
import {
	beforeOf,
	committedOf,
	type ExplainedRun,
	explainedIds,
	type Race,
	type RaceFeature,
	raceTxns,
	ranOf,
	type WriterChoice,
	writersGen
} from "#test/schedules/platform/support.ts"
import * as W from "#test/schedules/platform/world.ts"
import { defined } from "#test/support/assert.ts"
import { JAN } from "#test/support/platform/generate.ts"
import { platformSpan } from "#test/support/platform/model.ts"

const opFeatures = ["prior spend", "cap put", "caps given", "duplicate"] as const

type OpFeature = (typeof opFeatures)[number]

export interface CapSketch {
	/** Each request's charge, 1 to maxCharge micro-dollars. */
	readonly charges: ReadonlyArray<number>
	/** The cap: what the workspace spent before the race plus this, below the requests' total. */
	readonly cap: number
	/** What the workspace spent before the race when the swarm keeps prior spend, 1 to maxPrior. */
	readonly prior: number
	/** The cap a cap change sets: what was spent before plus this, up to the requests' total. */
	readonly capTo: number
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
		ops: source.draw(swarm(opFeatures)),
		writers: source.draw(writersGen)
	}
}

/**
 * A race whose cap is one micro under what its requests charge together, beside the spend before the race, with no
 * cap change and no duplicate: whatever order serializes the requests, the last is refused one micro over the cap.
 */
const overByOneArm: Gen<CapSketch> = map(anyCapSketchGen, (k): CapSketch => ({
	...k,
	cap: Arr.reduce(k.charges, 0, (a, b) => a + b) - 1,
	ops: { "prior spend": 3 }
}))

/**
 * A race's sketch: any; one in five with every op on, so the label-fixed floor and steered streams reach the caps given
 * beside a cap put, prior spend and a duplicate request; and one in five a cap one micro under the requests' total
 * (overByOneArm), a request refused one micro over the cap, which a drawn cap meets by chance alone.
 */
export const capSketchGen: Gen<CapSketch> = weighted([
	[3, anyCapSketchGen],
	[1, map(anyCapSketchGen, (k): CapSketch => ({ ...k, ops: fullSwarm(opFeatures) }))],
	[1, overByOneArm]
])

/** Request n's window: a minute apart, each half a minute long, inside the month. */
const windowOf = (n: number) => platformSpan(JAN + 60n * BigInt(n), JAN + 60n * BigInt(n) + 30n)

export const resolveCap =
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
		const changes = [
			...(on("cap put") ? [W.capWrite(cap, capTo)] : []),
			...(on("caps given")
				? [W.capsGivenWrite([W.limitOf(capTo), W.limitIn(W.nextMonth, secondCap)])]
				: [])
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
			judge: (e) => judgeCap(e, requestAt)
		}
	}

/** What the explained order reached; every outcome the laws decide, the oracle has explained. */
const judgeCap = (
	e: ExplainedRun,
	requestAt: (id: number) => { readonly charge: bigint } | undefined
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
		const q = requestAt(id)
		if (
			q !== undefined &&
			Option.exists(W.capIn(before), (limit) => W.spentIn(before) + q.charge === limit + 1n)
		) {
			reached.push("planted: a request one micro over the cap refused")
		}
	}
	return { departure: undefined, reached }
}
