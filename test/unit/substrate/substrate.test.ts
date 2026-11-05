import { describe, it } from "@effect/vitest"
import { assertNone, assertSome } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { array, element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { identifierOf, identity, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { assert } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName, wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	allocatingPid,
	assertIdentifier,
	defaultSchemaLabel,
	roleName,
	rolePrefix,
	uniqueSchemaName
} from "#test/support/substrate/names.ts"
import { parseVerboseError } from "#test/support/substrate/psql.ts"

/**
 * The database-free parts of the native PG test substrate.
 *
 * One line psql may print around a failed statement: a severity line, which opens PostgreSQL's report of the failure
 * and carries its message, or any other line.
 */
type StderrLine =
	| { readonly kind: "severity"; readonly line: string; readonly message: string }
	| { readonly kind: "other"; readonly line: string }

/** A failure psql reports itself, a client-side error, has no severity line. */
const stderrLines: Arr.NonEmptyReadonlyArray<StderrLine> = [
	{ kind: "other", line: "NOTICE:  00000: earlier notice" },
	{ kind: "other", line: "WARNING:  01000: a warning" },
	{ kind: "other", line: "LOCATION:  exec_stmt_raise, pl_exec.c:3956" },
	{ kind: "other", line: "DETAIL:  Key (k)=(1) already exists." },
	{ kind: "other", line: "psql:<stdin>:3: error: connection to server was lost" },
	{ kind: "severity", line: "ERROR:  22012: division by zero", message: "division by zero" },
	{
		kind: "severity",
		line: "psql:<stdin>:4: FATAL:  57P01: terminating connection due to administrator command",
		message: "terminating connection due to administrator command"
	}
]

/** Every role, login and role schema name minted under an allocated schema. */
const mintedUnder = (schema: string): ReadonlyArray<string> => {
	const installation = identity.schema(parsedSchemaName(schema))
	return [
		identifierOf(identity.role(installation, parsedName("Worker"))),
		identifierOf(identity.login(installation, parsedName("web"))),
		identifierOf(identity.roleSchema(identity.role(installation, parsedName("Worker")))),
		roleName(schema, "worker")
	]
}

describe("substrate names", () => {
	it.effect(
		"installs an allocated schema as allocated, and every role and role schema under it with its prefix",
		(ctx) =>
			Effect.gen(function* () {
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/substrate/allocated-names",
							/** Each label at each of the first 200 allocation indices. */
							generator: (source) =>
								[
									source.draw(element([defaultSchemaLabel, "ledger", "pay_roll"])),
									source.draw(int(0, 199))
								] as const,
							literal: Formatter.format,
							limit: 600,
							coverage: noCoverage,
							caseHang
						},
						([label, index]) =>
							Effect.sync(() => {
								const schema = uniqueSchemaName(label, index)
								const installation = identity.schema(parsedSchemaName(schema))
								assert.equal<string>(identifierOf(installation), schema)
								const prefix = rolePrefix(schema)
								for (const name of mintedUnder(schema)) {
									assert.ok(Str.startsWith(prefix)(name), `${name} starts with ${prefix}`)
								}
							})
					)
				)
				assert.throwsAny(() => uniqueSchemaName("gzs2", 0))
				assert.throwsAny(() => roleName(uniqueSchemaName(defaultSchemaLabel, 0), "worker2"))
				assert.throwsAny(() => roleName("gzs_1k", "worker"))
			})
	)

	it.effect(
		"recovers the allocating process from any name minted under an allocation, so the global setup can sweep a dead one's",
		(ctx) =>
			Effect.gen(function* () {
				const schema = uniqueSchemaName("counter_example", 0)
				const installation = identity.schema(parsedSchemaName(schema))
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/substrate/allocating-pid",
							generator: element([
								schema,
								roleName(schema, "member"),
								identifierOf(installation),
								identifierOf(identity.role(installation, parsedName("Member")))
							]),
							literal: Formatter.format,
							limit: 4,
							coverage: noCoverage,
							caseHang
						},
						(name) =>
							Effect.sync(() => {
								assertSome(allocatingPid(name), process.pid)
							})
					)
				)
				assertSome(allocatingPid("gzs_70000_3_0000000005_anon_abcdefgh23"), 70_000)
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/substrate/unallocated-names",
							generator: element([
								"dbg__member",
								"public",
								"gzs_ab_c_short__anon",
								"gzs_12_3_45__anon"
							]),
							literal: Formatter.format,
							limit: 4,
							coverage: noCoverage,
							caseHang
						},
						(name) =>
							Effect.sync(() => {
								assertNone(allocatingPid(name))
							})
					)
				)
			})
	)

	it("never lets PostgreSQL truncate a name", () => {
		assertIdentifier(Str.repeat(maxIdentifierBytes.value)("a"))
		assert.throwsAny(() => {
			assertIdentifier(Str.repeat(maxIdentifierBytes.value + 1)("a"))
		})
		assert.throwsAny(() => roleName(uniqueSchemaName(defaultSchemaLabel, 0), Str.repeat(60)("x")))
		assert.throwsAny(() => uniqueSchemaName("Bad", 0))
	})
})

describe("psql writer protocol", () => {
	it("parses psql's verbose error report", () => {
		/** A hand-made table's constraint, a name no production rule produces. */
		const factKey = wild.constraint("fact_key")
		const stderr = Arr.join(
			[
				"NOTICE:  00000: earlier notice",
				"LOCATION:  exec_stmt_raise, pl_exec.c:3956",
				`ERROR:  23505: duplicate key value violates unique constraint "${factKey}"`,
				"DETAIL:  Key (k)=(1) already exists.",
				"HINT:  Put a key no fact holds.",
				'CONTEXT:  SQL statement "INSERT INTO fact VALUES (1)"',
				"SCHEMA NAME:  s",
				"TABLE NAME:  fact",
				`CONSTRAINT NAME:  ${factKey}`,
				"LOCATION:  _bt_check_unique, nbtinsert.c:676",
				""
			],
			"\n"
		)
		assert.deepEqual(parseVerboseError("23505", stderr), {
			code: "23505",
			message: `duplicate key value violates unique constraint "${factKey}"`,
			detail: Option.some("Key (k)=(1) already exists."),
			hint: Option.some("Put a key no fact holds."),
			where: Option.some('SQL statement "INSERT INTO fact VALUES (1)"'),
			schema: Option.some("s"),
			table: Option.some("fact"),
			column: Option.none(),
			dataType: Option.none(),
			constraint: factKey
		})
		assert.deepEqual(
			parseVerboseError("22012", "psql:<stdin>:3: ERROR:  22012: division by zero\n"),
			{
				code: "22012",
				message: "division by zero",
				detail: Option.none(),
				hint: Option.none(),
				where: Option.none(),
				schema: Option.none(),
				table: Option.none(),
				column: Option.none(),
				dataType: Option.none(),
				constraint: undefined
			}
		)
	})

	it.effect(
		"finds no report in stderr without a severity line, and reads a report's message from the last one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/substrate/psql-report",
						/**
						 * Every stderr of up to three of the lines, each ending in a newline: 400 of them, with no severity
						 * line, one, or several in either order.
						 */
						generator: array(element(stderrLines), { min: 0, max: 3 }),
						literal: Formatter.format,
						limit: 400,
						coverage: requiredInSpace<"no report" | "reported">(["no report", "reported"]),
						caseHang
					},
					(lines, c) =>
						Effect.sync(() => {
							const report = parseVerboseError(
								"XX000",
								Arr.join(
									Arr.map(lines, (l) => `${l.line}\n`),
									""
								)
							)
							c.note(report === undefined ? "no report" : "reported")
							const messages = Arr.flatMap(lines, (l) => (l.kind === "severity" ? [l.message] : []))
							assert.equal(report?.message, messages.at(-1))
						})
				)
			)
	)
})
