import { Array as Arr, Option } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import {
	type HostFact,
	type HostSchema,
	lawRelations,
	relationOf
} from "#test/support/laws/model.ts"
import type { StepOutcome } from "#test/support/schedules/types.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"

/** Every level below SERIALIZABLE a planted writer begins at. */
export const belowLevels: Arr.NonEmptyReadonlyArray<BelowSerializable> = [
	"read uncommitted",
	"read committed",
	"repeatable read"
]

/** The write statements a planted writer runs: each form of DML grizzle's guard is on, and TRUNCATE. */
export const belowForms = [
	"insert",
	"update",
	"delete",
	"zero-row delete",
	"truncate",
	"merge"
] as const
export type BelowForm = (typeof belowForms)[number]

/**
 * Planted writers below SERIALIZABLE: a direct writer that BEGINs at a lower level and writes, which grizzle refuses.
 *
 * Every grizzle table carries a statement trigger, BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT,
 * that raises 25000 (invalid_transaction_state) naming the table in the error's SCHEMA and TABLE fields for any
 * transaction below SERIALIZABLE, even one whose statement touches no row.
 * PostgreSQL checks privileges at executor start, before any statement trigger fires, and grizzle grants TRUNCATE to no
 * one and UPDATE only on `mutable` relations, so for a world role the first refusal of
 * each form is a total table (refusalOf): INSERT, DELETE, a DELETE of no row, MERGE of granted actions and UPDATE of a
 * mutable relation meet the guard; TRUNCATE, and UPDATE of an immutable relation, meet privilege (42501) at every
 * level. A read alone is never refused, and a transaction that only reads commits.
 *
 * A planted writer is a named case, never a filtered blob: its level, its statement's form, the relation it writes,
 * whether it reads that relation first, and the fact its statement names. It is refused at its first write statement
 * and commits nothing; the history it runs beside leaves it out, so any effect it had is a committed state
 * no serial order reaches.
 */
export type Below =
	| {
			readonly kind: "write"
			readonly level: BelowSerializable
			readonly form: BelowForm
			readonly relation: string
			/** The fact the statement names: inserted, updated, deleted or merged. */
			readonly fact: HostFact
			/** Whether the transaction reads the relation before it writes. */
			readonly read: boolean
	  }
	| { readonly kind: "read only"; readonly level: BelowSerializable; readonly relation: string }

/** The first refusal a write meets: grizzle's guard, 25000 naming its table, or privilege, 42501. */
export type Refusal = "the guard" | "privilege"

/** The first refusal of each form on a relation, by whether it is mutable. */
const refusals: Readonly<Record<BelowForm, (mutable: boolean) => Refusal>> = {
	insert: () => "the guard",
	update: (mutable) => (mutable ? "the guard" : "privilege"),
	delete: () => "the guard",
	"zero-row delete": () => "the guard",
	truncate: () => "privilege",
	merge: () => "the guard"
}

/** The first refusal a planted write meets on its relation, by the relation's mutability. */
const refusalOf = (host: HostSchema, b: Extract<Below, { readonly kind: "write" }>): Refusal =>
	refusals[b.form](relationOf(host, b.relation).mutable)

/** The SQLSTATE of each refusal. */
const refusalCodes: Readonly<Record<Refusal, string>> = {
	"the guard": sqlstates.invalidTransactionState,
	privilege: sqlstates.insufficientPrivilege
}

/** What a planted case reached, for a suite's features. */
export type BelowFeature =
	| `below: ${BelowForm}`
	| "below: read only"
	| `below at ${BelowSerializable}`
	| `refused by ${Refusal}`
	| "below: a read before the write"
	| "below: on a foreign key's relation"
	| "below: on a relation no foreign key reads"

export const belowFeaturesOf = (host: HostSchema, b: Below): ReadonlyArray<BelowFeature> => {
	const read = Arr.some(
		host.laws,
		(l) => (l.kind === "contained" || l.kind === "covered") && lawRelations(l).includes(b.relation)
	)
	const on: BelowFeature = read
		? "below: on a foreign key's relation"
		: "below: on a relation no foreign key reads"
	switch (b.kind) {
		case "read only":
			return ["below: read only", `below at ${b.level}`, on]
		case "write":
			return [
				`below: ${b.form}`,
				`below at ${b.level}`,
				`refused by ${refusalOf(host, b)}`,
				...(b.read ? ["below: a read before the write" as const] : []),
				on
			]
	}
}

/** One field of a fact as a statement spells it: the field, its quoted column, and its value as a SQL literal. */
export interface Cell {
	readonly field: string
	readonly column: string
	readonly value: string
}

/**
 * How a planted transaction's SQL is spelled: a relation's schema-qualified quoted table, and a fact's cells in heading
 * order.
 */
export interface BelowSpelling {
	readonly table: (relation: string) => string
	readonly cells: (relation: string, fact: HostFact) => Arr.NonEmptyReadonlyArray<Cell>
}

/** The predicate that matches a fact by its key, each column qualified by `alias`. */
const keyMatch = (
	host: HostSchema,
	relation: string,
	cells: ReadonlyArray<Cell>,
	alias: string
): string => {
	const key = relationOf(host, relation).key
	return Arr.join(
		Arr.map(
			Arr.filter(cells, (c) => key.includes(c.field)),
			(c) => `${alias}${c.column} = ${c.value}`
		),
		" AND "
	)
}

/**
 * The write statement of a planted case. Every value is a literal at its column, so it takes the column's type
 * whatever that type is (an enum, a domain, a range); no statement reads a value of another type into a column.
 */
export const writeSql = (
	s: BelowSpelling,
	host: HostSchema,
	b: Extract<Below, { readonly kind: "write" }>
): string => {
	const table = s.table(b.relation)
	const cells = s.cells(b.relation, b.fact)
	const columns = Arr.join(
		Arr.map(cells, (c) => c.column),
		", "
	)
	const values = Arr.join(
		Arr.map(cells, (c) => c.value),
		", "
	)
	switch (b.form) {
		case "insert":
			return `INSERT INTO ${table} (${columns}) VALUES (${values})`
		case "update":
			return `UPDATE ${table} SET ${cells[0].column} = ${cells[0].column} WHERE ${keyMatch(host, b.relation, cells, "")}`
		case "delete":
			return `DELETE FROM ${table} WHERE ${keyMatch(host, b.relation, cells, "")}`
		case "zero-row delete":
			return `DELETE FROM ${table} WHERE false`
		case "truncate":
			return `TRUNCATE ${table}`
		case "merge":
			return `MERGE INTO ${table} AS "t" USING (SELECT 1) AS "s" ON ${keyMatch(host, b.relation, cells, `"t".`)} WHEN MATCHED THEN DELETE WHEN NOT MATCHED THEN INSERT (${columns}) VALUES (${values})`
	}
}

/** The read a planted case makes: a count of the relation's rows. */
export const readSql = (s: BelowSpelling, relation: string): string =>
	`SELECT count(*)::text FROM ${s.table(relation)}`

const succeeded = (o: StepOutcome | undefined): boolean => o?._tag === "Ok"

/**
 * Why a planted transaction's outcomes, its moves' in order (its BEGIN, its read, its write, then its COMMIT), are not
 * what its case predicts, or undefined. A write is refused at the write statement by its first refusal, the guard's
 * naming the installed schema and the relation's table, and its COMMIT answers ROLLBACK; a read-only transaction
 * commits.
 */
export const belowDeparture = (
	host: HostSchema,
	schema: string,
	b: Below,
	outcomes: ReadonlyArray<StepOutcome>
): string | undefined => {
	const [begun, ...rest] = outcomes
	if (!succeeded(begun)) {
		return `the planted BEGIN at ${b.level} did not succeed`
	}
	switch (b.kind) {
		case "read only": {
			const [read, commit] = rest
			if (!succeeded(read)) {
				return `a read at ${b.level} did not succeed`
			}
			return succeeded(commit) ? undefined : `a read-only transaction at ${b.level} did not commit`
		}
		case "write": {
			const [read, write, commit] = b.read ? rest : [undefined, ...rest]
			if (b.read && !succeeded(read)) {
				return `the read before the write at ${b.level} did not succeed`
			}
			const refusal = refusalOf(host, b)
			const code = refusalCodes[refusal]
			if (write?._tag !== "PgError" || write.fields.code !== code) {
				return `the ${b.form} of ${b.relation} at ${b.level} was not refused by ${refusal} (${code})`
			}
			const table = relationOf(host, b.relation).table
			if (
				refusal === "the guard" &&
				!(
					Option.contains(write.fields.schema, schema) && Option.contains(write.fields.table, table)
				)
			) {
				return `the guard's refusal of the ${b.form} at ${b.level} does not name ${schema}.${table}`
			}
			return commit?._tag === "RolledBack"
				? undefined
				: `the refused ${b.form}'s COMMIT did not answer ROLLBACK`
		}
	}
}
