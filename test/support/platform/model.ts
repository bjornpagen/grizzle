/**
 * The platform's billing model on the host: a second implementation of the pricing and settlement arithmetic the
 * platform fixture (test/support/fixtures/api/platform.ts) states in SQL and in its laws, written from the rules in
 * words and sharing nothing with grizzle.
 *
 * Rules:
 *
 * - Spans are half-open [start, end) over integers. A span holds a point t when start <= t < end; one covers another
 *   when it starts no later and ends no earlier; two overlap when each starts before the other ends.
 * - The rate of a model's token kind at an instant is the one card of that model and kind whose span holds the
 *   instant, and a charge is lawful only where there is one: it names the instant it was priced at as the one-second
 *   span [t, t + 1), which the cards of its model and kind cover exactly when one holds t. A charge is graduated: each
 *   tier [from, to) of the card prices min(to, tokens) - from tokens when from < tokens, at its rate in micro-dollars
 *   per million tokens, and each piece rounds half up to the micro-dollar: (tokens * rate + 500000) div 1000000.
 * - An event is priced at the start of its request window. Its month and day are the calendar's month and day holding
 *   that start.
 * - Credits are spent by earliest expiry: the organization's grants valid over the whole request window with something
 *   left, ordered by the end of their validity and then by id, each pays what it has left until the event's charge is
 *   paid. What credits paid is then split across the event's kinds by largest remainder, weighted by each kind's
 *   charge (ties to the kind first in the roster), and the (grant, kind) debits fill a grid row by row in grant order,
 *   column by column in roster order, so each grant pays exactly its part and each kind is credited exactly its share.
 * - A Team plan segment's charge over a period is its monthly price times the overlap over the period's width,
 *   rounded half away from zero to the micro-dollar.
 */
import type { Option } from "effect"
import { Array as Arr, Order } from "effect"
import type { Span } from "#compiler/public/fields.ts"

export type SpanV = Span<bigint>

export const platformSpan = (start: bigint, end: bigint): SpanV => ({ start, end })

export const holds = (s: SpanV, t: bigint): boolean => s.start <= t && t < s.end

export const covers = (outer: SpanV, inner: SpanV): boolean =>
	outer.start <= inner.start && inner.end <= outer.end

export const overlaps = (a: SpanV, b: SpanV): boolean => a.start < b.end && b.start < a.end
export const width = (s: SpanV): bigint => s.end - s.start
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b)
export const overlapOf = (a: SpanV, b: SpanV): bigint =>
	max(0n, min(a.end, b.end) - max(a.start, b.start))

/** The token kinds in roster order, as the fixture declares them. */
export const tokenKinds = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"batchInput",
	"batchOutput"
] as const
export type TokenKind = (typeof tokenKinds)[number]

/** Whether a span set covers a span: every point of the span lies in some member (members may abut). */
export const coveredBy = (spans: ReadonlyArray<SpanV>, s: SpanV): boolean => {
	let reached = s.start
	for (const m of Arr.sort(
		spans,
		Order.mapInput(Order.BigInt, (s: SpanV) => s.start)
	)) {
		if (m.start > reached) {
			break
		}
		if (m.end > reached) {
			reached = m.end
		}
		if (reached >= s.end) {
			return true
		}
	}
	return reached >= s.end
}

interface TierM {
	readonly tier: SpanV
	readonly rate: bigint
}

export interface CardM {
	readonly id: string
	readonly model: string
	readonly kind: TokenKind
	readonly during: SpanV
	readonly tiers: ReadonlyArray<TierM>
}

export interface Piece {
	readonly tier: SpanV
	readonly tokens: bigint
	readonly amount: bigint
}

export const microsPerMillion = 1_000_000n

/** The pieces a card's tiers price of `tokens`, in tier order. */
export const piecesOf = (tiers: ReadonlyArray<TierM>, tokens: bigint): ReadonlyArray<Piece> =>
	Arr.map(
		Arr.filter(
			Arr.sort(
				tiers,
				Order.mapInput(Order.BigInt, (t: TierM) => t.tier.start)
			),
			(t) => t.tier.start < tokens
		),
		(t) => {
			const priced = min(t.tier.end, tokens) - t.tier.start
			return {
				tier: t.tier,
				tokens: priced,
				amount: (priced * t.rate + microsPerMillion / 2n) / microsPerMillion
			}
		}
	)

export const chargeOf = (tiers: ReadonlyArray<TierM>, tokens: bigint): bigint =>
	Arr.reduce(piecesOf(tiers, tokens), 0n, (sum, p) => sum + p.amount)

/**
 * The card of a model's kind in force at an instant, if one is. A charge priced at the instant is lawful exactly when
 * one is (pricedByCard).
 */
export const cardAt = (
	cards: ReadonlyArray<CardM>,
	model: string,
	kind: TokenKind,
	at: bigint
): Option.Option<CardM> =>
	Arr.findFirst(cards, (c) => c.model === model && c.kind === kind && holds(c.during, at))

/** The instant a request over `window` is priced at, the window's start, as the one-second span a charge names. */
export const pricedAt = (window: SpanV): SpanV => platformSpan(window.start, window.start + 1n)

/**
 * `total` split across `weights` so the parts sum to it exactly: each part the floor of its share, the units left over
 * to the largest remainders, ties to the earlier weight. Every weight zero gives every part zero.
 */
const largestRemainder = (total: bigint, weights: ReadonlyArray<bigint>): ReadonlyArray<bigint> => {
	const sum = Arr.reduce(weights, 0n, (a, b) => a + b)
	if (sum === 0n) {
		return Arr.map(weights, () => 0n)
	}
	const parts = Arr.map(weights, (w) => (total * w) / sum)
	let left = total - Arr.reduce(parts, 0n, (a, b) => a + b)
	/** Largest remainder first; ties to the earlier weight. */
	const order = Arr.sort(
		Arr.map(weights, (w, i) => ({ i, r: (total * w) % sum })),
		Order.combine(
			Order.mapInput(
				Order.flip(Order.BigInt),
				(x: { readonly i: number; readonly r: bigint }) => x.r
			),
			Order.mapInput(Order.Number, (x: { readonly i: number; readonly r: bigint }) => x.i)
		)
	)
	const out = [...parts]
	for (const { i } of order) {
		if (left === 0n) {
			break
		}
		out[i] = (out[i] ?? 0n) + 1n
		left -= 1n
	}
	return out
}

export interface GrantM {
	readonly id: string
	readonly org: string
	readonly amount: bigint
	readonly valid: SpanV
}

interface DebitM {
	readonly grant: string
	readonly kind: TokenKind
	readonly amount: bigint
}

export interface Settlement {
	/** Each kind's charge and the part credits paid, in roster order, every kind charged. */
	readonly kinds: ReadonlyArray<{
		readonly kind: TokenKind
		readonly amount: bigint
		readonly credited: bigint
	}>
	readonly debits: ReadonlyArray<DebitM>
}

/** How an event's kinds are settled from grants, given what each grant has left (see the header). */
export const settle = (
	charges: ReadonlyArray<{ readonly kind: TokenKind; readonly amount: bigint }>,
	grants: ReadonlyArray<GrantM>,
	left: (grant: string) => bigint,
	window: SpanV
): Settlement => {
	const kinds = Arr.flatMap(tokenKinds, (k) => Arr.filter(charges, (c) => c.kind === k))
	const total = Arr.reduce(kinds, 0n, (s, c) => s + c.amount)
	const eligible = Arr.sort(
		Arr.filter(grants, (g) => covers(g.valid, window) && left(g.id) > 0n),
		Order.combine(
			Order.mapInput(Order.BigInt, (g: GrantM) => g.valid.end),
			Order.mapInput(Order.String, (g: GrantM) => g.id)
		)
	)
	const paid: Array<{ readonly grant: string; readonly amount: bigint }> = []
	let owed = total
	for (const g of eligible) {
		if (owed === 0n) {
			break
		}
		const take = min(owed, left(g.id))
		paid.push({ grant: g.id, amount: take })
		owed -= take
	}
	const credited = total - owed
	const shares = largestRemainder(
		credited,
		Arr.map(kinds, (k) => k.amount)
	)
	const debits: Array<DebitM> = []
	const due = [...shares]
	let column = 0
	let payer = 0
	let rest = paid[0]?.amount ?? 0n
	while (payer < paid.length) {
		const p = paid[payer]
		if (p === undefined || rest === 0n) {
			payer += 1
			rest = paid[payer]?.amount ?? 0n
			continue
		}
		const k = kinds[column]
		const need = due[column] ?? 0n
		if (k === undefined) {
			throw new Error("credits paid more than the event was charged")
		}
		const take = min(rest, need)
		if (take > 0n) {
			debits.push({ grant: p.grant, kind: k.kind, amount: take })
		}
		rest -= take
		due[column] = need - take
		if (due[column] === 0n) {
			column += 1
		}
	}
	return {
		kinds: Arr.map(kinds, (k, i) => ({
			kind: k.kind,
			amount: k.amount,
			credited: shares[i] ?? 0n
		})),
		debits
	}
}

/** price * overlap / width rounded half away from zero; every operand is nonnegative and width positive. */
export const prorated = (price: bigint, overlap: bigint, of: bigint): bigint =>
	(2n * price * overlap + of) / (2n * of)
