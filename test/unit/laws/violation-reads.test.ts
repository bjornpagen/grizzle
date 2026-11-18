/**
 * What a law's full violation query reads, as deploy/snapshot/violation.ts lawChecks lowers it: each stored relation's
 * table plainly, under its primary key's proof (lower/conservative/base/index.ts readsKeyedTable), never through
 * SELECT DISTINCT over it, so PostgreSQL flattens the table into the join that reads it and probes it by its indexes;
 * each derived relation as its definition, live, a query of its own (analysis/theory/query.ts violationQuery), so each
 * join PostgreSQL plans is one definition's own; and a law over closed relations alone no table at all, so the
 * setup-phase checks of a migration (diff.ts migrationChecks), which only such laws hold, print the same whatever a
 * table read prints.
 *
 * edullm's QTI identity migration drafted its check of LomObjectTitle with every stored relation read through SELECT
 * DISTINCT over every column: PostgreSQL planned one HashAggregate per table, no index, every multi-column join
 * estimated at one row, and the check ran past twelve minutes over tables of thousands of rows.
 *
 * The box, exhausted: stored relations A(id, k, a), B(id, k, b) and T(a, b); a rule over a query whose source is A's
 * facts of a nonzero a, the join J = A ⋈ B on k, the facts of a materialized derived relation V = A ⋈ B, or JJ = J ⋈ T
 * or VV = V ⋈ T, a definition reading a definition, and whose target is M, B's (k, b) whose b is a T row's a, with or
 * without a second arm, B's (k, b) whose b is no T row's a, a negation read by NOT EXISTS; beside closed relations
 * TierRank and TierNext and a containment between them alone. The oracle is the installation's own names of the stored
 * tables (PhysicalNames.relation) and the box's own definitions: every table a violation query reads is a stored one,
 * read by a core with no DISTINCT under the proof `keyed`, and never V's view, since a rule judges a derived relation
 * on its definition, live, which the migration that checks it may not have filled; no core of it joins more sources
 * than the widest rule of a definition it reads, each definition a query of its own, so PostgreSQL plans no join of
 * every relation the definitions read together; and a migration check reads no table.
 *
 * Features: a stored table read plainly; a negated arm; a definition reading a definition; a join; a migration check.
 *
 * Where a migration runs a rule's check, every table it reads holds its target primary key, which is why reading it
 * plainly is exact: the check is a Validate step (deploy/diff/diff.ts ruleChecks), after the unique index Indexes built
 * for a key over a table that may hold rows, which enforces the key from then, and before which every other key stands
 * (diff.ts ownConstraint); the key's constraint is attached to that index in Publish (deploy/diff/plan.ts slots,
 * slotFile), whose ACCESS EXCLUSIVE no long check runs under. The second box, exhausted, drafts a migration adding the
 * rule from a version without it, A's key kept, widened from (id) to (id, k), or moved to (k, a), with or without M's
 * negated arm. The oracle is the plan itself: each check is in Validate, every primary key a step attaches to a table
 * the check reads has its unique index built before the check, and no statement that takes ACCESS EXCLUSIVE, by
 * PostgreSQL's documented lock of each command (blocksReads), precedes a check in its transaction, so the app reads
 * every table while the checks read every row.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import {
	blocksReads,
	caseGen,
	type Feature,
	keyedBy,
	migrationCaseGen,
	type MigrationFeature,
	negations,
	schemaOf,
	tableKey,
	tableReads,
	uniquelyIndexedBy,
	versionsOf,
	widestJoin,
	widestRule
} from "#test/unit/laws/violation-reads.fixtures.ts"

/** A law's full violation query reads each stored table plainly under its key, never a view, each definition at a level of its own, and a law over closed relations no table. */
export const aLawsFullViolationQueryReadsEachStoredTablePlainlyUnderItsKeyNeverAViewEachDefinitionAtALevelOfItsOwnAndALawOverClosedRelationsNoTable =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"a stored table read plainly",
			"a negated arm",
			"a definition reading a definition",
			"a join",
			"a migration check"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const owned = succeeded(own(defined(schemaDescOf(schemaOf(c)), "the case's description")))
				const installation = succeeded(
					compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[],
							[],
							firstCodebook(rostersOf(owned))
						)
					)
				)
				const stored = new Set(
					Arr.map(["A", "B", "T"], (name) => tableKey(installation.names.relation(name)))
				)
				const checks = lawChecks(installation)
				assert.equal(checks.rules.length, 1, "the case's one rule over a query")
				for (const rule of checks.rules) {
					const reads = tableReads(rule.query)
					for (const r of reads) {
						assert.ok(stored.has(r.table), `${r.table}, a stored table, and no view`)
						assert.equal(r.read, "keyed", `${r.table}, a stored table, read plainly`)
						k.note("a stored table read plainly")
					}
					const names = new Set(Arr.map(reads, (r) => r.table))
					if (
						names.has(tableKey(installation.names.relation("A"))) &&
						names.has(tableKey(installation.names.relation("B")))
					) {
						k.note("a join")
					}
					if (negations(rule.query) > 1) {
						k.note("a negated arm")
					}
					assert.equal(
						widestJoin(rule.query),
						widestRule,
						"the widest join of the check, the widest rule of a definition it reads"
					)
					if (c.source === "nested" || c.source === "nested view") {
						k.note("a definition reading a definition")
					}
				}
				assert.equal(
					checks.migrations.length,
					1,
					"a law over closed relations alone, checked by the migration"
				)
				for (const m of checks.migrations) {
					assert.deepEqual(tableReads(m.query), [], "a migration check reads no table")
					k.note("a migration check")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the installation's own names of the stored tables, and the widest rule of the box's definitions"
		},
		box: "a rule over a query from A's selected facts, J = A ⋈ B, the materialized V = A ⋈ B, JJ = J ⋈ T or VV = V ⋈ T, into M of one arm or of two, one negated, beside a law over closed relations alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/base/index.ts",
				original: "\treturn readsKeyedTable(node, cx)",
				replacement: "\treturn readsKeyedTable(node, cx) && false",
				why: "The violation probe reads every stored table through SELECT DISTINCT again, as edullm's migration was drafted; it fails the first box."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\tmatch: { source: liveSource(side.relation, definition), bindings: bound, loc },",
				replacement:
					"\t\tmatch: {\n\t\t\tsource: imported(\n\t\t\t\tmapNonEmpty(side.arms, (a) =>\n\t\t\t\t\truleDesc(a.vars, a.matches.map(matchDesc), conditionsOf(a, loc), a.head, loc)\n\t\t\t\t),\n\t\t\t\tloc\n\t\t\t),\n\t\t\tbindings: bound,\n\t\t\tloc\n\t\t},",
				why: "A side is read as its arms, every definition inlined into one join; it fails the first box by its widest join."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\treturn liveSource(s.name, definition)",
				replacement: "\t\t\t\treturn s",
				why: "A materialized derived relation is read through its view; it fails the first box by the view it reads."
			}
		]
	})

/** A law's full violation query runs each rule's check in Validate, after every primary key of a table it reads is enforced by its unique index. */
export const aLawsFullViolationQueryRunsEachRulesCheckInValidateAfterEveryPrimaryKeyOfATableItReadsIsEnforcedByItsUniqueIndex =
	property.exhaust(finite(migrationCaseGen), {
		needs: {},
		situations: [
			"a key kept",
			"a key's index built before the check, attached after it",
			"a check in a transaction no lock blocking a read precedes",
			"a negated arm"
		] satisfies ReadonlyArray<Reached<MigrationFeature>>,
		check: (_, k: CaseOf<MigrationFeature>) => (c) =>
			Effect.sync(() => {
				const [first, second] = versionsOf(c)
				const drafted = draftChain(
					[
						{ desc: first, options: asDrafted, declared: noDeclarations },
						{ desc: second, options: asDrafted, declared: noDeclarations }
					],
					fromEmpty
				)
				const plan = defined(drafted[1], "the second migration").plan
				const steps = plan.steps
				for (const file of planFiles(plan)) {
					const last = Arr.findLastIndex(file.drafts, (d) => d.kind === "violation")
					if (Option.isNone(last)) {
						continue
					}
					assert.deepEqual(
						Arr.filter(Arr.take(file.drafts, last.value), blocksReads),
						[],
						`${file.name}: no statement that blocks a read before its checks`
					)
					assert.ok(
						file.transaction,
						`${file.name}: its checks in one transaction with the laws they check`
					)
					k.note("a check in a transaction no lock blocking a read precedes")
				}
				const checks = Arr.filter(
					Arr.map(steps, (step, i) => ({ step, i })),
					({ step }) => step.draft.kind === "violation"
				)
				assert.equal(checks.length, 1, "the added rule's one check")
				for (const { step, i } of checks) {
					assert.equal(step.slot, "validate", "a rule's check, in Validate")
					const read =
						step.draft.kind === "violation"
							? new Set(Arr.map(tableReads(step.draft.query), (r) => r.table))
							: new Set<string>()
					const attaching = Arr.filter(
						Arr.map(steps, (s, j) => ({ tables: keyedBy(s), j })),
						({ tables }) => Arr.some(tables, (t) => read.has(t))
					)
					for (const { tables, j } of attaching) {
						if (j < i) {
							continue
						}
						assert.ok(
							Arr.some(
								Arr.take(steps, i),
								(s) =>
									s.slot === "indexes.concurrent" &&
									Arr.some(uniquelyIndexedBy(s), (t) => tables.includes(t))
							),
							"a primary key of a table the check reads, attached after it, enforced before it by its unique index"
						)
						k.note("a key's index built before the check, attached after it")
					}
				}
				if (c.key === "kept") {
					k.note("a key kept")
				}
				if (c.negated) {
					k.note("a negated arm")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the plan's own steps: each check in Validate, after every primary key of a table it reads is enforced by its unique index, under no lock that blocks a read; and PostgreSQL's documented lock of each statement"
		},
		box: "a migration adding a rule of J = A ⋈ B into M of one arm or of two, A's key kept, widened or moved",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/plan.ts",
				original: '\t"indexes.concurrent",\n\t"validate",',
				replacement: '\t"validate",\n\t"indexes.concurrent",',
				why: "Validate's checks run before the unique indexes of the keys they read are built; it fails the second box."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					'\t\tthis.sql("publish.attach", [\n\t\t\talter(\n\t\t\t\tt,\n\t\t\t\treplacingOld({\n\t\t\t\t\tkind: "addConstraintUsingIndex",',
				replacement:
					'\t\tthis.sql("validate", [\n\t\t\talter(\n\t\t\t\tt,\n\t\t\t\treplacingOld({\n\t\t\t\t\tkind: "addConstraintUsingIndex",',
				why: "A key's attach USING INDEX, which takes ACCESS EXCLUSIVE, runs in Validate before its checks, so every read of the table waits out every check; it fails the second box."
			}
		]
	})
