/**
 * The binding (sql/bind.ts bindStatement): every read of a stored table is bound as its level fixes it, where the read
 * stands: a seek at the columns a B-tree holds that its level fixes, a literal, a placeholder or an enclosing level's
 * column, where one of them holds many values; a probe, every binding its index's, where one binds it to a column of an
 * item before it; a whole read where it binds only columns of few values or none; and beneath a window function, the
 * reader's equality pushed into the window's query only at a column every window partitions by. The bound plan names
 * each read under the scope's alias, which the bound statement reads it by, so its advice holds PostgreSQL to that read.
 *
 * Property: over T(a, b, f, v, d) keyed by a, of a and b of many values, f of few, v a vector keyed by pgvector's B-tree
 * class through its `=`, and d no B-tree holds, and S(k, w) keyed by k: a read of T at its level's top, after S joined
 * at T.b = S.k, beneath S's EXISTS at T.a = S.k, or through a window over T partitioned by a at a reader's equality of
 * a or of b, or inside T's groups by b that S is joined to at b, at a drawn set of literal equalities of a, b, f, v and
 * d: the bound statement reads T once, and the plan's item of the alias it reads T by is what the specification says
 * (bind.fixtures.ts `specified`), its scan, whether a probe's, and its bound columns; every alias the plan names is the
 * scope's, once; and groups joined to S are read per row of S at T's key where they group T itself, and where they group
 * a CTE of T's rows are derived once, no LATERAL, their join's condition left their level's and the level joining them
 * by a hash, never derived again for each row of S (read-once's CTE scan run 52 times, 1,800 rows each).
 *
 * Oracle: the specification of the contract's binding rules (CARRY-CONTRACT §1).
 *
 * Features: a seek at a literal; a whole read of few values alone; a probe driven by an earlier item; a seek at an
 * enclosing level's column; a seek beneath a window at its partition, and a whole read beneath it at no partition; an
 * extension's equality bound; a column no B-tree holds left a filter; a derived table joined to an earlier item by a
 * hash; a derived table read per earlier row at its stored read's key.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { bindSelect } from "#compiler/sql/bind.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { levelItems } from "#compiler/sql/plan.ts"
import {
	type BindFeature,
	bindCaseGen,
	bindFeatures,
	catalog,
	itemOf,
	specified,
	statementOf,
	topJoins,
	tReadsOf
} from "#test/unit/sql/bind.fixtures.ts"

/** Every read of T is bound as its level fixes it, where it stands, under the scope's one alias. */
export const everyReadIsBoundAsItsLevelFixesItWhereItStandsUnderTheScopesOneAlias =
	property.explore(bindCaseGen, {
		needs: {},
		situations: bindFeatures,
		check: (_, c: Case<BindFeature>) => (drawn) =>
			Effect.sync(() => {
				const bound = bindSelect(statementOf(drawn), new AdviceScope(), catalog)
				const [read, ...others] = tReadsOf(bound.statement)
				if (read === undefined || others.length > 0) {
					assert.fail("the bound statement reads T once")
				}
				const item = Option.getOrUndefined(itemOf(bound.plan, read.alias))
				if (item === undefined) {
					assert.fail(`the plan names T's read ${read.alias}`)
				}
				const spec = specified(drawn)
				const scan = item.scan
				assert.deepEqual(
					scan.kind === "index"
						? { kind: "index", probe: read.probe, bound: [...scan.bound] }
						: { kind: scan.kind === "seq" ? "whole" : scan.kind },
					spec.kind === "index"
						? { kind: "index", probe: spec.probe, bound: [...spec.bound] }
						: spec,
					"T's read is bound as the specification says"
				)
				const aliases = Arr.map(
					Arr.flatMap(bound.plan.levels, (level) => [...levelItems(level), ...level.appended]),
					(i) => i.alias
				)
				assert.deepEqual(
					Arr.sort(Arr.dedupe(aliases), Order.String),
					Arr.sort(aliases, Order.String),
					"every alias the plan names is named once"
				)
				for (const a of aliases) {
					assert.ok(
						Str.startsWith("r")(a) && Number.isInteger(Number(Str.slice(1)(a))),
						`the plan's alias ${a} is the scope's`
					)
				}
				const held = Arr.filter(drawn.fixed, (f) => f !== "d")
				switch (drawn.place.kind) {
					case "top":
						if (spec.kind === "index") {
							c.note("a seek at a literal")
							if (drawn.ranged && !Arr.contains(held, "b") && !Arr.contains(held, "a")) {
								c.note("a seek's range past its bound columns")
							}
						} else if (Arr.contains(held, "f")) {
							c.note("a whole read of few values alone")
						}
						break
					case "driven":
						c.note("a probe driven by an earlier item")
						break
					case "sublink":
						c.note("a seek at an enclosing level's column")
						break
					case "window":
						c.note(
							drawn.place.at === "a"
								? "a seek beneath a window, at its partition"
								: "a whole read beneath a window, at no partition"
						)
						break
					case "joined": {
						const joins = topJoins(bound.statement, bound.plan)
						if (drawn.place.over === "stored") {
							assert.deepEqual(
								joins,
								{ lateral: [true], where: false, hashed: false },
								"T's groups are read per row of S at T's key, the join's condition their read's binding"
							)
							c.note("a derived table read per earlier row at its stored read's key")
						} else {
							assert.deepEqual(
								joins,
								{ lateral: [false], where: true, hashed: true },
								"the groups of T's rows are derived once, joined to S by a hash at a condition their level keeps"
							)
							c.note("a derived table joined to an earlier item by a hash")
						}
						break
					}
				}
				if (Arr.contains(held, "v")) {
					c.note("an extension's equality bound")
				}
				if (Arr.contains(drawn.fixed, "d")) {
					c.note("a column no B-tree holds left a filter")
				}
			}),
		oracle: { kind: "specification", name: "the contract's binding rules (CARRY-CONTRACT §1)" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\tif (joins && !lateral && !this.#keyedBy(query, written, c)) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "A set join's condition pushed into the derived table it joins, which then reads a CTE's rows again at each row of S: the groups are LATERAL and joined by no hash, as read-once's CTE scan ran 52 times for 1,800 rows each."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\tif (joins && !lateral && !this.#keyedBy(query, written, c)) {\n",
				replacement: "\t\t\tif (joins && !lateral) {\n",
				why: "No join's condition keys the derived table's stored read: groups of T joined to S at b derive every group and hash them, where each row of S needs its group alone, read at T's key."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\tif (table !== undefined && bindings.some((b) => b.driven)) {\n",
				replacement:
					'\t\tif (table !== undefined && bindings.some((b) => b.driven && b.op === "in")) {\n',
				why: "A read bound to a column of an item before it is read as a seek of its fixed columns or whole, a join filter where PostgreSQL could read its index at each row before it."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\tif (c.kind === "binary" && c.op === "=") {\n',
				replacement: '\tif (c.kind === "binary" && c.op === "=" && c.schema === undefined) {\n',
				why: "An equality through an extension's operator binds nothing: a read of T at its vector v is read without it, an index of the other columns alone."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t\treturn d !== undefined && d.depth < here.depth\n",
				replacement: "\t\t\t\treturn false\n",
				why: "An enclosing level's column fixes nothing: the probe beneath S's EXISTS reads T whole at each row of S, where its key is fixed."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t!windows.every((w) => w.includes(text(t.expr)))\n",
				replacement: "\t\t\twindows.length > 0\n",
				why: "No reader's equality enters a query that calls a window function: an attachment's take per partition, read at its parent's partition, reads T whole."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t!windows.every((w) => w.includes(text(t.expr)))\n",
				replacement: "\t\t\tfalse\n",
				why: "A reader's equality of a column no window partitions by is pushed beneath the window, which then numbers the rows of a cut partition: the read's results change."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\tif (ranged !== undefined) {\n",
				replacement: "\t\tif (ranged === undefined && ranged !== undefined) {\n",
				why: "A read's range is left a filter: the read is a seek of its bound columns alone, reading every row at them, or whole where it binds none, where its range bounds them."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\t\t\t\t\t\tif (b === undefined || btreeColumn(table, b.column) === undefined) {\n",
				replacement: "\t\t\t\t\t\t\tif (b === undefined) {\n",
				why: "An equality of a column no B-tree holds is bound: the read asks an index of a column no B-tree keys, an internal compiler error of the binding's."
			}
		]
	})
