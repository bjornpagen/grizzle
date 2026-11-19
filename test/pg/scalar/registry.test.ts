/**
 * The scalar registry against the PostgreSQL 19 catalog: every descriptor names what PostgreSQL stores, and every
 * capability the registry claims is one PostgreSQL offers.
 *
 * - Spellings: every spelling of the pg namespace, the serials among them, declares a column PostgreSQL stores as the
 *   type the descriptor names.
 * - float(p): for every precision from -4 to 59, the registry admits float(p) exactly when PostgreSQL does, and names
 *   the type, real or double precision, PostgreSQL selects.
 * - numeric(p, s): for drawn typmods near and past numerictypmodin's bounds, the registry admits exactly what
 *   PostgreSQL admits, and names the typmod it stores.
 * - vector(n): for every dimension count within two of 1 and of the storage limit, the registry admits exactly what
 *   pgvector admits.
 * - Carriers: for every carrier, the capabilities the registry claims are, as a set, the catalog's (its operators,
 *   operator classes and aggregates over the carrier's type) less the documented exclusions, each of which the catalog
 *   offers; and a carrier is a span endpoint exactly where PostgreSQL has a discrete range over its type that the
 *   README does not name as a limit.
 *
 * Oracle: PostgreSQL itself, its catalog and the type a column's declaration stores.
 *
 * Features: "a serial" and "a type"; float(p)'s "refused below", "real", "double precision" and "refused above";
 * numeric's "admitted" and "refused"; vector's "refused below", "admitted" and "refused above"; and the carriers' "a
 * native capability excluded", "a spannable carrier", "a discrete range named as a limit" and "no discrete range".
 */

import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { array, finite, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { vectorSchemaOf } from "#test/pg/codec/support.ts"
import { carrierWords, spellingWords } from "#test/pg/scalar/registry.dictionary.ts"
import {
	accepts,
	type CarrierFeature,
	carrierTypes,
	catalogNames,
	claimedBy,
	columnSpelling,
	type DimensionsFeature,
	exclusions,
	type FloatFeature,
	installProbe,
	nativeOf,
	polymorphic,
	probe,
	storedAt,
	typmodGen,
	unspanned
} from "#test/pg/scalar/registry.fixtures.ts"
import { assert, contains, defined, unorderedEqual } from "#test/support/assert.ts"
import { floatOf } from "#test/support/descriptors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { isSerial, spelled } from "#test/unit/scalar/support.ts"

/** Descriptors against the PostgreSQL 19 catalog names the type PostgreSQL stores with every spelling of the pg namespace. */
export const descriptorsAgainstThePostgreSQL19CatalogNamesTheTypePostgreSQLStoresWithEverySpellingOfThePgNamespace =
	property.exhaust(finite(word(spellingWords)), {
		needs: { tx: Substrate.transaction },
		situations: ["a serial", "a type"] satisfies ReadonlyArray<Reached<"a serial" | "a type">>,
		check:
			({ tx }, c: Case<"a serial" | "a type">) =>
			(spelling) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					yield* installProbe(db)
					return yield* Effect.map(probe(db, [columnSpelling(spelling)]), (stored) => {
						c.note(isSerial(spelling) ? "a serial" : "a type")
						assert.deepEqual(stored, [spelled(spelling).sql], spelling)
					})
				}),
		oracle: {
			kind: "postgresql",
			name: "the type PostgreSQL stores a column of the spelling as"
		},
		box: "every spelling of the pg namespace that is a descriptor, the serials among them",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/pg.ts",
				original: 'const boolean = plain("boolean", carrierColumn("bool"))',
				replacement:
					'const boolean = defineField({}, "bool", { kind: "pg", type: "boolean" }, { column: carrierColumn("bool") }, SourceLoc("pg.boolean", []), bareEnv)',
				why: "The boolean descriptor names bool; the spellings property fails."
			}
		]
	})

/** Descriptors against the PostgreSQL 19 catalog selects real or double precision for float(p) as PostgreSQL does, and refuses what it refuses. */
export const descriptorsAgainstThePostgreSQL19CatalogSelectsRealOrDoublePrecisionForFloatPAsPostgreSQLDoesAndRefusesWhatItRefuses =
	property.exhaust(finite(int(-4, 59)), {
		needs: { tx: Substrate.transaction },
		situations: [
			"refused below",
			"real",
			"double precision",
			"refused above"
		] satisfies ReadonlyArray<Reached<FloatFeature>>,
		check:
			({ tx }, c: Case<FloatFeature>) =>
			(p) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					yield* installProbe(db)
					return yield* Effect.map(probe(db, [`float(${p})`]), (stored) => {
						const pgAccepts = !pipe(storedAt(stored, 0), Str.startsWith("refused"))
						assert.equal(
							accepts(() => floatOf(p)),
							pgAccepts,
							`float(${p})`
						)
						if (pgAccepts) {
							assert.equal(storedAt(stored, 0), floatOf(p).sql, `float(${p})`)
							c.note(storedAt(stored, 0) === "real" ? "real" : "double precision")
						} else {
							c.note(p < 1 ? "refused below" : "refused above")
						}
					})
				}),
		oracle: { kind: "postgresql", name: "the type PostgreSQL stores float(p) as" },
		box: "every precision from -4 to 59, past both of float(p)'s edges",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/pg.ts",
				original: "\t25: doublePrecision,",
				replacement: "\t25: real,",
				why: "float(25) selects real; the float(p) property fails."
			}
		]
	})

/** Descriptors against the PostgreSQL 19 catalog accepts exactly the numeric typmods numerictypmodin accepts. */
export const descriptorsAgainstThePostgreSQL19CatalogAcceptsExactlyTheNumericTypmodsNumerictypmodinAccepts =
	property.explore(array(typmodGen, { min: 1, max: 400 }), {
		needs: { tx: Substrate.transaction },
		situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<"admitted" | "refused">>,
		/** Its pre-conversion budget: runs 2, coverage cases 2 (registry.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 2 },
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
							accepts(() => pgDescriptors.numeric(p, s)),
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
			needs: { tx: Substrate.transaction },
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
								accepts(() => pgDescriptors.vector(n)),
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
					why: "pg.vector admits one dimension past the limit; the vector(n) property fails."
				}
			]
		}
	)

/** Descriptors against the PostgreSQL 19 catalog claims only native capabilities, leaves out only the documented exclusions, and has span endpoints exactly where a built-in discrete range exists or its limit is named. */
export const descriptorsAgainstThePostgreSQL19CatalogClaimsOnlyNativeCapabilitiesLeavesOutOnlyTheDocumentedExclusionsAndHasSpanEndpointsExactlyWhereABuiltInDiscreteRangeExistsOrItsLimitIsNamed =
	property.exhaust(finite(word(carrierWords)), {
		needs: { tx: Substrate.transaction },
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
					 * A carrier may be a span endpoint only where PostgreSQL has a built-in range over its
					 * type with a canonical function, so that a span's text is canonical: a discrete range.
					 * Each carrier with one is a span endpoint or is named in `unspanned` with its limit,
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
						`${carrier}: a discrete range is a span endpoint or a named limit, exactly one`
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
