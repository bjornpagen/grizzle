/** What the properties of foreign-key-types.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import type {
	ColumnDef,
	ForeignKey,
	ObjectName,
	PrimaryKey,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import { cUtf8Collation, lit, namedType, types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { messageOf } from "#test/support/message.ts"
import { emptyState, interpret, type ModelFile } from "#test/support/migrate/interpret.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"

const referencedTable = "referenced"

const referencingTable = "referencing"

const keyColumn = "k"

const referenceColumn = "r"

/** The referencing table's own key, over a column of its own, so a conversion of the referencing column reaches the
 * foreign key alone. */
const ownKeyColumn = "id"

const keyName = wild.constraint("referenced_key")

const ownKeyName = wild.constraint("referencing_own_key")

const referenceName = wild.constraint("referencing_key")

const rosterA = "kind_a"

const rosterB = "kind_b"

const bigDomain = "big"

/** A column type of the space: its name in features, the type, and a text of a value of it, which a conversion writes. */
interface ColumnType {
	readonly name: string
	readonly type: (schema: string) => TypeRef
	readonly sample: string
}

const builtin = (name: string, type: TypeRef, sample: string): ColumnType => ({
	name,
	type: () => type,
	sample
})

const named = (name: string, type: string, sample: string): ColumnType => ({
	name,
	type: (schema) => namedType(testTypeSchema(schema), type, []),
	sample
})

const columnTypes: Arr.NonEmptyReadonlyArray<ColumnType> = [
	builtin("smallint", types.smallint, "1"),
	builtin("integer", types.integer, "1"),
	builtin("bigint", types.bigint, "1"),
	builtin("numeric", types.numeric, "1"),
	builtin("real", types.real, "1"),
	builtin("double precision", types.double, "1"),
	builtin("boolean", types.boolean, "true"),
	builtin("text", types.text, "a"),
	builtin("uuid", types.uuid, "00000000-0000-4000-8000-000000000001"),
	builtin("money", types.money, "1"),
	named("roster domain a", rosterA, "1"),
	named("roster domain b", rosterB, "1"),
	named("domain over bigint", bigDomain, "1")
]

/** The ways a key comes to join a referencing column of one type to a referenced key of another. */
export const ways = ["created", "referencing converted", "referenced converted"] as const

type Way = (typeof ways)[number]

type Verdict = { readonly kind: "implemented" } | { readonly kind: "refused"; readonly at: number }

export type KeyFeature = `${Way}: ${"implemented" | "refused"}`

/** A case of the space: a way to make the key, the referencing column's type and the referenced key's. */
export const keyCaseGen: Gen<readonly [Way, ColumnType, ColumnType]> = (source) =>
	[
		source.draw(element(ways)),
		source.draw(element(columnTypes)),
		source.draw(element(columnTypes))
	] as const

const isText = (type: TypeRef): boolean =>
	type.kind === "builtin" && type.name === "text" && !type.array

const column = (name: string, type: TypeRef): ColumnDef => ({
	name,
	type,
	collation: isText(type) ? cUtf8Collation : undefined,
	generated: undefined
})

/** A domain over smallint with no constraint: what a roster's closed ids are typed by, its CHECK aside. */
const rosterDomain = (schema: string, name: string): SqlStatement => ({
	kind: "createDomain",
	name: { schema, name },
	base: types.smallint,
	collation: undefined,
	constraints: []
})

/** The types the schema's columns may have that are none of PostgreSQL's: the two roster domains and the domain. */
export const setup = (schema: string): ReadonlyArray<SqlStatement> => [
	rosterDomain(schema, rosterA),
	rosterDomain(schema, rosterB),
	{
		kind: "createDomain",
		name: { schema, name: bigDomain },
		base: types.bigint,
		collation: undefined,
		constraints: []
	}
]

/** The statements of one case: the referencing column ends of type `from`, the referenced key of type `to`. */
export const statementsOf = (
	schema: string,
	way: Way,
	from: ColumnType,
	to: ColumnType
): ReadonlyArray<SqlStatement> => {
	const referenced: ObjectName = { schema, name: referencedTable }
	const referencing: ObjectName = { schema, name: referencingTable }
	const key: PrimaryKey = {
		kind: "primaryKey",
		name: keyName,
		columns: [{ column: keyColumn, withoutOverlaps: false }]
	}
	const ownKey: PrimaryKey = {
		kind: "primaryKey",
		name: ownKeyName,
		columns: [{ column: ownKeyColumn, withoutOverlaps: false }]
	}
	const reference: ForeignKey = {
		kind: "foreignKey",
		name: referenceName,
		columns: [{ column: referenceColumn, period: false }],
		references: referenced,
		referencedColumns: [{ column: keyColumn, period: false }],
		deferrable: undefined,
		onUpdate: undefined
	}
	const tables = (keyType: ColumnType, referenceType: ColumnType): ReadonlyArray<SqlStatement> => [
		{
			kind: "createTable",
			table: referenced,
			columns: [column(keyColumn, keyType.type(schema))],
			primaryKey: key,
			secondary: []
		},
		{
			kind: "createTable",
			table: referencing,
			columns: [
				column(ownKeyColumn, types.integer),
				column(referenceColumn, referenceType.type(schema))
			],
			primaryKey: ownKey,
			secondary: []
		},
		{
			kind: "alterTable",
			table: referencing,
			actions: [{ kind: "addConstraint", constraint: reference, notValid: false }]
		}
	]
	const convert = (table: ObjectName, name: string, into: ColumnType): SqlStatement => {
		const type = into.type(schema)
		return {
			kind: "alterTable",
			table,
			actions: [
				{
					kind: "alterColumnType",
					column: name,
					type,
					collation: isText(type) ? cUtf8Collation : undefined,
					using: { kind: "expr", expr: lit.text(into.sample, type) }
				}
			]
		}
	}
	switch (way) {
		case "created":
			return tables(to, from)
		case "referencing converted":
			return [...tables(to, to), convert(referencing, referenceColumn, from)]
		case "referenced converted":
			return [...tables(from, from), convert(referenced, keyColumn, to)]
	}
}

const asFile = (name: string, statements: ReadonlyArray<SqlStatement>): ModelFile => ({
	draft: { name },
	actions: Arr.map(statements, (statement) => ({ kind: "statement", statement }))
})

/** The model's verdict: the case's statements after the setup's, refused with 42804 at a statement or not refused. */
export const modelVerdict = (schema: string, statements: ReadonlyArray<SqlStatement>): Verdict => {
	const ran = interpret(
		schema,
		emptyState,
		[asFile("setup", setup(schema)), asFile("case", statements)],
		() => {
			throw new Error("the case writes no placeholder")
		}
	)
	if (Result.isSuccess(ran)) {
		return { kind: "implemented" }
	}
	const failure = ran.failure
	const refusal = failure.refusal
	if (failure.file !== "case" || refusal.kind !== "sqlstate" || refusal.code !== "42804") {
		return assert.fail(
			`the model refuses otherwise: ${failure.file}, action ${failure.action}, ${Formatter.format(refusal)}: ${failure.reason}`
		)
	}
	return { kind: "refused", at: failure.action }
}

/**
 * PostgreSQL's verdict on the case's statements in order, inside the case's one transaction, each statement its own
 * savepoint (Substrate.transaction): implemented, or refused at the first statement PostgreSQL refuses, with 42804.
 */
export const pgVerdict = (connection: PgConnection, statements: ReadonlyArray<SqlStatement>) =>
	Effect.gen(function* () {
		for (const [i, statement] of statements.entries()) {
			const ran = yield* Effect.result(connection.query(printStatement(statement), []))
			if (!Result.isFailure(ran)) {
				continue
			}
			assert.equal(
				pgErrorFields(ran.failure)?.code,
				"42804",
				`PostgreSQL refuses statement ${i + 1} otherwise: ${messageOf(ran.failure)}`
			)
			const refused: Verdict = { kind: "refused", at: i + 1 }
			return refused
		}
		const implemented: Verdict = { kind: "implemented" }
		return implemented
	})
