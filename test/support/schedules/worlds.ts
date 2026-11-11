import { Array as Arr, Effect, Option, Record, type Scope, String as Str } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { sameIdentity, valueIdentityOrder } from "#test/support/kernel/identity.ts"
import {
	type HostSchema,
	rowsDifference,
	stateRows,
	type Violation,
	violations
} from "#test/support/laws/model.ts"
import { messageOf } from "#test/support/message.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import {
	allowed,
	type Backend,
	everyRelation,
	exploreEnv,
	exploreInterleavings,
	type Footprint,
	type Interleaving,
	type Judgment,
	type MoveRecord,
	refusedJudgment,
	relationsFootprint,
	runawayInterleavings,
	type Strategy,
	type Txn,
	type WorldStep
} from "#test/support/schedules/interleave.ts"
import type { StepOutcome } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { submittedTexts } from "#test/support/worlds/drive/index.ts"
import { realizeRace, type RacingWorld } from "#test/support/worlds/execute/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { factKey, hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { loginHolding } from "#test/support/worlds/model/session/state.ts"
import {
	expectedProbe,
	hiddenTokens,
	initialState,
	observedNext,
	settle,
	step
} from "#test/support/worlds/model/step.ts"

import type {
	Action,
	Branch,
	DirectStatement,
	EntrySpec,
	HostFact,
	HostState,
	InstallSpec,
	Isolation,
	LawSpec,
	ModelState,
	Observation,
	Probe
} from "#test/support/worlds/model/types.ts"

/**
 * A Db's work in a race: actions on a Db session the race's setup opened, each a transaction of its own, and probes of
 * the pooled connection between them. `blocked` is the environment's interruption point for an action: wait out a lock
 * it meets, or interrupt the call there, mid-flight, as a caller's interruption does.
 */
export type RaceOp =
	| { readonly kind: "act"; readonly action: Action; readonly blocked: "wait" | "interrupt" }
	| { readonly kind: "probe"; readonly session: number }

/**
 * One session of a race. A Db session runs its operations in order on its pooled connection; a direct session is one
 * SERIALIZABLE-or-below transaction of a login's own connection: its BEGIN, its statements (SET ROLE and the claims
 * setting among them, as a direct writer sets them by hand), and its end.
 */
export type RaceSession =
	| {
			readonly kind: "db"
			readonly name: string
			readonly session: number
			readonly ops: Arr.NonEmptyReadonlyArray<RaceOp>
	  }
	| {
			readonly kind: "direct"
			readonly name: string
			readonly login: string
			readonly isolation: Isolation
			readonly statements: Arr.NonEmptyReadonlyArray<DirectStatement>
			readonly end: "commit" | "rollback"
	  }

/**
 * A race as data: the installation, the reality its runs start from, the setup actions that open its Dbs (their
 * sessions are numbered in setup order, as the model numbers them), its sessions, the pool size each login's DbLayer
 * gets, and the strategy that orders the sessions' moves. The pool size is an environment choice: with one connection,
 * every Db of a login shares it, and with two, which connection serves which Db is nature's choice, recorded on the
 * tape as each move's backend.
 */
export interface WorldRace {
	readonly name: string
	readonly install: InstallSpec
	readonly reality: HostState
	readonly setup: ReadonlyArray<Action>
	readonly sessions: ReadonlyArray<RaceSession>
	readonly poolSize: 1 | 2
	readonly strategy: (moves: number) => Strategy
}

/**
 * How a race transaction ended, by README "Transactions and concurrency": committed, refused (a law, the world or the
 * server refused it, and it committed nothing), failed with a typed transient failure, or interrupted.
 */
type Ending = "commit" | "refusal" | "transient" | "interruption"

/**
 * What a race run reached: each transaction's ending, a probe of a Db session's pooled connection right after a
 * transaction of that session ended each way, every observation kind, overlaps, lock waits and deadlocks.
 */
export type WorldRaceFeature =
	| `ended: ${Ending}`
	| `probed after: ${Ending}`
	| `observed: ${Observation["kind"]}`
	| "overlapping"
	| "blocked"
	| "deadlock"
	| `pool of ${1 | 2}`

/** The relations a role relation reads: a whole entry its relation; a query entry every relation its rules match. */
const entryReads = (entry: EntrySpec): ReadonlyArray<string> => {
	switch (entry.kind) {
		case "whole":
			return [entry.relation]
		case "query":
			return Arr.flatMap(entry.rules, (rule) =>
				Arr.flatMap([...rule.matches, ...rule.negations.flat()], (o) =>
					o.source.kind === "context" ? [] : [o.source.name]
				)
			)
	}
}

/** Every relation a law of the base joins. */
const lawJoins = (law: LawSpec): ReadonlyArray<string> => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
			return [law.relation]
		case "contained":
		case "covered":
			return [law.source.relation, law.target.relation]
		case "alternatives":
			return [law.relation, ...Record.values(law.arms)]
	}
}

/**
 * The footprint of a write to `written`: the relations it writes and reads, closed under the laws, since a law's check
 * reads every relation it joins. Two moves commute only when no law joins what they touch.
 */
const writeFootprint = (install: InstallSpec, written: ReadonlyArray<string>): Footprint => {
	const out = new Set(written)
	for (let grew = true; grew;) {
		const joining = Arr.filter(
			Arr.map(install.base.laws, lawJoins),
			(joined) => Arr.some(joined, (r) => out.has(r)) && Arr.some(joined, (r) => !out.has(r))
		)
		for (const r of joining.flat()) {
			out.add(r)
		}
		grew = joining.length > 0
	}
	return relationsFootprint(out)
}

/** A role's relation by name; a race naming another is a defect of the race. */
const entryOf = (install: InstallSpec, role: string, relation: string): EntrySpec =>
	Option.getOrThrowWith(
		Option.flatMap(
			Arr.findFirst(install.roles, (r) => r.name === role),
			(r) => Record.get(r.entries, relation)
		),
		() => new Error(`the race names ${role}.${relation}, which the installation does not hold`)
	)

/** A derived relation's rules' reads, with the derived relation itself, which its refresh writes. */
const refreshReads = (install: InstallSpec, derived: string): ReadonlyArray<string> => [
	derived,
	...Arr.flatMap(
		Option.match(
			Arr.findFirst(install.base.derived, (d) => d.name === derived),
			{ onNone: () => [], onSome: (d) => d.rules }
		),
		(rule) => entryReads({ kind: "query", rules: [rule] })
	)
]

/**
 * What a Db action reads or writes, through its role's relations: a write the relations its entries read (an entry's
 * filter included) closed under the laws, a read the relations its entry reads, a refresh its derived relation and the
 * relations that relation reads. Opening, closing and interrupting touch no relation.
 */
const actionFootprint = (
	install: InstallSpec,
	roleOf: (session: number) => string,
	action: Action
): Footprint => {
	switch (action.kind) {
		case "apply":
			return writeFootprint(
				install,
				Arr.flatMap(
					[...Arr.map(action.strata.flat(), (op) => op.relation), ...action.reads],
					(relation: string) => entryReads(entryOf(install, roleOf(action.session), relation))
				)
			)
		case "read":
			return relationsFootprint(
				entryReads(entryOf(install, roleOf(action.session), action.relation))
			)
		case "refresh":
			return writeFootprint(install, refreshReads(install, action.relation))
		case "open-db":
		case "close":
		case "interrupt":
		case "direct-begin":
		case "direct":
		case "direct-end":
			return relationsFootprint([])
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return everyRelation
	}
}

/** What a direct statement reads or writes: a view its entry's relations; a table write that table under the laws. */
const statementFootprint = (install: InstallSpec, statement: DirectStatement): Footprint => {
	switch (statement.kind) {
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
			return relationsFootprint([])
		case "select-view":
			return relationsFootprint(entryReads(entryOf(install, statement.role, statement.relation)))
		case "select-table":
			return relationsFootprint([statement.relation])
		case "insert":
		case "insert-on-conflict":
		case "merge-delete":
		case "delete":
		case "update":
		case "truncate":
		case "setval":
			return writeFootprint(install, [statement.relation])
		case "call":
		case "prepare":
		case "execute-prepared":
			return everyRelation
	}
}

const union = (footprints: ReadonlyArray<Footprint>): Footprint =>
	Arr.some(footprints, (f) => f.kind === "every")
		? everyRelation
		: relationsFootprint(
				Arr.flatMap(footprints, (f) => (f.kind === "relations" ? [...f.relations] : []))
			)

/** Whether an observation is a typed transient failure: grizzle's TransientFailure, or a direct writer's 40001 or 40P01. */
const isTransient = (o: Observation): boolean =>
	o.kind === "transient" ||
	(o.kind === "refused" && (o.sqlstate === "40001" || o.sqlstate === "40P01"))

/** Whether an observation refuses its transaction: the transaction commits nothing and is judged in an order of its own. */
const isRefusal = (o: Observation): boolean => {
	switch (o.kind) {
		case "invariant-rejected":
		case "law-refused":
		case "encoding-refused":
		case "outside-world":
		case "compile-refused":
		case "resource-bound":
		case "open-refused":
		case "migration-refused":
		case "handle-refused":
		case "stale-snapshot":
			return true
		case "refused":
			return !isTransient(o)
		case "opened":
		case "rows":
		case "applied":
		case "transient":
		case "commit-unknown":
		case "interrupted":
		case "ok":
		case "drift":
		case "leak":
		case "artifacts-disagree":
			return false
	}
}

/** An observation as the driver's step outcome: a refusal or transient failure is the session's failure. */
const stepOutcomeOf = (o: Observation): StepOutcome =>
	isTransient(o) || isRefusal(o)
		? { _tag: "Failed", error: o }
		: { _tag: "Ok", rows: [], rowCount: 0 }

/** A run's span of a transaction: from its first move's issue to its last move's finish. */
interface Span {
	readonly start: number
	readonly end: number
}

/** What one transaction of a race did in a run. */
type Ran =
	| {
			readonly kind: "op"
			readonly label: string
			/** The Db session it ran on. */
			readonly session: number
			readonly action: Action
			readonly result:
				| { readonly kind: "observed"; readonly observation: Observation }
				| { readonly kind: "interrupted" }
			readonly span: Span
	  }
	| {
			readonly kind: "probe"
			readonly label: string
			readonly session: number
			readonly probe: Probe
			readonly span: Span
	  }
	| {
			readonly kind: "direct"
			readonly label: string
			readonly session: Extract<RaceSession, { readonly kind: "direct" }>
			readonly observations: ReadonlyArray<Observation>
			readonly span: Span
	  }

const endingOf = (r: Ran): Ending | "read" => {
	switch (r.kind) {
		case "probe":
			return "read"
		case "op": {
			if (r.result.kind === "interrupted") {
				return "interruption"
			}
			const o = r.result.observation
			return isTransient(o)
				? "transient"
				: isRefusal(o)
					? "refusal"
					: o.kind === "interrupted" || o.kind === "commit-unknown"
						? "interruption"
						: "commit"
		}
		case "direct": {
			if (Arr.some(r.observations, isTransient)) {
				return "transient"
			}
			if (
				Arr.some(r.observations, (o) => o.kind === "interrupted" || o.kind === "commit-unknown")
			) {
				return "interruption"
			}
			return Arr.some(r.observations, isRefusal) || r.session.end === "rollback"
				? "refusal"
				: "commit"
		}
	}
}

const sameProbe = (a: Probe, b: Probe): boolean =>
	a.transaction === "aborted" || b.transaction === "aborted"
		? a.transaction === b.transaction
		: a.transaction === b.transaction && a.currentUser === b.currentUser && a.claims === b.claims

const describeProbe = (p: Probe): string =>
	p.transaction === "aborted"
		? "an aborted transaction"
		: `${p.transaction} as ${p.currentUser}, claims "${p.claims}"`

/** An observation with an `opened` session renumbered, so the model's and the real system's numbering compare. */
const renumbered = (o: Observation, session: number): Observation =>
	o.kind === "opened" ? { ...o, session } : o

/**
 * The model's branches of an action, a landing completed under the compiler's names for the installation it lands
 * (execute/names.ts installedNames): the judge folds the model alone, after the run.
 */
const branchesOf = (state: ModelState, action: Action): Arr.NonEmptyReadonlyArray<Branch> =>
	Arr.map(step(state, action), (s) => settle(s, installedNames))

/** The candidate next states of one observed action from `state`, or why none matches. */
const branchesMatching = (
	state: ModelState,
	action: Action,
	observed: Observation
): {
	readonly next: ReadonlyArray<{ readonly state: ModelState; readonly observation: Observation }>
	readonly why: string
} => {
	const branches = branchesOf(state, action)
	const next = Arr.flatMap(branches, (b) => {
		const seen =
			b.observation.kind === "opened" ? renumbered(observed, b.observation.session) : observed
		const taken =
			seen.kind === "leak" || seen.kind === "artifacts-disagree" ? undefined : observedNext(b, seen)
		return taken === undefined ? [] : [{ state: taken, observation: b.observation }]
	})
	return {
		next,
		why: `${action.kind} observed ${observed.kind}, the model allows ${Arr.join(
			Arr.map(branches, (b) => b.observation.kind),
			" or "
		)}`
	}
}

/**
 * The states a transaction leads to from `state` with every observation it made, or why it cannot be at this place. A
 * direct transaction folds contiguously: its BEGIN, then each statement on the session the model's BEGIN opened, then
 * its end. An action the driver interrupted mid-flight may have applied or not, as the README treats an interrupted
 * write: the state unchanged, or any state an applied branch leads to.
 */
const foldRan = (
	state: ModelState,
	r: Ran
): { readonly next: ReadonlyArray<ModelState>; readonly why: string } => {
	switch (r.kind) {
		case "probe": {
			const want = expectedProbe(state, r.session)
			return {
				next: sameProbe(want, r.probe) ? [state] : [],
				why: `the probe read ${describeProbe(r.probe)}; the model expects ${describeProbe(want)}`
			}
		}
		case "op": {
			if (r.result.kind === "interrupted") {
				const applied = Arr.filter(
					branchesOf(state, r.action),
					(b) => b.observation.kind === "applied"
				)
				return { next: [state, ...Arr.map(applied, (b) => b.next)], why: "" }
			}
			const found = branchesMatching(state, r.action, r.result.observation)
			return { next: Arr.map(found.next, (b) => b.state), why: found.why }
		}
		case "direct":
			return foldDirect(state, r)
	}
}

/** The states `observed` leads to through `actions` from `start`, each observation matched in turn, or why none does. */
const foldActions = (
	start: ModelState,
	actions: ReadonlyArray<Action>,
	observed: ReadonlyArray<Observation>,
	label: string
): { readonly next: ReadonlyArray<ModelState>; readonly why: string } => {
	let states: ReadonlyArray<ModelState> = [start]
	for (const [i, o] of observed.entries()) {
		const action = actions[i]
		if (action === undefined) {
			return { next: [], why: `${label} observed more than its actions` }
		}
		const reached = Arr.map(states, (state) => branchesMatching(state, action, o))
		states = Arr.flatMap(reached, (x) => Arr.map(x.next, (n) => n.state))
		if (states.length === 0) {
			return {
				next: [],
				why: `${label}: ${Arr.join(
					Arr.map(reached, (x) => x.why),
					"; "
				)}`
			}
		}
	}
	return { next: states, why: "" }
}

const foldDirect = (
	state: ModelState,
	r: Extract<Ran, { readonly kind: "direct" }>
): { readonly next: ReadonlyArray<ModelState>; readonly why: string } => {
	const [begun, ...rest] = r.observations
	if (begun === undefined) {
		return { next: [], why: `${r.label} observed nothing` }
	}
	const opened = branchesMatching(
		state,
		{
			kind: "direct-begin",
			login: r.session.login,
			isolation: r.session.isolation,
			start: { current: { kind: "login" }, claims: { kind: "none" } }
		},
		begun
	)
	const actionsOf = (session: number): ReadonlyArray<Action> => [
		...Arr.map(r.session.statements, (statement): Action => ({
			kind: "direct",
			session,
			statement
		})),
		{ kind: "direct-end", session, end: r.session.end }
	]
	const folded = Arr.flatMap(opened.next, (b) =>
		b.observation.kind === "opened"
			? [foldActions(b.state, actionsOf(b.observation.session), rest, r.label)]
			: []
	)
	const next = Arr.flatMap(folded, (f) => f.next)
	const whys = Arr.filter(
		[opened.next.length === 0 ? opened.why : "", ...Arr.map(folded, (f) => f.why)],
		(w) => w !== ""
	)
	return { next, why: Arr.join(whys, "; ") }
}

/** What a run committed, read back as the owner: every base relation's facts, and every derived relation's. */
interface Stored {
	readonly reality: HostState
	readonly derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
}

/** Whether two derived relations' facts are one set of facts, each by its identity. */
const sameFacts = (a: ReadonlyArray<HostFact>, b: ReadonlyArray<HostFact>): boolean => {
	const keys = (facts: ReadonlyArray<HostFact>) =>
		Arr.sort(Arr.map(facts, factKey), valueIdentityOrder)
	const [x, y] = [keys(a), keys(b)]
	return (
		x.length === y.length && Arr.every(x, (k, i) => sameIdentity(k, defined(y[i], "a fact's key")))
	)
}

/** A derived relation's facts: the model and the read-back both hold every derived relation of the base. */
const derivedFacts = (
	derived: Readonly<Record<string, ReadonlyArray<HostFact>>>,
	name: string
): ReadonlyArray<HostFact> =>
	Option.getOrThrowWith(
		Record.get(derived, name),
		() => new Error(`no facts of the derived relation ${name}`)
	)

/** Why a model state's reality and derived relations are not what the run committed, if they are not. */
const storedDifference = (
	host: HostSchema,
	state: ModelState,
	stored: Stored
): Option.Option<string> =>
	Option.orElse(
		rowsDifference(stateRows(host, state.reality), stateRows(host, stored.reality)),
		() =>
			Option.map(
				Arr.findFirst(
					state.install.base.derived,
					(d) =>
						!sameFacts(derivedFacts(state.derived, d.name), derivedFacts(stored.derived, d.name))
				),
				(d) => `${d.name} holds other facts`
			)
	)

/** A serial order that explains the placed transactions and ends at the committed state, or why none does. */
const serialOrder = (
	host: HostSchema,
	initial: ModelState,
	placed: ReadonlyArray<Ran>,
	committed: Stored
): { readonly ok: true } | { readonly ok: false; readonly problem: string } => {
	const before = Arr.map(placed, (r) =>
		Arr.flatMap(placed, (q, j) => (q.span.end < r.span.start ? [j] : []))
	)
	const order: Array<string> = []
	let deepest: { readonly order: ReadonlyArray<string>; readonly reasons: ReadonlyArray<string> } =
		{
			order: [],
			reasons: []
		}
	const search = (done: ReadonlyArray<boolean>, state: ModelState): boolean => {
		if (order.length === placed.length) {
			const difference = storedDifference(host, state, committed)
			if (Option.isNone(difference)) {
				return true
			}
			if (order.length >= deepest.order.length) {
				deepest = {
					order: [...order],
					reasons: [`this order ends at another state: ${difference.value}`]
				}
			}
			return false
		}
		const reasons: Array<string> = []
		for (const [i, r] of placed.entries()) {
			if (done[i] === true || Arr.some(before[i] ?? [], (j) => done[j] !== true)) {
				continue
			}
			const folded = foldRan(state, r)
			if (folded.next.length === 0) {
				reasons.push(`${r.label}: ${folded.why}`)
				continue
			}
			const next = Arr.map(done, (d, j) => d || j === i)
			order.push(r.label)
			if (Arr.some(folded.next, (after) => search(next, after))) {
				return true
			}
			order.pop()
		}
		if (order.length >= deepest.order.length && reasons.length > 0) {
			deepest = { order: [...order], reasons }
		}
		return false
	}
	if (
		search(
			Arr.map(placed, () => false),
			initial
		)
	) {
		return { ok: true }
	}
	return {
		ok: false,
		problem: Arr.join(
			[
				`deepest explained prefix: ${Arr.join(deepest.order, ", ")}`,
				...Arr.map(deepest.reasons, (x) => `  ${x}`)
			],
			"\n"
		)
	}
}

const describeViolations = (found: ReadonlyArray<Violation>): string =>
	Arr.join(
		Arr.map(found, (v) => v.law),
		", "
	)

/**
 * Why a run is not one the worlds model allows, or undefined. The committed state keeps every law (the history
 * checker's rule, evaluated by the host). A transient failure changed nothing, wherever it falls: PostgreSQL's SSI may
 * refuse a transaction with no other transaction overlapping it once it summarizes old committed ones under load (README
 * "Transactions and concurrency"). The committed and interrupted transactions, the reads and the probes take
 * their places in one serial order that respects real time, folded through the model from the initial state: every
 * observation is one the model allows at its place, and the order ends at the committed state. Each refused transaction
 * takes its place in a serial order of the committed ones and itself alone: SSI orders the committed transactions, and
 * a refused one committed nothing, so only the order it read in is asked of it.
 */
const judgeWorldRun = (
	host: HostSchema,
	initial: ModelState,
	ran: ReadonlyArray<Ran>,
	committed: Stored
): Judgment => {
	const broken = violations(host, committed.reality)
	if (broken.length > 0) {
		return refusedJudgment(`the committed state breaks ${describeViolations(broken)}`)
	}
	const kept = Arr.filter(ran, (r) => {
		const ending = endingOf(r)
		return ending === "commit" || ending === "interruption" || ending === "read"
	})
	const serial = serialOrder(host, initial, kept, committed)
	if (!serial.ok) {
		return refusedJudgment(
			`no serial order of the committed transactions explains them\n${serial.problem}`
		)
	}
	for (const r of ran) {
		if (endingOf(r) !== "refusal") {
			continue
		}
		const own = serialOrder(host, initial, [...kept, r], committed)
		if (!own.ok) {
			return refusedJudgment(
				`no serial order of the committed transactions and the refusal ${r.label} explains them\n${own.problem}`
			)
		}
	}
	return allowed
}

/** The role of each Db session the setup opened, by the setup's own numbering. */
const setupRoles = (setup: ReadonlyArray<Action>): ReadonlyMap<number, string> =>
	new Map(
		Arr.flatMap(setup, (a, i): ReadonlyArray<readonly [number, string]> =>
			a.kind === "open-db" && a.role.kind === "own" ? [[i, a.role.role]] : []
		)
	)

/** One run's record of what each race transaction did, refilled every run. */
interface Recording {
	readonly observed: Map<string, Observation>
	readonly probes: Map<string, Probe>
	readonly direct: Map<string, Array<Observation>>
	readonly opened: Map<string, number>
}

/**
 * The tokens of `hidden` that none of `submitted` holds: what a refusal may not quote, since it may quote what its
 * statement, or its transaction, was given (README "Security model").
 */
const unsubmitted = (
	hidden: ReadonlySet<string>,
	submitted: ReadonlyArray<string>
): ReadonlySet<string> =>
	new Set(Arr.filter([...hidden], (token) => !Arr.some(submitted, Str.includes(token))))

/**
 * The driver's sessions of a race on a realized world. A Db session's connection is its login's pool when the pool has
 * one connection, and its own otherwise; a direct session's connection is its own. Every action is performed with the
 * tokens hidden from its session's world, less those it submits, so the executor reports a leak of any of them as its
 * observation, as the program driver judges an action (drive/index.ts hiddenFor).
 */
const raceTxns = (
	race: WorldRace,
	world: RacingWorld,
	initial: ModelState,
	recording: Recording
): ReadonlyArray<Txn> => {
	const roles = setupRoles(race.setup)
	const roleOf = (session: number): string => {
		const role = roles.get(session)
		if (role === undefined) {
			throw new Error(
				`the race acts on session ${session}, which its setup did not open as a role's Db`
			)
		}
		return role
	}
	/**
	 * The pool slot each Db session's steps hold: a login's Db sessions take its pool's connections in turn, so no more
	 * of them are in flight at once than the pool holds, and none waits on the pool, a wait no lock shows. Which real
	 * connection serves a step is the pool's choice.
	 */
	const dbSessions = Arr.flatMap(race.sessions, (s) => (s.kind === "db" ? [s] : []))
	/** The login whose pool serves a session's role. */
	const loginOfSession = (session: number): string =>
		defined(loginHolding(race.install, roleOf(session)), `the login of ${roleOf(session)}`).name
	const slotOf = (session: Extract<RaceSession, { readonly kind: "db" }>): string => {
		const login = loginOfSession(session.session)
		const n = Arr.filter(dbSessions, (s) => loginOfSession(s.session) === login).indexOf(session)
		return `pool ${login} slot ${n % race.poolSize}`
	}
	return Arr.map(race.sessions, (session): Txn => {
		switch (session.kind) {
			case "db": {
				const connection = slotOf(session)
				const backend: Backend = { kind: "watched", pid: world.backend(session.session) }
				const hidden = hiddenTokens(initial, session.session)
				return {
					kind: "world",
					session: session.name,
					connection,
					release: Effect.void,
					after: undefined,
					steps: Arr.map(session.ops, (op, i): WorldStep => {
						const key = `${session.name} #${i}`
						switch (op.kind) {
							case "act":
								return {
									label: key,
									outcome: Effect.map(
										world.perform(op.action, unsubmitted(hidden, submittedTexts(op.action))),
										(o) => {
											recording.observed.set(key, o)
											return stepOutcomeOf(o)
										}
									),
									footprint: actionFootprint(race.install, roleOf, op.action),
									ends: "commit",
									backend,
									blocked: op.blocked
								}
							case "probe":
								return {
									label: key,
									outcome: Effect.map(world.probe(op.session), (p): StepOutcome => {
										recording.probes.set(key, p)
										return { _tag: "Ok", rows: [], rowCount: 0 }
									}),
									footprint: relationsFootprint([]),
									ends: "nothing",
									backend,
									blocked: "wait"
								}
						}
					})
				}
			}
			case "direct":
				return directTxn(race, world, initial, session, recording)
		}
	})
}

const directTxn = (
	race: WorldRace,
	world: RacingWorld,
	initial: ModelState,
	session: Extract<RaceSession, { readonly kind: "direct" }>,
	recording: Recording
): Txn => {
	const begin: Action = {
		kind: "direct-begin",
		login: session.login,
		isolation: session.isolation,
		start: { current: { kind: "login" }, claims: { kind: "none" } }
	}
	const [modelBegun] = branchesOf(initial, begin)
	if (modelBegun.observation.kind !== "opened") {
		throw new Error(`${session.name}'s BEGIN as ${session.login} opens no session in the model`)
	}
	const began = modelBegun.observation.session
	/**
	 * The session alone after each prefix of its statements, from its BEGIN: the identity in force and the claims it set
	 * after the first n of them, at index n, whatever the other sessions do meanwhile.
	 */
	const alone = Arr.scan(session.statements, modelBegun.next, (state, statement) => {
		const [first] = branchesOf(state, { kind: "direct", session: began, statement })
		return first.next
	})
	/** What the session submitted by the end of its first n statements. */
	const sentBy = (n: number): ReadonlyArray<string> =>
		Arr.flatMap(session.statements.slice(0, n), (statement) =>
			submittedTexts({ kind: "direct", session: began, statement })
		)
	/**
	 * The tokens hidden from the session as it sends its statement n, its COMMIT or ROLLBACK last: hidden from the
	 * identity in force after the statements before it, the role it took on or else its login, less what it and every
	 * earlier statement of the transaction submitted, which a refusal may quote.
	 */
	const hiddenAt = Arr.map(alone, (state, n) =>
		unsubmitted(hiddenTokens(state, began), sentBy(n + 1))
	)
	const observations = (): Array<Observation> => {
		const found = recording.direct.get(session.name) ?? []
		recording.direct.set(session.name, found)
		return found
	}
	/** The session its BEGIN opened, read when a later step runs: the steps are built before any of them runs. */
	const opened: Effect.Effect<number> = Effect.suspend(() => {
		const id = recording.opened.get(session.name)
		return id === undefined
			? Effect.die(new Error(`${session.name} acts before its BEGIN opened it`))
			: Effect.succeed(id)
	})
	const performed = (hidden: ReadonlySet<string>, action: (id: number) => Action) =>
		Effect.flatMap(opened, (id) =>
			Effect.map(world.perform(action(id), hidden), (o) => {
				observations().push(o)
				return stepOutcomeOf(o)
			})
		)
	/**
	 * The backend the session's BEGIN opened, which the driver reads once the BEGIN has run (none when it opened no
	 * session) and knows until the session's last move ends it.
	 */
	const opens: Backend = {
		kind: "opens",
		pid: Effect.suspend(() =>
			Option.match(Option.fromNullishOr(recording.opened.get(session.name)), {
				onNone: () => Effect.succeedNone,
				onSome: (id) => world.backend(id)
			})
		)
	}
	const backend: Backend = { kind: "opened" }
	/**
	 * The session's release: the session its BEGIN opened, closed, which ends its psql child and terminates its backend,
	 * so its transaction ends without waiting on another session's lock (execute/writer.ts DirectSession); one its last
	 * move already closed is refused as no open session's. Nothing when its BEGIN opened none.
	 */
	const release: Effect.Effect<void> = Effect.suspend(() =>
		Option.match(Option.fromNullishOr(recording.opened.get(session.name)), {
			onNone: () => Effect.void,
			onSome: (id) =>
				Effect.flatMap(world.perform({ kind: "close", session: id }, new Set()), (o) =>
					o.kind === "ok" || o.kind === "handle-refused"
						? Effect.void
						: Effect.die(new Error(`${session.name}'s release could not close it: ${o.kind}`))
				)
		})
	)
	const whole = union(Arr.map(session.statements, (s) => statementFootprint(race.install, s)))
	return {
		kind: "world",
		session: session.name,
		connection: `direct ${session.name}`,
		release,
		after: undefined,
		steps: [
			{
				label: `${session.name} BEGIN`,
				outcome: Effect.map(world.perform(begin, hiddenTokens(modelBegun.next, began)), (o) => {
					observations().push(o)
					if (o.kind === "opened") {
						recording.opened.set(session.name, o.session)
					}
					return stepOutcomeOf(o)
				}),
				footprint: relationsFootprint([]),
				ends: "nothing",
				backend: opens,
				blocked: "wait"
			},
			...Arr.map(Arr.zip(session.statements, hiddenAt), ([statement, hidden], i): WorldStep => ({
				label: `${session.name} ${statement.kind}`,
				outcome: performed(hidden, (id) => ({ kind: "direct", session: id, statement })),
				/** The first statement takes the snapshot every later one reads. */
				footprint: i === 0 ? whole : statementFootprint(race.install, statement),
				ends: "nothing",
				backend,
				blocked: "wait"
			})),
			{
				label: `${session.name} ${Str.toUpperCase(session.end)}`,
				outcome: performed(Arr.lastNonEmpty(hiddenAt), (id) => ({
					kind: "direct-end",
					session: id,
					end: session.end
				})),
				footprint: whole,
				ends: session.end,
				backend,
				blocked: "wait"
			}
		]
	}
}

/** The moves of a session in a run, in order. */
/** What a judgment reads of a run: its moves, its waits and its deadlocks. */
type RunView = Pick<Interleaving, "moves" | "waits" | "deadlocks">

const movesOfSession = (i: RunView, session: string): ReadonlyArray<MoveRecord> =>
	Arr.filter(i.moves, (m) => m.session === session)

const spanOf = (moves: ReadonlyArray<MoveRecord>): Span | undefined => {
	const [first] = moves
	const last = moves[moves.length - 1]
	if (first === undefined || last?.result._tag !== "Finished") {
		return undefined
	}
	return { start: first.issued, end: last.result.at }
}

/** What one Db operation did in a run, from its move and the run's recording, or why it cannot be read. */
const ranOfOp = (
	name: string,
	session: number,
	n: number,
	op: RaceOp,
	move: MoveRecord | undefined,
	recording: Recording
): Ran | string => {
	const key = `${name} #${n}`
	const span = move === undefined ? undefined : spanOf([move])
	if (move === undefined || span === undefined || move.result._tag !== "Finished") {
		return `${key} did not finish`
	}
	if (op.kind === "probe") {
		const probe = recording.probes.get(key)
		return probe === undefined
			? `${key} recorded no probe`
			: { kind: "probe", label: key, session: op.session, probe, span }
	}
	if (move.result.outcome._tag === "Interrupted") {
		return {
			kind: "op",
			label: key,
			session,
			action: op.action,
			result: { kind: "interrupted" },
			span
		}
	}
	const observation = recording.observed.get(key)
	return observation === undefined
		? `${key} recorded no observation`
		: {
				kind: "op",
				label: key,
				session,
				action: op.action,
				result: { kind: "observed", observation },
				span
			}
}

/** What a race session's transactions did in a run, or why they cannot be read. */
const ranOfSession = (
	session: RaceSession,
	i: RunView,
	recording: Recording
): ReadonlyArray<Ran> | string => {
	const moves = movesOfSession(i, session.name)
	if (session.kind === "direct") {
		const span = spanOf(moves)
		return span === undefined
			? `${session.name} did not finish`
			: [
					{
						kind: "direct",
						label: session.name,
						session,
						observations: recording.direct.get(session.name) ?? [],
						span
					}
				]
	}
	const out: Array<Ran> = []
	for (const [n, op] of session.ops.entries()) {
		const ran = ranOfOp(session.name, session.session, n, op, moves[n], recording)
		if (typeof ran === "string") {
			return ran
		}
		out.push(ran)
	}
	return out
}

/** What each race transaction did in a run, from the driver's moves and the run's recording, or why it cannot be read. */
const ranOf = (race: WorldRace, i: RunView, recording: Recording): ReadonlyArray<Ran> | string => {
	const out: Array<Ran> = []
	for (const session of race.sessions) {
		const ran = ranOfSession(session, i, recording)
		if (typeof ran === "string") {
			return ran
		}
		appendAll(out, ran)
	}
	return out
}

/**
 * How the transaction a probe follows ended, when the run's transaction at `index` is a probe right after its own
 * session's transaction: the pooled connection as that ending left it.
 */
const probedAfter = (ran: ReadonlyArray<Ran>, index: number): Ending | undefined => {
	const r = ran[index]
	const before = ran[index - 1]
	if (r?.kind !== "probe" || before?.kind !== "op" || before.session !== r.session) {
		return undefined
	}
	const ending = endingOf(before)
	return ending === "read" ? undefined : ending
}

/** Notes what a passing run reached. */
const noteRun = (
	ran: ReadonlyArray<Ran>,
	i: RunView,
	note: (f: WorldRaceFeature) => void
): void => {
	if (i.waits.length > 0) {
		note("blocked")
	}
	if (i.deadlocks.length > 0) {
		note("deadlock")
	}
	for (const [index, r] of ran.entries()) {
		const ending = endingOf(r)
		if (ending !== "read") {
			note(`ended: ${ending}`)
		}
		const after = probedAfter(ran, index)
		if (after !== undefined) {
			note(`probed after: ${after}`)
		}
		const observed =
			r.kind === "direct"
				? r.observations
				: r.kind === "op" && r.result.kind === "observed"
					? [r.result.observation]
					: []
		for (const o of observed) {
			note(`observed: ${o.kind}`)
		}
		if (Arr.some(ran, (q) => q !== r && q.span.start < r.span.end && r.span.start < q.span.end)) {
			note("overlapping")
		}
	}
}

/**
 * The model state a race's runs start from: the installation's reality with the setup's Dbs opened. Each run resets the
 * real system to the reality (which closes every session and numbers sessions from 0 again) and performs the setup,
 * each observation one the model's branch allows and each Db numbered as the model numbers it.
 */
const setUp = (race: WorldRace, world: RacingWorld): Effect.Effect<ModelState, CaseFailed> =>
	Effect.gen(function* () {
		const failed = (report: string) => new CaseFailed({ report: `${race.name}: setup: ${report}` })
		yield* Effect.mapError(world.reset(race.reality), (e) =>
			failed(`the reset failed: ${messageOf(e)}`)
		)
		let state = initialState(race.install, world.names, race.reality)
		for (const action of race.setup) {
			const observed = yield* world.perform(action, new Set())
			const found = branchesMatching(state, action, observed)
			const [first] = found.next
			if (first === undefined) {
				return yield* failed(found.why)
			}
			if (
				observed.kind === "opened" &&
				first.observation.kind === "opened" &&
				observed.session !== first.observation.session
			) {
				return yield* failed(
					`the executor opened session ${observed.session} where the model opened ${first.observation.session}`
				)
			}
			state = first.state
		}
		return state
	})

/**
 * Runs a race: realizes its installation with the race's pool size, then explores its sessions' interleavings under
 * the race's strategy, each run from its reality with its Dbs opened again (setUp), and judges each run by the worlds
 * model (judgeWorldRun) against what the run committed, read back as the owner.
 */
export const runWorldRace = ({
	race,
	note
}: {
	readonly race: WorldRace
	readonly note: (f: WorldRaceFeature) => void
}): Effect.Effect<void, CaseFailed, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const failed = (report: string) => new CaseFailed({ report: `${race.name}: ${report}` })
		const s = yield* Substrate
		const world = yield* Effect.mapError(
			realizeRace(race.install, ordinarySession, race.poolSize),
			(e) => failed(`did not realize: ${messageOf(e)}`)
		)
		const host = hostSchemaOf(race.install.base, world.names)
		const initial = yield* setUp(race, world)
		note(`pool of ${race.poolSize}`)
		const recording: Recording = {
			observed: new Map(),
			probes: new Map(),
			direct: new Map(),
			opened: new Map()
		}
		const txns = raceTxns(race, world, initial, recording)
		const env = yield* Effect.mapError(exploreEnv(s), (e) => failed(`no observer: ${messageOf(e)}`))
		const moves = Arr.reduce(txns, 0, (sum, t) => sum + t.steps.length)
		yield* exploreInterleavings(
			env,
			{ direct: {}, grizzle: {} },
			{
				name: race.name,
				txns,
				reset: Effect.andThen(
					Effect.sync(() => {
						recording.observed.clear()
						recording.probes.clear()
						recording.direct.clear()
						recording.opened.clear()
					}),
					setUp(race, world)
				),
				state: { _tag: "Unread" },
				model: (i) =>
					Effect.gen(function* () {
						const ran = ranOf(race, i, recording)
						if (typeof ran === "string") {
							return refusedJudgment(ran)
						}
						const stored = yield* world.stored
						const judged = judgeWorldRun(host, initial, ran, stored)
						if (judged._tag === "Allowed") {
							noteRun(ran, i, note)
						}
						return judged
					}),
				maxInterleavings: runawayInterleavings
			},
			race.strategy(moves)
		).pipe(Effect.mapError((e) => e.pipe(messageOf, failed)))
	})
