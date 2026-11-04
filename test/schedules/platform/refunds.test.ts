/**
 * Refunds racing: two or three refunds of one invoice, whose amounts together exceed what is left of it, with its
 * settlements racing them: on a paid invoice a dispute, and on an open invoice its payment and its voiding.
 *
 * The settlements are the workload programs payInvoice, disputeInvoice and voidInvoice: a ChangeSet whose put and arm
 * insertion read one sub-query, the invoice in the state the settlement moves it from, so a settlement applies only to
 * an invoice in that state and is no-change on any other. Refunds never exceed what the invoice charged
 * (refundWithinInvoice), only a paid invoice is refunded (refundOnlyPaid), and a paid, void or disputed invoice has
 * exactly its payment, voiding or dispute (invoiceSettlement); the harness's oracle explains every outcome by those
 * laws and the programs' reads in some serial order. A direct writer settles the invoice as it read it before the race:
 * it replaces the invoice and its payment where it gives way.
 *
 * The swarm adds refunds made before the race, the dispute, the voiding, and an open invoice whose payment races its
 * refunds.
 */

import { array, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { keep, type Swarm, swarm } from "@grizzle/testing/swarm"
import { Array as Arr } from "effect"
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
	type WriterChoice,
	writersGen
} from "#test/schedules/platform/support.ts"
import * as W from "#test/schedules/platform/world.ts"
import { defined } from "#test/support/assert.ts"
import { rowsIn } from "#test/support/platform/laws.ts"

const opFeatures = ["open", "void", "prior refund", "dispute"] as const
type OpFeature = (typeof opFeatures)[number]

interface RefundSketch {
	/** Each refund's amount, 1 to maxRefund micro-dollars. */
	readonly refunds: ReadonlyArray<number>
	/**
	 * The invoice's amount: what was refunded before plus 1 and this, below the refunds' total less one, so the
	 * refunds together exceed what is left; but one sketch in four, exactly what a proper subset of the refunds sums to,
	 * and one in four, one micro less than two or more of the refunds together, so the last of them recorded can be one
	 * micro over what is left.
	 */
	readonly amount: number
	/** What was refunded before the race when the swarm keeps a prior refund, 1 to maxPrior. */
	readonly prior: number
	readonly ops: Swarm<OpFeature>
	readonly writers: ReadonlyArray<WriterChoice>
}

const maxRefund = 60
const maxPrior = 30

/**
 * A sketch's refunds and the amount past the prior refund the invoice leaves: anything that keeps one refund over; or,
 * one sketch in four, exactly what a proper subset of the refunds sums to, so the refunds that commit can meet the
 * invoice to the micro; or, one sketch in four, one micro less than two or more of the refunds together, so the last of
 * them recorded is one micro over what the others left.
 */
const refundSketchGen: Gen<RefundSketch> = (source) => {
	const refunds = source.draw(array(int(1, maxRefund), { min: 2, max: 3 }))
	const total = Arr.reduce(refunds, 0, (a, b) => a + b)
	/** What a drawn set of `min` to `max` of the refunds sums to, less `less`. */
	const setSum =
		(min: number, max: number, less: number): Gen<number> =>
		(inner) =>
			Arr.reduce(inner.draw(shuffled(refunds, { min, max })), 0, (a, b) => a + b) - less
	return {
		refunds,
		amount: source.draw(
			weighted([
				[2, int(0, total - 2)],
				[1, setSum(1, refunds.length - 1, 1)],
				[1, setSum(2, refunds.length, 2)]
			])
		),
		prior: source.draw(int(1, maxPrior)),
		ops: source.draw(swarm(opFeatures)),
		writers: source.draw(writersGen)
	}
}

const resolveRefunds =
	(k: RefundSketch): Gen<Race> =>
	(source) => {
		const on = (feature: OpFeature): boolean => source.draw(keep(k.ops, feature))
		const refunds = Arr.map(k.refunds, (r) => BigInt(r))
		const open = on("open")
		const prior = !open && on("prior refund") ? BigInt(k.prior) : 0n
		const amount = prior + 1n + BigInt(k.amount)
		const base = W.invoiced(W.world(1_000_000_000n), amount, open ? "open" : "paid")
		const initial = prior === 0n ? base : { ...base, Refund: [W.refundOf(0, prior)] }
		const settlements = open
			? [W.payWrite(amount), ...(on("void") ? [W.voidWrite(amount)] : [])]
			: on("dispute")
				? [W.disputeWrite(amount)]
				: []
		const writes = [
			...settlements,
			...Arr.map(refunds, (r, i) => W.refundWrite(W.refundOf(i + 1, r), `refund ${i + 1} of ${r}`))
		]
		const refundAt = (id: number) =>
			id < settlements.length ? undefined : refunds[id - settlements.length]
		return {
			initial,
			txns: raceTxns(k.writers, writes),
			judge: (e) => judgeRefunds(e, refundAt)
		}
	}

/** What the explained order reached; every outcome the laws decide, the oracle has explained. */
const judgeRefunds = (
	e: Explained,
	refundAt: (id: number) => bigint | undefined
): { readonly departure: string | undefined; readonly reached: ReadonlyArray<RaceFeature> } => {
	const reached: Array<RaceFeature> = []
	const committed = committedOf(e)
	const charged = amountOf(defined(rowsIn(committed, "Invoice")[0], "the invoice"), "amount")
	if (W.refundedIn(committed) === charged) {
		reached.push("planted: refunds summing to the invoice exactly")
	}
	for (const id of explainedIds(e)) {
		const observed = ranOf(e, id).observed
		const before = beforeOf(e, id)
		const refund = refundAt(id)
		if (refund === undefined && observed.kind === "no-change") {
			reached.push("planted: a settlement no-change after another settled it")
		}
		if (refund === undefined && observed.kind === "refused" && W.refundedIn(before) > 0n) {
			reached.push("planted: a settlement refused by refunds")
		}
		if (refund === undefined) {
			continue
		}
		if (observed.kind !== "refused") {
			continue
		}
		if (W.invoiceStateIn(before) !== "paid") {
			reached.push("planted: a refund of an unpaid invoice refused")
		} else if (W.refundedIn(before) + refund === charged + 1n) {
			reached.push("planted: a refund one micro over what is left refused")
		}
	}
	return { departure: undefined, reached }
}

raceSuite<RefundSketch>({
	label: "refunds racing",
	sketch: refundSketchGen,
	resolve: resolveRefunds,
	kept: [],
	required: [
		...commonRequired,
		"law family hit: capacity",
		"law family hit: containment",
		"planted: refunds summing to the invoice exactly",
		"planted: a refund one micro over what is left refused",
		"planted: a settlement refused by refunds",
		"planted: a refund of an unpaid invoice refused",
		"planted: a settlement no-change after another settled it",
		"grizzle no-change",
		"write: dispute",
		"write: void",
		"write: pay"
	]
})
