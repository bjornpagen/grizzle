/**
 * The box of test/pg/physical/query-entry-base.test.ts: a base of one relation, Secret(k, v) keyed by k, and a level of
 * one derived relation, Kept, its every row; a role, `viewer`, whose one entry is a query entry, Seen, every row of
 * Kept, which it holds none of, nor Secret; its login's workload, a read of Seen; and a read of Secret itself over the
 * role, which it may not make.
 */

import { type Gen, map, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"

const Secret = relation("Secret", { k: pg.integer, v: pg.integer }, ["k"])

/**
 * The schema under `name`, Secret and a derived relation of its every row, Kept; its role whose one entry reads Kept;
 * and its login serving a read of that entry.
 */
export const builtOf = (name: string) => {
	const base = schema(name, [Secret], [])
	const Kept = derived(
		"Kept",
		query(base).rule((r) => {
			const { k, v: x } = v(Secret, "secret")
			return r.match(Secret, { k, v: x }).find({ k, v: x })
		})
	)
	const top = schema.extend([base], `${name}_1`, [Kept], [])
	/** Every row of Kept: the query entry's definition, checked against the base. */
	const rows = query(top).rule((r) => {
		const { k, v: x } = v(Kept, "kept")
		return r.match(Kept, { k, v: x }).find({ k, v: x })
	})
	const viewer = role(top, "viewer", { Seen: rows })
	/** Every row of the role's query entry. */
	const seen = query(viewer).rule((r) => {
		const { k, v: x } = v(viewer.relations.Seen, "seen")
		return r.match(viewer.relations.Seen, { k, v: x }).find({ k, v: x })
	})
	return {
		schema: top,
		viewer,
		programs: { seen },
		login: login(top, "server", [viewer], { workload: [workload(viewer, { seen })] })
	}
}

/**
 * A read of Secret itself over the role `viewer`, which holds none of it, built by the untyped builder: the typed one
 * refuses it before it runs, a match of a relation outside the role.
 */
export const secretRead = (viewer: ReturnType<typeof builtOf>["viewer"]) =>
	queryOver(viewer).rule((r: RuleValue) => {
		const vars = varsOver(Secret, "secret")
		return r.match(Secret, vars).find(vars)
	})

/** A case: Secret's rows, each its key and its value. */
export interface SecretCase {
	readonly rows: ReadonlyArray<readonly [number, number]>
}

/** Three rows of Secret. */
const all: ReadonlyArray<readonly [number, number]> = [
	[1, 10],
	[2, 20],
	[3, 30]
]

/** The cases: a drawn set of Secret's three rows, none to all. */
export const secretCase: Gen<SecretCase> = map(
	subset(all, { min: 0, max: all.length }),
	(rows) => ({
		rows
	})
)

/** A case's facts, by relation. */
export const factsOf = (c: SecretCase) => ({
	Secret: Arr.map(c.rows, ([k, value]) => ({ k, v: value }))
})

/** A row as text. */
export const rowText = (row: { readonly k: unknown; readonly v: unknown }): string =>
	`${String(row.k)}=${String(row.v)}`

/** The entry's rows, the rule restated: every row of Secret. */
export const seenRows = (c: SecretCase): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(c.rows, ([k, value]) => rowText({ k, v: value })),
		Order.String
	)
