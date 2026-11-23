import { Array as Arr } from "effect"
import { textDomain } from "#test/support/worlds/model/text.ts"
import type {
	BaseSpec,
	ContextSpec,
	EntrySpec,
	FieldDomain,
	InstallSpec,
	Occurrence,
	Rule,
	Term
} from "#test/support/worlds/model/types.ts"

/** A subject: the session's user, a document's owner, a share's user and a note's author. */
const subject: FieldDomain = textDomain("^u_[a-z]{1,8}$", "u")
const uuid: FieldDomain = { kind: "uuid" }
const integer: FieldDomain = { kind: "integer", bits: 32 }

/** An organization's plan: the contract Plan over a 32-bit integer, whose domain holds 0 to 9. */
const planContract: FieldDomain = { kind: "contract", name: "Plan", bits: 32, min: 0, max: 9 }

/**
 * The documents base: organizations, their documents, the shares of a document with a user, the notes on a document,
 * and visits, each nothing but its two numbers, its own and its sequence; with laws of each kind a refusal under a
 * world reaches. A note's document
 * exists (a foreign key); an organization's documents differ in their word counts (a candidate key, a unique index); a
 * plan is at most five (a row check), and lies in 0..9 by its contract Plan (a domain
 * CHECK), so a plan of six to nine breaks the check and one past nine the domain. Doc, Share and Note are open, mutable
 * in the units their keys lead with, so a put of a document or a note replaces it in place and a share is revoked by its
 * delete; a note is keyed by its number `no`. Org and Visit are closed, their facts inserted, never changed or deleted.
 *
 * Two contexts read the verified token: Session { sub } from the payload's top level, and Tenant { org, seats } from
 * its `t` claim object, seats an int8 a token carries as a JSON number or a string of digits, so a token's wild forms
 * reach an unsafe integer and an int8 that is no digits. The closed roster Tier is read by no field, so an entry may match a relation no write targets.
 */
export const docsBase: BaseSpec = {
	name: "Docs",
	closed: [{ name: "Tier", members: ["Free", "Pro"] }],
	relations: [
		{
			name: "Org",
			fields: [
				{ name: "id", domain: uuid },
				{ name: "plan", domain: planContract }
			],
			key: ["id"],
			mutability: "immutable"
		},
		{
			name: "Doc",
			fields: [
				{ name: "id", domain: uuid },
				{ name: "org", domain: uuid },
				{ name: "owner", domain: subject },
				{ name: "words", domain: integer }
			],
			key: ["id"],
			mutability: "mutable"
		},
		{
			name: "Share",
			fields: [
				{ name: "doc", domain: uuid },
				{ name: "user", domain: subject }
			],
			key: ["doc", "user"],
			mutability: "mutable"
		},
		{
			name: "Note",
			fields: [
				{ name: "no", domain: { kind: "integer", bits: 64 } },
				{ name: "doc", domain: uuid },
				{ name: "author", domain: subject }
			],
			key: ["no"],
			mutability: "mutable"
		},
		{
			name: "Visit",
			fields: [
				{ name: "no", domain: { kind: "integer", bits: 64 } },
				{ name: "seq", domain: integer }
			],
			key: ["no"],
			mutability: "immutable"
		}
	],
	laws: [
		{
			kind: "contained",
			source: { relation: "Note", fields: ["doc"], where: {} },
			target: { relation: "Doc", fields: ["id"], where: {} }
		},
		{ kind: "key", relation: "Doc", fields: ["org", "words"] },
		{
			kind: "check",
			name: "PlanAtMostFive",
			relation: "Org",
			predicate: { kind: "compare", field: "plan", op: "<=", value: 5 }
		}
	],
	contexts: [
		{ name: "Session", claim: { kind: "top-level" }, fields: [{ name: "sub", domain: subject }] },
		{
			name: "Tenant",
			claim: { kind: "object", key: "t" },
			fields: [
				{ name: "org", domain: uuid },
				{ name: "seats", domain: { kind: "integer", bits: 64 } }
			]
		}
	]
}

/**
 * The documents base with at most one share per document: `key(on(Share, "doc"))`, the native at-most-one (fin.md §6).
 * A role writing its own shares through a query entry meets another user's share of the document, hidden from it, at
 * that key: the key refuses the write at its statement.
 */
const docsOneShareBase: BaseSpec = {
	...docsBase,
	name: "DocsOneShare",
	laws: [...docsBase.laws, { kind: "key", relation: "Share", fields: ["doc"] }]
}

/**
 * The documents base with a context Level read from the token's `l` claim object, its one field `plan` of the contract
 * Plan Org's plan holds: a claim of a contract, which the host decodes as an integer and PostgreSQL holds to the
 * contract's bounds where a statement reads it, so a plan past nine opens a Db whose claims PostgreSQL refuses, and an
 * organization's plan meets the claim in a rule.
 */
const docsLevelBase: BaseSpec = {
	...docsBase,
	name: "DocsLevel",
	contexts: [
		...docsBase.contexts,
		{
			name: "Level",
			claim: { kind: "object", key: "l" },
			fields: [{ name: "plan", domain: planContract }]
		}
	]
}

/**
 * A badge: a pattern whose reading needs PostgreSQL to agree with ECMAScript's, a word class ECMAScript holds to ASCII
 * and a dot no line terminator matches, both of which PostgreSQL's own classes would widen.
 */
const badge: FieldDomain = textDomain("^[a-z]\\w{0,3}.$", "u")

/**
 * The context Profile, read from the token's `p` claim object: a field of every type a context field takes (README
 * "Permissions"), a uuid, a text of a pattern, an integer of each width, a boolean, a closed id of the roster Tier and
 * the contract Plan.
 */
const profileContext: ContextSpec = {
	name: "Profile",
	claim: { kind: "object", key: "p" },
	fields: [
		{ name: "ref", domain: uuid },
		{ name: "badge", domain: badge },
		{ name: "small", domain: { kind: "integer", bits: 16 } },
		{ name: "seats", domain: integer },
		{ name: "big", domain: { kind: "integer", bits: 64 } },
		{ name: "active", domain: { kind: "boolean" } },
		{ name: "tier", domain: { kind: "handle", closed: "Tier", members: ["Free", "Pro"] } },
		{ name: "plan", domain: planContract }
	]
}

/**
 * The documents base with the context Profile, whose claims of every type a Db decodes from its token and a direct
 * writer hand-sets, each cast to its field's type where a statement reads it, PostgreSQL judging a refined one there.
 */
const docsProfileBase: BaseSpec = {
	...docsBase,
	name: "DocsProfile",
	contexts: [...docsBase.contexts, profileContext]
}

/** Every documents base a generated installation is drawn over. */
export const docsBases: Arr.NonEmptyReadonlyArray<BaseSpec> = [
	docsBase,
	docsOneShareBase,
	docsLevelBase
]

const variable = (name: string): Term => ({ kind: "var", name })
const claim = (context: string, field: string): Term => ({ kind: "context", context, field })
const literal = (value: number): Term => ({ kind: "literal", value })
const of = (name: string, fields: Readonly<Record<string, Term>>): Occurrence => ({
	source: { kind: "ordinary", name },
	fields
})

const rule = (
	matches: Arr.NonEmptyReadonlyArray<Occurrence>,
	head: Readonly<Record<string, Term>>,
	filters: Pick<Rule, "negations" | "comparisons">
): Rule => ({ matches, head, ...filters })
const none: Pick<Rule, "negations" | "comparisons"> = { negations: [], comparisons: [] }
const query = (one: Rule): EntrySpec => ({ kind: "query", rules: [one] })
const whole = (relation: string): EntrySpec => ({ kind: "whole", relation })

const id = variable("id")
const org = variable("org")
const owner = variable("owner")
const words = variable("words")
const doc = variable("doc")
const user = variable("user")
const no = variable("no")
const seq = variable("seq")
const tier = variable("tier")
const plan = variable("plan")
const tenant = claim("Tenant", "org")
const subjectClaim = claim("Session", "sub")

/**
 * The documents base's worlds, in the README example's shape. The signed-out `reader` reads no context: the documents
 * of organizations on a plan of at least one, without their owners (a read-only query entry), and the roster Tier
 * whole. The signed-in `member` reads Session and Tenant: the tenant's documents, written with `org` filled from the
 * claim; the shares of the tenant's documents; its own shares, written with `user` filled from the claim; its notes on
 * the tenant's documents, with `author` in its head bound to `Session.sub` (README "Writing through a role": a claim-fixed head
 * field, which no role may UPDATE, beside `doc`, bound to the claim only through Doc's join, which it may); the
 * tenant's documents it holds no share of (a negation reading a claim); the tenant's organization; and Tier whole. Both
 * are in the login `web`. The nightly `job`, in the login `ops`, writes Org whole and reads documents only as their
 * ids: the web login never writes Org, whatever claims it sets. The `admin`, a full role in `ops`, holds every relation
 * of the base whole, so every program over the base runs on it; it writes Org, Doc, Share, Note and Visit.
 */
export const docsInstall: InstallSpec = {
	base: docsBase,
	roles: [
		{
			name: "reader",
			entries: {
				Doc: query(
					rule(
						[of("Doc", { id, org, words }), of("Org", { id: org, plan })],
						{ id, org, words },
						{
							negations: [],
							comparisons: [{ left: plan, op: ">=", right: literal(1) }]
						}
					)
				),
				Tier: whole("Tier")
			},
			write: []
		},
		{
			name: "member",
			entries: {
				Doc: query(
					rule([of("Doc", { id, org: tenant, owner, words })], { id, owner, words }, none)
				),
				Share: query(
					rule(
						[of("Share", { doc, user }), of("Doc", { id: doc, org: tenant })],
						{ doc, user },
						none
					)
				),
				MyShare: query(rule([of("Share", { doc, user: subjectClaim })], { doc }, none)),
				MyNote: query(
					rule(
						[of("Note", { no, doc, author: subjectClaim }), of("Doc", { id: doc, org: tenant })],
						{ no, doc, author: subjectClaim },
						none
					)
				),
				Unshared: query(
					rule(
						[of("Doc", { id, org: tenant })],
						{ id },
						{
							negations: [[of("Share", { doc: id, user: subjectClaim })]],
							comparisons: []
						}
					)
				),
				Org: query(
					rule(
						[
							of("Org", { id: org, plan }),
							{ source: { kind: "context", name: "Tenant" }, fields: { org } }
						],
						{ org, plan },
						none
					)
				),
				Tier: whole("Tier")
			},
			write: ["Doc", "MyShare", "MyNote"]
		},
		{
			name: "job",
			entries: {
				Org: whole("Org"),
				Doc: query(rule([of("Doc", { id })], { id }, none))
			},
			write: ["Org"]
		},
		{
			name: "admin",
			entries: {
				Org: whole("Org"),
				Doc: whole("Doc"),
				Share: whole("Share"),
				Note: whole("Note"),
				Visit: whole("Visit"),
				Tier: whole("Tier")
			},
			write: ["Org", "Doc", "Share", "Note", "Visit"]
		}
	],
	logins: [
		{ name: "web", roles: ["reader", "member"] },
		{ name: "ops", roles: ["job", "admin"] }
	]
}

/**
 * The documents base's README-shaped worlds with the nightly `job` reading DocLinks beside its entries: every document's
 * id and organization, by two rules, one over every document and one over those of no negative word count, so the role
 * reads a union of rules, which a recursive read of it may not read in its step (README "A recursive rule joins
 * `self`": RecursionRefused, cause unionStep), its two uuid fields a pair a recursive read chains.
 */
export const docsUnionInstall: InstallSpec = {
	...docsInstall,
	roles: Arr.map(docsInstall.roles, (r) =>
		r.name === "job"
			? {
					...r,
					entries: {
						...r.entries,
						DocLinks: {
							kind: "query",
							rules: [
								rule([of("Doc", { id, org })], { id, org }, none),
								rule(
									[of("Doc", { id, org, words })],
									{ id, org },
									{
										negations: [],
										comparisons: [{ left: words, op: ">=", right: literal(0) }]
									}
								)
							]
						}
					}
				}
			: r
	)
}

/**
 * The documents base's README-shaped worlds over its one-share variant (docsOneShareBase): the member writing its own
 * shares through MyShare meets another user's share of a document, which MyShare hides, at the key on Share's `doc`.
 */
export const docsOneShareInstall: InstallSpec = { ...docsInstall, base: docsOneShareBase }

/**
 * The documents base's README-shaped worlds over its Level variant (docsLevelBase), the member reading PlanOrgs beside
 * its entries: the organizations on the plan its token's Level claim names, a rule matching Org's plan to a context
 * field of a contract.
 */
export const docsLevelInstall: InstallSpec = {
	base: docsLevelBase,
	roles: Arr.map(docsInstall.roles, (r) =>
		r.name === "member"
			? {
					...r,
					entries: {
						...r.entries,
						PlanOrgs: query(
							rule([of("Org", { id: org, plan: claim("Level", "plan") })], { org }, none)
						)
					}
				}
			: r
	),
	logins: docsInstall.logins
}

/** A variable of a Profile field, as the member's Profile entry binds it. */
const profiled = (field: string): Term => variable(`p_${field}`)

/**
 * The documents base's README-shaped worlds over its Profile variant (docsProfileBase), the member reading Profile
 * beside its entries: each organization on the plan its token's Profile claims, with every one of the Profile's claims,
 * so a read of it meets a claim of every type a context field takes; the organizations on that plan alone
 * (ProfileFiltered), which reads the badge, tier and plan claims in its filter and delivers none of them; and every
 * organization with the plan claim delivered beside it (ProfilePlan), a contract's claim read into an output column.
 */
export const docsProfileInstall: InstallSpec = {
	base: docsProfileBase,
	roles: Arr.map(docsInstall.roles, (r) =>
		r.name === "member"
			? {
					...r,
					entries: {
						...r.entries,
						Profile: query(
							rule(
								[
									of("Org", { id: org, plan }),
									{
										source: { kind: "context", name: "Profile" },
										fields: {
											ref: profiled("ref"),
											badge: profiled("badge"),
											small: profiled("small"),
											seats: profiled("seats"),
											big: profiled("big"),
											active: profiled("active"),
											tier: profiled("tier"),
											plan
										}
									}
								],
								{
									org,
									ref: profiled("ref"),
									badge: profiled("badge"),
									small: profiled("small"),
									seats: profiled("seats"),
									big: profiled("big"),
									active: profiled("active"),
									tier: profiled("tier"),
									plan
								},
								none
							)
						),
						ProfileFiltered: query(
							rule(
								[
									of("Org", { id: org, plan }),
									{
										source: { kind: "context", name: "Profile" },
										fields: { badge: profiled("badge"), tier: profiled("tier"), plan }
									}
								],
								{ org },
								none
							)
						),
						ProfilePlan: query(
							rule(
								[
									of("Org", { id: org }),
									{
										source: { kind: "context", name: "Profile" },
										fields: { plan: profiled("plan") }
									}
								],
								{ org, plan: profiled("plan") },
								none
							)
						)
					}
				}
			: r
	),
	logins: docsInstall.logins
}

/**
 * The documents base's README-shaped worlds with an `editor` beside them in the login `ops`: every fact outside an
 * entry the editor writes lies outside its world in one way only. It writes the tenant's documents (`org` filled from
 * the claim) and reads Doc whole beside them; it writes the organizations on a plan of at least one (a literal filter,
 * reading no context) and reads Org whole beside them; and it writes the notes of one author fixed by a literal
 * (`author` filled with "u_ed"), and holds no other note. So a document of another tenant, or any document under no
 * tenant claim, and an organization on the free plan, are outside the entry it writes yet visible through the whole
 * beside it, under its claims or under none; and another author's note is hidden from it, met at its key by a note it
 * writes. The member beside it writes its own shares.
 */
export const docsEditorInstall: InstallSpec = {
	base: docsBase,
	roles: [
		...docsInstall.roles,
		{
			name: "editor",
			entries: {
				TenantDoc: query(
					rule([of("Doc", { id, org: tenant, owner, words })], { id, owner, words }, none)
				),
				Doc: whole("Doc"),
				PlanOrg: query(
					rule(
						[of("Org", { id, plan })],
						{ id, plan },
						{
							negations: [],
							comparisons: [{ left: plan, op: ">=", right: literal(1) }]
						}
					)
				),
				Org: whole("Org"),
				EdNote: query(
					rule(
						[of("Note", { no, doc, author: { kind: "literal", value: "u_ed" } })],
						{ no, doc },
						none
					)
				)
			},
			write: ["TenantDoc", "PlanOrg", "EdNote"]
		}
	],
	logins: [
		{ name: "web", roles: ["reader", "member"] },
		{ name: "ops", roles: ["job", "admin", "editor"] }
	]
}

/**
 * The editor's worlds (docsEditorInstall) over the documents base's one-share variant: the member's own shares meet a
 * hidden share at the key on Share's `doc`, as in docsOneShareInstall, beside the editor's entries.
 */
export const docsOneShareEditorInstall: InstallSpec = {
	...docsEditorInstall,
	base: docsOneShareBase
}

/**
 * The documents base with every visit on a tier (Visit.tier, an id of the roster Tier), the one roster handle a stored
 * fact holds: a migration dropping a handle some visit holds is the removal VALIDATE refuses
 * (invalid/migrations.ts, migration:roster-removal-held).
 */
const docsTieredVisitsBase: BaseSpec = {
	...docsBase,
	name: "DocsTieredVisits",
	relations: Arr.map(docsBase.relations, (r) =>
		r.name === "Visit"
			? {
					...r,
					fields: [
						...r.fields,
						{ name: "tier", domain: { kind: "handle", closed: "Tier", members: ["Free", "Pro"] } }
					]
				}
			: r
	)
}

/**
 * The worlds a held roster handle is one action from (pg/world-model/inductive): over the tiered visits
 * (docsTieredVisitsBase), the `counter` writes LateVisit, the visits whose `seq` is at least one; the `keeper` holds
 * Visit and Tier whole. No role names a handle of Tier, so either may be dropped, and dropping one a
 * stored visit holds is migration:roster-removal-held. Both roles are in the login `ops`.
 */
export const docsHeldRosterInstall: InstallSpec = {
	base: docsTieredVisitsBase,
	roles: [
		{
			name: "counter",
			entries: {
				LateVisit: query(
					rule(
						[of("Visit", { no, seq, tier })],
						{ no, seq, tier },
						{ negations: [], comparisons: [{ left: seq, op: ">=", right: literal(1) }] }
					)
				)
			},
			write: ["LateVisit"]
		},
		{
			name: "keeper",
			entries: { Visit: whole("Visit"), Tier: whole("Tier") },
			write: []
		}
	],
	logins: [{ name: "ops", roles: ["counter", "keeper"] }]
}
