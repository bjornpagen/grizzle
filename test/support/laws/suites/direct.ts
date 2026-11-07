import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { grizzleFirstSession, ordinarySession } from "#test/support/ambient.ts"
import { type Family, type Mode, populationsOf } from "#test/support/laws/boxes.ts"
import {
	type DirectCase,
	type DirectFeature,
	directCaseGen,
	runDirect
} from "#test/support/laws/direct.ts"
import { installVariant, schemaPairs, shrink } from "#test/support/laws/suites/family.ts"

import { familyWriters } from "#test/support/laws/support.ts"
import { caseHang } from "#test/support/limits.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * A direct case runs without Db.open and in a few statements, a quarter of a family case's time, so a direct suite runs
 * twice a family suite's cases.
 */
const directCases = (cases: number): number => 2 * cases

/**
 * The kept cases a direct suite replays before its streams, by population, each naming its schema by its index in its
 * population (boxes.ts variantsOf): what its family's population reaches too rarely, planted by its caller (the
 * moves and selections in a transaction that commits, whose every other statement must keep each law).
 */
export type Planted = Readonly<Record<Mode, ReadonlyArray<Kept<DirectCase, DirectFeature>>>>

/**
 * One family's direct-writer suite (../direct.ts).
 *
 * For each population of the family's box (boxes.ts populationsOf), cases explore through the library's explore, each
 * drawing one of the population's schemas, a lawful state to start from and a few SERIALIZABLE transactions of a direct
 * SQL writer logged in as `direct`. A schema installs once
 * per test, the first time a case draws it (family.ts installVariant). The writer's session belongs to the case.
 *
 * The population must reach every statement kind its relations allow (an UPDATE that moves its fact to another key
 * among them, and such an UPDATE in a transaction that commits; an UPDATE that moves a referred fact to another key, in
 * a transaction refused at COMMIT; and one that moves a fact's references, and one that moves a fact into a referring
 * side's selection, each in a transaction that commits and in one refused at COMMIT), a refusal at a statement by a
 * key, a refusal at COMMIT by a foreign key when the family's schemas install one (every deferred law is one: fin.md
 * §7), and commits; the immutable population, an UPDATE refused by privilege; and every schema, a commit. What a
 * family's population reaches too rarely is planted as kept cases, replayed before the streams (Planted). Shrinking and
 * the time bound are the family suite's.
 */
export const directSuite = <P>(family: Family<P>, cases: number, planted: Planted): void => {
	layer(Substrate.layer, { excludeTestServices: true })(
		`a direct writer over law-bearing schemas: ${family.label}`,
		(it) => {
			for (const { mode, variants } of populationsOf(family)) {
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
				const search = Effect.gen(function* () {
					/**
					 * Every variant's installation, made before the first case; it holds no connection. The mutable
					 * population installs under the installation-first path, the immutable one under the cluster's own.
					 */
					const installs = yield* Effect.forEach(variants, (p) =>
						installVariant(family, p, mode === "mutable" ? grizzleFirstSession : ordinarySession)
					)
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: `laws/direct/${Str.replaceAll(regex("[^a-z0-9]+", "g"), "-")(family.label)}/${mode}`,
							draw: drawn(directCaseGen(variants.length)),
							literal: Formatter.format,
							coverage: required<DirectFeature>(situations, {
								cases: directCases(cases),
								sense: notesOnly
							}),
							kept: planted[mode],
							runs: directCases(cases),
							shrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(k, c) =>
							Effect.gen(function* () {
								const p = elementAt(variants, k.variant, "the family's schemas")
								const schemaFeature: DirectFeature = `schema ${family.describe(p)}`
								c.note(schemaFeature)
								const installed = elementAt(installs, k.variant, "the family's installations")
								/** Each transaction's ending is noted with the schema it ran on too. */
								const ended = (f: DirectFeature) => {
									c.note(f)
									c.pair(schemaFeature, f)
								}
								const direct = installed.world(
									familyWriters(family.schema(p)(installed.declared)).direct
								)
								yield* runDirect(installed, direct, family.host(p), family.domains, k, c, ended)
							})
					)
				})
				it.effect(
					`${mode}: a transaction commits iff its final state is lawful, refused where the law is checked`,
					(ctx) => searched(ctx, search)
				)
			}
		}
	)
}
