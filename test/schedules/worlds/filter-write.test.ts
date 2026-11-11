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
	openDb,
	orgA,
	poolSizeGen,
	setRole,
	tenantOf,
	worldRaceSuite
} from "#test/schedules/worlds/support.ts"
import type { RaceSession, WorldRace } from "#test/support/schedules/worlds.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"

/** A case: the environment's pool size and the rival's ending and kind, and the values the race writes. */
interface Case {
	readonly pool: 1 | 2
	readonly rival: "db" | "direct"
	readonly end: "commit" | "rollback"
	readonly words: number
	readonly no: number
	readonly reader: "none" | "cat reads MyNote"
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
	no: source.draw(int(1, 9)),
	reader: source.draw(element<Case["reader"]>(["none", "cat reads MyNote"]))
})

/** The third member's read of MyNote, when the case draws one. */
const reader = (c: Case): ReadonlyArray<RaceSession> =>
	c.reader === "cat reads MyNote"
		? [
				{
					kind: "db",
					name: "cat",
					session: 2,
					ops: [act({ kind: "read", session: 2, relation: "MyNote", via: { kind: "execute" } })]
				}
			]
		: []

/**
 * An insert through a writable entry races a write to the relation its filter reads: ann's note on a document of her
 * tenant goes through MyNote, whose filter reads Doc (the document's organization is the claimed tenant), while bob,
 * a member of the same tenant, deletes the document, through his Doc entry or as a direct writer who sets his role and
 * claims by hand. Notes need their document (a containment), so serially either the note lands and the deletion is
 * refused by that law, or the deletion lands and the note is outside ann's world; a third member may read MyNote
 * meanwhile. ann's write reads MyNote back, as of the state it committed. Every order of the moves is explored, with
 * reduction.
 *
 * Plants (main's test phase): worlds-isolation-row-security-off.patch.
 */
const race = (c: Case): WorldRace => {
	const deletion: RaceSession =
		c.rival === "db"
			? {
					kind: "db",
					name: "bob",
					session: 1,
					ops: [
						act({
							kind: "apply",
							session: 1,
							strata: [
								[
									{
										relation: "Doc",
										kind: "delete",
										facts: [{ id: doc1, owner: "u_ann", words: c.words }]
									}
								]
							],
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
						claimsOf(memberClaims("u_bob", tenantOf(orgA))),
						{ kind: "delete", relation: "Doc", key: { id: doc1 } }
					],
					end: c.end
				}
	return {
		name: "a note through MyNote races the deletion of its document",
		install: docsInstall,
		reality: new Map([
			["Org", [{ id: orgA, plan: 1 }]],
			["Doc", [docOf(doc1, orgA, "u_ann", c.words)]],
			["Share", []],
			["Note", []]
		]),
		setup: [
			openDb("member", memberToken("u_ann", tenantOf(orgA))),
			openDb("member", memberToken("u_bob", tenantOf(orgA))),
			openDb("member", memberToken("u_cat", tenantOf(orgA)))
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
						strata: [
							[
								{
									relation: "MyNote",
									kind: "insert",
									facts: [{ no: c.no, doc: doc1, author: "u_ann" }]
								}
							]
						],
						reads: ["MyNote"]
					})
				]
			},
			deletion,
			...reader(c)
		],
		poolSize: c.pool,
		strategy: exhaustive
	}
}

worldRaceSuite({
	file: "worlds race: an entry write against its filter's relation",
	test: "a write through an entry racing a write to the relation its filter reads is one serial order's outcome",
	draw: caseGen,
	race,
	required: ["ended: commit", "ended: refusal", "overlapping", "pool of 1", "pool of 2"],
	kept: []
})
