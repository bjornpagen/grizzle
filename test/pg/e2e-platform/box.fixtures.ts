/** What the properties of box.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { type CallError } from "#compiler/live/index.ts"
import { type PlatformDb, platformTemplate } from "#test/pg/e2e-platform/support.ts"
import { answered } from "#test/support/calls.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import {
	calendarOf,
	DAY,
	FAR,
	JAN,
	noFacts,
	type PlatformFacts,
	TOKENS_MAX,
	tierBounds,
	uid
} from "#test/support/platform/generate.ts"
import { untilAnswered } from "#test/support/transient.ts"

export const C = JAN + 10n * DAY

export const org = uid(1, 0)

const workspace = uid(2, 0)

export const key = uid(3, 0)

export const provider = uid(4, 0)

export const model = uid(5, 0)

export const grantIds = [uid(8, 0), uid(8, 1)] as const

/**
 * The static platform: the calendar month, the tenancy, the catalog, and the cards: input at 3 dollars per million
 * tokens until C and graduated from C, output flat.
 */
const months = calendarOf(1)

export const staticFacts: PlatformFacts = {
	...noFacts,
	Month: Arr.map(months, (m) => ({
		month: P.MonthNo(m.month),
		during: { start: P.Instant(m.during.start), end: P.Instant(m.during.end) }
	})),
	Day: Arr.flatMap(months, (m) => {
		const days: Array<PlatformFacts["Day"][number]> = []
		for (let t = m.during.start; t < m.during.end; t += DAY) {
			days.push({
				day: P.DayNo(Number(t / DAY)),
				during: { start: P.Instant(t), end: P.Instant(t + DAY) },
				month: P.MonthNo(m.month)
			})
		}
		return days
	}),
	Org: [{ id: org }],
	Workspace: [{ id: workspace, org }],
	WorkspaceLimit: Arr.map(months, (m) => ({
		workspace,
		month: P.MonthNo(m.month),
		cap: P.Micros(10n ** 12n)
	})),
	ApiKey: [{ id: key, workspace, state: "active" }],
	ApiKeyActive: [{ key, during: { start: P.Instant(JAN), end: P.Instant(FAR) } }],
	Provider: [{ id: provider }],
	Model: [{ id: model }],
	Route: [{ model, provider }],
	ProviderPrice: [
		{
			provider,
			model,
			kind: "input",
			during: { start: P.Instant(JAN), end: P.Instant(FAR) },
			rate: P.Rate(1_800_000n)
		}
	],
	RateCard: [
		{ id: uid(6, 0), model, kind: "input", during: { start: P.Instant(JAN), end: P.Instant(C) } },
		{ id: uid(6, 1), model, kind: "input", during: { start: P.Instant(C), end: P.Instant(FAR) } }
	],
	RateTier: [
		{
			card: uid(6, 0),
			tier: { start: P.Tokens(0n), end: P.Tokens(TOKENS_MAX) },
			rate: P.Rate(3_000_000n)
		},
		{
			card: uid(6, 1),
			tier: { start: P.Tokens(0n), end: P.Tokens(tierBounds[0]) },
			rate: P.Rate(3_000_001n)
		},
		{
			card: uid(6, 1),
			tier: { start: P.Tokens(tierBounds[0]), end: P.Tokens(TOKENS_MAX) },
			rate: P.Rate(2_000_000n)
		}
	]
}

interface Grant {
	readonly amount: bigint
	readonly end: bigint
}

interface Request {
	readonly start: bigint
	readonly tokens: bigint
}

interface Point {
	readonly grants: readonly [Grant, Grant]
	readonly requests: readonly [Request, Request, Request]
}

const amounts: Arr.NonEmptyReadonlyArray<bigint> = [1n, 3000n]

const ends: Arr.NonEmptyReadonlyArray<bigint> = [C, FAR]

const starts: Arr.NonEmptyReadonlyArray<bigint> = [C - 1n, C]

const inputs: Arr.NonEmptyReadonlyArray<bigint> = [1n, 1001n]

const grantGen: Gen<Grant> = (source) => ({
	amount: source.draw(element(amounts)),
	end: source.draw(element(ends))
})

const requestGen: Gen<Request> = (source) => ({
	start: source.draw(element(starts)),
	tokens: source.draw(element(inputs))
})

/** Every point of the box: the grants outermost, then the requests. */
export const box: Gen<Point> = (source) => ({
	grants: [source.draw(grantGen), source.draw(grantGen)],
	requests: [source.draw(requestGen), source.draw(requestGen), source.draw(requestGen)]
})

export type BoxFeature =
	| "an event exactly at the rate change"
	| "a grant expiring at an event's start"
	| "a grant expiring at an event's end"
	| "an event split across grants"
	| "a tier boundary crossed within one event"

/** A grant that paid part of a record is reached only once every earlier-expiring eligible grant is spent. */
export const spentInOrder = (
	r: P.UsageRecord,
	eligible: ReadonlyArray<{ readonly id: string }>,
	left: ReadonlyMap<string, bigint>
): void => {
	const paidBy = (grant: string): bigint =>
		Arr.reduce(
			Arr.filter(r.debits, (d) => d.grant === grant),
			0n,
			(sum: bigint, d) => sum + d.amount
		)
	for (const [i, g] of eligible.entries()) {
		if (paidBy(g.id) <= 0n) {
			continue
		}
		for (const earlier of eligible.slice(0, i)) {
			assert.equal(
				left.get(earlier.id) ?? 0n,
				paidBy(earlier.id),
				`${earlier.id} is spent before ${g.id}`
			)
		}
	}
}

/** A grant as the spending order reads it: its id and the end of its validity. */
interface Expiring {
	readonly id: string
	readonly valid: { readonly end: bigint }
}

/** Grants by the end of their validity, then by id: the order credits are spent in. */
export const grantOrder: Order.Order<Expiring> = Order.combine(
	Order.mapInput(Order.BigInt, (g: Expiring) => g.valid.end),
	Order.mapInput(Order.String, (g: Expiring) => g.id)
)

export const recordFacts = (r: P.UsageRecord): PlatformFacts => ({
	...noFacts,
	UsageEvent: [r.event],
	EventCharge: [r.total],
	UsageCharge: r.charges,
	ProviderCost: [r.cost],
	CreditDebit: r.debits
})

/**
 * A transient refusal, which the call runs again after (untilAnswered), as grizzle's contract asks of a `safe` one: it
 * changed nothing, so the box notes nothing of it.
 */
export const unnoted = (): void => undefined

export const decided = (db: PlatformDb, f: PlatformFacts): Effect.Effect<string, CallError> =>
	Effect.map(
		untilAnswered(answered(db.workload.load.once({ params: {}, facts: { insert: f } })), unnoted),
		(o) => (o.kind === "refused" ? `refused by ${Formatter.format(o.refused.laws)}` : o.kind)
	)

/** The platform with billing's workload, installed once per member: the template every point's seat clones. */
export const boxPlatform = platformTemplate(import.meta, "platform_box", () => [])
