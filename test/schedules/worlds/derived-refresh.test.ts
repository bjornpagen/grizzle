import { constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { type Nature, type PctSchedule, pctSchedule } from "@grizzle/testing/interleave"
import { Array as Arr } from "effect"
import {
	act,
	claimsOf,
	doc1,
	doc2,
	docOf,
	endGen,
	memberClaims,
	memberToken,
	openDb,
	orgA,
	pctDepth,
	pctOf,
	poolSizeGen,
	raceMoves,
	setRole,
	tenantOf,
	worldRaceSuite
} from "#test/schedules/worlds/support.ts"
import type { RaceSession, WorldRace } from "#test/support/schedules/worlds.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"

/** The race's environment: the pool, who deletes and how a direct deletion ends, and who refreshes. */
interface Environment {
	readonly pool: 1 | 2
	readonly deleter: "db" | "direct"
	readonly end: "commit" | "rollback"
	readonly refreshers: "the job alone" | "the job and ann"
}

/** A case: the environment, and a PCT schedule over the sessions it races, drawn among their moves. */
interface Case extends Environment {
	readonly schedule: PctSchedule<string>
}

/**
 * Deletion racing a read and a refresh of a derived relation: a member of tenant A deletes a document, through its Doc
 * entry or as a direct writer, while ann reads OrgDocs (each organization's documents, a stored query) before and
 * after, and the nightly job refreshes it; ann refreshes it too when the case says so, so two refreshes may meet. A
 * derived relation moves only at a refresh: every read shows it as of the last refresh in the serial order, and a
 * refresh meeting another is a typed transient failure. The moves are ordered by the case's PCT schedule.
 *
 * Plants (main's test phase): worlds-deletion-keeps-facts.patch.
 */
const racedOf = (c: Environment): Arr.NonEmptyReadonlyArray<RaceSession> => {
	const deleter: RaceSession =
		c.deleter === "db"
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
										facts: [{ id: doc1, owner: "u_ann", words: 1 }]
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
	const annRefresh: ReadonlyArray<RaceSession> =
		c.refreshers === "the job and ann"
			? [
					{
						kind: "db",
						name: "ann refreshes",
						session: 3,
						ops: [act({ kind: "refresh", session: 3, relation: "OrgDocs" })]
					}
				]
			: []
	return [
		deleter,
		{
			kind: "db",
			name: "ann",
			session: 0,
			ops: [
				act({ kind: "read", session: 0, relation: "OrgDocs", via: { kind: "execute" } }),
				act({ kind: "read", session: 0, relation: "Doc", via: { kind: "execute" } }),
				act({ kind: "read", session: 0, relation: "OrgDocs", via: { kind: "execute" } })
			]
		},
		{
			kind: "db",
			name: "job",
			session: 2,
			ops: [act({ kind: "refresh", session: 2, relation: "OrgDocs" })]
		},
		...annRefresh
	]
}

const caseGen: Gen<Case> = (source) => {
	const environment: Environment = {
		pool: source.draw(poolSizeGen),
		deleter: source.draw(
			weighted<Environment["deleter"]>([
				[1, constant("db")],
				[2, constant("direct")]
			])
		),
		end: source.draw(endGen),
		refreshers: source.draw(
			element<Environment["refreshers"]>(["the job alone", "the job and ann"])
		)
	}
	const raced = racedOf(environment)
	return {
		...environment,
		schedule: source.draw(
			pctSchedule(
				Arr.map(raced, (session) => session.name),
				pctDepth,
				raceMoves(raced)
			)
		)
	}
}

const race = (c: Case, nature: Nature): WorldRace => {
	const raced = racedOf(c)
	return {
		name: "a deletion races a read and a refresh of OrgDocs",
		install: docsInstall,
		reality: new Map([
			["Org", [{ id: orgA, plan: 1 }]],
			["Doc", [docOf(doc1, orgA, "u_ann", 1), docOf(doc2, orgA, "u_ann", 2)]],
			["Share", []],
			["Note", []]
		]),
		setup: [
			openDb("member", memberToken("u_ann", tenantOf(orgA))),
			openDb("member", memberToken("u_bob", tenantOf(orgA))),
			openDb("job", { kind: "none" }),
			openDb("member", memberToken("u_ann", tenantOf(orgA)))
		],
		sessions: raced,
		poolSize: c.pool,
		strategy: pctOf(c.schedule, raceMoves(raced), nature)
	}
}

worldRaceSuite({
	file: "worlds race: a deletion against a derived relation's read and refresh",
	test: "a deletion racing reads and refreshes of a derived relation shows the relation as of a serial order's last refresh",
	draw: caseGen,
	race,
	required: ["ended: commit", "observed: rows", "observed: ok"],
	kept: []
})
