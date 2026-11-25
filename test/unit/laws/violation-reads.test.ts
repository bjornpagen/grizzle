/**
 * What a law's check over every row reads, as deploy/snapshot/violation.ts lawChecks gives it: a rule's, the judge of
 * the transaction that writes every row into an installation that holds none (physical/ddl/rules.ts addRules), one
 * chain of steps from its region (analysis/theory/navigate.ts), each a lookup of one stored table by what the steps
 * before it bound, read LATERAL, a live derived relation read on its definition; and a law over closed relations alone
 * no table at all, so the
 * setup-phase checks of a migration (diff.ts migrationChecks), which only such laws hold, print the same whatever a
 * table read prints.
 *
 * edullm's QTI identity migration drafted its check of LomObjectTitle with every stored relation read through SELECT
 * DISTINCT over every column, and follow-up 4's binding-fit checks read BindingBaseTypeNode's DeclarationName and
 * TypedDeclarationName each as a query of its own, derived whole and joined to the bound variables by PostgreSQL's
 * estimates: 102 rows estimated of 61,093, a nested loop that threw 1,165,329,900 pairs away, 193 s and 161 s of an
 * 801.8 s window over zero violations. A chain's lookups are bound by the rows it reads, whatever PostgreSQL
 * estimates.
 *
 * The box, exhausted: stored relations A(id, k, a), B(id, k, b) and T(a, b); a rule over a query whose source is A's
 * facts of a nonzero a, the join J = A ⋈ B on k, or JJ = J ⋈ T, a definition reading a definition, and whose target is M, B's (k, b) whose b is a T row's a, with or
 * without a second arm, B's (k, b) whose b is no T row's a, a negation; beside closed relations TierRank and TierNext
 * and a containment between them alone. The oracle is the installation's own names of the stored tables
 * (PhysicalNames.relation) and the shape of a chain: every table a rule's check reads is a stored one, and no core of it joins a source to the ones before it uncorrelated (looseJoins); and a migration check reads no
 * table.
 *
 * Features: a stored table read; a negated arm; a definition reading a definition; a join; a migration check.
 *
 * Where a migration runs a rule's check, every table it reads holds its target primary key: the check is a Validate step
 * (deploy/diff/diff.ts ruleChecks), after the unique index Indexes built for a key over a table that may hold rows,
 * which enforces the key from then, and before which every other key stands (diff.ts ownConstraint); the key's
 * constraint is attached to that index in Publish (deploy/diff/plan.ts slots, slotFile), whose ACCESS EXCLUSIVE no long
 * check runs under. The second box, exhausted, drafts a migration adding the rule from a version without it, A's key
 * kept, widened from (id) to (id, k), or moved to (k, a), with or without M's negated arm. The oracle is the plan
 * itself: each check is in Validate, every primary key a step attaches to a table the check reads has its unique index
 * built before the check, and no statement that takes ACCESS EXCLUSIVE, by PostgreSQL's documented lock of each
 * command (blocksReads), precedes a check in its transaction, so the app reads every table while the checks read every
 * row.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
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
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedStatementsOf } from "#test/support/judge.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import {
	blocksReads,
	caseGen,
	chainReads,
	type Feature,
	firstRead,
	imageCaseGen,
	imageExpected,
	type ImageFeature,
	imageFeatureOf,
	imageSchemaOf,
	keyedBy,
	migrationCaseGen,
	type MigrationFeature,
	negations,
	orderCaseGen,
	orderExpected,
	type OrderFeature,
	orderFeatureOf,
	orderSchemaOf,
	schemaOf,
	tableKey,
	aggregatesBeside,
	looseJoins,
	tableReads,
	type UnitFeature,
	unboundSteps,
	uniquelyIndexedBy,
	unitCaseGen,
	unitFeatureOf,
	unitSchemaOf,
	versionsOf
} from "#test/unit/laws/violation-reads.fixtures.ts"

/** The installation `schema` compiles to, every option at its default. */
const installed = (schema: AnySchema) => {
	const owned = succeeded(own(defined(schemaDescOf(schema), "the case's description")))
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		)
	)
}

/** A rule's check over every row reads each stored table in one chain of lookups, and a law over closed relations no table. */
export const aRulesCheckOverEveryRowReadsEachStoredTableNeverAViewInOneChainOfLookupsAndALawOverClosedRelationsNoTable =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"a stored table read",
			"a negated arm",
			"a definition reading a definition",
			"a join",
			"a migration check"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const installation = installed(schemaOf(c))
				const stored = new Set(
					Arr.map(["A", "B", "T"], (name) => tableKey(installation.names.relation(name)))
				)
				const checks = lawChecks(installation)
				assert.equal(checks.rules.length, 1, "the case's one rule over a query")
				for (const rule of checks.rules) {
					const reads = tableReads(rule.query)
					for (const table of reads) {
						assert.ok(stored.has(table), `${table}, a stored table`)
						k.note("a stored table read")
					}
					const names = new Set(reads)
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
						looseJoins(rule.query),
						0,
						"no core of the check joins a source to the ones before it uncorrelated"
					)
					if (c.source === "nested") {
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
			name: "the installation's own names of the stored tables, and the shape of a chain of steps: no source joined uncorrelated"
		},
		box: "a rule over a query from A's selected facts, J = A ⋈ B or JJ = J ⋈ T, into M of one arm or of two, one negated, beside a law over closed relations alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original: "\t\t\t\tquery: defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				replacement:
					"\t\t\t\tquery: checkOf(installation, violations, r.law.id).query ?? defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				why: "A rule's check is its violation query lowered by the oracle baseline again, each definition a query of its own joined to the level that reads it by PostgreSQL's estimates, as follow-up 4's binding-fit checks were; it fails the first box by its loose joins."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\t\t\tnavigateQuery(\n\t\t\t\t\tquery,\n\t\t\t\t\tloc,\n\t\t\t\t\tcolumns,\n\t\t\t\t\t{ kind: "perStatement", extent },\n\t\t\t\t\tnew Navigation(b.model.theory.regionFacts)\n\t\t\t\t),\n',
				replacement: "\t\t\t\tquery,\n",
				why: "The judge reads its queries as written, a join of every relation a probe reads, which PostgreSQL may plan as a product it filters; it fails the first box by its loose joins."
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
							? new Set(tableReads(step.draft.query))
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

/**
 * A unit-local rule's judge and its check over every row read each stored table by the columns the steps before it
 * bound, an aggregate's import and a negated union as much as a rule's own matches: a key of Known's document, kind and
 * base, whose violation counts Known's facts per key, an aggregate over the join of Op and two reads of Item, walks Op,
 * then Item at the op's (doc, at), then Item at the item's (doc, parent), each a lookup of its full key, as a check over
 * the join does; and Known's selection contained in Two's at kind 1, a derived relation of two rules over ops, a query
 * of the same join, the first fixing kind at 1, negates each rule as a chain of lookups from the (doc, at) it is
 * filtered at, as does Either, one rule over either, a query of Op's and Item's rows, contained in it, a rule over
 * a union, at any depth of one-rule imports, read as its conjunctions; and Known's selection contained in One's at
 * kind 1, ops read once at kind 1, inlined at its one read, the selection's `kind = 1` a condition of the term that
 * defines One's kind. Never is a relation read whole for
 * the document and joined to the others by PostgreSQL's estimates, which follow-up 4's known_operand_base_key, reading
 * Expression twice inside its count, and expression_node_in_unknown_operand_base, negating UnknownOperandBase's two
 * rules over the operands' join, were. And the key's count is computed at its judged region row's document alone
 * (analysis/theory/navigate.ts boundInside, the match's bindings held inside the aggregate's import), never again for
 * every document the transaction wrote at each row of the region, which only then keeps the row's own: a judge of U
 * documents computed U² counts, every step of each still a lookup by what the steps before it bound.
 */
export const aUnitLocalRulesJudgeAndCheckReadEachStepByWhatTheStepsBeforeItBoundAnAggregatesImportAndANegatedUnionAsMuchAsItsOwnMatches =
	property.exhaust(finite(unitCaseGen), {
		needs: {},
		situations: [
			"a key's count over a join",
			"a check over a join",
			"a join contained in a union of joins",
			"a union contained in a union of joins",
			"a join contained in a join read once",
			"a judged statement"
		] satisfies ReadonlyArray<Reached<UnitFeature>>,
		check: (_, k: CaseOf<UnitFeature>) => (c) =>
			Effect.sync(() => {
				const installation = installed(unitSchemaOf(c))
				const stored = new Set(
					Arr.map(["Op", "Item"], (name) => tableKey(installation.names.relation(name)))
				)
				const checks = lawChecks(installation)
				assert.equal(checks.rules.length, 1, "the case's one rule over a query")
				for (const rule of checks.rules) {
					assert.equal(
						looseJoins(rule.query),
						0,
						"no core of the check over every row joins a source to the ones before it uncorrelated"
					)
					assert.equal(
						unboundSteps(rule.query, stored),
						0,
						"every step of the check over every row but its region's looks its table up by a value before it"
					)
					k.note(unitFeatureOf(c))
				}
				const judged = judgedStatementsOf(installation)
				assert.ok(judged.length > 0, "the rule's judged statements")
				for (const statement of judged) {
					assert.equal(
						looseJoins(statement.query),
						0,
						"no core of a judged statement joins a source to the ones before it uncorrelated"
					)
					assert.equal(
						unboundSteps(statement.query, stored),
						0,
						"every step of a judged statement but its region's looks its table up by a value before it"
					)
					assert.equal(
						aggregatesBeside(statement.query),
						0,
						"no aggregate of a judged statement is computed again for each row of a source beside it, its import read at its region row's unit alone"
					)
					k.note("a judged statement")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the shape of a chain of steps (analysis/theory/navigate.ts): every source after a core's first a LATERAL lookup by what the steps before it bound"
		},
		box: "a key of Known(doc, kind, base), a check of its base, or a selection of it or Either, one rule over a query of two over Op and Item, contained in Two's at kind 1, of two rules over ops = Op ⋈ Item ⋈ Item, the first fixing kind at 1, or a selection of Known contained in One's at kind 1, ops read once at kind 1, Known = Op ⋈ Item ⋈ Item, Op and Item immutable and keyed by their document first, so the rule is unit-local",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst query = navigatedQuery(inside.query, loc, columns, sharing, interned)",
				replacement: "\t\tconst query = inside.query",
				why: "An aggregate's import is read as written, Known's join of Op and Item a core of three sources, which PostgreSQL joins by its estimates; it fails the key's case."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst inside = boundInside(source, m.bindings, fixed, columns)",
				replacement: "\t\tconst inside = source",
				why: "An aggregate's import is navigated apart from the unit its groups are bound to: the judged statement computes Known's count over the key set of every unit the transaction wrote at each row of its region and keeps the row's unit after, U units' imports at each of U rows, every step still a lookup by what the steps before it bound; it fails the key's case."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\treturn (term) => (term.kind === "var" ? fixed(term.var) : isFixed(term) ? term : undefined)',
				replacement:
					'\treturn (term) => (term.kind === "var" ? undefined : isFixed(term) ? term : undefined)',
				why: "A variable the aggregate's rule equates with the unit's channel is no fixed term, so the unit stops at the aggregate's rule and its import's chain reads every Op row once per unit; it fails the key's case."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\treturn { one, most, every, filtersJoin }",
				replacement: "\treturn { one, most: one, every: one, filtersJoin }",
				why: "A filter of a rule over an import of several rules is read as written, Two's two rules over ops each a core of the three reads ops joins, derived whole and anti-joined to Known by PostgreSQL's estimates; it fails the containment's case."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\t\tif (v.kind !== "var" || isBare(term) || readsOf(term).has(v.var)) {',
				replacement: '\t\t\tif (v.kind !== "var" || readsOf(term).has(v.var)) {',
				why: "A bare literal defines a variable: navigation replaces the selection's kind by the 1 its `kind = 1` states, so One's own `kind = 1`, over ops inlined at its one read, reads 1 = 1, two bare literals the checker refuses, and the schema does not compile, as qti's \"Item ref target\" over select(ItemRefTarget, type = item) did not; it fails the case of a containment in One. Two's first rule reads ops twice, so navigation holds ops whole and Two's kind is that read's own, which no literal defines."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tif (!splits(rule) || !someConjunctionJoins(interned.reads(rule))) {",
				replacement: "\t\t\tif (true || !someConjunctionJoins(interned.reads(rule))) {",
				why: "A rule over Either, a union of Op's and Item's rows, is read as written beside its negation of Two, which is derived whole and anti-joined to it; it fails the union's case."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\t\t(n, arm) => (arm.most === undefined ? n : Math.max(n ?? arm.most, arm.most)),",
				replacement:
					"\t\t\t\t(n, arm) => (arm.one === undefined ? n : Math.max(n ?? arm.one, arm.one)),",
				why: "Conjunctions split an import of several rules matched directly alone, so Either, one rule over the query either of two, is no union to them, and its rule is read as written beside its negation of Two; it fails the union's case."
			}
		]
	})

/**
 * A rule's check over every row starts its chain at a read contained in another that reads every row of its relation:
 * Marked, Item joined to Rare at (doc, at), reads Rare first where the schema states Rare's rows contained in Item's at
 * its key, over every row, and the rule reads every item, each rare mark beside an item the chain reads, whichever its
 * rule matches first; and the first declared where it states none, one over a selection of Rare alone, which says
 * nothing of the rows outside it, or one at fields of Rare the rule binds to no variable of Item's, or where the rule
 * reads Item at a literal or beside a condition of its own, which may leave fewer items than marks: qti's `q` elements
 * are few, every node's first child many. With no statistics PostgreSQL plans each step of the chain as it stands, so a
 * chain that starts at the first declared of two reads alike reads every item where the few rare marks would do, as
 * follow-up 4's checks over a field's typed value beside its node read every node (field_value_text_check, 7.8 ms
 * drafted, 1,459 ms navigated, VALIDCOST's job 8).
 */
export const aRulesCheckOverEveryRowStartsAtAReadContainedInAnother = property.exhaust(
	finite(orderCaseGen),
	{
		needs: {},
		situations: [
			"a read contained in another, declared after it, first",
			"a read contained in another, declared first, first",
			"a containment into a read a literal restricts, the first declared first",
			"a containment into a read a condition restricts, the first declared first",
			"no containment, the first declared first",
			"a containment over a selection, the first declared first",
			"a containment at other fields, the first declared first"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, k: CaseOf<OrderFeature>) => (c) =>
			Effect.sync(() => {
				const installation = installed(orderSchemaOf(c))
				const checked = Arr.filter(lawChecks(installation).rules, (r) => r.meaning === "defined")
				assert.equal(checked.length, 1, "the box's one check over a query, Marked's")
				for (const rule of checked) {
					assert.equal(
						firstRead(rule.query),
						tableKey(installation.names.relation(orderExpected(c))),
						"the chain's first read"
					)
				}
				k.note(orderFeatureOf(c))
			}),
		oracle: {
			kind: "specification",
			name: "the containments the schema states: the read contained in another over every row at the variables both bind first, else the first declared"
		},
		box: "Marked = Item ⋈ Rare at (doc, at), either matched first, Item read whole, at a literal or beside a condition of its own, Rare contained in Item at its key over every row, over a selection, at other fields, or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\t\t\t(!this.#interned.narrower(held, at) &&\n\t\t\t\t\t\tthis.#interned.within(r, current) &&\n\t\t\t\t\t\treadsAll(current, values, seeks))",
				replacement: "\t\t\t\t\tfalse",
				why: "A chain starts at the first declared of two reads alike, Item, every item read where Rare's few marks, each beside an item, would do; it fails the case of Item read whole and matched first beside Rare contained in it."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tfacts.containments.filter((c) => c.selection.length === 0),",
				replacement: "\t\t\tfacts.containments,",
				why: "A containment over a selection orders a chain over every row of its source, as if each row outside the selection were beside a row of the target; it fails the case of a selection of Rare contained in Item."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\t\t\t\treturn x?.kind === "var" && y?.kind === "var" && x.var === y.var',
				replacement: "\t\t\t\t\treturn true",
				why: "A containment orders a chain whatever its fields bind, so Rare at (doc, mark), which the rule reads beside no item at mark, goes before Item; it fails the case of a containment at other fields."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\t\t\t\tthis.#interned.within(r, current) &&\n\t\t\t\t\t\treadsAll(current, values, seeks))",
				replacement: "\t\t\t\t\t\tthis.#interned.within(r, current))",
				why: "A read contained in another goes first however the rule restricts the other, so Rare goes before Item read at a parent literal, as qti's every first child went before its few `q` elements (quotation_end's third rule); it fails the cases of Item read at a literal or beside a condition."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\t\t\t\te.kind !== "var" ||\n',
				replacement: "",
				why: "A literal binding counts as a variable of the read's own, so Item read at a parent literal reads every row of it, and Rare goes first; it fails the case of Item read at a literal."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\treturn pending.every((c) => ![...readsOf(c)].every((id) => own.has(id) || known.has(id)))",
				replacement: "\t\t\treturn true",
				why: "A condition of the read's own variables restricts nothing, so Item beside a condition of its kind reads every row of it, and Rare goes first; it fails the case of Item beside a condition."
			}
		]
	}
)

/**
 * A chain reads first, of two lookups, the one the schema's keys and containments order first, whatever their
 * declared order and however many columns each is keyed by: a lookup bound at its relation's key, one row at most;
 * else, of two relations one is contained in over every row at the variables both reads bind, the contained read keyed
 * at more columns than its image in the container, which it reads no more rows than, or the container's lookup keyed at
 * more columns than the contained read's image, which narrows the container's rows that hold the contained read's. The image box is qti's walk from a placed reference: Expr, the expressions of
 * its placement, keyed at three columns (doc, asm, inst) and contained in Element at (doc, at), whose image there is
 * (doc) alone, every expression of the document; Element at (doc, parent), the reference's children, keyed at two. By
 * the count of keyed columns the chain read every expression of the item beside each reference (edullm's _08e9e8ae:
 * 33.6 M pairs at 42 items, three statements of 112 to 134 M buffer hits, 364 s of its COMMIT); and walking up, at
 * Element's key (doc, at) the reference's own place, every expression of the item beside each operand (the giant's
 * known operand keys). The order is read off the schema's statements alone, never an estimate, with statistics or none.
 */
export const aChainReadsFirstTheLookupTheSchemasKeysAndContainmentsOrderFirst = property.exhaust(
	finite(imageCaseGen),
	{
		needs: {},
		situations: [
			"an expression's children before its item's expressions, by the containment's image, declared after",
			"an expression's children before its item's expressions, by the containment's image, declared first",
			"an operand's element by its key before its item's expressions, declared after",
			"an operand's element by its key before its item's expressions, declared first",
			"the item's expressions first, more columns keyed, with no containment",
			"the item's expressions first, more columns keyed, beside a containment over a selection",
			"the item's expressions first, more columns keyed, beside a containment at other fields",
			"the item's expressions first, more columns keyed, beside a containment whose image leaves a key field apart"
		] satisfies ReadonlyArray<Reached<ImageFeature>>,
		check: (_, k: CaseOf<ImageFeature>) => (c) =>
			Effect.sync(() => {
				const installation = installed(imageSchemaOf(c))
				const checked = Arr.filter(lawChecks(installation).rules, (r) => r.meaning === "defined")
				assert.equal(checked.length, 1, "the box's one check over a query, Placed's")
				for (const rule of checked) {
					assert.deepEqual(
						chainReads(rule.query),
						[
							tableKey(installation.names.relation("Ref")),
							...(imageExpected(c) === "Element"
								? [
										tableKey(installation.names.relation("Element")),
										tableKey(installation.names.relation("Expr"))
									]
								: [
										tableKey(installation.names.relation("Expr")),
										tableKey(installation.names.relation("Element"))
									])
						],
						"the chain's reads, in its order"
					)
				}
				k.note(imageFeatureOf(c))
			}),
		oracle: {
			kind: "specification",
			name: "the keys and containments the schema states: a lookup bound at its relation's key first; else, under a containment over every row at the variables both reads bind whose source's key is among its bound columns and the containment's fields, the lookup keyed at more columns than the other's image; else the one keyed at more columns"
		},
		box: "Placed = Ref at kind 1 ⋈ Expr of its placement ⋈ Element linking them, down to the reference's child or up to its parent at its own place, Expr and Element matched in either order after Ref, Expr contained in Element at (doc, at) over every row, over a selection, at (doc, inst), at (doc) alone, or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\treturn this.#ordered(a, b) ?? counted(a, b)",
				replacement: "\t\treturn counted(a, b)",
				why: "The count of keyed columns orders the chain again: Expr, keyed at (doc, asm, inst), goes before Element at (doc, parent) and before Element at its key, every expression of the item read beside each reference; it fails every case that walks up, and the cases that walk down under the containment over every row."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\tconst unique = this.#unique(a)\n\t\tif (unique !== this.#unique(b)) {\n\t\t\treturn unique\n\t\t}\n",
				replacement: "",
				why: "A lookup bound at its relation's key is no narrower than one keyed at more columns: walking up, Expr goes before Element at the reference's own place; it fails the cases that walk up."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\treturn keys.some((key) => key.every((f) => x.bound.has(f) || paired.has(f)))",
				replacement: "\t\t\treturn true",
				why: "A containment images a lookup whose rows its fields do not tell apart: Expr at (doc) alone leaves its place apart, many expressions beside one element, and Element goes before Expr all the same; it fails the case of a containment whose image leaves a key field apart."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tthis.#imagesOf(b, a).some((image) => holdsMore(a.keyed, image))",
				replacement: "\t\t\tfalse",
				why: "Only the contained lookup is ever ordered first by a containment: Element at (doc, parent), keyed at more than Expr's image (doc), is not, and Expr goes first again; it fails the cases that walk down under the containment over every row."
			}
		]
	}
)
