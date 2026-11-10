import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import type { ShrinkBudget } from "@grizzle/testing/shrink"
import { generate, simplestChooser } from "@grizzle/testing/source"
import { tokenOf } from "@grizzle/testing/tape"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import {
	carryChain,
	catalogRenamedDrawGen,
	directVersion,
	holdsCatalogName,
	type IntentSketch,
	keyCarriedOverRetyped,
	keyPromotedBesideChangedReference,
	keyRenamedOntoPrimary,
	type LegalIntentKind,
	legalIntentSketchGen,
	payloadRostersRenamed,
	planOf,
	type RenamedDraw,
	type RenamedPath,
	referencedRenamedFirst,
	renamedDrawGen,
	renamedWithRetype,
	resolveLegalIntents,
	resolveRenamedDraw,
	serialFields,
	type SqConversion,
	sqConversions,
	statisticsOfRenamedRelation,
	statisticsOverRetyped,
	type Version
} from "#test/pg/migrate-gen/support.ts"

import {
	apply,
	carried,
	directory,
	drafted,
	factSetOf,
	identitiesPast,
	noFurther,
	openMigrator,
	rowsOf,
	sameCatalog,
	type Traced
} from "#test/pg/migrate/support.ts"
import {
	type AmbientFeature,
	type AmbientSession,
	ambientFeatures,
	ambientOwner,
	ambientSessionGen,
	grizzleFirstSession
} from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { installedSchemas } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import type { ValueFacts } from "#test/support/oracle/gen/facts.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { PropertyFailed } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Cases per stream; a failing path shrinks over at most this many candidates, each a few migrations on PostgreSQL.
 *
 * Generated migration paths on PostgreSQL 19, applied by the real runner, with PostgreSQL's own catalog as the oracle.
 *
 * A path is a schema A, its successor B and B's successor C, drawn two ways: the renamed paths of the generator
 * (`renamedDrawGen`: random oracle schemas with the renames a user makes), and the
 * adversarial rename intents over the hazard base (`legalIntentSketchGen`: swaps, chains, renames of a
 * referenced relation and of its key, keys over retyped fields, a field renamed with its type changed, a relation and
 * its field renamed together, a roster renamed, its handle removed or renamed, its field retyped, a name hopping across
 * the relation and type namespaces, a serial field widened, and a name B dropped taken in C). Each step is drafted by
 * generateMigration from the snapshot before under the renames and drops it declares (`--rename`, `--drop`): the
 * path's own renames when the path declares them, and every removal a drop otherwise, so the draft guesses nothing. It
 * is reviewed by the one reviewer, each placeholder given the typed value the carry model gives, and applied by the
 * runner as `grizzle migrate` applies it,
 * as the migration identity, with A's facts loaded after A. Properties, for every path:
 *
 * (a) every apply succeeds, and the runner's own check after it holds, so no statement
 *     fails where PostgreSQL refuses it (an order the drafter got wrong: 42830, 2BP01, 42P07, 42710, 42804, 23514);
 *     and after B and after C the migrated schema holds the catalog a fresh installation of that version holds, both
 *     read by the test kernel from PostgreSQL's catalog (`sameCatalog`), never through
 *     grizzle's own snapshot, whatever renames, conversions and rebuilds led there;
 * (b) the facts are carried as the drafted rules say (`carryChain`, A's facts those lawful through both
 *     chains, each migration's validation being a reviewed data step): after B, A's facts stand in B's relations
 *     exactly as the model's rows, loaded into a fresh installation of B and read back by PostgreSQL, compare;
 * (c) A to C directly, from A's snapshot, applies and passes (a) too, so the catalog of C is the same whichever path
 *     led to it, but for its rosters' codes, which are each path's history (a handle B added and C no longer holds is
 *     a hole after B, and no code at all on the direct path);
 * (d) after every migration, each identity's next value is past its column's stored maximum (`identitiesPast`): the
 *     reviewer converts a serial field to bigint by its cast, so a widened serial keeps its values and its advance
 *     is judged against them.
 *
 * Every path runs under a drawn ambient session (test/support/ambient.ts): the defaults of the path's own owner login,
 * which every migration session starts under, its search path PostgreSQL's own or the installation's schemas first. A
 * renamed path also draws, beside the generator's renames, an arm whose B renames a relation or a closed roster to the
 * name of a PostgreSQL type; the renamed stream requires that name under the installation-first path, the pairing
 * where a bare type name resolves to the installation's row type or domain, and a steered case takes that path while
 * the pairing is pending.
 *
 * Every verdict is PostgreSQL's: its refusal of a statement, its catalog of both installations, and its reading of the
 * rows. The features are the rename kinds a path made by successor, the intents it made, what the draft declared, the
 * ambient session, whether a version names a relation or a closed roster as PostgreSQL names a type or function, and
 * each conversion of R1's `sq` between an integer serial, a pg.uuidv7 and a uuid, which a kept path of intents makes
 * each of. */
const runs = 4
const shrink: ShrinkBudget = { kind: "bounded", candidates: 100 }

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
type Feature =
	| (typeof featureNames)[number]
	| `the intent ${LegalIntentKind}`
	| `sq: ${SqConversion}`
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

/**
 * The ambient session a case's migrations start under, drawn: its path the installation-first one while a steered
 * case's pairing of that path with a catalog type's name is pending.
 */
const ambientOf = (notes: Case<Feature>): AmbientSession => {
	const drawn = notes.draw(ambientSessionGen)
	return Option.exists(notes.steering, (pending) => pending.names("grizzle-first path"))
		? { ...drawn, path: grizzleFirstSession.path }
		: drawn
}

const property = (p: RenamedPath, notes: Case<Feature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const owner = substrate.owner.role
			const ambient = ambientOf(notes)
			const x = yield* substrate.schema({ create: false, label: "paths_x" })
			const y = yield* substrate.schema({ create: false, label: "paths_y" })
			const login = yield* ambientOwner(
				ambient,
				Arr.dedupe(
					Arr.appendAll(installedSchemas(planOf(p.path.a, x, owner).installation), [
						...installedSchemas(planOf(p.path.b, x, owner).installation),
						...installedSchemas(planOf(p.path.c, x, owner).installation),
						...installedSchemas(planOf(p.path.a, y, owner).installation),
						...installedSchemas(planOf(p.path.c, y, owner).installation)
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
			for (const conversion of [
				...sqConversions(p.path.a, p.path.b),
				...sqConversions(p.path.b, p.path.c),
				...sqConversions(p.path.a, p.path.c)
			]) {
				notes.note(`sq: ${conversion}`)
			}
			notes.note(p.choose ? "the path's renames declared" : "every removal declared a drop")
			/** The facts A holds: those whose carried forms are lawful through both chains, A to B to C and A to C. */
			const model = carryChain(
				{ a: p.path.a, b: p.path.b, c: p.path.c },
				p.path.facts,
				{ ab: carried(a, b, p.choose), bc: carried(b, c, p.choose), ac: carried(a, c, p.choose) },
				{ b: serialFields(p.path.b), c: serialFields(p.path.c) }
			)
			const load = (schema: string, v: Version, facts: ValueFacts) =>
				Effect.gen(function* () {
					const statements = factStatements(planOf(v, schema, owner), factSetOf(v, facts))
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
						const freshPlan = planOf(v, f, owner)
						yield* transaction(substrate.admin, freshPlan.sql)
						yield* sameCatalog(
							planOf(v, migrated, owner).installation,
							freshPlan.installation,
							what
						)
					})
				)

			/** X: A, its facts, B, then C. (a) at every apply. */
			const dx = yield* Effect.fromResult(drafted([a, b, c], x, owner, p.choose))
			yield* apply(m, directory(dx, 0), noFurther)
			yield* load(x, p.path.a, model.loaded)
			yield* apply(m, directory(dx, 1), noFurther)
			notes.note("a step applied")
			yield* fresh(x, p.path.b, "(a) A to B")
			yield* identitiesPast(planOf(p.path.b, x, owner), "(d) A to B")
			/** (b) against a fresh installation of B holding the model's rows. */
			const freshRows = yield* Effect.scoped(
				Effect.gen(function* () {
					const f = yield* substrate.schema({ create: false, label: "paths_fresh" })
					yield* transaction(substrate.admin, planOf(p.path.b, f, owner).sql)
					yield* load(f, p.path.b, model.expected)
					return yield* rowsOf(m, planOf(p.path.b, f, owner), p.path.b, f, model.numbered)
				})
			)
			const migratedRows = yield* rowsOf(m, planOf(p.path.b, x, owner), p.path.b, x, model.numbered)
			yield* same(
				migratedRows,
				freshRows,
				"(b) the facts B holds after the migration are not the carry model's"
			)
			yield* apply(m, directory(dx, 2), noFurther)
			yield* fresh(x, p.path.c, "(a) A to B to C")
			yield* identitiesPast(planOf(p.path.c, x, owner), "(d) A to B to C")

			/** (c) Y: A, then C directly, its rosters' codes the direct migration's (directVersion). */
			const direct = directVersion(p.path)
			const dy = yield* Effect.fromResult(
				drafted([a, { version: direct, origins: p.origins.c }], y, owner, p.choose)
			)
			yield* apply(m, directory(dy, 0), noFurther)
			yield* load(y, p.path.a, model.loaded)
			yield* apply(m, directory(dy, 1), noFurther)
			yield* fresh(y, direct, "(c) A to C")
			yield* identitiesPast(planOf(direct, y, owner), "(d) A to C")
		})
	)

/** A renamed path: the generator's, or, one time in four, one whose B also takes a catalog type's name. */
const pathDrawGen = weighted<RenamedDraw>([
	[3, renamedDrawGen],
	[1, catalogRenamedDrawGen]
])

/**
 * The property's draws of a case kept from before its property drew an ambient session: the simplest ambient session,
 * the ordinary one, every setting unset, under which the case was found.
 */
const ordinaryTape = generate(ambientSessionGen, simplestChooser).tape
const ordinaryDraws = tokenOf(ordinaryTape.values, ordinaryTape.length)

/**
 * The path a case runs: the drawn one, or, while the case's steering leaves a catalog-type name pending, a path whose B
 * takes one, drawn from the case's own tape.
 */
const aimedDraw = (d: RenamedDraw, notes: Case<Feature>): RenamedDraw =>
	Option.exists(notes.steering, (pending) => pending.names("catalog-type name"))
		? notes.draw(catalogRenamedDrawGen)
		: d

const planted = (
	path: RenamedDraw & { readonly kind: "stated" },
	note: string
): Kept<RenamedDraw, Feature> => ({
	note,
	sketch: path,
	draws: ordinaryDraws,
	reaches: ["a step applied"]
})

const kept: ReadonlyArray<Kept<RenamedDraw, Feature>> = [
	planted(
		{ kind: "stated", path: referencedRenamedFirst },
		"M49: two relation renames referencing each other"
	),
	planted(
		{ kind: "stated", path: keyCarriedOverRetyped },
		"M48: a key carried over a retyped field"
	),
	planted(
		{ kind: "stated", path: keyRenamedOntoPrimary },
		"a key over a field renamed onto the primary key a new reference reads"
	),
	planted(
		{ kind: "stated", path: keyPromotedBesideChangedReference },
		"a candidate key promoted over a dropped surrogate, its reference turned immediate in the same migration"
	),
	planted(
		{ kind: "stated", path: renamedWithRetype },
		"M36: a field renamed with its type changed"
	),
	planted({ kind: "stated", path: statisticsOverRetyped }, "M51: statistics over a retyped field"),
	planted(
		{ kind: "stated", path: statisticsOfRenamedRelation },
		"M51: statistics of a renamed relation"
	),
	planted(
		{ kind: "stated", path: payloadRostersRenamed },
		"rosters carrying a text payload: each version's login holds their closed relations as admitted"
	)
]

/** The intent counterexamples PostgreSQL found. */
const keptIntents: ReadonlyArray<Kept<IntentSketch & { readonly kind: "legal" }, Feature>> = [
	{
		note: "the referenced relation renamed while its serial field widens: the rename converts the serial in place, so its referrer's rows still find their keys",
		sketch: {
			kind: "legal",
			toB: [{ kind: "renameReferenced" }, { kind: "retypeSerial" }],
			toC: [],
			takeDropped: false,
			choose: true,
			freshRelations: "before"
		},
		draws: ordinaryDraws,
		reaches: [
			"the intent renameReferenced",
			"the intent retypeSerial",
			"a relation renamed in B",
			"the path's renames declared",
			"facts carried"
		]
	},
	{
		note: "R1's serial converted to a uuidv7 in B and back to a serial in C: each conversion gives its draw up first and takes the target's once converted",
		sketch: {
			kind: "legal",
			toB: [{ kind: "sqUuidv7" }],
			toC: [{ kind: "sqSerial" }],
			takeDropped: false,
			choose: true,
			freshRelations: "before"
		},
		draws: ordinaryDraws,
		reaches: [
			"the intent sqUuidv7",
			"the intent sqSerial",
			"sq: an integer serial to a uuidv7",
			"sq: a uuidv7 to an integer serial",
			"facts carried"
		]
	},
	{
		note: "R1's serial converted to a uuid in B, then a uuidv7 in C: the uuid takes its uuidv7() default in place",
		sketch: {
			kind: "legal",
			toB: [{ kind: "sqUuid" }],
			toC: [{ kind: "sqUuidv7" }],
			takeDropped: false,
			choose: true,
			freshRelations: "before"
		},
		draws: ordinaryDraws,
		reaches: ["the intent sqUuid", "the intent sqUuidv7", "sq: a uuid to a uuidv7", "facts carried"]
	},
	{
		note: "R1's serial converted to a uuidv7 in B, then a plain uuid in C: the uuidv7 gives its default up in place",
		sketch: {
			kind: "legal",
			toB: [{ kind: "sqUuidv7" }],
			toC: [{ kind: "sqUuid" }],
			takeDropped: false,
			choose: true,
			freshRelations: "before"
		},
		draws: ordinaryDraws,
		reaches: [
			"the intent sqUuidv7",
			"the intent sqUuid",
			"sq: an integer serial to a uuidv7",
			"sq: a uuidv7 to a uuid",
			"facts carried"
		]
	}
]

layer(Substrate.layer)("generated migration paths on PostgreSQL", (it) => {
	it.effect(
		`${runs} renamed paths: every apply admitted against its snapshot, facts carried, A to C as A to B to C`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "pg/migrate/paths",
						draw: drawn(pathDrawGen),
						literal: Formatter.format,
						coverage: required<Feature>([["grizzle-first path", "catalog-type name"]], {
							cases: 4 * runs,
							sense: notesOnly
						}),
						kept,
						runs,
						shrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d, notes) => property(notes.draw(resolveRenamedDraw(aimedDraw(d, notes))), notes)
				)
			)
	)
	it.effect(
		`${runs} paths of adversarial rename intents: every apply admitted against its snapshot, facts carried`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "pg/migrate/intents",
						draw: drawn(legalIntentSketchGen),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: keptIntents,
						runs,
						shrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, notes) => {
						for (const intent of new Set(Arr.map([...sketch.toB, ...sketch.toC], (i) => i.kind))) {
							notes.note(`the intent ${intent}`)
						}
						return property(resolveLegalIntents(sketch), notes)
					}
				)
			)
	)
})
