import { Array as Arr } from "effect"
import { textDomain } from "#test/support/worlds/model/text.ts"
import type {
	BaseSpec,
	EntrySpec,
	FieldDomain,
	InstallSpec,
	LawSpec,
	Occurrence,
	Rule,
	Term
} from "#test/support/worlds/model/types.ts"

/** A subject: the session's user, a document's owner, a share's user and a note's author. */
const subject: FieldDomain = textDomain("^u_[a-z]{1,8}$", "u")
const uuid: FieldDomain = { kind: "uuid" }
const integer: FieldDomain = { kind: "integer", bits: 32 }

/**
 * The documents base: organizations, their documents, the shares of a document with a user, the notes on a document,
 * and visits, each nothing but its two identity numbers, a bigserial key and a serial, a relation whose every field is
 * serial, so an addition written whole may carry no field (the unit relation), and one carrying one of its serial
 * fields and not the other is refused; with laws of each kind a refusal under a world reaches. A note's document
 * exists (a foreign key); an organization's documents differ in their word counts (a candidate key, a unique index); a
 * document has at most two shares (a capacity, a residual law whose function withholds its witness keys from a role
 * that does not hold Doc whole); a plan is at most five (a row check), and lies in 0..9 by its contract Plan (a domain
 * CHECK), so a plan of six to nine breaks the check and one past nine the domain. Doc and Note are mutable, so a put of
 * a document or a note replaces it in place; a note's `no` is a bigserial key.
 *
 * Two contexts read the verified token: Session { sub } from the payload's top level, and Tenant { org, seats } from
 * its `t` claim object, seats an int8 a token carries as a JSON number or a string of digits, so a token's wild forms
 * reach an unsafe integer and an int8 that is no digits. The closed roster Tier is read by no field, so an entry may match a relation no write targets; the
 * derived relation OrgDocs, each organization's documents, is a stored query an entry may filter by, as of its last
 * refresh.
 */
export const docsBase: BaseSpec = {
	name: "Docs",
	closed: [{ name: "Tier", members: ["Free", "Pro"] }],
	relations: [
		{
			name: "Org",
			fields: [
				{ name: "id", domain: uuid },
				{ name: "plan", domain: { kind: "contract", name: "Plan", bits: 32, min: 0, max: 9 } }
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
			mutability: "immutable"
		},
		{
			name: "Note",
			fields: [
				{ name: "no", domain: { kind: "serial", bits: 64 } },
				{ name: "doc", domain: uuid },
				{ name: "author", domain: subject }
			],
			key: ["no"],
			mutability: "mutable"
		},
		{
			name: "Visit",
			fields: [
				{ name: "no", domain: { kind: "serial", bits: 64 } },
				{ name: "seq", domain: { kind: "serial", bits: 32 } }
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
			kind: "capacity",
			target: { relation: "Doc", fields: ["id"], where: {} },
			source: { relation: "Share", fields: ["doc"], where: {} },
			weight: { kind: "count" },
			low: 0n,
			high: 2n
		},
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
	],
	derived: [
		{
			name: "OrgDocs",
			rules: [
				{
					matches: [
						{
							source: { kind: "ordinary", name: "Doc" },
							fields: { id: { kind: "var", name: "doc" }, org: { kind: "var", name: "org" } }
						}
					],
					negations: [],
					comparisons: [],
					head: { org: { kind: "var", name: "org" }, doc: { kind: "var", name: "doc" } }
				}
			]
		}
	]
}

/**
 * The documents base with at most one share per document: its capacity on Doc's shares bounded above by one, which the
 * law model specializes to a unique index on Share's `doc` (host.ts atMostOne). A role writing its own shares through a
 * query entry meets another user's share of the document, hidden from it, at that index: its precheck's unique probe
 * refuses the write on the capacity's law, with the document the role submitted.
 */
const docsOneShareBase: BaseSpec = {
	...docsBase,
	name: "DocsOneShare",
	laws: Arr.map(docsBase.laws, (law): LawSpec =>
		law.kind === "capacity" ? { ...law, high: 1n } : law
	)
}

/** Every documents base a generated installation is drawn over. */
export const docsBases: Arr.NonEmptyReadonlyArray<BaseSpec> = [docsBase, docsOneShareBase]

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
 * tenant's documents it holds no share of (a negation reading a claim); the tenant's organization; Tier whole; and
 * OrgDocs whole, which it refreshes. Both are in the login `web`. The nightly `job`, in the login `ops`, writes Org
 * whole, reads documents only as their ids, and refreshes OrgDocs: the web login never writes Org, whatever claims it
 * sets. The `admin`, a full role in `ops`, holds every relation of the base whole, so every program over the base runs
 * on it; it writes Org, Doc, Share, Note and Visit, and refreshes OrgDocs.
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
			write: [],
			refresh: []
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
				Tier: whole("Tier"),
				OrgDocs: whole("OrgDocs")
			},
			write: ["Doc", "MyShare", "MyNote"],
			refresh: ["OrgDocs"]
		},
		{
			name: "job",
			entries: {
				Org: whole("Org"),
				Doc: query(rule([of("Doc", { id })], { id }, none)),
				OrgDocs: whole("OrgDocs")
			},
			write: ["Org"],
			refresh: ["OrgDocs"]
		},
		{
			name: "admin",
			entries: {
				Org: whole("Org"),
				Doc: whole("Doc"),
				Share: whole("Share"),
				Note: whole("Note"),
				Visit: whole("Visit"),
				Tier: whole("Tier"),
				OrgDocs: whole("OrgDocs")
			},
			write: ["Org", "Doc", "Share", "Note", "Visit"],
			refresh: ["OrgDocs"]
		}
	],
	logins: [
		{ name: "web", roles: ["reader", "member"] },
		{ name: "ops", roles: ["job", "admin"] }
	]
}

/**
 * The documents base's README-shaped worlds over its one-share variant (docsOneShareBase): the member writing its own
 * shares through MyShare meets another user's share of a document, which MyShare hides, at the capacity's unique index.
 * A witness state over it offers the hidden capacity collision (fact:hidden-capacity-collision).
 */
export const docsOneShareInstall: InstallSpec = { ...docsInstall, base: docsOneShareBase }

/**
 * The documents base's README-shaped worlds with an `editor` beside them in the login `ops`: every fact outside an
 * entry the editor writes lies outside its world in one way only. It writes the tenant's documents (`org` filled from
 * the claim) and reads Doc whole beside them; it writes the organizations on a plan of at least one (a literal filter,
 * reading no context) and reads Org whole beside them; and it writes the notes of one author fixed by a literal
 * (`author` filled with "u_ed"), and holds no other note. So a document of another tenant, or any document under no
 * tenant claim, and an organization on the free plan, are outside the entry it writes yet visible through the whole
 * beside it, under its claims or under none; and another author's note is hidden from it, met at its key by a note it
 * writes. The member beside it writes its own shares under the capacity's residual law, whose witness it does not hold.
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
			write: ["TenantDoc", "PlanOrg", "EdNote"],
			refresh: []
		}
	],
	logins: [
		{ name: "web", roles: ["reader", "member"] },
		{ name: "ops", roles: ["job", "admin", "editor"] }
	]
}

/**
 * The editor's worlds (docsEditorInstall) over the documents base's one-share variant: the member's own shares meet a
 * hidden share at the capacity's unique index, as in docsOneShareInstall, beside the editor's entries.
 */
export const docsOneShareEditorInstall: InstallSpec = {
	...docsEditorInstall,
	base: docsOneShareBase
}

/**
 * The documents base's README-shaped worlds with two roles beside them in the login `ops`, each writing Visit through
 * one of the query entries the README names for serial columns ("Writing through a role"), since a role writes a
 * relation through one entry at most: the `visitor`'s Visits, both of its serials, an entry whose every carried field
 * is serial, so an insert through it may leave both out and carry no field (the unit relation); and the `counter`'s
 * LateVisit, the visits whose `seq` is at least one, a filter reading a serial field, so every fact inserted through it
 * carries `seq` and may leave out `no`.
 */
export const docsVisitsInstall: InstallSpec = {
	base: docsBase,
	roles: [
		...docsInstall.roles,
		{
			name: "visitor",
			entries: { Visits: query(rule([of("Visit", { no, seq })], { no, seq }, none)) },
			write: ["Visits"],
			refresh: []
		},
		{
			name: "counter",
			entries: {
				LateVisit: query(
					rule(
						[of("Visit", { no, seq })],
						{ no, seq },
						{ negations: [], comparisons: [{ left: seq, op: ">=", right: literal(1) }] }
					)
				)
			},
			write: ["LateVisit"],
			refresh: []
		}
	],
	logins: [
		{ name: "web", roles: ["reader", "member"] },
		{ name: "ops", roles: ["job", "admin", "visitor", "counter"] }
	]
}
