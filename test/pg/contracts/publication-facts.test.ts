/**
 * C7, no publication fact derived per call: a fact of sealed content alone is stored when its package is published,
 * and a call reads it by key, never scanning the content it is a fact of (laws.ts publicationFacts). Sealed content is
 * written whole by the transaction that founds its unit, so the fact is the same at every call; a call that derives it
 * reads every row its key reaches at every call (edullm's Delivered shape, 96 KB re-deriving deliverability at every
 * start). The bound is zero scans of the content.
 *
 * Oracle: PostgreSQL's generic plan of every statement a call sends (observed.ts), and the installation's holding of F.
 *
 * Space: drawn shapes (shapes.ts) holding published content: Pkg's two relations, F the count of their join's items by
 * package, stored only because Pkg is sealed, and L, a document's sightings joined to F at their packages.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { publicationFacts } from "#test/pg/contracts/laws.ts"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { shapeGen } from "#test/pg/contracts/shapes.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** No statement a call sends scans the sealed content a stored publication fact is the fact of. */
export const noStatementACallSendsDerivesAPublicationFactAgain = property.explore(shapeGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: ["published content read through its fact"] satisfies ReadonlyArray<
		Reached<ContractFeature>
	>,
	check:
		({ substrate }, c: Case<ContractFeature>) =>
		(s) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					contractCase(s, c.note, publicationFacts, "no call derives a publication fact again")
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's generic plan of every statement a call sends, and the installation's holding of the publication fact"
	},
	budget: { runs: 8, steered: 8 },
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/analysis/schema.ts",
			original: '\t\t\t\treturn c?.holding.kind === "stored" && c.subject.reads.every(seesWhole)\n',
			replacement:
				'\t\t\t\treturn c?.holding.kind === "stored" && c.subject.reads.every(seesWhole) && relation === ""\n',
			why: "No role reads a stored derived relation's table: L's read derives F from I0 and I1 at every call, where F's table holds it."
		},
		{
			file: "packages/engine/src/analysis/theory/frozen.ts",
			original: "\towned.units.get(unit)?.sealed === true\n",
			replacement: "\towned.units.get(unit)?.sealed === false\n",
			why: "A sealed unit read as unfounded: F, a count over a whole package, re-derives the package at every write of it, so the installation reads it live, and every call derives it again from the content."
		}
	]
})
