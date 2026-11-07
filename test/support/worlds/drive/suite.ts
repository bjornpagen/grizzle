import type { Vitest } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { type Reached, required, type Situations } from "@grizzle/testing/features"
import { element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Predicate,
	type Scope,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import { type AmbientSession, ambientFeatures, ambientSessionGen } from "#test/support/ambient.ts"
import { relationOf, sameValue, valueText } from "#test/support/laws/model.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"
import {
	checkStart,
	type ModelMismatch,
	type Noting,
	notedOf,
	runStep
} from "#test/support/worlds/drive/index.ts"
import { type RealWorld, realize } from "#test/support/worlds/execute/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import type { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { requiredWorldFeatures } from "#test/support/worlds/features.ts"
import { actionGen, withOpener } from "#test/support/worlds/generate/action.ts"
import { knownNonEmpty, pool } from "#test/support/worlds/generate/domain.ts"
import { defaultScope, enumerateKind } from "#test/support/worlds/generate/enumerate.ts"
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
import {
	docsBases,
	docsEditorInstall,
	docsInstall,
	docsLevelInstall,
	docsOneShareEditorInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { writtenOf } from "#test/support/worlds/model/session/writes.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	BaseSpec,
	Branch,
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
 * The model's branches of an action, a landing completed under the compiler's names for the installation it lands
 * (execute/names.ts installedNames): a lead reads the model alone, ahead of the real system.
 */
const branchesOf = (state: ModelState, action: Action): Arr.NonEmptyReadonlyArray<Branch> =>
	Arr.map(step(state, action), (s) => settle(s, installedNames))

/**
 * The box an aimed draw takes its candidates from (Aiming.scope): the exhaustive box's, with two contexts, so the
 * tokens a Db opens with and the claims a direct writer begins under claim both contexts of the documents base at once,
 * as a real user's do, besides each alone; the box's own single context would leave every write under both a role's
 * contexts to chance.
 */
export const aimScope: SmallScope = { ...defaultScope, contexts: 2 }

/** An action a case performed and the index of the branch the real system took on it. */
export interface Taken {
	readonly action: Action
	readonly branch: number
}

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
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature | typeof transactionEnded> => [
	...notedOf(state, action, observation),
	...(action.kind === "direct-end" && ofTheTransaction(action, state) ? [transactionEnded] : [])
]

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
const afterBegin = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> => {
	if (action.kind !== "direct-begin" || observation.kind !== "opened") {
		return []
	}
	return Arr.flatMap(branchesOf(state, action), ({ observation: began, next }) =>
		began.kind === "opened"
			? Arr.flatMap(
					[
						...enumerateKind(next, "direct", defaultScope),
						...enumerateKind(next, "direct-end", defaultScope)
					],
					(a) =>
						(a.kind === "direct" || a.kind === "direct-end") && a.session === began.session
							? Arr.flatMap(step(next, a), (b) => notedOf(next, a, b.observation))
							: []
				)
			: []
	)
}

/** What a direct writer's statements and COMMIT note: their op features and the world objects they meet. */
const directReach = (feature: WorldFeature): boolean =>
	startingWith("op:direct:", "op:direct-end:", "object:")(feature)

/** A live BEGIN aimed on every draw at `targets`, read of its outcome through `read`, among the box's BEGINs. */
const aimedBegin = (
	weights: Weights,
	targets: Arr.NonEmptyReadonlyArray<string>,
	read: Aiming["read"]
): Weights => ({
	...weights,
	kinds: ["direct-begin"],
	actions: { ...zeroWeights.actions, "direct-begin": 1 },
	validity: liveOnly,
	aims: everyDraw(targets, read, (a) => a.kind === "direct-begin")
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
 * A lead for a suite requiring a direct writer's statements: a BEGIN from which a required feature still pending is one
 * statement away (afterBegin, aimed on every draw among the box's starts: as the login or one of its roles, under no
 * claims, each choice of claims, a context alone, or malformed claims), three statements of its transaction each aimed
 * at the required features the program has not reached yet, and its end, aimed likewise (endingIt), so the lead closes
 * what it opened and the program's own draws meet no transaction they did not begin.
 */
export const directTransaction =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, () => true)
		if (first === undefined) {
			return []
		}
		const statement = aimedStatement(weights, [first, ...rest], notedOf)
		return whilePending(requiredFeatures(required, directReach), at, () => [
			aimedBegin(weights, [first, ...rest], afterBegin),
			statement,
			statement,
			statement,
			endingIt(weights, [first, ...rest])
		])
	}

/** Whether an action is a call through the open Db at `session` (afterOpen). */
const callThrough = (action: Action, session: number): boolean => {
	switch (action.kind) {
		case "read":
		case "apply":
			return action.session === session
		case "open-db":
		case "refresh":
		case "close":
		case "direct-begin":
		case "direct":
		case "direct-end":
		case "interrupt":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return false
	}
}

/**
 * What the Db an action opens reaches next through the calls of `kinds`, read of the open's outcome: every feature such
 * a call the box offers through it reaches as the model predicts them, by the suite's reading of a call's outcome
 * (`read`). The token's claims decide which facts lie inside, outside and hidden from the entries each call goes
 * through, which no draw after the open can change, so an aimed open is one from which a pending feature is one call
 * away. An input past the limit is refused before any fact is read, so the read of what an open reaches leaves it out.
 */
const afterOpen =
	(kinds: ReadonlyArray<"read" | "apply">, read: Aiming["read"]) =>
	(state: ModelState, action: Action, observation: ActionOutcome): ReadonlyArray<string> => {
		if (action.kind !== "open-db" || observation.kind !== "opened") {
			return []
		}
		return Arr.flatMap(branchesOf(state, action), ({ observation: opened, next }) =>
			opened.kind === "opened"
				? Arr.flatMap(kinds, (kind) =>
						Arr.flatMap(enumerateKind(next, kind, defaultScope), (a) =>
							callThrough(a, opened.session)
								? Arr.flatMap(step(next, a), (b) => read(next, a, b.observation))
								: []
						)
					)
				: []
		)
	}

/** What a Db's reads and applies note: their op features, the world objects and read paths they show. */
const dbReach = (feature: WorldFeature): boolean =>
	startingWith("op:read:", "op:apply:", "object:", "strata:", "readback:", "via:")(feature)

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
	aims: everyDraw(targets, afterOpen(calls, notedOf), (a) => a.kind === "open-db")
})

/**
 * A lead for a suite requiring a Db's reads and applies: an open from which a required feature still pending is one
 * call away (aimedOpen), three calls through it, apply, read and apply, those of the suite's kinds, each aimed at the
 * required features the program has not reached yet, and the Db's close.
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
			aims: everyDraw([first, ...rest], notedOf, (a, s) => a.kind === kind && ofAnOpenDb(a, s))
		})
		const calls = Arr.filter(["apply", "read", "apply"] as const, (kind) =>
			Arr.contains(weights.kinds, kind)
		)
		return whilePending(requiredFeatures(required, dbReach), at, () => [
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

/** A Db opened as a role that refreshes a derived relation computed from one it writes: a lead's own move. */
const dbRefreshingWritten = "lead:a Db refreshing what it writes" as const

/**
 * Whether a role refreshes a derived relation it holds whole, computed from a relation it writes, so its own delete can
 * leave that relation stale and its own refresh catch it up.
 */
const refreshesWritten = (base: BaseSpec, role: RoleSpec): boolean => {
	const written = Arr.map(writtenOf(base, role), (w) => w.target)
	return Arr.some(role.refresh, (name) => {
		const entry = role.entries[name]
		return Arr.some(
			base.derived,
			(d) =>
				entry?.kind === "whole" &&
				entry.relation === d.name &&
				Arr.some(d.rules, (rule) =>
					Arr.some(
						rule.matches,
						(o) => o.source.kind === "ordinary" && Arr.contains(written, o.source.name)
					)
				)
		)
	})
}

/** An open that opened a Db of a role refreshing what it writes (refreshesWritten), read of the outcome. */
const refreshesWrittenRead = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<typeof dbRefreshingWritten> => {
	if (action.kind !== "open-db" || observation.kind !== "opened" || action.role.kind !== "own") {
		return []
	}
	const opened = action.role.role
	return Option.exists(
		Arr.findFirst(state.install.roles, (r) => r.name === opened),
		(role) => refreshesWritten(state.install.base, role)
	)
		? [dbRefreshingWritten]
		: []
}

/** The calls through a Db after an apply that a derived relation's staleness shows on: its reads and refreshes. */
const afterApplyCalls: Arr.NonEmptyReadonlyArray<ActionKind> = ["read", "refresh"]

/**
 * What an apply reaches, and then the calls through the same Db after it: every feature the apply notes, and every
 * feature a read or refresh the box offers through the Db then notes, as the model predicts them. A deletion shows on a
 * derived relation only on the read or refresh after the delete, so an apply aimed by this read is one a pending
 * deletion feature is one call past.
 */
const afterApply = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> => {
	if (action.kind !== "apply") {
		return []
	}
	return [
		...notedOf(state, action, observation),
		...Arr.flatMap(branchesOf(state, action), ({ observation: applied, next }) =>
			applied.kind === observation.kind
				? Arr.flatMap(afterApplyCalls, (kind) =>
						Arr.flatMap(enumerateKind(next, kind, defaultScope), (a) =>
							(a.kind === "read" || a.kind === "refresh") && a.session === action.session
								? Arr.flatMap(step(next, a), (b) => notedOf(next, a, b.observation))
								: []
						)
					)
				: []
		)
	]
}

/**
 * A lead for a suite requiring what a deletion shows on a derived relation: an open of a role that refreshes a derived
 * relation computed from one it writes (aimed on every draw), an apply aimed at the required features the read or
 * refresh after it reaches (afterApply), a read and a refresh each aimed at the required features the program has not
 * reached yet, and the Db's close. The derived relation keeps a deleted fact until a refresh, so the delete, the read
 * that still shows it and the refresh that drops it are three calls apart.
 */
export const derivedLeftStale =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, () => true)
		if (first === undefined) {
			return []
		}
		return whilePending(requiredFeatures(required, startingWith("deletion:derived-")), at, () => [
			...staleDerivedMoves(weights, [first, ...rest]),
			dbCall(weights, "read", [first, ...rest], notedOf),
			dbCall(weights, "refresh", [first, ...rest], notedOf),
			{
				...weights,
				kinds: withOpener("close"),
				actions: { ...zeroWeights.actions, close: 1 },
				validity: liveOnly
			}
		])
	}

/**
 * A live call of a kind through an open Db the state holds, aimed on every draw at `targets`, read of its outcome
 * through `read`; a state holding no Db to call through opens one instead (withOpener).
 */
const dbCall = (
	weights: Weights,
	kind: "read" | "apply" | "refresh",
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
 * The moves that leave a derived relation stale one call before `targets`: an open of a role that refreshes a derived
 * relation computed from one it writes (aimed on every draw), and an apply through it aimed at `targets` as the read or
 * refresh after it reaches them (afterApply).
 */
const staleDerivedMoves = (
	weights: Weights,
	targets: Arr.NonEmptyReadonlyArray<string>
): Arr.NonEmptyReadonlyArray<Weights> => [
	{
		...weights,
		kinds: ["open-db"],
		actions: { ...zeroWeights.actions, "open-db": 1 },
		validity: liveOnly,
		aims: everyDraw([dbRefreshingWritten], refreshesWrittenRead, (a) => a.kind === "open-db")
	},
	dbCall(weights, "apply", targets, afterApply)
]

/** A direct writer's COMMIT a law refused: what a COMMIT-law lead reaches. */
const atCommitRefusals = (feature: WorldFeature): boolean =>
	opIn({ kinds: ["direct-end"], writers: ["direct-role"], observations: ["law-refused"] })(feature)

/**
 * What a COMMIT right after a direct statement reaches, read of the statement's outcome: the features of the
 * transaction's COMMIT, as the model predicts it, in each state the statement leaves. A law checked at COMMIT (a deferred
 * foreign key) that the statement breaks shows only there.
 */
const commitAfter = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> => {
	if (action.kind !== "direct") {
		return []
	}
	const commit: Action = { kind: "direct-end", session: action.session, end: "commit" }
	return Arr.flatMap(branchesOf(state, action), (b) =>
		b.observation.kind === observation.kind
			? Arr.flatMap(step(b.next, commit), (c) => notedOf(b.next, commit, c.observation))
			: []
	)
}

/** Whether an action is a read of a view or a table by the direct session at `session`. */
const directReadAt = (action: Action, session: number): boolean =>
	action.kind === "direct" &&
	action.session === session &&
	(action.statement.kind === "select-view" || action.statement.kind === "select-table")

/**
 * What the reads after a direct writer's delete reach, read of the delete's outcome: the features of each read of a view
 * or a table the box offers the transaction next, in each state the delete leaves. A read inside the transaction no
 * longer shows a fact it deleted, which only a read after the delete can show.
 */
const readsAfterDelete = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> => {
	if (
		action.kind !== "direct" ||
		(action.statement.kind !== "delete" && action.statement.kind !== "merge-delete")
	) {
		return []
	}
	return Arr.flatMap(branchesOf(state, action), (b) =>
		b.observation.kind === observation.kind
			? Arr.flatMap(enumerateKind(b.next, "direct", defaultScope), (a) =>
					directReadAt(a, action.session)
						? Arr.flatMap(step(b.next, a), (c) => notedOf(b.next, a, c.observation))
						: []
				)
			: []
	)
}

/**
 * What the move after a direct statement reaches, read of the statement's outcome: its transaction's COMMIT
 * (commitAfter) and, after a delete, the reads of its transaction (readsAfterDelete).
 */
const afterWrite = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> => [
	...commitAfter(state, action, observation),
	...readsAfterDelete(state, action, observation)
]

/**
 * What the move after one statement of the transaction an action begins reaches, read of the BEGIN's outcome: the
 * features `read` reads of each statement the box offers the transaction. Who the transaction acts as and the claims it
 * sets decide whose law a statement breaks, whether the law's witness is shown to it and which facts a read inside it
 * shows, so an aimed BEGIN is one from which a pending feature is a statement and the move after it away.
 */
const afterAStatementOf =
	(read: Aiming["read"]) =>
	(state: ModelState, action: Action, observation: ActionOutcome): ReadonlyArray<string> => {
		if (action.kind !== "direct-begin" || observation.kind !== "opened") {
			return []
		}
		return Arr.flatMap(branchesOf(state, action), ({ observation: began, next }) =>
			began.kind === "opened"
				? Arr.flatMap(enumerateKind(next, "direct", defaultScope), (a) =>
						a.kind === "direct" && a.session === began.session
							? Arr.flatMap(step(next, a), (b) => read(next, a, b.observation))
							: []
					)
				: []
		)
	}

/**
 * The moves of a transaction one statement in, a move before `targets`: a BEGIN from which one of them is a statement
 * and the move after it away (afterAStatementOf), and a statement after which that move reaches one, both aimed on
 * every draw and read through `read`.
 */
const oneStatementIn = (
	weights: Weights,
	targets: Arr.NonEmptyReadonlyArray<string>,
	read: Aiming["read"]
): Arr.NonEmptyReadonlyArray<Weights> => [
	aimedBegin(weights, targets, afterAStatementOf(read)),
	aimedStatement(weights, targets, read)
]

/**
 * A lead for a suite requiring laws a direct writer breaks at its COMMIT: a BEGIN
 * from which such a refusal still pending is a statement and the COMMIT away, a statement after which the COMMIT
 * reaches one (commitAfter), and the COMMIT, each aimed on every draw at the required features of a refused COMMIT. The
 * refusal comes two moves after the BEGIN that decides whose law it is, past the one-step reach of a suite's own aims.
 */
export const breakingAtCommit =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, atCommitRefusals)
		if (first === undefined) {
			return []
		}
		const targets: Arr.NonEmptyReadonlyArray<WorldFeature> = [first, ...rest]
		return whilePending(targets, at, () => [
			...oneStatementIn(weights, targets, commitAfter),
			endingIt(weights, targets)
		])
	}

/** A fact a direct writer's transaction deleted, gone from a read of the transaction: what a read past a delete reaches. */
const goneFromItsWorld = (feature: WorldFeature): boolean => feature === "deletion:world-gone"

/**
 * A lead for a suite requiring a fact a direct writer's transaction deleted, gone from what the transaction reads: a
 * BEGIN from which that is a delete and the read after it away, a delete after which a read of the transaction reaches
 * it (readsAfterDelete), that read, each aimed on every draw at it, and the transaction's end (endingIt). The read comes
 * two statements after the BEGIN that decides which facts the transaction's world holds and may delete, past the
 * one-statement reach of directTransaction's aims.
 */
export const readPastADelete =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(required, goneFromItsWorld)
		if (first === undefined) {
			return []
		}
		const targets: Arr.NonEmptyReadonlyArray<WorldFeature> = [first, ...rest]
		return whilePending(targets, at, () => [
			...oneStatementIn(weights, targets, readsAfterDelete),
			aimedStatement(weights, targets, notedOf),
			endingIt(weights, targets)
		])
	}

/**
 * What the opens after a catalog change reach, read of the change's outcome: every feature an open the box offers then
 * notes, as the model predicts it. A token that decodes is refused only past the token, at admission or the ledger,
 * so an open refused past its token needs the catalog changed first.
 */
const opensAfter = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> =>
	action.kind === "tamper"
		? Arr.flatMap(branchesOf(state, action), (b) =>
				b.observation.kind === observation.kind
					? Arr.flatMap(enumerateKind(b.next, "open-db", aimScope), (a) =>
							Arr.flatMap(step(b.next, a), (c) => notedOf(b.next, a, c.observation))
						)
					: []
			)
		: []

/**
 * A lead for a suite requiring the opens a catalog change refuses: while a required refused open is pending, a catalog
 * change from which one is one open away (opensAfter, aimed on every draw among the box's perturbations), and that open,
 * aimed at the required refused opens the program has not reached yet. A catalog change past the contract leaves a
 * program only opens and drift, so a suite takes this lead last.
 */
export const openPastATamper =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(
			required,
			opIn({ kinds: ["open-db"], writers: ["db"], observations: ["open-refused"] })
		)
		if (first === undefined) {
			return []
		}
		const targets: Arr.NonEmptyReadonlyArray<WorldFeature> = [first, ...rest]
		return whilePending(targets, at, () => [
			{
				...weights,
				kinds: ["tamper"],
				actions: { ...zeroWeights.actions, tamper: 1 },
				aims: everyDraw(targets, opensAfter, (a) => a.kind === "tamper")
			},
			{
				...weights,
				kinds: ["open-db"],
				actions: { ...zeroWeights.actions, "open-db": 1 },
				aims: everyDraw(targets, notedOf, (a) => a.kind === "open-db")
			}
		])
	}

/**
 * What the reads after a migration reach, read of the migration's outcome: every feature a read the box offers through
 * an open Db then notes, as the model predicts it. A Db's snapshot is moved past only by a migration after its open, so
 * a read refused by the snapshot guard needs a Db opened and the migration run first.
 */
const readsAfterMigration = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<WorldFeature> =>
	action.kind === "migrate"
		? Arr.flatMap(branchesOf(state, action), (b) =>
				b.observation.kind === observation.kind
					? Arr.flatMap(enumerateKind(b.next, "read", defaultScope), (a) =>
							a.kind === "read" && b.next.sessions[a.session]?.kind === "db"
								? Arr.flatMap(step(b.next, a), (c) => notedOf(b.next, a, c.observation))
								: []
						)
					: []
			)
		: []

/**
 * A lead for a suite requiring what a Db shows once a migration moved past its snapshot: while it is pending, a live
 * open of a Db, a migration after which a read through an open Db reaches it (readsAfterMigration, aimed on every draw
 * among the box's migrations), and that read, aimed at it. The read comes two moves after the open whose snapshot it
 * holds, past the one-step reach of a suite's own aims.
 */
export const callPastAMigration =
	(required: ReadonlyArray<Reached<WorldFeature>>): Lead =>
	(weights, _install, at) => {
		const [first, ...rest] = requiredFeatures(
			required,
			(feature) => feature === "connection:after-stale-snapshot"
		)
		if (first === undefined) {
			return []
		}
		const targets: Arr.NonEmptyReadonlyArray<WorldFeature> = [first, ...rest]
		return whilePending(targets, at, () => [
			{
				...weights,
				kinds: ["open-db"],
				actions: { ...zeroWeights.actions, "open-db": 1 },
				validity: liveOnly
			},
			{
				...weights,
				kinds: ["migrate"],
				actions: { ...zeroWeights.actions, migrate: 1 },
				aims: everyDraw(targets, readsAfterMigration, (a) => a.kind === "migrate")
			},
			dbCall(weights, "read", targets, notedOf)
		])
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
 * and how many actions its program runs after them. The property draws the rest from the case's own tape (`Case.draw`):
 * the reality once the installation's names exist, and each action from the model's state as the program reaches it,
 * so every draw replays and shrinks with the case.
 */
export interface ProgramCase {
	readonly install: InstallSpec
	readonly ambient: AmbientSession
	readonly weights: Weights
	readonly lead: Lead
	/** Whether the program takes a targeted lead (Leading). */
	readonly led: boolean
	readonly steps: number
}

/** How a case draws past its sketch: from its own tape (`Case.draw`), so the draw replays and shrinks with the case. */
export type CaseDraw = Case<WorldFeature>["draw"]

/**
 * What a case's steering leaves pending, read of the library's steering (`Case.steering`): none where a case may not
 * steer (the rotating stream, a kept case), so it aims at nothing; otherwise, a replay of a steered case among them,
 * since its token carries the steering it was drawn under, whether an aim, any text, is still pending: a feature of
 * the worlds feature map or of the suite's own requirements that a required situation the run had not reached when the
 * case's window began holds, or any other text, a lead's own move among them, which no case notes.
 */
export type Pending = Option.Option<(aim: string) => boolean>

/** Every feature of the worlds feature map by its text: the features a suite requires, and so the ones it aims at. */
const requirable: ReadonlyMap<string, WorldFeature> = new Map<string, WorldFeature>(
	Arr.map(
		Arr.flatMap(requiredWorldFeatures, (r): ReadonlyArray<WorldFeature> =>
			Predicate.isString(r) ? [r] : r
		),
		(feature) => [feature, feature] as const
	)
)

/**
 * A case's pending aims (Pending), each feature of the worlds feature map (requirable) and of the suite's own
 * requirements `required` read of the case's steering, so a feature a suite of its own requires (an education role's
 * write, say) is pending only while it is.
 */
const pendingOf = <F extends string>(
	steering: Case<F | WorldFeature>["steering"],
	required: ReadonlyArray<Reached<F | WorldFeature>>
): Pending => {
	const named = new Map<string, F | WorldFeature>([
		...requirable,
		...Arr.map(
			Arr.flatMap(required, (r): ReadonlyArray<F | WorldFeature> =>
				typeof r === "string" ? [r] : r
			),
			(feature) => [feature, feature] as const
		)
	])
	return Option.map(steering, (pending) => (aim: string) => {
		const feature = named.get(aim)
		return feature === undefined || pending.names(feature)
	})
}

/**
 * A program's lead: the weights of the draws it makes before its own steps, one per draw, from the case's weights, its
 * installation and what the case's steering leaves pending. A move a suite needs is drawn here by construction, not by
 * weighting the program's own draws: a draw narrowed to one kind and role, or aimed on every draw at the move (Aims
 * `every`). A lead toward required features draws only while one of them is pending (whilePending).
 */
export type Lead = (weights: Weights, install: InstallSpec, at: Leading) => ReadonlyArray<Weights>

/**
 * Where a program's lead stands: whether the case takes a targeted lead at all (three in four do; the fourth keeps
 * every draw its own, from the staged state, as an unsteered program would), and what the case's steering leaves
 * pending (Pending), read only by a lead that needs it.
 */
export interface Leading {
	readonly led: boolean
	readonly pending: Pending
}

/** No lead: a program draws only its own steps. */
export const noLead: Lead = (): ReadonlyArray<Weights> => []

/** Leads one after another: each one's draws, in order. */
export const leadsOf =
	(...leads: Arr.NonEmptyReadonlyArray<Lead>): Lead =>
	(weights, install, at) =>
		Arr.flatMap(leads, (lead) => lead(weights, install, at))

/**
 * A targeted lead's draws, in a case that takes its lead, while a feature it reaches is still pending; none once every
 * one is reached, nor where the case may not steer, so a lead spends no program's draws on what the population already
 * holds, the rotating stream's cases are plain draws of the suite's distribution, and one program in four keeps every
 * draw its own.
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
): ReadonlyArray<WorldFeature> =>
	Arr.filter(
		Arr.flatMap(required, (r): ReadonlyArray<WorldFeature> => (Predicate.isString(r) ? [r] : r)),
		holds
	)

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
	(aimed: (role: RoleSpec) => ReadonlyArray<string>, read: Aiming["read"]): Lead =>
	(weights, install, at) => {
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
	const [first, ...rest] = Arr.flatMap(required, (r): ReadonlyArray<F> =>
		Predicate.isString(r) ? [r] : r
	)
	return first === undefined
		? noAims
		: {
				kind: "half",
				features: [first, ...rest],
				read,
				worth: everyActionWorth,
				scope: aimScope
			}
}

/** The features an outcome reaches, read in the state its action ran in. */
type FeatureReading<F extends string> = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
) => ReadonlyArray<F>

/** What a world-model suite draws: its focus, every role, aimed at its required worlds features, after its lead. */
const worldDraws = (spec: Pick<ProgramSuite, "focus" | "required" | "lead">): Draws => ({
	kinds: spec.focus,
	roles: everyRole,
	aims: aimsAt(spec.required, notedOf),
	lead: spec.lead
})

/** The program cases of a suite's installations and draws, each running up to `maxSteps` actions after its lead. */
export const programCaseGen =
	(installs: Gen<InstallSpec>, { lead, ...draws }: Draws, maxSteps: number): Gen<ProgramCase> =>
	(source) => ({
		install: source.draw(installs),
		ambient: source.draw(ambientSessionGen),
		weights: { ...source.draw(weightsGen), ...draws },
		steps: source.draw(int(1, maxSteps)),
		led: source.draw(int(0, 3)) > 0,
		lead
	})

/** How a suite realizes a case's installation under its ambient session: fresh, or on a pool of a size it names. */
export type Realize = (
	install: InstallSpec,
	ambient: AmbientSession
) => Effect.Effect<RealWorld, RealizeRefused | SqlError, Scope.Scope | Substrate>

/** A world brought to a case's start: the real world and the model's state of it. */
export interface Staged {
	readonly world: RealWorld
	readonly start: ModelState
}

/**
 * Brings a realized world to a drawn reality: the reality is drawn from the case's tape, among the suite's realities
 * over the host schema the installation's names give, the world reset to it (every session closed, the facts replaced,
 * the derived relations refreshed), and the model's initial state over those names checked against the real system.
 */
export const stage = (
	world: RealWorld,
	install: InstallSpec,
	draw: CaseDraw,
	realities: Realities
): Effect.Effect<Staged, SqlError | ModelMismatch> =>
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
 * none pending stay as they are. Where the case may not steer, the weights are the case's own, unsteered, so every
 * case of the rotating stream is an independent draw of the suite's distribution, the only kind residual risk counts.
 * A case's steering is the snapshot its window began with, so every draw of a program reads one answer.
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
 * The weights of a case that draws one action, steered (steered): while a feature it aims at is pending, its draw is
 * aimed every time rather than half the time, since the case has no other draw for the unaimed half; once every one
 * is reached, or where the case may not steer, the case's own weights, whose aims keep their kind.
 */
export const steeredOnce = (weights: Weights, c: Pick<Case<WorldFeature>, "steering">): Weights => {
	const pending = pendingOf(c.steering, requiredWorldFeatures)
	const aimed = steered(weights, pending, nothingReached)
	const aims = aimed.aims
	return aims.kind === "half" &&
		Option.exists(pending, (isPending) => Arr.some(aims.features, isPending))
		? { ...aimed, aims: { ...aims, kind: "every" } }
		: aimed
}

/**
 * A state an inductive case builds past its planned Db sessions, one action before what it reaches: the required
 * features that action reaches there, and the weights of the moves that build it, each aimed on every draw.
 */
export interface InductiveLead {
	readonly targets: Arr.NonEmptyReadonlyArray<WorldFeature>
	readonly moves: (weights: Weights) => Arr.NonEmptyReadonlyArray<Weights>
}

/**
 * What only a Db's apply shows of a world object: a key probe refusing a key outside the entry it writes, and the
 * witness it shows there (features.ts applyObjects); a direct writer's call of a probe is accepted or refused as an
 * attempt.
 */
const appliedProbe = (feature: WorldFeature): boolean =>
	startingWith("object:key-probe:refused-outside", "object:key-probe:witness-shown")(feature)

/**
 * What a Db's write shows: its op feature, whatever the membership of what it met, the claims it ran under and its
 * outcome, and a probe refusing a key outside the entry it writes and the witness it shows there (appliedProbe).
 */
const dbWrite = (feature: WorldFeature): boolean => {
	const [tag, kind, , , writer] = Str.split(feature, ":")
	return (tag === "op" && kind === "apply" && writer === "db") || appliedProbe(feature)
}

/** The features of an inductive lead, and its moves toward them. */
interface InductiveShape {
	readonly reaches: (feature: WorldFeature) => boolean
	readonly moves: (
		weights: Weights,
		targets: Arr.NonEmptyReadonlyArray<WorldFeature>
	) => Arr.NonEmptyReadonlyArray<Weights>
}

/**
 * The inductive suite's leads over `required`, each with a required feature to reach:
 * - a transaction begun one statement from a direct writer's feature (afterBegin), any but what only a Db's apply shows
 *   (appliedProbe): the role it took on and the claims it set, none, some or malformed, decide which facts lie inside,
 *   outside and hidden from its world and which world function it may call;
 * - a transaction one statement in, aimed so that its COMMIT or, after a delete, a read of it reaches a feature
 *   (afterWrite): a law checked at COMMIT that the statement broke, or a fact
 *   the transaction deleted, gone from what it reads;
 * - a Db that deleted a fact a derived relation is computed from, one read or refresh before the derived relation shows
 *   it or drops it (staleDerivedMoves);
 * - a Db opened one apply from what a Db's write shows (aimedOpen, dbWrite): the role it opens as and the claims its
 *   token carries decide which facts lie inside, outside and hidden from the entry each apply writes, and an apply
 *   waits on a direct transaction the planned state holds (drive/index.ts serial), so a planned Db rarely offers the
 *   write a feature needs: a write under claims that disagree with a fact it submits needs a token carrying every
 *   context an entry reads whose head holds a field a claim fixes.
 */
export const inductiveLeads = (
	required: ReadonlyArray<Reached<WorldFeature>>
): ReadonlyArray<InductiveLead> => {
	const shapes: ReadonlyArray<InductiveShape> = [
		{
			reaches: (f) => directReach(f) && !appliedProbe(f),
			moves: (weights, targets) => [aimedBegin(weights, targets, afterBegin)]
		},
		{
			reaches: (f) => atCommitRefusals(f) || goneFromItsWorld(f),
			moves: (weights, targets) => oneStatementIn(weights, targets, afterWrite)
		},
		{ reaches: startingWith("deletion:derived-"), moves: staleDerivedMoves },
		{ reaches: dbWrite, moves: (weights, targets) => [aimedOpen(weights, targets, ["apply"])] }
	]
	return Arr.flatMap(shapes, (shape) =>
		Arr.match(requiredFeatures(required, shape.reaches), {
			onEmpty: (): ReadonlyArray<InductiveLead> => [],
			onNonEmpty: (targets) => [{ targets, moves: (weights) => shape.moves(weights, targets) }]
		})
	)
}

/**
 * What a led inductive case does past its planned Db sessions: the weights of its lead's moves, steered, and the
 * features its one action then aims at.
 */
export interface Led {
	readonly moves: ReadonlyArray<Weights>
	readonly aims: ReadonlyArray<Reached<WorldFeature>>
}

/**
 * The lead of a led inductive case, drawn from its tape: where the case steers, among the leads with a target still
 * pending, none once no lead's is, so a steered case spends no move on what the population already holds and its one
 * action goes to what is still pending from the Db sessions it planned; where the case may not steer, among all of
 * them, so the rotating stream's led cases are plain draws of the suite's distribution. Its moves are steered toward
 * what is pending (steered); its one action aims at the lead's pending targets, or at `required` where the case may
 * not steer. A led case without a lead takes no move.
 */
export const leadOf = (
	leads: ReadonlyArray<InductiveLead>,
	required: ReadonlyArray<Reached<WorldFeature>>,
	weights: Weights,
	c: Pick<Case<WorldFeature>, "steering" | "draw">
): Led => {
	const pending = pendingOf(c.steering, required)
	const pendingIn = (lead: InductiveLead): ReadonlyArray<WorldFeature> =>
		Arr.filter(lead.targets, (f) => Option.exists(pending, (isPending) => isPending(f)))
	const open = Arr.filter(leads, (lead) => Arr.isReadonlyArrayNonEmpty(pendingIn(lead)))
	return Arr.match(Option.isSome(pending) ? open : leads, {
		onEmpty: (): Led => ({ moves: [], aims: required }),
		onNonEmpty: (candidates): Led => {
			const lead = c.draw(element(candidates))
			const still = pendingIn(lead)
			return {
				moves: Arr.map(lead.moves(weights), (w) => steered(w, pending, nothingReached)),
				aims: Arr.isReadonlyArrayNonEmpty(still) ? still : required
			}
		}
	})
}

/** What a suite sees of one action its program performed: the state it ran in, its answer and the state after it. */
export interface Seen {
	readonly index: number
	readonly before: ModelState
	readonly action: Action
	readonly observation: ActionOutcome
	readonly after: ModelState
}

/** One performed action as a suite's rule judges it: what the suite saw of it, and of every action before it. */
export interface Checked {
	readonly seen: Seen
	readonly earlier: ReadonlyArray<Seen>
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
	readonly seen: ReadonlyArray<Seen>
	readonly reached: ReadonlySet<string>
}

/**
 * Runs a case's program on its staged world: its lead's draws, each under its own weights, then `pc.steps` actions
 * under the case's; each drawn from the case's tape in the state the model is in after the one before (drawAction),
 * performed by the driver (runStep) and held to the suite's own rule. Its lead and its aims read what the case's
 * steering leaves pending of the suite's requirements `required` (pendingOf). Returns the last state.
 */
export const driveProgram = <F extends string>(
	staged: Staged,
	pc: ProgramCase,
	c: Case<F | WorldFeature>,
	required: ReadonlyArray<Reached<F | WorldFeature>>,
	check: StepCheck
): Effect.Effect<ModelState, ModelMismatch> =>
	Effect.suspend(() => {
		const pending = pendingOf(c.steering, required)
		const lead = pc.lead(pc.weights, pc.install, { led: pc.led, pending })
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
						const seen: Seen = {
							index,
							before: at.state,
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
								...notedOf(at.state, action, stepped.observation)
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
 * A suite of generated programs: its label, the name of its test, the installations it draws, how it realizes them,
 * the action kinds it draws, the longest program and the count of cases, the features its population must reach, and
 * its own rule over each action.
 */
export interface ProgramSuite {
	readonly suite: string
	readonly name: string
	readonly installs: Gen<InstallSpec>
	readonly realize: Realize
	readonly focus: Focus
	readonly steps: number
	readonly cases: number
	readonly required: Situations<WorldFeature>
	readonly check: StepCheck
	/** The realities its cases draw (drawnRealities, or a targeted mix). */
	readonly realities: Realities
	/** What each program draws first (Lead): noLead, or moves the suite needs in every program. */
	readonly lead: Lead
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
 * claim, refresh lists, two logins), over the base (docsInstall), its one-share variant (docsOneShareInstall), where
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

/** A fresh realization of each case's installation, on the executor's default pools. */
export const fresh: Realize = realize

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

/** The most shrink candidates a failing program tries: every case installs a schema of its own. */
const programShrink = 200

/** How many cases a program suite's steered phase may run, as a multiple of its cases. */
const programSteered = 4

/**
 * Registers a program suite's test: each case realizes its installation, stages its reality and runs its program under
 * the driver and the suite's rule. A steered phase of up to programSteered times as many cases as the suite runs aims
 * programs, through their leads and aims, at the required features no case has reached yet, and stops once every one
 * is reached; the rotating stream's programs aim at nothing. Every case installs a schema of its own, so a failure
 * shrinks through at most programShrink candidates.
 */
export const programTests = (it: Vitest.MethodsNonLive<Substrate>, spec: ProgramSuite): void => {
	it.effect(spec.name, (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: spec.suite,
					draw: drawn(programCaseGen(spec.installs, worldDraws(spec), spec.steps)),
					literal: Formatter.format,
					coverage: required<WorldFeature>(spec.required, {
						cases: programSteered * spec.cases,
						sense: notesOnly
					}),
					kept: [],
					runs: spec.cases,
					shrink: { kind: "bounded", candidates: programShrink },
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(pc, c) =>
					Effect.scoped(
						Effect.gen(function* () {
							const world = yield* spec.realize(pc.install, pc.ambient)
							noteNaming(pc, c)
							const staged = yield* stage(world, pc.install, c.draw, spec.realities)
							yield* driveProgram(staged, pc, c, spec.required, spec.check)
						})
					)
			)
		)
	)
}

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

/** The feature of drawing each invalid kind, for a suite that requires every kind it draws. */
export const invalidFeatures = (kinds: ReadonlyArray<InvalidKind>): ReadonlyArray<WorldFeature> =>
	Arr.map(kinds, (kind): WorldFeature => `invalid:${kind}`)
