/**
 * Generated migration paths on PostgreSQL 19, applied by the real runner, with PostgreSQL's own catalog as the oracle.
 *
 * A path is a schema A, its successor B and B's successor C, drawn two ways: the renamed paths of the generator
 * (`renamedDrawGen`: random oracle schemas with the renames a user makes), and the
 * adversarial rename intents over the hazard base (`legalIntentSketchGen`: swaps, chains, renames of a
 * referenced relation and of its key, keys over retyped fields, a field renamed with its type changed, a relation and
 * its field renamed together, a roster renamed, its handle removed or renamed, its field retyped, a name hopping across
 * the relation and type namespaces, and a name B dropped taken in C). Each step is drafted by
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
 *     a hole after B, and no code at all on the direct path).
 *
 * Every path runs under a drawn ambient session (test/support/ambient.ts): the defaults of the path's own owner login,
 * which every migration session starts under, its search path PostgreSQL's own or the installation's schemas first. A
 * renamed path also draws, beside the generator's renames, an arm whose B renames a relation or a closed roster to the
 * name of a PostgreSQL type; the renamed stream requires that name under the installation-first path, the pairing
 * where a bare type name resolves to the installation's row type or domain, and the generator draws a steered case
 * under that path, its B taking such a name, while the pairing is pending.
 *
 * Every verdict is PostgreSQL's: its refusal of a statement, its catalog of both installations, and its reading of the
 * rows. The features are the rename kinds a path made by successor, the intents it made, what the draft declared, the
 * ambient session, and whether a version names a relation or a closed roster as PostgreSQL names a type or function.
 *
 * Oracle: PostgreSQL, through its refusal of a statement, its catalog of a fresh install of each version, and its
 * reading of the rows the carry model loads; and the path's own commutation, A to C directly as A to B to C.
 *
 * Features: the renamed stream requires a catalog-type name under the installation-first path; the intents stream
 * requires every legal intent, each steered case aiming its first B intent at the pending one its turn falls on as the
 * steering reads it after every case (steerEvery 1), so the steered phase's one case per intent reaches them all.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	legalIntents,
	resolveLegalIntents,
	resolveRenamedDraw
} from "#test/pg/migrate-gen/support.ts"
import {
	type Feature,
	intentsCaseSteered,
	pathCase,
	renamedCaseSteered
} from "#test/pg/migrate/paths.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Generated migration paths on PostgreSQL renamed paths: every apply admitted against its snapshot, facts carried, A to C as A to B to C. */
export const renamedPaths = property.explore(steered(renamedCaseSteered), {
	needs: { substrate: Substrate.installing },
	situations: [["grizzle-first path", "catalog-type name"]] satisfies ReadonlyArray<
		Reached<Feature>
	>,
	/** Its pre-conversion budget: runs 4, coverage cases 4 * runs, 16 (paths.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 16 },
	check:
		({ substrate }, notes: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				pathCase(notes.draw(resolveRenamedDraw(c.draw)), c.ambient, notes),
				Substrate,
				substrate
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's refusals, a fresh install's catalog of each version and the carried rows read back; A to C as A to B to C"
	},
	kept: [
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.0.0.0.0.0.0.0"),
			reason: "M49: two relation renames referencing each other",
			since: "2026-10-29"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.1.0.0.0.0.0.0"),
			reason: "M48: a key carried over a retyped field",
			since: "2026-10-29"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.2.0.0.0.0.0.0"),
			reason: "a key over a field renamed onto the primary key a new reference reads",
			since: "2026-10-29"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.3.0.0.0.0.0.0"),
			reason:
				"a candidate key promoted over a dropped surrogate, its reference turned immediate in the same migration",
			since: "2026-11-08"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.4.0.0.0.0.0.0"),
			reason: "M36: a field renamed with its type changed",
			since: "2026-10-29"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.5.0.0.0.0.0.0"),
			reason: "M51: statistics over a retyped field",
			since: "2026-10-29"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.6.0.0.0.0.0.0"),
			reason: "M51: statistics of a renamed relation",
			since: "2026-10-29"
		},
		{
			token: ReplayToken("test/pg/migrate/paths.test.ts#renamedPaths:-:8.7.0.0.0.0.0.0"),
			reason:
				"rosters carrying a text payload: each version's login holds their closed relations as admitted",
			since: "2026-11-07"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/paths.test.ts#renamedPaths:-:6.u.0.g.h.g.h.h.h.f.h.h.0.g.0.0.g.0.h.0.g.0.g.h.f.g.0.f.h.g.h.f.h.0.g.f.g.g.f.g.h.g.h.3.1.4.1.2.3.9.1.6.1.3.e.3.b.2.1.3.3.d.0.2.4.0.6.0.6.h.1.0.1.0.1.1.2.l.1.1.7.1.1.0.1.9.2.2.5.1.8.1.0.8.2.a.1.3.9.2.b.2.3.f.3.c.2.b.1.6.6.0.f.0.a.0.0.2.1.2.4.3.q.1.2.a.s.0.0.1.3.0.1ado.j9g.5w.1.1.1.1.a.z2v.1b2k.fwn.g.0.0.0.hlh.pav.6a1.f.1.k.1.1.p.txw.snt.zue.c.1.1.1.0.0.1.rfp.105z.1ej6.1.1.o.1.0.1.1efj.1.7.1e4d.1ce8.v21.5.0.0.2.5.eut.2f4.a9f.m.2.p.m.1.e.zpe.3.s.p.2.9.2.1.1.a.2.e.3.a.0.5.2.7.3.3.0.a.3.d.0.7.0.0.1.n.ady.284.zxe.6.0.0.1.d.xl1.e.1ei0.q.0.1.0.1.0.5ce.5y6.fhv.v.0.0.0.0.0.4.2.0"
			),
			reason:
				"FULLSUITE3: a handle removed from a roster whose domain types a relation the same step drops, holding the removed code (A to B, every removal a drop): the domain's VALIDATE drafted before the drop refused the dropped table's row, 23514 (engine fix 695fe292)",
			since: "2026-11-16"
		}
	],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\tconst relations = renamedSnapshot(previous, target, renamed, fields, anew, temporaries)",
			replacement:
				"\tconst relations = renamedSnapshot(previous, target, renamed, new Map(), anew, temporaries)",
			why: "A draft ignores every declared field rename in the snapshot it renames, so a renamed field's path fails."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: '\t\t\tthis.sql("publish.validate", [',
			replacement: '\t\t\tthis.sql("validate", [',
			why: "A re-pointed domain's VALIDATE drafted in Validate, before Publish drops the relations and fields the target no longer has, so a step that removes a handle and drops a relation still holding its code fails 23514 (the engine defect 695fe292 fixed, found red here by the rotating stream at TEST_SEED=604930236, kept as FULLSUITE3's case)."
		}
	]
})

/** Generated migration paths on PostgreSQL paths of adversarial rename intents: every apply admitted against its snapshot, facts carried. */
export const intentPaths = property.explore(steered(intentsCaseSteered), {
	needs: { substrate: Substrate.installing },
	situations: Arr.map(
		legalIntents,
		(kind): Feature => `the intent ${kind}`
	) satisfies ReadonlyArray<Reached<Feature>>,
	/**
	 * Its pre-conversion budget: runs 4, coverage cases one per legal intent (paths.test.ts at bf4f43bb: each steered case
	 * aims its first B intent at the pending one its turn falls on).
	 */
	budget: { runs: 4, steered: legalIntents.length },
	check:
		({ substrate }, notes: Case<Feature>) =>
		(sketch) =>
			Effect.provideServiceEffect(
				Effect.suspend(() => {
					for (const intent of new Set(
						Arr.map([...sketch.intents.toB, ...sketch.intents.toC], (i) => i.kind)
					)) {
						notes.note(`the intent ${intent}`)
					}
					return pathCase(resolveLegalIntents(sketch.intents), sketch.ambient, notes)
				}),
				Substrate,
				substrate
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's refusals, a fresh install's catalog of each version and the carried rows read back; A to C as A to B to C"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\tconst relations = renamedSnapshot(previous, target, renamed, fields, anew, temporaries)",
			replacement:
				"\tconst relations = renamedSnapshot(previous, target, new Map(), fields, anew, temporaries)",
			why: "A draft ignores every declared relation rename in the snapshot it renames, so a renamed relation's path fails."
		}
	]
})
