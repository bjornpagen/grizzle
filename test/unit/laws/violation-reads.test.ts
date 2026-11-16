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
 * plainly is exact: the check is a Validate step (deploy/diff/diff.ts ruleChecks), after validate.attach in the one
 * Validate transaction (deploy/diff/plan.ts slots, slotFile), where a key over a table that may hold rows is attached
 * to the unique index Indexes built, and before which every other key stands (diff.ts ownConstraint). The second box,
 * exhausted, drafts a migration adding the rule from a version without it, A's key kept, widened from (id) to (id, k),
 * or moved to (k, a), with or without M's negated arm. The oracle is the plan itself: each check is in Validate, and
 * every step that attaches a primary key to a table the check reads runs before it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import {
	caseGen,
	type Feature,
	keyedBy,
	migrationCaseGen,
	type MigrationFeature,
	negations,
	schemaOf,
	tableKey,
	tableReads,
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

/** A law's full violation query runs each rule's check in Validate, after every primary key of a table it reads is attached. */
export const aLawsFullViolationQueryRunsEachRulesCheckInValidateAfterEveryPrimaryKeyOfATableItReadsIsAttached =
	property.exhaust(finite(migrationCaseGen), {
		needs: {},
		situations: [
			"a key kept",
			"a key attached before the check",
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
				const steps = defined(drafted[1], "the second migration").plan.steps
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
					for (const { j } of attaching) {
						assert.ok(j < i, "a primary key of a table the check reads, attached before it")
						if (steps[j]?.slot === "validate.attach") {
							k.note("a key attached before the check")
						}
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
			name: "the plan's own steps: each check in Validate, after every primary key attached to a table it reads"
		},
		box: "a migration adding a rule of J = A ⋈ B into M of one arm or of two, A's key kept, widened or moved",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/plan.ts",
				original: '\t"validate.attach",\n\t"validate",',
				replacement: '\t"validate",\n\t"validate.attach",',
				why: "Validate's checks run before its keys are attached; it fails the second box."
			}
		]
	})
