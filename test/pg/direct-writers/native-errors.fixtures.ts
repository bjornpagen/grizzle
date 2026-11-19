/** What the properties of native-errors.test.ts read: the desk's template, its inserts and writes, and the model. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import {
	Account,
	DeskReports,
	DistinctPair,
	desk,
	Entry,
	Pair
} from "#test/pg/direct-writers/schema.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { lawIdOf, lawNamesOf, namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { type Fixture, openFixtureTemplate } from "#test/support/open-fixture.ts"
import { type PgErrorFields, reportedOwnerOf } from "#test/support/substrate/errors.ts"

/** The starting state, which every case's reset writes back whole: one account and one entry of it, Pair empty. */
export const startingState = (f: Fixture): ReadonlyArray<string> => {
	const names = namesOf(f.installed)
	return [
		`INSERT INTO ${names.table(Account)} (${names.column(Account, "id")}, ${names.column(Account, "name")}) VALUES (1, 1)`,
		`INSERT INTO ${names.table(Entry)} (${names.column(Entry, "id")}, ${names.column(Entry, "account")}, ${names.column(Entry, "amount")}) VALUES (10, 1, 5)`
	]
}

/** The law the installation reports for a constraint, index or domain constraint name under the table or domain it
 * lives on. */
export const lawOf = (
	f: Fixture,
	owner: ConstraintOwner | undefined,
	constraint: ConstraintName | undefined
): LawId | undefined =>
	constraint === undefined || owner === undefined
		? undefined
		: constraintLaw(f.installed.installation.constraintToLaw, owner, constraint)

/** The law a refusal PostgreSQL reported names: its constraint under the owner it reports. */
export const reportedLaw = (f: Fixture, fields: PgErrorFields): LawId | undefined =>
	lawOf(f, reportedOwnerOf(fields), fields.constraint)

/** One direct INSERT as drawn. */
export type Insert =
	| { readonly into: "Pair"; readonly a: number; readonly b: number }
	| { readonly into: "Entry"; readonly id: number; readonly amount: number }

export const insertGen: Gen<Insert> = oneOf<Insert>([
	(source) => ({ into: "Pair", a: source.draw(int(0, 2)), b: source.draw(int(0, 2)) }),
	(source) => ({ into: "Entry", id: source.draw(int(10, 12)), amount: source.draw(int(-2, 5)) })
])

/** A write of the derived relation, as a direct SQL writer would send it: drawn rows, a drawn column and filters. */
export type DerivedWrite =
	| {
			readonly kind: "INSERT"
			readonly rows: Arr.NonEmptyReadonlyArray<readonly [account: number, entries: number]>
	  }
	| {
			readonly kind: "UPDATE"
			readonly column: DerivedColumn
			readonly value: number
			readonly where: Option.Option<number>
	  }
	| { readonly kind: "DELETE"; readonly where: Option.Option<number> }

/** The derived relation's columns: its definition's heading. */
export type DerivedColumn = "account" | "entries"

const derivedRowGen: Gen<readonly [number, number]> = (source) => [
	source.draw(int(0, 2)),
	source.draw(int(0, 2))
]

const whereGen: Gen<Option.Option<number>> = (source) =>
	source.draw(boolean) ? Option.some(source.draw(int(0, 2))) : Option.none()

export const derivedWriteGen: Gen<DerivedWrite> = oneOf<DerivedWrite>([
	(source) => ({
		kind: "INSERT",
		rows: [source.draw(derivedRowGen), ...source.draw(array(derivedRowGen, { min: 0, max: 1 }))]
	}),
	(source) => ({
		kind: "UPDATE",
		column: source.draw(element(["account", "entries"] as const)),
		value: source.draw(int(0, 2)),
		where: source.draw(whereGen)
	}),
	(source) => ({ kind: "DELETE", where: source.draw(whereGen) })
])

/** The refusal the model names, or the state it commits. */
export type Prediction =
	| {
			readonly kind: "fails"
			readonly at: number
			readonly law: LawId
			readonly sqlstate: "23514" | "23505"
	  }
	| {
			readonly kind: "commits"
			readonly pairs: ReadonlyArray<readonly [number, number]>
			readonly entries: ReadonlyArray<number>
	  }

export type NativeFeature =
	| "23514 at a row check"
	| "23514 at a contract"
	| "23505 at Pair's key"
	| "23505 at Entry's key"
	| "committed"
	| "refused after a statement that ran"

/**
 * The row's CHECK, then the key's unique index.
 *
 * The domain's CHECK as the value is coerced, then the key's unique index.
 */
export const predict = (inserts: ReadonlyArray<Insert>): Prediction => {
	const laws = lawNamesOf(DeskReports)
	const amount = laws.contract("Amount")
	const rowCheck = lawIdOf(DeskReports, DistinctPair)
	const pairs: Array<readonly [number, number]> = []
	const entries: Array<number> = [10]
	/** The law an insert breaks, after the inserts before it. */
	const refusalOf = (
		s: Insert
	): Option.Option<{ readonly law: LawId; readonly sqlstate: "23514" | "23505" }> => {
		switch (s.into) {
			case "Pair":
				return s.a === s.b
					? Option.some({ law: rowCheck, sqlstate: "23514" })
					: Arr.some(pairs, ([a, b]) => a === s.a && b === s.b)
						? Option.some({ law: laws.primaryKeyLaw(Pair), sqlstate: "23505" })
						: Option.none()
			case "Entry":
				return s.amount < 0
					? Option.some({ law: amount.law, sqlstate: "23514" })
					: entries.includes(s.id)
						? Option.some({ law: laws.primaryKeyLaw(Entry), sqlstate: "23505" })
						: Option.none()
		}
	}
	for (const [at, s] of inserts.entries()) {
		const refusal = refusalOf(s)
		if (Option.isSome(refusal)) {
			return { kind: "fails", at, ...refusal.value }
		}
		if (s.into === "Pair") {
			pairs.push([s.a, s.b])
		} else {
			entries.push(s.id)
		}
	}
	return { kind: "commits", pairs, entries }
}

/** One insert as a direct writer sends it, under the installation's names. */
export const sqlOf = (f: Fixture, s: Insert): string => {
	const names = namesOf(f.installed)
	return s.into === "Pair"
		? `INSERT INTO ${names.table(Pair)} (${names.column(Pair, "a")}, ${names.column(Pair, "b")}) VALUES (${s.a}, ${s.b})`
		: `INSERT INTO ${names.table(Entry)} (${names.column(Entry, "id")}, ${names.column(Entry, "account")}, ${names.column(Entry, "amount")}) VALUES (${s.id}, 1, ${s.amount})`
}

const column = (field: DerivedColumn): string =>
	quoteIdent(identifierOf(identity.column(parsedName(field))))
const filter = (where: Option.Option<number>): string =>
	Option.match(where, {
		onNone: () => "",
		onSome: (n) => ` WHERE ${column("account")} = ${n}`
	})
/** A write of the derived relation `view` as a direct writer sends it. */
export const statementOf = (view: string, write: DerivedWrite): string => {
	switch (write.kind) {
		case "INSERT":
			return `INSERT INTO ${view} (${column("account")}, ${column("entries")}) VALUES ${Arr.join(
				Arr.map(write.rows, ([account, entries]) => `(${account}, ${entries})`),
				", "
			)}`
		case "UPDATE":
			return `UPDATE ${view} SET ${column(write.column)} = ${write.value}${filter(write.where)}`
		case "DELETE":
			return `DELETE FROM ${view}${filter(write.where)}`
	}
}

/**
 * The desk's installation, empty, once per member (open-fixture.ts openFixtureTemplate), where each search opened it
 * once before its cases; a case writes the starting state back whole before it runs.
 */
export const deskTemplate = openFixtureTemplate(import.meta, "native errors desk", DeskReports, [
	desk
])

/**
 * The transaction the search kept, the pair (0, 1) twice, refused at its key after a statement that ran (no red in git
 * log -S on the module: 65203c443 and f2643687b kept it for coverage), aimed at the situations it reached.
 */
export const pairTwiceAims: ReadonlyArray<
	readonly [Reached<NativeFeature>, Gen<ReadonlyArray<Insert>>]
> = Arr.map(["23505 at Pair's key", "refused after a statement that ran"] as const, (situation) => [
	situation,
	constant<ReadonlyArray<Insert>>([
		{ into: "Pair", a: 0, b: 1 },
		{ into: "Pair", a: 0, b: 1 }
	])
])

/** The roles of the desk's login, each a writer of the derived relation. */
export const deskRoles = nonEmpty(
	Arr.map(Record.values(desk.roles), (held) => held.role),
	"desk's roles"
)
