/** What the property of role-contexts.test.ts reads: its schema, its role and login, its space and its model. */
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	context,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { migratedOnceTemplate } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A role's declared contexts are what its served Db decodes from the token, and a program over the schema matching them
 * runs on a full role that declares them.
 *
 * README, "Contexts of a role": a role states the contexts its token's claims carry, `Db.open` decodes exactly those,
 * each from its own claim (a context of `{ claim: "act" }` from the nested `act` object, no row where the token has
 * none), and a program over the schema matching them runs on every full role declaring them. The schema is metis's
 * student act, cut to its contexts: an Account names the person a Clerk user signs in as, a Sitting its student, and a
 * student starts their own sitting (Started) by a program over the schema matching Session and the account it signs in
 * as, where the staff member acting as the student through Clerk's impersonation records their act (ActedAs) by a
 * program over the schema matching Acting, the `sub` of the token's `act` claim. The role `student` holds the schema
 * whole and declares both contexts; its login serves both programs, written once, over the schema.
 *
 * A case seats ann's and bob's accounts, the one sitting and its drawn student, and opens a Db with a drawn token: its
 * `sub` ann's, bob's, cat's (who has no account) or none, and its `act` claim staff's, none, or a text that is no claim
 * object. A token with no `sub`, or whose `act` is no object, is refused at stage `token`. Otherwise the start is
 * accepted exactly when the subject's account signs in as the sitting's student, else unchanged, and the act is
 * accepted, recording staff, exactly when the token has an `act` claim, else unchanged.
 */
const Clerk = str.regex("^u_[a-z]{1,8}$")
const Person = str.regex("^p_[a-z]{1,8}$")

export const Account = relation("Account", { clerk: Clerk, person: Person }, ["clerk"])
export const Sitting = relation("Sitting", { number: pg.integer, student: Person }, ["number"])
export const Started = relation("Started", { number: pg.integer }, ["number"])
export const ActedAs = relation("ActedAs", { number: pg.integer, actor: Clerk }, [
	"number",
	"actor"
])

/** The signed-in Clerk user: the `sub` of the verified token's top level. */
const Session = context("Session", { sub: Clerk })

/** The staff member acting as the signed-in user: the `sub` of the token's `act` claim, no row without one. */
const Acting = context("Acting", { sub: Clerk }, { claim: "act" })

/** The sitting the case's calls name. */
export const sittingNumber = 1

export const sittingsAt = (name: string) => {
	const base = schema(name, [Account, Sitting, Started, ActedAs], [])
	/** Start the sitting `number` as its own student, signed in as the session's Clerk user, else nothing. */
	const startAsStudent = ChangeSet.empty(base).insert(
		Started,
		query(base).rule((r) => {
			const number = r.param("number", pg.integer)
			const { student } = v(Sitting, "sitting")
			const { sub: clerk } = v(Session, "session")
			return r
				.match(Sitting, { number, student })
				.match(Session, { sub: clerk })
				.match(Account, { clerk, person: student })
				.find({ number })
		})
	)
	/** The act a staff member made as the sitting's student, the one the `act` claim names, else nothing. */
	const actedAs = ChangeSet.empty(base).insert(
		ActedAs,
		query(base).rule((r) => {
			const number = r.param("number", pg.integer)
			const { sub: actor } = v(Acting, "acting")
			return r.match(Sitting, { number }).match(Acting, { sub: actor }).find({ number, actor })
		})
	)
	const student = role(base, "student", wholeEntriesOf(base), {
		...wholeWritesOf(base),
		contexts: [Session, Acting]
	})
	return {
		base,
		student,
		desk: login(base, "desk", [student], {
			workload: [workload(student, { startAsStudent, actedAs })]
		})
	}
}

/** The installation migrated once per member (support/installed.ts migratedOnceTemplate). */
export const sittingsTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "role contexts",
	options: {
		label: "sittings",
		first: (name) => {
			const sittings = sittingsAt(name)
			return { schema: sittings.base, logins: [sittings.desk] }
		},
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})

/** The persons the accounts sign in as, and the accounts: ann's and bob's. Cat signs in as no one. */
const persons = ["p_ann", "p_bob"] as const
type PersonName = (typeof persons)[number]
export const accounts: ReadonlyArray<{ readonly clerk: string; readonly person: PersonName }> = [
	{ clerk: "u_ann", person: "p_ann" },
	{ clerk: "u_bob", person: "p_bob" }
]

/** The staff member an `act` claim names. */
const staff = "u_staff"

/** The token's `sub`: a Clerk user, or none. */
const subjects = ["u_ann", "u_bob", "u_cat", "none"] as const
type Subject = (typeof subjects)[number]

/** The token's `act` claim: staff's claim object, none, or a text where the object belongs. */
const acts = ["staff", "none", "malformed"] as const
type Act = (typeof acts)[number]

export interface ContextsCase {
	readonly student: PersonName
	readonly subject: Subject
	readonly act: Act
}

export const contextsCases: Gen<ContextsCase> = (source) => ({
	student: source.draw(element(persons)),
	subject: source.draw(element(subjects)),
	act: source.draw(element(acts))
})

/** The payload the case's token spells. */
export const payloadOf = (c: ContextsCase): { readonly [key: string]: Json } => ({
	...(c.subject === "none" ? {} : { sub: c.subject }),
	...(c.act === "staff" ? { act: { sub: staff } } : c.act === "malformed" ? { act: staff } : {})
})

/**
 * What the case's Db answers, by the specification: refused at stage `token` where the token has no `sub` or its `act`
 * is no object; otherwise whether the start and the act each write, and the rows they leave.
 */
export type ContextsAnswer =
	| { readonly kind: "refused" }
	| {
			readonly kind: "opened"
			readonly started: ReadonlyArray<number>
			readonly acted: ReadonlyArray<readonly [number, string]>
	  }

export const expected = (c: ContextsCase): ContextsAnswer => {
	if (c.subject === "none" || c.act === "malformed") {
		return { kind: "refused" }
	}
	const signsIn = Option.exists(
		Arr.findFirst(accounts, (a) => a.clerk === c.subject),
		(a) => a.person === c.student
	)
	return {
		kind: "opened",
		started: signsIn ? [sittingNumber] : [],
		acted: c.act === "staff" ? [[sittingNumber, staff]] : []
	}
}

export type ContextsFeature =
	| "the student's own sitting started"
	| "another student's sitting unchanged"
	| "a subject with no account unchanged"
	| "an act recorded"
	| "no act recorded nothing"
	| "no subject refused at token"
	| "an act that is no object refused at token"

/** What a case reaches. */
export const featuresOf = (c: ContextsCase): ReadonlyArray<ContextsFeature> => {
	if (c.subject === "none") {
		return ["no subject refused at token"]
	}
	if (c.act === "malformed") {
		return ["an act that is no object refused at token"]
	}
	const answer = expected(c)
	const start: ContextsFeature =
		answer.kind === "opened" && answer.started.length > 0
			? "the student's own sitting started"
			: c.subject === "u_cat"
				? "a subject with no account unchanged"
				: "another student's sitting unchanged"
	return [start, c.act === "staff" ? "an act recorded" : "no act recorded nothing"]
}
