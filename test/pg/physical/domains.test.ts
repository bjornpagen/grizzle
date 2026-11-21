/**
 * Shared domains on PostgreSQL 19: a contract's domain is named by the digest of its physical definition,
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
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import {
	type DomainFeature,
	type Pair,
	pairGen,
	same,
	schemaOf
} from "#test/pg/physical/domains.fixtures.ts"
import { soleLawOfConstraint } from "#test/support/constraint-law.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Shared domains on PostgreSQL 19 type two contracts' columns by one domain exactly when their definitions are equal, each column enforcing its contract.
 *
 * Its pre-conversion budget: runs 8, coverage cases 16 (test/pg/physical/domains.test.ts at d8eed1786).
 */
export const sharedDomainsOnPostgreSQL19TypeTwoContractsColumnsByOneDomainExactlyWhenTheirDefinitionsAreEqualEachColumnEnforcingItsContract =
	property.explore(pairGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"one definition shares one domain",
			"two definitions take two domains",
			"a shared domain refuses each contract's violation"
		] satisfies ReadonlyArray<Reached<DomainFeature>>,
		check:
			({ substrate }, c: Case<DomainFeature>) =>
			(p: Pair) =>
				Effect.provideServiceEffect(
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
						c.note(shared ? "one definition shares one domain" : "two definitions take two domains")
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
									? soleLawOfConstraint(
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
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "universal",
			name: "metamorphic: equal definitions share one domain, and different ones never do; PostgreSQL judges each contract"
		},
		budget: { runs: 8, steered: 16 },
		kept: [],
		kills: []
	})
