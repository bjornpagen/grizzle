import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Result, String as Str } from "effect"
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
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { emptyState, interpret, type ModelFile } from "#test/support/migrate/interpret.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The test's own tables, columns, constraints and types, in a schema of its own: names no installation has.
 *
 * The migration model's foreign key rule (`comparable`) against PostgreSQL.
 *
 * PostgreSQL implements a foreign key by an equality of the operator family of the referenced key's index, and refuses
 * a key whose columns have none (42804, "cannot be implemented"): when the key is added, and when a column on either
 * side changes type, after which it adds the key again at the end of the statement. The model refuses at the same
 * statements, so a drafted migration that converts a column under a foreign key whose sides then do not compare fails
 * in the unit box as it does on PostgreSQL.
 *
 * The space is exhaustive: every ordered pair of column types from the types a column can have (each builtin with an
 * index, two enums of one roster, and a domain over bigint), and a key from a column of the first to a key of the
 * second made three ways: with the two tables; over the second type with the referencing column then converted to
 * the first; over the first type with the referenced column then converted to the second. PostgreSQL, each case in a
 * transaction it rolls back, and the model, from the same statements, implement the key or refuse it with 42804 at the
 * same statement, each verdict of each way a required feature. */
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
const enumA = "kind_a"
const enumB = "kind_b"
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
	named("enum a", enumA, "x"),
	named("enum b", enumB, "x"),
	named("domain over bigint", bigDomain, "1")
]

/** The ways a key comes to join a referencing column of one type to a referenced key of another. */
const ways = ["created", "referencing converted", "referenced converted"] as const
type Way = (typeof ways)[number]

type Verdict = { readonly kind: "implemented" } | { readonly kind: "refused"; readonly at: number }

type KeyFeature = `${Way}: ${"implemented" | "refused"}`

/** A case of the space: a way to make the key, the referencing column's type and the referenced key's. */
const keyCaseGen: Gen<readonly [Way, ColumnType, ColumnType]> = (source) =>
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

/** The two types the schema's columns may have that are none of PostgreSQL's: the enums and the domain. */
const setup = (schema: string): ReadonlyArray<SqlStatement> => [
	{ kind: "createEnum", name: { schema, name: enumA }, labels: ["x", "y"] },
	{ kind: "createEnum", name: { schema, name: enumB }, labels: ["x", "y"] },
	{
		kind: "createDomain",
		name: { schema, name: bigDomain },
		base: types.bigint,
		collation: undefined,
		constraints: []
	}
]

/** The statements of one case: the referencing column ends of type `from`, the referenced key of type `to`. */
const statementsOf = (
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
		deferrable: undefined
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
const modelVerdict = (schema: string, statements: ReadonlyArray<SqlStatement>): Verdict => {
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
	if (failure.file !== "case" || !Str.includes("(42804)")(failure.reason)) {
		return assert.fail(
			`the model refuses otherwise: ${failure.file}, action ${failure.action}: ${failure.reason}`
		)
	}
	return { kind: "refused", at: failure.action }
}

/** PostgreSQL's verdict: the case's statements in one transaction, rolled back. */
const pgVerdict = (session: RawSession, statements: ReadonlyArray<SqlStatement>) =>
	Effect.gen(function* () {
		yield* session.begin
		for (const [i, statement] of statements.entries()) {
			const ran = yield* Effect.result(session.query(printStatement(statement), []))
			if (!Result.isFailure(ran)) {
				continue
			}
			yield* session.rollback
			assert.equal(
				pgErrorFields(ran.failure)?.code,
				"42804",
				`PostgreSQL refuses statement ${i + 1} otherwise: ${messageOf(ran.failure)}`
			)
			const refused: Verdict = { kind: "refused", at: i + 1 }
			return refused
		}
		yield* session.rollback
		const implemented: Verdict = { kind: "implemented" }
		return implemented
	})

layer(Substrate.layer)("the migration model's foreign key types", (it) => {
	it.effect(
		"a key between two column types, created or converted on either side, is refused by PostgreSQL exactly when by the model",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					for (const statement of setup(schema)) {
						yield* s.admin.query(printStatement(statement), [])
					}
					const session = yield* s.session({ ...ownerSession(), label: "foreign key types" })
					return yield* exhaust(
						{
							suite: "pg/migrate/foreign-key-types",
							generator: keyCaseGen,
							literal: ([way, from, to]) => `${way}: ${from.name} → ${to.name}`,
							/** 3 ways × 13 × 13 types; the limit is the cap against a space grown by mistake. */
							limit: 507,
							coverage: requiredInSpace<KeyFeature>(
								Arr.flatMap(ways, (way) => [
									`${way}: implemented` as const,
									`${way}: refused` as const
								])
							),
							caseHang
						},
						([way, from, to], c) =>
							Effect.gen(function* () {
								const statements = statementsOf(schema, way, from, to)
								const pg = yield* pgVerdict(session, statements)
								c.note(`${way}: ${pg.kind}`)
								assert.deepEqual(
									modelVerdict(schema, statements),
									pg,
									`a ${from.name} column referencing a ${to.name} key, ${way}`
								)
							})
					)
				})
			)
	)
})
