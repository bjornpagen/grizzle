/**
 * Shared domains on PostgreSQL 19rc1 (W6.Q10): a contract's domain is named by the digest of its physical definition,
 * so two contracts of one definition share one domain and two of different definitions never do, and each column the
 * shared domain types still enforces its contract, its violation refused with 23514 on that domain.
 *
 * - **PostgreSQL as the judge, metamorphic:** for every pair of contracts over two bases (int4 and int8) and two
 *   predicates (≥ 0 and ≥ 1), the installed columns of the two are of one type exactly when the pair's definitions are
 *   equal; each column admits a value its predicate holds of and refuses, with 23514 on its column's domain reporting a
 *   contract law of the installation, a value its predicate refuses.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Base = "int4" | "int8"
type Least = 0 | 1

/** A contract's physical definition: its base and the least value its predicate admits. */
interface Definition {
	readonly base: Base
	readonly least: Least
}

const DEFINITIONS: Arr.NonEmptyReadonlyArray<Definition> = [
	{ base: "int4", least: 0 },
	{ base: "int4", least: 1 },
	{ base: "int8", least: 0 },
	{ base: "int8", least: 1 }
]

/** A definition's key in the contract tables. */
const keyOf = (d: Definition) => `${d.base} ${d.least}` as const

/** Contract A under each definition. */
const A = {
	"int4 0": contract("A", pg.int4, (v) => v.ge(0)),
	"int4 1": contract("A", pg.int4, (v) => v.ge(1)),
	"int8 0": contract("A", pg.int8, (v) => v.ge(0n)),
	"int8 1": contract("A", pg.int8, (v) => v.ge(1n))
}

/** Contract B under each definition. */
const B = {
	"int4 0": contract("B", pg.int4, (v) => v.ge(0)),
	"int4 1": contract("B", pg.int4, (v) => v.ge(1)),
	"int8 0": contract("B", pg.int8, (v) => v.ge(0n)),
	"int8 1": contract("B", pg.int8, (v) => v.ge(1n))
}

const schemaOf = (a: Definition, b: Definition) =>
	schema(
		"fin_domains",
		{ R: relation("R", { id: pg.int4, a: A[keyOf(a)], b: B[keyOf(b)] }, ["id"]) },
		[]
	)

interface Pair {
	readonly a: Definition
	readonly b: Definition
}

const PAIRS: Arr.NonEmptyReadonlyArray<Pair> = nonEmpty(
	Arr.flatMap(DEFINITIONS, (a) => Arr.map(DEFINITIONS, (b) => ({ a, b })))
)

type DomainFeature =
	| "one definition shares one domain"
	| "two definitions take two domains"
	| "a shared domain refuses each contract's violation"

const same = (p: Pair): boolean => p.a.base === p.b.base && p.a.least === p.b.least

layer(Substrate.layer)("shared domains on PostgreSQL 19rc1", (it) => {
	it.effect(
		"type two contracts' columns by one domain exactly when their definitions are equal, each column enforcing its contract",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "fin/domains",
						generator: element(PAIRS),
						literal: Formatter.format,
						limit: PAIRS.length,
						box: "every pair of contracts over two bases, int4 and int8, and two predicates, ≥ 0 and ≥ 1",
						oracle: {
							kind: "universal",
							name: "metamorphic: equal definitions share one domain, and different ones never do; PostgreSQL judges each contract"
						},
						coverage: requiredInSpace<DomainFeature>([
							"one definition shares one domain",
							"two definitions take two domains",
							"a shared domain refuses each contract's violation"
						]),
						caseHang
					},
					(p: Pair, c) =>
						Effect.gen(function* () {
							const seat = yield* seatOf(schemaOf(p.a, p.b), ["R"], "domains")
							const table = seat.table("R")
							const write = (a: number, b: number) =>
								attempt(seat.session, [
									`INSERT INTO ${table} (${seat.column("R", "id")}, ${seat.column("R", "a")}, ${seat.column("R", "b")}) VALUES (1, ${a}, ${b})`
								])
							const lawful = yield* write(p.a.least, p.b.least)
							assert.equal(
								lawful.kind,
								"committed",
								`${Formatter.format(p)}: each contract's least value commits`
							)
							const types = yield* seat.session.values(
								`SELECT pg_catalog.pg_typeof(${seat.column("R", "a")})::text, pg_catalog.pg_typeof(${seat.column("R", "b")})::text FROM ${table}`,
								[]
							)
							const [ta, tb] = Arr.map(Arr.getUnsafe(types, 0), String)
							const shared = ta === tb
							assert.equal(
								shared,
								same(p),
								`${Formatter.format(p)}: the columns' domains ${ta} and ${tb}`
							)
							c.note(
								shared ? "one definition shares one domain" : "two definitions take two domains"
							)
							yield* cleared(seat, ["R"])
							for (const [column, d, a, b] of [
								["a", p.a, p.a.least - 1, p.b.least],
								["b", p.b, p.a.least, p.b.least - 1]
							] as const) {
								const real = yield* write(a, b)
								yield* seat.session.resetStatements
								const domain =
									real.kind === "refused" ? Option.getOrUndefined(real.fields.dataType) : undefined
								const law =
									real.kind === "refused" &&
									domain !== undefined &&
									real.fields.constraint !== undefined
										? constraintLaw(
												seat.installed.installation.constraintToLaw,
												{ kind: "domain", name: admittedIdentifier(domain) },
												real.fields.constraint
											)
										: undefined
								assert.ok(
									real.kind === "refused" && real.fields.code === "23514" && law !== undefined,
									`${Formatter.format(p)}: column ${column} below ${d.least} is refused with 23514 on its domain reporting a contract's law: ${real.kind === "refused" ? refusalText(real.fields) : "committed"}`
								)
							}
							if (shared) {
								c.note("a shared domain refuses each contract's violation")
							}
						}).pipe(Effect.scoped)
				)
			)
	)
})
