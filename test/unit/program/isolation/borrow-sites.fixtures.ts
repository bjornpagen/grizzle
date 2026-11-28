/**
 * What borrow-sites.test.ts reads: its logins, compiled for READ COMMITTED as generate compiles them, and each named
 * member's proof under the borrow rules over the installation the IR alone gives (program/isolation/borrows.ts
 * borrowInstallationOf).
 */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type MemberBorrows, memberBorrows } from "#compiler/analysis/isolation/borrows.ts"
import type { Borrow } from "#compiler/core/certificate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { borrowInstallationOf } from "#compiler/program/isolation/borrows.ts"
import { readCommittedChanges, variantsEntries } from "#compiler/program/workload/change.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { natural, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	context,
	login,
	on,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { succeeded } from "#test/support/assert.ts"
import { changeLogin } from "#test/support/change-login.ts"

/**
 * A case: a learner's answer in a sitting, its session a row of the learner's unit (keyed by child first) or a fact
 * outside every unit (keyed by stage first); or metis's operator permission (MR-OPS-GAPS G5), a grant read at the person
 * the signed-in clerk's account holds.
 */
export type Case =
	| { readonly kind: "sitting"; readonly session: (typeof SESSIONS)[number] }
	| { readonly kind: "grant" }

/** Where a sitting's session sits: under the learner's unit, keyed by child first, or outside every unit. */
const SESSIONS = ["under Learner", "outside every unit"] as const

export const caseGen: Gen<Case> = (s) =>
	s.draw(boolean) ? { kind: "grant" } : { kind: "sitting", session: s.draw(element(SESSIONS)) }

/** A child's unit, and a package's. */
const Learner = unit("Learner", { child: int4 })
const Package = unit("Package", { package: int4 })

/**
 * A sitting's login: TestSession (child, stage, package), the package a learner's stage delivers, keyed by child first
 * under Learner or by stage first outside every unit, which an enrolment inserts; Node (package, path), a package's
 * documents under Package, which an author inserts; and Attempt (child, stage, path) under Learner, which the learner's
 * `answer` inserts from its parameters where its stage's package holds the document: a read of Node at the package the
 * read of TestSession at (child, stage) finds.
 */
const sittingValue = (session: (typeof SESSIONS)[number]) => {
	const TestSession = relation(
		"TestSession",
		{ child: int4, stage: int4, package: int4 },
		session === "under Learner" ? ["child", "stage"] : ["stage", "child"]
	)
	const Node = relation("Node", { package: int4, path: int4 }, ["package", "path"])
	const Attempt = relation("Attempt", { child: int4, stage: int4, path: int4 }, [
		"child",
		"stage",
		"path"
	])
	const Sitting = schema("Sitting", [TestSession, Node, Attempt], [Learner, Package])
	const author = role(Sitting, "author", { Node }, { insert: ["Node"] })
	const enrolment = role(Sitting, "enrolment", { TestSession }, { insert: ["TestSession"] })
	const learner = role(Sitting, "learner", { TestSession, Node, Attempt }, { insert: ["Attempt"] })
	const l = learner.relations
	const answer = ChangeSet.empty(learner).insert(
		l.Attempt,
		query(learner).rule((r) => {
			const child = r.param("child", int4)
			const stage = r.param("stage", int4)
			const path = r.param("path", int4)
			const { package: pkg } = v(l.TestSession, "s")
			return r
				.match(l.TestSession, { child, stage, package: pkg })
				.match(l.Node, { package: pkg, path })
				.find({ child, stage, path })
		})
	)
	return login(Sitting, "app", [author, enrolment, learner], {
		workload: [workload(learner, { answer })]
	})
}

/**
 * metis's operator permission as MR-OPS-GAPS's mini repro states it: Account (clerk → person) and Grant (person,
 * program), which an admin inserts; Origin (number, origin) contained in Item (number); and `plain`'s `assignPlain`,
 * inserting Origin from its parameters where the signed-in clerk's account's person holds the grant "assign": a read of
 * Grant at the person the read of Account at the session's clerk finds and the constant program.
 */
const grantValue = () => {
	const Clerk = str.regex("^user_[0-9A-Za-z]{1,64}$")
	const Program = str.regex("^[a-z]{1,16}$")
	const Session = context("Session", { sub: Clerk })
	const Account = relation("Account", { clerk: Clerk, person: natural }, ["clerk"])
	const Grant = relation("Grant", { person: natural, program: Program }, ["person", "program"])
	const Item = relation("Item", { number: natural }, ["number"])
	const Origin = relation("Origin", { number: natural, origin: natural }, ["number"])
	const relations = { Account, Grant, Item, Origin } as const
	const Probe = schema(
		"PolicedProbe",
		[Account, Grant, Item, Origin],
		[contained(on(Origin, "number"), on(Item, "number"))]
	)
	const admin = role(Probe, "admin", relations, { insert: ["Account", "Grant", "Item"] })
	const plain = role(Probe, "plain", relations, { insert: ["Origin"], contexts: [Session] })
	const p = plain.relations
	const assignPlain = ChangeSet.empty(plain).insert(
		p.Origin,
		query(plain).rule((r) => {
			const { sub } = v(Session, "s")
			const { person } = v(p.Account, "a")
			return r
				.match(Session, { sub })
				.match(p.Account, { clerk: sub, person })
				.match(p.Grant, { person, program: "assign" })
				.find({ number: r.param("number", natural), origin: r.param("origin", natural) })
		})
	)
	return login(Probe, "probe_app", [admin, plain], {
		workload: [workload(plain, { assignPlain })]
	})
}

/** The role and member each case proves. */
const provedOf = (c: Case) =>
	c.kind === "sitting"
		? { value: sittingValue(c.session), role: "learner", member: "answer" }
		: { value: grantValue(), role: "plain", member: "assignPlain" }

/**
 * The case's member's proof under the borrow rules, one for each variant its flight sends, over the installation its
 * login's IR gives: its login compiled as generate compiles it (changeLogin, readCommittedChanges), and the facts each
 * variant's compile extracted.
 */
export const proofsOf = (c: Case): ReadonlyArray<MemberBorrows> => {
	const proved = provedOf(c)
	const compiled = changeLogin(proved.value)
	const installation = succeeded(
		borrowInstallationOf(compiled.artifacts, [compiled]),
		"the installation's borrow facts"
	)
	const roles = succeeded(readCommittedChanges(compiled, silentPhases), "the login's changes")
	const role = defined(roles.get(proved.role), `role ${proved.role}`)
	const variants = defined(role.changes.members.get(proved.member), `member ${proved.member}`)
	return Arr.flatMap(variantsEntries(variants), (entry) =>
		Arr.map(entry.facts, (facts) => memberBorrows(facts, installation))
	)
}

const childAt = { field: "child", source: { kind: "param", name: "child" } } as const
const stageAt = { field: "stage", source: { kind: "param", name: "stage" } } as const

/**
 * The borrows the rules prove of a case's member (the oracle), restated apart from the code: the learner's answer
 * borrows Learner exclusively at its child and Package shared at the package its session holds, the session's row read
 * at (child, stage), held under Learner where the session sits in it, learned where it is a fact outside every unit;
 * the operator's permission read borrows nothing, every relation it reads an immutable fact outside every unit.
 */
export const expectedOf = (c: Case): ReadonlyArray<Borrow> =>
	c.kind === "grant"
		? []
		: [
				{
					lock: { kind: "unit", unit: "Learner" },
					mode: "exclusive",
					at: "flight",
					keys: [{ kind: "bound", fields: [childAt] }]
				},
				{
					lock: { kind: "unit", unit: "Package" },
					mode: "shared",
					at: "flight",
					keys: [
						c.session === "under Learner"
							? {
									kind: "held",
									relation: "TestSession",
									key: [childAt, stageAt],
									columns: ["package"],
									under: { kind: "unit", unit: "Learner" }
								}
							: {
									kind: "learned",
									relation: "TestSession",
									key: [stageAt, childAt],
									columns: ["package"]
								}
					]
				}
			]
