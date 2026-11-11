import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
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
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeWrite } from "#test/support/conservative.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"

/**
 * A carrier's name fixes its declaration (sql/naming.ts carrierName): a session keeps each served statement under its
 * text, and a statement over a carrier reads the carrier its program's call creates, so two programs one session runs
 * whose texts name one carrier must declare it alike, or the second meets the plan the first cached with another row
 * type ("cached plan must not change result type").
 *
 * The programs: a put of R with a read-back of both sides of its delta, in both realizations, the optimized and the
 * conservative, under one schema name for every layout of R, whose fields are named alike and whose v is a pattern's
 * text, of a domain over text naming pg_catalog.pg_c_utf8, or a bigint, a boolean or a uuid. The oracle: over every carrier of every program
 * of the layouts drawn together, one name stands for one CREATE TEMPORARY TABLE, its text with the name set aside.
 * Exhausted over every set of layouts.
 */
const layouts = ["text", "bigint", "boolean", "uuid"] as const
type Layout = (typeof layouts)[number]

/** The schema every layout is compiled under, so its programs name their carriers as one session's programs do. */
const schemaName = "carrier_names"

/** A layout's schema and its put of R, with a read-back of both sides of R's delta. */
const layoutOf = (layout: Layout) => {
	switch (layout) {
		case "text": {
			const R = relation("R", { id: pg.int4, v: str.regex("^[a-z]*$") }, ["id"])
			const S = schema(schemaName, { R }, [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(R, [{ id: 0, v: "x" }])
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
		case "bigint": {
			const R = relation("R", { id: pg.int4, v: pg.bigint }, ["id"])
			const S = schema(schemaName, { R }, [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(R, [{ id: 0, v: 1n }])
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
		case "boolean": {
			const R = relation("R", { id: pg.int4, v: pg.boolean }, ["id"])
			const S = schema(schemaName, { R }, [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(R, [{ id: 0, v: true }])
					.read("r", (d) =>
						query(S).rule((r) => {
							const { id, v: value } = v(R, "added")
							return r.match(d.added(R), { id, v: value }).find({ id, v: value })
						})
					)
			}
		}
		case "uuid": {
			const R = relation("R", { id: pg.int4, v: uuid }, ["id"])
			const S = schema(schemaName, { R }, [mutable(R)])
			return {
				S,
				changes: ChangeSet.empty(S)
					.put(R, [{ id: 0, v: "00000000-0000-4000-8000-000000000001" }])
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

/** Every carrier a layout's programs create, in both realizations. */
const carriersOf = (layout: Layout): ReadonlyArray<readonly [string, string]> => {
	const { S, changes } = layoutOf(layout)
	const owned = owning(S)
	const names = succeeded(
		compileInstallation(owned, {
			...installOptions(owned, "owner"),
			levels: [identity.schema(parsedSchemaName(schemaName))]
		})
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
	return [...createdCarriers(program.artifact), ...createdCarriers(conservative.artifact)]
}

/** Each layout's carriers, compiled once. */
const carriers: { readonly [L in Layout]: ReadonlyArray<readonly [string, string]> } = {
	text: carriersOf("text"),
	bigint: carriersOf("bigint"),
	boolean: carriersOf("boolean"),
	uuid: carriersOf("uuid")
}

type Situation = "one layout" | "layouts of one carrier ordinal and two declarations"

const layoutsGen: Gen<ReadonlyArray<Layout>> = subarray(layouts)

describe("a write program's carriers", () => {
	it.effect("name one declaration each, across every program a session may run", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/write/carrier-names",
					generator: layoutsGen,
					literal: Formatter.format,
					limit: 2 ** layouts.length,
					box: "every set of R's layouts, v text, bigint, boolean or uuid, each a put with a read-back of both sides in both realizations",
					oracle: {
						kind: "second-implementation",
						name: "the CREATE TEMPORARY TABLE text of each carrier, its name set aside"
					},
					coverage: requiredInSpace<Situation>([
						"one layout",
						"layouts of one carrier ordinal and two declarations"
					]),
					caseHang
				},
				(drawnLayouts, c) =>
					Effect.sync(() => {
						const all = Arr.flatMap(drawnLayouts, (layout) => carriers[layout])
						if (drawnLayouts.length === 1) {
							c.note("one layout")
						}
						const declared = new Map<string, string>()
						for (const [name, declaration] of all) {
							const held = declared.get(name)
							assert.ok(
								held === undefined || held === declaration,
								`the carrier ${name} is declared ${held ?? ""} and ${declaration}`
							)
							declared.set(name, declaration)
						}
						const ordinalOf = (name: string): string =>
							defined(Str.split(name, "_")[3], `the ordinal of ${name}`)
						if (
							Arr.some(all, ([a, x]) =>
								Arr.some(all, ([b, y]) => ordinalOf(a) === ordinalOf(b) && x !== y)
							)
						) {
							c.note("layouts of one carrier ordinal and two declarations")
						}
					})
			)
		)
	)
})
