import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import { conversionOf, parseDeclaredName } from "#compiler/core/identity.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { CredentialError, Db, DbLayer, OpenError, relation, schema, uuid } from "#index.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { admittedNames, aliasGroups } from "#test/support/kernel/dict.ts"
import { atDeclaredName, installationOf } from "#test/support/kernel/naming.ts"
import { fromEmpty, generate } from "#test/support/migrate/kit.ts"
import { elementAt, nonEmptyList } from "#test/support/oracle/pick.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The public-API error matrix, opening's part: a schema that does not compile fails its DbLayer at the stage schema,
 * with the CompileError as its cause, before any connection.
 *
 * A property over drawn schemas of two relations of two fields each, every relation and field named from the identifier
 * dictionary (test/support/kernel/dict.ts), whose alias groups are names the production conversion maps to one
 * identifier. A schema whose two relations, or two fields of one relation, convert to one identifier does not compile:
 * DbLayer.make, which owns its login's base when the layer is built, fails with OpenError{stage: "schema"} whose cause
 * is that CompileError, IdentifierCollision; fields of different relations live in different scopes and never collide.
 * A schema that compiles is refused by the layer's startup check at the stage schema too: the snapshot it is given is
 * another schema's (WorkloadUngenerated).
 * Either way no connection is attempted, which the password Effect, evaluated by every attempt, counts, so no database
 * is needed.
 *
 * The other stages are provoked elsewhere, each through Db.open and asserted by stage:
 * - role (a role no provided login holds, a value that is not a role), token, settings, locale, capability,
 *   credential: test/pg/reads/suites/open.ts.
 * The stage version needs a server other than PostgreSQL 19, which is server configuration, not grizzle's code,
 * so it is not provoked.
 *
 * Two distinct names of one scope, drawn from one alias group (they collide) or from anywhere in the dictionary.
 */
type PairSketch = readonly [first: string, second: string]

/** The admitted names' declared spellings, every name of the dictionary. */
const declaredNames: ReadonlyArray<string> = Arr.map(admittedNames, (n) => n.declared)

/** Two distinct names of `pool`: the second is any other name of it, so the two never coincide as declared. */
const pairIn =
	(pool: ReadonlyArray<string>): Gen<PairSketch> =>
	(source) => {
		const first = source.draw(int(0, pool.length - 1))
		const second = (first + 1 + source.draw(int(0, pool.length - 2))) % pool.length
		return [elementAt(pool, first, "the names"), elementAt(pool, second, "the names")]
	}

const pairGen: Gen<PairSketch> = (source) =>
	source.draw(
		pairIn(
			source.draw(boolean)
				? source.draw(element(nonEmptyList(aliasGroups, "the alias groups")))
				: declaredNames
		)
	)

interface SchemaSketch {
	readonly relations: PairSketch
	readonly fields: readonly [PairSketch, PairSketch]
}

const schemaSketchGen: Gen<SchemaSketch> = (source) => ({
	relations: source.draw(pairGen),
	fields: [source.draw(pairGen), source.draw(pairGen)]
})

/**
 * Whether two declared names convert to one identifier, by the naming door's rule every name of the dictionary was
 * admitted by (core/identity.ts parseDeclaredName).
 */
const collide = (a: string, b: string): boolean => {
	const x = parseDeclaredName(a)
	const y = parseDeclaredName(b)
	return x.ok && y.ok && conversionOf(x.value) === conversionOf(y.value)
}

type OpenFeature =
	| "relations collide"
	| "fields of one relation collide"
	| "compiles"
	| "fields alike across relations"

/** The snapshot.json of a schema none drawn is, as an import of it yields: every layer here is given it. */
const otherSnapshot = snapshotJson(
	succeeded(
		generate({
			installation: installationOf(
				schema("Other", { Thing: relation("Thing", { id: uuid }, ["id"]) }, []),
				atDeclaredName
			),
			name: "other",
			timestamp: "20261024000000",
			previous: fromEmpty,
			workload: noWorkload
		}),
		"the other schema's first migration"
	).snapshotText
)

/** The pair of the dictionary's first name and the first name after it that converts to another identifier. */
const firstDistinctPair = (): PairSketch => {
	const [first, ...rest] = declaredNames
	if (first === undefined) {
		throw new Error("the dictionary admits no name")
	}
	for (const second of rest) {
		if (!collide(first, second)) {
			return [first, second]
		}
	}
	throw new Error("every admitted name converts to the first one's identifier")
}

/**
 * Planted: one distinct pair for both relations and both relations' fields, which collides nowhere and repeats across
 * relations, where a drawn schema compiles a few times a run.
 */
const openKept: ReadonlyArray<Kept<SchemaSketch, OpenFeature>> = [
	{
		note: "one distinct pair everywhere",
		sketch: { relations: firstDistinctPair(), fields: [firstDistinctPair(), firstDistinctPair()] },
		draws: "",
		reaches: ["compiles", "fields alike across relations"]
	}
]

layer(InitializedCluster.layer)("Db.open errors through the public API", (it) => {
	it.effect(
		"a schema that does not compile fails its DbLayer with OpenError{stage: schema} and its CompileError, before connecting",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const cluster = yield* InitializedCluster
					return yield* explore(
						{
							suite: "api-errors/open",
							draw: drawn(schemaSketchGen),
							literal: Formatter.format,
							kept: openKept,
							runs: 100,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2),
							coverage: required<OpenFeature>(
								[
									"relations collide",
									"fields of one relation collide",
									"compiles",
									"fields alike across relations"
								],
								{ cases: 100, sense: notesOnly }
							)
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const [r1, r2] = sketch.relations
								const [a1, b1] = sketch.fields[0]
								const [a2, b2] = sketch.fields[1]
								const R1 = relation(r1, { [a1]: uuid, [b1]: uuid }, [a1])
								const R2 = relation(r2, { [a2]: uuid, [b2]: uuid }, [a2])
								const drawnSchema = schema("Drawn", { [r1]: R1, [r2]: R2 }, [])
								const world = fullWorld(drawnSchema)
								const collision = collide(r1, r2) || collide(a1, b1) || collide(a2, b2)
								if (collide(r1, r2)) {
									c.note("relations collide")
								}
								if (collide(a1, b1) || collide(a2, b2)) {
									c.note("fields of one relation collide")
								}
								if (!collision) {
									c.note("compiles")
								}
								if (Arr.some([a1, b1], (f) => Arr.some([a2, b2], (g) => collide(f, g)))) {
									c.note("fields alike across relations")
								}
								/**
								 * Every connection attempt evaluates the password Effect: one that ran would be counted.
								 */
								let attempts = 0
								const password = Effect.suspend(() => {
									attempts++
									return Effect.fail(new CredentialError({ cause: "no connection is expected" }))
								})
								const layer = DbLayer.make({
									login: world.server,
									snapshot: otherSnapshot,
									host: pgPin.host,
									port: pgPin.port,
									database: "postgres",
									password,
									tls: { ca: cluster.caPem }
								})
								/**
								 * A schema that does not compile fails the layer; one that compiles fails it too, at the
								 * startup check of the other schema's snapshot it is given.
								 */
								const error = yield* Effect.flip(
									Effect.scoped(Db.open(world.server.roles.app, {})).pipe(withLayer(layer))
								)
								assert.ok(error instanceof OpenError, String(error))
								assert.equal(error.stage, "schema")
								assert.equal(attempts, 0, "no connection is attempted")
								if (collision) {
									assert.ok(isCompileError(error.reason), String(error.reason))
									assert.equal(error.reason.reason._tag, "IdentifierCollision")
								} else {
									assert.ok(error.reason._tag === "WorkloadUngenerated", String(error.reason))
									assert.equal(error.reason.fault.kind, "schema")
								}
							})
					)
				})
			)
	)
})
