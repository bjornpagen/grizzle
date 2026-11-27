/** What the property of instants.test.ts reads: its schema, its cases with their verdicts, and its features. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { InstantRule } from "#compiler/core/causes.ts"
import { instant, pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { contained, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/** A user's sign-in, its at the clock of child user. */
const SignIn = relation("SignIn", { user: pg.integer, at: instant, method: pg.integer }, [
	"user",
	"at"
])
/** A session, its at a reference SignIn's clock stamps at its user. */
const Session = relation("Session", { token: pg.integer, user: pg.integer, at: instant }, ["token"])
/** A user's visit, its at a clock of child user: a clock besides SignIn's. */
const Visit = relation("Visit", { user: pg.integer, at: instant, place: pg.integer }, [
	"user",
	"at"
])
/** Its at a reference carried to SignIn's at and to Visit's, two clocks, so no clock stamps it. */
const Orphan = relation("Orphan", { token: pg.integer, user: pg.integer, at: instant }, ["token"])
/** Its s a reference SignIn's clock stamps at its user, and its at a clock of child (user, s). */
const Chain = relation("Chain", { user: pg.integer, s: instant, at: instant }, ["user", "s", "at"])

/** SignIn, Visit and Session mutable, the first two inside the unit of their user and Session inside the unit of its
 * token, since the cases put and delete them. */
export const Clocks = schema(
	"Clocks",
	[SignIn, Session, Visit, Orphan, Chain],
	[
		contained(on(Session, "user", "at"), on(SignIn, "user", "at")),
		contained(on(Orphan, "user", "at"), on(SignIn, "user", "at")),
		contained(on(Orphan, "user", "at"), on(Visit, "user", "at")),
		contained(on(Chain, "user", "s"), on(SignIn, "user", "at")),
		unit("User", { user: pg.integer }),
		unit("Token", { token: pg.integer }),
		mutable(SignIn),
		mutable(Visit),
		mutable(Session)
	]
)

/** A sign-in's fields but its clock, each a parameter. */
const fresh = query(Clocks).rule((r) =>
	r.find({ user: r.param("user", pg.integer), method: r.param("method", pg.integer) })
)
/** The stored sign-ins, each field, its clock a stored instant. */
const stored = query(Clocks).rule((r) => {
	const { user, at, method } = v(SignIn, "signIn")
	return r.match(SignIn, { user, at, method }).find({ user, at, method })
})
/** A session's fields but its instant. */
const session = query(Clocks).rule((r) =>
	r.find({ token: r.param("token", pg.integer), user: r.param("user", pg.integer) })
)
/** A session of each stored sign-in, its instant the sign-in's, a stored instant. */
const sessionOfStored = query(Clocks).rule((r) => {
	const { user, at } = v(SignIn, "signIn")
	return r.match(SignIn, { user, at }).find({ token: r.param("token", pg.integer), user, at })
})
/** The stored sessions, each field. */
const storedSessions = query(Clocks).rule((r) => {
	const { token, user, at } = v(Session, "session")
	return r.match(Session, { token, user, at }).find({ token, user, at })
})
/** A session's fields but its instant, its token another parameter's: a second query of Session's insert. */
const otherSession = query(Clocks).rule((r) =>
	r.find({ token: r.param("other", pg.integer), user: r.param("user", pg.integer) })
)
/** A session of each stored sign-in under another token, its instant the sign-in's: a second query of Session's put. */
const otherOfStored = query(Clocks).rule((r) => {
	const { user, at } = v(SignIn, "signIn")
	return r.match(SignIn, { user, at }).find({ token: r.param("other", pg.integer), user, at })
})
/** The stored visits, each field, its clock a stored instant. */
const storedVisits = query(Clocks).rule((r) => {
	const { user, at, place } = v(Visit, "visit")
	return r.match(Visit, { user, at, place }).find({ user, at, place })
})
/** A visit's fields but its clock. */
const visit = query(Clocks).rule((r) =>
	r.find({ user: r.param("user", pg.integer), place: r.param("place", pg.integer) })
)
/** The stored visits to one place. */
const visitsTo = query(Clocks).rule((r) => {
	const { user, at, place } = v(Visit, "visit")
	return r
		.match(Visit, { user, at, place })
		.where(r.eq(place, r.param("place", pg.integer)))
		.find({ user, at, place })
})
const orphan = query(Clocks).rule((r) =>
	r.find({ token: r.param("token", pg.integer), user: r.param("user", pg.integer) })
)
const chain = query(Clocks).rule((r) => r.find({ user: r.param("user", pg.integer) }))

const empty = ChangeSet.empty(Clocks)

/** A rule a write is refused by: every instant rule but a schema's, which refuse a clock outside its key or first in it,
 * and a migration's, which refuses a clock added over stored rows its key would not keep apart. */
type WriteRule = Exclude<
	InstantRule,
	{ readonly kind: "clockOutsideKey" | "childless" | "addedOverRows" }
>

/** What the rule says of a case: it compiles, or is refused at a field by a rule. */
export type Verdict =
	| { readonly kind: "compiled" }
	| {
			readonly kind: "refused"
			readonly relation: string
			readonly field: string
			readonly rule: WriteRule
	  }

/** One case: its name, its ChangeSet, built anew as a caller builds it, and the rule's verdict. */
export interface InstantCase {
	readonly name: string
	readonly changeSet: () => unknown
	readonly verdict: Verdict
}

const compiled: Verdict = { kind: "compiled" }

const refusedAt = (relation: string, field: string, rule: WriteRule): Verdict => ({
	kind: "refused",
	relation,
	field,
	rule
})

const cases: readonly [InstantCase, ...ReadonlyArray<InstantCase>] = [
	{ name: "an insert of host rows", changeSet: () => empty.insert(SignIn, []), verdict: compiled },
	{
		name: "an insert of host rows whose every caller field the call computes, its stamped input of no field the unit relation, one public column",
		changeSet: () =>
			empty.insertAllComputed(
				{ SignIn: [] },
				{ user: param("user", pg.integer), method: param("method", pg.integer) }
			),
		verdict: compiled
	},
	{
		name: "an insert leaving its clock out",
		changeSet: () => empty.insert(SignIn, fresh),
		verdict: compiled
	},
	{
		name: "an insert stating its clock",
		changeSet: () => empty.insert(SignIn, stored),
		verdict: refusedAt("SignIn", "at", { kind: "clockStated", op: "insert" })
	},
	{
		name: "a put stating its clock",
		changeSet: () => empty.put(SignIn, stored),
		verdict: refusedAt("SignIn", "at", { kind: "clockStated", op: "put" })
	},
	{
		name: "a put leaving its clock out",
		changeSet: () => empty.put(SignIn, fresh),
		verdict: refusedAt("SignIn", "at", { kind: "unstated", op: "put" })
	},
	{
		name: "a put of a reference leaving it out",
		changeSet: () => empty.put(Session, session),
		verdict: refusedAt("Session", "at", { kind: "unstated", op: "put" })
	},
	{
		name: "a put of a reference stating a stored instant",
		changeSet: () => empty.put(Session, sessionOfStored),
		verdict: compiled
	},
	{
		name: "a delete stating its clock",
		changeSet: () => empty.delete(SignIn, stored),
		verdict: compiled
	},
	{
		name: "a delete leaving its clock out",
		changeSet: () => empty.delete(SignIn, fresh),
		verdict: refusedAt("SignIn", "at", { kind: "unstated", op: "delete" })
	},
	{
		name: "a reference stamped beside its clock",
		changeSet: () => empty.insert(SignIn, fresh).insert(Session, session),
		verdict: compiled
	},
	{
		name: "a reference stated from a stored instant",
		changeSet: () => empty.insert(Session, sessionOfStored),
		verdict: compiled
	},
	{
		name: "a reference stamped alone",
		changeSet: () => empty.insert(Session, session),
		verdict: refusedAt("Session", "at", { kind: "clockUnstamped", clock: "SignIn.at" })
	},
	{
		name: "a reference stamped a stratum after its clock",
		changeSet: () =>
			ChangeSet.sequence(empty.insert(SignIn, fresh), empty.insert(Session, session)),
		verdict: refusedAt("Session", "at", { kind: "clockUnstamped", clock: "SignIn.at" })
	},
	{
		name: "a reference no clock stamps",
		changeSet: () => empty.insert(SignIn, fresh).insert(Orphan, orphan),
		verdict: refusedAt("Orphan", "at", { kind: "unstampable" })
	},
	{
		name: "a clock whose child the insert stamps",
		changeSet: () => empty.insert(SignIn, fresh).insert(Chain, chain),
		verdict: refusedAt("Chain", "at", { kind: "childStamped", stamped: "Chain.s" })
	},
	{
		name: "a clock stamped in two strata",
		changeSet: () => ChangeSet.sequence(empty.insert(SignIn, fresh), empty.insert(SignIn, fresh)),
		verdict: refusedAt("SignIn", "at", {
			kind: "stampedApart",
			clock: "SignIn.at",
			apart: "strata"
		})
	},
	{
		name: "a clock's relation deleted from a query beside its insert",
		changeSet: () => empty.delete(Visit, storedVisits).insert(Visit, visit),
		verdict: compiled
	},
	{
		name: "a reference stamped from two queries beside its clock",
		changeSet: () =>
			empty.insert(SignIn, fresh).insert(Session, session).insert(Session, otherSession),
		verdict: compiled
	},
	{
		name: "a reference stamped from host rows and a query beside its clock",
		changeSet: () =>
			empty
				.insert(SignIn, fresh)
				.insert(Session, [{ token: 1, user: 1 }])
				.insert(Session, otherSession),
		verdict: compiled
	},
	{
		name: "a reference put from two queries stating stored instants",
		changeSet: () => empty.put(Session, sessionOfStored).put(Session, otherOfStored),
		verdict: compiled
	},
	{
		name: "a clock and its reference stamped beside two deletes of another clock's relation",
		changeSet: () =>
			empty
				.insert(SignIn, fresh)
				.insert(Session, session)
				.delete(Visit, storedVisits)
				.delete(Visit, visitsTo),
		verdict: compiled
	},
	{
		name: "a clock stamped by two statements of a stratum",
		changeSet: () =>
			empty.delete(Session, storedSessions).insert(Session, session).insert(SignIn, fresh),
		verdict: refusedAt("SignIn", "at", {
			kind: "stampedApart",
			clock: "SignIn.at",
			apart: "statements"
		})
	}
]

export const instantCaseGen: Gen<InstantCase> = element(cases)

/** What a case reaches: a compiled ChangeSet, or its refusal's rule. */
export type InstantWriteFeature =
	| "compiled"
	| Exclude<WriteRule["kind"], "stampedApart">
	| "stampedApart in strata"
	| "stampedApart in statements"

export const featureOf = (v: Verdict): InstantWriteFeature => {
	if (v.kind === "compiled") {
		return "compiled"
	}
	switch (v.rule.kind) {
		case "stampedApart":
			return v.rule.apart === "strata" ? "stampedApart in strata" : "stampedApart in statements"
		case "childStamped":
		case "clockStated":
		case "unstated":
		case "unstampable":
		case "clockUnstamped":
			return v.rule.kind
	}
}
