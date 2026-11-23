/**
 * A retirable unit as `grizzle migrate` installs it on PostgreSQL 19, written as a direct writer and its two
 * functions (physical/ddl/retire.ts) would write it, a header with its retirement field, two bodies grouped by the
 * header's key, and the second body's step contained in the first, carrying the group; two such units, by the width of
 * their header's key: Root, keyed by its id, with Step and Claim, grouped by root; and Pair, keyed by a tenant and an
 * id, with PairStep and PairClaim, grouped by tenant and root, so a function's groups travel as one key array per
 * field, read in lockstep.
 *
 * - **A second implementation as the oracle:** the unit's lifecycle as a model: each group absent, open or retired, and
 *   the rows of each body in it. A header inserted is open; a body row commits only in an open group (the fence,
 *   23503 otherwise) at a key no row holds (23505 otherwise); a hold commits only when every group it states is open,
 *   and otherwise refuses on the fence of the unit's first body (23000, raised by the refusal function); a retirement
 *   commits always, retiring each open group it states and deleting every body row in it, and leaves an absent or a
 *   retired group as it was. After every transaction the three tables hold exactly the model's rows.
 *
 * The space: a unit, by its header's width; its groups 0 and 1, Pair's two sharing their tenant, steps and attempts 0
 * and 1, and up to eight transactions of one operation each, run in order as the installation's owner. Each situation a
 * transaction reaches is noted beside the width, and a hold of open groups, a hold refused for an absent group and a
 * retirement of an open group are each required of the header keyed by two fields.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { identifierOf, type Identity, identity } from "#compiler/core/identity.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	Disagreed,
	empty,
	groupsArrays,
	type LifeFeature,
	lifeGen,
	modelRows,
	type Op,
	predict,
	RELATIONS,
	UNITS,
	unitsTemplate,
	valuesAt
} from "#test/pg/laws/retirable.fixtures.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A retirable unit installed on PostgreSQL 19 admits rows only into open groups, holds only open groups, and retires a group whole, keeping its header for good.
 *
 * Its budget is the runner's: its catch, the installation of a unit of two bodies that threw and the unit's functions'
 * SQL the installation audit refused on its first run (0f0d87454), re-plants as no single-span kill against today's
 * retire.ts, whose SQL is built as an AST.
 */
export const aRetirableUnitInstalledOnPostgreSQL19AdmitsRowsOnlyIntoOpenGroupsHoldsOnlyOpenGroupsAndRetiresAGroupWholeKeepingItsHeaderForGood =
	property.explore(lifeGen, {
		needs: { seated: Substrate.seat(unitsTemplate) },
		situations: [
			"a header keyed by one field",
			"a header keyed by two fields",
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
			"a retirement that changes nothing",
			["a header keyed by two fields", "a hold of open groups"],
			["a header keyed by two fields", "a hold refused for an absent group"],
			["a header keyed by two fields", "a retirement of an open group"]
		] satisfies ReadonlyArray<Reached<LifeFeature>>,
		check:
			({ seated }, c: Case<LifeFeature>) =>
			({ width, run }) =>
				Effect.gen(function* () {
					const taken = yield* seated
					const seat = yield* seatIn(taken, RELATIONS, "retire_life")
					const unit = UNITS[width]
					const headerKey = Arr.map(unit.key, (k) => k.header)
					const bodyGroup = Arr.map(unit.key, (k) => k.body)
					c.note(width)
					const unitFunction = (named: Identity<"hold" | "retire">) =>
						printObjectName({
							schema: seat.installed.names.relation(unit.header).schema,
							name: identifierOf(named)
						})
					/** `relation`'s columns of `fields`, in order, for a column list or a select list. */
					const cols = (relation: string, fields: ReadonlyArray<string>): string =>
						Arr.join(
							Arr.map(fields, (f) => seat.column(relation, f)),
							", "
						)
					const listed = (values: ReadonlyArray<number>): string =>
						Arr.join(Arr.map(values, String), ", ")
					const sqlOf = (op: Op): string => {
						switch (op.kind) {
							case "header":
								return `INSERT INTO ${seat.table(unit.header)} (${cols(unit.header, headerKey)}) VALUES (${listed(valuesAt(unit, op.group))})`
							case "step":
								return `INSERT INTO ${seat.table(unit.step)} (${cols(unit.step, [...bodyGroup, "step"])}) VALUES (${listed([...valuesAt(unit, op.group), op.step])})`
							case "claim":
								return `INSERT INTO ${seat.table(unit.claim)} (${cols(unit.claim, [...bodyGroup, "step", "attempt"])}) VALUES (${listed([...valuesAt(unit, op.group), op.step, op.attempt])})`
							case "hold":
								return `SELECT ${unitFunction(identity.hold(unit.header))}(${groupsArrays(unit, op.groups)})`
							case "retire":
								return `SELECT ${unitFunction(identity.retire(unit.header))}(${groupsArrays(unit, op.groups)})`
						}
					}
					const readRows = Effect.gen(function* () {
						const rows = (relation: string, fields: ReadonlyArray<string>) =>
							Effect.map(
								seat.session.values(
									`SELECT ${cols(relation, fields)} FROM ${seat.table(relation)} ORDER BY ${listed(Arr.map(fields, (_, i) => i + 1))}`,
									[]
								),
								(rs) => Arr.map(rs, (r) => Arr.join(Arr.map(r, String), ","))
							)
						return [
							yield* rows(unit.header, [...headerKey, "retired"]),
							yield* rows(unit.step, [...bodyGroup, "step"]),
							yield* rows(unit.claim, [...bodyGroup, "step", "attempt"])
						]
					})

					let model = empty
					for (const [at, op] of run.entries()) {
						const predicted = predict(model, op)
						const real = yield* attempt(seat.session, [sqlOf(op)])
						const said = `transaction ${at} (${Formatter.format(op)}) of ${Formatter.format(run)} over ${unit.header}`
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
						c.pair(width, predicted.feature)
						const rows = yield* readRows
						yield* agree(
							[
								[`the tables after ${said}`, rows],
								["the model", modelRows(unit, model)]
							],
							exact
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the unit's lifecycle as a model: each group absent, open or retired, and each body's rows in it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/retire.ts",
				original:
					'\t\t\t\tmapNonEmpty(params, (p, at) => targetAs(call("unnest", [argument(p)]), keyColumn(at))),\n\t\t\t\t[],\n',
				replacement:
					'\t\t\t\tmapNonEmpty(params, (_, at) => targetAs(col("u", keyColumn(at)), keyColumn(at))),\n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\tkind: "function",\n\t\t\t\t\t\tcall: call("unnest", params.map(argument)),\n\t\t\t\t\t\talias: "u",\n\t\t\t\t\t\tcolumns: params.map((_, at) => keyColumn(at)),\n\t\t\t\t\t\tlateral: false,\n\t\t\t\t\t\tordinality: false\n\t\t\t\t\t}\n\t\t\t\t],\n',
				why: "A call's groups are its key arrays unnested in FROM again, one call of them all, printed pg_catalog.unnest(keys_1, keys_2), which PostgreSQL expands into one unnest per array only unqualified: every hold and retirement of Pair, keyed by two fields, is refused 42883, as STAMPRC found."
			}
		]
	})
