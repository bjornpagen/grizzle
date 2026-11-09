import { constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { Array as Arr, Record } from "effect"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import type { BoundaryArms, Strata, Variant } from "#test/support/worlds/invalid/kinds.ts"
import { staleReason } from "#test/support/worlds/model/session/state.ts"
import type {
	InvalidKind,
	Isolation,
	ModelState,
	RoleSpec,
	ModelSession,
	SnapshotRef,
	WildSite
} from "#test/support/worlds/model/types.ts"

/**
 * Which kind of session an action needs: a Db's for a call that sends SQL (a read, a write, a refresh) or for a close,
 * a direct writer's, or either (an interrupt).
 */
export type SessionUse = "call" | "db" | "direct" | "either"

/** The invalid kind of naming a session for a use, or none when the session is a live one of that use. */
const handleKind = (session: ModelSession, use: SessionUse): InvalidKind | undefined => {
	const wanted = use === "call" ? "db" : use
	switch (session.kind) {
		case "db":
			return wanted === "direct" ? "handle:wrong-kind" : undefined
		case "direct":
			return wanted === "db" ? "handle:wrong-kind" : undefined
		case "closed":
			if (wanted === "either") {
				return session.was === "db" ? "handle:closed-db" : "handle:closed-direct"
			}
			return session.was === wanted
				? wanted === "db"
					? "handle:closed-db"
					: "handle:closed-direct"
				: "handle:wrong-kind"
	}
}

/**
 * The invalid kind of naming a session for a use in a state: a Db call on a Db whose snapshot the catalog no longer
 * is, a migration unfinished or completed past it (handle:stale-db), else the handle's own kind.
 */
export const namingKind = (
	state: ModelState,
	session: ModelSession,
	use: SessionUse
): InvalidKind | undefined =>
	use === "call" && session.kind === "db" && staleReason(state, session) !== undefined
		? "handle:stale-db"
		: handleKind(session, use)

/**
 * The invalid kind of naming a session for a use, or none for a live one: a direct writer's statement also needs its
 * transaction still running, so an aborted one is named after its refusal.
 */
const sessionKind = (
	state: ModelState,
	session: ModelSession,
	use: SessionUse
): InvalidKind | undefined =>
	use === "direct" && session.kind === "direct" && session.transaction === "aborted"
		? "session:after-refusal"
		: namingKind(state, session, use)

/** The live sessions an action of one use may name, among those `allowed` admits. */
export const liveSessions = (
	state: ModelState,
	use: SessionUse,
	allowed: (id: number) => boolean
): ReadonlyArray<number> =>
	Arr.flatMap(state.sessions, (s, id) =>
		allowed(id) && sessionKind(state, s, use) === undefined ? [id] : []
	)

/**
 * The sessions an action of one use may name, among those `allowed` admits (the serial rule), stratified: live, an open
 * session of its kind (for a direct writer's statement, one whose transaction still runs); stale, a closed one of its
 * kind, a direct transaction a refusal aborted, or, for a call, a Db whose snapshot the catalog no longer is; wild, one
 * of the other kind, open or closed. A state with no live
 * session of the use has no live draw.
 */
export const sessionStrata = (
	state: ModelState,
	use: SessionUse,
	allowed: (id: number) => boolean
): Strata<number> => {
	const ids = Arr.flatMap(state.sessions, (s, id) =>
		allowed(id) ? [{ id, kind: sessionKind(state, s, use) }] : []
	)
	const byKind = (kind: InvalidKind): ReadonlyArray<Variant<number>> => {
		const [first, ...rest] = Arr.map(
			Arr.filter(ids, (i) => i.kind === kind),
			(i) => i.id
		)
		return first === undefined ? [] : [{ invalid: kind, gen: element([first, ...rest]) }]
	}
	const [live, ...moreLive] = liveSessions(state, use, allowed)
	return {
		live: live === undefined ? [] : [element([live, ...moreLive])],
		stale: [
			...byKind("handle:closed-db"),
			...byKind("handle:closed-direct"),
			...byKind("session:after-refusal"),
			...byKind("handle:stale-db")
		],
		wild: byKind("handle:wrong-kind")
	}
}

/** Whose relations a session reads: a Db's role, or none (a closed session, a direct writer's). */
export type Reader = { readonly kind: "role"; readonly role: RoleSpec } | { readonly kind: "none" }

/** The entries of the roles other than the reader's that the reader does not hold under the same name: another world's handles. */
const otherEntries = (state: ModelState, reader: Reader): ReadonlyArray<string> =>
	reader.kind === "none"
		? []
		: Arr.filter(
				[
					...new Set(
						Arr.flatMap(
							Arr.filter(state.install.roles, (r) => r.name !== reader.role.name),
							(r: RoleSpec) => Record.keys(r.entries)
						)
					)
				],
				(name) => !Record.has(reader.role.entries, name)
			)

/**
 * The relations a read names through a role: live, one of its entries (those listed first when `prefer` names any); stale,
 * a relation of another role it does not hold (handle:other-role). A session without a role (closed, or a direct
 * writer's) reads any role's entries.
 */
export const relationArms = (
	state: ModelState,
	reader: Reader,
	prefer: ReadonlyArray<string>
): BoundaryArms<string> => {
	const own =
		reader.kind === "none"
			? knownNonEmpty(
					Arr.flatMap(state.install.roles, (r) => Record.keys(r.entries)),
					"the installation's entries"
				)
			: knownNonEmpty(Record.keys(reader.role.entries), `the entries of ${reader.role.name}`)
	const preferred = Arr.filter(own, (name) => prefer.includes(name))
	const [first, ...rest] = preferred.length > 0 ? preferred : own
	const others = otherEntries(state, reader)
	const [firstOther, ...moreOthers] = others
	return {
		live: element([first, ...rest]),
		stale:
			firstOther === undefined
				? []
				: [{ invalid: "handle:other-role", gen: element([firstOther, ...moreOthers]) }],
		wild: []
	}
}

/** The snapshots the opening role's login layer is given: the installation's own; an older version's, another schema's. */
export const snapshotArms: BoundaryArms<SnapshotRef> = {
	live: constant<SnapshotRef>("current"),
	stale: [
		{ invalid: "handle:stale-snapshot", gen: constant<SnapshotRef>("stale") },
		{ invalid: "handle:foreign-snapshot", gen: constant<SnapshotRef>("foreign") }
	],
	wild: []
}

/** The isolation levels a direct writer begins at: SERIALIZABLE, or any level below it. */
export const isolationArms: BoundaryArms<Isolation> = {
	live: constant<Isolation>("serializable"),
	stale: [],
	wild: Arr.map(
		["repeatable read", "read committed", "read uncommitted"] as const,
		(level): Variant<Isolation> => ({
			invalid: `isolation:${level}`,
			gen: constant<Isolation>(level)
		})
	)
}

/**
 * The sites a JavaScript caller hands grizzle a value its types refuse: Db.open's role or its token (for any installed
 * role, a role that reads no context included), and a Db's read, apply or refresh, at the sessions `allowed` admits,
 * where `calls` says which calls each admits (the serial rule leaves only reads at a Db while a direct transaction is open).
 */
export const wildSiteGen = (
	state: ModelState,
	allowed: (id: number) => ReadonlyArray<"read" | "apply" | "refresh">
): Gen<WildSite> => {
	const [role, ...roles] = knownNonEmpty(
		Arr.map(state.install.roles, (r) => r.name),
		"the roles"
	)
	const sessions = Arr.flatMap([...state.sessions.keys()], (session) =>
		Arr.map(allowed(session), (call): WildSite => ({ kind: "session", session, call }))
	)
	const [firstSession, ...moreSessions] = sessions
	return oneOf([
		constant<WildSite>({ kind: "open-role" }),
		map(element([role, ...roles]), (r): WildSite => ({ kind: "open-token", role: r })),
		...(firstSession === undefined ? [] : [element([firstSession, ...moreSessions])])
	])
}
