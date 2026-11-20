/**
 * The migrator under the deltas of the identity cutover, on PostgreSQL 19, run as a commands program over schema
 * versions of a populated installation, against a pure model of the world and its facts.
 *
 * The world is a few relations, each with a payload `x`, keyed by a uuid `id` or by a compound key of two texts and a
 * bigint (`ka`, `kb`, `kc`), each referencing relations before it: by a plain containment, or as the member of an
 * ordered family (with its drawn `at`) or a counted one, its owner's drawn count `n<m>` and, with a sum fold of `x`, its
 * accumulated end `e<m>`; and stored generated columns `g<k>` over `x`, and caller fields `y<k>`. A row's identity is
 * its serial in the model, and every key a row has ever had is a function of it: a uuid numbered by it, or texts of the
 * relation's drawn widths and the serial itself, so a re-key's data mapping, old key to new key, is the model's own.
 *
 * Each command is one delta of the cutover, composed several to a version:
 *
 * - a relation re-keyed from its uuid to the compound key, every relation that references it re-pointed to the new key
 *   (its uuid field dropped, three fields added), the new fields filled by the reviewer's data step; several re-keys in
 *   one version make chains and diamonds of re-keyed references;
 * - a relation re-keyed from its uuid to one text, a manifest identifier's shape, every reference to it keeping its
 *   name and changing its type from the uuid to the text (CONTRACT's `package`), each referencing row's value the
 *   reviewer's correlated read of the re-keyed row's new key through the old uuid;
 * - an ordered family switched to counted: the position goes, the set remains;
 * - an ordered family dropped, its member keeping a plain containment of its owner (Entry losing `at`);
 * - stored generated columns added in bulk to one relation;
 * - a caller field added and filled by a data step, row by row, from the model's function;
 * - a re-key whose texts are past PostgreSQL's B-tree entry limit, which the draft refuses by name, applying nothing.
 *
 * `migrate` first writes a batch of new facts through the login's served file (a ChangeSet of the version installed,
 * ordered members nested under their new owners), then drafts the pending version from the snapshot before it
 * (`grizzle generate`), declaring every dropped uuid field (`--drop`), and reviews it as a person does: each
 * new column's placeholder takes a typed default, and where the marker says, right after the draft's own `SET
 * CONSTRAINTS ALL IMMEDIATE`, the harness writes the data step from the model's mapping: each re-keyed relation's new
 * key from its old one, each referencing row's new fields joined through its old uuid, each filled field row by row;
 * a set-aside reference's fill takes the correlated read of its target's new key. Then the files are checked as
 * `grizzle check` checks them (every marker resolved, every loss decided, no statement controlling the transaction),
 * applied by `grizzle migrate`'s runner, whose admission judges the catalog against the snapshot, with the
 * installed-catalog checker. After every step:
 *
 * - every table of the installation was rewritten at most once by the migration, by PostgreSQL's `table_rewrite`
 *   event trigger (test/support/migrate/rewrites.ts);
 * - the installed catalog is a fresh install's of the version, its worlds included;
 * - every fact the model holds reads back exactly, through the model's identity and key mapping: each key, each
 *   re-pointed reference, each kept position, each count and fold end, each generated and filled value; nothing lost,
 *   nothing invented;
 * - the version's schema drafts no further change from the snapshot the migration reached: it is generated.
 *
 * A re-key past the limit is refused by the draft as UnrepresentableKey over the relation's texts; any other refusal of
 * any step fails the property.
 *
 * Text widths are drawn per re-key: short ones, and the widest a B-tree entry holds beside the other text and four
 * bigints in any order, every column NULL-able (cutover.fixtures.ts fitsBeside), which covers every index the world plans over a re-keyed key
 * (its primary key, an owner's key with a count, a family's own UNIQUEs with an index and a fold's running value), so
 * an index entry near BTMaxItemSize is inside the box; every row of an even serial holds its texts at their full width
 * in four-byte characters no compression shortens, so PostgreSQL itself refuses a key grizzle admits that does not fit.
 * Past the limit, both texts are wider than half of BTMaxItemSize. Widths between the documented bound and the limit
 * are not drawn: grizzle's bound there is its own, which this suite does not restate.
 *
 * Oracle: the world model, a second implementation of what every fact is after each delta, judged by PostgreSQL: the
 * rows it holds, the catalog of a fresh install, and the table_rewrite events it fires.
 *
 * Features: each delta, a reference re-pointed under its own name among them; a re-keyed relation referenced by two
 * relations, and by a re-keyed relation; an ordered family's owner re-keyed and an ordered member re-keyed; ordered to
 * counted with a fold over the family; a dropped position a fold read; a key near BTMaxItemSize admitted and one past
 * it refused; and a version with all six deltas.
 * Each is aimed at by a steered case, drawn over a world that holds every structure, never by filtering draws.
 *
 * The seventh delta, a property of its own over a tree rooted at one document field and keyed by it and its start
 * (test/support/migrate/keyed-tree.ts docTreeOf), drafted from nothing: its root replaced, it becomes a keyed tree
 * rooted at a package and a path, its parent drawn anew from its kept intervals, with pantry's Node's shape over its
 * parent copies: the parent's kind copied along the
 * parent axis under the keyed tree's law, so drawn anew, the grandparent's kind copied from the parent's copy, and a
 * count fold over each node's children whose selection reads both copies, which the backfill draws only after the
 * copies (backfill.ts ordered); and pantry's Instance's shape, the tree's own count `children` also carried along a
 * second family's owner axis (a family over Node by each node's `anchor`, the first node of its count in pre-order,
 * from the anchor's `sites`), which the backfill draws as the tree's count alone (backfill.ts familyCells); and
 * pantry's Node `was`, each member's copy of the kind of the sibling before it along the tree's predecessor axis, the
 * base at slot 0 and on the root, which no predecessor meets (backfill.ts copyUpdate). One to three documents' trees,
 * each drawn by its parents, are written directly with every drawn value the stored tree's laws fix; the keyed tree is
 * drafted from its snapshot, `--drop`ping the document, reviewed with the data step that fills each node's new root
 * from its document, and applied. Each document mapped to its own root keeps every slot, count, interval and fold
 * value, each parent the stored parent's start, and holds every copy and turns fold value the
 * keyed tree's laws fix over the same facts, which a fresh install holds (families/tree.ts numbered, the direct
 * pre-order numbering, and turnsOf over it), at a fresh install's catalog, every table rewritten at most once, nothing
 * left to generate; two documents mapped onto one root, a named case of its own weight, are
 * refused at migrate before any of the backfill's derivations runs, by its check of the keyed tree's primary key, which
 * raises under that law's identity (backfill.ts keyChecks): the derivations meet rows at that key, and over its
 * duplicates every join of them would multiply the rows. The parent drawn anew is read off each root's intervals sorted
 * (backfill.ts parentDerivation), so every statement of the draft's backfill is judged on its SQL AST to read no row once
 * per row of another, neither a subquery reading a row outside it nor a LATERAL source, to recur nowhere, and each table
 * is written by one UPDATE (test/support/migrate/probes.ts). Its features: the tree re-rooted, a tree of three levels
 * or more, several stored trees each its own root, the refused merge, a fold over the copies
 * selecting a member, a node whose parent's kind is not its grandparent's, a tree's count carried along the anchor
 * family's owner axis from another node, a copy from the sibling before along the predecessor axis, and the shapes
 * whose depths and levels the parent's backfill numbers: a single-node tree, a chain four levels deep, three siblings
 * or more under one parent, and one level under two parents, each aimed at by a steered case that constructs it.
 *
 * Each case runs in a database of its own (Substrate.fresh): the rewrite observer's event trigger is the database's.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	cutoverSteered,
	type Feature,
	features,
	history,
	type TreeFeature,
	treeFeatures,
	treeHistory,
	treeSteered
} from "#test/pg/migrate/cutover.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The migrator under the identity cutover's deltas every migration of a cutover history rewrites each table at most once, reaches a fresh install's catalog, keeps every fact through the model's key mapping and leaves nothing to generate, and a key past BTMaxItemSize is refused by the draft.
 *
 * Its pre-conversion budget: runs 3, coverage cases 32 (test/pg/migrate/cutover.test.ts at d8eed1786).
 */
export const theMigratorUnderTheIdentityCutoversDeltasEveryMigrationOfACutoverHistoryRewritesEachTableAtMostOnceReachesAFreshInstallsCatalogKeepsEveryFactThroughTheModelsKeyMappingAndLeavesNothingToGenerateAndAKeyPastBTMaxItemSizeIsRefusedByTheDraft =
	property.explore(steered(cutoverSteered), {
		needs: { substrate: Substrate.fresh },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(cutover) =>
				Effect.provideServiceEffect(
					history(cutover, (f) => c.note(f)),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the world model and its key mapping, judged by PostgreSQL's rows, a fresh install's catalog and its table_rewrite events"
		},
		budget: { runs: 3, steered: 32 },
		kept: [],
		kills: []
	})

/**
 * The migrator under the identity cutover's deltas a tree re-rooted at a package and a path becomes the keyed tree: every parent the stored parent's start, every slot, interval and fold value kept, at a fresh install's catalog with each table rewritten at most once, and two trees mapped onto one root refused by the backfill's check of the keyed tree's primary key.
 *
 * Its pre-conversion budget: runs 2, coverage cases 16 (test/pg/migrate/cutover.test.ts at d8eed1786).
 */
export const theMigratorUnderTheIdentityCutoversDeltasATreeReRootedAtAPackageAndAPathBecomesTheKeyedTreeEveryParentTheStoredParentsStartEverySlotIntervalAndFoldValueKeptAtAFreshInstallsCatalogWithEachTableRewrittenAtMostOnceAndTwoTreesMappedOntoOneRootRefusedByTheBackfillsCheckOfTheKeyedTreesPrimaryKey =
	property.explore(steered(treeSteered), {
		needs: { substrate: Substrate.fresh },
		situations: treeFeatures satisfies ReadonlyArray<Reached<TreeFeature>>,
		check:
			({ substrate }, k: Case<TreeFeature>) =>
			(tree) =>
				Effect.provideServiceEffect(
					treeHistory(tree, (f) => k.note(f)),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the direct pre-order numbering of each stored tree under its new root, judged by PostgreSQL's rows, a fresh install's catalog and its table_rewrite events"
		},
		budget: { runs: 2, steered: 16 },
		kept: [],
		kills: []
	})
