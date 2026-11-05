import { constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import {
	act,
	doc1,
	docOf,
	endGen,
	exhaustive,
	memberToken,
	noTenant,
	openDb,
	orgA,
	poolSizeGen,
	setRole,
	worldRaceSuite
} from "#test/schedules/worlds/support.ts"
import type { RaceSession, WorldRace } from "#test/support/schedules/worlds.ts"
import { docsOneShareInstall } from "#test/support/worlds/model/bases/docs.ts"
import type { DirectStatement, SettingScope } from "#test/support/worlds/model/types.ts"

interface Case {
	readonly pool: 1 | 2
	readonly end: "commit" | "rollback"
	readonly claimed: "own" | "another"
	readonly scope: SettingScope
	readonly reads: "writes blind" | "reads its shares first"
	readonly stored: 0 | 1
	readonly words: number
}

const caseGen: Gen<Case> = (source) => ({
	pool: source.draw(poolSizeGen),
	end: source.draw(endGen),
	claimed: source.draw(
		weighted<Case["claimed"]>([
			[2, constant("own")],
			[1, constant("another")]
		])
	),
	scope: source.draw(
		weighted<Case["scope"]>([
			[3, constant("transaction")],
			[1, constant("session")]
		])
	),
	reads: source.draw(element<Case["reads"]>(["writes blind", "reads its shares first"])),
	stored: source.draw(element<Case["stored"]>([0, 1])),
	words: source.draw(int(0, 9))
})

/**
 * Direct writers with hand-set claims racing grizzle writes: dan logs in as the login `web`, sets the role `member`
 * and sets `grizzle.claims` by hand, for the transaction or the session, claiming himself or another subject, reads
 * his shares when the case says so, and inserts his share of a document straight into the Share table, where row
 * security admits it only when the claims make it his. ann shares the same document through her Db meanwhile, and,
 * under the documents base's one-share variant, the document holds at most one share (`key(on(Share, "doc"))`), eve's
 * when the case says so. Serially the direct insert is refused with 42501 outside its world, every share but the first
 * is refused at its statement by the key (23505 naming its constraint for dan), and concurrently a writer may fail
 * with a typed transient failure; a carl reads his own shares, which no
 * other writer's claims ever reach. Every order of the moves is explored, with reduction.
 */
const race = (c: Case): WorldRace => {
	const reads: ReadonlyArray<DirectStatement> =
		c.reads === "reads its shares first"
			? [{ kind: "select-view", role: "member", relation: "MyShare", filter: { kind: "none" } }]
			: []
	const dan: RaceSession = {
		kind: "direct",
		name: "dan",
		login: "web",
		isolation: "serializable",
		statements: [
			setRole("member"),
			{
				kind: "set-claims",
				setting: {
					kind: "facts",
					facts: { Session: { sub: c.claimed === "own" ? "u_dan" : "u_mallory" } },
					scope: c.scope
				}
			},
			...reads,
			{ kind: "insert", relation: "Share", fact: { doc: doc1, user: "u_dan" } }
		],
		end: c.end
	}
	return {
		name: "a direct writer with hand-set claims races a grizzle write",
		install: docsOneShareInstall,
		reality: new Map([
			["Org", [{ id: orgA, plan: 1 }]],
			["Doc", [docOf(doc1, orgA, "u_eve", c.words)]],
			["Share", c.stored === 1 ? [{ doc: doc1, user: "u_eve" }] : []],
			["Note", []]
		]),
		setup: [
			openDb("member", memberToken("u_ann", noTenant)),
			openDb("member", memberToken("u_carl", noTenant))
		],
		sessions: [
			dan,
			{
				kind: "db",
				name: "ann",
				session: 0,
				ops: [
					act({
						kind: "apply",
						session: 0,
						strata: [[{ relation: "MyShare", kind: "insert", facts: [{ doc: doc1 }] }]],
						reads: []
					})
				]
			},
			{
				kind: "db",
				name: "carl",
				session: 1,
				ops: [act({ kind: "read", session: 1, relation: "MyShare", via: { kind: "execute" } })]
			}
		],
		poolSize: c.pool,
		strategy: exhaustive
	}
}

worldRaceSuite({
	file: "worlds race: direct writers with hand-set claims",
	test: "concurrent writers through worlds keep every law and fail only with typed transient failures",
	draw: caseGen,
	race,
	required: ["ended: commit", "ended: refusal", "observed: refused", "overlapping"]
})
