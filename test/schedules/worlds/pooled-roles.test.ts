import { type Gen, int } from "@grizzle/testing/gen"
import { type Nature, type PctSchedule, pctSchedule } from "@grizzle/testing/interleave"
import {
	act,
	claimsOf,
	doc1,
	doc7,
	docOf,
	endGen,
	interruptionGen,
	memberClaims,
	memberToken,
	openDb,
	orgA,
	orgB,
	pctDepth,
	pctOf,
	poolSizeGen,
	setRole,
	tenantOf,
	worldRaceSuite
} from "#test/schedules/worlds/support.ts"
import type { RaceOp, WorldRace } from "#test/support/schedules/worlds.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"

const SESSIONS = ["ann", "reader", "dan"] as const

type Session = (typeof SESSIONS)[number]

/** The race's moves: ann's seven, the reader's four, and dan's BEGIN, three statements and end. */
const MOVES = 16

interface Case {
	readonly pool: 1 | 2
	readonly interruption: "wait" | "interrupt"
	readonly end: "commit" | "rollback"
	readonly words: number
	readonly schedule: PctSchedule<Session>
}

const caseGen: Gen<Case> = (source) => ({
	pool: source.draw(poolSizeGen),
	interruption: source.draw(interruptionGen),
	end: source.draw(endGen),
	words: source.draw(int(0, 9)),
	schedule: source.draw(pctSchedule(SESSIONS, pctDepth, MOVES))
})

/** A probe of a Db session's pooled connection between its transactions. */
const probe = (session: number): RaceOp => ({ kind: "probe", session })

/**
 * Roles of one login interleaved on its pool, across every way a transaction ends: the signed-out reader and ann, a
 * member of tenant A, are both in the login `web`, whose pool has one connection (or two, when the case says so), and
 * the pooled connection is probed after every transaction. ann's insert of a document meets dan's direct insert of the
 * same id, still uncommitted: it waits, and the case's interruption point either waits it out (it commits after dan
 * rolls back, is refused by the key after dan commits, or fails transiently) or interrupts the call there, mid-flight.
 * ann then shares a document (committed) and writes a note on a document outside her tenant (refused). Whatever ended
 * the transaction before, each probe must read the login's own role with no claims and no transaction open: claims and
 * roles never cross transactions on a pooled connection. The probe right after a call interrupted mid-flight is the one
 * place it is checked after an interruption: the worlds model's serial drivers never have a call in flight to interrupt
 * (pg/world-model/pool's connection situations). The moves are ordered by the case's PCT schedule.
 *
 * Plants (main's test phase): worlds-pool-claims-outlive-transaction.patch.
 */
const race = (c: Case, nature: Nature): WorldRace => ({
	name: "a reader and a member interleave on one pooled connection",
	install: docsInstall,
	reality: new Map([
		[
			"Org",
			[
				{ id: orgA, plan: 1 },
				{ id: orgB, plan: 1 }
			]
		],
		["Doc", [docOf(doc1, orgB, "u_eve", 3)]],
		["Share", []],
		["Note", []]
	]),
	setup: [
		openDb("reader", { kind: "none" }),
		openDb("member", memberToken("u_ann", tenantOf(orgA)))
	],
	sessions: [
		{
			kind: "db",
			name: "ann",
			session: 1,
			ops: [
				probe(1),
				{
					kind: "act",
					action: {
						kind: "apply",
						session: 1,
						strata: [
							[
								{
									relation: "Doc",
									kind: "insert",
									facts: [{ id: doc7, owner: "u_ann", words: c.words }]
								}
							]
						],
						reads: []
					},
					blocked: c.interruption
				},
				probe(1),
				act({
					kind: "apply",
					session: 1,
					strata: [[{ relation: "MyShare", kind: "insert", facts: [{ doc: doc1 }] }]],
					reads: []
				}),
				probe(1),
				act({
					kind: "apply",
					session: 1,
					strata: [
						[{ relation: "MyNote", kind: "insert", facts: [{ no: 5, doc: doc1, author: "u_ann" }] }]
					],
					reads: []
				}),
				probe(1)
			]
		},
		{
			kind: "db",
			name: "reader",
			session: 0,
			ops: [
				act({ kind: "read", session: 0, relation: "Doc", via: { kind: "execute" } }),
				probe(0),
				act({ kind: "read", session: 0, relation: "Tier", via: { kind: "execute" } }),
				probe(0)
			]
		},
		{
			kind: "direct",
			name: "dan",
			login: "web",
			isolation: "serializable",
			statements: [
				setRole("member"),
				claimsOf(memberClaims("u_dan", tenantOf(orgA))),
				{ kind: "insert", relation: "Doc", fact: docOf(doc7, orgA, "u_dan", (c.words + 1) % 10) }
			],
			end: c.end
		}
	],
	poolSize: c.pool,
	strategy: pctOf(c.schedule, MOVES, nature)
})

worldRaceSuite({
	file: "worlds race: roles of one login on a pooled connection",
	test: "roles of one login interleaved on its pool leave no role, claims or transaction on the connection, however a transaction ends",
	draw: caseGen,
	race,
	required: [
		"ended: commit",
		"ended: refusal",
		"ended: interruption",
		"probed after: interruption",
		"pool of 1",
		"blocked"
	],
	kept: []
})
