import type { Situations } from "@bjornpagen/testing/features"
import { Array as Arr, Option, Record } from "effect"
import { isSpan, sameValue } from "#test/support/laws/model.ts"
import { invalidKindsOf } from "#test/support/worlds/generate/classify.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import { entryKey } from "#test/support/worlds/generate/reads.ts"
import { invalidKinds } from "#test/support/worlds/invalid/kinds.ts"
import {
	classifyEntry,
	entryRows,
	equalValues,
	evaluateRules,
	factKey,
	factKeySet,
	isMember,
	sameFact
} from "#test/support/worlds/model/host.ts"
import { reachedPairs, steppedPairs } from "#test/support/worlds/model/reads.ts"
import { compileRefused, readBackClasses } from "#test/support/worlds/model/session/apply.ts"
import { handSetFaults } from "#test/support/worlds/model/session/direct.ts"
import { reorderedRoster } from "#test/support/worlds/model/session/migrate.ts"
import {
	dbSessionAt,
	directSessionAt,
	draftedFrom,
	entryContexts,
	roleEntryOf,
	factsIn,
	relationSpecOf,
	roleOf,
	seenThrough,
	sessionAt
} from "#test/support/worlds/model/session/state.ts"
import {
	filterReadsStored,
	installedRole,
	installedWrite,
	keysOf,
	serialHead,
	writtenNamed
} from "#test/support/worlds/model/session/writes.ts"
import type {
	Action,
	ActionKind,
	AdditionFeature,
	BaseSpec,
	ClaimReadAt,
	ClaimRefusal,
	ClaimState,
	ClassedEntry,
	ContextFacts,
	DbSessionState,
	DirectSessionState,
	DirectStatement,
	EntryClass,
	EntryOp,
	EntrySpec,
	FieldDomain,
	HostFact,
	InstallSpec,
	InvariantName,
	LawFamily,
	LawIds,
	LawPath,
	LawSpec,
	Membership,
	MigrationKind,
	ModelState,
	ObjectKind,
	Observation,
	PageKey,
	ActionOutcome,
	RelationSpec,
	RefinedClaim,
	RoleSpec,
	Rule,
	ModelSession,
	Term,
	Token,
	HostValue,
	WorldFeature,
	WriteShape,
	Writer
} from "#test/support/worlds/model/types.ts"

/** What a session's claims hold: context facts, or a malformed setting, which holds none. */
type Claims =
	| { readonly kind: "facts"; readonly facts: ContextFacts }
	| { readonly kind: "malformed" }

const noClaims: Claims = { kind: "facts", facts: {} }

/** The installed role of that name, none when the installation has none (session/state.ts roleOf, read as an Option). */
const roleIn = (install: InstallSpec, name: string): Option.Option<RoleSpec> =>
	Option.fromUndefinedOr(roleOf(install, name))

/** A role's entry of that name, none when it has none. */
const entryIn = (role: RoleSpec, relation: string): Option.Option<EntrySpec> =>
	Option.fromUndefinedOr(roleEntryOf(role, relation))

/** The direct session at `id`, none when the state holds none there or one of another kind. */
const directSession = (state: ModelState, id: number): Option.Option<DirectSessionState> =>
	Option.fromUndefinedOr(directSessionAt(state, id))

/** The Db session at `id`, none when the state holds none there or one of another kind. */
const dbSession = (state: ModelState, id: number): Option.Option<DbSessionState> =>
	Option.fromUndefinedOr(dbSessionAt(state, id))

/** The entry of that name of the installed role of that name, none when either is missing. */
const roleEntry = (
	install: InstallSpec,
	role: string,
	relation: string
): Option.Option<EntrySpec> => Option.flatMap(roleIn(install, role), (r) => entryIn(r, relation))

/**
 * A role acting: through a Db, or a direct writer that took it on, reading `state` (a writer's transaction view), with
 * its entries, each classed once for the action.
 */
interface RoleActor {
	readonly kind: "role"
	readonly writer: "db" | "direct-role"
	readonly role: RoleSpec
	readonly entries: ReadonlyArray<ClassedEntry>
	readonly state: ModelState
	readonly claims: Claims
}

/** A role acting, its entries classed against the installation's base. */
const roleActor = (
	writer: RoleActor["writer"],
	role: RoleSpec,
	state: ModelState,
	claims: Claims
): RoleActor => ({
	kind: "role",
	writer,
	role,
	entries: installedRole(state, role.name).entries,
	state,
	claims
})

/**
 * Who performs an action, read off the state before it: a role; a login acting as itself, which sees no fact; a call
 * naming a closed session or a session of the other kind, refused as a stale handle before it reads anything; or the
 * caller of an action that runs on no session (Db.open, a direct writer's BEGIN, the owner's migrate, tamper and
 * drift, a wild value handed to Db.open). The owner acts as itself, a login that never takes on a role.
 */
type Actor =
	| RoleActor
	| { readonly kind: "login"; readonly claims: Claims }
	| { readonly kind: "handle"; readonly writer: Writer }
	| { readonly kind: "caller"; readonly writer: Writer }

/** The kind of session an action runs on. */
type Wants = "db" | "direct" | "either"

const writerOf = (actor: Actor): Writer => {
	switch (actor.kind) {
		case "role":
			return actor.writer
		case "login":
			return "direct-login"
		case "handle":
		case "caller":
			return actor.writer
	}
}

/** A call refused as a stale handle, by the writer whose handle it named. */
const stale = (writer: Writer): Actor => ({ kind: "handle", writer })

const sessionActor = (state: ModelState, id: number, wants: Wants): Actor =>
	Option.match(Option.fromUndefinedOr(sessionAt(state, id)), {
		onNone: () => stale(wants === "direct" ? "direct-login" : "db"),
		onSome: (session) => liveActor(state, session, wants)
	})

/** The actor of a session the state holds: a stale handle when the session is closed or of the other kind. */
const liveActor = (state: ModelState, session: ModelSession, wants: Wants): Actor => {
	switch (session.kind) {
		case "closed":
			return stale(session.was === "db" ? "db" : "direct-login")
		case "db":
			return Option.match(roleIn(state.install, session.role), {
				onNone: () => stale("db"),
				onSome: (role): Actor =>
					wants === "direct"
						? stale("db")
						: roleActor("db", role, state, { kind: "facts", facts: session.facts })
			})
		case "direct": {
			const claims: Claims =
				session.claims.kind === "none"
					? noClaims
					: session.claims.setting.kind === "facts"
						? { kind: "facts", facts: session.claims.setting.facts }
						: { kind: "malformed" }
			if (session.current.kind === "login") {
				return wants === "db" ? stale("direct-login") : { kind: "login", claims }
			}
			const view = session.view
			return Option.match(roleIn(state.install, session.current.role), {
				onNone: () => stale("direct-role"),
				onSome: (role): Actor =>
					wants === "db"
						? stale("direct-role")
						: roleActor("direct-role", role, seenThrough(state, view), claims)
			})
		}
	}
}

const actorOf = (state: ModelState, action: Action): Actor => {
	switch (action.kind) {
		case "open-db":
			return { kind: "caller", writer: "db" }
		case "read":
		case "apply":
		case "refresh":
		case "close":
			return sessionActor(state, action.session, "db")
		case "direct":
		case "direct-end":
			return sessionActor(state, action.session, "direct")
		case "interrupt":
			return sessionActor(state, action.session, "either")
		case "direct-begin":
		case "migrate":
		case "tamper":
		case "drift":
			return { kind: "caller", writer: "direct-login" }
		case "wild":
			return action.at.kind === "session"
				? sessionActor(state, action.at.session, "db")
				: { kind: "caller", writer: "db" }
	}
}

/** A stored fact an action reads or meets, by its relation. */
interface Stored {
	readonly relation: string
	readonly fact: HostFact
}

/** A fact an action submits through an entry of the acting role: in the entry's own fields, or in its target's. */
interface Submitted {
	readonly entry: Option.Option<string>
	readonly space: "entry" | "target"
	readonly fact: HostFact
}

/** What an action touches: the acting role's entry it goes through, the stored facts it reads or meets, what it submits. */
interface Touch {
	readonly entry: Option.Option<string>
	readonly stored: ReadonlyArray<Stored>
	readonly submitted: ReadonlyArray<Submitted>
}

const untouched: Touch = { entry: Option.none(), stored: [], submitted: [] }

/** A relation's facts in a state: an ordinary relation's in reality, a derived relation's as of its last refresh. */
const storedFacts = (state: ModelState, relation: string): ReadonlyArray<Stored> =>
	Arr.map(
		Arr.some(state.install.base.relations, (r) => r.name === relation)
			? factsIn(state.reality, relation)
			: Option.getOrElse(Record.get(state.derived, relation), () => []),
		(fact) => ({ relation, fact })
	)

/** Every relation a rule names, in a match or a negation. */
const ruleRelations = (rule: Rule): ReadonlyArray<string> =>
	Arr.flatMap([...rule.matches, ...Arr.flatten(rule.negations)], (o) =>
		o.source.kind === "context" ? [] : [o.source.name]
	)

/**
 * The relations a read of an entry reads facts of: a whole entry's relation; a writable query entry's target, whose
 * facts its rows stand for; and every relation a read-only query entry names.
 */
const readRelations = (base: BaseSpec, entry: EntrySpec): ReadonlyArray<string> => {
	if (entry.kind === "whole") {
		return [entry.relation]
	}
	const classified = classifyEntry(base, entry)
	return classified.kind === "writable"
		? [classified.target]
		: Arr.dedupe(Arr.flatMap(entry.rules, ruleRelations))
}

/** Whether two key values meet: equal, or two spans sharing a point. */
const meets = (a: HostValue, b: HostValue): boolean =>
	isSpan(a) && isSpan(b) ? a.start < b.end && b.start < a.end : equalValues(a, b)

/**
 * Whether a fact of a relation names a key at which a stored fact sits: every field of the key present in both, and
 * each meeting. The relation's keys are read once, for every pair the predicate is asked about.
 */
const collision = (
	base: BaseSpec,
	relation: string
): ((fact: HostFact, stored: HostFact) => boolean) => {
	const keys = keysOf(base, relation)
	return (fact, stored) =>
		Arr.some(keys, (fields) =>
			Arr.every(fields, (field) =>
				Option.match(Option.all([Record.get(fact, field), Record.get(stored, field)]), {
					onNone: () => false,
					onSome: ([a, b]) => meets(a, b)
				})
			)
		)
}

/** The stored facts of a relation the submitted facts meet at one of its keys, each fact's in turn. */
const metByEach = (
	state: ModelState,
	relation: string,
	facts: ReadonlyArray<HostFact>
): ReadonlyArray<Stored> => {
	const stored = storedFacts(state, relation)
	const collides = collision(state.install.base, relation)
	return Arr.flatMap(facts, (fact) => Arr.filter(stored, (s) => collides(fact, s.fact)))
}

/** The stored facts of a relation a submitted fact meets at one of its keys. */
const metBy = (state: ModelState, relation: string, fact: HostFact): ReadonlyArray<Stored> =>
	metByEach(state, relation, [fact])

const factsOfClaims = (claims: Claims): ContextFacts =>
	claims.kind === "facts" ? claims.facts : {}

/**
 * The target fact an entry fact stands for: its head fields under the target's names, and each fill, a context fill
 * read from the claims; a fill whose context holds no fact is left out, so the fact names fewer keys.
 */
const targetFact = (
	classified: Extract<EntryClass, { readonly kind: "writable" }>,
	facts: ContextFacts,
	fact: HostFact
): HostFact => ({
	...Record.fromEntries(
		Arr.flatMap(Record.toEntries(classified.head), ([head, { field }]) =>
			Option.match(Record.get(fact, head), {
				onNone: () => [],
				onSome: (value) => [[field, value] as const]
			})
		)
	),
	...Record.fromEntries(
		Arr.flatMap(Record.toEntries(classified.fills), ([field, fill]) => {
			if (fill.kind === "literal") {
				return [[field, fill.value] as const]
			}
			const value = Option.flatMap(Record.get(facts, fill.context), (f) =>
				Record.get(f, fill.field)
			)
			return Option.match(value, { onNone: () => [], onSome: (v) => [[field, v] as const] })
		})
	)
})

/** The role's entry that writes a base relation, by name: an entry its write list names whose target the relation is. */
const writeEntryOf = (state: ModelState, role: RoleSpec, relation: string): Option.Option<string> =>
	Option.map(Option.fromUndefinedOr(installedWrite(state, role.name, relation)), (w) => w.entry)

/** What a read of a role's entry touches, as the acting role sees it: through its own entry, or another role's. */
const readTouch = (actor: RoleActor, role: string, relation: string): Touch =>
	Option.match(roleEntry(actor.state.install, role, relation), {
		onNone: () => untouched,
		onSome: (entry): Touch => ({
			entry: role === actor.role.name ? Option.some(relation) : Option.none(),
			stored: Arr.flatMap(readRelations(actor.state.install.base, entry), (r) =>
				storedFacts(actor.state, r)
			),
			submitted: []
		})
	})

/** What an apply's op touches: the stored facts its facts meet at a key, through the entry it writes. */
const opTouch = (actor: RoleActor, op: EntryOp): Touch =>
	Option.match(entryIn(actor.role, op.relation), {
		onNone: () => untouched,
		onSome: (entry) => entryTouch(actor, op, entry)
	})

/** What an apply's op touches through the role's entry it writes. */
const entryTouch = (actor: RoleActor, op: EntryOp, entry: EntrySpec): Touch => {
	const classified = classifyEntry(actor.state.install.base, entry)
	if (classified.kind === "read-only") {
		return { entry: Option.some(op.relation), stored: [], submitted: [] }
	}
	const facts = factsOfClaims(actor.claims)
	return {
		entry: Option.some(op.relation),
		stored: metByEach(
			actor.state,
			classified.target,
			Arr.map(op.facts, (fact) => targetFact(classified, facts, fact))
		),
		submitted: Arr.map(op.facts, (fact): Submitted => ({
			entry: Option.some(op.relation),
			space: "entry",
			fact
		}))
	}
}

/** Every write of a ChangeSet, its strata in order. */
const opsOf = (action: Extract<Action, { readonly kind: "apply" }>): ReadonlyArray<EntryOp> =>
	Arr.flatten(action.strata)

/** What a direct writer's statement touches, as the role it took on sees it. */
const statementTouch = (actor: RoleActor, statement: DirectStatement): Touch => {
	const through = (
		relation: string,
		stored: ReadonlyArray<Stored>,
		submitted: ReadonlyArray<HostFact>
	): Touch => {
		const entry = writeEntryOf(actor.state, actor.role, relation)
		return {
			entry,
			stored,
			submitted: Arr.map(submitted, (fact): Submitted => ({ entry, space: "target", fact }))
		}
	}
	switch (statement.kind) {
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
		case "call":
		case "setval":
		case "prepare":
		case "execute-prepared":
			return untouched
		case "select-view":
			return readTouch(actor, statement.role, statement.relation)
		case "select-table":
		case "truncate":
			return through(statement.relation, storedFacts(actor.state, statement.relation), [])
		case "insert":
		case "insert-on-conflict":
			return through(statement.relation, metBy(actor.state, statement.relation, statement.fact), [
				statement.fact
			])
		case "delete":
			return through(statement.relation, metBy(actor.state, statement.relation, statement.key), [])
		case "merge-delete":
			return through(
				statement.relation,
				metByEach(actor.state, statement.relation, statement.keys),
				[]
			)
		case "update":
			return through(statement.relation, metBy(actor.state, statement.relation, statement.key), [
				{ ...statement.key, ...statement.set }
			])
	}
}

const touchOf = (actor: RoleActor, action: Action): Touch => {
	switch (action.kind) {
		case "read":
			return readTouch(actor, actor.role.name, action.relation)
		case "apply": {
			const touches = Arr.map(opsOf(action), (op) => opTouch(actor, op))
			return {
				entry: Arr.findFirst(touches, (t) => Option.isSome(t.entry)).pipe(
					Option.flatMap((t) => t.entry)
				),
				stored: Arr.flatMap(touches, (t) => t.stored),
				submitted: Arr.flatMap(touches, (t) => t.submitted)
			}
		}
		case "direct":
			return statementTouch(actor, action.statement)
		case "open-db":
		case "refresh":
		case "close":
		case "direct-begin":
		case "direct-end":
		case "interrupt":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return untouched
	}
}

/** Whether the role's entry holds a stored fact: a whole entry every fact of its relation, a query entry its members. */
const entryHolds = (actor: RoleActor, name: string, stored: Stored): boolean =>
	Option.exists(
		Arr.findFirst(actor.entries, (e) => e.name === name),
		(e) => holdsThrough(actor, e, stored)
	)

/** Whether one of the role's entries holds a stored fact. */
const holdsThrough = (
	actor: RoleActor,
	{ name, entry, classified }: ClassedEntry,
	stored: Stored
): boolean => {
	if (entry.kind === "whole") {
		return entry.relation === stored.relation
	}
	return (
		classified.kind === "writable" &&
		classified.target === stored.relation &&
		isMember(actor.state, actor.role.name, name, factsOfClaims(actor.claims), stored.fact)
	)
}

const visibility: Readonly<Record<Membership, number>> = {
	hidden: 0,
	"outside-visible": 1,
	inside: 2
}

/** The least visible of some memberships; inside when there are none, since nothing outside was met. */
const leastVisible = (memberships: ReadonlyArray<Membership>): Membership =>
	Arr.reduce(memberships, "inside", (a: Membership, b) => (visibility[b] < visibility[a] ? b : a))

/** A stored fact as the acting role sees it: in the entry it goes through, in another of its entries, or in none. */
const membershipOf = (actor: RoleActor, touch: Touch, stored: Stored): Membership => {
	if (Option.isSome(touch.entry) && entryHolds(actor, touch.entry.value, stored)) {
		return "inside"
	}
	return Arr.some(actor.entries, (e) => holdsThrough(actor, e, stored))
		? "outside-visible"
		: "hidden"
}

/**
 * The membership of an action: the least visible of the stored facts it reads or meets. A login sees no fact, so any
 * fact it meets is hidden from it; an action that meets none touches nothing outside, so it is inside.
 */
const actionMembership = (actor: Actor, touch: Touch): Membership => {
	switch (actor.kind) {
		case "role":
			return leastVisible(Arr.map(touch.stored, (s) => membershipOf(actor, touch, s)))
		case "login":
			return touch.stored.length === 0 ? "inside" : "hidden"
		case "handle":
		case "caller":
			return "inside"
	}
}

/** A context field a writable entry fixes a field to: in its target's fields, and in its own when the field is in the head. */
interface Claimed {
	readonly target: string
	readonly head: Option.Option<string>
	readonly context: string
	readonly field: string
}

/**
 * The fields a writable query entry binds to a context field: each context fill of its target, and each head field the
 * claims fix though the caller submits it: one whose term is the context field itself, or whose variable a positive
 * context match also binds.
 */
const claimedOf = (
	entry: EntrySpec,
	classified: Extract<EntryClass, { readonly kind: "writable" }>
): ReadonlyArray<Claimed> => {
	const fills = Arr.flatMap(
		Record.toEntries(classified.fills),
		([target, fill]): ReadonlyArray<Claimed> =>
			fill.kind === "context"
				? [{ target, head: Option.none(), context: fill.context, field: fill.field }]
				: []
	)
	if (entry.kind === "whole") {
		return fills
	}
	const [rule] = entry.rules
	const bound = Arr.flatMap(rule.matches, (o) => {
		const source = o.source
		return source.kind === "context"
			? Arr.flatMap(Record.toEntries(o.fields), ([field, term]) =>
					term.kind === "var" ? [{ variable: term.name, context: source.name, field }] : []
				)
			: []
	})
	const heads = Arr.flatMap(
		Record.toEntries(classified.head),
		([head, { field: target }]): ReadonlyArray<Claimed> =>
			Option.match(Record.get(rule.head, head), {
				onNone: () => [],
				onSome: (term): ReadonlyArray<Claimed> => {
					switch (term.kind) {
						case "var":
							return Arr.map(
								Arr.filter(bound, (b) => b.variable === term.name),
								(b): Claimed => ({
									target,
									head: Option.some(head),
									context: b.context,
									field: b.field
								})
							)
						case "context":
							return [{ target, head: Option.some(head), context: term.context, field: term.field }]
						case "literal":
						case "handle":
							return []
					}
				}
			})
	)
	return [...fills, ...heads]
}

/** Whether a submitted fact disagrees with the claims on a field the entry binds to a context field. */
const disagrees = (
	claimed: ReadonlyArray<Claimed>,
	facts: ContextFacts,
	submitted: Submitted
): boolean =>
	Arr.some(claimed, (c) => {
		const at = submitted.space === "entry" ? c.head : Option.some(c.target)
		const value = Option.flatMap(at, (field) => Record.get(submitted.fact, field))
		const claim = Option.flatMap(Record.get(facts, c.context), (f) => Record.get(f, c.field))
		return Option.match(Option.all([value, claim]), {
			onNone: () => false,
			onSome: ([v, w]) => !equalValues(v, w)
		})
	})

const tokenClaim = (token: Token): ClaimState => {
	switch (token.kind) {
		case "none":
			return "absent"
		case "live":
			return "matching"
		case "stale":
			return "not-matching"
		case "wild":
			return "malformed"
	}
}

/**
 * The claims an action runs under, judged against what it touches: malformed for a malformed setting or a wild token;
 * absent with no context fact, or none for a context the touched entry reads; not-matching when a submitted fact
 * disagrees with a claim on a field the entry binds to it, or for a stale token; matching otherwise. A stale handle and
 * an action on no session take on no claims.
 */
const claimStateOf = (action: Action, actor: Actor, touch: Touch): ClaimState => {
	if (action.kind === "open-db") {
		return tokenClaim(action.token)
	}
	if (action.kind === "wild" && action.at.kind === "open-token") {
		return "malformed"
	}
	switch (actor.kind) {
		case "handle":
		case "caller":
			return "absent"
		case "login":
			return actor.claims.kind === "malformed"
				? "malformed"
				: Record.isEmptyRecord(actor.claims.facts)
					? "absent"
					: "matching"
		case "role": {
			if (actor.claims.kind === "malformed") {
				return "malformed"
			}
			const facts = actor.claims.facts
			const entryNamed = (name: Option.Option<string>): Option.Option<EntrySpec> =>
				Option.flatMap(name, (n) => entryIn(actor.role, n))
			const entries = Arr.getSomes([
				entryNamed(touch.entry),
				...Arr.map(touch.submitted, (s) => entryNamed(s.entry))
			])
			const needed = Arr.flatMap(entries, (e) => [...entryContexts(e)])
			if (
				Record.isEmptyRecord(facts) ||
				Arr.some(needed, (context) => !Record.has(facts, context))
			) {
				return "absent"
			}
			const claimedBy = (s: Submitted): ReadonlyArray<Claimed> =>
				Option.match(entryNamed(s.entry), {
					onNone: () => [],
					onSome: (e) => {
						const classified = classifyEntry(actor.state.install.base, e)
						return classified.kind === "writable" ? claimedOf(e, classified) : []
					}
				})
			return Arr.some(touch.submitted, (s) => disagrees(claimedBy(s), facts, s))
				? "not-matching"
				: "matching"
		}
	}
}

/** Whether a role's writable entry is a query entry, so a policy filters its writes, and whether a filter function serves it. */
interface Filtered {
	readonly name: string
	readonly function: boolean
}

/**
 * The policy behind a write through a role's entry: none for a whole entry, whose policy is TRUE; for a writable
 * query entry, its filter, served by a filter function when its rule reads a stored relation besides the target's row
 * (a match or a negation of an ordinary or derived relation other than the supplying occurrence).
 */
const filteredOf = (base: BaseSpec, role: RoleSpec, name: string): Option.Option<Filtered> =>
	Option.flatMap(entryIn(role, name), (entry) =>
		entry.kind === "whole" || classifyEntry(base, entry).kind === "read-only"
			? Option.none()
			: Option.some({ name, function: filterReadsStored(entry.rules) })
	)

type ObjectOutcomeOf<F> = F extends `object:${string}:${infer O}` ? O : never

/** What a world object can show: the outcome half of an `object:` feature. */
type ObjectOutcome = ObjectOutcomeOf<WorldFeature>

const objectFeature = (kind: ObjectKind, outcome: ObjectOutcome): WorldFeature =>
	`object:${kind}:${outcome}`

/** A policy's outcome, and its filter function's when one serves it. */
const policy = (filtered: Filtered, outcome: ObjectOutcome): ReadonlyArray<WorldFeature> => [
	objectFeature("policy", outcome),
	...(filtered.function ? [objectFeature("filter-function", outcome)] : [])
]

/** Whether a raise-on filter over a table under row security would have raised on a row its policy hides from the role. */
const raiseOnTable = (actor: RoleActor, touch: Touch, field: string, value: HostValue): boolean =>
	Arr.some(
		touch.stored,
		(s) =>
			membershipOf(actor, touch, s) !== "inside" &&
			Option.exists(Record.get(s.fact, field), (v) => equalValues(v, value))
	)

/** The privilege a direct statement on a base relation needs, which the role holds by writing the relation. */
const holdsFor = (state: ModelState, role: RoleSpec, statement: DirectStatement): boolean => {
	const base = state.install.base
	switch (statement.kind) {
		case "select-table":
		case "insert":
		case "delete":
		case "merge-delete":
			return Option.isSome(writeEntryOf(state, role, statement.relation))
		case "insert-on-conflict":
			return (
				Option.isSome(writeEntryOf(state, role, statement.relation)) &&
				(statement.onConflict.kind !== "update" ||
					Arr.some(
						base.relations,
						(r) => r.name === statement.relation && r.mutability === "mutable"
					))
			)
		case "update": {
			const relation = Arr.findFirst(base.relations, (r) => r.name === statement.relation)
			return (
				Option.isSome(writeEntryOf(state, role, statement.relation)) &&
				Option.exists(relation, (r) => r.mutability === "mutable")
			)
		}
		case "truncate":
		case "setval":
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
		case "select-view":
		case "call":
		case "prepare":
		case "execute-prepared":
			return false
	}
}

const refusedPrivilege = (observation: Observation): boolean =>
	observation.kind === "refused" && observation.sqlstate === "42501"

const succeeded = (observation: Observation): boolean =>
	observation.kind === "ok" || observation.kind === "rows"

/** The view kind of a role's entry: a whole entry's plain view, a query entry's security-barrier view. */
const viewKind = (entry: EntrySpec): ObjectKind =>
	entry.kind === "whole" ? "view" : "barrier-view"

/** A read's objects: the view showed its world; a security-barrier view hid a fact the role cannot see. */
const readObjects = (
	actor: RoleActor,
	touch: Touch,
	relation: string,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (observation.kind !== "rows") {
		return []
	}
	return Option.match(entryIn(actor.role, relation), {
		onNone: () => [],
		onSome: (entry) => {
			const kind = viewKind(entry)
			const hidden = Arr.some(touch.stored, (s) => membershipOf(actor, touch, s) === "hidden")
			return [
				objectFeature(kind, "accepted-inside"),
				...(kind === "barrier-view" && hidden ? [objectFeature(kind, "hidden-row-absent")] : [])
			]
		}
	})
}

/**
 * Whether a raise-on filter over a query entry's view would have raised on a row hidden from the role: a stored fact
 * outside the entry carries the value at the target field the filter's head field stands for.
 */
const raiseWouldHide = (
	actor: RoleActor,
	touch: Touch,
	relation: string,
	field: string,
	value: HostValue
): boolean =>
	Option.exists(
		entryIn(actor.role, relation),
		(entry) => entry.kind === "query" && hidesRaise(actor, touch, entry, field, value)
	)

/** Whether a raise-on filter over one query entry's view would have raised on a row hidden from the role. */
const hidesRaise = (
	actor: RoleActor,
	touch: Touch,
	entry: EntrySpec,
	field: string,
	value: HostValue
): boolean => {
	const classified = classifyEntry(actor.state.install.base, entry)
	const target =
		classified.kind === "writable"
			? Option.map(Option.fromUndefinedOr(classified.head[field]), (h) => h.field)
			: Option.some(field)
	return Arr.some(
		touch.stored,
		(s) =>
			membershipOf(actor, touch, s) !== "inside" &&
			Option.exists(
				Option.flatMap(target, (f) => Record.get(s.fact, f)),
				(v) => equalValues(v, value)
			)
	)
}

const functionKind = (
	fn: Extract<DirectStatement, { readonly kind: "call" }>["fn"]
): ObjectKind => {
	switch (fn.kind) {
		case "filter":
			return "filter-function"
		case "key-probe":
			return "key-probe"
		case "advance":
			return "advance-function"
	}
}

/** What a direct statement shows of the world's objects. */
const statementObjects = (
	state: ModelState,
	actor: Actor,
	touch: Touch,
	statement: DirectStatement,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	switch (statement.kind) {
		case "set-role":
		case "set-session-authorization":
			return observation.kind === "ok" && statement.kind === "set-role"
				? [objectFeature("membership", "accepted-inside")]
				: observation.kind === "refused"
					? [objectFeature("membership", "attempt-refused")]
					: []
		case "reset-role":
		case "set-claims":
		case "prepare":
		case "execute-prepared":
			return []
		case "call": {
			const kind = functionKind(statement.fn)
			return refusedPrivilege(observation)
				? [objectFeature(kind, "attempt-refused")]
				: observation.kind === "ok"
					? [objectFeature(kind, "accepted-inside")]
					: []
		}
		case "select-view": {
			if (actor.kind === "role" && statement.role === actor.role.name) {
				const raised =
					statement.filter.kind === "raise-on" &&
					observation.kind === "rows" &&
					raiseWouldHide(
						actor,
						touch,
						statement.relation,
						statement.filter.field,
						statement.filter.value
					)
				return [
					...readObjects(actor, touch, statement.relation, observation),
					...(raised ? [objectFeature("barrier-view", "raise-suppressed")] : [])
				]
			}
			const kind = Option.match(roleEntry(state.install, statement.role, statement.relation), {
				onNone: (): ObjectKind => "barrier-view",
				onSome: viewKind
			})
			return refusedPrivilege(observation) ? [objectFeature(kind, "attempt-refused")] : []
		}
		case "select-table":
		case "insert":
		case "insert-on-conflict":
		case "delete":
		case "merge-delete":
		case "update":
		case "truncate":
		case "setval": {
			if (actor.kind === "login") {
				return refusedPrivilege(observation) ? [objectFeature("revoke", "attempt-refused")] : []
			}
			if (actor.kind !== "role") {
				return []
			}
			const held = holdsFor(actor.state, actor.role, statement)
			const grant: ReadonlyArray<WorldFeature> = held
				? succeeded(observation)
					? [objectFeature("grant", "accepted-inside")]
					: []
				: refusedPrivilege(observation)
					? [objectFeature("grant", "attempt-refused")]
					: []
			const filtered = Option.flatMap(touch.entry, (name) =>
				filteredOf(actor.state.install.base, actor.role, name)
			)
			const outside = Arr.some(touch.stored, (s) => membershipOf(actor, touch, s) !== "inside")
			const policies = Option.match(filtered, {
				onNone: (): ReadonlyArray<WorldFeature> => [],
				onSome: (f) => {
					if (!held) {
						return []
					}
					switch (statement.kind) {
						case "insert":
							return observation.kind === "ok"
								? policy(f, "accepted-inside")
								: refusedPrivilege(observation)
									? policy(f, "refused-outside")
									: []
						case "insert-on-conflict": {
							const resolution = statement.onConflict
							const suppressed =
								resolution.kind !== "nothing" &&
								resolution.where.kind === "raise-on" &&
								refusedPrivilege(observation) &&
								raiseOnTable(actor, touch, resolution.where.field, resolution.where.value)
							return [
								...(observation.kind === "ok"
									? policy(f, "accepted-inside")
									: refusedPrivilege(observation)
										? policy(f, "refused-outside")
										: []),
								...(suppressed ? [objectFeature("policy", "conflict-raise-suppressed")] : [])
							]
						}
						case "update":
							return observation.kind === "ok"
								? policy(f, outside ? "hidden-row-absent" : "accepted-inside")
								: refusedPrivilege(observation)
									? policy(f, "refused-outside")
									: []
						case "delete":
						case "merge-delete":
							return observation.kind === "ok"
								? policy(f, outside ? "hidden-row-absent" : "accepted-inside")
								: []
						case "select-table": {
							const raised =
								statement.filter.kind === "raise-on" &&
								observation.kind === "rows" &&
								raiseOnTable(actor, touch, statement.filter.field, statement.filter.value)
							return [
								...(observation.kind === "rows" && outside ? policy(f, "hidden-row-absent") : []),
								...(raised ? policy(f, "raise-suppressed") : [])
							]
						}
						case "truncate":
						case "setval":
							return []
					}
				}
			})
			return [...grant, ...policies]
		}
	}
}

/**
 * The probe a write's precheck meets a law of a relation through: a key's or a span key's, the entry's key probe; none
 * for any other law.
 */
const probeKindOf = (state: ModelState, law: string, relation: string): "key-probe" | undefined =>
	Arr.some(
		state.host.laws,
		(l) => l.law === law && (l.kind === "key" || l.kind === "spanKey") && l.relation === relation
	)
		? "key-probe"
		: undefined

/** What an apply shows of the world's objects: policies accepting and refusing, and key probes refusing. */
const applyObjects = (
	actor: RoleActor,
	action: Extract<Action, { readonly kind: "apply" }>,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	const base = actor.state.install.base
	const perOp = (op: EntryOp): ReadonlyArray<WorldFeature> => {
		const filtered = filteredOf(base, actor.role, op.relation)
		/** Whether the op met a stored fact outside the entry it writes, asked only by the outcomes it shows on. */
		const outside = (): boolean => {
			const touch = opTouch(actor, op)
			return Arr.some(touch.stored, (s) => membershipOf(actor, touch, s) !== "inside")
		}
		const classified = Option.map(entryIn(actor.role, op.relation), (entry) =>
			classifyEntry(base, entry)
		)
		switch (observation.kind) {
			case "applied":
				return Option.match(filtered, {
					onNone: () => [],
					onSome: (f) =>
						op.kind === "delete"
							? outside()
								? policy(f, "hidden-row-absent")
								: []
							: observation.outcome === "accepted"
								? policy(f, "accepted-inside")
								: []
				})
			case "outside-world":
				return observation.relation === op.relation
					? Option.match(filtered, {
							onNone: () => [],
							onSome: (f) => policy(f, "refused-outside")
						})
					: []
			case "invariant-rejected": {
				const probe =
					Option.isSome(filtered) && op.kind !== "delete" && outside()
						? Option.flatMap(classified, (c) =>
								c.kind === "writable"
									? Option.fromUndefinedOr(probeKindOf(actor.state, observation.law, c.target))
									: Option.none()
							)
						: Option.none()
				return Option.isSome(probe)
					? [
							objectFeature(probe.value, "refused-outside"),
							...(observation.witness.kind === "shown"
								? [objectFeature(probe.value, "witness-shown")]
								: [])
						]
					: []
			}
			case "opened":
			case "open-refused":
			case "rows":
			case "law-refused":
			case "encoding-refused":
			case "artifacts-disagree":
			case "compile-refused":
			case "resource-bound":
			case "transient":
			case "commit-unknown":
			case "interrupted":
			case "refused":
			case "migration-refused":
			case "handle-refused":
			case "stale-snapshot":
			case "ok":
			case "drift":
			case "leak":
				return []
		}
	}
	return Arr.flatMap(opsOf(action), perOp)
}

const objectsOf = (
	state: ModelState,
	action: Action,
	actor: Actor,
	touch: Touch,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	switch (action.kind) {
		case "open-db":
			return action.role.kind !== "own" && observation.kind === "open-refused"
				? [objectFeature("membership", "attempt-refused")]
				: []
		case "read":
			return actor.kind === "role" ? readObjects(actor, touch, action.relation, observation) : []
		case "apply":
			return actor.kind === "role" ? applyObjects(actor, action, observation) : []
		case "direct":
			return statementObjects(state, actor, touch, action.statement, observation)
		case "direct-end":
		case "refresh":
		case "close":
		case "direct-begin":
		case "interrupt":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return []
	}
}

/** The invariants a direct statement makes non-vacuous: login isolation when it takes on a role, deleted facts after a delete. */
const statementInvariants = (
	statement: DirectStatement,
	hidden: ReadonlyArray<InvariantName>
): ReadonlyArray<InvariantName> => {
	switch (statement.kind) {
		case "set-role":
		case "set-session-authorization":
			return ["login-isolation"]
		case "delete":
		case "merge-delete":
		case "truncate":
			return [...hidden, "deleted-means-gone"]
		case "reset-role":
		case "set-claims":
		case "select-view":
		case "select-table":
		case "insert":
		case "insert-on-conflict":
		case "update":
		case "call":
		case "setval":
		case "prepare":
		case "execute-prepared":
			return hidden
	}
}

/**
 * The invariants an action makes non-vacuous, so a run that drives it checks them on something: the laws after a
 * write or a commit; hidden values whenever the action met a fact outside its world; claims and role after a Db's
 * transaction and a direct writer's end; login isolation when a Db opens or a writer takes on a role; deleted facts
 * after a delete; least privilege when the catalog changes or a Db's open check reads it.
 */
const invariantsOf = (
	action: Action,
	actor: Actor,
	membership: Membership
): ReadonlyArray<InvariantName> => {
	const hidden: ReadonlyArray<InvariantName> = membership === "inside" ? [] : ["no-hidden-value"]
	const transaction: ReadonlyArray<InvariantName> =
		actor.kind === "role" ? ["claims-end-with-transaction", "role-ends-with-transaction"] : []
	switch (action.kind) {
		case "open-db":
			return ["login-isolation", "least-privilege"]
		case "read":
		case "refresh":
			return [...hidden, ...transaction]
		case "apply":
			return [
				"laws-hold",
				...hidden,
				...transaction,
				...(Arr.some(opsOf(action), (op) => op.kind === "delete")
					? ["deleted-means-gone" as const]
					: [])
			]
		case "direct":
			return statementInvariants(action.statement, hidden)
		case "direct-end":
			return action.end === "commit"
				? ["laws-hold", "claims-end-with-transaction", "role-ends-with-transaction"]
				: ["claims-end-with-transaction", "role-ends-with-transaction"]
		case "migrate":
		case "tamper":
		case "drift":
			return ["least-privilege", ...(action.kind === "migrate" ? ["laws-hold" as const] : [])]
		case "close":
		case "direct-begin":
		case "interrupt":
		case "wild":
			return []
	}
}

/** A derived relation's facts as of its last refresh that a refresh now drops: those computed from facts since deleted. */
export const staleDerived = (state: ModelState, relation: string): ReadonlyArray<HostFact> =>
	Option.match(
		Arr.findFirst(state.install.base.derived, (d) => d.name === relation),
		{
			onNone: () => [],
			onSome: (d) => {
				const fresh = factKeySet(
					evaluateRules(state.install.base, d.rules, state.reality, state.derived, {})
				)
				return Arr.filter(
					Option.getOrElse(Record.get(state.derived, relation), () => []),
					(f) => !fresh.has(factKey(f))
				)
			}
		}
	)

/** The stored facts of reality a direct writer's transaction deleted: no fact of its view sits at their primary key. */
export const deletedBy = (state: ModelState, session: DirectSessionState): ReadonlyArray<Stored> =>
	Arr.flatMap(state.install.base.relations, (r) =>
		Arr.flatMap(factsIn(state.reality, r.name), (fact): ReadonlyArray<Stored> => {
			const kept = Arr.some(factsIn(session.view, r.name), (v) =>
				Arr.every(r.key, (field) =>
					Option.match(Option.all([Record.get(fact, field), Record.get(v, field)]), {
						onNone: () => false,
						onSome: ([a, b]) => equalValues(a, b)
					})
				)
			)
			return kept ? [] : [{ relation: r.name, fact }]
		})
	)

/** The relations a read reads facts of, by the entry or the table it names. */
const readOf = (state: ModelState, action: Action, actor: RoleActor): ReadonlyArray<string> => {
	const ofEntry = (role: string, relation: string): ReadonlyArray<string> =>
		Option.match(roleEntry(state.install, role, relation), {
			onNone: () => [],
			onSome: (entry) => readRelations(state.install.base, entry)
		})
	if (action.kind === "read") {
		return ofEntry(actor.role.name, action.relation)
	}
	if (action.kind !== "direct") {
		return []
	}
	switch (action.statement.kind) {
		case "select-view":
			return ofEntry(action.statement.role, action.statement.relation)
		case "select-table":
			return [action.statement.relation]
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
		case "insert":
		case "insert-on-conflict":
		case "delete":
		case "merge-delete":
		case "update":
		case "truncate":
		case "call":
		case "setval":
		case "prepare":
		case "execute-prepared":
			return []
	}
}

/**
 * What a deletion shows: a delete the driver's stored check then finds gone from its base table (an accepted apply
 * that deleted a fact of its world, a direct writer's COMMIT of a transaction that deleted one); a read inside a
 * direct writer's transaction that no longer shows a fact the transaction deleted; a read of a derived relation not
 * yet refreshed that still shows a fact computed from a deleted one; and a refresh that drops such facts.
 */
const deletionsOf = (
	state: ModelState,
	action: Action,
	actor: Actor,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	switch (action.kind) {
		case "apply": {
			if (
				actor.kind !== "role" ||
				observation.kind !== "applied" ||
				observation.outcome !== "accepted"
			) {
				return []
			}
			const gone = Arr.some(opsOf(action), (op) => {
				const touch = opTouch(actor, op)
				return (
					op.kind === "delete" &&
					Arr.some(touch.stored, (s) => membershipOf(actor, touch, s) === "inside")
				)
			})
			return gone ? ["deletion:base-gone"] : []
		}
		case "direct-end": {
			const gone = Option.exists(
				directSession(state, action.session),
				(session) =>
					action.end === "commit" &&
					observation.kind === "ok" &&
					deletedBy(state, session).length > 0
			)
			return gone ? ["deletion:base-gone"] : []
		}
		case "refresh":
			return observation.kind === "ok" && staleDerived(state, action.relation).length > 0
				? ["deletion:derived-refreshed"]
				: []
		case "read":
		case "direct": {
			if (actor.kind !== "role" || observation.kind !== "rows") {
				return []
			}
			const relations = readOf(state, action, actor)
			const worldGone =
				action.kind === "direct" &&
				Option.exists(directSession(state, action.session), (session) => {
					const deleted = deletedBy(state, session)
					return (
						Arr.some(deleted, (s) => Arr.contains(relations, s.relation)) &&
						!Arr.some(observation.rows, (row) => Arr.some(deleted, (s) => sameFact(s.fact, row)))
					)
				})
			const kept = Arr.some(relations, (relation) => {
				const staleKeys = factKeySet(staleDerived(state, relation))
				return Arr.some(observation.rows, (row) => staleKeys.has(factKey(row)))
			})
			return [
				...(worldGone ? ["deletion:world-gone" as const] : []),
				...(kept ? ["deletion:derived-kept" as const] : [])
			]
		}
		case "open-db":
		case "close":
		case "direct-begin":
		case "interrupt":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return []
	}
}

/** The role of the open Db at a session, none for a session that is no open Db. */
const dbRoleAt = (state: ModelState, id: number): Option.Option<RoleSpec> =>
	Option.flatMap(dbSession(state, id), (session) => roleIn(state.install, session.role))

/**
 * The context fields a query entry's rules read, each by its context and field: a context term anywhere in a rule, and
 * a field a context match binds.
 */
const contextFieldsRead = (
	entry: EntrySpec
): ReadonlyArray<{ readonly context: string; readonly field: string }> => {
	if (entry.kind === "whole") {
		return []
	}
	const ofTerm = (
		term: Term
	): ReadonlyArray<{ readonly context: string; readonly field: string }> =>
		term.kind === "context" ? [{ context: term.context, field: term.field }] : []
	return Arr.flatMap(entry.rules, (rule) => [
		...Arr.flatMap([...rule.matches, ...Arr.flatten(rule.negations)], (o) => {
			const source = o.source
			return [
				...(source.kind === "context"
					? Arr.map(Record.keys(o.fields), (field) => ({ context: source.name, field }))
					: []),
				...Arr.flatMap(Record.values(o.fields), ofTerm)
			]
		}),
		...Arr.flatMap(rule.comparisons, (c) => [...ofTerm(c.left), ...ofTerm(c.right)]),
		...Arr.flatMap(Record.values(rule.head), ofTerm)
	])
}

/**
 * The key grizzle completes a page's order with (PageKey): a derived relation's, read whole; a key it proves of the
 * entry short of its heading (generate/reads.ts entryKey); or the heading itself.
 */
const pageKeyOf = (base: BaseSpec, entry: EntrySpec): PageKey =>
	entry.kind === "whole" && Arr.some(base.derived, (d) => d.name === entry.relation)
		? "derived-key"
		: entryKey(base, entry).length < headingOf(base, entry).length
			? "proven-key"
			: "heading-key"

/**
 * What a read that delivered rows shows of how it went: the key a page's order is completed by (pageKeyOf) and where
 * it started; an attachment that nested a row under another; a
 * recursive read that chained a pair past one step; a span read through the world; and each domain of a context
 * field the relation's rules read under a fact its Db holds, decoded from the token.
 */
const readsOf = (
	state: ModelState,
	action: Extract<Action, { readonly kind: "read" }>,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (observation.kind !== "rows") {
		return []
	}
	const base = state.install.base
	return Option.match(
		Option.all([dbSession(state, action.session), dbRoleAt(state, action.session)]),
		{
			onNone: () => [],
			onSome: ([session, role]): ReadonlyArray<WorldFeature> => {
				const entry = roleEntryOf(role, action.relation)
				if (entry === undefined) {
					return []
				}
				const rowsOf = (relation: string): ReadonlyArray<HostFact> =>
					roleEntryOf(role, relation) === undefined
						? []
						: entryRows(state, role.name, relation, session.facts)
				const via = action.via
				const path: ReadonlyArray<WorldFeature> =
					via.kind === "page"
						? [`page:${pageKeyOf(base, entry)}:${via.from}`]
						: via.kind === "attach"
							? Arr.some(rowsOf(action.relation), (row) =>
									Arr.some(rowsOf(via.relation), (child) =>
										sameValue(child[via.child], row[via.parent])
									)
								)
								? ["attach:nested"]
								: []
							: via.kind === "reach" &&
								  reachedPairs(rowsOf(action.relation), via.from, via.to).length >
										steppedPairs(rowsOf(action.relation), via.from, via.to).length
								? ["reach:chained"]
								: []
				const spans: ReadonlyArray<WorldFeature> = Arr.some(observation.rows, (row) =>
					Arr.some(Record.values(row), isSpan)
				)
					? ["read:span"]
					: []
				const claims = Arr.flatMap(contextFieldsRead(entry), ({ context, field }) =>
					Option.toArray(
						Option.flatMap(Option.fromUndefinedOr(session.facts[context]?.[field]), () =>
							Arr.findFirst(base.contexts, (c) => c.name === context).pipe(
								Option.flatMap((c) => Arr.findFirst(c.fields, (f) => f.name === field)),
								Option.flatMap((f) => claimFeature(f.domain))
							)
						)
					)
				)
				return [...path, ...spans, ...claims]
			}
		}
	)
}

/**
 * The SQLSTATE a direct writer's statement met reading a hand-set claim its field's type refuses (README "Direct SQL
 * access"), by the field's domain: each fault of the session's hand-set claims (model/session/direct.ts handSetFaults)
 * the statement's refusal is, a refinement's 23514 on its law domain's CHECK law where it has one; none for any other
 * action or answer.
 */
export const claimRefusalsOf = (
	state: ModelState,
	action: Action,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (
		action.kind !== "direct" ||
		(observation.kind !== "refused" && observation.kind !== "law-refused")
	) {
		return []
	}
	const session = state.sessions[action.session]
	if (
		session?.kind !== "direct" ||
		session.claims.kind !== "set" ||
		session.claims.setting.kind !== "malformed"
	) {
		return []
	}
	const statement = action.statement
	const entry =
		statement.kind === "select-view"
			? Option.getOrUndefined(
					Option.flatMap(
						Arr.findFirst(state.install.roles, (r) => r.name === statement.role),
						(role) => Option.fromUndefinedOr(role.entries[statement.relation])
					)
				)
			: undefined
	return Arr.flatMap(
		handSetFaults(state.names, session.claims.read, observation),
		(fault): ReadonlyArray<WorldFeature> => {
			const at = entry === undefined ? undefined : claimReadAt(entry, fault.context, fault.field)
			const refined = refinedOf(fault.domain)
			return [
				...claimRefusalFeature(fault.domain, fault.sqlstate),
				...(at === undefined || refined === undefined || fault.sqlstate !== "23514"
					? []
					: [`claim-refused-read:${refined}:${at}` as const])
			]
		}
	)
}

/** A refined claim's domain kind: a contract, a pattern's text or a roster's handle; none for an unrefined one. */
const refinedOf = (domain: FieldDomain): RefinedClaim | undefined =>
	domain.kind === "contract" || domain.kind === "text" || domain.kind === "handle"
		? domain.kind
		: undefined

/** The match a variable of a rule is first bound at: its source and the field it binds; none for an unbound one. */
const firstBinding = (
	rule: Rule,
	variable: string
): { readonly source: Rule["matches"][number]["source"]; readonly field: string } | undefined =>
	Option.getOrUndefined(
		Arr.head(
			Arr.flatMap(rule.matches, (o) =>
				Arr.flatMap(Record.toEntries(o.fields), ([field, term]) =>
					term.kind === "var" && term.name === variable ? [{ source: o.source, field }] : []
				)
			)
		)
	)

/**
 * Where a view's query entry reads a context field: `output` where a head field delivers the claim (a context term of
 * it, or a variable first bound at it); `filter` where a rule reads the context but delivers the field nowhere; none
 * where no rule reads the context, or the entry is whole.
 */
const claimReadAt = (entry: EntrySpec, context: string, field: string): ClaimReadAt | undefined => {
	if (entry.kind === "whole") {
		return undefined
	}
	const delivers = (rule: Rule): boolean =>
		Arr.some(Record.values(rule.head), (term) => {
			if (term.kind === "context") {
				return term.context === context && term.field === field
			}
			if (term.kind !== "var") {
				return false
			}
			const at = firstBinding(rule, term.name)
			return at?.source.kind === "context" && at.source.name === context && at.field === field
		})
	const reads = (rule: Rule): boolean =>
		Arr.some(
			[...rule.matches, ...rule.negations.flat()],
			(o) => o.source.kind === "context" && o.source.name === context
		)
	return Arr.some(entry.rules, delivers)
		? "output"
		: Arr.some(entry.rules, reads)
			? "filter"
			: undefined
}

/** A refused hand-set claim's feature, by its field's domain; none for a domain no context field takes. */
const claimRefusalFeature = (
	domain: FieldDomain,
	refusal: ClaimRefusal
): ReadonlyArray<WorldFeature> => {
	switch (domain.kind) {
		case "uuid":
		case "text":
		case "integer":
		case "boolean":
		case "handle":
		case "contract":
			return [`claim-refused:${domain.kind}:${refusal}`]
		case "serial":
		case "span":
			return []
	}
}

/** The feature of a context field's domain decoded from a token; none for a domain no context field takes. */
const claimFeature = (domain: FieldDomain): Option.Option<WorldFeature> => {
	switch (domain.kind) {
		case "uuid":
		case "text":
		case "integer":
		case "boolean":
		case "handle":
		case "contract":
			return Option.some<WorldFeature>(`claim:${domain.kind}`)
		case "serial":
		case "span":
			return Option.none()
	}
}

/**
 * How each read-back of a ChangeSet through a Db stood to the change (ReadBackClass, by the model's restatement of
 * README "Writes", session/apply.ts readBackClasses): of an applied ChangeSet, each read-back's class; of one refused
 * when it compiled for a read-back alone, an undetermined one.
 */
const readBacksOf = (
	state: ModelState,
	action: Extract<Action, { readonly kind: "apply" }>,
	observation: Observation
): ReadonlyArray<WorldFeature> =>
	Option.match(dbRoleAt(state, action.session), {
		onNone: () => [],
		onSome: (role): ReadonlyArray<WorldFeature> => {
			const base = state.install.base
			const classes = readBackClasses(base, role, action.strata, action.reads)
			if (observation.kind === "applied") {
				return Arr.map(classes, (c): WorldFeature => `readback:${c}`)
			}
			return observation.kind === "compile-refused" &&
				!compileRefused(base, role, action.strata, []) &&
				Arr.contains(classes, "undetermined")
				? ["readback:undetermined"]
				: []
		}
	})

/**
 * How a Db's read and write went: the read path a read took and what it showed (readsOf); how a ChangeSet's writes
 * were stratified (one write, a union of several in one stratum, a sequence of strata, or a stratum refused because a
 * query entry's membership would depend on the order of its writes); and how each read-back stood to the change
 * (readBacksOf).
 */
const pathsOf = (
	state: ModelState,
	action: Action,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	switch (action.kind) {
		case "read":
			return [`via:${action.via.kind}`, ...readsOf(state, action, observation)]
		case "apply": {
			const strata: WorldFeature =
				observation.kind === "compile-refused" &&
				Arr.some(action.strata, (stratum) => orderDependent(state, action.session, stratum))
					? "strata:refused-order"
					: action.strata.length > 1
						? "strata:sequence"
						: action.strata[0].length > 1
							? "strata:union"
							: "strata:one"
			return [
				strata,
				...readBacksOf(state, action, observation),
				...additionsOf(state, action),
				...(observation.kind === "applied" ? suppliedSerialsOf(state, action) : [])
			]
		}
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
			return []
	}
}

/**
 * The insertions a ChangeSet applies through a Db's role relations, each fact by its serial class and its relation's
 * generated class (AdditionFeature): generated when it leaves out every classed serial field of a classed relation,
 * complete otherwise; unit when the relation's every carried field is classed serial, so a generated fact carries none.
 */
export const additionsOf = (
	state: ModelState,
	action: Extract<Action, { readonly kind: "apply" }>
): ReadonlyArray<AdditionFeature> => {
	const base = state.install.base
	const role = Option.flatMap(Option.fromUndefinedOr(sessionAt(state, action.session)), (session) =>
		session.kind === "db" ? roleIn(state.install, session.role) : Option.none()
	)
	return Option.match(role, {
		onNone: () => [],
		onSome: (r) =>
			Arr.flatMap(action.strata.flat(), (op): ReadonlyArray<AdditionFeature> => {
				const written = writtenNamed(base, r, op.relation)
				if (op.kind !== "insert" || written === undefined) {
					return []
				}
				const { classed } = serialHead(base, written)
				const carried =
					written.kind === "whole"
						? Arr.map(relationSpecOf(base, written.target)?.fields ?? [], (f) => f.name)
						: Record.keys(written.head)
				const target = written.kind === "whole" ? "whole" : "entry"
				const unit = Arr.every(carried, (f) => classed.includes(f)) ? "unit" : "carried"
				return Arr.map(op.facts, (fact): AdditionFeature => {
					const generated = classed.length > 0 && Arr.every(classed, (f) => fact[f] === undefined)
					return `addition:${generated ? "generated" : "complete"}:${target}:${unit}`
				})
			})
	})
}

/**
 * The generated additions through a Db's query entries that supply a serial value, one the entry's filter reads or its
 * fill fixes, a stored value the driver holds to the model's (README "Writing through a role"): a fact leaving out every classed serial head field (writes.ts serialHead) of an
 * entry whose target holds a serial field no classed head field writes. Noted of an applied ChangeSet alone, whose
 * committed state the driver then holds to the model's, the supplied value stored.
 */
const suppliedSerialsOf = (
	state: ModelState,
	action: Extract<Action, { readonly kind: "apply" }>
): ReadonlyArray<WorldFeature> => {
	const base = state.install.base
	const role = Option.flatMap(Option.fromUndefinedOr(sessionAt(state, action.session)), (session) =>
		session.kind === "db" ? roleIn(state.install, session.role) : Option.none()
	)
	return Option.match(role, {
		onNone: () => [],
		onSome: (r) =>
			Arr.flatMap(action.strata.flat(), (op): ReadonlyArray<WorldFeature> => {
				const written = writtenNamed(base, r, op.relation)
				if (op.kind !== "insert" || written?.kind !== "query") {
					return []
				}
				const { classed } = serialHead(base, written)
				const drawn = new Set(
					Arr.flatMap(classed, (h) =>
						Option.toArray(
							Option.map(Option.fromUndefinedOr(written.head[h]), (head) => head.field)
						)
					)
				)
				const supplied = Arr.some(
					relationSpecOf(base, written.target)?.fields ?? [],
					(f) => f.domain.kind === "serial" && !drawn.has(f.name)
				)
				return supplied
					? Arr.flatMap(op.facts, (fact): ReadonlyArray<WorldFeature> =>
							Arr.every(classed, (h) => fact[h] === undefined)
								? ["addition:generated:entry:supplied-serial"]
								: []
						)
					: []
			})
	})
}

/** Whether a stratum writes a query entry and also a relation the entry's rule reads, so membership would depend on order. */
const orderDependent = (
	state: ModelState,
	id: number,
	stratum: ReadonlyArray<EntryOp>
): boolean => {
	const role = Option.flatMap(Option.fromUndefinedOr(sessionAt(state, id)), (session) =>
		session.kind === "db" ? roleIn(state.install, session.role) : Option.none()
	)
	return Option.exists(role, (r) => stratumOrderDependent(state.install.base, r, stratum))
}

/** Whether a stratum of one role's writes reads, through a query entry, a relation another of its writes targets. */
const stratumOrderDependent = (
	base: BaseSpec,
	role: RoleSpec,
	stratum: ReadonlyArray<EntryOp>
): boolean => {
	const targets = Arr.flatMap(stratum, (op) =>
		Arr.flatMap(Option.toArray(entryIn(role, op.relation)), (entry) =>
			Option.toArray(writableTarget(base, entry))
		)
	)
	return Arr.some(stratum, (op) =>
		Option.exists(
			entryIn(role, op.relation),
			(entry) =>
				entry.kind === "query" &&
				Arr.some(Arr.flatMap(entry.rules, ruleRelations), (read) =>
					Arr.some(
						targets,
						(t) => t === read && Option.exists(writableTarget(base, entry), (own) => own !== read)
					)
				)
		)
	)
}

const writableTarget = (base: BaseSpec, entry: EntrySpec): Option.Option<string> => {
	const classified = classifyEntry(base, entry)
	return classified.kind === "writable" ? Option.some(classified.target) : Option.none()
}

/**
 * The transaction outcome an observation ends a Db's transaction with, as the next probe of its connection follows it.
 * A serial program never ends one transient, which its driver runs again (drive/index.ts answered), nor interrupted,
 * since it interrupts no call in flight: those are the race suites' (test/schedules/worlds/pooled-roles.test.ts).
 */
const endedWith = (observation: Observation): Option.Option<WorldFeature> => {
	switch (observation.kind) {
		case "rows":
		case "ok":
			return Option.some("connection:after-commit")
		case "applied":
			return Option.some(
				observation.outcome === "accepted"
					? "connection:after-commit"
					: "connection:after-no-change"
			)
		case "invariant-rejected":
			return Option.some("connection:after-invariant-rejected")
		case "outside-world":
			return Option.some("connection:after-outside-world")
		case "compile-refused":
			return Option.some("connection:after-compile-refused")
		case "stale-snapshot":
			return Option.some("connection:after-stale-snapshot")
		case "transient":
		case "interrupted":
		case "opened":
		case "open-refused":
		case "law-refused":
		case "encoding-refused":
		case "artifacts-disagree":
		case "resource-bound":
		case "commit-unknown":
		case "refused":
		case "migration-refused":
		case "handle-refused":
		case "drift":
		case "leak":
			return Option.none()
	}
}

/**
 * What a pooled connection shows: a Db's transaction ending with an outcome just before the driver probes its
 * connection, and a connection serving two roles of one login, when another open Db of another role holds the
 * connection the acting Db runs on.
 */
const connectionsOf = (
	state: ModelState,
	action: Action,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (
		action.kind !== "read" &&
		action.kind !== "apply" &&
		action.kind !== "refresh" &&
		action.kind !== "interrupt"
	) {
		return []
	}
	return Option.match(dbSession(state, action.session), {
		onNone: () => [],
		onSome: (session): ReadonlyArray<WorldFeature> => {
			const shared = Arr.some(
				state.sessions,
				(other) =>
					other.kind === "db" &&
					other.login === session.login &&
					other.role !== session.role &&
					other.connection === session.connection
			)
			return [
				...Option.toArray(endedWith(observation)),
				...(shared ? ["connection:shared-by-roles" as const] : [])
			]
		}
	})
}

/** The law family a declared law states (README "Rules"). */
const familyOfSpec = (law: LawSpec): LawFamily => {
	switch (law.kind) {
		case "key":
			return "key"
		case "spanKey":
			return "span-key"
		case "check":
			return "check"
		case "contained":
			return "contained"
		case "covered":
			return "covered"
		case "alternatives":
			return "alternatives"
	}
}

/** Whether a declared law's identities hold `law`: its one, or one of an alternatives law's arms and reverses. */
const holdsLaw = (ids: LawIds, law: string): boolean =>
	ids.kind === "alternatives"
		? Arr.some([...Record.values(ids.arms), ...Record.values(ids.reverse)], (id) => id === law)
		: ids.law === law

/** Whether a relation's primary key holds a span: a key WITHOUT OVERLAPS. */
const spanKeyed = (relation: RelationSpec): boolean =>
	Arr.some(relation.fields, (f) => relation.key.includes(f.name) && f.domain.kind === "span")

/**
 * The family of the law of an identity the installation names (LawFamily): a relation's primary key, a key or a span
 * key; a contract's or a pattern's domain CHECK, a field's own pattern law among them; or a declared law's family.
 */
const lawFamilyOf = (state: ModelState, law: string): Option.Option<LawFamily> => {
	const base = state.install.base
	const primary = Arr.findFirst(Record.toEntries(state.names.primaryKeys), ([, id]) => id === law)
	if (Option.isSome(primary)) {
		const [relation] = primary.value
		return Option.some(
			Option.exists(Option.fromUndefinedOr(relationSpecOf(base, relation)), spanKeyed)
				? "span-key"
				: "key"
		)
	}
	if (
		Arr.some(Record.values(state.names.domains), (id) => id === law) ||
		Arr.some(Record.values(state.names.patterns), (fields) =>
			Arr.some(Record.values(fields), (id) => id === law)
		)
	) {
		return Option.some("domain")
	}
	return Option.map(
		Arr.findFirst(Arr.zip(base.laws, state.names.laws), ([, ids]) => holdsLaw(ids, law)),
		([spec]) => familyOfSpec(spec)
	)
}

/**
 * The law a refused write met, by its family, the path it took (LawPath: a Db's ChangeSet through a query entry or
 * through whole entries alone, or a direct writer's statement as the role it took on) and what its witness showed,
 * which the model's restatement of README "Errors and outcomes" holds the real witness to.
 */
const lawsOf = (
	state: ModelState,
	action: Action,
	actor: Actor,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (
		(observation.kind !== "invariant-rejected" && observation.kind !== "law-refused") ||
		actor.kind !== "role"
	) {
		return []
	}
	const base = state.install.base
	const path: Option.Option<LawPath> =
		action.kind === "apply"
			? Option.some(
					Arr.some(
						opsOf(action),
						(op) => writtenNamed(base, actor.role, op.relation)?.kind === "query"
					)
						? "entry"
						: "whole"
				)
			: action.kind === "direct" || action.kind === "direct-end"
				? Option.some("direct")
				: Option.none()
	return Option.toArray(
		Option.map(
			Option.all([lawFamilyOf(state, observation.law), path]),
			([family, through]): WorldFeature => `law:${family}:${through}:${observation.witness.kind}`
		)
	)
}

/**
 * A row check refused with a shown witness where a fact the ChangeSet states through a whole entry leaves out a field of
 * the check's relation's primary key, an identity the database draws: the witness names that fact by another declared
 * key (README "Errors and outcomes").
 */
const declaredKeysOf = (
	state: ModelState,
	action: Action,
	actor: Actor,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (
		action.kind !== "apply" ||
		actor.kind !== "role" ||
		observation.kind !== "invariant-rejected" ||
		observation.witness.kind !== "shown"
	) {
		return []
	}
	const base = state.install.base
	const law = Option.getOrUndefined(
		Arr.findFirst(state.host.laws, (l) => l.law === observation.law)
	)
	if (law?.kind !== "check") {
		return []
	}
	const primary = Option.match(Option.fromUndefinedOr(relationSpecOf(base, law.relation)), {
		onNone: (): ReadonlyArray<string> => [],
		onSome: (spec) => spec.key
	})
	const leavesOut = Arr.some(
		opsOf(action),
		(op) =>
			op.kind !== "delete" &&
			writtenNamed(base, actor.role, op.relation)?.kind === "whole" &&
			writtenNamed(base, actor.role, op.relation)?.target === law.relation &&
			Arr.some(op.facts, (fact) => Arr.some(primary, (field) => fact[field] === undefined))
	)
	return leavesOut ? ["law:check:declared-key"] : []
}

/**
 * The shapes of relation an accepted ChangeSet through a Db wrote (WriteShape), each op by its relation's mutability,
 * the path it took (a query entry or a whole one) and its kind: a relation keyed WITHOUT OVERLAPS, and a pure set.
 */
const writesOf = (
	state: ModelState,
	action: Action,
	actor: Actor,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (
		action.kind !== "apply" ||
		actor.kind !== "role" ||
		observation.kind !== "applied" ||
		observation.outcome !== "accepted"
	) {
		return []
	}
	const base = state.install.base
	return Arr.flatMap(opsOf(action), (op): ReadonlyArray<WorldFeature> => {
		const written = writtenNamed(base, actor.role, op.relation)
		const relation = written === undefined ? undefined : relationSpecOf(base, written.target)
		if (written === undefined || relation === undefined || op.facts.length === 0) {
			return []
		}
		const shapes: ReadonlyArray<WriteShape> = [
			...(spanKeyed(relation) ? (["span-key"] as const) : []),
			...(Arr.every(relation.fields, (f) => relation.key.includes(f.name))
				? (["pure-set"] as const)
				: [])
		]
		const path = written.kind === "query" ? "entry" : "whole"
		return Arr.map(
			shapes,
			(shape): WorldFeature => `write:${shape}:${relation.mutability}:${path}:${op.kind}`
		)
	})
}

/**
 * The features of one action in the state it ran in, with what was observed:
 * - `op:`: the action's kind, the membership of what it touched, the claims it ran under, who wrote, and the
 *   observation's kind. Membership is the least visible of the stored facts it read or met (a read: the facts behind
 *   the entry; a write: the stored facts at the keys it submits, or colliding with it at a unique index; a direct
 *   statement on a table: the table's facts or those at its key), judged for the acting role by the host model: inside
 *   the entry it goes through, visible through another of its entries, or hidden. A login sees nothing; an action that
 *   meets no fact is inside.
 * - `object:`: what the observation demonstrates of a world object: a barrier view hiding a row or suppressing a raise
 *   on one, a policy (and its filter function) accepting an inside fact, refusing an outside one or hiding a row from a
 *   write, a key probe refusing a hidden key and showing the submitted witness, a function, view, grant, revoke or
 *   membership refusing an attempt, or accepting its holder.
 * - `invalid:`: every invalid input the action draws (generate's invalidKindsOf).
 * - `invariant:`: every invariant the action makes non-vacuous (invariantsOf).
 * - `deletion:` and `connection:`: what a deletion and a pooled connection show (deletionsOf, connectionsOf).
 * - `via:`, `page:`, `attach:`, `reach:`, `read:`, `claim:`, `readback:`, `strata:` and `addition:`: how a Db's read
 *   or write went (pathsOf).
 * - `law:` and `write:`: the law family a refused write met with its path and witness (lawsOf), and the shapes of
 *   relation an accepted write changed (writesOf).
 * A Defect (a leak, artifacts that disagree) is no feature: the run fails on it.
 */
export const featuresOf = (
	state: ModelState,
	action: Action,
	observation: Observation
): ReadonlyArray<WorldFeature> => {
	if (observation.kind === "leak" || observation.kind === "artifacts-disagree") {
		return []
	}
	const actor = actorOf(state, action)
	const touch = actor.kind === "role" ? touchOf(actor, action) : untouched
	const membership = actionMembership(
		actor,
		actor.kind === "login" ? loginTouch(state, action) : touch
	)
	const op: WorldFeature = `op:${action.kind}:${membership}:${claimStateOf(action, actor, touch)}:${writerOf(actor)}:${observation.kind}`
	return Arr.dedupe([
		op,
		...objectsOf(state, action, actor, touch, observation),
		...Arr.map(invalidKindsOf(state, action), (kind): WorldFeature => `invalid:${kind}`),
		...Arr.map(
			invariantsOf(action, actor, membership),
			(name): WorldFeature => `invariant:${name}`
		),
		...deletionsOf(state, action, actor, observation),
		...connectionsOf(state, action, observation),
		...pathsOf(state, action, observation),
		...lawsOf(state, action, actor, observation),
		...declaredKeysOf(state, action, actor, observation),
		...writesOf(state, action, actor, observation),
		...claimRefusalsOf(state, action, observation),
		...(action.kind === "migrate"
			? [`migration:${migrationKindOf(state, action.to)}:${observation.kind}` as const]
			: [])
	])
}

/**
 * What a migration to `to` changes against the installation its folder is drafted from, the first that applies: a
 * roster declared out of its codes' order (D1), a roster losing a handle, a roster grown by one, a law added, or the
 * installation otherwise. With the verdict it met, the (migration kind, verdict) feature.
 */
const migrationKindOf = (state: ModelState, to: InstallSpec): MigrationKind => {
	const from = draftedFrom(state).base
	if (reorderedRoster(from, to.base) !== undefined) {
		return "roster-reorder"
	}
	const membersOf = (name: string): ReadonlyArray<string> =>
		Option.match(
			Arr.findFirst(from.closed, (c) => c.name === name),
			{ onNone: () => [], onSome: (c) => c.members }
		)
	if (Arr.some(to.base.closed, (c) => Arr.some(membersOf(c.name), (m) => !c.members.includes(m)))) {
		return "roster-removal"
	}
	if (
		Arr.some(to.base.closed, (c) => {
			const before = membersOf(c.name)
			return before.length > 0 && Arr.some(c.members, (m) => !before.includes(m))
		})
	) {
		return "roster-growth"
	}
	return to.base.laws.length > from.laws.length ? "law-added" : "install"
}

/** What a login's direct statement meets: the facts of a table it reads or writes, or at a key, in its transaction view. */
const loginTouch = (state: ModelState, action: Action): Touch => {
	if (action.kind !== "direct") {
		return untouched
	}
	const view = Option.match(directSession(state, action.session), {
		onNone: () => state,
		onSome: (session) => seenThrough(state, session.view)
	})
	const statement = action.statement
	switch (statement.kind) {
		case "select-table":
		case "truncate":
			return { entry: Option.none(), stored: storedFacts(view, statement.relation), submitted: [] }
		case "insert":
		case "insert-on-conflict":
			return {
				entry: Option.none(),
				stored: metBy(view, statement.relation, statement.fact),
				submitted: []
			}
		case "delete":
		case "update":
			return {
				entry: Option.none(),
				stored: metBy(view, statement.relation, statement.key),
				submitted: []
			}
		case "merge-delete":
			return {
				entry: Option.none(),
				stored: metByEach(view, statement.relation, statement.keys),
				submitted: []
			}
		case "select-view": {
			return {
				entry: Option.none(),
				stored: Option.match(roleEntry(view.install, statement.role, statement.relation), {
					onNone: () => [],
					onSome: (entry) =>
						Arr.flatMap(readRelations(view.install.base, entry), (r) => storedFacts(view, r))
				}),
				submitted: []
			}
		}
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
		case "call":
		case "setval":
		case "prepare":
		case "execute-prepared":
			return untouched
	}
}

/** A block of required op features: every combination of its dimensions. */
interface OpBlock {
	readonly kind: ActionKind
	readonly writers: Arr.NonEmptyReadonlyArray<Writer>
	readonly memberships: Arr.NonEmptyReadonlyArray<Membership>
	readonly claims: Arr.NonEmptyReadonlyArray<ClaimState>
	readonly observations: Arr.NonEmptyReadonlyArray<ActionOutcome["kind"]>
}

const block = (
	kind: ActionKind,
	writers: Arr.NonEmptyReadonlyArray<Writer>,
	memberships: Arr.NonEmptyReadonlyArray<Membership>,
	claims: Arr.NonEmptyReadonlyArray<ClaimState>,
	observations: Arr.NonEmptyReadonlyArray<ActionOutcome["kind"]>
): OpBlock => ({ kind, writers, memberships, claims, observations })

const allMemberships: Arr.NonEmptyReadonlyArray<Membership> = [
	"inside",
	"outside-visible",
	"hidden"
]
const seen: Arr.NonEmptyReadonlyArray<Membership> = ["outside-visible", "hidden"]

/** A call naming a closed session, or one of the other kind: refused as a stale handle, touching nothing. */
const staleHandle = (kind: ActionKind, writers: Arr.NonEmptyReadonlyArray<Writer>): OpBlock =>
	block(kind, writers, ["inside"], ["absent"], ["handle-refused"])

/**
 * The op features of the worlds feature map: each combination below is one the README allows and a run over the
 * documents or the education base meets. What is left out, and why:
 * - an action that meets no stored fact (open-db, refresh, close, direct-begin, direct-end, interrupt, migrate,
 *   tamper, drift, wild) is inside by definition, and the owner's actions and a BEGIN run under no claims;
 * - a read submits nothing, so its claims never disagree with a fact, and a Db's claims are never malformed (verify
 *   decodes them or Db.open refuses the token);
 * - a stale token decodes, so its Db opens: Db.open contacts nothing, so nothing refuses an open past its token, and
 *   not-matching claims are required opened only;
 * - a login reads no row (it holds only USAGE on its schema and SELECT on the ledger), so it never observes rows, and
 *   a fact it meets is hidden from it;
 * - an insert whose claimed field disagrees with the claims is outside-world (a Db) or refused by the policy (a direct
 *   writer) before any key is compared, so not-matching claims are required inside only;
 * - outcomes decided before a fact is read (compile-refused) and races (transient, commit-unknown) are required through
 *   their invalid kinds and the race suites, not here; resource-bound, a statement's Bind message past PostgreSQL's
 *   message limit, is past any input a world sends; a leak is a mismatch, never an outcome;
 * - a wild value handed to a Db call is the wrong kind of host value, refused before the encoder (compile-refused on
 *   an open session, handle-refused on a closed one, open-refused at Db.open), so it never meets the encoder:
 *   encoding-refused is required of an apply, whose right-kind value the encoder refuses (past an integer type's
 *   range);
 * - a serial driver's interrupt of a Db finds no call in flight, so it answers `ok`; a call interrupted mid-flight is
 *   the race suites' (test/schedules/worlds/pooled-roles.test.ts requires `ended: interruption` and the probe after
 *   it);
 * - `grizzle drift` answers `drift` whether or not the catalog departs from the contract (a clean catalog is a drift
 *   naming no object), so `ok` is no outcome of a drift.
 */
const requiredOps: ReadonlyArray<OpBlock> = [
	block("open-db", ["db"], ["inside"], ["absent", "matching", "not-matching"], ["opened"]),
	block("open-db", ["db"], ["inside"], ["absent", "matching", "malformed"], ["open-refused"]),
	block("read", ["db"], allMemberships, ["absent", "matching"], ["rows"]),
	staleHandle("read", ["db", "direct-role", "direct-login"]),
	block("apply", ["db"], allMemberships, ["absent", "matching"], ["applied", "invariant-rejected"]),
	block("apply", ["db"], ["inside"], ["not-matching"], ["applied", "outside-world"]),
	block("apply", ["db"], ["inside"], ["absent"], ["outside-world"]),
	block("apply", ["db"], ["inside"], ["absent", "matching"], ["encoding-refused"]),
	staleHandle("apply", ["db", "direct-role", "direct-login"]),
	block("refresh", ["db"], ["inside"], ["absent", "matching"], ["ok"]),
	staleHandle("refresh", ["db"]),
	block("close", ["db"], ["inside"], ["absent", "matching"], ["ok"]),
	block("direct-begin", ["direct-login"], ["inside"], ["absent"], ["opened"]),
	block(
		"direct",
		["direct-role"],
		["inside"],
		["absent", "matching", "malformed"],
		["ok", "rows", "refused"]
	),
	block("direct", ["direct-role"], seen, ["absent", "matching"], ["ok", "rows", "refused"]),
	block("direct", ["direct-role"], ["inside"], ["not-matching"], ["refused"]),
	block("direct", ["direct-role"], allMemberships, ["absent", "matching"], ["law-refused"]),
	block(
		"direct",
		["direct-login"],
		["inside"],
		["absent", "matching", "malformed"],
		["ok", "refused"]
	),
	block("direct", ["direct-login"], ["hidden"], ["absent"], ["refused"]),
	staleHandle("direct", ["db"]),
	block("direct-end", ["direct-role"], ["inside"], ["absent", "matching"], ["ok", "law-refused"]),
	block("direct-end", ["direct-login"], ["inside"], ["absent"], ["ok"]),
	staleHandle("direct-end", ["db"]),
	block("interrupt", ["db"], ["inside"], ["absent", "matching"], ["ok"]),
	block("migrate", ["direct-login"], ["inside"], ["absent"], ["ok", "migration-refused"]),
	block("tamper", ["direct-login"], ["inside"], ["absent"], ["ok"]),
	block("drift", ["direct-login"], ["inside"], ["absent"], ["drift"]),
	block("wild", ["db"], ["inside"], ["absent", "malformed"], ["open-refused"])
]

const blockFeatures = (b: OpBlock): ReadonlyArray<WorldFeature> =>
	Arr.flatMap(b.writers, (writer) =>
		Arr.flatMap(b.memberships, (membership) =>
			Arr.flatMap(b.claims, (claim) =>
				Arr.map(
					b.observations,
					(observation): WorldFeature =>
						`op:${b.kind}:${membership}:${claim}:${writer}:${observation}`
				)
			)
		)
	)

/**
 * Every object outcome a world object can show. Left out: a whole entry's plain view hides no row and so suppresses no
 * raise; no view, policy or function but a key probe carries a witness, and a key probe's is always the key the caller
 * submitted (shown); a policy is met by a write, never attempted on its own; and a revoke is never accepted, since
 * PUBLIC holds nothing.
 */
const objectOutcomes: ReadonlyArray<WorldFeature> = [
	objectFeature("view", "accepted-inside"),
	objectFeature("view", "attempt-refused"),
	objectFeature("barrier-view", "accepted-inside"),
	objectFeature("barrier-view", "hidden-row-absent"),
	objectFeature("barrier-view", "raise-suppressed"),
	objectFeature("barrier-view", "attempt-refused"),
	objectFeature("policy", "accepted-inside"),
	objectFeature("policy", "refused-outside"),
	objectFeature("policy", "hidden-row-absent"),
	objectFeature("policy", "raise-suppressed"),
	objectFeature("policy", "conflict-raise-suppressed"),
	objectFeature("filter-function", "accepted-inside"),
	objectFeature("filter-function", "refused-outside"),
	objectFeature("filter-function", "hidden-row-absent"),
	objectFeature("filter-function", "attempt-refused"),
	objectFeature("key-probe", "accepted-inside"),
	objectFeature("key-probe", "refused-outside"),
	objectFeature("key-probe", "witness-shown"),
	objectFeature("key-probe", "attempt-refused"),
	objectFeature("advance-function", "accepted-inside"),
	objectFeature("advance-function", "attempt-refused"),
	objectFeature("grant", "accepted-inside"),
	objectFeature("grant", "attempt-refused"),
	objectFeature("revoke", "attempt-refused"),
	objectFeature("membership", "accepted-inside"),
	objectFeature("membership", "attempt-refused")
]

/**
 * The situations of the worlds feature map. A pooled connection after an interrupted call is no situation here: a
 * serial driver never has a call in flight to interrupt, and the model answers an interrupt of an idle Db `ok`. The
 * concurrent race driver interrupts a call mid-flight and probes the connection after it
 * (test/schedules/worlds/pooled-roles.test.ts, `probed after: interruption`).
 */
const situations: ReadonlyArray<WorldFeature> = [
	"via:execute",
	"via:get",
	"via:page",
	"via:compile",
	"via:attach",
	"via:reach",
	"page:proven-key:first",
	"page:proven-key:last",
	"page:derived-key:first",
	"page:derived-key:last",
	"page:heading-key:first",
	"page:heading-key:last",
	"attach:nested",
	"strata:one",
	"strata:union",
	"strata:sequence",
	"strata:refused-order",
	"readback:untouched",
	"readback:written",
	"readback:beside",
	"readback:undetermined",
	"addition:complete:whole:carried",
	"addition:complete:whole:unit",
	"addition:complete:entry:carried",
	"addition:complete:entry:unit",
	"addition:generated:whole:carried",
	"addition:generated:whole:unit",
	"addition:generated:entry:supplied-serial",
	"addition:generated:entry:carried",
	"addition:generated:entry:unit",
	"deletion:base-gone",
	"deletion:world-gone",
	"deletion:derived-kept",
	"deletion:derived-refreshed",
	"connection:shared-by-roles",
	"connection:after-commit",
	"connection:after-no-change",
	"connection:after-invariant-rejected",
	"connection:after-outside-world",
	"connection:after-compile-refused",
	"connection:after-stale-snapshot"
]

const invariantNames: Arr.NonEmptyReadonlyArray<InvariantName> = [
	"laws-hold",
	"no-hidden-value",
	"claims-end-with-transaction",
	"role-ends-with-transaction",
	"login-isolation",
	"deleted-means-gone",
	"least-privilege"
]

/**
 * The worlds feature map, from which each aimed suite requires its area's features (drive/suite.ts requiredWhere): the
 * op features of requiredOps, every object outcome a world object can show, every invalid kind of the vocabulary
 * (invalid/kinds.ts lists them all), every invariant, and every deletion and pooled-connection situation.
 */
export const requiredWorldFeatures: Situations<WorldFeature> = Arr.dedupe(
	Arr.appendAll(
		[
			...situations,
			...Arr.flatMap(requiredOps, blockFeatures),
			...objectOutcomes,
			...Arr.map(invalidKinds, (kind): WorldFeature => `invalid:${kind}`)
		],
		Arr.map(invariantNames, (name): WorldFeature => `invariant:${name}`)
	)
)
