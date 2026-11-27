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
 * scope's, once; a read through T's whole view is planned under the alias its body names T by (sql/naming.ts
 * wholeViewAlias), which PostgreSQL plans T under once it flattens the view, bound as T's, and a second read of the view
 * at its level is a level of its own, T planned there under that alias; and groups joined to S are read per row of S at
 * T's key where they group T itself, and where they group
 * a CTE of T's rows are derived once, no LATERAL, their join's condition left their level's and the level joining them
 * by a hash, never derived again for each row of S (read-once's CTE scan run 52 times, 1,800 rows each).
 *
 * Oracle: the specification of the contract's binding rules (CARRY-CONTRACT §1).
 *
 * Features: a seek at a literal; a whole read of few values alone; a probe driven by an earlier item; a seek at an
 * enclosing level's column; a seek beneath a window at its partition, and a whole read beneath it at no partition; an
 * extension's equality bound; a column no B-tree holds left a filter; a derived table joined to an earlier item by a
 * hash; a derived table read per earlier row at its stored read's key; a whole view's read named by its body's alias;
 * a whole view read twice at one level, the second a level of its own.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { nameKey } from "#compiler/sql/ast.ts"
import { bindSelect } from "#compiler/sql/bind.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { levelItems } from "#compiler/sql/plan.ts"
import { codebookOfStates } from "#test/support/closed/generate.ts"
import { owning } from "#test/support/policy.ts"
import {
	installationOf,
	schemaOf,
	states,
	worldGen
} from "#test/unit/physical/constants.fixtures.ts"
import {
	type BindFeature,
	bindCaseGen,
	bindFeatures,
	catalog,
	contextLevel,
	itemOf,
	specified,
	statementOf,
	topJoins,
	tReadsOf,
	tViewAlias,
	viewedLevels
} from "#test/unit/sql/bind.fixtures.ts"

/** Every read of T is bound as its level fixes it, where it stands, under the scope's one alias. */
export const everyReadIsBoundAsItsLevelFixesItWhereItStandsUnderTheScopesOneAlias =
	property.explore(bindCaseGen, {
		needs: {},
		situations: bindFeatures,
		check: (_, c: Case<BindFeature>) => (drawn) =>
			Effect.sync(() => {
				const bound = bindSelect(statementOf(drawn), new AdviceScope(), catalog)
				if (drawn.place.kind === "context") {
					const { source, levels } = contextLevel(bound.statement, bound.plan)
					const inner = Option.match(source, { onNone: () => "none", onSome: (s) => s.inner })
					assert.ok(
						inner !== "m" &&
							Str.startsWith("r")(inner) &&
							Arr.length(levels) === 1 &&
							Arr.every(levels, (aliases) => aliases.length === 1 && aliases[0] === inner),
						`the context's claims row is ${inner}, the scope's, the one item of the level its alias names (${Formatter.format(levels)})`
					)
					c.note("a context source's row named by the scope, its level's one item")
					return
				}
				if (drawn.place.kind === "viewed") {
					const { top, named } = viewedLevels(bound.plan)
					const [first, ...rest] = top
					const spec = specified(drawn)
					assert.deepEqual(
						first === undefined
							? undefined
							: {
									alias: first.alias,
									scan:
										first.scan.kind === "index"
											? { kind: "index", probe: false, bound: [...first.scan.bound] }
											: { kind: first.scan.kind === "seq" ? "whole" : first.scan.kind }
								},
						{
							alias: tViewAlias,
							scan:
								spec.kind === "index"
									? { kind: "index", probe: false, bound: [...spec.bound] }
									: { kind: spec.kind }
						},
						"T's read through its whole view is planned under its body's alias, bound as T's"
					)
					c.note("a whole view's read named by its body's alias")
					if (spec.kind === "whole" && Arr.contains(drawn.fixed, "f")) {
						c.note("a whole read of few values alone")
					}
					if (drawn.place.reads === 2) {
						assert.ok(
							rest.length === 1 &&
								Arr.every(rest, (i) => i.alias !== tViewAlias && i.scan.kind === "rows") &&
								Arr.some(named, (aliases) => aliases[0] === tViewAlias && aliases.length === 1),
							"the second read of T's whole view at its level is a level of its own, T planned there under its body's alias"
						)
						c.note("a whole view read twice at one level, the second a level of its own")
					}
					return
				}
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
				original: "\t\t\t\tconst inner = this.#alias(source.inner)\n",
				replacement: "\t\t\t\tconst inner = source.inner\n",
				why: "A context source's claims row keeps the name its lowering wrote, `m` in every statement, which no scope minted: two contexts' rows in one scope share it, and the advice names neither (ready-keys' Law 1)."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\t\titem: { alias: stored === undefined ? alias : itemAlias(stored, alias), scan: bound.scan },\n",
				replacement: "\t\t\titem: { alias, scan: bound.scan },\n",
				why: "A read through a whole view planned under the reference's alias, which PostgreSQL names no relation by once it flattens the view: the advice's scan of it matches nothing, and the table is planned by cost (LAWS' Law 1 on cross-step's served read: no scan atom for any of its four view reads)."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\tif (stored?.kind !== "view" || !viewed.has(stored.view.alias)) {\n',
				replacement: "\t\tif (true) {\n",
				why: "A whole view read twice at one level is read there twice: PostgreSQL plans its table under one alias twice, an occurrence it numbers, and the advice names both reads by one target."
			},
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
				original: "\t\tif (stored !== undefined && bindings.some((b) => b.driven)) {\n",
				replacement:
					'\t\tif (stored !== undefined && bindings.some((b) => b.driven && b.op === "in")) {\n',
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

/**
 * Every whole view an installation creates names its table, in its body, by the alias the binding's catalog reads it
 * under (physical/ddl/roles.ts wholeView, physical/access/catalog.ts wholeViewAliases, sql/bind.ts BindView `whole`): the
 * one name PostgreSQL plans the table under once it flattens the view into the level that reads it, so the advice a
 * read of the view carries names the relation PostgreSQL plans. Over the constants world's installations
 * (test/unit/physical/constants.fixtures.ts): a login whose full role, reader and tagger hold Item and Tags whole.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const everyWholeViewNamesItsTableByTheAliasTheBindingReadsItUnder = property.explore(
	worldGen,
	{
		needs: {},
		situations: ["a whole view read through its body's alias"],
		check: (_, c: Case<"a whole view read through its body's alias">) => (w) =>
			Effect.sync(() => {
				const i = installationOf(owning(schemaOf(w)), codebookOfStates(states(w)))
				for (const view of i.statements) {
					if (view.kind !== "createView" || view.barrier) {
						continue
					}
					const body = view.query.body
					const from = body.kind === "core" ? body.from : []
					const read = i.catalog.view(nameKey(view.name))
					assert.deepEqual(
						Arr.map(from, (item) => (item.kind === "table" ? item.alias : item.kind)),
						[read?.kind === "whole" ? read.alias : "no whole view the catalog reads"],
						`the whole view ${view.name.name} names its table by the alias the binding reads it under`
					)
					c.note("a whole view read through its body's alias")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the binding's catalog of the installation, which reads each whole view's table under its alias"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\t\t\t\t[table(source.schema, source.name, alias)],\n",
				replacement: '\t\t\t\t[table(source.schema, source.name, "r1")],\n',
				why: "A whole view's body names its table by a scope's `r1`, which PostgreSQL plans the table under once it flattens the view: every read of the view carries advice naming the view's alias, which matches no relation (LAWS' Law 1 on cross-step's served read)."
			}
		]
	}
)
