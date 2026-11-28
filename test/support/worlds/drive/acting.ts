import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Record as Rec } from "effect"
import { valueText } from "#test/support/laws/model.ts"
import { submittedTexts } from "#test/support/worlds/drive/index.ts"
import type { Checked, SeenAction, StepCheck } from "#test/support/worlds/drive/suite.ts"
import { loginOf, roleOf, sessionAt } from "#test/support/worlds/model/session/state.ts"
import type {
	Action,
	DirectStatement,
	HostFact,
	ModelState,
	RoleSpec
} from "#test/support/worlds/model/types.ts"

/**
 * Who acts, and two rules of the README the suites hold directly beside the worlds model, over every action they
 * perform: a security rule stated plainly, so a defect the model and grizzle share still fails the suite.
 */

/** The session an action acts through, when it names one. */
export const sessionOf = (action: Action): Option.Option<number> => {
	switch (action.kind) {
		case "read":
		case "apply":
		case "close":
		case "direct":
		case "direct-end":
		case "interrupt":
			return Option.some(action.session)
		case "wild":
			return action.at.kind === "session" ? Option.some(action.at.session) : Option.none()
		case "open-db":
		case "direct-begin":
		case "migrate":
		case "tamper":
		case "drift":
			return Option.none()
	}
}

/** The role a session acts as: a Db's role, a direct writer's current role; none for a login, a closed session or none. */
const sessionRole = (state: ModelState, session: number): Option.Option<RoleSpec> => {
	const held = sessionAt(state, session)
	if (held === undefined) {
		return Option.none()
	}
	switch (held.kind) {
		case "db":
			return Option.fromUndefinedOr(roleOf(state.install, held.role))
		case "direct":
			return held.current.kind === "role"
				? Option.fromUndefinedOr(roleOf(state.install, held.current.role))
				: Option.none()
		case "closed":
			return Option.none()
	}
}

const factTexts = (fact: HostFact): ReadonlyArray<string> => Arr.map(Rec.values(fact), valueText)

/** The facts of a relation in a state: a base relation's stored facts, none of a closed one. */
const factsOf = (state: ModelState, relation: string): ReadonlyArray<HostFact> =>
	state.reality.get(relation) ?? []

/** Every value, as text, of the facts a role holds whole in a state: its whole entries over base relations. */
const wholeHeldTexts = (state: ModelState, role: RoleSpec): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(Rec.values(role.entries), (entry) =>
			entry.kind === "whole" ? Arr.flatMap(factsOf(state, entry.relation), factTexts) : []
		)
	)

/** Every value, as text, of the facts a session's claims hold: a Db's context facts, a direct writer's set claims. */
const claimsTexts = (state: ModelState, session: number): ReadonlyArray<string> => {
	const held = sessionAt(state, session)
	if (held === undefined) {
		return []
	}
	switch (held.kind) {
		case "db":
			return Arr.flatMap(Rec.values(held.facts), factTexts)
		case "direct":
			return held.claims.kind === "set" && held.claims.setting.kind === "facts"
				? Arr.flatMap(Rec.values(held.claims.setting.facts), factTexts)
				: []
		case "closed":
			return []
	}
}

/**
 * Every value, as text, an action and its transaction handed the real system: the action's own, for a direct writer
 * every earlier statement of its transaction (a direct session is one transaction, so every earlier action on it), and
 * the session's claims, which an insert through a query entry fills from.
 */
const submittedBy = ({ seen, earlier }: Checked): ReadonlySet<string> => {
	const session = sessionOf(seen.action)
	const transaction = Option.match(session, {
		onNone: (): ReadonlyArray<string> => [],
		onSome: (id): ReadonlyArray<string> =>
			sessionAt(seen.before, id)?.kind === "direct"
				? Arr.flatMap(
						Arr.filter(earlier, (e: SeenAction) => Option.contains(sessionOf(e.action), id)),
						(e: SeenAction) => submittedTexts(e.action)
					)
				: []
	})
	return new Set([
		...submittedTexts(seen.action),
		...transaction,
		...Option.match(session, {
			onNone: (): ReadonlyArray<string> => [],
			onSome: (id) => claimsTexts(seen.before, id)
		})
	])
}

/**
 * A refusal's shown witness carries only keys the writer submitted (in its transaction, or through its claims) and keys
 * of relations its role holds whole (docs/errors-and-concurrency.md "Errors and outcomes").
 */
export const witnessesShowTheirOwn: StepCheck = (checked) => {
	const { seen } = checked
	const o = seen.observation
	if (
		(o.kind !== "invariant-rejected" && o.kind !== "law-refused") ||
		o.witness.kind === "withheld"
	) {
		return
	}
	const submitted = submittedBy(checked)
	const held = Option.match(
		Option.flatMap(sessionOf(seen.action), (session) => sessionRole(seen.before, session)),
		{ onNone: () => new Set<string>(), onSome: (role) => wholeHeldTexts(seen.before, role) }
	)
	for (const key of o.witness.keys) {
		for (const [field, value] of Rec.toEntries(key)) {
			const text = valueText(value)
			assert.ok(
				submitted.has(text) || held.has(text),
				`action ${seen.index}: the witness of ${o.kind === "law-refused" ? Arr.join(o.laws, ", ") : o.law} shows ${field} = ${text}, which the writer neither submitted nor holds whole`
			)
		}
	}
}

/**
 * Whether a direct statement reaches for what its session does not hold: taking on any identity but a role of its own
 * login (SET SESSION AUTHORIZATION needs a superuser, so every one does); reading or preparing the view of a query entry
 * of a role another login holds, which is that role's alone; reading the view of a whole entry, its relation's one
 * whole view, which every role holding the relation whole reads, as a role that does not hold it whole (a PREPARE of
 * one only names it: its EXECUTE reads it, and the model judges that); or calling the filter or key probe of a role it
 * does not act as.
 */
const reachesPast = (state: ModelState, session: number, statement: DirectStatement): boolean => {
	const held = sessionAt(state, session)
	if (held?.kind !== "direct") {
		return false
	}
	const ownLogin = (role: string): boolean =>
		loginOf(state.install, held.login)?.roles.includes(role) === true
	const current =
		held.current.kind === "role" ? roleOf(state.install, held.current.role) : undefined
	/** The whole entry `role` reads `relation` by, its relation's name, or none for a query entry or none at all. */
	const wholeOf = (role: string, relation: string): string | undefined => {
		const entry = roleOf(state.install, role)?.entries[relation]
		return entry?.kind === "whole" ? entry.relation : undefined
	}
	/** Whether the session's current role holds `relation` whole, a closed roster aside, which has no view. */
	const holdsWhole = (relation: string): boolean =>
		current !== undefined &&
		!Arr.some(state.install.base.closed, (c) => c.name === relation) &&
		Arr.some(Rec.values(current.entries), (e) => e.kind === "whole" && e.relation === relation)
	const viewPast = (role: string, relation: string): boolean => {
		const whole = wholeOf(role, relation)
		return whole === undefined ? !ownLogin(role) : !holdsWhole(whole)
	}
	switch (statement.kind) {
		case "set-role":
			return statement.role.kind !== "own"
		case "set-session-authorization":
			return true
		case "select-view":
			return viewPast(statement.role, statement.relation)
		case "prepare":
			return (
				statement.read.kind === "view" &&
				wholeOf(statement.read.role, statement.read.relation) === undefined &&
				!ownLogin(statement.read.role)
			)
		case "call":
			return !(held.current.kind === "role" && held.current.role === statement.fn.role)
		case "reset-role":
		case "set-claims":
		case "select-table":
		case "insert":
		case "delete":
		case "update":
		case "truncate":
		case "insert-on-conflict":
		case "merge-delete":
		case "execute-prepared":
			return false
	}
}

/**
 * A direct writer never crosses into what its login does not hold: a statement that reaches for another login's role
 * or its query entries' views, a whole view of a relation its role does not hold, another identity or another role's
 * functions is refused, whatever the claims (docs/access.md "Security model").
 */
export const reachingPastRefused: StepCheck = ({ seen }) => {
	if (
		seen.action.kind !== "direct" ||
		!reachesPast(seen.before, seen.action.session, seen.action.statement)
	) {
		return
	}
	assert.ok(
		seen.observation.kind === "refused" || seen.observation.kind === "handle-refused",
		`action ${seen.index}: ${seen.action.statement.kind} reached past its login and answered ${seen.observation.kind}`
	)
}
