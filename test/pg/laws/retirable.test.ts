/**
 * A retirable unit as `grizzle migrate` installs it on PostgreSQL 19rc2, written as a direct writer and its two
 * functions (physical/ddl/retire.ts) would write it: Root, the header, with its retirement field; Step and Claim, its
 * bodies, grouped by root; and Claim's step contained in Step, carrying the group.
 *
 * - **A second implementation as the oracle:** the unit's lifecycle as a model: each group absent, open or retired, and
 *   the rows of each body in it. A header inserted is open; a body row commits only in an open group (the fence,
 *   23503 otherwise) at a key no row holds (23505 otherwise); a hold commits only when every group it states is open,
 *   and otherwise refuses on the fence of the unit's first body (23000, raised by the refusal function); a retirement
 *   commits always, retiring each open group it states and deleting every body row in it, and leaves an absent or a
 *   retired group as it was. After every transaction the three tables hold exactly the model's rows.
 *
 * The space: groups, steps and attempts 0 and 1, and up to eight transactions of one operation each, run in order as
 * the installation's owner.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { identifierOf, type Identity, identity } from "#compiler/core/identity.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import {
	Disagreed,
	empty,
	groupsArray,
	type LifeFeature,
	modelRows,
	type Op,
	predict,
	RELATIONS,
	runGen,
	Units
} from "#test/pg/laws/retirable.fixtures.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A retirable unit installed on PostgreSQL 19rc2 admits rows only into open groups, holds only open groups, and retires a group whole, keeping its header for good.
 *
 * Its pre-conversion budget: runs 150, coverage cases 300 (test/pg/laws/retirable.test.ts at d8eed1786).
 */
export const aRetirableUnitInstalledOnPostgreSQL19rc2AdmitsRowsOnlyIntoOpenGroupsHoldsOnlyOpenGroupsAndRetiresAGroupWholeKeepingItsHeaderForGood =
	property.explore(runGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a header inserted",
			"a header refused at its key",
			"a body row inserted",
			"a body row refused at its key",
			"a body row refused in a retired group",
			"a body row refused in an absent group",
			"a claim refused with no step",
			"a hold of open groups",
			"a hold refused for a retired group",
			"a hold refused for an absent group",
			"a retirement of an open group",
			"a retirement that changes nothing"
		] satisfies ReadonlyArray<Reached<LifeFeature>>,
		check:
			({ substrate }, c: Case<LifeFeature>) =>
			(run) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const seat = yield* seatOf(Units, RELATIONS, "retire_life")
						const unitFunction = (named: Identity<"hold" | "retire">) =>
							printObjectName({
								schema: seat.installed.names.relation("Root").schema,
								name: identifierOf(named)
							})
						const col = (r: string, f: string) => seat.column(r, f)
						const sqlOf = (op: Op): string => {
							switch (op.kind) {
								case "header":
									return `INSERT INTO ${seat.table("Root")} (${col("Root", "id")}) VALUES (${op.group})`
								case "step":
									return `INSERT INTO ${seat.table("Step")} (${col("Step", "root")}, ${col("Step", "step")}) VALUES (${op.group}, ${op.step})`
								case "claim":
									return `INSERT INTO ${seat.table("Claim")} (${col("Claim", "root")}, ${col("Claim", "step")}, ${col("Claim", "attempt")}) VALUES (${op.group}, ${op.step}, ${op.attempt})`
								case "hold":
									return `SELECT ${unitFunction(identity.hold("Root"))}(${groupsArray(op.groups)})`
								case "retire":
									return `SELECT ${unitFunction(identity.retire("Root"))}(${groupsArray(op.groups)})`
							}
						}
						const readRows = Effect.gen(function* () {
							const rows = (sql: string) =>
								Effect.map(seat.session.values(sql, []), (rs) =>
									Arr.map(rs, (r) => Arr.join(Arr.map(r, String), ","))
								)
							return [
								yield* rows(
									`SELECT ${col("Root", "id")}, ${col("Root", "retired")} FROM ${seat.table("Root")} ORDER BY 1`
								),
								yield* rows(
									`SELECT ${col("Step", "root")}, ${col("Step", "step")} FROM ${seat.table("Step")} ORDER BY 1, 2`
								),
								yield* rows(
									`SELECT ${col("Claim", "root")}, ${col("Claim", "step")}, ${col("Claim", "attempt")} FROM ${seat.table("Claim")} ORDER BY 1, 2, 3`
								)
							]
						})

						yield* cleared(seat, RELATIONS)
						let model = empty
						for (const [at, op] of run.entries()) {
							const predicted = predict(model, op)
							const real = yield* attempt(seat.session, [sqlOf(op)])
							const said = `transaction ${at} (${Formatter.format(op)}) of ${Formatter.format(run)}`
							if (predicted.kind === "committed") {
								if (real.kind !== "committed") {
									return yield* new Disagreed({
										message: `${said} was refused by ${refusalText(real.fields)}; the model commits it`
									})
								}
								model = predicted.next
							} else if (real.kind === "committed" || real.fields.code !== predicted.code) {
								return yield* new Disagreed({
									message: `${said} ${real.kind === "committed" ? "committed" : `was refused by ${refusalText(real.fields)}`}; the model refuses it with ${predicted.code}`
								})
							}
							c.note(predicted.feature)
							const rows = yield* readRows
							yield* agree(
								[
									[`the tables after ${said}`, rows],
									["the model", modelRows(model)]
								],
								exact
							)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the unit's lifecycle as a model: each group absent, open or retired, and each body's rows in it"
		},
		budget: { runs: 150, steered: 300 },
		kept: [],
		kills: []
	})
