import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Pending as Unreached, Reached, Situations } from "@bjornpagen/testing/features"
import {
	element,
	type Gen,
	int,
	map,
	oneOf,
	steered as steeredSpace,
	type Steered
} from "@bjornpagen/testing/gen"
import {
	type Budget,
	type Case,
	type Kept,
	type Kill,
	type Property,
	property
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Predicate, Record, type Scope, String as Str } from "effect"
import { type AmbientSession, ambientFeatures, ambientSessionGen } from "#test/support/ambient.ts"
import { isImmediate, relationOf, sameValue, valueText } from "#test/support/laws/model.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type SubstrateShape, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import {
	checkStart,
	type ModelMismatch,
	type Noting,
	runStep
} from "#test/support/worlds/drive/index.ts"
import { type RealWorld, realizeRace } from "#test/support/worlds/execute/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import type { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import {
	deletedBy,
	featuresOf,
	reachOf,
	requiredWorldFeatures
} from "#test/support/worlds/features.ts"
import { actionGen, offeredOf, withOpener } from "#test/support/worlds/generate/action.ts"
import { knownNonEmpty, pool } from "#test/support/worlds/generate/domain.ts"
import {
	defaultScope,
	enumerateKind,
	enumerateThrough
} from "#test/support/worlds/generate/enumerate.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import {
	dictionaryNamed,
	nameFeatures,
	namesCatalogType,
	ownConversions
} from "#test/support/worlds/generate/names.ts"
import { reaches } from "#test/support/worlds/generate/reads.ts"
import { lawfulOf, realityGen } from "#test/support/worlds/generate/reality.ts"
import {
	actionKinds,
	type Aiming,
	type Aims,
	everyActionWorth,
	everyRole,
	noAims,
	type RoleFocus,
	type Weights,
	weightsGen,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { invalidKinds } from "#test/support/worlds/invalid/kinds.ts"
import {
	docsBases,
	docsEditorInstall,
	docsInstall,
	docsLevelInstall,
	docsOneShareEditorInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { classifyEntry, hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { entryContexts } from "#test/support/worlds/model/session/state.ts"
import { writtenOf } from "#test/support/worlds/model/session/writes.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	Allowed,
	BaseSpec,
	Branch,
	EntrySpec,
	HostFact,
	HostSchema,
	HostState,
	HostValue,
	InstallSpec,
	InvalidKind,
	ModelState,
	ActionOutcome,
	RoleSpec,
	SmallScope,
	WorldFeature,
	Writer
} from "#test/support/worlds/model/types.ts"

/**
 * An outcome the model allows an action, a landing completed under the compiler's names for the installation it lands
 * (execute/names.ts installedNames): a lead reads the model alone, ahead of the real system.
 */
const settled = (outcome: Allowed): Branch => settle(outcome, installedNames)

/** A reading of an action's outcomes as an aim reads them: the action read once, then each outcome's observation. */
const outcomeRead =
	<F extends string>(reading: FeatureReading<F>): Aiming["read"] =>
	(state, action) => {
		const of = reading(state, action)
		return (outcome) => of(outcome.observation)
	}

/** The features the driver notes of an action (features.ts featuresOf), as a lead's read of its outcomes. */
const noted: Aiming["read"] = outcomeRead(featuresOf)

/**
 * The box an aimed draw takes its candidates from (Aiming.scope): the exhaustive box's, with two contexts, so the
 * tokens a Db opens with and the claims a direct writer begins under claim both contexts of the documents base at once,
 * as a real user's do, besides each alone; the box's own single context would leave every write under both a role's
 * contexts to chance.
 */
export const aimScope: SmallScope = { ...defaultScope, contexts: 2 }

/** The action kinds a suite draws: every program it runs draws only these, whatever its weights. */
export type Focus = Arr.NonEmptyReadonlyArray<ActionKind>

/** Every action kind: the focus of a suite that draws them all. */
export const everyAction: Focus = actionKinds

/**
 * How a suite draws a case's reality from its base and the host schema the installation's names give: realityGen's
 * lawful realities, or a mix a suite targets at situations they rarely hold (docsTenantRealities).
 */
export type Realities = (base: BaseSpec, host: HostSchema) => Gen<HostState>

/** The lawful realities of a base, as realityGen draws them. */
export const drawnRealities = (base: BaseSpec, host: HostSchema): Gen<HostState> =>
	realityGen(base, host)

/** The facts of a relation in a reality. */
const factsOf = (reality: HostState, relation: string): ReadonlyArray<HostFact> =>
	reality.get(relation) ?? []

/**
 * A documents reality narrowed to one tenant: every document of the organization of its first, every share and note on
 * one of them, in turn, and the whole repaired to lawful (a document's words unique in its organization, at most two
 * shares a document); a reality holding no document is unchanged. Under the Tenant claims of that organization a role's
 * entries over the tenant's documents hold every share and note, so a statement over a whole table meets no fact hidden
 * from it: a share outside the entry it goes through is visible through another.
 */
const oneTenant = (host: HostSchema, reality: HostState): HostState => {
	const docs = factsOf(reality, "Doc")
	const org = Arr.head(docs).pipe(Option.flatMap((d) => Option.fromNullishOr(d["org"])))
	const ids = Arr.flatMap(docs, (d) => Option.toArray(Option.fromNullishOr(d["id"])))
	const [firstId] = ids
	if (Option.isNone(org) || firstId === undefined) {
		return reality
	}
	const onDocs = (facts: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> =>
		Arr.map(facts, (f, i): HostFact => ({
			...f,
			doc: Option.getOrElse(Arr.get(ids, i % ids.length), () => firstId)
		}))
	const narrowed: ReadonlyArray<readonly [string, ReadonlyArray<HostFact>]> = Arr.map(
		[...reality],
		([name, facts]) => [
			name,
			name === "Doc"
				? Arr.map(facts, (d): HostFact => ({ ...d, org: org.value }))
				: name === "Share" || name === "Note"
					? onDocs(facts)
					: facts
		]
	)
	return lawfulOf(host, new Map(narrowed))
}

/** An aim on every draw at `features`, read of an outcome through `read`, among the candidates `worth` admits. */
const everyDraw = (
	features: Arr.NonEmptyReadonlyArray<string>,
	read: Aiming["read"],
	worth: Aiming["worth"]
): Aims => ({ kind: "every", features, read, worth, scope: aimScope })

/** Whether an action is a statement or the end of the direct writer's transaction the state holds. */
const ofTheTransaction = (action: Action, state: ModelState): boolean =>
	(action.kind === "direct" || action.kind === "direct-end") &&
	state.sessions[action.session]?.kind === "direct"

/** The transaction a lead began ended, whatever the COMMIT or ROLLBACK answered: a lead's own move. */
const transactionEnded = "lead:the transaction ended" as const

/**
 * What the end of a transaction reaches, read of its outcome: the features it notes, and its ending, when it is the end
 * of the transaction the state holds: COMMIT and ROLLBACK end it whatever they answer, an aborted one included.
 */
const endingRead = (
	state: ModelState,
	action: Action
): ((outcome: Allowed) => ReadonlyArray<WorldFeature | typeof transactionEnded>) => {
	const read = featuresOf(state, action)
	const ending =
		action.kind === "direct-end" && ofTheTransaction(action, state) ? [transactionEnded] : []
	return (outcome) => [...read(outcome.observation), ...ending]
}

/**
 * A lead's last move, the end of the transaction it began: aimed on every draw at `features` and at the ending itself,
 * among the ends of that transaction alone, so it ends the transaction even when a refusal aborted it, whose end no
 * live draw names (generate/action.ts sessionStrata), and the program's own draws meet no transaction they did not
 * begin.
 */
const endingIt = (weights: Weights, features: ReadonlyArray<string>): Weights => ({
	...weights,
	kinds: ["direct-end"],
	actions: { ...zeroWeights.actions, "direct-end": 1 },
	validity: liveOnly,
	aims: everyDraw(
		Arr.append(features, transactionEnded),
		endingRead,
		(a, s) => a.kind === "direct-end" && ofTheTransaction(a, s)
	)
})

/**
 * What the transaction an action begins reaches next, read of the BEGIN's outcome: every feature a statement the box
 * offers it, or its end, reaches as the model predicts them. An aimed BEGIN is one from which a pending feature is one
 * statement away: the role it takes on and the claims it sets decide which facts lie inside, outside and hidden from
 * the world each statement meets, which no draw after the BEGIN can change.
 */
const afterBegin =
	(_state: ModelState, action: Action) =>
	(outcome: Allowed): ReadonlyArray<WorldFeature> => {
		const { observation: began, next } = settled(outcome)
		if (action.kind !== "direct-begin" || began.kind !== "opened") {
			return []
		}
		return Arr.flatMap(
			[
				...enumerateThrough(next, "direct", began.session, defaultScope),
				...enumerateThrough(next, "direct-end", began.session, defaultScope)
			],
			(a) => reachOf(next, a)
		)
	}

/** Whether an action is a BEGIN, any the box offers. */
const everyBegin = (action: Action): boolean => action.kind === "direct-begin"

/** How a lead aims its BEGIN: at what `read` finds the BEGIN's outcome reaches, among the box's BEGINs `worth` admits. */
interface BeginAim {
	readonly read: Aiming["read"]
	readonly worth: (action: Action) => boolean
}

/** A live BEGIN aimed on every draw at `targets` as `begin` aims it. */
const aimedBegin = (
	weights: Weights,
	targets: Arr.NonEmptyReadonlyArray<string>,
	begin: BeginAim
): Weights => ({
	...weights,
	kinds: ["direct-begin"],
	actions: { ...zeroWeights.actions, "direct-begin": 1 },
	validity: liveOnly,
	aims: everyDraw(targets, begin.read, begin.worth)
})

/**
 * A live statement of the transaction the state holds, aimed on every draw at `targets`, read of its outcome through
 * `read`.
 */
const aimedStatement = (
	weights: Weights,
	targets: Arr.NonEmptyReadonlyArray<string>,
	read: Aiming["read"]
): Weights => ({
	...weights,
	kinds: ["direct"],
	actions: { ...zeroWeights.actions, direct: 1 },
	validity: liveOnly,
	aims: everyDraw(targets, read, (a, s) => a.kind === "direct" && ofTheTransaction(a, s))
})

/**
 * A lead's transaction: a BEGIN aimed as `begin` aims it, three statements of its transaction each aimed at the required
 * features the program has not reached yet, and its end, aimed likewise (endingIt), so the lead closes what it opened
 * and the program's own draws meet no transaction they did not begin. It runs while a feature it aims at is pending:
 * the BEGIN's look-ahead decides which of them the transaction's statements reach, so every one a statement carries has
 * its lead, the invalid inputs of a statement and the law its refusal names included.
 */
const transactionLead =
	(required: ReadonlyArray<Reached<WorldFeature>>, begin: BeginAim): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, () => true)
		if (first === undefined) {
			return []
		}
		const statement = aimedStatement(weights, [first, ...rest], noted)
		return whilePending([first, ...rest], at, () => [
			aimedBegin(weights, [first, ...rest], begin),
			statement,
			statement,
			statement,
			endingIt(weights, [first, ...rest])
		])
	}

/**
 * A lead for a suite requiring a direct writer's statements (transactionLead): a BEGIN from which a required feature
 * still pending is one statement away (afterBegin, aimed on every draw among the box's starts: as the login or one of
 * its roles, under no claims, each choice of claims, a context alone, or malformed claims).
 */
export const directTransaction = (required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	transactionLead(required, { read: afterBegin, worth: everyBegin })

/**
 * What the Db an action opens reaches next through the calls of `kinds`, read of the open's outcome: every feature such
 * a call the box offers through it reaches as the model predicts them, by the suite's reading of a call's outcome
 * (`read`). The token's claims decide which facts lie inside, outside and hidden from the entries each call goes
 * through, which no draw after the open can change, so an aimed open is one from which a pending feature is one call
 * away. An input past the limit is refused before any fact is read, so the read of what an open reaches leaves it out.
 */
const afterOpen =
	(kinds: ReadonlyArray<"read" | "apply">, read: Aiming["read"]) =>
	(_state: ModelState, action: Action) =>
	(outcome: Allowed): ReadonlyArray<string> => {
		const { observation: opened, next } = settled(outcome)
		if (action.kind !== "open-db" || opened.kind !== "opened") {
			return []
		}
		return Arr.flatMap(kinds, (kind) =>
			Arr.flatMap(enumerateThrough(next, kind, opened.session, defaultScope), (a) =>
				Arr.flatMap(step(next, a), read(next, a))
			)
		)
	}

/** Whether an action is a call through an open Db the state holds. */
const ofAnOpenDb = (action: Action, state: ModelState): boolean =>
	(action.kind === "read" || action.kind === "apply") &&
	state.sessions[action.session]?.kind === "db"

/**
 * A live open from which one of `targets` is one call of `calls` away, through the Db it opens (afterOpen), aimed on
 * every draw among the box's opens: each role's live tokens, under both of its contexts or one, and its invalid ones.
 */
const aimedOpen = (
	weights: Weights,
	targets: Arr.NonEmptyReadonlyArray<string>,
	calls: ReadonlyArray<"read" | "apply">
): Weights => ({
	...weights,
	kinds: ["open-db"],
	actions: { ...zeroWeights.actions, "open-db": 1 },
	validity: liveOnly,
	aims: everyDraw(targets, afterOpen(calls, noted), (a) => a.kind === "open-db")
})

/**
 * A lead for a suite requiring a Db's reads and applies: an open from which a required feature still pending is one
 * call away (aimedOpen), three calls through it, apply, read and apply, those of the suite's kinds, each aimed at the
 * required features the program has not reached yet, and the Db's close. It runs while a feature it aims at is pending:
 * the open's look-ahead decides which of them a Db's calls reach, so every one a call carries has its lead, the invalid
 * inputs of an apply and the law its refusal names included.
 */
export const dbSession =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, () => true)
		if (first === undefined) {
			return []
		}
		const call = (kind: "read" | "apply"): Weights => ({
			...weights,
			kinds: withOpener(kind),
			actions: { ...zeroWeights.actions, [kind]: 1 },
			validity: liveOnly,
			aims: everyDraw([first, ...rest], noted, (a, s) => a.kind === kind && ofAnOpenDb(a, s))
		})
		const calls = Arr.filter(["apply", "read", "apply"] as const, (kind) =>
			Arr.contains(weights.kinds, kind)
		)
		return whilePending([first, ...rest], at, () => [
			aimedOpen(weights, [first, ...rest], calls),
			...Arr.map(calls, call),
			{
				...weights,
				kinds: withOpener("close"),
				actions: { ...zeroWeights.actions, close: 1 },
				validity: liveOnly
			}
		])
	}

/**
 * What a tamper reaches next through a complete migrate, read of the tamper's outcome: every feature such a migrate the
 * box offers from the state it leaves reaches as the model predicts it (noted).
 */
const afterTampering =
	(_state: ModelState, action: Action) =>
	(outcome: Allowed): ReadonlyArray<string> => {
		if (action.kind !== "tamper") {
			return []
		}
		const { next } = settled(outcome)
		return Arr.flatMap(
			Arr.filter(
				enumerateKind(next, "migrate", defaultScope),
				(a: Action): boolean => a.kind === "migrate" && a.how === "complete"
			),
			(a: Action) => Arr.flatMap(step(next, a), noted(next, a))
		)
	}

/**
 * A lead for a suite requiring a migrate over each perturbation of the catalog: a tamper from which a required feature
 * still pending is one complete migrate away (afterTampering, aimed on every draw among the box's perturbations), then
 * that migrate, aimed at the same features.
 */
export const tamperThenMigrate =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, () => true)
		if (first === undefined) {
			return []
		}
		return whilePending([first, ...rest], at, () => [
			{
				...weights,
				kinds: ["tamper"],
				actions: { ...zeroWeights.actions, tamper: 1 },
				validity: { live: 0, stale: 0, wild: 1 },
				aims: everyDraw([first, ...rest], afterTampering, (a) => a.kind === "tamper")
			},
			{
				...weights,
				kinds: ["migrate"],
				actions: { ...zeroWeights.actions, migrate: 1 },
				validity: liveOnly,
				aims: everyDraw(
					[first, ...rest],
					noted,
					(a) => a.kind === "migrate" && a.how === "complete"
				)
			}
		])
	}

/**
 * A live call of a kind through an open Db the state holds, aimed on every draw at `targets`, read of its outcome
 * through `read`; a state holding no Db to call through opens one instead (withOpener).
 */
const dbCall = (
	weights: Weights,
	kind: "read" | "apply",
	targets: Arr.NonEmptyReadonlyArray<string>,
	read: Aiming["read"]
): Weights => ({
	...weights,
	kinds: withOpener(kind),
	actions: { ...zeroWeights.actions, [kind]: 1 },
	validity: liveOnly,
	aims: everyDraw(targets, read, (a, s) => a.kind === kind && s.sessions[a.session]?.kind === "db")
})

/**
 * What a COMMIT right after a direct statement reaches, read of the statement's outcome: the features of the
 * transaction's COMMIT, as the model predicts it, in each state the statement leaves. A law checked at COMMIT (a deferred
 * foreign key) that the statement breaks shows only there.
 */
const commitAfter =
	(_state: ModelState, action: Action) =>
	(outcome: Allowed): ReadonlyArray<WorldFeature> => {
		if (action.kind !== "direct") {
			return []
		}
		const { next } = settled(outcome)
		const commit: Action = { kind: "direct-end", session: action.session, end: "commit" }
		return reachOf(next, commit)
	}

/**
 * The documents base's realities for a suite whose situations need one tenant's facts: half of them drawn as
 * realityGen draws them, half narrowed to one tenant (oneTenant); another base's, realityGen's.
 */
export const docsTenantRealities = (base: BaseSpec, host: HostSchema): Gen<HostState> =>
	docsBases.includes(base)
		? oneOf([
				realityGen(base, host),
				map(realityGen(base, host), (reality) => oneTenant(host, reality))
			])
		: realityGen(base, host)

/**
 * A documents reality whose first document is shared as often as its base admits (once over the one-share variant, by
 * its key on Share's `doc`), by subjects the reality holds (a document's owner, a share's user, a note's author) that do
 * not share it yet, and the whole repaired to lawful: a writer adding its own share of that document breaks the key
 * there. A reality over a base with no such key, with no document, or with no subject to share it with, keeps what it
 * has.
 */
const atBound = (base: BaseSpec, host: HostSchema, reality: HostState): HostState => {
	const [doc] = Arr.flatMap(factsOf(reality, "Doc"), (d) =>
		Option.toArray(Option.fromNullishOr(d["id"]))
	)
	const keyed = Arr.some(
		base.laws,
		(law) =>
			law.kind === "key" &&
			law.relation === "Share" &&
			law.fields.length === 1 &&
			law.fields[0] === "doc"
	)
	const bound = 1
	if (doc === undefined || !keyed) {
		return reality
	}
	const shares = factsOf(reality, "Share")
	const sharing = new Set(
		Arr.flatMap(shares, (s) => {
			const user = s["user"]
			return sameValue(s["doc"], doc) && user !== undefined ? [valueText(user)] : []
		})
	)
	const users: ReadonlyArray<HostValue | undefined> = [
		...Arr.map(factsOf(reality, "Doc"), (d) => d["owner"]),
		...Arr.map(shares, (s) => s["user"]),
		...Arr.map(factsOf(reality, "Note"), (n) => n["author"])
	]
	const subjects = Arr.dedupeWith(
		Arr.flatMap(users, (user) =>
			user === undefined || sharing.has(valueText(user)) ? [] : [user]
		),
		(a: HostValue, b: HostValue) => sameValue(a, b)
	)
	const added = Arr.map(
		Arr.take(subjects, Math.max(0, bound - sharing.size)),
		(user): HostFact => ({ doc, user })
	)
	return lawfulOf(host, new Map(reality).set("Share", [...shares, ...added]))
}

/**
 * A reality with a chain at each ordinary relation's first pair of fields a recursive read chains (reads.ts reaches):
 * two facts, a first fact's copy at `from` a and `to` b and another at `from` b and `to` c, a, b and c three distinct
 * values of the pair's pool, beside the relation's facts that share no key with either (its primary key and every key
 * a law declares), so every role relation that keeps the pair and both facts reads a pair past one step; repaired to
 * lawful (lawfulOf), which drops what a dropped fact held up. A relation with no fact, no such pair, or a pool of fewer
 * than three values is left as it is.
 */
const chainedOf = (base: BaseSpec, host: HostSchema, reality: HostState): HostState => {
	const chained = Arr.reduce(base.relations, reality, (at, relation) => {
		const facts = factsOf(at, relation.name)
		const [fact] = facts
		const [pair] = Arr.flatMap(reaches(relation.fields), (via) =>
			via.kind === "reach" ? [via] : []
		)
		const domain = Option.getOrUndefined(
			Option.map(
				Arr.findFirst(relation.fields, (f) => f.name === pair?.from),
				(f) => f.domain
			)
		)
		const [a, b, c] = domain === undefined ? [] : Arr.dedupeWith(pool(domain), sameValue)
		if (
			fact === undefined ||
			pair === undefined ||
			a === undefined ||
			b === undefined ||
			c === undefined
		) {
			return at
		}
		const links: ReadonlyArray<HostFact> = [
			{ ...fact, [pair.from]: a, [pair.to]: b },
			{ ...fact, [pair.from]: b, [pair.to]: c }
		]
		const keys = [
			relationOf(host, relation.name).key,
			...Arr.flatMap(host.laws, (law) =>
				law.kind === "key" && law.relation === relation.name ? [law.fields] : []
			)
		]
		const clashes = (f: HostFact): boolean =>
			Arr.some(keys, (key) =>
				Arr.some(links, (link) => Arr.every(key, (field) => sameValue(f[field], link[field])))
			)
		return new Map(at).set(relation.name, [...Arr.filter(facts, (f) => !clashes(f)), ...links])
	})
	return lawfulOf(host, chained)
}

/**
 * The documents bases' realities for a suite whose reads need a recursive read past one step: docsTenantRealities'
 * draws, each with a chain planted at every relation a recursive read chains (chainedOf), so a role relation holding
 * the pair and the facts reads one whatever the drawn reality held, and the reads lead aims a recursive read at it.
 */
export const docsChainedRealities = (base: BaseSpec, host: HostSchema): Gen<HostState> =>
	map(docsTenantRealities(base, host), (reality) => chainedOf(base, host, reality))

/**
 * The documents bases' realities for a suite whose refusals need a document at its bound of shares: docsTenantRealities'
 * draws, half of them with the first document holding as many shares as its base admits (atBound), so a writer adding
 * its own share of that document breaks the one-share variant's key on Share's `doc`, a unique index.
 */
export const docsAtBoundRealities = (base: BaseSpec, host: HostSchema): Gen<HostState> =>
	docsBases.includes(base)
		? oneOf([
				docsTenantRealities(base, host),
				map(docsTenantRealities(base, host), (reality) => atBound(base, host, reality))
			])
		: realityGen(base, host)

/**
 * A program case: an installation and the ambient session its owner sessions start under
 * (test/support/ambient.ts), the case's swarm weights (its kinds the suite's focus), the weights of its lead's draws,
 * what its steering left pending, resolved as it was drawn (PendingFeatures), and how many actions its program runs
 * after them. The property draws the rest from the case's own tape (`Case.draw`): the reality once the installation's
 * names exist, and each action from the model's state as the program reaches it, so every draw replays and shrinks
 * with the case.
 */
export interface ProgramCase {
	readonly install: InstallSpec
	readonly ambient: AmbientSession
	readonly weights: Weights
	readonly lead: Lead
	/** Whether the program takes a targeted lead (Leading). */
	readonly led: boolean
	readonly pending: PendingFeatures
	readonly steps: number
}

/** How a case draws past its sketch: from its own tape (`Case.draw`), so the draw replays and shrinks with the case. */
export type CaseDraw = Case<WorldFeature>["draw"]

/**
 * What a case's steering left pending, resolved by the generator that drew it (pendingOf) and kept in its sketch, so a
 * kept case and a replay aim as the case drawn did: none where it was drawn under no steering (the rotating stream),
 * so it aims at nothing; otherwise each feature of the worlds feature map and of the suite's own requirements that a
 * required situation the run had not reached when the case's window began names.
 */
export type PendingFeatures = Option.Option<ReadonlyArray<string>>

/**
 * What a case's pending features (PendingFeatures) leave pending of an aim, any text: none where the case was drawn
 * under no steering, so it aims at nothing; otherwise whether the aim is one of them, or no feature of the worlds
 * feature map or of the suite's own requirements at all, a lead's own move among them, which no case notes.
 */
export type Pending = Option.Option<(aim: string) => boolean>

/** The features of required situations, each pair as its two features. */
const featuresIn = <F extends string>(required: ReadonlyArray<Reached<F>>): ReadonlyArray<F> =>
	Arr.flatMap(required, (r): ReadonlyArray<F> => (Predicate.isString(r) ? [r] : r))

/** Every feature of the worlds feature map: the features a suite requires, and so the ones it aims at. */
const requirable: ReadonlyArray<WorldFeature> = featuresIn<WorldFeature>(requiredWorldFeatures)

/**
 * Every feature a case's aims may name as a requirement: each of the worlds feature map (requirable) and each of the
 * suite's own requirements `required`.
 */
const namedOf = <F extends string>(
	required: ReadonlyArray<Reached<F | WorldFeature>>
): ReadonlyArray<F | WorldFeature> => [...requirable, ...featuresIn<F | WorldFeature>(required)]

/**
 * What the steering a case is drawn under leaves pending (PendingFeatures): each feature named (namedOf) that a required
 * situation still pending names, so a feature a suite of its own requires (an education role's write, say) is pending
 * only while it is. A generator resolves it into the sketch it draws.
 */
export const pendingOf = <F extends string>(
	steering: Option.Option<Unreached<F | WorldFeature>>,
	required: ReadonlyArray<Reached<F | WorldFeature>>
): PendingFeatures =>
	Option.map(steering, (unreached) =>
		Arr.fromIterable(new Set<string>(Arr.filter(namedOf<F>(required), (f) => unreached.names(f))))
	)

/** A case's pending aims (Pending), read of its pending features as resolved of the suite's requirements `required`. */
const pendingIn = <F extends string>(
	features: PendingFeatures,
	required: ReadonlyArray<Reached<F | WorldFeature>>
): Pending => {
	const named = new Set<string>(namedOf<F>(required))
	return Option.map(features, (pending) => {
		const still = new Set<string>(pending)
		return (aim: string) => !named.has(aim) || still.has(aim)
	})
}

/**
 * A program's lead: the weights of the draws it makes before its own steps, one per draw, from the case's weights, its
 * installation and what the case's steering left pending. A move a suite needs is drawn here by construction, not by
 * weighting the program's own draws: a draw narrowed to one kind and role, or aimed on every draw at the move (Aims
 * `every`). A lead toward required features draws only while one of them is pending (whilePending).
 */
export type Lead = (weights: Weights, install: InstallSpec, at: Leading) => ReadonlyArray<Weights>

/**
 * Where a program's lead stands: whether the case takes a targeted lead at all (three in four do; the fourth keeps
 * every draw its own, from the staged state, as an unsteered program would), and what the case's steering left
 * pending (Pending), read only by a lead that needs it.
 */
export interface Leading {
	readonly led: boolean
	readonly pending: Pending
}

/** Leads one after another: each one's draws, in order. */
export const leadsOf =
	(...leads: Arr.NonEmptyReadonlyArray<Lead>): Lead =>
	(weights, install, at) =>
		Arr.flatMap(leads, (lead) => lead(weights, install, at))

/**
 * A targeted lead's draws, in a case that takes its lead, while a feature it reaches is still pending; none once every
 * one is reached, nor where the case was drawn under no steering, so a lead spends no program's draws on what the
 * population already holds, the rotating stream's cases are plain draws of the suite's distribution, and one program
 * in four keeps every draw its own.
 */
export const whilePending = (
	targets: ReadonlyArray<string>,
	at: Leading,
	draws: () => ReadonlyArray<Weights>
): ReadonlyArray<Weights> =>
	at.led && Option.exists(at.pending, (pending) => Arr.some(targets, pending)) ? draws() : []

/** The required features `holds` admits, each pair as its two features. */
const requiredFeatures = (
	required: ReadonlyArray<Reached<WorldFeature>>,
	holds: (feature: WorldFeature) => boolean
): ReadonlyArray<WorldFeature> => Arr.filter(featuresIn<WorldFeature>(required), holds)

/** The validity weights of a live draw only. */
const liveOnly: Weights["validity"] = { live: 1, stale: 0, wild: 0 }

/**
 * A lead in which every role that writes writes once, in the installation's order: a live open of its Db (its live
 * token, the current snapshot), an apply through it under the case's validity weights, and the close of that Db, so the
 * next writer's apply goes through the next writer's Db; an apply or close with no Db to act through (the open was
 * refused) opens one instead (withOpener).
 */
/** Whether an action is an apply through an open Db of `role`. */
const applyAs =
	(role: string) =>
	(action: Action, state: ModelState): boolean => {
		if (action.kind !== "apply") {
			return false
		}
		const session = state.sessions[action.session]
		return session?.kind === "db" && session.role === role
	}

export const everyWriterWrites =
	(aimed: (role: RoleSpec) => ReadonlyArray<string>, reading: FeatureReading<string>): Lead =>
	(weights, install, at) => {
		const read = outcomeRead(reading)
		const writers = Arr.filter(install.roles, (r) => r.write.length > 0)
		return Arr.flatMap(writers, (r): ReadonlyArray<Weights> => {
			const open: Weights = {
				...weights,
				kinds: ["open-db"],
				roles: { kind: "only", roles: [r.name] },
				actions: { ...zeroWeights.actions, "open-db": 1 },
				validity: liveOnly
			}
			const apply: Weights = {
				...weights,
				kinds: withOpener("apply"),
				actions: { ...zeroWeights.actions, apply: 1 }
			}
			const close: Weights = {
				...weights,
				kinds: withOpener("close"),
				actions: { ...zeroWeights.actions, close: 1 },
				validity: liveOnly
			}
			const plain = [open, apply, close]
			const [first, ...rest] = aimed(r)
			if (first === undefined) {
				return plain
			}
			const targets: Arr.NonEmptyReadonlyArray<string> = [first, ...rest]
			const opensAs = (a: Action): boolean =>
				a.kind === "open-db" && a.role.kind === "own" && a.role.role === r.name
			return Arr.match(
				whilePending(targets, at, () => [
					{ ...open, aims: everyDraw(targets, afterOpen(["apply"], read), opensAs) },
					{ ...apply, aims: everyDraw(targets, read, applyAs(r.name)) },
					close
				]),
				{ onEmpty: () => plain, onNonEmpty: (led) => led }
			)
		})
	}

/**
 * What a suite's programs draw, whatever a case's swarm weights: the action kinds of its focus, the roles they open a Db
 * as, the features they aim at, and the lead each program draws first.
 */
export interface Draws {
	readonly kinds: Focus
	readonly roles: RoleFocus
	readonly aims: Aims
	readonly lead: Lead
}

/**
 * Aiming at a suite's required features, each pair as its two features, read of an outcome through `read`: half of a
 * case's draws then take an action the state offers that reaches one of them (generate/weights.ts Aims).
 */
export const aimsAt = <F extends string>(
	required: ReadonlyArray<Reached<F>>,
	read: FeatureReading<F>
): Aims => {
	const [first, ...rest] = featuresIn<F>(required)
	return first === undefined
		? noAims
		: {
				kind: "half",
				features: [first, ...rest],
				read: outcomeRead(read),
				worth: everyActionWorth,
				scope: aimScope
			}
}

/** The features an action reaches, read in the state it ran in, then of each outcome's observation. */
type FeatureReading<F extends string> = (
	state: ModelState,
	action: Action
) => (observation: ActionOutcome) => ReadonlyArray<F>

/** What a world-model suite draws: its focus, every role, aimed at its required worlds features, after its lead. */
const worldDraws = (spec: Pick<ProgramSuite, "focus" | "required" | "lead">): Draws => ({
	kinds: spec.focus,
	roles: everyRole,
	aims: aimsAt(spec.required, featuresOf),
	lead: spec.lead
})

/**
 * The program cases of a suite's installations and draws, each running up to `maxSteps` actions after its lead, with
 * what the steering it is drawn under leaves pending of the suite's requirements `required` resolved into its sketch
 * (pendingOf): its lead and its aims read that alone, so the case a kept or replayed sketch runs is the one drawn.
 */
export const programDraw = <F extends string>(
	installs: Gen<InstallSpec>,
	{ lead, ...draws }: Draws,
	maxSteps: number,
	required: ReadonlyArray<Reached<F | WorldFeature>>
): Steered<ProgramCase, F | WorldFeature> =>
	steeredSpace((steering) => (source) => ({
		install: source.draw(installs),
		ambient: source.draw(ambientSessionGen),
		weights: { ...source.draw(weightsGen), ...draws },
		steps: source.draw(int(1, maxSteps)),
		led: source.draw(int(0, 3)) > 0,
		pending: pendingOf<F>(steering, required),
		lead
	}))

/** The features of a required situation: its feature, or both of a pair. */
export const featuresOfSituation = <F extends string>(
	situation: Reached<F>
): Arr.NonEmptyReadonlyArray<F> =>
	typeof situation === "string" ? [situation] : [situation[0], situation[1]]

/** A world brought to a case's start: the real world and the model's state of it. */
export interface Staged {
	readonly world: RealWorld
	readonly start: ModelState
}

/**
 * Brings a realized world to a drawn reality: the reality is drawn from the case's tape, among the suite's realities
 * over the host schema the installation's names give, the world reset to it (every session closed, the facts
 * replaced), and the model's initial state over those names checked against the real system.
 * The caller's scope is the case's: every direct writer the case begins ends with it (RealWorld.reset).
 */
export const stage = (
	world: RealWorld,
	install: InstallSpec,
	draw: CaseDraw,
	realities: Realities
): Effect.Effect<Staged, SqlError | ModelMismatch, Scope.Scope> =>
	Effect.gen(function* () {
		const base = install.base
		const host = hostSchemaOf(base, world.names)
		const reality = draw(realities(base, host))
		yield* world.reset(reality)
		const start = yield* checkStart(world, initialState(install, world.names, reality))
		return { world, start }
	})

/**
 * An action drawn from a case's tape in the state its program reached, under the weights of the draw: the generators
 * draw only actions a program may go on with there (`drivable`), and the driver refuses any other as their defect.
 */
export const drawAction = (draw: CaseDraw, state: ModelState, weights: Weights): Action =>
	draw(actionGen(state, weights))

/**
 * Weights steered toward what the population lacks (Pending). While a required feature is pending, the aims narrow to
 * the features still pending that the program has not itself reached yet (`reached`, its own notes so far), so its
 * aimed draws spread over what is left rather than reaching one pending feature again and again; once the program
 * reached every pending one, to the pending ones; a lead's own moves, which no case notes, stay pending, and aims with
 * none pending stay as they are. Where the case was drawn under no steering, the weights are the case's own, unsteered,
 * so every case of the rotating stream is an independent draw of the suite's distribution, the only kind residual
 * risk counts. A case's pending features are resolved once, as it is drawn, so every draw of a program reads one
 * answer.
 */
const steered = (weights: Weights, pending: Pending, reached: ReadonlySet<string>): Weights => {
	const aims = weights.aims
	if (aims.kind === "none") {
		return weights
	}
	return Option.match(pending, {
		onNone: () => weights,
		onSome: (isPending) => {
			const still = Arr.filter(aims.features, isPending)
			const fresh = Arr.filter(still, (f) => !reached.has(f))
			return Arr.match(Arr.isReadonlyArrayNonEmpty(fresh) ? fresh : still, {
				onEmpty: () => weights,
				onNonEmpty: (features) => ({ ...weights, aims: { ...aims, features } })
			})
		}
	})
}

/** A program that has reached nothing yet: where every program starts (driveProgram). */
const nothingReached: ReadonlySet<string> = new Set<string>()

/**
 * The weights of a case that draws one action, steered (steered) by its pending features (PendingFeatures): while a
 * feature it aims at is pending, its draw is aimed every time rather than half the time, since the case has no other
 * draw for the unaimed half; once every one is reached, or where the case was drawn under no steering, the case's own
 * weights, whose aims keep their kind.
 */
export const steeredOnce = (weights: Weights, features: PendingFeatures): Weights => {
	const pending = pendingIn<WorldFeature>(features, requiredWorldFeatures)
	const aimed = steered(weights, pending, nothingReached)
	const aims = aimed.aims
	return aims.kind === "half" &&
		Option.exists(pending, (isPending) => Arr.some(aims.features, isPending))
		? { ...aimed, aims: { ...aims, kind: "every" } }
		: aimed
}

/** The claims a BEGIN starts its transaction under, as a direct op feature names them of the transaction. */
type BegunClaims = "no claims" | "claims" | "malformed claims"

/** A lead's own aim at a BEGIN's shape: the writer its transaction acts as and the claims it starts under. */
type BegunAs =
	| `lead:begun as ${"direct-role" | "direct-login"} under ${BegunClaims}`
	| `lead:begun as a role seeing outside its writes under ${"no claims" | "claims"}`
	| `lead:begun as a role writing past a law checked at COMMIT under ${"no claims" | "claims"}`

/** Every shape a BEGIN takes: what a lead's BEGIN aims at while no pending feature names one. */
const everyBegun: Arr.NonEmptyReadonlyArray<BegunAs> = [
	"lead:begun as direct-role under no claims",
	"lead:begun as direct-role under claims",
	"lead:begun as direct-role under malformed claims",
	"lead:begun as direct-login under no claims",
	"lead:begun as direct-login under claims",
	"lead:begun as direct-login under malformed claims",
	"lead:begun as a role seeing outside its writes under no claims",
	"lead:begun as a role seeing outside its writes under claims",
	"lead:begun as a role writing past a law checked at COMMIT under no claims",
	"lead:begun as a role writing past a law checked at COMMIT under claims"
]

/** The claims a BEGIN sets that a role's entries may hold facts under: none, or claims of its contexts. */
type HoldingClaims = Exclude<BegunClaims, "malformed claims">

/**
 * Whether an entry may hold facts of `relation` under `under` (features.ts holdsThrough): a whole entry of it; or a
 * writable query entry over it, under claims whatever it reads, under none only one that reads no context.
 */
const holdsUnder = (
	base: BaseSpec,
	entry: EntrySpec,
	relation: string,
	under: HoldingClaims
): boolean => {
	if (entry.kind === "whole") {
		return entry.relation === relation
	}
	const classified = classifyEntry(base, entry)
	return (
		classified.kind === "writable" &&
		classified.target === relation &&
		(under === "claims" || entryContexts(entry).size === 0)
	)
}

/**
 * Whether a role, under `under`, may hold through one of its entries facts of a relation it writes through another, so
 * a statement through the entry it writes meets them outside its world yet visible (features.ts membershipOf).
 */
const seesOutside = (base: BaseSpec, role: RoleSpec, under: HoldingClaims): boolean =>
	Arr.some(writtenOf(base, role), (written) =>
		Arr.some(
			Record.toEntries(role.entries),
			([name, entry]) => name !== written.entry && holdsUnder(base, entry, written.target, under)
		)
	)

/** The relations a law checked at COMMIT reads: each side of a containment or a coverage that is deferred. */
const deferredRelations = (host: HostSchema): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(host.laws, (law): ReadonlyArray<string> => {
			switch (law.kind) {
				case "key":
				case "spanKey":
				case "check":
					return []
				case "contained":
				case "covered":
					return isImmediate(host, law) ? [] : [law.source.relation, law.target.relation]
			}
		})
	)

/**
 * Whether a role writes a relation a law checked at COMMIT reads, through an entry that may hold facts under the claims
 * it begins with (holdsUnder): a statement of its transaction may then break the law, and its COMMIT is refused.
 */
const writesPastCommit = (state: ModelState, role: RoleSpec, under: HoldingClaims): boolean => {
	const deferred = deferredRelations(state.host)
	return Arr.some(writtenOf(state.install.base, role), (written) => {
		const entry = role.entries[written.entry]
		return (
			deferred.has(written.target) &&
			entry !== undefined &&
			holdsUnder(state.install.base, entry, written.target, under)
		)
	})
}

/**
 * The shapes of the transaction a BEGIN leaves open, read of its outcome: the writer it acts as and the claims it set;
 * for a role under none or under claims, whether it may hold facts outside the entries it writes (seesOutside) and
 * whether it writes a relation a law checked at COMMIT reads (writesPastCommit). It steps nothing past the BEGIN.
 */
const begunRead =
	(state: ModelState, action: Action) =>
	(outcome: Allowed): ReadonlyArray<BegunAs> => {
		if (action.kind !== "direct-begin") {
			return []
		}
		const session = settled(outcome).next.sessions[state.sessions.length]
		if (session?.kind !== "direct" || session.transaction !== "open") {
			return []
		}
		const under: BegunClaims =
			session.claims.kind === "none"
				? "no claims"
				: session.claims.setting.kind === "malformed"
					? "malformed claims"
					: "claims"
		const current = session.current
		switch (current.kind) {
			case "login":
				return [`lead:begun as direct-login under ${under}`]
			case "role":
				return Option.match(
					Arr.findFirst(state.install.roles, (r) => r.name === current.role),
					{
						onNone: (): ReadonlyArray<BegunAs> => [`lead:begun as direct-role under ${under}`],
						onSome: (role): ReadonlyArray<BegunAs> =>
							under === "malformed claims"
								? [`lead:begun as direct-role under ${under}`]
								: [
										`lead:begun as direct-role under ${under}`,
										...(seesOutside(state.install.base, role, under)
											? [`lead:begun as a role seeing outside its writes under ${under}` as const]
											: []),
										...(writesPastCommit(state, role, under)
											? [
													`lead:begun as a role writing past a law checked at COMMIT under ${under}` as const
												]
											: [])
									]
					}
				)
		}
	}

/**
 * The BEGIN shape a required feature needs its transaction begun in: a direct writer's statement or COMMIT names the
 * writer and the claims it ran under (absent: none set; matching or not-matching: claims set; malformed); outside yet
 * visible, a role that may hold facts outside the entries it writes (seesOutside); a COMMIT a law refuses, a role that
 * writes a relation such a law reads (writesPastCommit); and a read of a transaction showing a fact it deleted gone, a
 * role. Any other feature needs no shape.
 */
const begunFor = (feature: string): ReadonlyArray<BegunAs> => {
	if (feature === "deletion:world-gone") {
		return ["lead:begun as direct-role under no claims", "lead:begun as direct-role under claims"]
	}
	const [tag, kind, membership, claims, writer, observation] = Str.split(feature, ":")
	if (
		tag !== "op" ||
		(kind !== "direct" && kind !== "direct-end") ||
		(writer !== "direct-role" && writer !== "direct-login")
	) {
		return []
	}
	const under: BegunClaims =
		claims === "absent" ? "no claims" : claims === "malformed" ? "malformed claims" : "claims"
	if (writer === "direct-role" && under !== "malformed claims") {
		if (membership === "outside-visible") {
			return [`lead:begun as a role seeing outside its writes under ${under}`]
		}
		if (kind === "direct-end" && observation === "law-refused") {
			return [`lead:begun as a role writing past a law checked at COMMIT under ${under}`]
		}
	}
	return [`lead:begun as ${writer} under ${under}`]
}

/** The shapes a lead's BEGIN aims at: those the pending features need, or every shape where none needs one. */
const begunTargetsOf = (targets: ReadonlyArray<string>): Arr.NonEmptyReadonlyArray<BegunAs> =>
	Arr.match(Arr.dedupe(Arr.flatMap(targets, begunFor)), {
		onEmpty: () => everyBegun,
		onNonEmpty: (shapes) => shapes
	})

/**
 * A live BEGIN aimed on every draw at the shapes the pending `targets` need it in (begunTargetsOf), read of the BEGIN
 * alone (begunRead): who it acts as and the claims it sets decide which facts lie inside, outside and hidden from the
 * world its statements meet, which no draw after it can change.
 */
const begunAimed = (weights: Weights, targets: Arr.NonEmptyReadonlyArray<string>): Weights => ({
	...weights,
	kinds: ["direct-begin"],
	actions: { ...zeroWeights.actions, "direct-begin": 1 },
	validity: liveOnly,
	aims: everyDraw(begunTargetsOf(targets), begunRead, (a) => a.kind === "direct-begin")
})

/** A statement of a transaction that deleted a stored fact its view held: a lead's own move. */
const factDeleted = "lead:a fact its transaction deleted" as const

/**
 * Whether a direct statement deleted a stored fact from its transaction's view, read of its outcome alone: a read of the
 * transaction after it shows the fact gone (deletion:world-gone).
 */
const deletedRead =
	(state: ModelState, action: Action) =>
	(outcome: Allowed): ReadonlyArray<typeof factDeleted> => {
		if (action.kind !== "direct") {
			return []
		}
		const { next } = settled(outcome)
		const before = state.sessions[action.session]
		const after = next.sessions[action.session]
		return before?.kind === "direct" &&
			after?.kind === "direct" &&
			deletedBy(next, after).length > deletedBy(state, before).length
			? [factDeleted]
			: []
	}

/**
 * A lead's first move past the planned state: one the box offers of a kind, drawn evenly among them; or one drawn
 * under the weights the lead aims it with, from the required features still pending.
 */
type LeadFirst =
	| { readonly kind: "offered"; readonly of: "open-db" }
	| {
			readonly kind: "aimed"
			readonly weights: (weights: Weights, targets: Arr.NonEmptyReadonlyArray<string>) => Weights
	  }

/**
 * A state an inductive case builds past its planned Db sessions, one action before what it reaches: its first move
 * (LeadFirst), and the moves after it (`after`), each aimed on every draw at the required features still pending
 * (`targets`) or at a lead's own move. No move looks past the next: what the case reaches from the state it builds is
 * its one action's aim to decide, never a list of features.
 */
interface InductiveLead {
	readonly first: LeadFirst
	readonly after: (
		weights: Weights,
		targets: Arr.NonEmptyReadonlyArray<string>
	) => ReadonlyArray<Weights>
}

/**
 * What the move after a direct statement reaches, read of the statement's outcome alone or its COMMIT after it: the
 * features its COMMIT notes (commitAfter), and whether it deleted a fact of its transaction's view (deletedRead).
 */
const afterStatement = (
	state: ModelState,
	action: Action
): ((outcome: Allowed) => ReadonlyArray<string>) => {
	const commit = commitAfter(state, action)
	const deleted = deletedRead(state, action)
	return (outcome) => [...commit(outcome), ...deleted(outcome)]
}

/**
 * A live apply through a Db the state holds, aimed on every draw at `targets`, read of the features its outcome notes;
 * a state holding no Db opens one instead (dbCall).
 */
const aimedApply = (weights: Weights, targets: Arr.NonEmptyReadonlyArray<string>): Weights =>
	dbCall(weights, "apply", targets, noted)

/**
 * The inductive suite's leads, each a state one action before what it reaches. Every aimed move reads its own outcome
 * alone, or its COMMIT after it at most (commitAfter): no move looks past the next.
 * - a transaction begun in the shape a pending feature needs (begunAimed): the role it took on and the claims it set,
 *   none, some or malformed, decide which facts lie inside, outside and hidden from its world and which world function
 *   it may call;
 * - a transaction so begun, one statement in, the statement aimed so that its COMMIT reaches a feature (commitAfter),
 *   a law checked at COMMIT that the statement broke, or so that it deleted a fact of its view (deletedRead), which a
 *   read of the transaction then shows gone: the case's one action aims at either;
 * - a Db the planned state holds, one apply in, the apply aimed at what it reaches itself;
 * - a Db opened, one read or apply from what it reaches: the role it opens as and the claims its token carries decide
 *   which facts lie inside, outside and hidden from each entry it reads or writes, and an apply waits on a direct
 *   transaction the planned state holds (drive/index.ts serial), so a planned Db rarely offers the call a feature needs.
 */
const inductiveLeads: Arr.NonEmptyReadonlyArray<InductiveLead> = [
	{ first: { kind: "aimed", weights: begunAimed }, after: () => [] },
	{
		first: { kind: "aimed", weights: begunAimed },
		after: (weights, targets) => [
			aimedStatement(weights, Arr.append(targets, factDeleted), afterStatement)
		]
	},
	{ first: { kind: "aimed", weights: aimedApply }, after: () => [] },
	{ first: { kind: "offered", of: "open-db" }, after: () => [] }
]

/** A move of a lead past a planned state: the action its first move took there, or a draw under its weights. */
export type LeadMove =
	| { readonly kind: "taken"; readonly action: Action }
	| { readonly kind: "drawn"; readonly weights: Weights }

/** The action a lead's move performs in a state: the one it took, or one drawn from the case's tape. */
export const moveAction = (draw: CaseDraw, state: ModelState, move: LeadMove): Action => {
	switch (move.kind) {
		case "taken":
			return move.action
		case "drawn":
			return drawAction(draw, state, move.weights)
	}
}

/**
 * The moves of a led inductive case past its planned state, while a required feature is pending (PendingFeatures)
 * where the case was drawn steered and always where it was not: a lead drawn from its tape (`draw`) evenly among the
 * leads; its first move drawn evenly among the actions of its kind the box offers in the planned state (offeredOf), or
 * under the weights the lead aims it with; and its later moves steered toward what is pending (steered). None where
 * nothing is pending or the box offers an offered lead's kind nothing. The case's one action aims at the required
 * features as every case's does, so no draw of a case steps more than the box of the state it is drawn in, each
 * candidate once and its COMMIT after it at most (commitAfter): no box is listed past another's move.
 */
export const leadOf = (
	required: ReadonlyArray<Reached<WorldFeature>>,
	weights: Weights,
	state: ModelState,
	features: PendingFeatures,
	draw: CaseDraw
): ReadonlyArray<LeadMove> => {
	const pending = pendingIn<WorldFeature>(features, required)
	const [first, ...rest] = requiredFeatures(required, (f) =>
		Option.match(pending, { onNone: () => true, onSome: (isPending) => isPending(f) })
	)
	if (first === undefined) {
		return []
	}
	const lead = draw(element(inductiveLeads))
	const after = Arr.map(lead.after(weights, [first, ...rest]), (w): LeadMove => ({
		kind: "drawn",
		weights: steered(w, pending, nothingReached)
	}))
	switch (lead.first.kind) {
		case "offered":
			return Arr.match(offeredOf(state, [lead.first.of], weights.roles, aimScope), {
				onEmpty: (): ReadonlyArray<LeadMove> => [],
				onNonEmpty: (moves) => [{ kind: "taken", action: draw(element(moves)) }, ...after]
			})
		case "aimed":
			return [
				{
					kind: "drawn",
					weights: steered(lead.first.weights(weights, [first, ...rest]), pending, nothingReached)
				},
				...after
			]
	}
}

/** What a suite sees of one action its program performed: the state it ran in, its answer and the state after it. */
export interface SeenAction {
	readonly index: number
	readonly before: ModelState
	readonly action: Action
	readonly observation: ActionOutcome
	readonly after: ModelState
}

/** One performed action as a suite's rule judges it: what the suite saw of it, and of every action before it. */
export interface Checked {
	readonly seen: SeenAction
	readonly earlier: ReadonlyArray<SeenAction>
}

/**
 * A suite's own rule over each performed action, beside the driver's agreement with the model: it throws, through the
 * assertions, when the action and what came before it in the program break the rule.
 */
export type StepCheck = (checked: Checked) => void

/** The rule of a suite whose every check is the driver's. */
export const noCheck: StepCheck = () => undefined

/**
 * Where a program has got to: the model's state, what the suite saw of each action taken, and every feature its
 * actions noted (steered).
 */
interface Progress {
	readonly state: ModelState
	readonly seen: ReadonlyArray<SeenAction>
	readonly reached: ReadonlySet<string>
}

/** A program case's lead draws (Lead), under what its steering left pending (Pending). */
const programLead = (pc: ProgramCase, pending: Pending): ReadonlyArray<Weights> =>
	pc.lead(pc.weights, pc.install, { led: pc.led, pending })

/**
 * Runs a case's program on its staged world: its lead's draws, each under its own weights, then `pc.steps` actions
 * under the case's; each drawn from the case's tape in the state the model is in after the one before (drawAction),
 * performed by the driver (runStep) and held to the suite's own rule. Its lead and its aims read what its steering left
 * pending (`pc.pending`) as resolved of the suite's requirements `required`, the ones it was drawn under
 * (programDraw). Returns the last state.
 */
export const driveProgram = <F extends string>(
	staged: Staged,
	pc: ProgramCase,
	c: Case<F | WorldFeature>,
	required: ReadonlyArray<Reached<F | WorldFeature>>,
	check: StepCheck
): Effect.Effect<ModelState, ModelMismatch> =>
	Effect.suspend(() => {
		const pending = pendingIn<F>(pc.pending, required)
		const lead = programLead(pc, pending)
		return Effect.map(
			Effect.reduce(
				indices(lead.length + pc.steps),
				(): Progress => ({ state: staged.start, seen: [], reached: nothingReached }),
				(at, index) =>
					Effect.gen(function* () {
						const led = lead[index]
						const action = drawAction(
							c.draw,
							at.state,
							steered(led ?? pc.weights, pending, at.reached)
						)
						const stepped = yield* runStep(staged.world, at.state, action, index, c)
						const seen: SeenAction = {
							index,
							before: stepped.before,
							action,
							observation: stepped.observation,
							after: stepped.next
						}
						check({ seen, earlier: at.seen })
						return {
							state: stepped.next,
							seen: [...at.seen, seen],
							reached: new Set<string>([
								...at.reached,
								...featuresOf(stepped.before, action)(stepped.observation)
							])
						}
					})
			),
			(at) => at.state
		)
	})

/**
 * Noting nothing: the setup a case performs to reach the state it explores from is checked by the driver like any
 * action, but it is no part of what the case reached.
 */
export const unnoted: Noting = { noteAll: () => undefined }

/**
 * A suite of generated programs: its label, the name of its test, the installations it draws, the action kinds it
 * draws, the longest program, the features its population must reach, and its own rule over
 * each action. Each case realizes its installation afresh, every login's pool of one connection (serialPool).
 */
export interface ProgramSuite {
	readonly installs: Gen<InstallSpec>
	readonly focus: Focus
	readonly steps: number
	/** Its own search budget, where a kill it declares survives the runner's: none, the runner's. */
	readonly budget?: Budget
	readonly required: Situations<WorldFeature>
	readonly check: StepCheck
	/** The realities its cases draw (drawnRealities, or a targeted mix). */
	readonly realities: Realities
	/** What each program draws first (Lead): noLead, or moves the suite needs in every program. */
	readonly lead: Lead
	/** Its counterexamples, each replayed before any stream. */
	readonly kept: ReadonlyArray<Kept>
	/** The bugs it must catch (Kill), each applied in a kill trial its witnesses must fail. */
	readonly kills: ReadonlyArray<Kill>
}

/**
 * A generated installation of a documents base (installGen): of the base itself, of the base with at most one share
 * per document (docsOneShareBase), whose key on a share's document a write meets hidden facts at, or of the base with a
 * context field of a contract (docsLevelBase), which a rule may equate an organization's plan to; half the time with
 * its objects and query entries named from the kernel dictionary or after PostgreSQL's types (generate/names.ts).
 */
export const generatedDocsInstalls: Gen<InstallSpec> = dictionaryNamed((source) =>
	source.draw(installGen(source.draw(element(docsBases))))
)

/**
 * The documents base's installations a suite draws: half the time its README-shaped worlds, whose roles hold every
 * shape the README names (writable query entries filled from a claim, a claim-fixed head field, a negation reading a
 * claim, two logins), over the base (docsInstall), its one-share variant (docsOneShareInstall), where
 * the member's own shares meet a hidden share at that key, or its Level variant (docsLevelInstall), where the member
 * reads a context field of a contract, and the first two with an editor beside (docsEditorInstall,
 * docsOneShareEditorInstall), whose every fact outside an entry it writes is one it sees through a relation it holds
 * whole, or one hidden from it, under its claims or under none; and otherwise a generated one (generatedDocsInstalls),
 * which combines the shapes anew.
 */
export const docsInstalls: Gen<InstallSpec> = oneOf([
	element([
		docsInstall,
		docsOneShareInstall,
		docsLevelInstall,
		docsEditorInstall,
		docsOneShareEditorInstall
	]),
	generatedDocsInstalls
])

/** The conversions of the names the documents bases declare: a dictionary name converting to none was drawn. */
const docsConversions: ReadonlySet<string> = ownConversions(docsBases)

/**
 * Notes what a case's realization met of how PostgreSQL resolves names: the ambient session its owner sessions started
 * under, the dictionary features of the names its installation drew beyond the documents bases' own, and a base object
 * or a role entry named after a PostgreSQL type, paired with the grizzle-first path where the installation's schemas
 * come first on its owner's search path, ahead of pg_catalog's type of that name.
 */
export const noteNaming = (pc: ProgramCase, c: Case<WorldFeature>): void => {
	for (const feature of ambientFeatures(pc.ambient)) {
		c.note(feature)
	}
	for (const feature of nameFeatures(pc.install, docsConversions)) {
		c.note(`name:${feature}`)
	}
	if (namesCatalogType(pc.install)) {
		c.note("catalog-type name")
		if (pc.ambient.path.kind === "grizzleFirst") {
			c.pair("grizzle-first path", "catalog-type name")
		}
	}
}

/**
 * The connections of a login's pool a program holds at once: it runs one action at a time, and its open of a Db leases
 * one connection at once (execute/index.ts openedDb), so every login's pool, the stranger's among them, holds one.
 */
const serialPool = 1

/**
 * A program case's installation realized afresh in a substrate of its own (a property's Substrate.fresh), a database no
 * case beside it uses, every login's pool serial (serialPool).
 */
export const ownWorld = (
	substrate: SubstrateShape,
	pc: ProgramCase
): Effect.Effect<RealWorld, RealizeRefused | SqlError, Scope.Scope> =>
	Effect.provideService(realizeRace(pc.install, pc.ambient, serialPool), Substrate, substrate)

/**
 * A program suite's property: each case realizes its installation afresh in a database of its own (Substrate.fresh), a
 * database no case beside it uses, every login's pool serial (serialPool), so a program's database-wide changes (a
 * tamper of the database's settings or privileges) never meet a case beside it; then it stages its reality and runs its
 * program under the driver and the suite's rule. Its steered phase aims programs, through their leads and aims, at the
 * required features no case has reached yet, and stops once every one is reached; the rotating stream's programs aim
 * at nothing.
 */
export const programProperty = (spec: ProgramSuite): Property =>
	property.explore(programDraw(spec.installs, worldDraws(spec), spec.steps, spec.required), {
		needs: { own: Substrate.fresh(baseSubstrate) },
		situations: spec.required,
		check:
			({ own }, c: Case<WorldFeature>) =>
			(pc) =>
				Effect.scoped(
					Effect.gen(function* () {
						const { substrate } = yield* own
						const world = yield* ownWorld(substrate, pc)
						noteNaming(pc, c)
						const staged = yield* stage(world, pc.install, c.draw, spec.realities)
						yield* driveProgram(staged, pc, c, spec.required, spec.check)
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model (test/support/worlds/model), stepped beside every action: its allowed observations, its stored relations and every open session's probe"
		},
		...(spec.budget === undefined ? {} : { budget: spec.budget }),
		kept: spec.kept,
		kills: spec.kills
	})

/**
 * The worlds features a suite's area must reach: each required feature of the feature map that `holds` admits, and
 * each required pair whose two features it admits. An area that admits none is refused when its suite loads, never
 * left to require nothing.
 */
export const requiredWhere = (
	holds: (feature: WorldFeature) => boolean
): Situations<WorldFeature> =>
	knownNonEmpty(
		Arr.filter(requiredWorldFeatures, (r) =>
			Predicate.isString(r) ? holds(r) : holds(r[0]) && holds(r[1])
		),
		"the world features an area requires"
	)

/** Operations of some action kinds, by some writers, observed some ways: a family of op features. */
interface Ops {
	readonly kinds: ReadonlyArray<ActionKind>
	readonly writers: ReadonlyArray<Writer>
	readonly observations: ReadonlyArray<ActionOutcome["kind"]>
}

/**
 * Whether a feature is one of `ops`: `op:<kind>:<membership>:<claims>:<writer>:<observation>` of one of its kinds,
 * writers and observations, whatever its membership and claims.
 */
export const opIn =
	(ops: Ops) =>
	(feature: WorldFeature): boolean => {
		const [tag, kind, , , writer, observation] = Str.split(feature, ":")
		return (
			tag === "op" &&
			Arr.some(ops.kinds, (k) => k === kind) &&
			Arr.some(ops.writers, (w) => w === writer) &&
			Arr.some(ops.observations, (o) => o === observation)
		)
	}

/** Whether a feature begins with one of `prefixes`: a family of the feature vocabulary, or a kind within one. */
export const startingWith =
	(...prefixes: Arr.NonEmptyReadonlyArray<string>) =>
	(feature: WorldFeature): boolean =>
		Arr.some(prefixes, (prefix) => Str.startsWith(prefix)(feature))

/** Every writer: grizzle's Db, a direct writer that took on a role, and one still the login. */
export const everyWriter: ReadonlyArray<Writer> = ["db", "direct-role", "direct-login"]

/** The invalid kinds of one family of the vocabulary (invalid/kinds.ts): each whose name starts with `prefix`. */
export const invalidKindsWith = (prefix: string): ReadonlyArray<InvalidKind> =>
	Arr.filter(invalidKinds, Str.startsWith(prefix))

/** The feature of drawing each invalid kind, for a suite that requires every kind it draws. */
export const invalidFeatures = (kinds: ReadonlyArray<InvalidKind>): ReadonlyArray<WorldFeature> =>
	Arr.map(kinds, (kind): WorldFeature => `invalid:${kind}`)
