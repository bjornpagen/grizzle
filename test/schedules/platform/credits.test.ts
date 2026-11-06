/**
 * Usage against credit grants: two to four requests of one organization, each settled from its prepaid grants by
 * earliest expiry and recorded by its own writer, against a grant too small for all of them.
 *
 * Each request is priced and settled by the host billing model (settle) from the grants
 * as every application read them before the race, so the requests compete for the same credit. The grant laws decide
 * which are recorded (a grant debited at most its amount, a debit inside its grant's validity, a kind's debits summing
 * to its credited part), and the harness's oracle explains every outcome by them in some serial order. The race's own
 * contract is the billing rule the laws do not state: settlement stays first-in-first-out under concurrency, so every
 * request the explained order records is debited exactly as the model settles it from the grants at its place. That
 * holds because balances only fall during a race and validity only shrinks: a request settled from an older state is
 * either what the model settles at its place or over-debits a grant and is refused.
 *
 * The swarm adds a second grant expiring later, requests whose windows cross the first grant's expiry, credit spent
 * before the race, the first grant expiring mid-race (a put shortening its validity, by grizzle or a direct writer's
 * UPDATE in place, its debits kept), and a request submitted twice.
 */

import { array, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { keep, type Swarm, swarm } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { Addition } from "#compiler/public/changeset.ts"
import { Uuid } from "#compiler/public/fields.ts"
import {
	amountOf,
	beforeOf,
	committedOf,
	commonRequired,
	type Explained,
	explainedIds,
	type Race,
	type RaceFeature,
	raceSuite,
	raceTxns,
	ranOf,
	spanOf,
	textOf,
	type WriterChoice,
	writersGen
} from "#test/schedules/platform/support.ts"
import * as W from "#test/schedules/platform/world.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { FAR, JAN } from "#test/support/platform/generate.ts"
import { rowsIn, type State } from "#test/support/platform/laws.ts"
import { covers, type GrantM, settle, platformSpan } from "#test/support/platform/model.ts"

const opFeatures = [
	"second grant",
	"crossing window",
	"prior debit",
	"expiry",
	"usage again"
] as const
type OpFeature = (typeof opFeatures)[number]

interface CreditSketch {
	/** Each request's charge, 1 to maxCharge micro-dollars. */
	readonly charges: ReadonlyArray<number>
	/**
	 * What the first grant holds past the debit before the race, and the second grant's amount, 1 to maxGrant each; but
	 * one sketch in four, the first holds one micro less than two or more of the requests charge together, so the last
	 * of them recorded can be one micro over it.
	 */
	readonly amounts: readonly [number, number]
	/**
	 * Where the first grant's validity ends when its window crosses: a request's slot, 1 to the requests' count, and an
	 * offset (instantOf).
	 */
	readonly ends: readonly [number, number]
	/** Where an expiry moves its end: a slot, 0 to the requests' count, and an offset. */
	readonly cut: readonly [number, number]
	/** What was debited before the race when the swarm keeps a prior debit, 1 to maxPrior. */
	readonly prior: number
	readonly ops: Swarm<OpFeature>
	readonly writers: ReadonlyArray<WriterChoice>
}

const maxCharge = 60
const maxGrant = 80
const maxPrior = 20

/** Request n's window: a minute apart, each half a minute long; the request before the race is request 0. */
const startOf = (n: number): bigint => JAN + 60n + 60n * BigInt(n)
const windowOf = (n: number) => platformSpan(startOf(n), startOf(n) + 30n)
/**
 * An instant by a slot, request n's start, and an offset into it: at its start, inside its window, at its end, or
 * between it and the next.
 */
const offsets = [0n, 15n, 30n, 45n] as const
const instantOf = (slot: number, offset: number): bigint =>
	startOf(slot) + defined(offsets[offset], "an offset")

const offsetGen = int(0, offsets.length - 1)

const creditSketchGen: Gen<CreditSketch> = (source) => {
	const charges = source.draw(array(int(1, maxCharge), { min: 2, max: 4 }))
	const n = charges.length
	const shortOfSet: Gen<number> = (inner) =>
		Arr.reduce(inner.draw(shuffled(charges, { min: 2, max: n })), 0, (a, b) => a + b) - 1
	return {
		charges,
		amounts: [
			source.draw(
				weighted([
					[3, int(1, maxGrant)],
					[1, shortOfSet]
				])
			),
			source.draw(int(1, maxGrant))
		],
		ends: [source.draw(int(1, n)), source.draw(offsetGen)],
		cut: [source.draw(int(0, n)), source.draw(offsetGen)],
		prior: source.draw(int(1, maxPrior)),
		ops: source.draw(swarm(opFeatures)),
		writers: source.draw(writersGen)
	}
}

/** The grants of a state, as the host model reads them. */
const grantsIn = (s: State): ReadonlyArray<GrantM> =>
	Arr.map(rowsIn(s, "CreditGrant"), (g) => ({
		id: succeeded(Uuid.parse(textOf(g, "id")), "a stored grant's id"),
		org: succeeded(Uuid.parse(textOf(g, "org")), "a stored grant's organization"),
		amount: amountOf(g, "amount"),
		valid: spanOf(g, "valid")
	}))

const debitedFrom = (s: State, grant: string): bigint =>
	Arr.reduce(
		Arr.filter(rowsIn(s, "CreditDebit"), (d) => d["grant"] === grant),
		0n,
		(sum, d) => sum + amountOf(d, "amount")
	)

const debitText = (d: {
	readonly grant: string
	readonly kind: string
	readonly amount: bigint
}): string => `${d.grant} ${d.kind} ${d.amount}`

interface Priced {
	readonly charge: bigint
	readonly record: P.UsageRecord
}

const resolveCredits =
	(k: CreditSketch): Gen<Race> =>
	(source) => {
		const on = (feature: OpFeature): boolean => source.draw(keep(k.ops, feature))
		const n = k.charges.length
		const charges = Arr.map(k.charges, (c) => BigInt(c))
		const prior = on("prior debit") ? BigInt(k.prior) : 0n
		/** The first grant ends after every window, or, crossing, at an instant among the windows. */
		const firstEnd = on("crossing window") ? instantOf(k.ends[0], k.ends[1]) : startOf(n + 2)
		const first: Addition<typeof P.CreditGrant> = {
			id: W.grantId(1),
			org: W.ids.org,
			amount: P.Micros(prior + BigInt(k.amounts[0])),
			valid: W.instants(platformSpan(JAN, firstEnd))
		}
		const second: ReadonlyArray<Addition<typeof P.CreditGrant>> = on("second grant")
			? [
					{
						id: W.grantId(2),
						org: W.ids.org,
						amount: P.Micros(BigInt(k.amounts[1])),
						valid: W.instants(platformSpan(JAN, FAR))
					}
				]
			: []
		const base = { ...W.world(1_000_000_000n), CreditGrant: [first, ...second] }
		const initial =
			prior === 0n
				? base
				: W.withUsage(base, W.recordOf(base, W.grantsLeft(base), W.request(0, windowOf(0), prior)))
		const left = W.grantsLeft(initial)
		const priced = Arr.map(charges, (charge, i): Priced => ({
			charge,
			record: W.recordOf(initial, left, W.request(i + 1, windowOf(i + 1), charge))
		}))
		const firstRequest = defined(priced[0], "the first request")
		const again = on("usage again")
		const requests = Arr.map(priced, (q, i) =>
			again && i === priced.length - 1 ? firstRequest : q
		)
		const expiry = on("expiry")
		/** The first grant shortened to end at an instant among the windows, never later than it ended. */
		const cutEnd = instantOf(k.cut[0], k.cut[1])
		const shortened: Addition<typeof P.CreditGrant> = {
			...first,
			valid: W.instants(platformSpan(JAN, cutEnd < firstEnd ? cutEnd : firstEnd))
		}
		const writes = [
			...(expiry
				? [W.grantWrite("expiry", shortened, `the first grant ends at ${shortened.valid.end}`)]
				: []),
			...Arr.map(requests, (q, i) =>
				W.usageWrite(
					again && i === requests.length - 1 ? "usage again" : "usage",
					q.record,
					`request ${i + 1} of ${q.charge}`
				)
			)
		]
		const firstUsage = expiry ? 1 : 0
		const requestAt = (id: number) => (id < firstUsage ? undefined : requests[id - firstUsage])
		return {
			initial,
			txns: raceTxns(k.writers, writes),
			judge: (e) => judgeCredits(e, requestAt)
		}
	}

/** First in, first out at its place, and what the explained order reached. */
const judgeCredits = (
	e: Explained,
	requestAt: (id: number) => Priced | undefined
): { readonly departure: string | undefined; readonly reached: ReadonlyArray<RaceFeature> } => {
	const reached: Array<RaceFeature> = []
	for (const id of explainedIds(e)) {
		const q = requestAt(id)
		if (q === undefined) {
			continue
		}
		const observed = ranOf(e, id).observed
		const before = beforeOf(e, id)
		const grants = grantsIn(before)
		const debits = q.record.debits
		if (observed.kind === "refused") {
			appendAll(
				reached,
				Arr.flatMap(debits, (d): ReadonlyArray<RaceFeature> =>
					Option.match(
						Arr.findFirst(grants, (x) => x.id === d.grant),
						{
							onNone: () => [],
							onSome: (g) => [
								...(debitedFrom(before, g.id) + d.amount === g.amount + 1n
									? ["planted: a request one micro over its grant refused" as const]
									: []),
								...(covers(g.valid, platformSpan(d.during.start, d.during.end))
									? []
									: ["planted: a debit outside its grant's validity refused" as const])
							]
						}
					)
				)
			)
		}
		if (observed.kind !== "accepted") {
			continue
		}
		if (new Set(Arr.map(debits, (d) => d.grant)).size > 1) {
			reached.push("planted: an event split across two grants")
		}
		const left = new Map(Arr.map(grants, (g) => [g.id, g.amount - debitedFrom(before, g.id)]))
		const settled = settle(
			Arr.map(q.record.charges, (c) => ({ kind: c.kind, amount: c.amount })),
			grants,
			(g) => defined(left.get(g), `what grant ${g} has left`),
			platformSpan(q.record.event.during.start, q.record.event.during.end)
		)
		const want = Arr.sort(Arr.map(settled.debits, debitText), Order.String)
		const got = Arr.sort(Arr.map(debits, debitText), Order.String)
		if (Arr.join(want, "; ") !== Arr.join(got, "; ")) {
			return {
				departure: `#${id} was recorded with debits [${Arr.join(got, "; ")}], but first-in-first-out at its place debits [${Arr.join(want, "; ")}]`,
				reached
			}
		}
	}
	const committed = committedOf(e)
	for (const g of grantsIn(committed)) {
		if (debitedFrom(committed, g.id) === g.amount) {
			reached.push("planted: a grant debited to its last micro")
		}
	}
	return { departure: undefined, reached }
}

raceSuite<CreditSketch>({
	label: "usage against credit grants",
	sketch: creditSketchGen,
	resolve: resolveCredits,
	kept: [],
	required: [
		...commonRequired,
		"law family hit: check",
		"law family hit: coverage",
		"planted: a grant debited to its last micro",
		"planted: a request one micro over its grant refused",
		"planted: an event split across two grants",
		"planted: a debit outside its grant's validity refused",
		"write: expiry",
		"write: usage again"
	]
})
