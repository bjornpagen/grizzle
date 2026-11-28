/**
 * insertPreview (engine program/preview.ts) against PostgreSQL 19: the rows a preview gives are the rows the same
 * `ChangeSet.empty(S).insertAll(rows)` stores as the first write of an installation holding no row, every field of
 * every writable relation as a host value, each row's generated fields as rowEvaluator computes them of the preview's
 * row; and each refusal a preview gives is the write's, by the same law, with the same witness.
 *
 * Each case draws a schema of families, half the time the fresh groups' counted families (two to four mutable
 * relations, one to three counted families, a sequence nesting a counted member, owner-axis copies;
 * test/pg/write/fresh-groups), half the time the fill order's (trees, ordered and counted families, folds and copies
 * along each axis; test/support/families/fill.ts admittedFillSpecGen), with an instance of it; beside it a palette of
 * closed ids over the ordered roster Hue: Swatch, keyed by a closed id, whose generated lum reads the closed relation
 * Glow at its tone, owning Dab's counted family (a max fold over closed ids, an or fold over sets, owner copies of a
 * closed id and of the generated lum) and Stroke's ordered family (a predecessor copy of a closed id, its base a). Its
 * call states the whole instance, now and then with a fault: a handle the history dropped, two rows at one key, a tone
 * whose lum is NULL with dabs reading it and without, a dab whose swatch the call does not insert, a label past its
 * domain whose tag the dabs copy. Each refusal is aimed
 * at by a case constructed to reach it.
 *
 * The schema is installed twice: fresh, through its first migration, where codes are the roster's declared order the
 * preview binds under; and migrated, through a first version whose Hue holds b and lacks e, then the second, which
 * drops b and appends e, so its codes hold a hole: c, d and e are 2, 3 and 4, where the preview's are 1, 2 and 3. In
 * each, a served insertAll over every top-level relation applies the call, and:
 *
 * - where the preview gives rows and rowEvaluator finds every generated field of them a value, the write is accepted
 *   and each writable relation's stored rows, every field, read as the owner, are the preview's with their generated
 *   fields, as sets;
 * - where a generated field of a preview's row is NULL, which no fill read, the write is refused by that field's law,
 *   which PostgreSQL judges after the statements run;
 * - where the preview refuses the input, the write fails as `input`; where it refuses two rows at one key or a NULL a
 *   fill reads, the write is refused by the same law with the same witness; where it refuses an orphan counted member,
 *   the write is refused by the member's counted family's law among the laws its foreign key carries;
 * - where a row the preview gives is past its domain, rowEvaluator's DomainRefused, the write is refused by that
 *   field's domain law, which PostgreSQL judges once it stores the row: a long label, past Label, and the tag and
 *   width the fresh fill draws from it and copies to its dabs, the width through a domain cast nested in its
 *   generation, the fill never refusing a drawn value its domain judges.
 *
 * Oracle: PostgreSQL itself, which draws nothing the host does not send and proves every family value of the stored
 * rows by its natives.
 *
 * Features: each of `previewFeatures`, noted where the case reaches it.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	type PreviewFeature,
	previewCase,
	previewFeatures
} from "#test/support/pg/write/preview/preview.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The rows a preview gives are the rows the same insertAll stores, fresh and migrated, and its refusals are the write's. */
export const thePreviewsRowsAreTheRowsTheSameInsertAllStoresFreshAndMigratedAndItsRefusalsAreTheWrites =
	property.explore(caseGen, {
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		situations: previewFeatures satisfies ReadonlyArray<Reached<PreviewFeature>>,
		budget: { runs: 32, steered: 32 },
		check:
			({ caseSubstrate }, c: Case<PreviewFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					previewCase(k, c).pipe(Effect.scoped),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the rows the same insertAll stores, and its refusal, in a fresh installation and in one migrated past a dropped handle"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/preview/preview.test.ts#thePreviewsRowsAreTheRowsTheSameInsertAllStoresFreshAndMigratedAndItsRefusalsAreTheWrites:1fff.4:1.2.0.0.0.0.1.0.0.1.1.0.0.1.0.1.0.2.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"R1, a counted member of R0 that owns R2's counted family: its count n1, drawn on its own row, beside the columns R0's family draws on it",
				since: "2026-11-18"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: "\t\t\t\treturn castExpr(expr.args[0], base)",
				replacement:
					'\t\t\t\tconst coerce = castExpr(expr.args[0], base)\n\t\t\t\treturn (leaves, patterns) => Result.flatMap(coerce(leaves, patterns), (coerced) => coerced === sqlNull ? Result.ok(coerced) : Result.flatMap(membership(coerced, expr.type, patterns), (member) => (member ? Result.ok(coerced) : undefinedAt("contract"))))',
				why: "A domain cast's membership is the evaluation's precondition again: the fresh fill stops on a long label's width, the octets of the label cast into Label, a cast nested in the generation that keeps its node, and the preview and the write refuse the call as input, a refusal naming no law, where PostgreSQL refuses the row by the label's domain law."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					"\t\t\t\treturn (leaves) => {\n\t\t\t\t\tconst read = leaves.column(ref)\n\t\t\t\t\treturn read === undefined ? stop : Result.ok(read)\n",
				replacement:
					'\t\t\t\treturn (leaves, patterns) => {\n\t\t\t\t\tconst read = leaves.column(ref)\n\t\t\t\t\treturn read === undefined ? stop : read === sqlNull ? Result.ok(read) : Result.flatMap(membership(read, expr.type, patterns), (member) => (member ? Result.ok(read) : undefinedAt("contract")))\n',
				why: "A field's domain membership is the evaluation's precondition: the fresh fill stops on a long label, past Label, as it reads it for the tag its dabs copy, and the preview and the write refuse the call as input, a refusal naming no law, where PostgreSQL refuses the row by the label's domain law. (A domain cast its operand's bounds prove holds no cast node, scalar/compute/typing.ts, so the tag reads the label bare and the evaluation's domainCast meets only a literal or a parameter, which never stands past its domain on the host.)"
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\treturn { family: g.key, group, members: g.groups?.get(group) ?? [] }",
				replacement:
					"\t\t\t\t\treturn { family: g.key, group, members: [...(g.groups?.values() ?? [])][0] ?? [] }",
				why: "The host draws every owner's family from the first group's members, so a counted member's owner copies, its tone and lum, and its owner's count and folds come from the wrong owner; the preview gives them and the store refuses the write."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: "\tone: 1n,",
				replacement: "\tone: 2n,",
				why: "The host's count steps two a member, so a count fold's end over one member is one past its members; the preview gives it and PostgreSQL refuses the fold's CHECK."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					'\t\t\treturn row.place.kind !== "member" || row.place.predecessor === undefined\n\t\t\t\t? Result.ok(rule.base)',
				replacement:
					'\t\t\treturn row.place.kind !== "member" || row.place.predecessor === undefined\n\t\t\t\t? Result.ok(row.values.get(rule.to) ?? rule.base)',
				why: "A sequence's first member copies its own source where its predecessor copy has no predecessor, not the axis's start: Stroke's prior at its base is its shade, not a; the preview gives it and PostgreSQL refuses the base."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: "\t\t\treturn drawnValue(row, column, treeOf(row).end)",
				replacement: "\t\t\treturn drawnValue(row, column, treeOf(row).end + 1)",
				why: "A tree node's end is one past its interval's; the preview gives it and PostgreSQL refuses the tree."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\t\t\tfor (const row of sentRows.nested(stratum, relation)) {",
				replacement:
					"\t\t\t\t\t\t\tfor (const row of sentRows.nested(stratum, relation).slice(1)) {",
				why: "The read-out drops the first nested row of each relation a nested write fills, a Stroke, a sequence's member or a tree's root, which the write stores."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\t\tof.set(key, { values: filled, scanned: [] })",
				replacement:
					'\t\t\t\t\t\tof.set(key, { values: filled.map((v, at) => { const i = judgedOf(relation).layout.key.findIndex((c) => c.type.carrier === "code" && prepared.columns(relation).at(c.key) === at); return i < 0 ? v : key[i] }), scanned: [] })',
				why: "The read-out holds a row's closed-id key field at its key's text, the code its statement sends, in place of its handle: Swatch's hue is a code the installation's codes read as another handle, or none."
			},
			{
				file: "packages/engine/src/program/preview.ts",
				original: "\t\t\tconst orphan = of.find((row) => row.scanned.length > 0)",
				replacement: "\t\t\tconst orphan = of.find((row) => row.scanned.length > 1)",
				why: "A counted member whose owner the call does not insert is not refused: the preview gives a dab whose family the statement would draw past a stored swatch no installation holding no row has, which the store refuses by the family's law."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original:
					"\t\t\t\t\t\t\tfor (const at of taken) {\n\t\t\t\t\t\t\t\tmerged[at] = member[at]\n\t\t\t\t\t\t\t}",
				replacement:
					"\t\t\t\t\t\t\tfor (const [at, value] of member.entries()) {\n\t\t\t\t\t\t\t\tmerged[at] = value\n\t\t\t\t\t\t\t}",
				why: "The read-out takes every value a fresh fill holds of a counted member, its own fields as the call stated them among them, not only the columns its family draws: a member that owns a counted family has its drawn count clobbered back to 0 (the kept case's R1)."
			}
		]
	})
