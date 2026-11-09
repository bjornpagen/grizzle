import { Array as Arr, Option } from "effect"
import { actionKinds } from "#test/support/worlds/generate/weights.ts"
import type { SessionUse } from "#test/support/worlds/invalid/handles.ts"
import { driftOf } from "#test/support/worlds/model/session/catalog.ts"
import { migrating, staleDb } from "#test/support/worlds/model/session/state.ts"
import type {
	Action,
	ActionKind,
	ModelState,
	ModelSession
} from "#test/support/worlds/model/types.ts"

/**
 * What a state offers a program: the kinds it may take next and the sessions each may name, under the serial rule (a
 * harness invariant: nothing that could wait on an open direct transaction's locks) and the rule that a catalog left
 * the contract is only opened or checked for drift. The random generators (action.ts) and the exhaustive box
 * (enumerate.ts) both draw within it.
 */

/** The session holding an open direct transaction: at most one, by the serial rule's own construction. */
const holderOf = (state: ModelState): Option.Option<number> =>
	Arr.findFirstIndex(state.sessions, (s) => s.kind === "direct")

/**
 * Whether an action of a kind may name a session under the serial rule, a harness invariant: while a direct session
 * holds its transaction and locks, an action that would write, refresh or interrupt at a Db could wait on them, so it
 * names only the holder or a session that is no Db (closed, or a direct writer's), where no statement is sent.
 */
const quiet = (state: ModelState, holder: Option.Option<number>, session: number): boolean =>
	Option.match(holder, {
		onNone: () => true,
		onSome: (h) => session === h || state.sessions[session]?.kind !== "db"
	})

/** The kinds the serial rule never draws while a direct transaction is open: each could wait on the holder's locks. */
const blockedByHolder: ReadonlySet<ActionKind> = new Set(["direct-begin", "migrate", "tamper"])

/** The action kinds that name a session. */
export type SessionKind =
	| "read"
	| "apply"
	| "refresh"
	| "close"
	| "direct"
	| "direct-end"
	| "interrupt"

/** The use each session-naming kind makes of its session. */
export const useOf = (kind: SessionKind): SessionUse => {
	switch (kind) {
		case "read":
		case "apply":
		case "refresh":
			return "call"
		case "close":
			return "db"
		case "direct":
		case "direct-end":
			return "direct"
		case "interrupt":
			return "either"
	}
}

/**
 * Whether a session is a Db whose claims hold a refined value PostgreSQL refuses: Db.open judges no claim against the
 * database, so it opens, and is then only closed, a harness rule. What its calls meet is where each statement reads the
 * claims, the cast every reader of a context takes (sql/print.ts contextClaims), which the direct writers' hand-set
 * claims draw over every plan order (session/direct.ts handSetFaults).
 */
const refusedClaims = (state: ModelState, session: number): boolean => {
	const s = state.sessions[session]
	return s?.kind === "db" && s.claims === "refused"
}

/**
 * The sessions an action of a kind may name in a state: every session for a close or a direct statement; every one
 * but a Db with claims PostgreSQL refuses for a read (refusedClaims); the quiet ones of those otherwise. A Db whose
 * snapshot a migration moved past, or met while one is unfinished, or opened at a snapshot no migration lands, is named
 * like any other: its calls are refused by their prologue (README "Deploying").
 */
export const allowedFor =
	(state: ModelState, kind: SessionKind): ((session: number) => boolean) =>
	(session: number): boolean => {
		switch (kind) {
			case "close":
			case "direct":
			case "direct-end":
				return true
			case "read":
				return !refusedClaims(state, session)
			case "apply":
			case "refresh":
			case "interrupt":
				return !refusedClaims(state, session) && quiet(state, holderOf(state), session)
		}
	}

/**
 * The calls a wild value may be handed to at a session: every one, and only a read while a direct transaction is open;
 * none at a Db with claims PostgreSQL refuses (refusedClaims).
 */
export const wildCalls =
	(state: ModelState) =>
	(session: number): ReadonlyArray<"read" | "apply" | "refresh"> =>
		refusedClaims(state, session)
			? []
			: quiet(state, holderOf(state), session)
				? ["read", "apply", "refresh"]
				: ["read"]

/**
 * Whether a state offers the session an action names: one its kind may name (allowedFor), a wild value at a call the
 * session admits (wildCalls); an action naming no session offers none to refuse.
 */
export const namesOffered = (state: ModelState, action: Action): boolean => {
	switch (action.kind) {
		case "read":
		case "apply":
		case "refresh":
		case "close":
		case "direct":
		case "direct-end":
		case "interrupt":
			return allowedFor(state, action.kind)(action.session)
		case "wild":
			return (
				action.at.kind !== "session" || wildCalls(state)(action.at.session).includes(action.at.call)
			)
		case "open-db":
		case "direct-begin":
		case "migrate":
		case "tamper":
		case "drift":
			return true
	}
}

/**
 * Whether the catalog has left the contract: a perturbation in the state that `grizzle drift` finds, as the model
 * predicts it (every perturbation `Db.open` refuses is among them). From there only opening a Db and checking drift are
 * drawn, a harness rule; an inert perturbation (a membership that confers nothing, a setting of the owner's, a grant
 * already held) leaves the program going.
 */
const catalogLeftContract = (state: ModelState): boolean =>
	driftOf(state.install, state.tampered).length > 0

/** The kinds drawn once the catalog has left the contract. */
const afterTamper: ReadonlySet<ActionKind> = new Set(["open-db", "drift"])

/** The kinds never drawn while a folder is unfinished: each acts on a catalog the model leaves to the runner. */
const migratingBlocked: ReadonlySet<ActionKind> = new Set(["direct-begin", "tamper"])

/** Whether a drift run resumes pending folders: a migration then, which an open direct transaction would block. */
const resumes = (state: ModelState): boolean => state.migrations.kind === "pending"

/**
 * Whether a state offers an action of a kind anything to name: a session for a session's action, nothing the serial
 * rule forbids, no direct writer and no catalog change while a folder is unfinished (the model leaves a stopped
 * migration's catalog to the runner: its committed files may already have dropped the world object a perturbation
 * would edit), and only opening a Db or checking drift once the catalog has left the contract.
 */
export const applicable = (state: ModelState, kind: ActionKind): boolean => {
	if (
		Option.isSome(holderOf(state)) &&
		(blockedByHolder.has(kind) || (kind === "drift" && resumes(state)))
	) {
		return false
	}
	if (!afterTamper.has(kind) && catalogLeftContract(state)) {
		return false
	}
	if (migratingBlocked.has(kind) && migrating(state)) {
		return false
	}
	switch (kind) {
		case "open-db":
		case "direct-begin":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return true
		case "read":
		case "apply":
		case "refresh":
		case "close":
		case "direct":
		case "direct-end":
		case "interrupt":
			return Arr.some([...state.sessions.keys()], (id) => allowedFor(state, kind)(id))
	}
}

/**
 * Whether a session is live: a Db its snapshot describes, whose guard holds the ledger to it and whose claims
 * PostgreSQL admits, or a direct writer's transaction.
 */
const isOpen =
	(state: ModelState) =>
	(s: ModelSession): boolean =>
		s.kind === "direct" ||
		(s.kind === "db" && s.guard === "held" && s.claims === "admitted" && !staleDb(state, s))

/**
 * The moves a state forces when the weights give nothing to draw: with no live session, opening one (a Db, or a direct
 * transaction when the serial rule admits one), since every session's action needs one. A forced move never depends on
 * a weight.
 */
export const forcedMoves = (state: ModelState): ReadonlyArray<ActionKind> =>
	Arr.some(state.sessions, isOpen(state))
		? []
		: Arr.filter(
				actionKinds,
				(k) => (k === "open-db" || k === "direct-begin") && applicable(state, k)
			)
