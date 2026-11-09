import { Array as Arr, Option, Record } from "effect"
import { viaKinds } from "#test/support/worlds/generate/reads.ts"
import { directFactKinds, opKinds, type FactWriter } from "#test/support/worlds/invalid/facts.ts"
import { namingKind, type SessionUse } from "#test/support/worlds/invalid/handles.ts"
import { migrationKinds } from "#test/support/worlds/invalid/migrations.ts"
import type {
	Action,
	DirectStart,
	DirectStatement,
	InvalidKind,
	ModelState,
	RoleRef,
	SnapshotRef,
	Token
} from "#test/support/worlds/model/types.ts"

/**
 * The invalid kind of naming a session for a use: a closed session, one of the other kind, a stale Db for a call; none
 * for a live one.
 */
const handleKinds = (
	state: ModelState,
	session: number,
	use: SessionUse
): ReadonlyArray<InvalidKind> => {
	const s = state.sessions[session]
	if (s === undefined) {
		throw new Error(`the action names the session ${session}, which the state does not hold`)
	}
	const kind = namingKind(state, s, use)
	return kind === undefined ? [] : [kind]
}

/** A token's kind: its stale source or its wild kind; none for no token or a live one. */
const tokenKinds = (token: Token): ReadonlyArray<InvalidKind> => {
	switch (token.kind) {
		case "none":
		case "live":
			return []
		case "stale":
			return [`token:stale:${token.source}`]
		case "wild":
			return [`token:${token.wild}`]
	}
}

const snapshotKinds = (snapshot: SnapshotRef): ReadonlyArray<InvalidKind> => {
	switch (snapshot) {
		case "current":
			return []
		case "stale":
			return ["handle:stale-snapshot"]
		case "foreign":
			return ["handle:foreign-snapshot"]
		case "drafted":
			return ["handle:drafted-snapshot"]
	}
}

/** A role reference's kind: none for an own role, the live value. */
const roleKinds = (role: RoleRef): ReadonlyArray<InvalidKind> =>
	role.kind === "own" ? [] : [`role:${role.kind}`]

/** The Db session's role and claims, when the session is an open Db. */
const writerAt = (state: ModelState, session: number): Option.Option<FactWriter> => {
	const s = state.sessions[session]
	return s?.kind === "db"
		? Option.map(
				Arr.findFirst(state.install.roles, (r) => r.name === s.role),
				(role): FactWriter => ({ role, facts: s.facts })
			)
		: Option.none()
}

/** A relation a Db session's role does not hold that another role does: another world's handle. */
const relationKinds = (
	state: ModelState,
	session: number,
	relation: string
): ReadonlyArray<InvalidKind> =>
	Option.match(writerAt(state, session), {
		onNone: (): ReadonlyArray<InvalidKind> => [],
		onSome: (writer) =>
			!Record.has(writer.role.entries, relation) &&
			Arr.some(state.install.roles, (r) => Record.has(r.entries, relation))
				? ["handle:other-role"]
				: []
	})

/** The direct writer at a session, as the facts of a statement are judged: its current role (or the first) and its claims. */
const directWriter = (state: ModelState, session: number): FactWriter => {
	const s = state.sessions[session]
	const current = s?.kind === "direct" && s.current.kind === "role" ? s.current.role : undefined
	const role = Option.getOrElse(
		Arr.findFirst(state.install.roles, (r) => r.name === current),
		() => state.install.roles[0]
	)
	const facts =
		s?.kind === "direct" && s.claims.kind === "set" && s.claims.setting.kind === "facts"
			? s.claims.setting.facts
			: {}
	return { role, facts }
}

/** The kinds of one direct statement's own inputs. */
const statementKinds = (
	state: ModelState,
	session: number,
	statement: DirectStatement
): ReadonlyArray<InvalidKind> => {
	switch (statement.kind) {
		case "set-role":
		case "set-session-authorization":
			return roleKinds(statement.role)
		case "set-claims":
			return [`claims:${statement.setting.kind}:${statement.setting.scope}`]
		case "insert":
		case "insert-on-conflict": {
			const s = state.sessions[session]
			return s?.kind === "direct"
				? directFactKinds(
						state,
						directWriter(state, session),
						statement.relation,
						statement.fact,
						s.view
					)
				: []
		}
		case "merge-delete":
		case "prepare":
		case "execute-prepared":
		case "reset-role":
		case "select-view":
		case "select-table":
		case "delete":
		case "update":
		case "truncate":
		case "call":
		case "setval":
			return []
	}
}

/** The claims a direct writer's start sets (DirectStart), as the statement setting them is classified. */
const startKinds = (start: DirectStart): ReadonlyArray<InvalidKind> =>
	start.claims.kind === "set"
		? [`claims:${start.claims.setting.kind}:${start.claims.setting.scope}`]
		: []

/**
 * Whether a direct action follows a refusal: its session's transaction is aborted. A statement or a COMMIT there does;
 * a ROLLBACK is how the writer ends what the refusal aborted.
 */
const afterRefusal = (state: ModelState, session: number): ReadonlyArray<InvalidKind> => {
	const s = state.sessions[session]
	return s?.kind === "direct" && s.transaction === "aborted" ? ["session:after-refusal"] : []
}

/**
 * The invalid inputs an action carries in a state, each by its kind: the classifier every generator's intent is
 * checked against and every suite's `invalid:` features come from. It judges the inputs alone (a stale token, a closed
 * handle, a fact a law refuses, a perturbed catalog), never what the system does with them: that is the model's.
 */
export const invalidKindsOf = (state: ModelState, action: Action): ReadonlyArray<InvalidKind> => {
	const kinds = ((): ReadonlyArray<InvalidKind> => {
		switch (action.kind) {
			case "open-db":
				return [
					...roleKinds(action.role),
					...(action.role.kind === "other-login" ? (["handle:other-login"] as const) : []),
					...tokenKinds(action.token),
					...snapshotKinds(action.snapshot)
				]
			case "read": {
				return [
					...handleKinds(state, action.session, "call"),
					...relationKinds(state, action.session, action.relation),
					...Option.match(writerAt(state, action.session), {
						onNone: (): ReadonlyArray<InvalidKind> => [],
						onSome: (writer) =>
							viaKinds(state, writer.role, writer.facts, action.relation, action.via)
					})
				]
			}
			case "refresh":
				return [
					...handleKinds(state, action.session, "call"),
					...relationKinds(state, action.session, action.relation)
				]
			case "apply": {
				const ops = Arr.flatten(action.strata)
				return [
					...handleKinds(state, action.session, "call"),
					...Arr.flatMap([...Arr.map(ops, (op) => op.relation), ...action.reads], (r) =>
						relationKinds(state, action.session, r)
					),
					...Option.match(writerAt(state, action.session), {
						onNone: (): ReadonlyArray<InvalidKind> => [],
						onSome: (writer) => opKinds(state, writer, ops)
					})
				]
			}
			case "close":
				return handleKinds(state, action.session, "db")
			case "direct-begin":
				return [
					...(action.isolation === "serializable"
						? []
						: [`isolation:${action.isolation}` as const]),
					...startKinds(action.start)
				]
			case "direct":
				return [
					...handleKinds(state, action.session, "direct"),
					...afterRefusal(state, action.session),
					...statementKinds(state, action.session, action.statement)
				]
			case "direct-end":
				return [
					...handleKinds(state, action.session, "direct"),
					...(action.end === "commit" ? afterRefusal(state, action.session) : [])
				]
			case "interrupt":
				return ["session:interrupted", ...handleKinds(state, action.session, "either")]
			case "migrate":
				return migrationKinds(state, action.to, action.how)
			case "tamper":
				return [`catalog:${action.perturbation.kind}`]
			case "drift":
				return []
			case "wild":
				return [
					"handle:wild-js-value",
					...(action.at.kind === "session" ? handleKinds(state, action.at.session, "call") : [])
				]
		}
	})()
	return [...new Set(kinds)]
}
