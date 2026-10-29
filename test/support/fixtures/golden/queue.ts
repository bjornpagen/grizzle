/**
 * The work queue example's golden state, which the queue schedules load: every standing, nine items of kind render
 * in slot 0 (and one transcode item) spread over the key space, two leases on gpu, one expired and one live, occupying
 * seats 1 and 2 of gpu's three, and two leases on cpu occupying both of its seats, one expiring at 150 and one live.
 */

import { String as Str } from "effect"
const digest = (hex: string): string => Str.repeat(64)(hex)

export const kA = digest("2")
export const kB = digest("4")
const kC = digest("6")
export const kG = digest("7")
const kD = digest("8")
const kE = digest("a")
const kF = digest("c")
const kH = digest("e")
const kI = digest("f")

export const queueFacts = {
	Work: [
		{ key: kA, kind: "render", slot: 0, standing: "wanted", epoch: 0n, enqueued: 10n },
		{ key: kB, kind: "render", slot: 0, standing: "leased", epoch: 1n, enqueued: 11n },
		{ key: kC, kind: "render", slot: 0, standing: "wanted", epoch: 0n, enqueued: 12n },
		{ key: kD, kind: "render", slot: 0, standing: "done", epoch: 1n, enqueued: 13n },
		{ key: kE, kind: "transcode", slot: 0, standing: "wanted", epoch: 0n, enqueued: 14n },
		{ key: kF, kind: "render", slot: 0, standing: "leased", epoch: 2n, enqueued: 15n },
		{ key: kG, kind: "render", slot: 0, standing: "wanted", epoch: 0n, enqueued: 16n },
		{ key: kH, kind: "render", slot: 0, standing: "leased", epoch: 1n, enqueued: 17n },
		{ key: kI, kind: "render", slot: 0, standing: "leased", epoch: 3n, enqueued: 18n }
	],
	Wanted: [
		{ key: kA, due: 100n, attempts: 0 },
		{ key: kC, due: 300n, attempts: 0 },
		{ key: kE, due: 100n, attempts: 0 },
		{ key: kG, due: 120n, attempts: 2 }
	],
	Leased: [
		{ key: kB, resource: "gpu", seat: 1, epoch: 1n, expires: 50n },
		{ key: kF, resource: "gpu", seat: 2, epoch: 2n, expires: 500n },
		{ key: kH, resource: "cpu", seat: 1, epoch: 1n, expires: 150n },
		{ key: kI, resource: "cpu", seat: 2, epoch: 3n, expires: 900n }
	],
	Done: [{ key: kD, outcome: "succeeded" }],
	Seat: [
		{ resource: "gpu", seat: 1 },
		{ resource: "gpu", seat: 2 },
		{ resource: "gpu", seat: 3 },
		{ resource: "cpu", seat: 1 },
		{ resource: "cpu", seat: 2 }
	]
} as const
