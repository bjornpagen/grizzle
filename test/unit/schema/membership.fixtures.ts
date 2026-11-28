/** What the properties of membership.test.ts read: the box of one-value and many-value IN statements, and each one's readings. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { admitLoginRoles, type StatementDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { check, closed, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { fullRoleDesc, installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { ownValue } from "#test/unit/schema/own.fixtures.ts"

const Kind = closed.ordered("Kind", ["a", "b", "c"])
const Item = relation("Item", { id: int4, kind: closedId(Kind), n: int4 }, ["id"])

/** The surfaces a membership is written at: a row check's own helper, Logic's, and a side's selection's helper. */
const surfaces = ["row helper", "Logic", "selection"] as const
export type Surface = (typeof surfaces)[number]

/** The fields a membership reads: a closed id, read against its roster's handles, and an integer. */
const fields = ["kind", "n"] as const
export type MemberField = (typeof fields)[number]

/** The lists of values a membership names: one value, one value written twice, and two values. */
const lists = ["one", "one twice", "two"] as const
export type ListForm = (typeof lists)[number]

export interface MembershipCase {
	readonly surface: Surface
	readonly field: MemberField
	readonly list: ListForm
}

export const membershipGen: Gen<MembershipCase> = (source) => ({
	surface: source.draw(element(surfaces)),
	field: source.draw(element(fields)),
	list: source.draw(element(lists))
})

/** The values of a list of `first` and `second`, the first of them the value its equality names. */
const listOf = <V>(list: ListForm, first: V, second: V): Arr.NonEmptyReadonlyArray<V> => {
	switch (list) {
		case "one":
			return [first]
		case "one twice":
			return [first, first]
		case "two":
			return [first, second]
	}
}

/** A case's handles of Kind, and its integers. */
const handlesOf = (c: MembershipCase) => listOf<"b" | "c">(c.list, "b", "c")
const integersOf = (c: MembershipCase) => listOf(c.list, 7, 9)

/** Whether a case's list names one value, however often, so its membership is the equality with it. */
export const namesOne = (c: MembershipCase): boolean => c.list !== "two"

type Written = "in" | "eq"

/**
 * The case's statement, its membership written as `written`: IN of the case's list, or the equality with its first
 * value; a check over Item at the row helper or Logic, or a key over the rows a selection keeps.
 */
const statementOf = (c: MembershipCase, written: Written) => {
	const handles = handlesOf(c)
	const integers = integersOf(c)
	const [handle] = handles
	const [integer] = integers
	switch (c.surface) {
		case "row helper":
			return c.field === "kind"
				? check("Picked", Item, (r) =>
						written === "in" ? r.in(r.kind, handles) : r.eq(r.kind, handle)
					)
				: check("Picked", Item, (r) =>
						written === "in" ? r.in(r.n, integers) : r.eq(r.n, integer)
					)
		case "Logic":
			return c.field === "kind"
				? check("Picked", Item, (r) =>
						written === "in" ? Logic.in(r.kind, handles) : Logic.eq(r.kind, handle)
					)
				: check("Picked", Item, (r) =>
						written === "in" ? Logic.in(r.n, integers) : Logic.eq(r.n, integer)
					)
		case "selection":
			return c.field === "kind"
				? key(
						on(
							select(Item, (r) =>
								written === "in" ? r.in(r.kind, handles) : r.eq(r.kind, handle)
							),
							"n"
						)
					)
				: key(
						on(
							select(Item, (r) => (written === "in" ? r.in(r.n, integers) : r.eq(r.n, integer))),
							"kind"
						)
					)
	}
}

/** What a schema of one membership statement reads as: its fingerprint, its statement, its laws and its install script. */
export interface Readings {
	readonly fingerprint: string
	readonly statement: StatementDesc
	readonly laws: ReturnType<typeof lawsOf>
	readonly sql: ReadonlyArray<string>
}

const loc = SourceLoc("membership case", [])

/** The readings of the case's schema with its membership written as `written`. */
export const readingsOf = (c: MembershipCase, written: Written): Readings => {
	const declared = schema("Picks", [Kind, Item], [statementOf(c, written)])
	const owned = succeeded(ownValue(declared), "the case's schema owned")
	const app = succeeded(fullRoleDesc(owned.desc, "app", loc))
	const login = succeeded(
		Result.flatMap(admitLoginRoles(owned.desc, { name: "desk", roles: [app], loc }), ownLogin)
	)
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				installationsOf(owned),
				[login],
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
	const [statement] = owned.desc.statements
	if (statement === undefined) {
		throw new Error("the case's schema states its one statement")
	}
	return {
		fingerprint: owned.fingerprint,
		statement,
		laws: lawsOf(declared),
		sql: installationSql(installation, "picks")
	}
}

/** Whether a description holds an IN list anywhere: a check's predicate or a side's selection. */
export const holdsIn = (desc: unknown): boolean =>
	isList(desc)
		? Arr.some(desc, holdsIn)
		: isRecord(desc) && (desc["kind"] === "in" || Arr.some(Rec.values(desc), holdsIn))
