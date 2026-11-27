/**
 * A family over stored rows across a migration that renames it or changes what fills it, on PostgreSQL 19,
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
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	changeAims,
	changeCase,
	changeCaseGen,
	type ChangeFeature,
	kinds,
	redrawAims,
	redrawCase,
	redrawCaseGen,
	type RedrawFeature,
	renameCase,
	renameCaseGen,
	type RenameFeature
} from "#test/pg/migrate/family-renames.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A family over stored rows renamed or refilled through grizzle's migrations on PostgreSQL 19 a declared rename of a family's relations, the owner's fields, a roster and its handles, swaps and chains among them, renames every law column, drawn field, constraint and index in place: no table rewritten, no row updated, nothing built or validated again. */
export const declaredRenames = property.explore(renameCaseGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
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
			Effect.provideServiceEffect(
				renameCase(value, c),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "a rename changes no stored byte and builds nothing: relfilenodes, xmins, attribute numbers, values and constraint and index OIDs, judged by PostgreSQL's catalog"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/migrate/family-renames.test.ts#declaredRenames:140512.a:0.0.0.0.1.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0"
			),
			reason:
				"A counted family's member and the spare relation swapped: the member's predecessor, generated from its index, which the swap renames, was added again STORED, a rewrite of the member's table (32618b388's pairing of generated law columns by their definitions as held)",
			since: "2026-11-20"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/family-renames.test.ts#declaredRenames:140512.4:0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0"
			),
			reason:
				"A counted family's hidden fold selecting by weight under its handles b and c swapped: the fold's CHECK, which calls a row function on the hidden accumulators the swap renames, was added again NOT VALID and validated, the function named by its parameters' column names (56f26ca01's row functions)",
			since: "2026-11-21"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/family-renames.test.ts#declaredRenames:140512.4:0.1.2.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0"
			),
			reason:
				"A counted family whose hidden fold selects by weight, its roster renamed Kind to Sort, its handles kept, three owners and no member: the fold's CHECK calls Weight's row function, whose name digests the roster domain's name its text casts to, so the rename named it anew, and the CHECK was added again NOT VALID and validated (CLOSEDBITS's steered case 27 at seed 0x84b9c97d); a function whose definition the rename leaves is renamed in place",
			since: "2026-11-21"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/row-functions.ts",
			original: `\t\tname: \`p\${i + 1}\`,`,
			replacement: "\t\tname: column,",
			why: "A row function's parameters are named by the columns its caller passes, so a declared rename of one names the function anew: the CHECK that calls it is added again NOT VALID and validated, a scan of its table, where it is renamed in place; the kept swap's constraint OIDs move."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t\treturn restatedLawColumn(plan, laws, names, installation.laws.theory.relations)",
			replacement:
				"\t\t\t\t\treturn undefined && restatedLawColumn(plan, laws, names, installation.laws.theory.relations)",
			why: "A declared rename restates no law column, so the family's law columns are dropped and drawn again; the rename's no-stored-byte oracle fails."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original: "\t\t\t\tnew Transform(ownColumnHooks((c) => into.get(c) ?? c)).columnDef(d)",
			replacement: "\t\t\t\td",
			why: "A held generated column compared as it reads its columns before the renames: a predecessor whose index a declaration renames is found as no held column, and is dropped and added again STORED, a rewrite of its table; the kept swap's relfilenode moves."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t...natives.filter((n) => !generates(n)),\n\t\t\t\t...natives.filter(generates)\n",
			replacement:
				"\t\t\t\t...natives.filter(generates),\n\t\t\t\t...natives.filter((n) => !generates(n))\n",
			why: "Generated law columns found before the columns they read: a predecessor is compared before its index is found, reads it by its held name, and is added again STORED; the kept swap's relfilenode moves."
		}
	]
})

/** A family over stored rows renamed or refilled through grizzle's migrations on PostgreSQL 19 a fold's step, an axis copy's target or a counted family's group changed over stored rows, or a fold added, trees included, is drawn again, and an ordered family's group change keeps every stored index or is refused naming its law, unless the index is declared dropped: the migration commits with every law validated. */
export const changedFills = property.explore(aimed(changeCaseGen, changeAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
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
			Effect.provideServiceEffect(
				changeCase(value, c),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL validates every constraint the migration adds over the values it draws again, and refuses a regroup that breaks an ordered family's sequences, naming its law"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t\treturn (restated !== undefined && canonicalEquals(restated, f.writing)) ||\n\t\t\t\t\t\tsameSequence(previous, installation, now.name, field.name, f.writing)",
			replacement:
				"\t\t\t\t\treturn restated !== undefined || sameSequence(previous, installation, now.name, field.name, f.writing)",
			why: "A field whose filler changes keeps its stale values."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t\treturn (restated !== undefined && canonicalEquals(restated, f.writing)) ||\n\t\t\t\t\t\tsameSequence(previous, installation, now.name, field.name, f.writing)",
			replacement:
				"\t\t\t\t\treturn restated !== undefined && canonicalEquals(restated, f.writing)",
			why: "A re-pointed family's index is drawn again in member-key order."
		},
		{
			file: "packages/engine/src/physical/ddl/recheck.ts",
			original: '\t\t\t\t\t{ option: "CONSTRAINT", value: lit.text(law, types.text) }',
			replacement: `\t\t\t\t\t{ option: "CONSTRAINT", value: lit.text(\`\${law}_elsewhere\`, types.text) }`,
			why: "The violation check raises under `<law>_elsewhere` (physical/ddl/recheck.ts violationCheck), so a broken regroup's refusal names no law of the family."
		}
	]
})

/** A family over stored rows renamed or refilled through grizzle's migrations on PostgreSQL 19 a fold's step, an axis copy's target or a counted family's group changed over stored rows, a fold added, or the closed relation of weights a fold's selection by weight reads given other rows, is drawn again in place and writes exactly the rows whose values it changes: none where the new filler draws every row as the old one did, k where it moves k rows' values, every law validated over what it leaves, and builds again no constraint the target holds as it is that no state of the backfill can break. */
export const redrawWrites = property.explore(aimed(redrawCaseGen, redrawAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		...kinds,
		"fold step",
		"copy target",
		"group",
		"fold added",
		"weights",
		"every row alike",
		"some rows alike",
		"a family emptied by its regroup",
		"a fold over the copy",
		"a table the re-draw writes no row of",
		"a table the re-draw writes some rows of"
	] satisfies ReadonlyArray<Reached<RedrawFeature>>,
	budget: { runs: 4, steered: 40 },
	check:
		({ substrate }, c: Case<RedrawFeature>) =>
		(value) =>
			Effect.provideServiceEffect(
				redrawCase(value, c),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL validates every constraint the migration builds over the values it draws again, and each row's xmin moves exactly where one of its stored values changes, on every table the migration does not rewrite"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original:
				'\t\t\t\treturn call("record_image_ne", [image(valueOf), image((c) => col("k", c))])',
			replacement: "\t\t\t\treturn undefined",
			why: "The guard removed: a table's UPDATE writes every row of it, so a re-draw that moves no value writes every row and its xmin moves where no value changed; the property fails."
		},
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original:
				'\t\tredrawn.has(cellKey(cell)) ? columnAtCell(cell).placeholder : col("k", cell.column)',
			replacement: '\t\tcol("k", cell.column)',
			why: "A column drawn again in place stands before the backfill as stored: an owner whose regroup empties its family keeps its stale count, which its family's natives refuse at VALIDATE; the property fails."
		},
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: "\t\t\tfor (const r of closedOf(c.rule)) {\n\t\t\t\treads.push(r)\n\t\t\t}\n",
			replacement: "",
			why: "A fold's fill reads no closed relation, so Weight's replaced rows draw no fold again: the fold's CHECK, redefined over the new constants, refuses the accumulators the old weights drew at VALIDATE, 23514; the property fails."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: '\t\t\t\tcase "check":\n\t\t\t\t\treturn !keptAsIs(o)\n',
			replacement: '\t\t\t\tcase "check":\n\t\t\t\t\treturn false\n',
			why: "A revaluation keeps a CHECK the target defines otherwise: the previous fold's CHECK judges the values the backfill draws by the previous step and refuses the migration at the backfill's UPDATE; the property fails."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\t\tif (!keptAsIs(o) || (from && onto && nameKey(table) !== nameKey(fk.references))) {",
			replacement: "\t\t\tif (!keptAsIs(o)) {",
			why: "A revaluation keeps a foreign key over revalued columns of two tables: an owner's end held to its last member's after is checked at the end of the members' UPDATE, against the owner's stale end, and refuses the migration; the property fails."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\t\tcase "check":\n\t\t\t\t\treturn !keptAsIs(o)\n\t\t\t\tcase "primaryKey":\n\t\t\t\tcase "unique":\n\t\t\t\t\treturn takesKey(o, over.table, over.columns)\n\t\t\t\tcase "foreignKey":\n\t\t\t\t\treturn takesForeignKey(o, v.constraint, v.table)\n',
			replacement:
				'\t\t\t\tcase "check":\n\t\t\t\tcase "primaryKey":\n\t\t\t\tcase "unique":\n\t\t\t\tcase "foreignKey":\n\t\t\t\t\treturn true\n',
			why: "A revaluation takes every constraint over the column: a fold over a copy whose target moves builds its CHECK, its key and its foreign key along its members again, which no state of the backfill breaks; their OIDs move and the property fails."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: '\t\tcase "kept":\n\t\tcase "redrawn":\n\t\t\treturn { kind: "redrawn" }',
			replacement: '\t\tcase "kept":\n\t\tcase "redrawn":\n\t\t\treturn { kind: "rewritten" }',
			why: "A field drawn again dropped and added again under its placeholder: the backfill writes every row whose drawn value is not the placeholder, its xmin moved where its value is the one it stored; the property fails."
		}
	]
})
