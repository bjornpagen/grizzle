/** What the property of scope.test.ts reads: its space of schemas, roots and databases, and its models. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, context, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import type { Scope } from "#compiler/schema/scope.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { nonEmptyArgumentsOf } from "#test/support/list.ts"

/**
 * scopedEntriesOf's derivation (schema/scope.ts deriveScopes) over drawn schemas: two to four relations R0…R3, each
 * keyed by its `id`, by its `id` and `step`, or by its `person` and `step`, each with a `person` and, for every other
 * relation Rj, a field `to<j>`;
 * each ordered pair joined or not by a declared containment into the second's key, from the first's own key fields or
 * from its `to<j>`; and some relations stated roots by their `person`. The owner is the persons a session's Clerk user
 * signs in as (Session ⋈ Account).
 *
 * A database draws each relation's rows over small domains, then drops every row a containment refuses until every
 * containment holds, so it is a lawful state of the schema. The models read membership off it along the schema's
 * declared containments, as the definition of a reached scope states it: a root's row is the owner's where its person
 * is; any other row is the owner's where a containment from its fields into a key reaches a row, by the key the one
 * row, the owner's (`exists`), or where every such containment reaches one (`every`). A scope holds its rows by one
 * form; so where the derivation admits the schema, both models and the scope's own reading (`scopeMember`) agree on
 * every row, every relation some containment chain leads from to a root is scoped, every other whole, and every scope
 * is in its shortest form.
 */

const Name = str.regex("^[a-z]{1,8}$")

export const Account = relation("Account", { clerk: Name, person: Name }, ["clerk"])
export const Session = context("Session", { sub: Name })

/** A relation's key: its `id`; its `id` and `step`; or its `person` and `step`, a key that holds a root's field. */
export type KeyKind = "id" | "idStep" | "personStep"

/** A containment of relation `from` into relation `into`'s key: from `from`'s own key fields (`own`), or from its
 * `to<into>` (`ref`), which only a key of `id` alone takes. */
export interface Edge {
	readonly from: number
	readonly into: number
	readonly left: "own" | "ref"
}

export interface ScopeShape {
	readonly keys: readonly [KeyKind, ...Array<KeyKind>]
	readonly edges: ReadonlyArray<Edge>
	readonly roots: ReadonlyArray<number>
}

export const relationName = (i: number): string => `R${i}`
const toField = (j: number): string => `to${j}`

export const keyFields = (k: KeyKind): readonly [string, ...Array<string>] => {
	switch (k) {
		case "id":
			return ["id"]
		case "idStep":
			return ["id", "step"]
		case "personStep":
			return ["person", "step"]
	}
}

/** The fields of an edge's containment, its left side's and its right side's, paired by position. */
export const edgeFields = (
	e: Edge,
	keys: ScopeShape["keys"]
): {
	readonly left: readonly [string, ...Array<string>]
	readonly right: readonly [string, ...Array<string>]
} => {
	const right = keyFields(defined(keys[e.into], `R${e.into}'s key`))
	return { left: e.left === "own" ? right : [toField(e.into)], right }
}

export const shapeGen: Gen<ScopeShape> = (s) => {
	const n = s.draw(int(2, 4))
	const indices = Array.from({ length: n }, (_, i) => i)
	const keys = Arr.map(indices, () => s.draw(element(["id", "idStep", "personStep"] as const)))
	const keyAt = (i: number): KeyKind => defined(keys[i], `R${i}'s key`)
	const edges = Arr.flatMap(indices, (from) =>
		Arr.flatMap(indices, (into): ReadonlyArray<Edge> => {
			if (from === into) {
				return []
			}
			const left = s.draw(
				element(
					keyAt(into) === "id" ? (["none", "own", "ref"] as const) : (["none", "own"] as const)
				)
			)
			return left === "none" ? [] : [{ from, into, left }]
		})
	)
	return {
		keys: [keyAt(0), ...Arr.map(indices.slice(1), keyAt)],
		edges,
		roots: s.draw(subarray(indices))
	}
}

/** A drawn schema's values: the schema, each relation by its index, and the owner query. */
export const built = (shape: ScopeShape) => {
	const relations = Arr.map(shape.keys, (k, i) =>
		relationBuilder(
			relationName(i),
			Rec.fromEntries([
				["id", pg.bigint] as const,
				["step", pg.bigint] as const,
				["person", Name] as const,
				...Arr.flatMap(shape.keys, (_, j): ReadonlyArray<readonly [string, typeof pg.bigint]> =>
					j === i ? [] : [[toField(j), pg.bigint]]
				)
			]),
			keyFields(k),
			[]
		)
	)
	const at = (i: number) => defined(relations[i], `R${i}`)
	const statements: ReadonlyArray<Statement> = Arr.map(shape.edges, (e) => {
		const { left, right } = edgeFields(e, shape.keys)
		return contained(
			on(at(e.from), ...nonEmptyArgumentsOf(left)),
			on(at(e.into), ...nonEmptyArgumentsOf(right))
		)
	})
	const value = schema("Scopes", [Account, ...relations], statements)
	const owner = query(value).rule((r) => {
		const { sub } = v(Session, "session")
		const { person } = v(Account, "account")
		return r.match(Session, { sub }).match(Account, { clerk: sub, person }).find({ person })
	})
	return { schema: value, owner }
}

/** A row of a drawn relation. */
export type Row = Readonly<Record<string, bigint | string>>

/** A database of a drawn schema: each relation's rows, by index, every containment holding. */
export type Database = ReadonlyArray<ReadonlyArray<Row>>

const persons = ["ann", "bob"] as const
/** The owner: the session signs in as ann. */
export const owners: ReadonlySet<string> = new Set(["ann"])

/** A row as a failure names it: each field and its value. */
export const rowText = (row: Row): string =>
	Arr.join(
		Arr.map(Rec.toEntries(row), ([f, x]) => `${f}=${String(x)}`),
		", "
	)

const rowKey = (row: Row, fields: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(fields, (f) => String(row[f])),
		" "
	)

/**
 * A database of `shape`: each relation's rows over ids and steps of 1 and 2, persons ann and bob, references of 1 and
 * 2, each key's once; then every row a containment refuses dropped, until none is.
 */
export const databaseGen =
	(shape: ScopeShape): Gen<Database> =>
	(s) => {
		const drawn = Arr.map(shape.keys, (k, i) => {
			const rows = s.draw(
				array(
					(d): Row =>
						Rec.fromEntries([
							["id", BigInt(d.draw(int(1, 2)))] as const,
							["step", BigInt(d.draw(int(1, 2)))] as const,
							["person", d.draw(element(persons))] as const,
							...Arr.flatMap(shape.keys, (_, j): ReadonlyArray<readonly [string, bigint]> =>
								j === i ? [] : [[toField(j), BigInt(d.draw(int(1, 2)))]]
							)
						]),
					{ min: 0, max: 4 }
				)
			)
			const seen = new Set<string>()
			return Arr.filter(rows, (row) => {
				const key = rowKey(row, keyFields(k))
				const fresh = !seen.has(key)
				seen.add(key)
				return fresh
			})
		})
		let db: Database = drawn
		for (let moved = true; moved;) {
			const current = db
			const next = Arr.map(current, (rows, i) =>
				Arr.filter(rows, (row) =>
					Arr.every(
						Arr.filter(shape.edges, (e) => e.from === i),
						(e) => {
							const { left, right } = edgeFields(e, shape.keys)
							return Arr.some(defined(current[e.into], `R${e.into}'s rows`), (target) =>
								Arr.every(left, (l, p) => target[defined(right[p], "a paired field")] === row[l])
							)
						}
					)
				)
			)
			moved = Arr.some(
				next,
				(rows, i) => rows.length !== defined(current[i], `R${i}'s rows`).length
			)
			db = next
		}
		return db
	}

/** The row of relation `into` whose key holds `values` at its fields, by containment the one row a path reaches. */
const rowAt = (
	db: Database,
	into: number,
	fields: ReadonlyArray<string>,
	values: ReadonlyArray<bigint | string>
) =>
	Option.getOrUndefined(
		Arr.findFirst(defined(db[into], `R${into}'s rows`), (row) =>
			Arr.every(fields, (f, p) => row[f] === values[p])
		)
	)

/**
 * The model's reading of a row's ownership along the schema's containments: from relation `i`'s row, each containment
 * into a relation's key reaches that key's one row, whose ownership is its root's person or read on from it. `combine`
 * decides a row of several containments: any (`exists`) or every (`every`); a row of none reaching a root is no one's,
 * and only a relation with one is scoped.
 */
const memberBy =
	(
		shape: ScopeShape,
		db: Database,
		combine: "exists" | "every"
	): ((i: number, row: Row, visiting: ReadonlySet<number>) => boolean | undefined) =>
	(i, row, visiting) => {
		if (Arr.contains(shape.roots, i)) {
			return owners.has(String(row["person"]))
		}
		const outgoing: ReadonlyArray<Edge> = Arr.filter(
			shape.edges,
			(e: Edge) => e.from === i && !visiting.has(e.into)
		)
		const paths = Arr.flatMap(outgoing, (e: Edge): ReadonlyArray<boolean> => {
			const { left, right } = edgeFields(e, shape.keys)
			const target = rowAt(
				db,
				e.into,
				right,
				Arr.map(left, (l) => defined(row[l], l))
			)
			const read =
				target === undefined
					? undefined
					: memberBy(shape, db, combine)(e.into, target, new Set([...visiting, i]))
			return read === undefined ? [] : [read]
		})
		if (!Arr.isReadonlyArrayNonEmpty(paths)) {
			return undefined
		}
		return combine === "exists" ? Arr.some(paths, (p) => p) : Arr.every(paths, (p) => p)
	}

/** Whether relation `i`'s row is the owner's by the model, any path's or every path's; none where no path reaches a
 * root from it. */
export const modelMember = (
	shape: ScopeShape,
	db: Database,
	combine: "exists" | "every",
	i: number,
	row: Row
): boolean | undefined => memberBy(shape, db, combine)(i, row, new Set())

/** The relations some containment chain leads from to a root, roots among them: the ones a derivation scopes. */
export const scopedModel = (shape: ScopeShape): ReadonlySet<number> => {
	const scoped = new Set(shape.roots)
	for (let moved = true; moved;) {
		moved = false
		for (const e of shape.edges) {
			if (!scoped.has(e.from) && scoped.has(e.into)) {
				scoped.add(e.from)
				moved = true
			}
		}
	}
	return scoped
}

/** A case: a drawn schema and some lawful databases of it. */
export interface ScopeCase {
	readonly shape: ScopeShape
	readonly databases: ReadonlyArray<Database>
}

export const scopeCaseGen: Gen<ScopeCase> = (s) => {
	const shape = s.draw(shapeGen)
	return { shape, databases: s.draw(array(databaseGen(shape), { min: 1, max: 3 })) }
}

/** Whether a row of a scope's relation is the owner's by the scope's own form: its root field the owner's, or the row
 * its reach reaches the owner's by the scope it is reached through. */
export const scopeMember = (scope: Scope, db: Database, row: Row): boolean => {
	switch (scope.kind) {
		case "root":
			return owners.has(String(row[scope.field]))
		case "reached": {
			const into = Number(Str.slice(1)(scope.reach.into))
			const target = rowAt(
				db,
				into,
				Arr.map(scope.reach.pairs, (p) => p.key),
				Arr.map(scope.reach.pairs, (p) => defined(row[p.column], p.column))
			)
			return target !== undefined && scopeMember(scope.parent, db, target)
		}
	}
}

/**
 * Whether a scope is in its shortest form: a reach into a root never holds the root's field in its key, and a reach into
 * a reached scope never holds that scope's own reach's fields, either of which makes the scope one step shorter.
 */
export const shortest = (scope: Scope): boolean => {
	switch (scope.kind) {
		case "root":
			return true
		case "reached": {
			const keys = Arr.map(scope.reach.pairs, (p) => p.key)
			const parent = scope.parent
			const onward =
				parent.kind === "root"
					? Arr.contains(keys, parent.field)
					: Arr.every(parent.reach.pairs, (p) => Arr.contains(keys, p.column))
			return !onward && shortest(parent)
		}
	}
}

export type ScopeFeature =
	| "a root"
	| "a reached scope"
	| "a chain held in its shortest form"
	| "a relation kept whole"
	| "an ambiguous relation refused"
