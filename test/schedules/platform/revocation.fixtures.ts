/** What the properties of revocation.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, constant } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
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
import { FAR, JAN } from "#test/support/platform/generate.ts"
import { rowsIn } from "#test/support/platform/laws.ts"
import { platformSpan } from "#test/support/platform/model.ts"

/** The revocation's instant, an hour into the month. */
const revokedAt = JAN + 3600n

/** Where a request's half-minute window lies against the revocation's instant. */
const placements = ["before", "ending at", "across", "starting at", "after"] as const

type Placement = (typeof placements)[number]

const windowOf = (where: Placement) => {
	switch (where) {
		case "before":
			return platformSpan(revokedAt - 100n, revokedAt - 70n)
		case "ending at":
			return platformSpan(revokedAt - 30n, revokedAt)
		case "across":
			return platformSpan(revokedAt - 15n, revokedAt + 15n)
		case "starting at":
			return platformSpan(revokedAt, revokedAt + 30n)
		case "after":
			return platformSpan(revokedAt + 70n, revokedAt + 100n)
	}
}

export interface RevokeSketch {
	/** Per request: where its window lies, and its charge, 1 to maxCharge. */
	readonly requests: ReadonlyArray<{ readonly where: Placement; readonly charge: number }>
	readonly writers: ReadonlyArray<WriterChoice>
}

const maxCharge = 20

export const revokeSketchGen: Gen<RevokeSketch> = (source) => ({
	requests: source.draw(
		array(
			(request) => ({
				where: request.draw(element(placements)),
				charge: request.draw(int(1, maxCharge))
			}),
			{ min: 1, max: 4 }
		)
	),
	writers: source.draw(writersGen)
})

/** A revocation race: its sketch has no swarm to thin, so its resolution draws nothing. */
export const resolveRevoke =
	(k: RevokeSketch): Gen<Race> =>
	() => {
		const initial = W.world(1_000_000_000n)
		const requests = Arr.map(k.requests, (q, i) => ({
			where: q.where,
			record: W.recordOf(initial, new Map(), W.request(i + 1, windowOf(q.where), BigInt(q.charge)))
		}))
		const writes = [
			W.revokeWrite(revokedAt, platformSpan(JAN, FAR)),
			...Arr.map(requests, (q, i) =>
				W.usageWrite("usage", q.record, `request ${i + 1} ${q.where} the revocation`)
			)
		]
		return {
			initial,
			txns: raceTxns(k.writers, writes),
			judge: (e) => judgeRevoke(e, (id) => (id === 0 ? undefined : requests[id - 1]))
		}
	}

/** What the explained order reached; every outcome the laws decide, the oracle has explained. */
const judgeRevoke = (
	e: ExplainedRun,
	requestAt: (id: number) => { readonly where: Placement } | undefined
): { readonly departure: string | undefined; readonly reached: ReadonlyArray<RaceFeature> } => {
	const reached: Array<RaceFeature> = []
	const revoked = rowsIn(committedOf(e), "Revocation").length > 0
	for (const id of explainedIds(e)) {
		const observed = ranOf(e, id).observed
		const q = requestAt(id)
		if (q === undefined && observed.kind === "refused") {
			reached.push("planted: the revocation refused by later usage")
		}
		if (q === undefined) {
			continue
		}
		const revokedBefore = rowsIn(beforeOf(e, id), "Revocation").length > 0
		if (observed.kind === "accepted" && q.where === "ending at" && revoked) {
			reached.push("planted: a request ending at the revocation recorded")
		}
		if (observed.kind === "refused" && revokedBefore) {
			reached.push("planted: a request after the revocation refused")
		}
	}
	return { departure: undefined, reached }
}

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const revocationCases: ReadonlyArray<{
	readonly why: string
	readonly value: RevokeSketch
	readonly reaches: ReadonlyArray<RaceFeature>
}> = [
	{
		why: "the revocation after a request recorded before its cut: the key's active span is replaced by the cut span, which still covers the request, so the PERIOD reference into it is checked at COMMIT, not between the deletion and the insertion",
		value: {
			requests: [{ where: "before", charge: 1 }],
			writers: Arr.makeBy(6, () => ({ kind: "grizzle", checked: "at COMMIT" }) as const)
		},
		reaches: ["write: revoke", "write: usage", "every interleaving"]
	}
]

/** The property's aims (revocation): each kept case's value at every situation it reaches. */
export const revocationAims: ReadonlyArray<readonly [Reached<RaceFeature>, Gen<RevokeSketch>]> =
	Arr.flatMap(revocationCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
