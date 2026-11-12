/**
 * A login's served file holds exactly what the login's code can reach. `grizzle generate` compiles each login into
 * `served/<login>.json`, and a layer loads nothing else, so a roster or a law the file holds beyond the login's reach
 * is waste every cold start pays, and one it lacks is a load that fails or a refusal misread.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts), and logins
 * drawn over them (test/support/served-login.ts:
 * roles that may write some relations, write some of those and perhaps a query entry reading a context, and read some
 * of the case's queries), each login compiled as generate compiles it (adapter/served/compile.ts snapshotCompiled,
 * then servedEntryOf) and its file read back from the JSON value its text parses to:
 *
 * - Rosters, sufficiency: the file holds the codes of every roster a role's code meets, its decoders' closed ids and
 *   sets, its codecs' parameters, claims and window anchors, and the columns of every relation its writes write.
 * - Rosters, minimality: every roster the file holds is one of those, or one a form of the file holds as a type, which
 *   a load rebuilds from its codes (served/json.ts `~roster:`).
 * - The load fails closed: the file loads (adapter/served/load.ts loadServed), and without the codes of any one roster
 *   it holds it does not, a defect or a refusal and never a layer.
 * - Laws, sufficiency and minimality: each role's refusals hold exactly what its writes can raise of its installation,
 *   its table constraints and triggers, each domain's CHECK with its uses on the written tables alone, its unstored
 *   contract domains, the theory's laws over the written relations, their generated columns, their rosters' domains,
 *   their tables and headings, and the query entries it writes through into them; and every role, writing or not,
 *   holds the domains its members' parameters are cast to at the boundary, and their rosters' (served-reach.ts castBy).
 *
 * The oracle is the reach computed independently from the compiled program and the installation
 * (test/support/served-reach.ts): the statements' parameters and written relations, the decoders, and the written
 * relations' field types, never through program/served.ts servedRosters or program/schema.ts raisableOf.
 *
 * Plants (~/.cache/grizzle-release/TSERVED/plants): served-roster-unreached.patch adds every roster of the snapshot to
 * the file (minimality red, and the file loads without the added codes); served-roster-dropped.patch drops the first
 * roster the file would hold (sufficiency red, and the file does not load).
 * ~/.cache/grizzle-release/LIVE-SUBSCRIBE/plants/castby-changes-only.patch: the oracle's castBy counts a ChangeSet's
 * parameters alone, so a role that only reads a closed roster by a parameter of its type holds a roster domain the
 * oracle says it never reaches (minimality red).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { loadServed } from "#adapter/served/load.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { ServedRoleForm } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	type DrawnSchema,
	loginGen,
	type RoleShape,
	roleName,
	rolesOf
} from "#test/support/served-login.ts"
import {
	castBy,
	constraintText,
	heldRosters,
	partedTexts,
	type Raised,
	raisedBy,
	roleRosters,
	writtenBy
} from "#test/support/served-reach.ts"

type Feature =
	| "a roster the login reaches"
	| "a roster of the installation no role reaches"
	| "a role that writes"
	| "a role that writes nothing"
	| "a relation a role may write and does not"
	| "a written column typed by a roster"
	| "a domain shared with a relation the role does not write"
	| "a law a write statement raises"
	| "a write through a query entry reading a context"

/** Whether the JSON value of a served file loads as a layer loads it: no defect, no refusal. */
const loads = (json: unknown, login: string): boolean => {
	const read = Answered.try(() => loadServed(servedFile(json), login))
	return Answered.isSuccess(read) && Answered.isSuccess(read.success)
}

/** A served file's JSON value without the codes of `roster`. */
const withoutRoster = (json: unknown, roster: string): unknown =>
	isRecord(json) && isRecord(json["rosters"])
		? { ...json, rosters: Rec.remove(json["rosters"], roster) }
		: json

/** That the texts a file holds are exactly those its reach holds, naming what it lacks and what it holds beyond. */
const exactly = (
	held: Iterable<string>,
	reach: Iterable<string>,
	what: string,
	printed: () => string
): void => {
	const parted = partedTexts(held, reach)
	assert.deepEqual(parted.missing, [], `sufficiency: ${what} lacks what it reaches\n${printed()}`)
	assert.deepEqual(
		parted.extra,
		[],
		`minimality: ${what} holds what it never reaches\n${printed()}`
	)
}

/** That a served role's refusals hold exactly what its writes can raise (Raised). */
const refusalsReach = (role: ServedRoleForm, raised: Raised, printed: () => string): void => {
	const { laws } = role.refusals
	exactly(
		Arr.map(laws.constraintLaws, constraintText),
		Arr.map(raised.constraints, constraintText),
		`role ${role.name}'s constraints`,
		printed
	)
	exactly(
		Arr.map(laws.theoryLaws, (l) => l.law),
		Arr.map(raised.theoryLaws, (l) => l.law),
		`role ${role.name}'s laws of the theory`,
		printed
	)
	exactly(
		Arr.map(laws.rosterDomains, (d) => d.roster),
		raised.rosters,
		`role ${role.name}'s roster domains`,
		printed
	)
	exactly(
		Arr.map(laws.generated, (g) => `${g.table}.${g.column}`),
		Arr.map(raised.generated, (g) => `${g.table}.${g.column}`),
		`role ${role.name}'s generated columns`,
		printed
	)
	exactly(laws.tables.keys(), raised.relations, `role ${role.name}'s tables`, printed)
	exactly(role.refusals.relations.keys(), raised.relations, `role ${role.name}'s headings`, printed)
	exactly(
		Arr.map([...role.refusals.entries], ([target, e]) => `${target}=${e.entry}`),
		Arr.map([...raised.entries], ([target, entry]) => `${target}=${entry}`),
		`role ${role.name}'s written query entries`,
		printed
	)
}

const reach = (
	drawn: DrawnSchema,
	level: LawLevel,
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const printed = () =>
			`${printCase(drawn.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const compiled = yield* Effect.result(
			compiledLogin(drawnLogin(drawn, shapes), drawn.laws.codes)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		const { json, back } = compiled.success
		const roles = rolesOf(compiled.success)
		const reached = new Set(
			Arr.flatMap(roles, (r) => [...roleRosters(r.served, r.compiled.artifacts)])
		)
		const held = heldRosters(json)
		const rosters = [...back.rosters.keys()]
		const parted = partedTexts(rosters, reached)
		assert.deepEqual(
			parted.missing,
			[],
			`sufficiency: the file lacks the codes of rosters its code reaches\n${printed()}`
		)
		assert.deepEqual(
			Arr.filter(parted.extra, (r) => !held.has(r)),
			[],
			`minimality: the file holds the codes of rosters its code reaches nowhere\n${printed()}`
		)
		assert.ok(loads(json, back.login), `the file loads\n${printed()}`)
		for (const roster of rosters) {
			assert.ok(
				!loads(withoutRoster(json, roster), back.login),
				`the file without the codes of roster ${roster} does not load\n${printed()}`
			)
		}
		if (rosters.length > 0) {
			note("a roster the login reaches")
		}
		for (const [place, shape] of shapes.entries()) {
			const role = Arr.findFirst(roles, (r) => r.served.name === roleName(place)).pipe(
				Option.getOrUndefined
			)
			if (role === undefined) {
				continue
			}
			const { artifacts } = role.compiled
			if (Arr.some([...artifacts.names.codes.rosters.keys()], (r) => !back.rosters.has(r))) {
				note("a roster of the installation no role reaches")
			}
			const written = writtenBy(role.served)
			const raised = raisedBy(artifacts, written, castBy(role.served))
			refusalsReach(role.served, raised, printed)
			note(written.size > 0 ? "a role that writes" : "a role that writes nothing")
			const writes = new Set<string>(written)
			if (Arr.some(shape.writes, (r) => !writes.has(r))) {
				note("a relation a role may write and does not")
			}
			if (raised.rosters.size > 0) {
				note("a written column typed by a roster")
			}
			if (raised.theoryLaws.length > 0) {
				note("a law a write statement raises")
			}
			const tables = new Set<string>(
				Arr.map([...raised.relations], (r) => artifacts.names.relation(r).name)
			)
			if (
				Arr.some(
					artifacts.constraintLaws,
					(law) =>
						law.kind === "domainConstraint" &&
						Arr.some(law.uses, (u) => tables.has(u.table)) &&
						Arr.some(law.uses, (u) => !tables.has(u.table))
				)
			) {
				note("a domain shared with a relation the role does not write")
			}
			if (Arr.some(shape.changes, (change) => change.target.kind === "entry")) {
				note("a write through a query entry reading a context")
			}
		}
	})

describe("a login's served file", () => {
	it.effect("holds exactly the rosters and the laws the login's code can reach", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the reach computed from the compiled program and its installation (test/support/served-reach.ts)"
					},
					suite: "unit/served/reach",
					draw: drawn((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a roster the login reaches",
							"a roster of the installation no role reaches",
							"a role that writes",
							"a role that writes nothing",
							"a relation a role may write and does not",
							"a written column typed by a roster",
							"a domain shared with a relation the role does not write",
							"a law a write statement raises",
							"a write through a query entry reading a context"
						],
						{ cases: 60, sense: notesOnly }
					),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([sketch, level], notes) =>
					Effect.suspend(() => {
						const drawn = drawnSchema(notes.draw(resolveCase(sketch)), level)
						return reach(drawn, level, notes.draw(loginGen(drawn)), notes.note)
					})
			)
		)
	)
})
