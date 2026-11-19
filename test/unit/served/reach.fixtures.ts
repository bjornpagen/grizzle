/** What the properties of reach.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { loadServed } from "#adapter/served/load.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { ServedRoleForm } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { type LawLevel } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	type DrawnSchema,
	roleName,
	type RoleShape,
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

export type Feature =
	| "a roster the login reaches"
	| "a roster of the installation no role reaches"
	| "a role that writes"
	| "a role that writes nothing"
	| "a relation a role may write and does not"
	| "a written column typed by a roster"
	| "a domain shared with a relation the role does not write"
	| "a law a write statement raises"
	| "a write through a query entry reading a context"
	| "a clocked member with a contract-typed param"

/** Whether the JSON value of a served file reads and loads as a layer loads it: no defect, no refusal. */
const loads = (json: unknown, login: string): boolean => {
	const file = servedFile(json)
	if (!file.ok) {
		return false
	}
	const read = Answered.try(() => loadServed(file.value, login))
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

export const reach = (
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
			const raised = raisedBy(artifacts, written, castBy(role.served, role.compiled))
			if (shape.clocked) {
				note("a clocked member with a contract-typed param")
			}
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
