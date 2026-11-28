/** What the properties of swaps.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, map, shuffled } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option, Order, Record } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { type SqlStatement, tableConstraints } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { draftActions, draftFiles, planStatements } from "#test/support/migrate/review.ts"

/** The words key names are made of, as field names, and plain ones.
 */
const words = ["next", "ix", "key", "pk", "a", "b"] as const

/** The name the naming door builds an index under before it is swapped in for `name` (identity.swap). */
const swapName = (name: string): string => identifierOf(identity.swap(name))

interface SwapCase {
	/** Distinct field words: the first is retyped and keyed alone and with the second; the third is keyed alone. */
	readonly fields: ReadonlyArray<string>
}

export const caseGen: Gen<SwapCase> = map(shuffled(words, { min: 3, max: 4 }), (fields) => ({
	fields
}))

/** A version of Task: as drawn, its first field retyped to bigint, or its primary key moved to the second and third. */
type Successor = "drawn" | "retyped" | "moved"

/** Task with the first field an integer, or a bigint once retyped, and the others integers, keyed as the header says. */
const desc = (c: SwapCase, version: Successor): SchemaDesc => {
	const [first, second, third] = c.fields
	if (first === undefined || second === undefined || third === undefined) {
		throw new Error("a case of fewer than three fields")
	}
	return {
		name: "Swap",
		relations: [
			relation(
				"Task",
				{
					id: f.uuid,
					...Record.fromEntries(
						Arr.map(c.fields, (w) => [
							w,
							w === first && version === "retyped" ? f.bigint : f.integer
						])
					)
				},
				version === "moved" ? [second, third] : ["id"]
			)
		],
		statements: [
			key(on("Task", [first])),
			key(on("Task", [first, second])),
			key(on("Task", [third]))
		],
		bases: []
	}
}

/** The index names a statement names: what it creates, drops, renames, or attaches as a key's index. */
const indexNames = (s: SqlStatement): ReadonlyArray<string> => {
	if (s.kind === "createIndex") {
		return [s.name]
	}
	if (s.kind === "dropIndex") {
		return [s.name.name]
	}
	if (s.kind === "rename") {
		return s.object === "INDEX" ? [s.name.name, s.to] : []
	}
	if (s.kind === "alterTable") {
		return Arr.flatMap(s.actions, (a) =>
			a.kind === "addConstraintUsingIndex" ? [a.index, a.name] : []
		)
	}
	return []
}

/** The names an installation registers in the relation namespace: tables, every constraint (a key's index takes its
 * name) and indexes. */
const registered = (statements: ReadonlyArray<SqlStatement>): ReadonlyArray<string> =>
	Arr.flatMap(statements, (s): ReadonlyArray<string> => {
		if (s.kind === "createTable") {
			return [s.table.name, ...Arr.map(tableConstraints(s), (k) => k.name)]
		}
		if (s.kind === "createIndex") {
			return [s.name]
		}
		if (s.kind === "alterTable") {
			return Arr.flatMap(s.actions, (a) => (a.kind === "addConstraint" ? [a.constraint.name] : []))
		}
		return []
	})

/** The keys (primary or candidate) an installation's tables declare that hold `column`, by name. */
const keysOver = (statements: ReadonlyArray<SqlStatement>, column: string): ReadonlyArray<string> =>
	Arr.flatMap(statements, (s) =>
		s.kind === "createTable"
			? Arr.flatMap(tableConstraints(s), (k) =>
					(k.kind === "primaryKey" || k.kind === "unique") &&
					Arr.some(k.columns, (c) => c.column === column)
						? [k.name]
						: []
				)
			: []
	)

const featureNames = [
	"a key over the retyped field added again",
	"the primary key swapped",
	"a swap beside the key its suffix spelling would name"
] as const

export type Feature = (typeof featureNames)[number]

/** The draft of `to` from the snapshot `from` drafts. */
const draftTo = (from: SwapCase, to: Successor) => {
	const before = compile(desc(from, "drawn"), asDrafted)
	const first = succeeded(
		generate({
			installation: before,
			name: "first",
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations
		})
	)
	const after = compile(desc(from, to), asDrafted)
	const g = succeeded(
		generate({
			previous: fromSnapshot(first.snapshot),
			installation: after,
			name: to,
			timestamp: draftedAt(2),
			workload: noWorkload,
			declared: noDeclarations
		})
	)
	return { before, after, g }
}

/** The statements a draft names, among the relation's indexes and keys, beyond `allowed`, which the successor changes. */
const strays = (
	g: Parameters<typeof planStatements>[0],
	after: ReadonlyArray<SqlStatement>,
	allowed: ReadonlySet<string>
): ReadonlyArray<string> => {
	const unchanged = Arr.filter(registered(after), (n) => !allowed.has(n))
	return Arr.filter(
		Arr.flatMap(planStatements(g), indexNames),
		(n) => !allowed.has(n) && unchanged.includes(n)
	)
}

/** The swap names and the registered names are disjoint, in every installation: the naming door mints a swap name
 * from the identity of what it swaps (identity.swap), which no installed object has.
 *
 * Live when the draft runs: a key whose suffix-spelled swap name it would be. */
export const swaps = (c: Case<Feature>, value: SwapCase): void => {
	for (const version of ["drawn", "retyped", "moved"] as const) {
		const installation = compile(desc(value, version), asDrafted)
		const names = registered(installation.statements)
		const taken = new Set(names)
		assert.deepEqual(
			Arr.filter(names, (n) => taken.has(swapName(n))),
			[],
			"a swap name is a registered name"
		)
	}
	const [retyped] = value.fields
	if (retyped === undefined) {
		throw new Error("a case without fields")
	}
	/** The retyped field: each key over it keeps its name, dropped before the conversion and added again right after it
	 * in Structure, never built under a swap name or concurrently. */
	const r = draftTo(value, "retyped")
	const changed = new Set(keysOver(r.after.statements, retyped))
	assert.deepEqual(
		Arr.sort([...changed], Order.String),
		Arr.sort([...keysOver(r.before.statements, retyped)], Order.String),
		"a key over the retyped field keeps its name"
	)
	const structure = Arr.flatMap(draftFiles(r.g), (file) =>
		file.phase === "structure" ? Arr.flatMap(file.drafts, draftActions) : []
	)
	const conversion = Arr.findFirstIndex(
		structure,
		(a) => a.kind === "fill" && Arr.some(a.fields, (f) => f.column.name === retyped)
	)
	assert.ok(Option.isSome(conversion), `Structure sets ${retyped} aside and fills it`)
	const at = (name: string, kind: "dropConstraint" | "addConstraint") =>
		Arr.findFirstIndex(structure, (a) =>
			Arr.some(
				a.kind === "statement" && a.statement.kind === "alterTable"
					? a.statement.actions
					: a.kind === "alteration"
						? a.actions
						: [],
				(x) =>
					kind === "dropConstraint"
						? x.kind === "dropConstraint" && x.name === name
						: x.kind === "addConstraint" && x.constraint.name === name && !x.notValid
			)
		)
	const built = Arr.flatMap(planStatements(r.g.plan), (s) =>
		s.kind === "createIndex" ? [s.name] : []
	)
	for (const name of changed) {
		const dropped = at(name, "dropConstraint")
		const added = at(name, "addConstraint")
		assert.ok(
			Option.exists(dropped, (d) => d < conversion.value) &&
				Option.exists(added, (k) => k > conversion.value),
			`${name} is dropped before the conversion and added again after it, in Structure`
		)
		assert.ok(
			!built.includes(name) && !built.includes(swapName(name)),
			`${name} is built by no CREATE INDEX of its own`
		)
	}
	if (changed.size > 0) {
		c.note("a key over the retyped field added again")
	}
	assert.deepEqual(
		strays(r.g.plan, r.after.statements, changed),
		[],
		`the draft names a key it does not change`
	)
	/** The moved primary key: built under its swap name and attached under its own. */
	const m = draftTo(value, "moved")
	const [pk] = Arr.flatMap(m.after.statements, (s) =>
		s.kind === "createTable" ? [s.primaryKey.name] : []
	)
	if (pk === undefined) {
		throw new Error("a relation without a primary key")
	}
	const plan = planStatements(m.g.plan)
	const swap = swapName(pk)
	assert.ok(
		Arr.some(plan, (s) => s.kind === "createIndex" && s.name === swap),
		`${pk} is built under its swap name`
	)
	assert.ok(
		Arr.some(
			plan,
			(s) =>
				s.kind === "alterTable" &&
				Arr.some(
					s.actions,
					(a) => a.kind === "addConstraintUsingIndex" && a.name === pk && a.index === swap
				)
		),
		`${pk} is attached from its swap index`
	)
	c.note("the primary key swapped")
	if (registered(m.before.statements).includes(`${pk}__next`)) {
		c.note("a swap beside the key its suffix spelling would name")
	}
	assert.deepEqual(
		strays(m.g.plan, m.after.statements, new Set([pk, swap])),
		[],
		`the draft names a key it does not change`
	)
}
