/**
 * A stored derived relation equals its definition after every COMMIT, for every writer (physical/ddl/rules.ts, the
 * judge's phase A; analysis/theory/unit.ts StoredUpkeep): the judge reads both sides of every holder a transaction
 * wrote at each unit, and makes the stored rows there its definition's by their set difference, under the borrow that
 * every write of the unit holds.
 *
 * The box: a document's places and its links, both in the unit of the document, Doc closed or open; four stored
 * relations over them, a projection, a count by document, a negation within the document, and the rows of an immutable
 * function each place's document and place are passed to, which the judge reads at each written unit's channels; and
 * a drawn sequence of transactions of the owner's direct SQL, each putting and taking places and links at two
 * documents and three places, and changing a place's value where Doc is open, each committed before the next.
 *
 * The oracle is PostgreSQL's: after each COMMIT, in one read-only snapshot, each stored relation's rows and its
 * definition's, the definition evaluated by the conservative lowering, which relies on no evidence (oracle/harness.ts);
 * and a query of each stored relation, compiled as a read of its rows is, reads its table, never its definition, and
 * exactly its table's rows (a stored relation is a relation a query matches by its table, ir/desc.ts derivedHeld).
 *
 * Features: each kind of write, a transaction over two documents, and an open Doc.
 *
 * The live leg (stored.fixtures.ts watchRun): a stored relation's table is a footprint table like an authored one's
 * (logical/routes.ts footprintOf, physical/ddl/live.ts), published with the replica identity its primary key gives, or
 * whole where a route lies outside the key, so a watch of it is woken by the writing transaction itself. Over the same
 * box, the schema generated with a login whose workload watches each stored relation at one document, and Placed at
 * one value too, and a temporary pgoutput slot opened as the decoder login: after each COMMIT the slot decodes, through
 * the leader's own reader, to exactly one transaction holding the route keys of the stored rows the commit's upkeep
 * inserted or deleted, or to nothing where it changed none. The oracle is the stored rows themselves, read before and
 * after each COMMIT on the host. Features: a stored row's change decoded, a commit that changed no stored row, a stored
 * table published whole, and an open Doc.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type LawfulFeature,
	lawfulRun,
	type UpkeepFeature,
	upkeepCase,
	upkeepRun,
	type WatchFeature,
	watchRun
} from "#test/pg/derived/stored.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** A stored relation's rows are its definition's after every COMMIT, whatever its holders gained or lost. */
export const aStoredRelationEqualsItsDefinitionAfterEveryCommitOfEveryWriteOfItsUnits =
	property.explore(upkeepCase, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"wrote place",
			"wrote unplace",
			"wrote link",
			"wrote unlink",
			"wrote revalue",
			"two documents in one transaction",
			"Doc open"
		] satisfies ReadonlyArray<Reached<UpkeepFeature>>,
		check:
			({ substrate }, c) =>
			(value) =>
				Effect.provideServiceEffect(
					Effect.scoped(upkeepRun(value, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "each stored relation's rows against its definition evaluated by the conservative lowering, in one snapshot after each COMMIT"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/state.ts",
				original: "\tif (derived !== undefined && !derivedHeld(derived.storage)) {",
				replacement: "\tif (derived !== undefined) {",
				why: "A query matching a stored relation reads its definition again, every holder of its units scanned, where its table holds the rows it reads."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tsource: mapBindTerms(m.source, (e) => mapLeaves(e, leaves)),\n",
				replacement: "",
				why: "A restriction to the written units reads the unit's variables at its channels everywhere but a call's arguments, which still name the variable it no longer declares, so no installation of a stored relation over a function's rows compiles."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\tconst every = found.regions.map((r): RegionRead => ({ ...r, polarity: "both" }))',
				replacement: "\tconst every = found.regions",
				why: "The upkeep's region reads only the sides that can break a law: a place taken, which no positive occurrence's added side reads, puts no unit in the region, and the stored rows of a removed place outlive it."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\tbody: [removed, inserted]",
				replacement: "\t\t\tbody: [inserted]",
				why: "The upkeep inserts and never deletes: a place taken, or a link put over a place, leaves stored rows its definition no longer delivers."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\tconst upkept = b.model.theory.upkeeps.map(upkeepBlock)\n",
				replacement: "\tconst upkept: ReadonlyArray<Judged> = []\n",
				why: "No upkeep runs at COMMIT: a stored relation keeps the rows its migration filled it with, empty, whatever is written after."
			}
		]
	})

/** A watch of a stored relation is woken by the transaction whose upkeep changes its rows, at exactly their route keys. */
export const aWatchOfAStoredRelationHearsExactlyTheRouteKeysOfTheRowsEachCommitsUpkeepChanges =
	property.explore(upkeepCase, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a stored row's change decoded",
			"a commit that changed no stored row",
			"a stored table published whole",
			"Doc open"
		] satisfies ReadonlyArray<Reached<WatchFeature>>,
		check:
			({ substrate }, c) =>
			(value) =>
				Effect.provideServiceEffect(
					Effect.scoped(watchRun(value, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "each stored table's rows before and after each COMMIT, their changed rows' route keys computed on the host"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/routes.ts",
				original: '\t\t\t\tcase "relation":\n\t\t\t\tcase "derived":\n',
				replacement: '\t\t\t\tcase "relation":\n',
				why: "A read of a stored relation enters no footprint, so no live table publishes its table and no commit decodes a change of its rows: a watch of it is never woken."
			},
			{
				file: "packages/engine/src/physical/ddl/live.ts",
				original: '\t\t? "key"\n\t\t: "full"\n',
				replacement: '\t\t? "key"\n\t\t: "key"\n',
				why: "Placed, watched at a value outside its primary key (doc, at), is published by its key's columns alone, so a change of its rows carries no value and decodes to its table's key, where its rows' keyed keys are due."
			}
		]
	})

/**
 * A law over a stored relation is judged over its rows as the transaction leaves them (d11-design §3.2, step C): a
 * containment into Placed is a rule reading Placed's table in the judge's phase B, after phase A wrote it; a key over
 * Placed it does not prove is its UNIQUE, and a check over Counted its CHECK, each refusing at phase A's insert. Over the
 * same box with the three laws stated, each transaction commits exactly where the state it leaves keeps them, computed
 * on the host from the base relations alone, and is refused as an integrity violation otherwise, changing nothing.
 */
export const aLawOverAStoredRelationIsJudgedOverItsRowsAsTheTransactionLeavesThem =
	property.explore(upkeepCase, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a lawful transaction committed",
			"refused for a link at no place",
			"refused for a value twice in a document",
			"refused for three places",
			"Doc open"
		] satisfies ReadonlyArray<Reached<LawfulFeature>>,
		check:
			({ substrate }, c) =>
			(value) =>
				Effect.provideServiceEffect(
					Effect.scoped(lawfulRun(value, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the three laws restated over the host's model of the base relations, the stored rows against their definitions"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t...(isNonEmpty(upkeep) ? [readWritten] : []),\n",
				replacement: "",
				why: "Phase B judges by the written set as it stood before phase A, so a place taken leaves Placed's removed rows unjudged and a link at it commits."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\t\treturn (relation?.kind === "relation" || relation?.kind === "stored") && touched !== undefined',
				replacement: '\t\t\treturn relation?.kind === "relation" && touched !== undefined',
				why: "Placed's table is no rule table: no write of it is judged, so a place taken under a link commits."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original:
					'\t\tthis.sides.relations.get(relation)?.kind === "stored"\n\t\t\t? undefined\n\t\t\t: this.definitions.get(relation)\n',
				replacement: "\t\tthis.definitions.get(relation)\n",
				why: "A law over a stored relation reads its definition again, a key over it judged as a rule over every row of its units, and the stored rows it reads at COMMIT none of the judge's."
			}
		]
	})
