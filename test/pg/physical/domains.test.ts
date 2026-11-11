/**
 * Shared domains on PostgreSQL 19rc1: a contract's domain is named by the digest of its physical definition,
 * so two contracts of one definition share one domain and two of different definitions never do, and each column the
 * shared domain types still enforces its contract, its violation refused with 23514 on that domain.
 *
 * - **PostgreSQL as the judge, metamorphic:** for drawn pairs of contracts, each over a base (int4 or int8) and a
 *   least admitted value from -1 to 1, the second the first's definition one draw in three, the installed columns of
 *   the two are of one type exactly when the pair's definitions are equal; each column admits a drawn value its
 *   predicate holds of and refuses, with 23514 on its column's domain reporting a contract law of the installation, a
 *   drawn value its predicate refuses.
 *
 * Features: one definition sharing one domain, two definitions taking two, and a shared domain refusing each
 * contract's violation.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): domains-named-by-contract (a contract's domain is named by its
 * definition and its contract's name, so two contracts of one definition never share one).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Base = "int4" | "int8"

/** A contract's physical definition: its base and the least value its predicate admits. */
interface Definition {
	readonly base: Base
	readonly least: number
}

/** Contract A under a definition. */
const contractA = (d: Definition) =>
	d.base === "int4"
		? contract("A", pg.int4, (v) => v.ge(d.least))
		: contract("A", pg.int8, (v) => v.ge(BigInt(d.least)))

/** Contract B under a definition. */
const contractB = (d: Definition) =>
	d.base === "int4"
		? contract("B", pg.int4, (v) => v.ge(d.least))
		: contract("B", pg.int8, (v) => v.ge(BigInt(d.least)))

const schemaOf = (a: Definition, b: Definition) =>
	schema(
		"fin_domains",
		[relation("R", { id: pg.int4, a: contractA(a), b: contractB(b) }, ["id"])],
		[]
	)

/** Two contracts' definitions, and how far above and below each one's least value the written values lie. */
interface Pair {
	readonly a: Definition
	readonly b: Definition
	readonly above: number
	readonly below: number
}

const definitionGen: Gen<Definition> = (source) => ({
	base: source.draw(boolean) ? "int8" : "int4",
	least: source.draw(int(-1, 1))
})

const pairGen: Gen<Pair> = (source) => {
	const a = source.draw(definitionGen)
	return {
		a,
		b: source.draw(
			weighted<Definition>([
				[1, constant(a)],
				[2, definitionGen]
			])
		),
		above: source.draw(int(0, 2)),
		below: source.draw(int(1, 3))
	}
}

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
				explore(
					{
						suite: "fin/domains",
						draw: drawn(pairGen),
						literal: Formatter.format,
						oracle: {
							kind: "universal",
							name: "metamorphic: equal definitions share one domain, and different ones never do; PostgreSQL judges each contract"
						},
						coverage: required<DomainFeature>(
							[
								"one definition shares one domain",
								"two definitions take two domains",
								"a shared domain refuses each contract's violation"
							],
							{ cases: 16, sense: notesOnly }
						),
						kept: [],
						runs: 8,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
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
							const lawful = yield* write(p.a.least + p.above, p.b.least + p.above)
							assert.equal(
								lawful.kind,
								"committed",
								`${Formatter.format(p)}: each contract's admitted value commits`
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
								["a", p.a, p.a.least - p.below, p.b.least],
								["b", p.b, p.a.least, p.b.least - p.below]
							] as const) {
								const real = yield* write(a, b)
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
