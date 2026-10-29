import { constant, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { type Swarm, swarm, weightOf } from "@grizzle/testing/swarm"
import { type Array as Arr, Record } from "effect"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import type {
	Action,
	ActionKind,
	ActionWeights,
	ModelState,
	Outcome,
	SmallScope,
	ValidityWeights
} from "#test/support/worlds/model/types.ts"

/** Every action kind, each once: a kind the vocabulary adds is a compile error here until it is listed. */
const kindOf: { readonly [K in ActionKind]: K } = {
	"open-db": "open-db",
	read: "read",
	apply: "apply",
	refresh: "refresh",
	close: "close",
	"direct-begin": "direct-begin",
	direct: "direct",
	"direct-end": "direct-end",
	interrupt: "interrupt",
	migrate: "migrate",
	tamper: "tamper",
	drift: "drift",
	wild: "wild"
}

/** Every action kind, opening a session first: the floor a choice with no weight falls back to. */
export const actionKinds: Arr.NonEmptyReadonlyArray<ActionKind> = knownNonEmpty(
	Record.values(kindOf),
	"the action kinds"
)

/**
 * Whether a kind draws an action carrying no invalid input in some state: every kind but those invalid by nature, an
 * interrupt (session:interrupted), a catalog change (catalog:*) and a wild JavaScript value (handle:wild-js-value).
 */
export const drawsLive: { readonly [K in ActionKind]: boolean } = {
	"open-db": true,
	read: true,
	apply: true,
	refresh: true,
	close: true,
	"direct-begin": true,
	direct: true,
	"direct-end": true,
	interrupt: false,
	migrate: true,
	tamper: false,
	drift: true,
	wild: false
}

/**
 * The roles a run opens a Db as, its own role named: every role the installation holds, or a suite's focus, which no
 * open of an own role leaves (an installation holding none of them offers only opens naming no own role).
 */
export type RoleFocus =
	| { readonly kind: "every" }
	| { readonly kind: "only"; readonly roles: Arr.NonEmptyReadonlyArray<string> }

/** The focus of no role in particular. */
export const everyRole: RoleFocus = { kind: "every" }

/**
 * What an aimed draw reaches for: features a suite requires, or the move a lead constructs; `read`, the suite's feature
 * map of one outcome (features.ts featuresOf for the worlds suites); `worth`, which actions the box offers are worth
 * the model's step at all, read of the action alone (every one, for a feature map that reads every outcome); and
 * `scope`, the box the candidates come from (generate/enumerate.ts enumerateKind).
 */
export interface Aiming {
	readonly features: Arr.NonEmptyReadonlyArray<string>
	readonly read: (state: ModelState, action: Action, observation: Outcome) => ReadonlyArray<string>
	readonly worth: (action: Action, state: ModelState) => boolean
	readonly scope: SmallScope
}

/** Every action worth a step: the worth of a feature map that reads every outcome. */
export const everyActionWorth: (action: Action, state: ModelState) => boolean = (): boolean => true

/**
 * The features a run aims at: none; on half its draws (`half`); or on every draw (`every`), a lead's constructed move.
 * An aimed draw, wherever an action the exhaustive box offers in the state (enumerateKind, within the run's kinds and
 * role focus) reaches one of them as the model predicts it, takes one: a feature among those the state can reach next,
 * evenly, then an action reaching it, evenly. So a required feature one step away is reached by construction, not by
 * its share of chance.
 */
export type Aims =
	| { readonly kind: "none" }
	| ({ readonly kind: "half" } & Aiming)
	| ({ readonly kind: "every" } & Aiming)

/** Aiming at nothing in particular. */
export const noAims: Aims = { kind: "none" }

/**
 * The run's weights: one per action kind, the live, stale and wild shares of every drawn input, the kinds the run may
 * draw at all (a suite's focus, or every kind), which no fallback leaves, the roles it opens a Db as, and the features
 * it aims at.
 */
export interface Weights {
	readonly actions: ActionWeights
	readonly validity: ValidityWeights
	readonly kinds: Arr.NonEmptyReadonlyArray<ActionKind>
	readonly roles: RoleFocus
	readonly aims: Aims
}

/** Each action kind's weight under a drawn swarm, as a typed record. */
const weightsOf = (drawn: Swarm<ActionKind>): ActionWeights =>
	Record.map(kindOf, (kind) => weightOf(drawn, kind))

/** An invalid share of the validity weights: off half the time, otherwise 1 to 9, so a run can be 90% stale or all live. */
const shareGen: Gen<number> = oneOf([constant(0), int(1, 9)])

/**
 * The live share: 1 to 9, never off. A run whose live share is zero opens no session wherever the state offers an
 * invalid open, so it draws nothing past a refused open: every session's action, every write, read and commit, is
 * unreachable in it, and it reaches no feature a run of refusals at the open does not.
 */
const liveShareGen: Gen<number> = int(1, 9)

/**
 * A run's weights, drawn fresh per run (swarm testing): each action kind's weight is a swarm gate's (off, or 1 to 3,
 * the omission rate itself drawn per run), so some runs never tamper and others do little else; and a live share of
 * 1 to 9 beside stale and wild shares of 0 to 9 each, so some runs are lopsided (nine stale tokens in ten) and some
 * draw no invalid input at all. A weight of zero everywhere is a run like any other: actionGen's forced moves keep it going.
 */
export const weightsGen: Gen<Weights> = (source) => {
	const actions = weightsOf(source.draw(swarm(actionKinds)))
	const live = source.draw(liveShareGen)
	const stale = source.draw(shareGen)
	const wild = source.draw(shareGen)
	return {
		actions,
		validity: { live, stale, wild },
		kinds: actionKinds,
		roles: everyRole,
		aims: noAims
	}
}

/** The weights that weigh nothing: every action kind and every validity share at zero. */
export const zeroWeights: Weights = {
	actions: {
		"open-db": 0,
		read: 0,
		apply: 0,
		refresh: 0,
		close: 0,
		"direct-begin": 0,
		direct: 0,
		"direct-end": 0,
		interrupt: 0,
		migrate: 0,
		tamper: 0,
		drift: 0,
		wild: 0
	},
	validity: { live: 0, stale: 0, wild: 0 },
	kinds: actionKinds,
	roles: everyRole,
	aims: noAims
}
