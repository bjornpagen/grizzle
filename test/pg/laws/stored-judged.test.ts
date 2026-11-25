/**
 * A law over a stored derived relation is judged exactly as one over its definition is: a write of the relations its
 * definition reads changes it, since the rule judge's upkeep rewrites it at the same COMMIT (laws/model/model.ts
 * changedBy), so the judge holds every law over it at that write's COMMIT, a sealed unit's founding one among them,
 * whatever else the law reads. On PostgreSQL 19, pantry's MappableBaseType reduced (stored-judged.fixtures.ts): a
 * package's mappings beside their declarations' base types, stored at the mapping's place, sealed or not, and the base
 * types a package's mappings have, live where the package is unsealed and stored where it is sealed; three laws over
 * them alone or beside a closed relation, and one beside an ordinary relation.
 *
 * qti-pie's B''' (grizzle d4d27933) accepted six packages its law oracles refuse, its laws over inferred-stored
 * derivations held by nothing: the rule judge's triggers were kept for the laws reading a relation the slice writes, and
 * a rule names a stored derivation by its own name, never its holders', so a law reading stored derivations and closed
 * relations alone had no trigger, no native and no migration check (54 of pantry's laws, 54 of the result level's),
 * the package's seal making more of them stored. The installation now refuses a law nothing discharges as an internal
 * error (physical/install/compile.ts installationOver).
 *
 * Each case founds package 1 in one transaction rolled back after, then runs the judge (SET CONSTRAINTS ALL
 * IMMEDIATE).
 *
 * Oracle: specification, the laws restated over the drawn rows (brokenLaws): the judge refuses exactly when one breaks,
 * under an integrity SQLSTATE.
 *
 * Features: refused and accepted, sealed and unsealed; a stored derivation's law over a closed relation alone broken; a
 * package derivation's law over itself alone broken.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type JudgedFeature,
	judgedCaseGen,
	judgedTemplates,
	runJudged
} from "#test/pg/laws/stored-judged.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A law over a stored derived relation is judged at every write of its holders, its unit's founding one among them,
 * exactly as one over its definition is.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aLawOverAStoredDerivationIsJudgedAtEveryWriteOfItsHoldersTheFoundingOneAmongThemAsOneOverItsDefinitionIs =
	property.explore(judgedCaseGen, {
		needs: {
			sealed: Substrate.rolledBack(judgedTemplates.sealed),
			unsealed: Substrate.rolledBack(judgedTemplates.unsealed)
		},
		situations: [
			"refused, sealed",
			"refused, unsealed",
			"accepted, sealed",
			"accepted, unsealed",
			"a stored derivation's law over a closed relation alone broken",
			"a package derivation's law over itself alone broken"
		] satisfies ReadonlyArray<Reached<JudgedFeature>>,
		check:
			({ sealed, unsealed }, c) =>
			(drawn) =>
				Effect.flatMap(drawn.seal === "sealed" ? sealed : unsealed, ({ connection, value }) =>
					runJudged(value, connection, drawn, c)
				),
		oracle: {
			kind: "specification",
			name: "the laws restated over the drawn rows: the judge refuses exactly when one breaks"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/stored-judged.test.ts#aLawOverAStoredDerivationIsJudgedAtEveryWriteOfItsHoldersTheFoundingOneAmongThemAsOneOverItsDefinitionIs:3f.5:2.0.0.1.0.0.3.0.0.0.3"
				),
				reason:
					"A sealed package founded with three mappings of a file declaration: pantry's MappableBaseType and its typed-mappable law over stored derivations and the closed Mappable alone, which qti-pie's B''' (grizzle d4d27933) accepted, its program oracle's mapping on a file response (Q5.11), and its sealed package's identifier and title mismatches beside it",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\t\tplan.discharge === "trigger" && !plan.law.reads.isDisjointFrom(this.changed)\n',
				replacement:
					'\t\t\tplan.discharge === "trigger" && !plan.law.reads.isDisjointFrom(this.writes)\n',
				why: "A law's trigger is kept only where it reads a relation the slice writes, never a stored derivation those writes change: a law over stored derivations and closed relations alone is held by nothing, and pantry's MappableBaseType and its sealed package's laws accept the packages that break them."
			}
		]
	})
