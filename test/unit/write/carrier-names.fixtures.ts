/** What the properties of carrier-names.test.ts read: its spaces, models and helpers. */

import { type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { servingParams, testArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeWrite } from "#test/support/conservative.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"

/** The types a layout's column v takes. */
const layouts = ["text", "bigint", "boolean", "uuid"] as const

type Layout = (typeof layouts)[number]

/** The schema every layout is compiled under, so its programs name their carriers as one session's programs do. */
const schemaName = "carrier_names"

/**
 * A layout's schema and its put of R from a query over the relation parameter `rows`, with a read-back of its added
 * facts: the put is described, so its displacing deletion and its insert both read the query's rows from a carrier of
 * the program's own (write/schedule/plan.ts), declared by R's layout.
 */
const layoutOf = (layout: Layout) => {
	switch (layout) {
		case "text": {
			const R = relation("R", { id: pg.integer, v: str.regex("^[a-z]*$") }, ["id"])
			const S = schema(schemaName, [R], [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(
						R,
						query(S).rule((r) => {
							const rows = r.relation("rows", { id: R.fields.id, v: R.fields.v })
							const { id, v: value } = v(R, "r")
							return r.match(rows, { id, v: value }).find({ id, v: value })
						})
					)
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
		case "bigint": {
			const R = relation("R", { id: pg.integer, v: pg.bigint }, ["id"])
			const S = schema(schemaName, [R], [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(
						R,
						query(S).rule((r) => {
							const rows = r.relation("rows", { id: R.fields.id, v: R.fields.v })
							const { id, v: value } = v(R, "r")
							return r.match(rows, { id, v: value }).find({ id, v: value })
						})
					)
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
		case "boolean": {
			const R = relation("R", { id: pg.integer, v: pg.boolean }, ["id"])
			const S = schema(schemaName, [R], [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(
						R,
						query(S).rule((r) => {
							const rows = r.relation("rows", { id: R.fields.id, v: R.fields.v })
							const { id, v: value } = v(R, "r")
							return r.match(rows, { id, v: value }).find({ id, v: value })
						})
					)
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
		case "uuid": {
			const R = relation("R", { id: pg.integer, v: uuid }, ["id"])
			const S = schema(schemaName, [R], [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(
						R,
						query(S).rule((r) => {
							const rows = r.relation("rows", { id: R.fields.id, v: R.fields.v })
							const { id, v: value } = v(R, "r")
							return r.match(rows, { id, v: value }).find({ id, v: value })
						})
					)
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
	}
}

/** Every carrier an artifact creates: its name, and its CREATE TEMPORARY TABLE's text with the name set aside. */
const createdCarriers = (
	artifact: WriteArtifact
): ReadonlyArray<readonly [name: string, declaration: string]> =>
	Arr.flatMap(artifact.statements, (s) =>
		s.step.kind === "carrier" && s.step.step === "create"
			? [[s.step.carrier, Str.replaceAll(s.step.carrier, "?")(s.spec.sql)] as const]
			: []
	)

/** The carriers a layout's programs create, each realization's in the order its program creates them. */
interface Created {
	readonly optimized: ReadonlyArray<readonly [name: string, declaration: string]>
	readonly conservative: ReadonlyArray<readonly [name: string, declaration: string]>
}

/** Every carrier a layout's programs create, in both realizations. */
const carriersOf = (layout: Layout): Created => {
	const { S, changes } = layoutOf(layout)
	const owned = owning(S)
	const names = succeeded(
		compileInstallation(
			owned,
			servingParams(
				{
					...installOptions(owned, "owner"),
					levels: [identity.schema(parsedSchemaName(schemaName))]
				},
				S,
				{ put: changes }
			)
		)
	).names
	const artifacts = succeeded(testArtifacts(S, testCompile))
	const program = succeeded(
		compileWrite(checking(S), defined(changeSetDesc(changes), "a ChangeSet"), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable"
		}),
		`the ${layout} put compiles`
	)
	const conservative = succeeded(
		conservativeWrite(program, { names, reads: names }),
		`the ${layout} put's conservative realization`
	)
	return {
		optimized: createdCarriers(program.artifact),
		conservative: createdCarriers(conservative.artifact)
	}
}

/** Each layout's carriers, compiled once. */
export const carriers: { readonly [L in Layout]: Created } = {
	text: carriersOf("text"),
	bigint: carriersOf("bigint"),
	boolean: carriersOf("boolean"),
	uuid: carriersOf("uuid")
}

export type Situation = "one layout" | "layouts of one carrier position and two declarations"

/** The realizations a layout's carriers are created in. */
const realizations = ["optimized", "conservative"] as const

/**
 * Whether two of the layouts create, at one position of one realization's program, carriers declared otherwise: where a
 * name drawn from a carrier's place alone would name two declarations.
 */
export const placedApart = (drawnLayouts: ReadonlyArray<Layout>): boolean =>
	Arr.some(drawnLayouts, (a) =>
		Arr.some(drawnLayouts, (b) =>
			Arr.some(realizations, (r) =>
				Arr.some(carriers[a][r], ([, x], i) => {
					const other = carriers[b][r][i]
					return a !== b && other !== undefined && other[1] !== x
				})
			)
		)
	)

export const layoutsGen: Gen<ReadonlyArray<Layout>> = subarray(layouts)
