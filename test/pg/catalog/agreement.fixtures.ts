/** What the property of agreement.test.ts reads: the catalog's entries, their space and its aims. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import type { Pending, Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	steered,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import type { Direction } from "#compiler/core/order.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { type CatalogResult } from "#compiler/lower/shapes/catalog/rewrite.ts"
import { aimedSteered } from "#test/support/aims.ts"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import * as Q from "#test/support/pg/catalog/queries.ts"
import { type Facts, factsGen, labFacts } from "#test/support/pg/catalog/support.ts"
import * as D from "#test/support/unit/check/dsl.ts"

/** The facts with a price of the first sitting's student, below 105, on the sitting's day and on the day before. */
const withPricedSitting = (f: Facts, amount: number): Facts => {
	const [first] = f.sittings
	const sitting = first ?? ([1000, 1, 6, 1] as const)
	const [, student, day] = sitting
	return {
		...f,
		sittings: first === undefined ? [sitting] : f.sittings,
		prices: [...f.prices, [1001, student, day, amount], [1002, student, day - 1, amount]]
	}
}

/** How a running aggregate's self-match is written: plainly, its first occurrence above 3, or one student fixed. */
type Running = "plain" | "first occurrence above 3" | "student 1 on both occurrences"

/** What a discrete percentile's selection reads: the ordinal joined on the group, an unjoined one, a running count. */
type Stage = "ordinal" | "unjoined ordinal" | "running count"

/**
 * A composition of the compile-target catalog (R26-R31, R41, R42), written as an author writes it (queries.ts), by the
 * shape its recognizer reads: each field a choice the composition's text makes, never its verdict.
 */
type Entry =
	| { readonly kind: "ordinal"; readonly dirs: readonly [Direction, Direction] }
	| { readonly kind: "running"; readonly running: Running }
	| {
			readonly kind: "bound neighbor"
			readonly direction: "next" | "previous"
			readonly restricted: boolean
			readonly parents: Q.Parents
	  }
	| {
			readonly kind: "attached neighbor"
			readonly direction: "next" | "previous"
			readonly parents: Q.Parents | "pointed"
	  }
	| {
			readonly kind: "as-of"
			readonly mode: "le" | "lt" | "ge"
			readonly attached: boolean
			readonly cheap: boolean
			readonly parents: Q.Parents
	  }
	| {
			readonly kind: "grouped share"
			readonly over: "Sitting" | "Price" | "filtered"
			readonly restricted: boolean
	  }
	| { readonly kind: "keyed share"; readonly restricted: boolean }
	| {
			readonly kind: "discrete percentile"
			readonly fractions: Arr.NonEmptyReadonlyArray<number>
			readonly stage: Stage
	  }
	| { readonly kind: "continuous percentile"; readonly p: number }
	| { readonly kind: "mode" }

const directionGen: Gen<Direction> = element(["asc", "desc"] as const)
const neighborGen: Gen<"next" | "previous"> = element(["next", "previous"] as const)
const parentsGen: Gen<Q.Parents> = element(["every", "keyed"] as const)

/** The largest denominator 2^j of a dyadic fraction the discrete rewrite admits (percentile.ts maxDyadicExponent). */
const admittedDenominator = 2 ** 7

/** A dyadic fraction in (0, 1] whose denominator the discrete rewrite admits: m / 2^j, j up to its largest. */
const admittedFraction: Gen<number> = (source) => {
	const j = source.draw(int(0, Math.log2(admittedDenominator)))
	return source.draw(int(1, 2 ** j)) / 2 ** j
}

/** Every catalog entry's shape, each kind equally often. */
const entryGen: Gen<Entry> = weighted<Entry>([
	[
		1,
		(source) => ({ kind: "ordinal", dirs: [source.draw(directionGen), source.draw(directionGen)] })
	],
	[
		1,
		(source) => ({
			kind: "running",
			running: source.draw(
				element(["plain", "first occurrence above 3", "student 1 on both occurrences"] as const)
			)
		})
	],
	[
		1,
		(source) => ({
			kind: "bound neighbor",
			direction: source.draw(neighborGen),
			restricted: source.draw(boolean),
			parents: source.draw(parentsGen)
		})
	],
	[
		1,
		(source) => ({
			kind: "attached neighbor",
			direction: source.draw(neighborGen),
			parents: source.draw(element(["every", "keyed", "pointed"] as const))
		})
	],
	[
		1,
		(source) => ({
			kind: "as-of",
			mode: source.draw(element(["le", "lt", "ge"] as const)),
			attached: source.draw(boolean),
			cheap: source.draw(boolean),
			parents: source.draw(parentsGen)
		})
	],
	[
		1,
		(source) => ({
			kind: "grouped share",
			over: source.draw(element(["Sitting", "Price", "filtered"] as const)),
			restricted: source.draw(boolean)
		})
	],
	[1, (source) => ({ kind: "keyed share", restricted: source.draw(boolean) })],
	[
		1,
		(source) => ({
			kind: "discrete percentile",
			fractions: nonEmpty(
				source.draw(array(admittedFraction, { min: 1, max: 2 })),
				"a percentile's fractions"
			),
			stage: source.draw(element(["ordinal", "unjoined ordinal", "running count"] as const))
		})
	],
	[
		1,
		(source) => {
			const j = source.draw(int(0, 3))
			return { kind: "continuous percentile", p: source.draw(int(0, 2 ** j)) / 2 ** j }
		}
	],
	[1, () => ({ kind: "mode" })]
])

const f8 = (value: number) => D.typedLit(value, Q.double)

/** The composition an entry is, as queries.ts writes it. */
export const descOf = (entry: Entry): QueryDesc => {
	switch (entry.kind) {
		case "ordinal":
			return Q.ordinal(entry.dirs)
		case "running":
			switch (entry.running) {
				case "plain":
					return Q.running(Q.plainSelfMatch)
				case "first occurrence above 3":
					return Q.running({
						...Q.plainSelfMatch,
						extra: [D.gt(D.ref("Sitting", "score"), f8(3))]
					})
				case "student 1 on both occurrences":
					return Q.running({ ...Q.plainSelfMatch, student: D.lit(1), keys: ["id"] })
			}
		case "bound neighbor":
			return Q.boundNeighbor(
				entry.direction,
				entry.restricted ? [D.gt(D.varRef("n.score"), f8(3))] : [],
				entry.parents
			)
		case "attached neighbor":
			return Q.attachedNeighbor(entry.direction, entry.parents)
		case "as-of": {
			const cheap = entry.cheap ? [D.lt(D.varRef("p.amount"), D.lit(105n))] : []
			return entry.attached
				? Q.attachedAsOf(entry.mode, cheap, entry.parents)
				: Q.boundAsOf(entry.mode, cheap, "day", entry.parents)
		}
		case "grouped share":
			return Q.groupedShare(entry.over, entry.restricted)
		case "keyed share":
			return Q.keyedShare(entry.restricted)
		case "discrete percentile":
			switch (entry.stage) {
				case "ordinal":
					return Q.discretePercentile(entry.fractions, Q.ordinalStage)
				case "unjoined ordinal":
					return Q.discretePercentile(entry.fractions, { ...Q.ordinalStage, joined: false })
				case "running count":
					return Q.discretePercentile(entry.fractions, { ...Q.ordinalStage, fold: "runningCount" })
			}
		case "continuous percentile":
			return Q.continuousPercentile(entry.p, "score")
		case "mode":
			return Q.modeOfDays("asc", Q.plainMode)
	}
}

/**
 * The rules the catalog's specification has its rewrite apply to an entry (README's catalog, R26-R42), a shape a
 * recognizer must refuse applying none, so a dropped condition shows as a wrong answer:
 *
 * - R26 rewrites an ordinal's self-join count in every direction; R41 a running aggregate, R26 its ordinal beside it;
 * - a neighbor or an as-of whose parents a key bounds keeps the LATERAL probe, bound or attached (neighbor.ts
 *   boundRegion, boundRows), a proof from keys;
 * - R27 a successor or predecessor of the parent's own source, bound or attached over parents no key bounds; a
 *   restricted source is no successor of the parent's, and R42's strict as-of mirror takes it;
 * - R42 an as-of in its ordered pass, bound or attached over parents no key bounds, its Q's own restriction before the
 *   union;
 * - R28 a share of the total grouped over the same relation, or keyed, unrestricted; a total bound to the count, or
 *   over another relation or a filtered one, is no share;
 * - R29 a discrete percentile of admitted fractions over a joined ordinal, R26 alone over an unjoined one, and R41 alone
 *   over a running conditional count, which is a fold and no position;
 * - R30 a continuous percentile; R31 the mode of days, ties to the smallest.
 */
export const rulesOf = (entry: Entry): ReadonlyArray<CertificateRule> => {
	switch (entry.kind) {
		case "ordinal":
			return ["R26"]
		case "running":
			return ["R26", "R41"]
		case "bound neighbor":
			return entry.parents === "keyed" ? [] : entry.restricted ? ["R42"] : ["R27"]
		case "attached neighbor":
			return entry.parents === "keyed" ? [] : ["R27"]
		case "as-of":
			return entry.parents === "keyed" ? [] : ["R42"]
		case "grouped share":
			return entry.over === "Sitting" && !entry.restricted ? ["R28"] : []
		case "keyed share":
			return entry.restricted ? [] : ["R28"]
		case "discrete percentile":
			switch (entry.stage) {
				case "ordinal":
					return ["R29"]
				case "unjoined ordinal":
					return ["R26"]
				case "running count":
					return ["R41"]
			}
		case "continuous percentile":
			return ["R30"]
		case "mode":
			return ["R31"]
	}
}

/**
 * Whether an entry's answer is empty on most facts, so its cases need not deliver a row: a count bound to another value,
 * parents restricted by a second occurrence or by sitting 1's key, which drawn facts may hold none of, and a selection
 * read through a stage that is no position.
 */
const mayDeliverNone = (entry: Entry): boolean => {
	switch (entry.kind) {
		case "attached neighbor":
			return entry.parents !== "every"
		case "bound neighbor":
		case "as-of":
			return entry.parents === "keyed"
		case "grouped share":
		case "keyed share":
			return entry.restricted
		case "discrete percentile":
			return entry.stage !== "ordinal"
		case "ordinal":
		case "running":
		case "continuous percentile":
		case "mode":
			return false
	}
}

/**
 * What a case of the catalog search reached: each entry kind, each rule the rewrite applied, none, a delivered row, and
 * R29 and R30 each applied to a percentile selecting -0 (selectsNegativeZero).
 */
export type AgreementFeature =
	| `entry ${Entry["kind"]}`
	| `applied ${CertificateRule}`
	| "applied none"
	| "delivers rows"
	| "R29 selecting -0"
	| "R30 selecting -0"

/**
 * The ordinals, from 1, a percentile entry selects in a group of n scores: ceil(p · n), at least the first, for each of
 * a discrete one's fractions; 1 + (n − 1)p for a continuous one's, where it is a whole ordinal, the value there its
 * answer; none for any other entry.
 */
const selectedOrdinals = (entry: Entry, n: number): ReadonlyArray<number> => {
	switch (entry.kind) {
		case "discrete percentile":
			return Arr.map(entry.fractions, (p) => Math.max(1, Math.ceil(p * n)))
		case "continuous percentile": {
			const at = 1 + (n - 1) * entry.p
			return Number.isInteger(at) ? [at] : []
		}
		case "ordinal":
		case "running":
		case "bound neighbor":
		case "attached neighbor":
		case "as-of":
		case "grouped share":
		case "keyed share":
		case "mode":
			return []
	}
}

/**
 * Whether a percentile entry selects -0 in a student's sittings that hold no +0: PERCENTILE_DISC and PERCENTILE_CONT at a
 * whole ordinal deliver the value there itself, so a native form that took no canonical zero delivers -0 where the
 * composition, whose head merges, delivers +0.
 */
export const selectsNegativeZero = (entry: Entry, facts: Facts): boolean =>
	Arr.some(Arr.dedupe(Arr.map(facts.sittings, ([, student]) => student)), (student) => {
		const scores = Arr.sort(
			Arr.flatMap(facts.sittings, ([, s, , score]) => (s === student ? [score] : [])),
			Order.Number
		)
		return (
			!Arr.some(scores, (x) => Object.is(x, 0)) &&
			Arr.some(selectedOrdinals(entry, scores.length), (k) => Object.is(scores[k - 1], -0))
		)
	})

/** The entry kinds, each a feature the search must reach. */
export const entryKinds: Arr.NonEmptyReadonlyArray<Entry["kind"]> = [
	"ordinal",
	"running",
	"bound neighbor",
	"attached neighbor",
	"as-of",
	"grouped share",
	"keyed share",
	"discrete percentile",
	"continuous percentile",
	"mode"
]

/** A case of the catalog search: an entry and the lab facts it runs over. */
type AgreementCase = Readonly<{ entry: Entry; facts: Facts }>

/**
 * The catalog's compositions as its hand-written suites ran them, over the lab's facts, kept: each replays before the
 * streams, judged by the same specification.
 */
const keptEntries: Arr.NonEmptyReadonlyArray<Entry> = [
	{ kind: "ordinal", dirs: ["asc", "asc"] },
	{ kind: "ordinal", dirs: ["desc", "desc"] },
	{ kind: "ordinal", dirs: ["desc", "asc"] },
	{ kind: "running", running: "plain" },
	{ kind: "running", running: "first occurrence above 3" },
	{ kind: "running", running: "student 1 on both occurrences" },
	{ kind: "bound neighbor", direction: "next", restricted: false, parents: "every" },
	{ kind: "bound neighbor", direction: "previous", restricted: false, parents: "every" },
	{ kind: "bound neighbor", direction: "next", restricted: true, parents: "every" },
	{ kind: "bound neighbor", direction: "next", restricted: false, parents: "keyed" },
	{ kind: "attached neighbor", direction: "next", parents: "every" },
	{ kind: "attached neighbor", direction: "previous", parents: "every" },
	{ kind: "attached neighbor", direction: "next", parents: "pointed" },
	{ kind: "attached neighbor", direction: "next", parents: "keyed" },
	...Arr.flatMap(["le", "lt", "ge"] as const, (mode): ReadonlyArray<Entry> => [
		{ kind: "as-of", mode, attached: false, cheap: false, parents: "every" },
		{ kind: "as-of", mode, attached: true, cheap: false, parents: "every" },
		{ kind: "as-of", mode, attached: true, cheap: false, parents: "keyed" },
		{ kind: "as-of", mode, attached: false, cheap: false, parents: "keyed" },
		{ kind: "as-of", mode, attached: false, cheap: true, parents: "every" }
	]),
	{ kind: "as-of", mode: "le", attached: true, cheap: true, parents: "every" },
	{ kind: "grouped share", over: "Sitting", restricted: false },
	{ kind: "keyed share", restricted: false },
	{ kind: "keyed share", restricted: true },
	{ kind: "grouped share", over: "Sitting", restricted: true },
	{ kind: "grouped share", over: "Price", restricted: false },
	{ kind: "grouped share", over: "filtered", restricted: false },
	{ kind: "discrete percentile", fractions: [0.5], stage: "ordinal" },
	{ kind: "discrete percentile", fractions: [0.25, 0.75], stage: "ordinal" },
	{ kind: "discrete percentile", fractions: [1], stage: "ordinal" },
	{ kind: "continuous percentile", p: 0.5 },
	{ kind: "continuous percentile", p: 0.25 },
	{ kind: "continuous percentile", p: 0 },
	{ kind: "discrete percentile", fractions: [0.5], stage: "unjoined ordinal" },
	{ kind: "discrete percentile", fractions: [0.5], stage: "running count" },
	{ kind: "mode" }
]

/**
 * The compositions the hand-written catalog suites ran, over the lab's facts, which 46b817cea kept so none of their
 * coverage was lost (no red in git log -S on the module), aimed at the entry kind each reaches: a case whose turn aims at
 * an entry kind draws one of that kind's compositions over the lab's facts.
 */
const keptAims: ReadonlyArray<readonly [Reached<AgreementFeature>, Gen<AgreementCase>]> =
	Arr.flatMap(entryKinds, (kind) =>
		Arr.match(
			Arr.filter(keptEntries, (entry) => entry.kind === kind),
			{
				onEmpty: () => [],
				onNonEmpty: (entries) => [
					[
						`entry ${kind}`,
						oneOf(Arr.map(entries, (entry) => constant<AgreementCase>({ entry, facts: labFacts })))
					] as const
				]
			}
		)
	)

/**
 * The facts with student 1's sittings one, on `day`, its score -0: a group of one score, which a percentile selects at
 * its one ordinal whatever its fraction, so a native form that took no canonical zero delivers -0 there
 * (selectsNegativeZero).
 */
const withNegativeZeroAlone = (f: Facts, day: number): Facts => ({
	...f,
	sittings: [[999, 1, day, -0], ...Arr.filter(f.sittings, ([, student]) => student !== 1)]
})

/**
 * A case as the generator draws it: an entry and the facts it runs over, aimed at a delivered row while no witness has
 * delivered one (Steered): for an entry that delivers a row on most facts (mayDeliverNone), half its cases, by a draw of
 * their own, are priced for their first sitting (withPricedSitting); and at R29 or R30 selecting -0 while none has, which
 * the drawn facts seldom meet, half its cases are a discrete percentile read at its ordinal (R29) or a continuous one
 * (R30) over facts whose student 1 holds one sitting at -0 (withNegativeZeroAlone); a rotating case is drawn unaimed.
 */
const agreementCaseOf =
	(steering: Option.Option<Pending<AgreementFeature>>): Gen<AgreementCase> =>
	(source) => {
		const facts = source.draw(factsGen)
		const pendingZero = Arr.filter(["R29 selecting -0", "R30 selecting -0"] as const, (feature) =>
			Option.exists(steering, (pending) => pending.has(feature))
		)
		if (Arr.isReadonlyArrayNonEmpty(pendingZero) && source.draw(boolean)) {
			const zeroFacts = withNegativeZeroAlone(facts, source.draw(int(1, 12)))
			if (source.draw(element(pendingZero)) === "R29 selecting -0") {
				return {
					entry: {
						kind: "discrete percentile",
						fractions: [source.draw(admittedFraction)],
						stage: "ordinal"
					},
					facts: zeroFacts
				}
			}
			const j = source.draw(int(0, 3))
			return {
				entry: { kind: "continuous percentile", p: source.draw(int(0, 2 ** j)) / 2 ** j },
				facts: zeroFacts
			}
		}
		const entry = source.draw(entryGen)
		return {
			entry,
			facts:
				!mayDeliverNone(entry) &&
				Option.exists(steering, (pending) => pending.has("delivers rows")) &&
				source.draw(boolean)
					? withPricedSitting(facts, source.draw(int(0, 104)))
					: facts
		}
	}

/** The native targets a rewrite names: its windows' and ordered-set aggregates' overloads. */
export const nativeTargets = (rewritten: CatalogResult): ReadonlyArray<string> =>
	Arr.flatMap(topoOrder(rewritten.dag), (n): ReadonlyArray<string> =>
		n.kind === "Window" || n.kind === "OrderedSetAggregate" ? [n.op] : []
	)

/** The catalog's cases, aimed at each entry kind its kept compositions reach and at a delivered row. */
export const agreementSpace = aimedSteered(steered(agreementCaseOf), keptAims)
