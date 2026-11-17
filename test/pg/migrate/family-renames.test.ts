/**
 * A family over stored rows across a migration that renames it or changes what fills it, on PostgreSQL 19rc2,
 * generated.
 *
 * A history: relations with rows stored at their first version, a roster's kinds among them, a tree's keyed by its
 * root field and start and so a tree already; a family over them at the second, counted, ordered or that tree, with a
 * fold whose accumulators are hidden, named or absent, stepping over every member or over those of one kind, and an
 * axis copy or none, backfilled over the rows; then a third version that either
 *
 * - **renames** it: the relations mapped injectively onto their own names, each other's or fresh ones, so swaps, chains
 *   and cycles occur, the owner, the member and a spare relation among them; the owner's count and caller fields
 *   likewise; and the roster and its handles, the kind a selected fold steps over or a closed relation's read compares
 *   with among them; each rename declared
 *   (`--rename`); or
 * - **changes what fills it**: the field its fold steps over, the field its axis copy reads, a counted or ordered
 *   family's group, or a fold it adds, a tree's among them, nothing declared.
 *
 * The oracles, PostgreSQL the judge:
 *
 * - **A rename changes no stored byte and builds nothing.** Every table keeps its OID and its relfilenode, so nothing
 *   rewrote it; every column its attribute number and its values, so no law column or drawn field was dropped and added
 *   again; every row its xmin, so no backfill UPDATE touched it; and every constraint and index its OID, so none was
 *   built or validated again. The family's law columns (‹n›, a counted index, a fold's hidden accumulators, the
 *   generated terms), its drawn fields, its keys and its CHECKs and foreign keys are renamed in place.
 * - **A changed filler is drawn again.** The migration commits, so PostgreSQL validated every constraint it added over
 *   the values it drew; a field kept with its old filler's values fails the fold's CHECK or the axis's foreign key, and
 *   a fold over a tree is drawn in the tree's stored sibling order.
 * - **A stored index is data.** An ordered family whose group changes from g to h keeps every member's stored index
 *   (README "A stored index is data"); a data step between the second and third versions, a SERIALIZABLE writer's,
 *   writes each member's h by a fate the case's swarm weighs. Mapping each owner's members onto one owner, a
 *   permutation of the owners, keeps each new group's indices 0 … n − 1: the migration commits with every member's
 *   index as the second version left it. Moving the first member of an owner's family of several to another owner breaks
 *   them: PostgreSQL refuses the third folder at the first of the family's checks it meets, naming the family's law or
 *   its fold's: the backfill's check of the family's key (h, at) before any derivation, which raises under the family's
 *   law itself (deploy/diff/backfill.ts keyChecks), for a duplicate; its bound's or a foreign key's VALIDATE, through
 *   the folder's laws, for a gap (support.ts refusedLaw reads either). A history that declares the index dropped
 *   (`--drop Member.at`) leaves h as stored and gets each member's index anew, its place in its new group's member-key
 *   order.
 * - Either way, migrate's drift check and the installed-catalog checker match the catalog against the snapshot after
 *   every step, and no constraint is left NOT VALID: every law holds.
 *
 * Features: each family kind and fold, a copy, the owner, member and count renamed, relations, fields and handles
 * swapped and chained, the roster renamed, a selected fold's handle renamed, and stored members; for a changed filler,
 * each change on each kind, trees among them, and an ordered family's group change kept, refused with its member moved
 * onto a family (the key check's refusal) and onto none (VALIDATE's), and redrawn as declared, each aimed at by a case
 * constructed to reach it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	changeAims,
	changeCase,
	changeCaseGen,
	type ChangeFeature,
	kinds,
	renameCase,
	renameCaseGen,
	type RenameFeature
} from "#test/pg/migrate/family-renames.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A family over stored rows renamed or refilled through grizzle's migrations on PostgreSQL 19rc2 a declared rename of a family's relations, the owner's fields, a roster and its handles, swaps and chains among them, renames every law column, drawn field, constraint and index in place: no table rewritten, no row updated, nothing built or validated again. */
export const declaredRenames = property.explore(renameCaseGen, {
	needs: { substrate: Substrate.installing },
	situations: [
		...kinds,
		"fold none",
		"fold hidden",
		"fold named",
		"copy",
		"owner renamed",
		"member renamed",
		"count renamed",
		"relations swapped",
		"relations chained",
		"fields swapped",
		"fields chained",
		"roster renamed",
		"handles swapped",
		"handles chained",
		"fold selecting by kind",
		"fold selecting by weight",
		"kind selection's handle renamed",
		"weight selection's handle renamed",
		"stored members"
	] satisfies ReadonlyArray<Reached<RenameFeature>>,
	/** Its pre-conversion budget: runs 4, coverage cases 48 (family-renames.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 48 },
	check:
		({ substrate }, c: Case<RenameFeature>) =>
		(value) =>
			Effect.provideServiceEffect(renameCase(value, c), Substrate, substrate),
	oracle: {
		kind: "postgresql",
		name: "a rename changes no stored byte and builds nothing: relfilenodes, xmins, attribute numbers, values and constraint and index OIDs, judged by PostgreSQL's catalog"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\twas: restatedLawColumn(n.plan, laws, names, installation.laws.theory.relations)",
			replacement: "\t\t\twas: undefined",
			why: "A declared rename restates no law column, so the family's law columns are dropped and drawn again; the rename's no-stored-byte oracle fails."
		}
	]
})

/** A family over stored rows renamed or refilled through grizzle's migrations on PostgreSQL 19rc2 a fold's step, an axis copy's target or a counted family's group changed over stored rows, or a fold added, trees included, is drawn again, and an ordered family's group change keeps every stored index or is refused naming its law, unless the index is declared dropped: the migration commits with every law validated. */
export const changedFills = property.explore(aimed(changeCaseGen, changeAims), {
	needs: { substrate: Substrate.installing },
	situations: [
		...kinds,
		"fold hidden",
		"fold named",
		"copy",
		"fold step",
		"copy target",
		"group",
		"fold added",
		"fold step on a tree",
		"fold added on a tree",
		"copy target on a tree",
		"fold selecting by kind",
		"fold selecting by weight",
		"stored members",
		"group kept on an ordered family",
		"group refused, moved onto a family, on an ordered family",
		"group refused, moved onto no family, on an ordered family",
		"group redrawn as declared on an ordered family"
	] satisfies ReadonlyArray<Reached<ChangeFeature>>,
	/** Its pre-conversion budget: runs 4, coverage cases 60 (family-renames.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 60 },
	check:
		({ substrate }, c: Case<ChangeFeature>) =>
		(value) =>
			Effect.provideServiceEffect(changeCase(value, c), Substrate, substrate),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL validates every constraint the migration adds over the values it draws again, and refuses a regroup that breaks an ordered family's sequences, naming its law"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t\treturn (spell.complete && sameText(restated, f.writing)) ||\n\t\t\t\t\t\tsameSequence(previous, installation, now.name, field.name, f.writing)",
			replacement:
				"\t\t\t\t\treturn spell.complete || sameSequence(previous, installation, now.name, field.name, f.writing)",
			why: "A field whose filler changes keeps its stale values."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t\treturn (spell.complete && sameText(restated, f.writing)) ||\n\t\t\t\t\t\tsameSequence(previous, installation, now.name, field.name, f.writing)",
			replacement: "\t\t\t\t\treturn spell.complete && sameText(restated, f.writing)",
			why: "A re-pointed family's index is drawn again in member-key order."
		},
		{
			file: "packages/engine/src/deploy/render/sql.ts",
			original:
				'\t\t\t\t\t\t\t\t\t\t\t{ option: "CONSTRAINT", value: lit.text(action.law, types.text) }',
			replacement: `\t\t\t\t\t\t\t\t\t\t\t{ option: "CONSTRAINT", value: lit.text(\`\${action.law}_elsewhere\`, types.text) }`,
			why: "The violation check raises under `<law>_elsewhere` (render/sql.ts), so a broken regroup's refusal names no law of the family."
		}
	]
})
