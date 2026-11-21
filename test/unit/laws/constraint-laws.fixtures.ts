/** What constraint-laws.test.ts reads: its schema in each statement order, its artifacts and a refusal of a constraint. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { installationWitness } from "#adapter/served/refusals.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { type GeneratedLawId, type LawId, StoredRelationName } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	counted,
	f,
	fin,
	fold,
	on,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/**
 * A counted family whose owner also folds its members' count (README: counted, fold): the key index that numbers each
 * owner's members serves the counted law and the fold's, as qti's site_target does, so one constraint serves two laws.
 */
const statements = [
	counted(on("Member", ["owner"]), fin("Owner", "n")),
	fold(fin("Owner", "n"), "count", on("Member", ["owner"]), on("Owner", ["id", "size"]))
] as const

/** The schema with its statements in `order`: as written, or reversed. */
const schemaIn = (order: StatementOrder): SchemaDesc => ({
	name: "Counted",
	relations: [
		relation("Owner", { id: f.bigint, n: f.drawn, size: f.accumulated(f.natural, 0n) }, ["id"]),
		relation("Member", { id: f.bigint, owner: f.bigint }, ["id"])
	],
	statements: order === "as written" ? [...statements] : Arr.reverse([...statements]),
	bases: []
})

/** The orders the schema states its statements in. */
export type StatementOrder = "as written" | "reversed"

export const statementOrderGen: Gen<StatementOrder> = element(["as written", "reversed"] as const)

/** The schema's artifacts in `order`, under the test's naming. */
export const artifactsIn = (order: StatementOrder): SchemaArtifacts =>
	succeeded(testArtifacts(schemaIn(order), testCompile))

/** A table constraint's entries of the model, by its owner and name: every entry PostgreSQL reports under it. */
export const constraintEntriesByName = (
	artifacts: SchemaArtifacts
): ReadonlyMap<
	string,
	ReadonlyArray<Extract<ConstraintLaw, { readonly kind: "constraint" | "trigger" }>>
> => {
	const byName = new Map<
		string,
		Array<Extract<ConstraintLaw, { readonly kind: "constraint" | "trigger" }>>
	>()
	for (const c of artifacts.constraintLaws) {
		if (c.kind === "constraint" || c.kind === "trigger") {
			const key = `${c.owner} ${c.name}`
			byName.set(key, [...(byName.get(key) ?? []), c])
		}
	}
	return byName
}

/** The laws of a table constraint's entries, each once, in code point order: what a refusal of it names. */
export const lawsServed = (
	entries: ReadonlyArray<Extract<ConstraintLaw, { readonly kind: "constraint" | "trigger" }>>
): ReadonlyArray<LawId> =>
	Arr.sort(
		Arr.dedupe(Arr.flatMap(entries, (c) => Arr.map(c.laws, (l) => l.law))),
		(a: LawId, b: LawId) => (a < b ? -1 : a > b ? 1 : 0)
	)

/** A statement writing every relation of the schema, whose host judges nothing: a refusal names what PostgreSQL's
 * object serves. */
const writingAll = (relations: ReadonlyArray<StoredRelationName>): WrittenAt => ({
	relations,
	judge: () => ({ witness: { kind: "unreported" }, laws: { kind: "object" } }),
	above: () => ({ own: "unjudged" })
})

/**
 * The laws the installation's classifier names for a unique violation PostgreSQL reports on `constraint` of `table`,
 * by identity, in the refusal's order; none where it names no law.
 */
export const refusedIds = (
	artifacts: SchemaArtifacts,
	table: string,
	constraint: string
): ReadonlyArray<LawId | GeneratedLawId> => {
	const classify = installationWitness(artifacts, noLevelAbove).classify
	const outcome = classify(
		serverError({
			...nothingReported,
			sqlstate: sqlstates.uniqueViolation,
			schema: artifacts.names.schema,
			table,
			constraint
		}),
		writingAll([StoredRelationName("Owner"), StoredRelationName("Member")])
	)
	if (outcome?.kind !== "rejected") {
		return []
	}
	return Arr.map(refusedEntries(outcome.refused), (l) => l.id)
}
