/**
 * The guard trigger per relation (physical/ddl/isolation.ts readCommittedRelations), searched as a pure function over
 * drawn certifications: roles, each READ COMMITTED or SERIALIZABLE, each holding a drawn set of table privileges on each
 * of four relations. The relations whose tables take no guard are exactly those some role writes, holding INSERT,
 * UPDATE or DELETE there, every such role READ COMMITTED and holding only INSERT and SELECT there. A relation no role
 * writes keeps its guard, and so does one a SERIALIZABLE writer, or a READ COMMITTED writer that may update or delete,
 * writes.
 *
 * Oracle: the rule restated over the case. An installation's guard objects follow this set over its own certification
 * (test/unit/physical/insert-grants.test.ts).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { readCommittedRelations } from "#compiler/physical/ddl/isolation.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const relations = ["r0", "r1", "r2", "r3"] as const
type Relation = (typeof relations)[number]
const privileges: ReadonlyArray<TablePrivilege> = ["SELECT", "INSERT", "UPDATE", "DELETE"]
const levels: Arr.NonEmptyReadonlyArray<Isolation> = ["readCommitted", "serializable"]

/** One role of a case: its level, and the privileges it holds on each relation it holds any on. */
interface RoleCase {
	readonly level: Isolation
	readonly held: ReadonlyArray<readonly [Relation, ReadonlyArray<TablePrivilege>]>
}

const roleGen: Gen<RoleCase> = (source) => ({
	level: source.draw(element(levels)),
	held: Arr.flatMap(
		relations,
		(r): ReadonlyArray<readonly [Relation, ReadonlyArray<TablePrivilege>]> => {
			const held = source.draw(subarray(privileges))
			return held.length > 0 ? [[r, held]] : []
		}
	)
})

const rolesGen: Gen<ReadonlyArray<RoleCase>> = array(roleGen, { min: 0, max: 4 })

const writing = (held: ReadonlyArray<TablePrivilege>): boolean =>
	Arr.some(held, (p) => p !== "SELECT")

/** The rule restated: whether `r`'s table takes no guard among `roles`. */
const unguarded = (roles: ReadonlyArray<RoleCase>, r: Relation): boolean => {
	const writers = Arr.flatMap(roles, (role) =>
		Arr.flatMap(role.held, ([at, held]) =>
			at === r && writing(held) ? [{ level: role.level, held }] : []
		)
	)
	return (
		writers.length > 0 &&
		Arr.every(
			writers,
			(w) =>
				w.level === "readCommitted" && Arr.every(w.held, (p) => p === "SELECT" || p === "INSERT")
		)
	)
}

type Feature =
	| "a relation no role holds"
	| "a relation a role only reads"
	| "a relation every writer of which inserts at READ COMMITTED"
	| "a relation two READ COMMITTED inserters write"
	| "a relation a SERIALIZABLE role writes"
	| "a relation a READ COMMITTED role updates or deletes"

const noteRelation = (roles: ReadonlyArray<RoleCase>, r: Relation, c: Case<Feature>): void => {
	const holders = Arr.flatMap(roles, (role) =>
		Arr.flatMap(role.held, ([at, held]) => (at === r ? [{ level: role.level, held }] : []))
	)
	const writers = Arr.filter(holders, (h) => writing(h.held))
	if (holders.length === 0) {
		c.note("a relation no role holds")
	} else if (writers.length === 0) {
		c.note("a relation a role only reads")
	} else if (unguarded(roles, r)) {
		c.note(
			writers.length > 1
				? "a relation two READ COMMITTED inserters write"
				: "a relation every writer of which inserts at READ COMMITTED"
		)
	} else if (Arr.some(writers, (w) => w.level === "serializable")) {
		c.note("a relation a SERIALIZABLE role writes")
	} else {
		c.note("a relation a READ COMMITTED role updates or deletes")
	}
}

describe("the guard trigger per relation", () => {
	it.effect(
		"no guard exactly on a relation some role writes, every writer READ COMMITTED and inserting",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/physical/isolation-guard",
						draw: drawn(rolesGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a relation no role holds",
								"a relation a role only reads",
								"a relation every writer of which inserts at READ COMMITTED",
								"a relation two READ COMMITTED inserters write",
								"a relation a SERIALIZABLE role writes",
								"a relation a READ COMMITTED role updates or deletes"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 32,
						caseHang
					},
					(roles, c) =>
						Effect.sync(() => {
							const set = readCommittedRelations(
								Arr.map(roles, (role) => ({
									level: role.level,
									privileges: new Map(
										Arr.map(role.held, ([r, held]) => [r, new Set(held)] as const)
									)
								}))
							)
							for (const r of relations) {
								noteRelation(roles, r, c)
								assert.equal(set.has(r), unguarded(roles, r), `${r}: ${Formatter.format(roles)}`)
							}
							assert.ok(
								Arr.every([...set], (r) => Arr.some(relations, (x) => x === r)),
								"no relation outside the roles' privileges"
							)
						})
				)
			)
	)
})
