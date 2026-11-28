/**
 * What canonical-aliases.test.ts reads: its space of aliases of one definition and their workloads, each compiled into
 * an installation twice: with the aliases, every read of each over its own alias; and with the first alias alone,
 * every read over it.
 *
 * A shape is a unit Doc of `doc` and its member M0(doc, k0, v0, v1), keyed by (doc, k0), closed or mutable; a
 * definition over M0, the union of M0's (doc, k0, v0) with itself, a count of its rows by (doc, k0) or by `doc`, or M0
 * without the rows its own negation finds at (doc, k0), delivering (doc, v0); two or three derived relations of that one
 * definition, D0, D1 and D2, aliases of one canonical relation (analysis/derived/canonical.ts); and one to four live
 * reads, each of an alias, by `doc` alone, by `doc` and the first field after it, or by `doc` and the last, a count
 * never, so a read may ask for an index past the table's key.
 */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { mutable, schema, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder } from "#compiler/schema/schema.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { servedInstallation } from "#test/support/compiled-served.ts"

/** The definition every alias of a shape has (see the header). */
type Definition = "union" | "byKey" | "byDoc" | "without"

/** A read: the alias it reads, and the fields past `doc` its binding fixes: none, the first, or the last. */
interface AliasRead {
	readonly alias: number
	readonly binds: "doc" | "first" | "last"
}

export interface AliasShape {
	readonly mutable: boolean
	readonly definition: Definition
	readonly aliases: 2 | 3
	readonly reads: Arr.NonEmptyReadonlyArray<AliasRead>
}

export const aliasShapeGen: Gen<AliasShape> = (source) => {
	const aliases = source.draw(element([2, 3] as const))
	const read: Gen<AliasRead> = (s) => ({
		alias: s.draw(int(0, aliases - 1)),
		binds: s.draw(element(["doc", "first", "last"] as const))
	})
	const [first, ...rest] = source.draw(array(read, { min: 1, max: 4 }))
	return {
		mutable: source.draw(boolean),
		definition: source.draw(element(["union", "byKey", "byDoc", "without"] as const)),
		aliases,
		reads: [defined(first, "a first read"), ...rest]
	}
}

/** The heading the definition delivers, `doc` first. */
const headingOf = (d: Definition): Arr.NonEmptyReadonlyArray<string> => {
	switch (d) {
		case "union":
			return ["doc", "k0", "v"]
		case "byKey":
			return ["doc", "k0", "n"]
		case "byDoc":
			return ["doc", "n"]
		case "without":
			return ["doc", "v0"]
	}
}

const M0 = relationBuilder(
	"M0",
	{ doc: pg.bigint, k0: pg.bigint, v0: pg.bigint, v1: pg.bigint },
	["doc", "k0"],
	[]
)

/** The definition's query over `base`. */
const definitionOf = (base: ReturnType<typeof schema>, d: Definition) => {
	const all = (r: RuleValue, scope: string) => {
		const m = varsOver(M0, scope)
		return {
			m,
			ruled: r.match(M0, { doc: m["doc"], k0: m["k0"], v0: m["v0"], v1: m["v1"] })
		}
	}
	switch (d) {
		case "union": {
			const arm = (scope: string) => (r: RuleValue) => {
				const { m, ruled } = all(r, scope)
				return ruled.find({ doc: m["doc"], k0: m["k0"], v: m["v0"] })
			}
			return queryOver(base).rule(arm("a")).rule(arm("b"))
		}
		case "byKey":
			return queryOver(base).rule((r: RuleValue) => {
				const { m, ruled } = all(r, "m")
				return ruled.find({ doc: m["doc"], k0: m["k0"], n: r.count() })
			})
		case "byDoc":
			return queryOver(base).rule((r: RuleValue) => {
				const { m, ruled } = all(r, "m")
				return ruled.find({ doc: m["doc"], n: r.count() })
			})
		case "without":
			return queryOver(base).rule((r: RuleValue) => {
				const { m, ruled } = all(r, "m")
				return ruled
					.where(r.not(M0, { doc: m["doc"], k0: m["k0"] }))
					.find({ doc: m["doc"], v0: m["v0"] })
			})
	}
}

/**
 * The installation of `s` with `aliases` derived relations of its definition and every read over the alias `aliasOf`
 * names for it, as `grizzle generate` drafts it serving those reads (test/support/compiled-served.ts
 * servedInstallation): every read its bound statements make asked an index for, and its live plan.
 */
const installed = (
	s: AliasShape,
	aliases: number,
	aliasOf: (read: AliasRead) => number
): Installation => {
	const base = schema(
		"Aliased",
		[M0],
		[unit("Doc", { doc: pg.bigint }), ...(s.mutable ? [mutable(M0)] : [])]
	)
	const derived = Array.from({ length: aliases }, (_, at) =>
		derivedBuilder(`D${at}`, definitionOf(base, s.definition), [])
	)
	const top = schemaBuilder.extend([base], "Aliased_1", derived, [], [])
	const heading = headingOf(s.definition)
	const programs = Rec.fromEntries(
		Arr.map(s.reads, (read, at) => {
			const d = defined(derived[aliasOf(read)], "a read alias")
			/** The fields past `doc` a parameter may bind: every one but a count, of no parameter's type. */
			const bindable = Arr.filter(heading.slice(1), (f) => f !== "n")
			const bound = new Set([
				"doc",
				...(read.binds === "first" ? Arr.take(bindable, 1) : []),
				...(read.binds === "last" ? Arr.takeRight(bindable, 1) : [])
			])
			return [
				`read${at}`,
				queryOver(top).rule((r: RuleValue) => {
					const vars = varsOver(d, `r${at}`)
					const bindings = Rec.fromEntries(
						Arr.map(heading, (f) => [f, bound.has(f) ? r.param(f, pg.bigint) : vars[f]] as const)
					)
					const head = Rec.fromEntries(
						Arr.flatMap(heading, (f) => (bound.has(f) ? [] : [[f, vars[f]] as const]))
					)
					return r
						.match(d, bindings)
						.find(Rec.isEmptyRecord(head) ? { doc: bindings["doc"] } : head)
				})
			] as const
		})
	)
	return succeeded(servedInstallation(top, programs), "the aliases' served installation")
		.installation
}

/** The installation with every alias, each read over its own. */
export const withAliases = (s: AliasShape): Installation =>
	installed(s, s.aliases, (read) => read.alias)

/** The installation with the first alias alone, every read over it. */
export const withOne = (s: AliasShape): Installation => installed(s, 1, () => 0)

/**
 * What an installation plans of the canonical relation's table, each as its DDL prints it, in order: its stored
 * tables' creations, every index, every constraint added to a table, and the live source's publication.
 */
export const tableObjects = (installation: Installation): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(installation.statements, (st: SqlStatement): ReadonlyArray<string> =>
			st.kind === "createStoredTable" ||
			st.kind === "createIndex" ||
			st.kind === "createPublication" ||
			(st.kind === "alterTable" && Arr.some(st.actions, (a) => a.kind === "addConstraint"))
				? [printStatement(st)]
				: []
		),
		Order.String
	)
