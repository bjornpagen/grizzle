import { constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import {
	act,
	claimsOf,
	doc1,
	docOf,
	endGen,
	exhaustive,
	memberClaims,
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

interface Case {
	readonly pool: 1 | 2
	readonly rival: "db" | "direct"
	readonly end: "commit" | "rollback"
	readonly words: number
	readonly stored: 0 | 1
}

const caseGen: Gen<Case> = (source) => ({
	pool: source.draw(poolSizeGen),
	rival: source.draw(
		weighted<Case["rival"]>([
			[1, constant("db")],
			[2, constant("direct")]
		])
	),
	end: source.draw(endGen),
	words: source.draw(int(0, 9)),
	stored: source.draw(element<Case["stored"]>([0, 1]))
})

/**
 * A key over facts outside the writer's world, met concurrently: under the documents base's one-share variant a
 * document holds at most one share, `key(on(Share, "doc"))` (fin.md §6, "at most one"), and ann and bob, signed in with
 * no tenant, each share the document through MyShare, which holds only their own shares. carl's share is stored when
 * the case says so, outside both worlds. bob writes through his Db or as a direct writer with his role and claims set
 * by hand. Serially every share but the first is refused at its statement by the key, whose refusal quotes no value
 * of the hidden share; concurrently the key still holds, and a writer may fail with a typed transient failure instead.
 * Every order of the moves is explored, with reduction. The oracle is the worlds model, judging every order.
 */
const race = (c: Case): WorldRace => {
	const bob: RaceSession =
		c.rival === "db"
			? {
					kind: "db",
					name: "bob",
					session: 1,
					ops: [
						act({
							kind: "apply",
							session: 1,
							strata: [[{ relation: "MyShare", kind: "insert", facts: [{ doc: doc1 }] }]],
							reads: []
						})
					]
				}
			: {
					kind: "direct",
					name: "bob",
					login: "web",
					isolation: "serializable",
					statements: [
						setRole("member"),
						claimsOf(memberClaims("u_bob", noTenant)),
						{ kind: "insert", relation: "Share", fact: { doc: doc1, user: "u_bob" } }
					],
					end: c.end
				}
	return {
		name: "two writers meet a key over shares outside their worlds",
		install: docsOneShareInstall,
		reality: new Map([
			["Org", [{ id: orgA, plan: 1 }]],
			["Doc", [docOf(doc1, orgA, "u_carl", c.words)]],
			["Share", c.stored === 1 ? [{ doc: doc1, user: "u_carl" }] : []],
			["Note", []]
		]),
		setup: [
			openDb("member", memberToken("u_ann", noTenant)),
			openDb("member", memberToken("u_bob", noTenant))
		],
		sessions: [
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
					}),
					act({ kind: "read", session: 0, relation: "MyShare", via: { kind: "execute" } })
				]
			},
			bob
		],
		poolSize: c.pool,
		strategy: exhaustive
	}
}

worldRaceSuite({
	file: "worlds race: a key over facts outside the world",
	test: "writers meeting a key over facts outside their worlds never break it",
	draw: caseGen,
	race,
	required: ["ended: commit", "ended: refusal", "overlapping"],
	kept: []
})
