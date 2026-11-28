/**
 * C1, statement size bounded by its definition's: a read's statement scans each relation its definition reads at most
 * once per occurrence, a stored relation as its table, a live one as its own definition (laws.ts statementSize). The
 * constant of the bound is one: a plan that scans a relation more often spells a derivation again in place, paying its
 * planning and its pages at every call (edullm's take, 2.28 MB of text planned in about 6 s cold), and one that scans a
 * stored relation's definition derives it per call where its table holds it. The definition's size is the model's
 * (shapes.ts askedOf, occurrences); the definition size the compiler serves for each statement replaces it, the law
 * unchanged.
 *
 * Oracle: PostgreSQL's generic plan of each read's statement (observed.ts), its scans counted by relation.
 *
 * Space: drawn shapes (shapes.ts).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { statementSize } from "#test/pg/contracts/laws.ts"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { shapeGen } from "#test/pg/contracts/shapes.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A read's statement scans each relation its definition reads at most once per occurrence. */
export const aReadsStatementScansEachRelationAtMostOncePerOccurrenceItsDefinitionReadsItAt =
	property.explore(shapeGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a live derived relation read",
			"a stored derived relation read",
			"two aliases of one definition",
			"published content read through its fact"
		] satisfies ReadonlyArray<Reached<ContractFeature>>,
		check:
			({ substrate }, c: Case<ContractFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						contractCase(s, c.note, statementSize, "each read scans a relation once per occurrence")
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's generic plan of each read's statement, its scans by relation against its definition's occurrences"
		},
		budget: { runs: 16, steered: 16 },
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/contracts/statement-size.test.ts#aReadsStatementScansEachRelationAtMostOncePerOccurrenceItsDefinitionReadsItAt:4.2:2.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.1.0.0"
				),
				reason:
					"a fold by document over the first member, read at the document a row of Owner names: computed at the key set of Owner's documents, Owner scanned once for the key set and again for the read (lane REDS7's census of main 29a4d30c)",
				since: "2026-11-28"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\tif (atRows || (once && readers(site.occurrence.source) === 1)) {\n",
				replacement: "\t\t\t\tif (atRows) {\n",
				why: "A region evaluated once reads its row sites from a key set however few rows come before them: read4's fold at the document Owner's row names is computed at the key set of Owner's documents, Owner scanned for the key set and again for the read, twice where its definition reads it once."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					'\t\t\t\treturn c?.holding.kind === "stored" && c.subject.reads.every(seesWhole)\n',
				replacement:
					'\t\t\t\treturn c?.holding.kind === "stored" && c.subject.reads.every(seesWhole) && relation === ""\n',
				why: "No role reads a stored derived relation's table: every read of one spells its definition in place, scanning the members it derives from where its definition reads its table once."
			}
		]
	})
