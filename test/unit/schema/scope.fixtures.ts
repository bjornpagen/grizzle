/** What scope.test.ts reads: a base with a Learner unit, its owners by every rule they keep or break, and the roles. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, relation, role, schema, unit, wholeEntriesOf } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { DefinitionQuery } from "#compiler/types/derived/derived.ts"

/**
 * A role's scope (schema/scope.ts ownerOf, schema/own.ts ownRole): a base whose Learner unit holds Assignment, a Clerk
 * user's sign-in as a child (ClerkAccount, keyed by the Clerk user), a coach's grants (CoachOf, keyed (coach, child)), a
 * sign-in whose child is an integer, no type the unit's key compares with (Alias), and two contexts, the token's Session and a Learner
 * claim naming its child itself.
 */
const Name = str.regex("^[a-z]{1,8}$")
const Child = str.regex("^c[a-z]{0,7}$")

const ClerkAccount = relation("ClerkAccount", { clerk: Name, child: Child }, ["clerk"])
const CoachOf = relation("CoachOf", { coach: Name, child: Child }, ["coach", "child"])
const Alias = relation("Alias", { clerk: Name, child: pg.integer }, ["clerk"])
const Assignment = relation("Assignment", { child: Child, number: Name }, ["child", "number"])
const Session = context("Session", { sub: Name })
const LearnerClaim = context("LearnerClaim", { child: Child })

const Base = schema(
	"Scoped",
	[ClerkAccount, CoachOf, Alias, Assignment],
	[unit("Learner", { child: Child })]
)

/** The children a Session's Clerk user signs in as, at ClerkAccount's key. */
const signIn = query(Base).rule((r) => {
	const { sub } = v(Session, "s")
	const { child } = v(ClerkAccount, "account")
	return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, child }).find({ child })
})

/** The children a Session's coach is granted, at a prefix of CoachOf's key. */
const grant = query(Base).rule((r) => {
	const { sub } = v(Session, "s")
	const { child } = v(CoachOf, "grant")
	return r.match(Session, { sub }).match(CoachOf, { coach: sub, child }).find({ child })
})

/** The child the token's claims name themselves. */
const claim = query(Base).rule((r) => {
	const { child } = v(LearnerClaim, "claim")
	return r.match(LearnerClaim, { child }).find({ child })
})

/** Every way an owner keeps the rules, and every rule a scope breaks, each by one owner or one role. */
const scopeForms = [
	"signIn",
	"grant",
	"claim",
	"heading",
	"source",
	"noContext",
	"undetermined",
	"unit",
	"unitType",
	"twice",
	"outsideRead",
	"undeclaredContext"
] as const
export type ScopeForm = (typeof scopeForms)[number]

export const scopeFormGen: Gen<ScopeForm> = element(scopeForms)

/** What a form's role answers by the rules: admitted, or refused by the rule it breaks, as the refusal names it. */
export type ScopeVerdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "scope"; readonly rule: string }
	| { readonly kind: "outsideRole"; readonly access: "read" | "context" }

export const verdictOf = (form: ScopeForm): ScopeVerdict => {
	switch (form) {
		case "signIn":
		case "grant":
		case "claim":
			return { kind: "admitted" }
		case "heading":
		case "source":
		case "noContext":
		case "undetermined":
			return { kind: "scope", rule: `owner ${form}` }
		case "unit":
		case "unitType":
		case "twice":
			return { kind: "scope", rule: form }
		case "outsideRead":
			return { kind: "outsideRole", access: "read" }
		case "undeclaredContext":
			return { kind: "outsideRole", access: "context" }
	}
}

/** The role a form builds: a student over every relation whole, its scope the form's owners. */
export const roleOf = (form: ScopeForm) => {
	const contexts = [Session, LearnerClaim] as const
	const over = (scope: ReadonlyArray<DefinitionQuery>) =>
		role(Base, "student", wholeEntriesOf(Base), { contexts, scope })
	switch (form) {
		case "signIn":
			return over([signIn])
		case "grant":
			return over([grant])
		case "claim":
			return over([claim])
		case "heading":
			return over([
				query(Base)
					.rule((r) => {
						const { sub } = v(Session, "s")
						const { child } = v(ClerkAccount, "account")
						return r
							.match(Session, { sub })
							.match(ClerkAccount, { clerk: sub, child })
							.find({ child })
					})
					.orderBy(["child", "asc"])
					.take(1)
			])
		case "source":
			return over([
				query(Base).rule((r) => {
					const { sub } = v(Session, "s")
					const { child } = v(ClerkAccount, "account")
					return r
						.match(Session, { sub })
						.match(ClerkAccount, { clerk: sub, child })
						.where(r.not(Assignment, { child }))
						.find({ child })
				})
			])
		case "noContext":
			return over([
				query(Base).rule((r) => {
					const { child } = v(ClerkAccount, "account")
					return r.match(ClerkAccount, { clerk: "ann", child }).find({ child })
				})
			])
		case "undetermined":
			return over([
				query(Base).rule((r) => {
					const { sub } = v(Session, "s")
					const { child } = v(CoachOf, "grant")
					return r.match(Session, { sub }).match(CoachOf, { child }).find({ child })
				})
			])
		case "unit":
			return over([
				query(Base).rule((r) => {
					const { sub } = v(Session, "s")
					const { child } = v(ClerkAccount, "account")
					return r
						.match(Session, { sub })
						.match(ClerkAccount, { clerk: sub, child })
						.find({ learner: child })
				})
			])
		case "unitType":
			return over([
				query(Base).rule((r) => {
					const { sub } = v(Session, "s")
					const { child } = v(Alias, "alias")
					return r.match(Session, { sub }).match(Alias, { clerk: sub, child }).find({ child })
				})
			])
		case "twice":
			return over([signIn, grant])
		case "outsideRead":
			return role(
				Base,
				"student",
				{
					...wholeEntriesOf(Base),
					ClerkAccount: query(Base).rule((r) => {
						const { clerk, child } = v(ClerkAccount, "account")
						return r.match(ClerkAccount, { clerk, child }).find({ clerk, child })
					})
				},
				{ contexts, scope: [signIn] }
			)
		case "undeclaredContext":
			return role(Base, "student", wholeEntriesOf(Base), {
				contexts: [LearnerClaim],
				scope: [signIn]
			})
	}
}
