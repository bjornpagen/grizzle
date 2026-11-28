/** What the properties of paths.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { weighted, type Steered } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record } from "effect"
import {
	type AmbientFeature,
	ambientFeatures,
	ambientOwner,
	type AmbientSession,
	ambientSessionGen,
	grizzleFirstSession
} from "#test/support/ambient.ts"
import { filledSql } from "#test/support/compile.ts"
import { installedSchemas } from "#test/support/install-migrate.ts"
import { messageOf } from "#test/support/message.ts"
import type { ValueFacts } from "#test/support/oracle/gen/facts.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { PropertyFailed } from "#test/support/oracle/runner.ts"
import {
	carryChain,
	catalogRenamedDrawGen,
	directVersion,
	holdsCatalogName,
	type IntentSketch,
	type LegalIntentKind,
	legalIntents,
	legalIntentSketchGen,
	planOf,
	type RenamedDraw,
	renamedDrawGen,
	type RenamedPath,
	statedRenamedDrawGen,
	type Version
} from "#test/support/pg/migrate-gen/support.ts"
import {
	apply,
	carried,
	directory,
	drafted,
	factSetOf,
	noFurther,
	openMigrator,
	sameCatalog,
	storedRowsOf,
	type Traced
} from "#test/support/pg/migrate/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const featureNames = [
	"a step applied",
	"facts carried",
	"the path's renames declared",
	"every removal declared a drop",
	"a relation renamed in B",
	"a field renamed in B",
	"a field retyped in B",
	"a handle removed in C"
] as const

export type Feature =
	| (typeof featureNames)[number]
	| `the intent ${LegalIntentKind}`
	| AmbientFeature
	| "catalog-type name"

const failed = (report: string) => Effect.fail(new PropertyFailed({ report: report }))

/** Fails with the report of a structural difference. */
const same = (
	actual: unknown,
	expected: unknown,
	what: string
): Effect.Effect<void, PropertyFailed> =>
	Effect.try({
		try: () => assert.deepEqual(actual, expected),
		catch: (error) => new PropertyFailed({ report: `${what}: ${messageOf(error)}` })
	})

/** The rename kinds a path made, by successor, as features. */
const noteRenames = (c: Case<Feature>, p: RenamedPath): void => {
	const b = new Set(p.renames.toB)
	if (b.has("relation") || b.has("relationRetyped")) {
		c.note("a relation renamed in B")
	}
	if (b.has("column")) {
		c.note("a field renamed in B")
	}
	if (b.has("retyped") || b.has("relationRetyped")) {
		c.note("a field retyped in B")
	}
	const k = new Set(p.renames.toC)
	if (k.has("removeHandle")) {
		c.note("a handle removed in C")
	}
}

/** A path's property, its migrations started under the ambient session `ambient`. */
export const pathCase = (p: RenamedPath, ambient: AmbientSession, notes: Case<Feature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const x = yield* substrate.schema({ create: false, label: "paths_x" })
			const y = yield* substrate.schema({ create: false, label: "paths_y" })
			const login = yield* ambientOwner(
				ambient,
				Arr.dedupe(
					Arr.appendAll(installedSchemas(planOf(p.path.a, x).installation), [
						...installedSchemas(planOf(p.path.b, x).installation),
						...installedSchemas(planOf(p.path.c, x).installation),
						...installedSchemas(planOf(p.path.a, y).installation),
						...installedSchemas(planOf(p.path.c, y).installation)
					])
				)
			)
			const m = yield* openMigrator(substrate, login.credentials)
			const a: Traced = { version: p.path.a, origins: p.origins.a }
			const b: Traced = { version: p.path.b, origins: p.origins.b }
			const c: Traced = { version: p.path.c, origins: p.origins.c }
			for (const feature of ambientFeatures(ambient)) {
				notes.note(feature)
			}
			if (Arr.some([p.path.a, p.path.b, p.path.c], holdsCatalogName)) {
				notes.note("catalog-type name")
				for (const feature of ambientFeatures(ambient)) {
					notes.pair(feature, "catalog-type name")
				}
			}
			noteRenames(notes, p)
			notes.note(p.choose ? "the path's renames declared" : "every removal declared a drop")
			/** The facts A holds: those whose carried forms are lawful through both chains, A to B to C and A to C. */
			const model = carryChain({ a: p.path.a, b: p.path.b, c: p.path.c }, p.path.facts, {
				ab: carried(a, b, p.choose),
				bc: carried(b, c, p.choose),
				ac: carried(a, c, p.choose)
			})
			const load = (schema: string, v: Version, facts: ValueFacts) =>
				Effect.gen(function* () {
					const statements = factStatements(planOf(v, schema), factSetOf(v, facts))
					if (!statements.ok) {
						return yield* failed(statements.error.message)
					}
					yield* transaction(substrate.admin, statements.value)
				})
			if (Arr.some(Record.values(model.expected), (rows) => rows.length > 0)) {
				notes.note("facts carried")
			}
			/** (a): the migrated schema `migrated` holds the catalog of a fresh installation of `v`. */
			const fresh = (migrated: string, v: Version, what: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const f = yield* substrate.schema({ create: false, label: "paths_fresh" })
						const freshPlan = planOf(v, f)
						yield* transaction(substrate.admin, filledSql(freshPlan.drafted, substrate.database))
						yield* sameCatalog(planOf(v, migrated).installation, freshPlan.installation, what)
					})
				)

			/** X: A, its facts, B, then C. (a) at every apply. */
			const dx = yield* Effect.fromResult(drafted([a, b, c], x, p.choose))
			yield* apply(m, directory(dx, 0), noFurther)
			yield* load(x, p.path.a, model.loaded)
			yield* apply(m, directory(dx, 1), noFurther)
			notes.note("a step applied")
			yield* fresh(x, p.path.b, "(a) A to B")
			/** (b) against a fresh installation of B holding the model's rows. */
			const freshRows = yield* Effect.scoped(
				Effect.gen(function* () {
					const f = yield* substrate.schema({ create: false, label: "paths_fresh" })
					yield* transaction(
						substrate.admin,
						filledSql(planOf(p.path.b, f).drafted, substrate.database)
					)
					yield* load(f, p.path.b, model.expected)
					return yield* storedRowsOf(m, planOf(p.path.b, f), p.path.b, f)
				})
			)
			const migratedRows = yield* storedRowsOf(m, planOf(p.path.b, x), p.path.b, x)
			yield* same(
				migratedRows,
				freshRows,
				"(b) the facts B holds after the migration are not the carry model's"
			)
			yield* apply(m, directory(dx, 2), noFurther)
			yield* fresh(x, p.path.c, "(a) A to B to C")

			/** (c) Y: A, then C directly, its rosters' codes the direct migration's (directVersion). */
			const direct = directVersion(p.path)
			const dy = yield* Effect.fromResult(
				drafted([a, { version: direct, origins: p.origins.c }], y, p.choose)
			)
			yield* apply(m, directory(dy, 0), noFurther)
			yield* load(y, p.path.a, model.loaded)
			yield* apply(m, directory(dy, 1), noFurther)
			yield* fresh(y, direct, "(c) A to C")
		})
	)

/**
 * A renamed path: the generator's; or, one time in four of those, one whose B also takes a catalog type's name; or, one
 * time in nine, a path the generated paths found once, stated by value (statedRenamedDrawGen), the arm its kept
 * findings are drawn by.
 */
const pathDrawGen = weighted<RenamedDraw>([
	[6, renamedDrawGen],
	[2, catalogRenamedDrawGen],
	[1, statedRenamedDrawGen]
])

/** A renamed path's case: the path as drawn, and the ambient session its migrations start under. */
interface RenamedCase {
	readonly draw: RenamedDraw
	readonly ambient: AmbientSession
}

/**
 * A renamed path's case under its steering: the path pathDrawGen draws, or, while the steering leaves a catalog-type
 * name pending, one whose B takes one; and the ambient session, its path the installation-first one while the steering
 * leaves that path's pairing with a catalog type's name pending. Both are the sketch, so a kept case runs them as drawn.
 */
export const renamedCaseSteered: Steered<RenamedCase, Feature>["under"] =
	(steering) => (source) => {
		const names = (feature: Feature): boolean =>
			Option.exists(steering, (pending) => pending.names(feature))
		const draw = source.draw(names("catalog-type name") ? catalogRenamedDrawGen : pathDrawGen)
		const ambient = source.draw(ambientSessionGen)
		return {
			draw,
			ambient: names("grizzle-first path")
				? { ...ambient, path: grizzleFirstSession.path }
				: ambient
		}
	}

/**
 * The intents a case runs, under its steering: the drawn ones, or, while the steering leaves an intent pending, the
 * drawn ones with B's first intent the pending one its turn aims at, so each steered case reaches an intent no witness
 * has, none waits behind another, and the steered phase needs at most one case per intent. Any intent may be B's: only
 * C's are kept from naming a field B drops. The sketch holds the intent aimed at, so a kept case runs it.
 */
const aimedIntents: Steered<IntentSketch & { readonly kind: "legal" }, Feature>["under"] =
	(steering) => (source) => {
		const sketch = source.draw(legalIntentSketchGen)
		const pending = Option.flatMap(steering, (p) =>
			Arr.findFirst(legalIntents, (kind) => p.aimed(`the intent ${kind}`))
		)
		return Option.match(pending, {
			onNone: () => sketch,
			onSome: (kind) => ({ ...sketch, toB: [{ kind }, ...Arr.drop(sketch.toB, 1)] })
		})
	}

/** An intents case: the intents a path makes, and the ambient session its migrations start under. */
interface IntentsCase {
	readonly intents: IntentSketch & { readonly kind: "legal" }
	readonly ambient: AmbientSession
}

/**
 * An intents case under its steering: the intents aimedIntents draws, and the ambient session, both the sketch, so a
 * kept case runs them as drawn.
 */
export const intentsCaseSteered: Steered<IntentsCase, Feature>["under"] =
	(steering) => (source) => ({
		intents: source.draw(aimedIntents(steering)),
		ambient: source.draw(ambientSessionGen)
	})
