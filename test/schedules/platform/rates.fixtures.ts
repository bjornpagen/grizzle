/** What the properties of rates.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { keep, type Swarm, swarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Order } from "effect"
import {
	amountOf,
	beforeOf,
	committedOf,
	type ExplainedRun,
	type Race,
	type RaceFeature,
	raceTxns,
	ranOf,
	spanField,
	type WriterChoice,
	writersGen
} from "#test/schedules/platform/support.ts"
import * as W from "#test/schedules/platform/world.ts"
import { FAR, JAN } from "#test/support/platform/generate.ts"
import { rowsIn, type State } from "#test/support/platform/laws.ts"
import { chargeOf, platformSpan, type SpanV } from "#test/support/platform/model.ts"

/** The change's instant, an hour into the month, and the second split's, half an hour later. */
const splitAt = JAN + 3600n

const secondAt = splitAt + 1800n

/** Where a request's window starts against the changes. */
const starts = {
	"before the split": splitAt - 1n,
	"at the split": splitAt,
	"after the split": splitAt + 1n,
	"at the second split": secondAt
} as const

type Start = keyof typeof starts

const startNames: Arr.NonEmptyReadonlyArray<Start> = [
	"before the split",
	"at the split",
	"after the split",
	"at the second split"
]

/** The rates a split may take, micro-dollars per million tokens: twice, half and thrice the old rate. */
const rates = [2_000_000n, 500_000n, 3_000_000n] as const

const opFeatures = ["second split", "retire"] as const

type OpFeature = (typeof opFeatures)[number]

export interface RateSketch {
	/** Per request: where its window starts, and its tokens, 1 to maxTokens. */
	readonly requests: ReadonlyArray<{ readonly start: Start; readonly tokens: number }>
	/** The rates the splits take. */
	readonly rates: readonly [bigint, bigint]
	readonly ops: Swarm<OpFeature>
	readonly writers: ReadonlyArray<WriterChoice>
}

const maxTokens = 40

export const rateSketchGen: Gen<RateSketch> = (source) => ({
	requests: source.draw(
		array(
			(request) => ({
				start: request.draw(element(startNames)),
				tokens: request.draw(int(1, maxTokens))
			}),
			{ min: 1, max: 3 }
		)
	),
	rates: [source.draw(element(rates)), source.draw(element(rates))],
	ops: source.draw(swarm(opFeatures)),
	writers: source.draw(writersGen)
})

const priceOf = (rate: bigint, tokens: bigint): bigint =>
	chargeOf([{ tier: platformSpan(0n, 1n << 40n), rate }], tokens)

/** The committed cards of the model's input tokens, by start. */
const cardsIn = (s: State) =>
	Arr.sort(
		Arr.map(
			Arr.filter(rowsIn(s, "RateCard"), (c) => c["model"] === W.ids.model && c["kind"] === "input"),
			(c) => spanField(c, "during")
		),
		Order.mapInput(Order.BigInt, (span: SpanV) => span.start)
	)

/** A rate change of the race: a split at an instant to a rate, or the retirement at the first instant. */
type Change =
	| { readonly kind: "split"; readonly id: number; readonly at: bigint; readonly rate: bigint }
	| { readonly kind: "retire"; readonly id: number; readonly at: bigint }

interface Priced {
	readonly id: number
	readonly start: Start
	readonly tokens: bigint
	readonly quoted: boolean
}

export const resolveRates =
	(k: RateSketch): Gen<Race> =>
	(source) => {
		const on = (feature: OpFeature): boolean => source.draw(keep(k.ops, feature))
		const initial = W.world(1_000_000_000n)
		const retire = on("retire")
		const changes: ReadonlyArray<Change> = retire
			? [{ kind: "retire", id: 0, at: splitAt }]
			: [
					{ kind: "split", id: 0, at: splitAt, rate: k.rates[0] },
					...(on("second split")
						? [{ kind: "split" as const, id: 1, at: secondAt, rate: k.rates[1] }]
						: [])
				]
		const requests: ReadonlyArray<Priced> = Arr.map(k.requests, (q, i) => ({
			id: changes.length + i,
			start: q.start,
			tokens: BigInt(q.tokens),
			quoted: !retire
		}))
		const writes = [
			...Arr.map(changes, (c) =>
				c.kind === "retire"
					? W.retireWrite(c.at)
					: W.splitWrite(
							c.id === 0 ? "rate split" : "second split",
							c.at,
							W.cardId(2 + c.id),
							c.rate
						)
			),
			...Arr.map(requests, (q, i) => {
				const start = starts[q.start]
				const priced = W.recordOf(
					initial,
					new Map(),
					W.request(i + 1, platformSpan(start, start + 30n), q.tokens)
				)
				const label = `request ${i + 1} ${q.start} for ${q.tokens} tokens`
				return q.quoted
					? W.quotedUsageWrite(priced, q.tokens, label)
					: W.usageWrite("usage", priced, label)
			})
		]
		return {
			initial,
			txns: raceTxns(k.writers, writes),
			judge: (e) => judgeRates(e, changes, requests)
		}
	}

const judgeRates = (
	e: ExplainedRun,
	changes: ReadonlyArray<Change>,
	requests: ReadonlyArray<Priced>
): { readonly departure: string | undefined; readonly reached: ReadonlyArray<RaceFeature> } => {
	const committed = committedOf(e)
	const reached: Array<RaceFeature> = []
	const accepted = Arr.filter(changes, (c) => ranOf(e, c.id).observed.kind === "accepted")
	/**
	 * The cards cover all of time from January on, each meeting the next, up to the retirement's end if it committed.
	 */
	const end = Arr.some(accepted, (c) => c.kind === "retire") ? splitAt : FAR
	let reach = JAN
	for (const c of cardsIn(committed)) {
		if (c.start !== reach) {
			return { departure: `the cards leave [${reach}, ${c.start}) unpriced`, reached }
		}
		reach = c.end
	}
	if (reach !== end) {
		return { departure: `the cards end at ${reach}, not ${end}`, reached }
	}
	for (const c of changes) {
		const observed = ranOf(e, c.id).observed
		if (observed.kind !== "refused") {
			continue
		}
		reached.push(
			c.kind === "retire"
				? "planted: a retirement refused by the charges it priced"
				: "planted: a second split refused"
		)
	}
	for (const q of requests) {
		const r = ranOf(e, q.id)
		const start = starts[q.start]
		if (
			r.observed.kind === "refused" &&
			start >= splitAt &&
			Arr.some(changes, (c) => c.kind === "retire")
		) {
			reached.push("planted: a request priced after the card's end refused")
		}
		if (!q.quoted || r.writer !== "grizzle" || r.observed.kind !== "accepted") {
			continue
		}
		const chargeOps = Arr.filter(r.ops(beforeOf(e, q.id)), (o) => o.relation === "UsageCharge")
		const charge = Arr.reduce(
			Arr.flatMap(chargeOps, (o) => o.facts),
			0n,
			(sum, c) => sum + amountOf(c, "amount")
		)
		const old = priceOf(W.flatRate, q.tokens)
		/** The accepted splits whose new card holds the request's start, each with its price there. */
		const holding = Arr.flatMap(accepted, (c) => (c.kind === "split" && start >= c.at ? [c] : []))
		const allowed = [old, ...Arr.map(holding, (c) => priceOf(c.rate, q.tokens))]
		if (!allowed.includes(charge)) {
			return {
				departure: `#${q.id} was charged ${charge}, the price under no card that held its start: ${Arr.join(Arr.map(allowed, String), " or ")}`,
				reached
			}
		}
		const misprices = Arr.flatMap(holding, (c) => {
			const split = ranOf(e, c.id)
			return [
				...(split.end < r.start && charge !== priceOf(c.rate, q.tokens)
					? [
							`#${q.id} began after the split #${c.id} committed, but was charged ${charge}, not the new rate's ${priceOf(c.rate, q.tokens)}`
						]
					: []),
				...(r.end < split.start && charge !== old
					? [
							`#${q.id} ended before the split #${c.id} began, but was charged ${charge}, not the old rate's ${old}`
						]
					: [])
			]
		})
		const [misprice] = misprices
		if (misprice !== undefined) {
			return { departure: misprice, reached }
		}
		const [split] = q.start === "at the split" ? holding : []
		const fresh = split === undefined ? old : priceOf(split.rate, q.tokens)
		if (charge === fresh && fresh !== old) {
			reached.push("planted: a request at the split priced by the new rate")
		}
		if (charge === old && fresh !== old) {
			reached.push("planted: a request at the split priced by the old rate")
		}
	}
	return { departure: undefined, reached }
}
