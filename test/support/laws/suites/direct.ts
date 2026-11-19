import type { Reached } from "@bjornpagen/testing/features"
import { constant } from "@bjornpagen/testing/gen"
import {
	type Case,
	family as propertyFamily,
	type Family as PropertyFamily,
	property
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { defined } from "#test/support/assert.ts"
import { type Family, type Mode, populationsOf } from "#test/support/laws/boxes.ts"
import {
	type DirectCase,
	type DirectFeature,
	directDraw,
	runDirect
} from "#test/support/laws/direct.ts"
import {
	casesPerTest,
	familyTemplates,
	schemaPairs,
	variantKey
} from "#test/support/laws/suites/family.ts"
import { familyWriters } from "#test/support/laws/support.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A direct case runs without Db.open and in a few statements, a quarter of a family case's time, so a direct suite runs
 * twice a family suite's cases.
 */
const directCases = 2 * casesPerTest

/**
 * A case its caller plants for a direct suite, by population: the case, naming its schema by its index in its
 * population (boxes.ts variantsOf), and the situations it reaches, which its family's population reaches too rarely
 * (the moves and selections in a transaction that commits, whose every other statement must keep each law). A witness
 * whose turn aims at one of them draws it (direct.ts directDraw).
 */
export interface DirectPlant {
	readonly note: string
	readonly sketch: DirectCase
	readonly reaches: ReadonlyArray<Reached<DirectFeature>>
}

/** The cases a caller plants for a direct suite, by population (DirectPlant). */
export type Planted = Readonly<Record<Mode, ReadonlyArray<DirectPlant>>>

/**
 * One family's direct-writer suite (../direct.ts): a property for each population of the family's box (boxes.ts
 * populationsOf), keyed by its mode, each case drawing one of the population's schemas, a lawful state to start from
 * and a few SERIALIZABLE transactions of a direct SQL writer logged in as `direct`, on the worker's clone of its schema's
 * template (family.ts familyTemplates, the family suite's). The writer's session belongs to the case.
 *
 * The population must reach every statement kind its relations allow (an UPDATE that moves its fact to another key
 * among them, and such an UPDATE in a transaction that commits; an UPDATE that moves a referred fact to another key, in
 * a transaction refused at COMMIT; and one that moves a fact's references, and one that moves a fact into a referring
 * side's selection, each in a transaction that commits and in one refused at COMMIT), a refusal at a statement by a
 * key, a refusal at COMMIT by a foreign key when the family's schemas install one (every deferred law is one: fin.md
 * §7), and commits; the immutable population, an UPDATE refused by privilege; and every schema, a commit. A witness
 * whose turn aims at an ending of a move still pending draws a case with an UPDATE of the mode aimed at it alone
 * (direct.ts directDraw), since a move needs a fact in the state to move, and one whose turn aims at a situation its
 * caller planted a case for draws that case (Planted).
 */
export const directSuite = <P>(
	declaredIn: ImportMeta,
	family: Family<P>,
	planted: Planted
): PropertyFamily =>
	propertyFamily(
		Rec.fromEntries(
			Arr.map(populationsOf(family), ({ mode, variants }) => [
				mode,
				directProperty(declaredIn, family, mode, variants, planted[mode])
			])
		)
	)

/**
 * One population's property of a direct suite (directSuite): `mode: a transaction commits iff its final state is lawful,
 * refused where the law is checked`.
 *
 * Its pre-conversion budget: runs 2 · casesPerTest, coverage cases 2 · casesPerTest (test/support/laws/suites/direct.ts
 * at c568eb123).
 */
const directProperty = <P>(
	declaredIn: ImportMeta,
	family: Family<P>,
	mode: Mode,
	variants: Arr.NonEmptyReadonlyArray<P>,
	planted: ReadonlyArray<DirectPlant>
) => {
	const laws = Arr.flatMap(variants, (p) => family.host(p).laws)
	/** Every schema commits (its refusals by schema are the family suite's, whose cases run longer). */
	const situations: Arr.NonEmptyReadonlyArray<Reached<DirectFeature>> = [
		"statement insert",
		"statement delete",
		...(mode === "mutable"
			? ([
					"statement update payload",
					"statement update key",
					["statement update key", "committed"],
					["statement rekey of a referred fact", "refused at COMMIT"],
					["statement move of a referring fact", "refused at COMMIT"],
					["statement move of a referring fact", "committed"],
					["statement selection of a referring fact", "refused at COMMIT"],
					["statement selection of a referring fact", "committed"]
				] satisfies ReadonlyArray<Reached<DirectFeature>>)
			: (["refused by privilege"] satisfies ReadonlyArray<Reached<DirectFeature>>)),
		"refused at a statement by a key",
		...(Arr.some(laws, (l) => l.kind === "contained" || l.kind === "covered")
			? (["refused at COMMIT by a foreign key"] as const)
			: []),
		"committed",
		...schemaPairs(family, variants, (): ReadonlyArray<DirectFeature> => ["committed"])
	]
	const plantedAims = Arr.flatMap(planted, (k) =>
		Arr.map(k.reaches, (situation) => [situation, constant(k.sketch)] as const)
	)
	return property.explore(directDraw(variants.length, plantedAims), {
		needs: Substrate.oneOf(familyTemplates(declaredIn, family), Substrate.seat),
		situations,
		check: (seats, c: Case<DirectFeature>) => (k) =>
			Effect.scoped(
				Effect.gen(function* () {
					const p = elementAt(variants, k.variant, "the family's schemas")
					const schemaFeature: DirectFeature = `schema ${family.describe(p)}`
					c.note(schemaFeature)
					const seat = yield* defined(seats[variantKey(family, p)], "the family's seats")
					/** Each transaction's ending is noted with the schema it ran on too. */
					const ended = (f: DirectFeature) => {
						c.note(f)
						c.pair(schemaFeature, f)
					}
					const direct = seat.value.world(
						familyWriters(family.schema(p)(seat.value.declared)).direct
					)
					yield* Effect.provideService(
						runDirect(seat.value, direct, family.host(p), family.domains, k, c, ended),
						Substrate,
						seat.substrate
					)
				})
			),
		oracle: { kind: "unstated" },
		budget: { runs: directCases, steered: directCases },
		kept: [],
		kills: []
	})
}
