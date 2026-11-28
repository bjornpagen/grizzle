/** What whole-tables.test.ts reads: its space, the family schemas, their first migration and script, and the judge. */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { noDeclarations } from "#compiler/deploy/diff/plan.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { schema } from "#compiler/public/schema.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import {
	type AlterTableAction,
	type CreateTable,
	type NameKey,
	nameKey,
	type SqlStatement
} from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { admittedFillSpecGen, buildFill, type FillSpec } from "#test/support/families/fill.ts"
import { owning } from "#test/support/policy.ts"

/** The most relations a drawn specification holds. */
const relationsAtMost = 3

/** A family schema the fill reference admits (test/support/families/fill.ts): relations with families, trees, folds and
 * copies between them, whose law columns, drawn and generated, and own keys and CHECKs over them its tables carry. */
export const wholeCaseGen: Gen<FillSpec> = (source) =>
	source.draw(admittedFillSpecGen({ relations: relationsAtMost, families: 3, copies: 2 }))

export type WholeFeature =
	| "a law column in its table's CREATE TABLE"
	| "a key or CHECK in its table's CREATE TABLE"
	| "a foreign key added after every table"

/** The installation of a drawn schema, with no login. */
export const installationOf = (spec: FillSpec): Installation => {
	const built = buildFill(spec)
	const owned = owning(schema("Whole", Rec.values(built.relations), built.statements))
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		)
	)
}

/** Every statement of a plan's steps, each table's alteration as the one ALTER TABLE it runs. */
const statementsOf = (steps: ReturnType<typeof draftMigration>): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(succeeded(steps).plan.steps, (step): ReadonlyArray<SqlStatement> => {
		const d = step.draft
		switch (d.kind) {
			case "statement":
				return [d.statement]
			case "alteration":
				return [{ kind: "alterTable", table: d.table, actions: d.actions }]
			case "fill":
			case "violation":
			case "zones":
			case "loss":
			case "confirm":
				return []
		}
	})

/** What a CREATE TABLE states itself of an ALTER TABLE's subcommand: a column, or a key, exclusion or CHECK added valid. */
const statedInline = (a: AlterTableAction): string | undefined =>
	a.kind === "addColumn"
		? `column ${a.column.name}`
		: a.kind === "addConstraint" && !a.notValid && a.constraint.kind !== "foreignKey"
			? `constraint ${a.constraint.name}`
			: undefined

/** What a CREATE TABLE states: each column, and each constraint, its primary key first. */
const statedBy = (t: CreateTable): ReadonlyArray<string> => [
	...Arr.map(t.columns, (c) => `column ${c.name}`),
	...Arr.map([t.primaryKey, ...t.secondary], (c) => `constraint ${c.name}`)
]

/** The statements of `statements` that create the table `key`. */
const createdIn = (
	statements: ReadonlyArray<SqlStatement>,
	key: NameKey
): ReadonlyArray<CreateTable> =>
	Arr.flatMap(statements, (s) => (s.kind === "createTable" && nameKey(s.table) === key ? [s] : []))

/** The subcommands of every ALTER TABLE of the table `key` among `statements`. */
const alterationsOf = (
	statements: ReadonlyArray<SqlStatement>,
	key: NameKey
): ReadonlyArray<AlterTableAction> =>
	Arr.flatMap(statements, (s) =>
		s.kind === "alterTable" && nameKey(s.table) === key ? s.actions : []
	)

/** What a CREATE TABLE states of `actions` (statedInline). */
const statedOf = (actions: ReadonlyArray<AlterTableAction>): ReadonlyArray<string> =>
	Arr.flatMap(actions, (a) => {
		const stated = statedInline(a)
		return stated === undefined ? [] : [stated]
	})

/**
 * Judges a drawn schema's first migration, drafted from nothing, and its installation's script: each creates every table
 * by one CREATE TABLE, the same statement in both, that states exactly what the installation's objects state of the
 * table, its table object's CREATE TABLE and every ALTER TABLE of its objects after it, each law column and own
 * constraint its own object (physical/ddl/tables.ts addNatives); no ALTER TABLE of either adds one; only foreign keys
 * and what a CREATE TABLE cannot state stay an ALTER TABLE.
 */
export const judgedWhole = (spec: FillSpec, note: (f: WholeFeature) => void): void => {
	const installation = installationOf(spec)
	const draft = draftMigration({
		previous: emptySnapshot({ schemaName: "Whole", schema: "whole" }),
		installation,
		workload: noWorkload,
		declared: noDeclarations,
		abandoned: []
	})
	const drafted = statementsOf(draft)
	const objects = Arr.flatMap(installation.manifest.objects, (o) => o.ddl)
	for (const object of Arr.flatMap(objects, (s) => (s.kind === "createTable" ? [s] : []))) {
		const key = nameKey(object.table)
		const name = object.table.name
		const created = createdIn(drafted, key)
		assert.equal(created.length, 1, `${name} is created by one CREATE TABLE of the first migration`)
		assert.deepEqual(
			created,
			createdIn(installation.statements, key),
			`the first migration creates ${name} by the installation's script's CREATE TABLE`
		)
		const create = defined(created[0], "the one CREATE TABLE")
		const added = alterationsOf(drafted, key)
		assert.deepEqual(
			statedOf(added),
			[],
			`no ALTER TABLE of ${name} in the first migration adds what its CREATE TABLE states`
		)
		assert.deepEqual(
			statedOf(alterationsOf(installation.statements, key)),
			[],
			`no ALTER TABLE of ${name} in the installation's script adds what its CREATE TABLE states`
		)
		const objectAdds = alterationsOf(objects, key)
		assert.deepEqual(
			Arr.sort(statedBy(create), Order.String),
			Arr.sort([...statedBy(object), ...statedOf(objectAdds)], Order.String),
			`${name}'s CREATE TABLE states what the installation's objects state of it`
		)
		if (Arr.some(objectAdds, (a) => a.kind === "addColumn")) {
			note("a law column in its table's CREATE TABLE")
		}
		if (
			Arr.some(objectAdds, (a) => a.kind === "addConstraint" && a.constraint.kind !== "foreignKey")
		) {
			note("a key or CHECK in its table's CREATE TABLE")
		}
		if (Arr.some(added, (a) => a.kind === "addConstraint" && a.constraint.kind === "foreignKey")) {
			note("a foreign key added after every table")
		}
	}
}
