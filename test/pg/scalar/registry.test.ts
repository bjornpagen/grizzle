/**
 * The scalar registry against the PostgreSQL 19 catalog: every descriptor names what PostgreSQL stores, and every
 * capability the registry claims is one PostgreSQL offers.
 *
 * - Spellings: every spelling of the pg namespace declares a column PostgreSQL stores as the type the descriptor
 *   names.
 * - numeric(p, s): for drawn typmods near and past numerictypmodin's bounds, the registry admits exactly what
 *   PostgreSQL admits, and names the typmod it stores.
 * - vector(n): for every dimension count within two of 1 and of the storage limit, the registry admits exactly what
 *   pgvector admits.
 * - Carriers: for every carrier, the capabilities the registry claims are, as a set, the catalog's (its operators,
 *   operator classes and aggregates over the carrier's type) less the documented exclusions, each of which the catalog
 *   offers; and a carrier is a range endpoint exactly where PostgreSQL has a discrete range over its type that the
 *   README does not name as a limit.
 *
 * Oracle: PostgreSQL itself, its catalog and the type a column's declaration stores.
 *
 * Features: "a type"; numeric's "admitted" and "refused"; vector's "refused below", "admitted" and "refused above"; and the carriers' "a
 * native capability excluded", "a spannable carrier", "a discrete range named as a limit" and "no discrete range".
 */

import { assert, contains, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { array, finite, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { numeric } from "#compiler/scalar/pg.ts"
import { vector } from "#compiler/scalar/vector.ts"
import { carrierWords, spellingWords } from "#test/pg/scalar/registry.dictionary.ts"
import {
	accepts,
	type CarrierFeature,
	carrierTypes,
	catalogNames,
	claimedBy,
	type DimensionsFeature,
	exclusions,
	installProbe,
	nativeOf,
	polymorphic,
	probe,
	storedAt,
	typnamesOf,
	typmodGen,
	unspanned
} from "#test/pg/scalar/registry.fixtures.ts"
import { vectorSchemaOf } from "#test/support/pg/codec/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { spelled } from "#test/support/unit/scalar/support.ts"

/**
 * Descriptors against the PostgreSQL 19 catalog: each of PostgreSQL's plain types is named, and tagged, by the
 * pg_type.typname PostgreSQL stores a column of it as.
 */
export const descriptorsAgainstThePostgreSQL19CatalogEachPlainTypeIsNamedByTheTypnamePostgreSQLStoresItAs =
	property.exhaust(finite(word(spellingWords)), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["a type"] satisfies ReadonlyArray<Reached<"a type">>,
		check:
			({ tx }, c: Case<"a type">) =>
			(spelling) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					return yield* Effect.map(typnamesOf(db, [spelling]), (stored) => {
						c.note("a type")
						assert.deepEqual(stored, [spelled(spelling).sql], spelling)
					})
				}),
		oracle: {
			kind: "postgresql",
			name: "the pg_type.typname PostgreSQL stores a column of the spelling as"
		},
		box: "every one of PostgreSQL's plain types that is a descriptor by itself",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/pg.ts",
				original: 'export const bool = plain("bool", carrierColumn("bool"))',
				replacement: 'export const bool = plain("boolean", carrierColumn("bool"))',
				why: "The bool descriptor is tagged by format_type's name, boolean, not by its typname; the spellings property fails."
			}
		]
	})

/**
 * Descriptors against the PostgreSQL 19 catalog accepts exactly the numeric typmods numerictypmodin accepts.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/scalar/registry.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/scalar/registry.test.ts` at its budget before,
 *   `{ runs: 2, steered: 2 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const descriptorsAgainstThePostgreSQL19CatalogAcceptsExactlyTheNumericTypmodsNumerictypmodinAccepts =
	property.explore(array(typmodGen, { min: 1, max: 400 }), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<"admitted" | "refused">>,
		budget: { runs: 1, steered: 2 },
		check:
			({ tx }, c: Case<"admitted" | "refused">) =>
			(pairs) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					yield* installProbe(db)

					const stored = yield* probe(
						db,
						Arr.map(pairs, ([p, s]) => `numeric(${p}, ${s})`)
					)
					for (const [i, [p, s]] of pairs.entries()) {
						const pgAccepts = !pipe(storedAt(stored, i), Str.startsWith("refused"))
						assert.equal(
							accepts(() => numeric(p, s)),
							pgAccepts,
							`numeric(${p}, ${s})`
						)
						c.note(pgAccepts ? "admitted" : "refused")
						if (pgAccepts) {
							assert.equal(stored[i], `numeric(${p},${s})`)
						}
					}
				}),
		oracle: { kind: "postgresql", name: "numerictypmodin, through a column's declaration" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					"\tif (!isInteger(scale) || scale < numericMinScale || scale > numericMaxScale) {",
				replacement:
					"\tif (!isInteger(scale) || scale < numericMinScale || scale > numericMaxScale + 1) {",
				why: "numerictypmodin's rule admits a scale one past its bound; the numeric(p, s) property fails."
			}
		]
	})

/** Descriptors against the PostgreSQL 19 catalog accepts exactly the vector dimensions pgvector accepts. */
export const descriptorsAgainstThePostgreSQL19CatalogAcceptsExactlyTheVectorDimensionsPgvectorAccepts =
	property.exhaust(
		finite(oneOf([int(-2, 3), int(vectorMaxDimensions - 2, vectorMaxDimensions + 2)])),
		{
			needs: { tx: Substrate.rolledBack(baseSubstrate) },
			situations: ["refused below", "admitted", "refused above"] satisfies ReadonlyArray<
				Reached<DimensionsFeature>
			>,
			check:
				({ tx }, c: Case<DimensionsFeature>) =>
				(n) =>
					Effect.gen(function* () {
						const { session: db } = yield* tx
						yield* installProbe(db)
						const vectorSchema = yield* vectorSchemaOf(db)
						return yield* Effect.map(probe(db, [`${vectorSchema}.vector(${n})`]), (stored) => {
							const pgAccepts = !pipe(storedAt(stored, 0), Str.startsWith("refused"))
							c.note(pgAccepts ? "admitted" : n < 1 ? "refused below" : "refused above")
							assert.equal(
								accepts(() => vector(n)),
								pgAccepts,
								`vector(${n})`
							)
							if (pgAccepts) {
								assert.match(storedAt(stored, 0), regex.as(`vector\\(${n}\\)$`))
							}
						})
					}),
			oracle: {
				kind: "postgresql",
				name: "pgvector's typmod input, through a column's declaration"
			},
			box: "every dimension count within two of 1 and of vectorMaxDimensions, and down to -2",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/vector.ts",
					original: "\t\tdimensions > vectorMaxDimensions",
					replacement: "\t\tdimensions > vectorMaxDimensions + 1",
					why: "vector admits one dimension past the limit; the vector(n) property fails."
				}
			]
		}
	)

/** Descriptors against the PostgreSQL 19 catalog claims only native capabilities, leaves out only the documented exclusions, and has range endpoints exactly where a built-in discrete range exists or its limit is named. */
export const descriptorsAgainstThePostgreSQL19CatalogClaimsOnlyNativeCapabilitiesLeavesOutOnlyTheDocumentedExclusionsAndHasSpanEndpointsExactlyWhereABuiltInDiscreteRangeExistsOrItsLimitIsNamed =
	property.exhaust(finite(word(carrierWords)), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a native capability excluded",
			"a spannable carrier",
			"a discrete range named as a limit",
			"no discrete range"
		] satisfies ReadonlyArray<Reached<CarrierFeature>>,
		check:
			({ tx }, c: Case<CarrierFeature>) =>
			(carrier) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					yield* db.query("CREATE EXTENSION IF NOT EXISTS btree_gist", [])
					const vectorSchema = yield* vectorSchemaOf(db)
					const types = carrierTypes(vectorSchema)

					const native = yield* nativeOf(db, types[carrier], polymorphic[carrier])
					const claimed = Arr.filter(claimedBy(carrier), (cap) => catalogNames.includes(cap))
					const excluded = exclusions[carrier] ?? []
					unorderedEqual(
						claimed,
						Arr.filter(native, (cap) => !excluded.includes(cap)),
						carrier
					)
					for (const cap of excluded) {
						contains(native, cap, `${carrier} excludes a native ${cap}`)
						c.note("a native capability excluded")
					}
					if (claimedBy(carrier).includes("expressionIndex")) {
						contains(native, "ordering", `${carrier} expression index`)
					}
					/**
					 * A carrier may be a range endpoint only where PostgreSQL has a built-in range over its
					 * type with a canonical function, so that a span's text is canonical: a discrete range.
					 * Each carrier with one is a range endpoint or is named in `unspanned` with its limit,
					 * never neither and never both, so a ranged carrier the registry gains is refused here
					 * until it is declared spannable or its limit is stated.
					 */
					const [row] = yield* db.values(
						"SELECT EXISTS (SELECT FROM pg_catalog.pg_range r WHERE r.rngsubtype = $1::text::regtype AND r.rngcanonical <> 0)::text",
						[types[carrier]]
					)
					const discrete = defined(row, carrier)[0] === "true"
					const spannable = claimedBy(carrier).includes("spanEndpoint")
					const limited = unspanned[carrier] !== undefined
					assert.deepEqual(
						{ spannable, limited },
						{ spannable: discrete && !limited, limited: discrete && !spannable },
						`${carrier}: a discrete range is a range endpoint or a named limit, exactly one`
					)
					c.note(
						spannable
							? "a spannable carrier"
							: limited
								? "a discrete range named as a limit"
								: "no discrete range"
					)
				}),
		oracle: {
			kind: "postgresql",
			name: "the catalog's operators, operator classes, aggregates and discrete ranges over the carrier's type"
		},
		box: "every carrier of the registry",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/native.ts",
				original: '\tbits: ["equality", "expressionIndex", "setAlgebra", "storage"],',
				replacement:
					'\tbits: ["equality", "expressionIndex", "ordering", "setAlgebra", "storage"],',
				why: "A set claims an ordering; the carriers property fails."
			}
		]
	})
