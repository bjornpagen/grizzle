import { constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import {
	act,
	claimsOf,
	doc7,
	docOf,
	endGen,
	exhaustive,
	memberClaims,
	memberToken,
	openDb,
	orgA,
	orgB,
	poolSizeGen,
	setRole,
	tenantOf,
	worldRaceSuite
} from "#test/schedules/worlds/support.ts"
import type { RaceSession, WorldRace } from "#test/support/schedules/worlds.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"

interface Case {
	readonly pool: 1 | 2
	readonly rival: "db" | "direct"
	readonly end: "commit" | "rollback"
	readonly conflict: "none" | "nothing" | "update"
	readonly annWords: number
	readonly danWords: number
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
	conflict: source.draw(
		weighted<Case["conflict"]>([
			[2, constant("none")],
			[1, constant("nothing")],
			[1, constant("update")]
		])
	),
	annWords: source.draw(int(0, 9)),
	danWords: source.draw(int(0, 9))
})

/**
 * A key collision with a fact hidden from the writer, inserted concurrently by another world: ann, a member of tenant
 * A, inserts a document through her Doc entry while dan, a member of tenant B, inserts a document with the same id
 * through his, or as a direct writer with his role and claims set by hand, whose INSERT may resolve a conflict with ON
 * CONFLICT DO NOTHING or DO UPDATE, which row security must keep from reaching the hidden fact. Neither world holds the other's document,
 * yet the primary key is global: serially the second insert is refused by Doc's primary-key law, its witness the key
 * the writer submitted and nothing of the hidden fact, and concurrently PostgreSQL may refuse one writer instead with
 * a typed transient failure. Every order of the moves is explored, with reduction.
 *
 * Plants (main's test phase): worlds-isolation-row-security-off.patch.
 */
const race = (c: Case): WorldRace => {
	const rival: RaceSession =
		c.rival === "db"
			? {
					kind: "db",
					name: "dan",
					session: 1,
					ops: [
						act({
							kind: "apply",
							session: 1,
							strata: [
								[
									{
										relation: "Doc",
										kind: "insert",
										facts: [{ id: doc7, owner: "u_dan", words: c.danWords }]
									}
								]
							],
							reads: []
						})
					]
				}
			: {
					kind: "direct",
					name: "dan",
					login: "web",
					isolation: "serializable",
					statements: [
						setRole("member"),
						claimsOf(memberClaims("u_dan", tenantOf(orgB))),
						c.conflict === "none"
							? { kind: "insert", relation: "Doc", fact: docOf(doc7, orgB, "u_dan", c.danWords) }
							: {
									kind: "insert-on-conflict",
									relation: "Doc",
									fact: docOf(doc7, orgB, "u_dan", c.danWords),
									onConflict:
										c.conflict === "nothing"
											? { kind: "nothing" }
											: { kind: "update", where: { kind: "none" } }
								}
					],
					end: c.end
				}
	return {
		name: "two worlds insert one document id",
		install: docsInstall,
		reality: new Map([
			[
				"Org",
				[
					{ id: orgA, plan: 1 },
					{ id: orgB, plan: 2 }
				]
			],
			["Doc", []],
			["Share", []],
			["Note", []]
		]),
		setup: [
			openDb("member", memberToken("u_ann", tenantOf(orgA))),
			openDb("member", memberToken("u_dan", tenantOf(orgB)))
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
									relation: "Doc",
									kind: "insert",
									facts: [{ id: doc7, owner: "u_ann", words: c.annWords }]
								}
							]
						],
						reads: []
					}),
					act({ kind: "read", session: 0, relation: "Doc", via: { kind: "execute" } })
				]
			},
			rival
		],
		poolSize: c.pool,
		strategy: exhaustive
	}
}

worldRaceSuite({
	file: "worlds race: a key collision with a hidden fact",
	test: "a key collision with a fact another world inserts concurrently is refused by the key's law or fails transiently",
	draw: caseGen,
	race,
	required: ["ended: commit", "ended: refusal", "observed: invariant-rejected", "overlapping"],
	kept: []
})
