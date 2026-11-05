import { Array as Arr, Option, Record } from "effect"
import type {
	BaseSpec,
	Branch,
	ContextFacts,
	DbSessionState,
	DirectSessionState,
	EntrySpec,
	HostFact,
	HostState,
	InstallSpec,
	LoginSpec,
	ModelState,
	ActionOutcome,
	RelationSpec,
	RoleSpec,
	Rule,
	ModelSession,
	ModelStaleReason,
	Term
} from "#test/support/worlds/model/types.ts"

/** The installed role of that name, or undefined when the installation has none. */
export const roleOf = (install: InstallSpec, name: string): RoleSpec | undefined =>
	Option.getOrUndefined(Arr.findFirst(install.roles, (r) => r.name === name))

/** The installed login of that name, or undefined when the installation has none. */
export const loginOf = (install: InstallSpec, name: string): LoginSpec | undefined =>
	Option.getOrUndefined(Arr.findFirst(install.logins, (l) => l.name === name))

/** The login holding a role: every installed role is in exactly one login. */
export const loginHolding = (install: InstallSpec, role: string): LoginSpec | undefined =>
	Option.getOrUndefined(Arr.findFirst(install.logins, (l) => l.roles.includes(role)))

/** Every installed role of a login. */
export const rolesOfLogin = (install: InstallSpec, login: string): ReadonlyArray<RoleSpec> =>
	Arr.filter(install.roles, (r) => loginOf(install, login)?.roles.includes(r.name) === true)

/** The ordinary relation of that name, or undefined for a closed or derived relation or none. */
export const relationSpecOf = (base: BaseSpec, name: string): RelationSpec | undefined =>
	Option.getOrUndefined(Arr.findFirst(base.relations, (r) => r.name === name))

/** A relation's facts in a state; a relation the state does not hold has none. */
export const factsIn = (state: HostState, relation: string): ReadonlyArray<HostFact> =>
	state.get(relation) ?? []

/** A role relation's definition, or undefined when the role holds no relation of that name. */
export const roleEntryOf = (role: RoleSpec, relation: string): EntrySpec | undefined =>
	Record.has(role.entries, relation) ? role.entries[relation] : undefined

/** Whether the role holds the base relation whole, under its own name. */
export const holdsWhole = (role: RoleSpec, relation: string): boolean =>
	Arr.some(Record.values(role.entries), (e) => e.kind === "whole" && e.relation === relation)

/** The contexts a term reads. */
const termContexts = (t: Term): ReadonlyArray<string> => (t.kind === "context" ? [t.context] : [])

/** The contexts a rule reads: in a match, a negation, a comparison or its head. */
const ruleContexts = (rule: Rule): ReadonlyArray<string> => [
	...Arr.flatMap([...rule.matches, ...rule.negations.flat()], (o) => [
		...(o.source.kind === "context" ? [o.source.name] : []),
		...Arr.flatMap(Record.values(o.fields), termContexts)
	]),
	...Arr.flatMap(rule.comparisons, (c) => [...termContexts(c.left), ...termContexts(c.right)]),
	...Arr.flatMap(Record.values(rule.head), termContexts)
]

/** The contexts an entry reads: none for a whole entry. */
export const entryContexts = (entry: EntrySpec): ReadonlySet<string> =>
	new Set(entry.kind === "whole" ? [] : Arr.flatMap(entry.rules, ruleContexts))

/** The contexts a role's relations read. */
export const roleContexts = (role: RoleSpec): ReadonlySet<string> =>
	new Set(Arr.flatMap(Record.values(role.entries), (e) => [...entryContexts(e)]))

/** Whether some role of the login reads a context, so its layer carries a verify. */
export const loginVerifies = (install: InstallSpec, login: string): boolean =>
	Arr.some(rolesOfLogin(install, login), (r) => roleContexts(r).size > 0)

/** The session of an id, or undefined for an id the model never minted. */
export const sessionAt = (state: ModelState, id: number): ModelSession | undefined =>
	state.sessions[id]

/** The open Db at an id, or undefined for a closed, direct or never minted session. */
export const dbSessionAt = (state: ModelState, id: number): DbSessionState | undefined => {
	const s = state.sessions[id]
	return s?.kind === "db" ? s : undefined
}

/** The direct writer at an id, or undefined for a closed, Db or never minted session. */
export const directSessionAt = (state: ModelState, id: number): DirectSessionState | undefined => {
	const s = state.sessions[id]
	return s?.kind === "direct" ? s : undefined
}

/** The state with the session at `id` replaced. */
export const withSession = (state: ModelState, id: number, session: ModelSession): ModelState => ({
	...state,
	sessions: Arr.map(state.sessions, (s, i) => (i === id ? session : s))
})

/** The version whose migration created a login's role; none for a login the installation does not hold. */
const createdAt = (state: Pick<ModelState, "loginsCreated">, login: string): number | undefined =>
	Record.has(state.loginsCreated, login) ? state.loginsCreated[login] : undefined

/**
 * Whether the login a Db was opened under is gone: a migration since its open dropped the login's role, whether or not
 * a later one created the login again. Its connection is then a session of no role: the ledger's lock its calls'
 * prologue takes is refused (42501), and `current_user` cannot be read on it.
 */
export const loginGone = (state: ModelState, session: DbSessionState): boolean => {
	const created = createdAt(state, session.login)
	return created === undefined || created > session.snapshot.version
}

/**
 * The version each login of an installation landed at `version` was created at: a login the state's installation holds
 * keeps its own, and a new one is created at `version`.
 */
export const loginsCreatedOn = (
	state: Pick<ModelState, "loginsCreated">,
	to: InstallSpec,
	version: number
): Readonly<Record<string, number>> =>
	Record.fromEntries(
		Arr.map(to.logins, (l) => [l.name, createdAt(state, l.name) ?? version] as const)
	)

/**
 * Whether a session is a Db whose snapshot a completed migration moved past: it holds its role at no version of the
 * installation, and every call it sends SQL for refuses as `migrated` (staleReason).
 */
export const staleDb = (state: ModelState, session: ModelSession): boolean =>
	session.kind === "db" && session.snapshot.version !== state.version

/**
 * A Db call as grizzle answers it on the host, judged by the Db's snapshot: refused there before any SQL, with each
 * outcome it allows, none changing the state; or sending statements, whose branches its SQL phase yields once the
 * transaction's prologue lets it through (step.ts dbCall).
 */
export type Called =
	| { readonly kind: "host"; readonly refusals: Arr.NonEmptyReadonlyArray<ActionOutcome> }
	| { readonly kind: "sends"; readonly sql: () => Arr.NonEmptyReadonlyArray<Branch> }

/** Whether the ledger holds an unfinished folder: every Db call that sends SQL, and every Db.open, is refused. */
export const migrating = (state: ModelState): boolean =>
	state.migrations.kind === "pending" && state.migrations.ledger === "unfinished"

/**
 * The installation a migration's new folder is drafted from: the newest pending folder's, which the run lands before
 * the new folder, or the current installation when no folder is pending. A migration to it drafts a folder with no
 * file, so a half-applied run, killed inside its new folder, needs another.
 */
export const draftedFrom = (state: ModelState): InstallSpec =>
	state.migrations.kind === "pending" ? Arr.lastNonEmpty(state.migrations.folders) : state.install

/**
 * Why a Db's call that sends SQL is refused by its transaction's prologue (README "Deploying"), the ledger's
 * lock and the snapshot guard, both run as the login: `migrating` while a folder is unfinished, `migrated` once a
 * migration to another installation completed past its snapshot; none for a Db its snapshot describes.
 */
export const staleReason = (
	state: ModelState,
	session: DbSessionState
): ModelStaleReason | undefined => {
	if (migrating(state)) {
		return "migrating"
	}
	return session.snapshot.version === state.version ? undefined : "migrated"
}

/** A session closed: a Db's, or a direct writer's whose transaction ended. */
export const closedDb: ModelSession = { kind: "closed", was: "db" }
export const closedDirect: ModelSession = { kind: "closed", was: "direct" }

/** A model state whose reality is a transaction's view: what a direct session's statements read and write. */
export const seenThrough = (state: ModelState, view: HostState): ModelState => ({
	...state,
	reality: view
})

/** No context facts: a session with no claims. */
export const noFacts: ContextFacts = {}

/** Whether two values of plain data are one: primitives as themselves, arrays and records member by member. */
export const samePlain = (a: unknown, b: unknown): boolean => {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return Object.is(a, b)
	}
	if (Arr.isArray(a) || Arr.isArray(b)) {
		return (
			Arr.isArray(a) &&
			Arr.isArray(b) &&
			a.length === b.length &&
			Arr.every(a, (x: unknown, i) => samePlain(x, b[i]))
		)
	}
	const keys = Record.keys(a)
	return (
		keys.length === Record.keys(b).length &&
		Arr.every(keys, (k) => Record.has(b, k) && samePlain(Reflect.get(a, k), Reflect.get(b, k)))
	)
}
