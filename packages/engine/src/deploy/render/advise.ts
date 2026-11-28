/**
 * A migration's files bound for the plan advice their transactions run under (CARRY THE PLAN, design point 6): every
 * data step a transactional file drafts, a statement that reads stored rows and a law's violation check, bound against
 * the target installation (sql/bind.ts) under the one advice scope of its file's transaction, each read whole and joined
 * by a hash (`whole`), since a migration runs each step once over every row it reads, a read at the values it fixes
 * sought where an index of the installation serves it (physical/indexes/engine.ts servingOf), since index planning plans
 * a data step no index, else read whole beside its filter; the file's advice the join of its steps' plans (sql/advice.ts
 * transactionAdvice), which meta.json records beside the file's lock demand and the runner sets as its transaction's
 * first statement. Each index a step reads through stands where the step runs, the previous installation's or one a
 * statement of the migration before the step creates (deploy/locks/demand.ts StandingIndexes), or the draft is an
 * internal compiler error: advice naming an index the database does not hold yet plans by none of it. A no-transaction file runs each statement alone and drafts no step that reads stored rows. The runner's own
 * statements, the ledger's rows, are cost-chosen, their target the ledger's own unaliased name, which no scope mints;
 * a reviewer's value of a set-aside field and a consumer's custom migration are no statement grizzle binds.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { LawId } from "#compiler/core/ids.ts"
import type { Draft, MigrationPlan } from "#compiler/deploy/diff/plan.ts"
import type { StandingIndexes } from "#compiler/deploy/locks/demand.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import { violationCheck } from "#compiler/physical/ddl/recheck.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { type Advice, noAdvice, transactionAdvice } from "#compiler/sql/advice.ts"
import type { ObjectName, PlBlock, SqlStatement } from "#compiler/sql/ast.ts"
import { bindBlock, type BoundReads, bindStatement } from "#compiler/sql/bind.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { type ReadPlan, scannedItems } from "#compiler/sql/plan.ts"

/**
 * A draft as its file writes it: a data step bound (see the header) with the plan its advice is printed of, a statement
 * that reads stored rows (`step`) or a law's violation check as the DO block it runs (`violation`); every other draft
 * as the diff drafts it.
 */
export type BoundDraft =
	| Exclude<Draft, { readonly kind: "violation" }>
	| {
			readonly kind: "step"
			readonly statement: SqlStatement
			readonly plan: ReadPlan<AccessIndexRequest>
	  }
	| {
			readonly kind: "violation"
			readonly law: LawId
			readonly block: PlBlock
			readonly plan: ReadPlan<AccessIndexRequest>
	  }

/**
 * A drafted file and what it writes: `file` as the diff drafts it, which the lock model counts and the decision record
 * names; its drafts as it writes them (BoundDraft); and the advice its transaction runs under, none for a file of no
 * data step and for a no-transaction file.
 */
export interface AdvisedFile {
	readonly file: DraftFile
	readonly drafts: ReadonlyArray<BoundDraft>
	readonly advice: Advice
}

/** The reads of a data step bound over `installation` (see the header). */
const stepReads = (installation: Installation): BoundReads => ({
	kind: "whole",
	serves: (request) => installation.serving(request) !== undefined
})

/** Every index request a plan's reads make, in its order. */
const requestsOf = (plan: ReadPlan<AccessIndexRequest>): ReadonlyArray<AccessIndexRequest> =>
	plan.levels.flatMap((level) =>
		scannedItems(level).flatMap((item) => (item.scan.kind === "index" ? [item.scan.index] : []))
	)

/**
 * The indexes a draft's data step reads through, as the installation resolves its reads bound whole (see the header):
 * none for a draft of no data step.
 */
const readThrough = (draft: Draft, installation: Installation): ReadonlyArray<ObjectName> => {
	const plans: Array<ReadPlan<AccessIndexRequest>> = []
	boundDraft(draft, new AdviceScope(), installation, (plan) => plans.push(plan))
	return plans.flatMap(requestsOf).map((r) => installation.resolve(r).name)
}

/** Whether `draft` creates the index `index`: its CREATE INDEX, of a table of its schema. */
const createsIndex = (draft: Draft, index: ObjectName): boolean =>
	draft.kind === "statement" &&
	draft.statement.kind === "createIndex" &&
	draft.statement.name === index.name &&
	draft.statement.table.schema === index.schema

/**
 * The drafter's rule for a data step's indexes: each index a data step reads through is created before the step, its
 * build moved from its later slot to just before the first step that reads through it, a plain CREATE INDEX there,
 * where a transaction holds it (a concurrent build runs in no transaction block), and a concurrent build's DROP INDEX
 * IF EXISTS before it, which makes a rerun of its no-transaction file safe, gone with it, since a transaction's build
 * rolls back whole (deploy/diff/diff.ts buildConcurrently); every other index stays where the diff drafted it, after
 * the data steps, which then write no entry of it as they run, the cheaper order for a bulk write. So no step's advice
 * names an index that does not stand where it runs (advisedFiles).
 */
export const indexesBeforeReaders = (
	plan: MigrationPlan,
	installation: Installation
): MigrationPlan => {
	const steps = [...plan.steps]
	for (let at = 0; at < steps.length; at++) {
		const reader = defined(steps[at], "a step of the plan")
		for (const index of readThrough(reader.draft, installation)) {
			const later = steps.findIndex((s, i) => i > at && createsIndex(s.draft, index))
			if (later < 0) {
				continue
			}
			const before = steps[later - 1]
			const rerunSafe =
				before?.draft.kind === "statement" &&
				before.draft.statement.kind === "dropIndex" &&
				before.draft.statement.ifExists &&
				before.draft.statement.name.name === index.name &&
				before.draft.statement.name.schema === index.schema
			const [creation] = steps.splice(later, 1)
			if (rerunSafe) {
				steps.splice(later - 1, 1)
			}
			const draft = defined(creation, "the step that creates the index").draft
			steps.splice(at, 0, {
				slot: reader.slot,
				draft:
					draft.kind === "statement" && draft.statement.kind === "createIndex"
						? { kind: "statement", statement: { ...draft.statement, concurrently: false } }
						: draft
			})
			at++
		}
	}
	return { ...plan, steps }
}

/**
 * The files of a migration, in their order, bound (see the header) over `installation`, each step's indexes held to
 * `standing`, which learns every draft as it runs.
 */
export const advisedFiles = (
	files: ReadonlyArray<DraftFile>,
	installation: Installation,
	standing: StandingIndexes
): ReadonlyArray<AdvisedFile> =>
	files.map((file) => {
		const scope = new AdviceScope()
		const plans: Array<ReadPlan<AccessIndexRequest>> = []
		/** A step's plan, every index it reads through standing where the step runs. */
		const planned = (plan: ReadPlan<AccessIndexRequest>): void => {
			for (const request of requestsOf(plan)) {
				const index = installation.resolve(request).name
				if (!standing.stands(index)) {
					defect(
						`a data step of ${file.name} reads ${request.relation} through ${index.schema}.${index.name}, which stands only once a later statement of the migration creates it: the drafter orders an index before the first data step that reads through it`
					)
				}
			}
			if (!file.transaction && plan.levels.length > 0) {
				defect(`the no-transaction file ${file.name} drafts a step that reads stored rows`)
			}
			plans.push(plan)
		}
		const drafts = file.drafts.map((draft): BoundDraft => {
			const bound = boundDraft(draft, scope, installation, planned)
			standing.ran(draft)
			return bound
		})
		return {
			file,
			drafts,
			advice: file.transaction ? transactionAdvice(plans, installation.resolve) : noAdvice
		}
	})

/**
 * Whether a drafted statement is a data step, one that reads or writes stored rows (sql/bind.ts binds its reads): a
 * query, a DML statement or a stored table's fill. Every other is DDL, an installed routine among them, bound once
 * already where its installation was compiled (physical/install/compile.ts), or a lock or a role's statement.
 */
const readsRows = (statement: SqlStatement): boolean => {
	switch (statement.kind) {
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "fillStored":
			return true
		case "adoptRole":
		case "alterDefaultPrivileges":
		case "alterDomain":
		case "alterRole":
		case "alterRowType":
		case "alterTable":
		case "beginRead":
		case "beginWrite":
		case "comment":
		case "commit":
		case "createConstant":
		case "createConstraintTrigger":
		case "createJudgeLog":
		case "createDeclaredFunction":
		case "createDomain":
		case "createExtension":
		case "createFunction":
		case "createGuardTrigger":
		case "createImmutableGuardTrigger":
		case "createIndex":
		case "createLiveSecret":
		case "createPolicy":
		case "createPublication":
		case "createRole":
		case "createRowType":
		case "createSchema":
		case "createStoredTable":
		case "createTable":
		case "createTransitionTrigger":
		case "createView":
		case "drop":
		case "dropFunction":
		case "dropIndex":
		case "dropPolicy":
		case "dropPublication":
		case "dropTrigger":
		case "endHolders":
		case "grant":
		case "grantColumns":
		case "grantRole":
		case "guardBracket":
		case "handOverFunction":
		case "lockTable":
		case "packConstant":
		case "rename":
		case "renameColumn":
		case "renameConstraint":
		case "replaceConstant":
		case "revoke":
		case "revokeRole":
		case "rollback":
		case "setConstraintsImmediate":
		case "stubConstant":
			return false
	}
}

/** `draft` as its file writes it, bound under `scope` over `installation`, each plan handed to `planned`. */
const boundDraft = (
	draft: Draft,
	scope: AdviceScope,
	installation: Installation,
	planned: (plan: ReadPlan<AccessIndexRequest>) => void
): BoundDraft => {
	switch (draft.kind) {
		case "statement": {
			if (!readsRows(draft.statement)) {
				return draft
			}
			const bound = bindStatement(
				draft.statement,
				scope,
				installation.catalog,
				stepReads(installation)
			)
			planned(bound.plan)
			return { kind: "step", statement: bound.statement, plan: bound.plan }
		}
		case "violation": {
			const bound = bindBlock(
				violationCheck(draft.law, draft.query),
				scope,
				installation.catalog,
				stepReads(installation)
			)
			planned(bound.plan)
			return { kind: "violation", law: draft.law, block: bound.block, plan: bound.plan }
		}
		case "alteration":
		case "fill":
		case "zones":
		case "loss":
		case "confirm":
			return draft
	}
}
