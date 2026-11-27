/**
 * A stored derived relation equals its definition after every COMMIT, for every writer (physical/ddl/rules.ts, the
 * judge's phase A; analysis/theory/unit.ts StoredUpkeep): the judge reads both sides of every holder a transaction
 * wrote at each unit, and makes the stored rows there its definition's by their set difference, under the borrow that
 * every write of the unit holds. The installation infers each one stored, its definition unit-local within the unit Doc
 * and Link sit in, at a unit narrower than it, so its upkeep costs what its delta bounds, whether Doc and Link are closed
 * or open (analysis/derived/storage.ts).
 *
 * The box: a document's places and its links, both in the unit of the document's shelf, which every write borrows, each
 * stored relation kept at a document or narrower, so a write's upkeep re-derives the documents it touched and never the
 * rest of the shelf, Doc and Link closed or open; five stored relations over them, a projection, a count by document, a
 * negation within the document, the rows of an immutable function each place's document and place are passed to, which the judge
 * reads at each written unit's channels, and Programmed, edullm's WalkPattern in the box's terms, each linked place
 * joined back to its value's program, a rule compiling each of a document's distinct values once by an immutable
 * function; and a level above them Hops, the placed places linked back to a document's placed place 0, over the stored
 * projection's table and the links through a stored relation of them, kept a stratum after both, though it sorts before it by name, Dense, the documents of two places or more, over the
 * stored count's table, kept a stratum after the count, and Weighted, each place with each heavy weight, matching the
 * closed Weight, whose rows no write changes, so its upkeep holds Doc alone; a level above those Crowded, the dense
 * documents placed at 0, over the stored Dense and Placed alone, kept a stratum above Dense; and a drawn sequence of
 * transactions of the owner's direct SQL, each putting places and links at two documents and three places, and, where
 * Doc and Link are open, taking them and changing a place's value, a closed relation's facts never removed
 * (physical/ddl/immutable.ts), each committed before the next, the writer standing up the two tables it writes and no
 * other (test/support/judge.ts standUpRelations).
 *
 * The oracle is PostgreSQL's: after each COMMIT, in one read-only snapshot, each stored relation's rows and its
 * definition's, the definition evaluated by the conservative lowering, which relies on no evidence (oracle/harness.ts);
 * and a query of each stored relation, compiled as a read of its rows is, reads its table, never its definition, and
 * exactly its table's rows (a stored relation is a relation a query matches by its table, analysis/schema.ts
 * CheckedSchema read).
 *
 * Features: each kind of write, a transaction over two documents, and an open Doc and Link.
 *
 * The call leg (stored.fixtures.ts callsRun): over the same box, before each COMMIT, Programmed's upkeep calls its
 * function once for each distinct value of each document it keeps, however many places hold the value and links stand
 * at them. The oracle is the host's model of the places, the function counting its own calls. Features: a value at two
 * places of a written document, a value at no linked place of one, and an open Doc.
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
import { finite } from "@bjornpagen/testing/gen"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CallsFeature,
	callsRun,
	type LawfulFeature,
	lawfulRun,
	type ServedLawFeature,
	servedLawRun,
	servedPlacesGen,
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
			"wrote a place of a value Placed rejects",
			"wrote a link of a target Linked rejects",
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
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/stored.test.ts#aStoredRelationEqualsItsDefinitionAfterEveryCommitOfEveryWriteOfItsUnits:-:0.1.1.0.0.0.0"
				),
				reason:
					"a stored relation's upkeep of hops read Linked's stored table at (doc, shelf, to), the previous step's `to` landed on its last step, a binding the extraction never asked, so the installation refused the upkeep as a missed index",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: '\t\tnamed.get(relation)?.holding.kind === "stored"\n',
				replacement: "\t\tfalse\n",
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
				original: "\tconst every = found.regions.map((r): RegionRead => ({ ...r, polarity }))",
				replacement: "\tconst every = found.regions",
				why: "The upkeep's region reads only the sides that can break a law: a place taken, which no positive occurrence's added side reads, puts no unit in the region, and the stored rows of a removed place outlive it."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\t\tbody: [...removed.body, inserting(headed(rows.statement, reads), heading)]\n",
				replacement: "\t\t\t\t\tbody: [inserting(headed(rows.statement, reads), heading)]\n",
				why: "The upkeep inserts and never deletes: a place taken, or a link put over a place, leaves stored rows its definition no longer delivers."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tconst [held, ...more] = found.reads.filter((r) => holders.has(r.relation))",
				replacement: "\tconst [held, ...more] = found.reads",
				why: "An upkeep's reads take the closed Weight, which Weighted matches, as a holder: no installation compiles (grizzle internal invariant: Weight, a table the upkeep of Weighted reads: an ordinary relation or a stored derived one), edullm's ItemRecordVariable over the closed Declares."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\tconst stratum = below.reduce((most, at) => Math.max(most, at), 0)\n",
				replacement: "\t\tconst stratum = 0\n",
				why: "Every upkeep runs in one stratum, under the written set as the transaction left it: Hops's part runs only where a delta it read before phase A holds a row, so a place put at 0 under standing links, which changes Placed and no link, leaves Hops without the places it now reaches."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "\t\tfor (const c of this.checked.canonical.values()) {\n",
				replacement:
					"\t\tfor (const c of [...this.checked.canonical.values()].toSorted((a, b) => compareStrings(a.subject.name, b.subject.name))) {\n",
				why: "The theory admits stored relations in name order, not the checked schema's admission order, level by level, Hops before Placed, which it reads: Hops's upkeep reads no stored Placed, so its stratum is 0 and no change of Placed's rows puts a unit in its region."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t...new Set([...reach.keys()].flatMap((name) => (kept.has(name) ? [root(name)] : [])))\n",
				replacement: "\t\t\t...new Set<string>()\n",
				why: "A table's stand-up makes the deltas one block away from its own alone and calls no closure's maker: a place's write stands up the deltas its upkeeps read beside its own and no closure of the stored relations they write, so Counted's capture in phase A finds its closure's marker missing and refuses the transaction (55Z03)."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\tconst upkeep = upkeepParts.flatMap((stratum) => [...partsRun(stratum), readWritten])\n",
				replacement: "\tconst upkeep: ReadonlyArray<PlStatement> = []\n",
				why: "No upkeep runs at COMMIT: a stored relation keeps the rows its migration filled it with, empty, whatever is written after."
			}
		]
	})

/**
 * A stored relation's upkeep calls a declared function once for each distinct tuple of arguments at the units a
 * transaction wrote, however many of their rows hold the tuple (ir/expr.ts evaluatesCall): Programmed, edullm's
 * WalkPattern in the box's terms, joins each linked place back to its value's compile, a rule over each document's
 * distinct values, which navigation reads whole (analysis/theory/navigate.ts sharedImports), and a closed form's gain
 * computes once over the distinct values its rules deliver (analysis/theory/query.ts sharedCalls), whose projection reads its
 * input as a set (analysis/physical/consumers.ts) and which PostgreSQL never pulls up into the step that reads it, its
 * call refusing a NULL through the volatile refusal function (write/refusal.ts), so `compile` runs once per value of a
 * written document, never once per place or per linked place.
 */
export const aStoredRelationsUpkeepCallsAFunctionOncePerDistinctArgumentTupleOfTheUnitsAWriteWrote =
	property.explore(upkeepCase, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a value at two places of a written document",
			"a value at no linked place of a written document",
			"Doc open"
		] satisfies ReadonlyArray<Reached<CallsFeature>>,
		check:
			({ substrate }, c) =>
			(value) =>
				Effect.provideServiceEffect(
					Effect.scoped(callsRun(value, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the distinct values of each document a transaction wrote, counted on the host's model of the places, against the calls PostgreSQL counts of the upkeep's insert before COMMIT: exactly those where it re-derives the documents, at most those where Doc is closed and it derives the facts the added rows gain"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/stored.test.ts#aStoredRelationsUpkeepCallsAFunctionOncePerDistinctArgumentTupleOfTheUnitsAWriteWrote:-:0.1.1.0.0.0.0"
				),
				reason:
					"a stored relation's upkeep of hops read Linked's stored table at (doc, shelf, to), the previous step's `to` landed on its last step, a binding the extraction never asked, so the installation refused the upkeep as a missed index",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/derived/stored.test.ts#aStoredRelationsUpkeepCallsAFunctionOncePerDistinctArgumentTupleOfTheUnitsAWriteWrote:7.1:0.1.2.0.1.2.0.1.1.2.0"
				),
				reason:
					"a place and its link written in one transaction, Doc and Link closed: the closed form's gain, three rules (the place, the link, the compiled value's own place) each joined to the value, called compile three times where the document holds one value, each arm of the union evaluating its own head",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/pg/derived/stored.test.ts#aStoredRelationsUpkeepCallsAFunctionOncePerDistinctArgumentTupleOfTheUnitsAWriteWrote:-:0.3.1.0.1.0.3.1.1.1.0.0.2.0.1.2.3.1.1.2.0"
				),
				reason:
					"a linked place, then a second place of its value written with its link, Doc and Link closed: the gain's compiles, an import no parameter restricts over the units, were read at each read again, keyed by the drivers before them, so compile ran once for each of the two linked places the drivers delivered where the document holds one value",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\t\t\tstage.kind === "rules" &&\n\t\t\t!(stage.arms.length === 1 && callsOnce(stage.arms[0]))\n',
				replacement: '\t\t\tstage.kind === "rules"\n',
				why: "The gain's compiles, read over the units where no parameter restricts them, are read at each read again, a step keyed by the drivers before it: compile runs once per linked place the drivers deliver, twice for a document of two linked places of one value."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\treturn { touched, query: sharedCalls([first, ...rest], u.loc) }",
				replacement: "\treturn { touched, query: queryOf([first, ...rest], u.loc) }",
				why: "The gain's rules each evaluate their heads' calls, the union read arm by arm: a place and its link written in one transaction compile the place's value three times, once for each rule that derives the fact."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\t\t\t\tif (sharing.kind === "perStatement" && callsOf(stage.arms[0].head).size > 0) {\n\t\t\t\t\tshared.add(key)\n\t\t\t\t\tcontinue\n\t\t\t\t}\n',
				replacement: "",
				why: "Navigation inlines the compiles into the upkeep's chain, so its call stands in the chain's head and runs once for every linked place, joined to every place of its value: a document of two places of one value, both linked, is compiled four times, where it holds one value."
			},
			{
				file: "packages/engine/src/analysis/physical/consumers.ts",
				original:
					'\t\t\t\tevaluatesCall(node.out.map((o) => o.expr))\n\t\t\t\t\t? observe(node.input, "input")\n',
				replacement:
					'\t\t\t\tevaluatesCall(node.out.map((o) => o.expr))\n\t\t\t\t\t? pass(node.input, "input")\n',
				why: "A projection that calls a function passes its input's repeats on, so the compiles' DISTINCT stands above the call: `compile` runs once per place of a written document, twice for a value two places hold."
			},
			{
				file: "packages/engine/src/write/refusal.ts",
				original: 'const refusalVolatility = "VOLATILE"\n',
				replacement: 'const refusalVolatility = "STABLE"\n',
				why: "The refusal function a call's NULL value is refused by is STABLE, so the compiles are a simple subquery, which PostgreSQL pulls up into the step that joins them back to the linked places, evaluating the call where that step reads the program: once per linked place, and never for a value no linked place holds."
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
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/stored.test.ts#aWatchOfAStoredRelationHearsExactlyTheRouteKeysOfTheRowsEachCommitsUpkeepChanges:-:0.1.1.0.0.0.0"
				),
				reason:
					"a stored relation's upkeep of hops read Linked's stored table at (doc, shelf, to), the previous step's `to` landed on its last step, a binding the extraction never asked, so the installation refused the upkeep as a missed index; and the served read countedAt reads Counted at its document alone, which the extraction asked as a lookup of Counted's key (doc, shelf), whose index leads with the shelf, its unit (shelf, doc), so generate refused the read as a missed index",
				since: "2026-11-26"
			}
		],
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
				original:
					"\tconst upkeep = upkeepParts.flatMap((stratum) => [...partsRun(stratum), readWritten])\n",
				replacement: "\tconst upkeep = upkeepParts.flatMap((stratum) => partsRun(stratum))\n",
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
					'\t\tthis.checked.holdings.get(relation)?.kind === "stored"\n\t\t\t? undefined\n\t\t\t: this.definitions.get(relation)\n',
				replacement: "\t\tthis.definitions.get(relation)\n",
				why: "A law over a stored relation reads its definition again, a key over it judged as a rule over every row of its units, and the stored rows it reads at COMMIT none of the judge's."
			}
		]
	})

/**
 * A served write that breaks a law over a stored relation is refused naming the law: Placed's key and Counted's check
 * each refuse at the judge's phase A by its stored table's native object, and the refusal names the law as the schema
 * states it, as a key of an ordinary relation's does (stored.fixtures.ts servedLawRun), where the UNIQUE's 23505 was an
 * ExecutionFailure naming the index (edullm's pantry, its trimmed_mark and id_binding keys and p23's KnownOperand key).
 */
export const aServedWriteThatBreaksALawOverAStoredRelationIsRefusedNamingTheLaw = property.exhaust(
	finite(servedPlacesGen),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"refused for a value twice in a document",
			"refused for three places",
			"a lawful write accepted"
		] satisfies ReadonlyArray<Reached<ServedLawFeature>>,
		check:
			({ substrate }, c) =>
			(places) =>
				Effect.provideServiceEffect(
					Effect.scoped(servedLawRun(places, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the lawful schema's key over Placed and check over Counted over the places a call states: a value twice refused by the key, three places by the check, as the schema states each"
		},
		box: "a served insert of one document's places by the full world's login over the lawful schema: two places of one value, three places, two places of two values",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/schema.ts",
				original: '\t\t\tr.kind === "stored" && written.has(r.name) ? [r.ident] : []\n',
				replacement: "\t\t\t[]\n",
				why: "The stored tables' keys and checks are left out of the role's key-law map: Placed's UNIQUE refuses at phase A and its 23505 reaches the shell unclaimed, an ExecutionFailure naming the index (edullm's pantry, trimmed_mark and id_binding)."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					"\t\t\tif (!changed.has(upkeep.relation) && upkeep.reads.some((r) => changed.has(r.relation))) {\n",
				replacement:
					"\t\t\tif (!changed.has(upkeep.relation) && upkeep.reads.some(() => false)) {\n",
				why: "A write of Doc changes Doc alone, not the stored relations the judge keeps from it: their natives are no law the role's writes can raise, and Counted's CHECK refuses three places as an ExecutionFailure."
			}
		]
	}
)
