import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { aggregateOverload } from "#compiler/scalar/aggregate.ts"
import {
	type AggregateFeature,
	aggregateProblems,
	callGen,
	keptContract
} from "#test/pg/compute/aggregate.fixtures.ts"
import { concreteTypeName } from "#test/pg/compute/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Aggregate typing against PostgreSQL 19 types count(*) and every aggregate as pg_aggregate and pg_typeof do, keeps a contract exactly through an extreme, and refuses what PostgreSQL lacks.
 */
export const aggregateTypingAgainstPostgreSQL19TypesCountAndEveryAggregateAsPgAggregateAndPgTypeofDoKeepsAContractExactlyThroughAnExtremeAndRefusesWhatPostgreSQLLacks =
	property.exhaust(finite(callGen), {
		needs: { substrate: Substrate.installing },
		situations: [
			"checked count(*)",
			"checked min/code",
			"checked sum/Cents",
			"checked sum/int2",
			"checked sum/int4",
			"checked max/Cents",
			"checked min/bool"
		] satisfies ReadonlyArray<Reached<AggregateFeature>>,
		check:
			({ substrate }, c: Case<AggregateFeature>) =>
			(call) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { session, schema } = yield* Substrate
						const db = yield* session(ownerSession())
						const s = yield* schema(freshSchema)
						yield* db.query(
							`CREATE DOMAIN "${s}".mood AS smallint CONSTRAINT mood_check CHECK ((VALUE BETWEEN 0 AND 2) IS TRUE)`,
							[]
						)
						yield* db.query(
							`CREATE DOMAIN "${s}".cents AS bigint CONSTRAINT cents_check CHECK ((VALUE >= 0) IS TRUE)`,
							[]
						)

						if (call.kind === "count") {
							const count = succeeded(aggregateOverload({ name: "count" }, SourceLoc("test", [])))
							const [row] = yield* db.values(
								"SELECT pg_typeof(count(*))::text, to_regprocedure('count()')::regprocedure::text FROM (VALUES (1)) AS t(x)",
								[]
							)
							assert.deepEqual(row, [concreteTypeName[count.result.carrier], count.op])
							c.note("checked count(*)")
							return
						}
						const { sample, name } = call
						const outcome = yield* aggregateProblems(db, s, sample, name)
						assert.deepEqual(outcome.problems, [])
						const overload = aggregateOverload({ name, arg: sample.type }, SourceLoc("test", []))
						if (overload.ok) {
							assert.equal<string | undefined>(
								overload.value.result.contract?.name,
								keptContract(name, sample.type),
								`${name}/${sample.label}'s contract`
							)
						}
						if (outcome.checked) {
							c.note(`checked ${name}/${sample.label}`)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "pg_aggregate's resolution and pg_typeof's result of each call"
		},
		box: "count(*), and every aggregate over every sample",
		kept: [],
		kills: []
	})
