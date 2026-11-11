import { Array as Arr, Option, Record as Rec } from "effect"
import { sameValue, valueText } from "#test/support/laws/model.ts"
import {
	type Binding,
	bindFacts,
	bound,
	distinctFacts,
	everyMeets,
	factMeets,
	fresh,
	holdsDraw,
	type Meet,
	type Rest,
	unbound
} from "#test/support/worlds/model/draws.ts"
import {
	entryRows,
	evaluateRules,
	fieldDomain,
	headFieldDomain,
	hostSchemaOf,
	isMember
} from "#test/support/worlds/model/host.ts"
import {
	attachedField,
	attachedRows,
	headingNames,
	reachedPairs
} from "#test/support/worlds/model/reads.ts"
import { applyCall } from "#test/support/worlds/model/session/apply.ts"
import { claimsText } from "#test/support/worlds/model/session/claims.ts"
import {
	directBranches,
	directEndBranches,
	directInterruptBranches,
	startedBranches,
	startStatements
} from "#test/support/worlds/model/session/direct.ts"
import { ofDomainType } from "#test/support/worlds/model/session/domains.ts"
import { entryKeyed } from "#test/support/worlds/model/session/keys.ts"
import { driftBranches, migrateBranches } from "#test/support/worlds/model/session/migrate.ts"
import { openBranches, wildOpenBranches } from "#test/support/worlds/model/session/open.ts"
import {
	type Called,
	closedDb,
	closedDirect,
	dbSessionAt,
	factsIn,
	loginGone,
	loginOf,
	roleOf,
	seenThrough,
	sessionAt,
	staleReason,
	withSession
} from "#test/support/worlds/model/session/state.ts"
import { installedRoles, writtenOf } from "#test/support/worlds/model/session/writes.ts"
import type {
	Action,
	BaseSpec,
	Branch,
	ContextFacts,
	DbSessionState,
	DirectSessionState,
	DirectStatement,
	EntrySpec,
	FieldDomain,
	HostFact,
	HostState,
	InstalledNames,
	InstallSpec,
	ModelState,
	ActionOutcome,
	Probe,
	ReadBack,
	ReadVia,
	ModelSession,
	Source,
	Allowed,
	HostValue,
	RefusedBy,
	Witness
} from "#test/support/worlds/model/types.ts"

/**
 * Each derived relation's facts over `reality`, in declaration order, so one reads the derived relations declared before
 * it as they now stand.
 */
const derivedOver = (
	install: InstallSpec,
	reality: HostState
): Readonly<Record<string, ReadonlyArray<HostFact>>> => {
	const derived: Record<string, ReadonlyArray<HostFact>> = {}
	for (const d of install.base.derived) {
		derived[d.name] = evaluateRules(install.base, d.rules, reality, derived, {})
	}
	return derived
}

/**
 * The state of a fresh installation over a loaded reality: no session, no pooled connection, nothing tampered, every
 * migration applied, and each derived relation populated from reality, as the load's refresh leaves it.
 */
export const initialState = (
	install: InstallSpec,
	names: InstalledNames,
	reality: HostState
): ModelState => ({
	install,
	names,
	host: hostSchemaOf(install.base, names),
	roles: installedRoles(install),
	reality,
	derived: derivedOver(install, reality),
	sessions: [],
	connections: [],
	tampered: [],
	version: 0,
	loginsCreated: Rec.fromEntries(Arr.map(install.logins, (l) => [l.name, 0] as const)),
	migrations: { kind: "applied" }
})

/**
 * A step as a branch: itself, or a landing completed under `namesOf`'s names for the installation it landed, the
 * compiler's names, which the model cannot mint (the executor's after a migration, execute/names.ts installedNames
 * where no executor runs).
 */
export const settle = (s: Allowed, namesOf: (install: InstallSpec) => InstalledNames): Branch =>
	"next" in s
		? s
		: { observation: s.observation, next: s.landing.complete(namesOf(s.landing.install)) }

/** A fact tagged with the relation that holds it. */
interface Tagged {
	readonly relation: string
	readonly fact: HostFact
}

/** A tagged model fact meeting a tagged stored fact: one relation, one fact (draws.ts factMeets). */
const taggedMeets: Meet<Tagged, Tagged> = (e, o, binding, rest) =>
	e.relation === o.relation ? factMeets(e.fact, o.fact, binding, rest) : undefined

/**
 * The state with the values the identity defaults drew, read from the stored relations: the model predicts every value
 * but a draw (draws.ts), which the stored facts show. The base and derived relations holding a draw bind their draws
 * together, one binding under which each model fact meets a stored fact of its own relation and its own, every stored
 * fact is met, and every value is fresh, and the state holds the values bound. When no binding does, a stored relation
 * repeating a fact among them, the state is left as it is, and the caller's comparison finds the relations differing.
 */
export const adoptStored = (
	state: ModelState,
	stored: {
		readonly reality: HostState
		readonly derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
	}
): ModelState => {
	/** A relation's facts, tagged with its name, on both sides, of each relation whose model facts hold a draw. */
	const drawing = Arr.filter(
		[
			...Arr.map(state.install.base.relations, (r) => ({
				model: factsIn(state.reality, r.name),
				stored: factsIn(stored.reality, r.name),
				relation: `relation ${r.name}`
			})),
			...Arr.map(Rec.toEntries(state.derived), ([name, facts]) => ({
				model: facts,
				stored: stored.derived[name] ?? [],
				relation: `derived ${name}`
			}))
		],
		(r) => Arr.some(r.model, holdsDraw)
	)
	const tagged = (side: "model" | "stored"): ReadonlyArray<Tagged> =>
		Arr.flatMap(drawing, (r) => Arr.map(r[side], (fact) => ({ relation: r.relation, fact })))
	const model = tagged("model")
	const real = tagged("stored")
	const binding =
		model.length === real.length && Arr.every(drawing, (r) => distinctFacts(r.stored))
			? everyMeets(model, real, taggedMeets, unbound, (met) =>
					fresh(state, met) ? met : undefined
				)
			: undefined
	return binding === undefined ? state : bound(state, binding)
}

const handleRefused = (state: ModelState): Arr.NonEmptyReadonlyArray<Branch> => [
	{ observation: { kind: "handle-refused" }, next: state }
]

/** The state a Db's call is judged in on the host: the installation its snapshot describes, with the live data. */
const snapshotView = (state: ModelState, s: DbSessionState): ModelState =>
	s.snapshot.version === state.version
		? state
		: {
				...state,
				install: s.snapshot.install,
				names: s.snapshot.names,
				host: s.snapshot.host,
				roles: installedRoles(s.snapshot.install)
			}

/**
 * A grizzle call through a Db session: refused as a stale handle when the id names no open Db. grizzle answers it on
 * the host first, by the Db's own snapshot, and a refusal there sends nothing and changes nothing. A call that sends SQL
 * then meets its transaction's prologue, run as the login (README "Deploying"): the ledger's lock, which the
 * connection of a login a migration dropped since the open (loginGone), even one created again, holds no SELECT for
 * (42501, the server's refusal); then the snapshot guard, refusing as
 * `migrating` while a folder is unfinished and as `migrated` once a migration completed past the Db's snapshot. Either
 * refusal runs nothing, retires nothing and leaves the connection clean; past them the call runs on the live state, the
 * one its snapshot describes. Past the lock, any call that sends SQL may also fail with TransientFailure
 * SerializationFailure, changing nothing (README "Transactions and concurrency"): once SSI summarizes old committed transactions under
 * load, it refuses a transaction with no other session beside it in the case.
 */
const dbCall = (
	state: ModelState,
	id: number,
	call: (view: ModelState, session: DbSessionState) => Called
): Arr.NonEmptyReadonlyArray<Branch> => {
	const s = dbSessionAt(state, id)
	if (s === undefined) {
		return handleRefused(state)
	}
	const called = call(snapshotView(state, s), s)
	switch (called.kind) {
		case "host":
			return Arr.map(called.refusals, (observation): Branch => ({ observation, next: state }))
		case "sends": {
			if (loginGone(state, s)) {
				return [{ observation: { kind: "refused", sqlstate: "42501" }, next: state }]
			}
			const reason = staleReason(state, s)
			const transient: Branch = {
				observation: { kind: "transient", reason: "SerializationFailure" },
				next: state
			}
			return Arr.append(
				reason === undefined
					? called.sql()
					: [{ observation: { kind: "stale-snapshot", reason }, next: state }],
				transient
			)
		}
	}
}

/**
 * Whether a direct writer's statement reads or writes a relation, a table, a view or a sequence, so its transaction meets
 * SSI's checks: a read, a write, a call of an installed function and the execution of a prepared read. A statement that
 * sets the role, the session identity or the claims, or prepares a read without running it, reads none, and neither does
 * one PostgreSQL refuses before it runs (TRUNCATE and setval by privilege).
 */
const meetsRelations = (statement: DirectStatement): boolean => {
	switch (statement.kind) {
		case "select-view":
		case "select-table":
		case "insert":
		case "insert-on-conflict":
		case "merge-delete":
		case "delete":
		case "update":
		case "call":
		case "execute-prepared":
			return true
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
		case "prepare":
		case "truncate":
		case "setval":
			return false
	}
}

/**
 * Whether PostgreSQL's SSI may refuse a direct writer's statement, or its COMMIT, with 40001 (README "Transactions and concurrency"): its
 * transaction is open and SERIALIZABLE, and it meets a relation, the statement itself or, for its COMMIT, one statement
 * it ran. Once SSI summarizes old committed transactions under load it treats their reads and writes as concurrent with
 * any transaction whose snapshot the cluster's oldest transaction holds back, so a transaction with no other session
 * beside it in the case may meet it too. A transaction below SERIALIZABLE takes no part in SSI.
 */
const serializable = (session: DirectSessionState, statements: ReadonlyArray<DirectStatement>) =>
	session.transaction === "open" &&
	session.isolation === "serializable" &&
	Arr.some(statements, meetsRelations)

/** A direct writer's serialization failure (serializable), leading to `next`: nothing it wrote is kept. */
const serializationFailed = (next: ModelState): Branch => ({
	observation: { kind: "refused", sqlstate: "40001" },
	next
})

/** Whether a row holds a key's values at every field the key names. */
const atKey = (row: HostFact, key: HostFact): boolean =>
	Arr.every(Rec.toEntries(key), ([f, v]) => Rec.has(row, f) && sameValue(row[f], v))

/** The domain of a role relation's field: its base field's for a whole entry, its head field's for a query entry. */
const entryFieldDomain = (
	base: BaseSpec,
	entry: EntrySpec,
	field: string
): FieldDomain | undefined => {
	switch (entry.kind) {
		case "whole": {
			const source: Source = Arr.some(base.closed, (c) => c.name === entry.relation)
				? { kind: "closed", name: entry.relation }
				: Arr.some(base.derived, (d) => d.name === entry.relation)
					? { kind: "derived", name: entry.relation }
					: { kind: "ordinary", name: entry.relation }
			return fieldDomain(base, source, field)
		}
		case "query":
			return headFieldDomain(base, entry.rules, field)
	}
}

/**
 * A page size grizzle's page admission takes: a safe integer of at least 1, with no upper bound (README "A page size
 * has no upper bound"); it refuses any other before any SQL.
 */
export const isPageSize = (size: number): boolean => Number.isSafeInteger(size) && size >= 1

/**
 * A read through a Db's role relation (README "Reading"): `execute`, `compile` and every page together deliver
 * its rows under the Db's facts; `get` the row at a key the relation proves, or none; an attachment each row with the
 * attached relation's rows whose field equals its own (model/reads.ts attachedRows); a recursive read every pair its
 * rows chain (reachedPairs). Refused on the host when it compiles: a relation the role does not hold, a get by a field
 * set within which none of its keys lies (session/keys.ts) or by a key holding a value of another type than its
 * field's, which the builder refuses as a literal of that field, a page whose size is no page size (isPageSize), and an
 * attachment or a recursive read naming a field its relation's heading lacks.
 */
const readCall = (
	state: ModelState,
	session: DbSessionState,
	relation: string,
	via: ReadVia
): Called => {
	const refused: Called = { kind: "host", refusals: [{ kind: "compile-refused" }] }
	const role = roleOf(state.install, session.role)
	if (role === undefined || !Rec.has(role.entries, relation)) {
		return refused
	}
	const rowsOf = (name: string): ReadonlyArray<HostFact> =>
		entryRows(state, role.name, name, session.facts)
	const delivers = (
		delivered: (rows: ReadonlyArray<HostFact>) => ReadonlyArray<HostFact>
	): Called => ({
		kind: "sends",
		sql: () => [
			{
				observation: { kind: "rows", rows: delivered(rowsOf(relation)) },
				next: state
			}
		]
	})
	const heading = headingNames(state.install.base, role, relation)
	switch (via.kind) {
		case "execute":
		case "compile":
			return delivers((rows) => rows)
		case "page":
			return isPageSize(via.size) && Arr.every(via.order, (k) => heading.includes(k.field))
				? delivers((rows) => rows)
				: refused
		case "attach":
			return heading.includes(via.parent) &&
				headingNames(state.install.base, role, via.relation).includes(via.child)
				? delivers((rows) => attachedRows(rows, rowsOf(via.relation), via, attachedField(heading)))
				: refused
		case "reach":
			return heading.includes(via.from) && heading.includes(via.to)
				? delivers((rows) => reachedPairs(rows, via.from, via.to))
				: refused
		case "get": {
			const entry = role.entries[relation]
			if (entry === undefined) {
				return refused
			}
			const mistyped = Arr.some(Rec.toEntries(via.key), ([field, value]) => {
				const domain = entryFieldDomain(state.install.base, entry, field)
				return domain !== undefined && !ofDomainType(domain, value)
			})
			return !mistyped && entryKeyed(state.install.base, entry, Rec.keys(via.key))
				? delivers((rows) => Arr.filter(rows, (r) => atKey(r, via.key)))
				: refused
		}
	}
}

/**
 * A refresh of a derived relation (README "Derived tables"): only one the role's refresh list names, which then holds its
 * definition's result over reality and the derived relations as they stand.
 */
const refreshCall = (state: ModelState, session: DbSessionState, relation: string): Called => {
	const role = roleOf(state.install, session.role)
	const derived = Option.getOrUndefined(
		Arr.findFirst(state.install.base.derived, (d) => d.name === relation)
	)
	if (role === undefined || derived === undefined || !role.refresh.includes(relation)) {
		return { kind: "host", refusals: [{ kind: "compile-refused" }] }
	}
	return {
		kind: "sends",
		sql: () => {
			const facts = evaluateRules(
				state.install.base,
				derived.rules,
				state.reality,
				state.derived,
				{}
			)
			return [
				{
					observation: { kind: "ok" },
					next: { ...state, derived: { ...state.derived, [relation]: facts } }
				}
			]
		}
	}
}

/** The state with what direct session `id` sent followed by `statement`, while the session is a direct one. */
const sentBy = (state: ModelState, id: number, statement: DirectStatement): ModelState => {
	const s = sessionAt(state, id)
	return s?.kind === "direct"
		? withSession(state, id, { ...s, sent: [...s.sent, statement] })
		: state
}

/**
 * Every outcome the README allows for one action from one state, each with the state it leads to. Concurrency is not
 * here: one action runs at a time, and a race is a fold of `step` over serial orders. SSI's serialization failure,
 * which PostgreSQL may raise in any SERIALIZABLE transaction, is: a Db call's TransientFailure (dbCall), a direct
 * statement's or COMMIT's 40001 (`serializable`), each changing nothing. A migration or drift run that lands an
 * installation leads to a state awaiting its names (Landed, settle). An action naming a session that is closed, never
 * opened, or of the wrong kind is refused as a stale handle and changes nothing.
 */
export const step = (state: ModelState, action: Action): Arr.NonEmptyReadonlyArray<Allowed> => {
	switch (action.kind) {
		case "open-db":
			return openBranches(state, action.role, action.token, action.snapshot)
		case "read":
			return dbCall(state, action.session, (view, s) =>
				readCall(view, s, action.relation, action.via)
			)
		case "apply":
			return dbCall(state, action.session, (view, s) =>
				applyCall(view, s, action.strata, action.reads)
			)
		case "refresh":
			return dbCall(state, action.session, (view, s) => refreshCall(view, s, action.relation))
		case "close": {
			const s = sessionAt(state, action.session)
			if (s === undefined || s.kind === "closed") {
				return handleRefused(state)
			}
			return [
				{
					observation: { kind: "ok" },
					next: withSession(state, action.session, s.kind === "db" ? closedDb : closedDirect)
				}
			]
		}
		case "direct-begin": {
			if (loginOf(state.install, action.login) === undefined) {
				return [{ observation: { kind: "refused", sqlstate: "other" }, next: state }]
			}
			const session: ModelSession = {
				kind: "direct",
				login: action.login,
				current: { kind: "login" },
				claims: { kind: "none" },
				isolation: action.isolation,
				transaction: "open",
				view: state.reality,
				prepared: {},
				sent: []
			}
			return startedBranches(
				{ ...state, sessions: [...state.sessions, session] },
				state.sessions.length,
				startStatements(action.start)
			)
		}
		case "direct": {
			const s = sessionAt(state, action.session)
			if (s?.kind !== "direct") {
				return handleRefused(state)
			}
			const answered = directBranches(state, action.session, s, action.statement)
			const branches = serializable(s, [action.statement])
				? Arr.append(
						answered,
						serializationFailed(
							withSession(state, action.session, { ...s, transaction: "aborted" })
						)
					)
				: answered
			return Arr.map(branches, (b) => ({
				...b,
				next: sentBy(b.next, action.session, action.statement)
			}))
		}
		case "direct-end": {
			const s = sessionAt(state, action.session)
			if (s?.kind !== "direct") {
				return handleRefused(state)
			}
			const ended = directEndBranches(state, action.session, s, action.end)
			return action.end === "commit" && serializable(s, s.sent)
				? Arr.append(ended, serializationFailed(withSession(state, action.session, closedDirect)))
				: ended
		}
		case "interrupt": {
			const s = sessionAt(state, action.session)
			if (s?.kind === "direct") {
				return directInterruptBranches(state, action.session, s)
			}
			return s?.kind === "db"
				? [{ observation: { kind: "ok" }, next: state }]
				: handleRefused(state)
		}
		case "migrate":
			return migrateBranches(state, action.to, action.how)
		case "tamper":
			return [
				{
					observation: { kind: "ok" },
					next: { ...state, tampered: [...state.tampered, action.perturbation] }
				}
			]
		case "drift":
			return driftBranches(state)
		case "wild": {
			const at = action.at
			if (at.kind !== "session") {
				return wildOpenBranches(state, at, action.wild)
			}
			return dbSessionAt(state, at.session) === undefined
				? handleRefused(state)
				: [{ observation: { kind: "compile-refused" }, next: state }]
		}
	}
}

/** The keys a witness shows: none when it is withheld. */
const shownKeys = (w: Witness): ReadonlyArray<HostFact> => (w.kind === "shown" ? w.keys : [])

/**
 * The binding, which `rest` accepts, under which an observed witness shows only keys the expected one allows: a shown
 * witness at least one, withheld none.
 */
const within = (expected: Witness, observed: Witness, rest: Rest): Binding | undefined => {
	const shown = shownKeys(observed)
	return observed.kind === "withheld" || shown.length > 0
		? everyMeets(
				shown,
				shownKeys(expected),
				(key, allowed, binding, next) => factMeets(allowed, key, binding, next),
				unbound,
				rest
			)
		: undefined
}

/**
 * Whether an observed refusing object is the expected one: the constraint of the same relation's table, any other object,
 * or, where the model leaves the object open, any.
 */
const refusedByMeets = (expected: RefusedBy, observed: RefusedBy): boolean => {
	switch (expected.kind) {
		case "constraint":
			return observed.kind === "constraint" && observed.relation === expected.relation
		case "other":
			return observed.kind === "other"
		case "open":
			return true
	}
}

/** An expected read-back meeting an observed one: one relation, its rows and delta as keyed sets (draws.ts bindFacts). */
const readBackMeets: Meet<ReadBack, ReadBack> = (e, o, binding, rest) =>
	o.relation === e.relation
		? bindFacts(e.rows, o.rows, binding, (rows) =>
				bindFacts(e.delta.inserted, o.delta.inserted, rows, (inserted) =>
					bindFacts(e.delta.deleted, o.delta.deleted, inserted, rest)
				)
			)
		: undefined

/**
 * The binding, which `rest` accepts, under which an observed outcome is the expected one, none when it is not; a draw
 * the expected outcome holds is any value of its type, one value wherever the outcome shows it (draws.ts), and the
 * binding says which. Rows compare as keyed sets: a delivery that repeats a row agrees with nothing. A witness agrees
 * when every key it shows is one the expected witness allows, each a key of its own: the model predicts the most README
 * "Errors and outcomes" lets a refusal show, and a refusal may name fewer of the violating facts, never another; a
 * withheld witness shows none; a refusal's object agrees where it is the one the model names (refusedByMeets).
 * Read-backs agree relation by relation, rows and delta as keyed sets. The drift check's
 * mismatches are catalog facts as PostgreSQL deparses them, which the model does not spell: drift agrees when both find
 * something or both find nothing.
 */
const matched = (
	expected: ActionOutcome,
	observed: ActionOutcome,
	rest: Rest
): Binding | undefined => {
	const agreed = (same: boolean): Binding | undefined => (same ? rest(unbound) : undefined)
	switch (expected.kind) {
		case "opened":
			return agreed(
				observed.kind === "opened" &&
					observed.session === expected.session &&
					observed.verifyCalls === expected.verifyCalls
			)
		case "open-refused":
			return agreed(
				observed.kind === "open-refused" &&
					observed.stage === expected.stage &&
					observed.verifyCalls === expected.verifyCalls
			)
		case "rows":
			return observed.kind === "rows"
				? bindFacts(expected.rows, observed.rows, unbound, rest)
				: undefined
		case "applied":
			return observed.kind === "applied" &&
				observed.outcome === expected.outcome &&
				observed.reads.length === expected.reads.length
				? everyMeets(expected.reads, observed.reads, readBackMeets, unbound, rest)
				: undefined
		case "invariant-rejected":
			return observed.kind === "invariant-rejected" &&
				observed.law === expected.law &&
				refusedByMeets(expected.by, observed.by)
				? within(expected.witness, observed.witness, rest)
				: undefined
		case "law-refused":
			return observed.kind === "law-refused" &&
				observed.sqlstate === expected.sqlstate &&
				observed.law === expected.law
				? within(expected.witness, observed.witness, rest)
				: undefined
		case "outside-world":
			return agreed(observed.kind === "outside-world" && observed.relation === expected.relation)
		case "transient":
			return agreed(observed.kind === "transient" && observed.reason === expected.reason)
		case "refused":
			return agreed(observed.kind === "refused" && observed.sqlstate === expected.sqlstate)
		case "migration-refused":
			return agreed(observed.kind === "migration-refused" && observed.stage === expected.stage)
		case "stale-snapshot":
			return agreed(observed.kind === "stale-snapshot" && observed.reason === expected.reason)
		case "drift":
			return agreed(
				observed.kind === "drift" &&
					(observed.objects.length === 0) === (expected.objects.length === 0)
			)
		case "compile-refused":
		case "encoding-refused":
		case "resource-bound":
		case "commit-unknown":
		case "interrupted":
		case "handle-refused":
		case "ok":
			return agreed(observed.kind === expected.kind)
	}
}

/**
 * The state a branch leads to once its outcome is the observed one (matched): the branch's state with each draw the
 * observation showed held as its value, every such value one its column holds nowhere else in that state (fresh);
 * none when the observation is not the branch's.
 */
export const observedNext = (branch: Branch, observed: ActionOutcome): ModelState | undefined => {
	const binding = matched(branch.observation, observed, (met) =>
		fresh(branch.next, met) ? met : undefined
	)
	return binding === undefined ? undefined : bound(branch.next, binding)
}

/** The PostgreSQL role the installation gave a grizzle role or login; every one has one. */
const installedRole = (names: Readonly<Record<string, string>>, name: string): string => {
	const installed = names[name]
	if (installed === undefined) {
		throw new Error(`the installation names no PostgreSQL role for ${name}`)
	}
	return installed
}

/**
 * What a session's connection shows (README "Deploying": every transaction a Db sends takes on its role and
 * claims for that transaction only). A Db's connection between calls is its login's, with no claims, outside any
 * transaction. A direct writer is inside its transaction: as the role it took on, or its login, with the claims it set;
 * an aborted transaction shows only that. A closed session has no connection to probe.
 */
export const expectedProbe = (state: ModelState, session: number): Probe => {
	const s = sessionAt(state, session)
	if (s === undefined || s.kind === "closed") {
		throw new Error(`session ${session} has no connection to probe`)
	}
	if (s.kind === "db") {
		return {
			transaction: "idle",
			currentUser: installedRole(state.names.logins, s.login),
			claims: ""
		}
	}
	if (s.transaction === "aborted") {
		return { transaction: "aborted" }
	}
	const setting = s.claims.kind === "none" ? undefined : s.claims.setting
	return {
		transaction: "in-transaction",
		currentUser:
			s.current.kind === "role"
				? installedRole(state.names.roles, s.current.role)
				: installedRole(state.names.logins, s.login),
		claims:
			setting === undefined
				? ""
				: setting.kind === "facts"
					? claimsText(state.install.base.contexts, state.names.codes, setting.facts)
					: setting.text
	}
}

/** Every uuid and text value reality holds, each as PostgreSQL spells it. */
const realityTokens = (state: ModelState): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(state.install.base.relations, (r) => {
			const tokened = Arr.map(
				Arr.filter(r.fields, (f) => f.domain.kind === "uuid" || f.domain.kind === "text"),
				(f) => f.name
			)
			return Arr.flatMap(factsIn(state.reality, r.name), (fact) =>
				Arr.flatMap(tokened, (f) => {
					const v = fact[f]
					return v === undefined ? [] : [valueText(v)]
				})
			)
		})
	)

/** Every value of some facts, as PostgreSQL spells it. */
const valuesOf = (facts: ReadonlyArray<HostFact>): ReadonlyArray<string> =>
	Arr.flatMap(facts, (f) => Arr.map(Rec.values(f), (v: HostValue) => valueText(v)))

/** What a session's world shows: every row of every role relation under its facts, its writable tables' members, and its claims. */
const shownTo = (state: ModelState, role: string, facts: ContextFacts): ReadonlySet<string> => {
	const spec = roleOf(state.install, role)
	if (spec === undefined) {
		return new Set()
	}
	const rows = Arr.flatMap(Rec.keys(spec.entries), (relation) =>
		entryRows(state, role, relation, facts)
	)
	const members = Arr.flatMap(writtenOf(state.install.base, spec), (w) =>
		Arr.filter(
			factsIn(state.reality, w.target),
			(f) => w.kind === "whole" || isMember(state, role, w.entry, facts, f)
		)
	)
	return new Set([...valuesOf(rows), ...valuesOf(members), ...valuesOf(Rec.values(facts))])
}

/**
 * The uuid and text values of reality a session's world never shows: every one for a session not open (one an action
 * would open, or a closed one), and for an open one those no relation of its role, no member of a table it writes and
 * none of its claims holds. A direct writer acting as its login sees none. The driver removes what the action submits,
 * and for a direct writer what its transaction sent before it (DirectSessionState `sent`).
 */
export const hiddenTokens = (state: ModelState, session: number): ReadonlySet<string> => {
	const all = realityTokens(state)
	const s = sessionAt(state, session)
	if (s === undefined || s.kind === "closed") {
		return all
	}
	const hiddenFrom = (shown: ReadonlySet<string>): ReadonlySet<string> =>
		new Set(Arr.filter([...all], (t) => !shown.has(t)))
	if (s.kind === "db") {
		return hiddenFrom(shownTo(state, s.role, s.facts))
	}
	if (s.current.kind === "login") {
		return all
	}
	const facts =
		s.claims.kind === "set" && s.claims.setting.kind === "facts" ? s.claims.setting.facts : {}
	return hiddenFrom(shownTo(seenThrough(state, s.view), s.current.role, facts))
}
