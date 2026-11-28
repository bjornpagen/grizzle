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
 * a or of b, or inside T's groups by b that S is joined to at b, or in a fenced arm of a UNION nested in another's arm
 * that S's EXISTS equates at a with S's key, at a drawn set of literal equalities of a, b, f, v and
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
 * a whole view read twice at one level, the second a level of its own; a reader's conjunct moved through every arm of a
 * fenced UNION nested in another's arm, binding the read there; a probe of a group in its order and of its last row, each
 * an ordered seek of its group then its order, and one in an order no B-tree holds, an internal compiler error.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { nameKey } from "#compiler/sql/ast.ts"
import { bindSelect } from "#compiler/sql/bind.ts"
import { col, keyedSet, select, table, target } from "#compiler/sql/build.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { levelItems, planRequests, scannedItems } from "#compiler/sql/plan.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { codebookOfStates } from "#test/support/closed/generate.ts"
import { owning } from "#test/support/policy.ts"
import {
	installationOf,
	schemaOf,
	states,
	worldGen
} from "#test/support/unit/physical/constants.fixtures.ts"
import {
	type BindFeature,
	bindAims,
	bindCaseGen,
	bindFeatures,
	boundAccess,
	boundMet,
	catalog,
	contextLevel,
	existsFenced,
	firstItemOf,
	itemOf,
	joinedMembers,
	printedTwiceOf,
	seekConditionsOf,
	specified,
	statementOf,
	topJoins,
	tReadsOf,
	type TwicePlace,
	tViewAlias,
	twiceCaseGen,
	viewedLevels,
	worldTAlias
} from "#test/unit/sql/bind.fixtures.ts"

/** Every read of T is bound as its level fixes it, where it stands, under the scope's one alias. */
export const everyReadIsBoundAsItsLevelFixesItWhereItStandsUnderTheScopesOneAlias =
	property.explore(aimed(bindCaseGen, bindAims), {
		needs: {},
		situations: bindFeatures,
		check: (_, c: Case<BindFeature>) => (drawn) =>
			Effect.sync(() => {
				if (drawn.place.kind === "ordered" && drawn.place.order === "d") {
					assert.throws(
						() => bindSelect(statementOf(drawn), new AdviceScope(), catalog),
						(e) =>
							Str.includes("in an order of d, which no B-tree column of its table holds")(
								String(e)
							),
						"a probe of T's group in an order of d, which no B-tree holds, is an internal compiler error"
					)
					c.note("a probe in an order no B-tree holds, an internal compiler error")
					return
				}
				const bound = bindSelect(statementOf(drawn), new AdviceScope(), catalog)
				if (drawn.place.kind === "ordered") {
					const requests = Arr.filter(planRequests(bound.plan), (r) => r.relation === "T")
					assert.deepEqual(
						Arr.map(requests, (r) => ({
							use: r.use,
							keys: Arr.map(r.keys, (k) => k.expr),
							fixed: r.fixed
						})),
						[{ use: "take seek", keys: ["b", "a"], fixed: 1 }],
						"T's group at b probed in its order of a is an ordered seek of b then a, which an index holding a after b serves"
					)
					c.note(
						drawn.place.how === "last"
							? "a probe of a group's last row, an ordered seek of its group then its order"
							: "a probe of a group in its order, an ordered seek of its group then its order"
					)
					return
				}
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
				if (drawn.place.kind === "hashed") {
					const [read] = Arr.flatMap(bound.plan.levels, (level) =>
						level.name.kind === "top" ? scannedItems(level) : []
					)
					const request = read?.scan.kind === "index" ? read.scan.index : undefined
					const access = boundAccess(bound.statement)
					assert.deepEqual(
						{
							use: request?.use,
							keys: Arr.map(request?.keys ?? [], (k) => k.expr),
							access: access?.kind,
							row: access?.kind === "row" ? [...access.columns] : []
						},
						drawn.place.both
							? { use: "row equality", keys: ["p", "q"], access: "row", row: ["p", "q"] }
							: { use: "equality lookup", keys: ["p"], access: "seek", row: [] },
						"U's byte strings bound together are one equality of their row, read through the hash index over it; one alone an equality lookup"
					)
					c.note(
						drawn.place.both
							? "byte strings bound together, one equality of their row"
							: "one byte string bound alone, an equality lookup"
					)
					return
				}
				if (drawn.place.kind === "met") {
					const met = Option.getOrUndefined(boundMet(bound.statement))
					if (met === undefined) {
						assert.fail("the bound statement reads its met rows at its top")
					}
					const marked: ReadonlyArray<ReadonlyArray<string>> = Arr.flatMap(
						bound.plan.levels,
						(level) =>
							level.kind === "joins" &&
							level.name.kind === "named" &&
							level.name.name === met.marked
								? [[firstItemOf(level.problem).alias, ...Arr.map(level.appended, (i) => i.alias)]]
								: []
					)
					const top: ReadonlyArray<string> = Arr.map(viewedLevels(bound.plan).top, (i) => i.alias)
					assert.deepEqual(
						{ top, marked },
						{ top: [met.marked], marked: [[met.sides, met.scan, met.returned]] },
						"the met rows' marked rows are the reader's item, planned apart reading their sides, the append relation of both arms"
					)
					const own = [met.marked, met.sides, met.scan, met.returned]
					assert.ok(
						Arr.every(own, (a) => Str.startsWith("r")(a)) && Arr.dedupe(own).length === own.length,
						`each of the met rows' own names is the scope's, once (${Arr.join(own, ", ")})`
					)
					c.note("an INSERT's met rows planned apart under the scope's names")
					return
				}
				if (drawn.place.kind === "world") {
					const { top } = viewedLevels(bound.plan)
					const [reference, ...beside] = top
					const inner = Arr.flatMap(bound.plan.levels, (level) =>
						reference !== undefined &&
						level.name.kind === "named" &&
						level.name.name === reference.alias
							? levelItems(level)
							: []
					)
					const spec = specified(drawn)
					assert.deepEqual(
						{
							reference: reference?.scan.kind,
							beside: beside.length,
							inner: Arr.map(inner, (i) => ({
								alias: String(i.alias),
								scan:
									i.scan.kind === "index"
										? { kind: "index", probe: false, bound: [...i.scan.bound] }
										: { kind: i.scan.kind === "seq" ? "whole" : i.scan.kind }
							}))
						},
						{
							reference: "rows",
							beside: 0,
							inner: [
								{
									alias: worldTAlias(),
									scan:
										spec.kind === "index"
											? { kind: "index", probe: false, bound: [...spec.bound] }
											: { kind: spec.kind }
								}
							]
						},
						"a read of T's world view plans its body under the reference's alias, T named as its body names it"
					)
					c.note(
						drawn.place.leaky
							? "a world view's read whose qual its barrier keeps out"
							: "a world view's read planned under its body's aliases, the reader's qual pushed past its barrier"
					)
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
				const aliases = Arr.map(Arr.flatMap(bound.plan.levels, scannedItems), (i) => i.alias)
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
				const conditions = seekConditionsOf(bound.statement)
				assert.deepEqual(
					[...Arr.dedupe(conditions)],
					[...conditions],
					"a conjunct stated twice binds T's seek once, never an index condition and a filter of one column"
				)
				switch (drawn.place.kind) {
					case "exists": {
						const top = Arr.flatMap(bound.plan.levels, (level) =>
							level.kind === "joins" && level.name.kind === "top" ? [level] : []
						)
						const joined = Arr.flatMap(top, (level) =>
							Arr.map(joinedMembers(level.problem), (j) => j.join)
						)
						if (drawn.place.pinned) {
							assert.deepEqual(
								joined,
								["nestedLoop"],
								"the NOT EXISTS whose equality's level side S's key is fixed at the level is an anti join PostgreSQL pairs by nothing, its clause thrown back as TRUE (equivclass.c reconsider_outer_join_clauses), so its set joins by a nested loop"
							)
							c.note("a NOT EXISTS whose level side its level fixes, anti-joined by a nested loop")
						} else if (drawn.place.not) {
							assert.deepEqual(
								joined,
								["hash"],
								"the NOT EXISTS of a set is an anti join of the level, its set hashed after S"
							)
							c.note("a NOT EXISTS of a set PostgreSQL anti-joins, hashed after its level's items")
						} else {
							assert.ok(
								joined.length === 0 && existsFenced(bound.statement),
								"the EXISTS of a set reads it through one fenced item, a subplan PostgreSQL makes no join of"
							)
							c.note("an EXISTS of a set read through a fenced item, a subplan")
						}
						if (drawn.place.over === "values") {
							assert.ok(
								Str.includes(" OFFSET 0) AS ")(printStatement(bound.statement)),
								"the VALUES list is fenced, planned apart under its alias"
							)
							c.note("a VALUES list fenced, planned apart under its alias")
						}
						break
					}
					case "fenced": {
						const joins = topJoins(bound.statement, bound.plan)
						assert.deepEqual(
							joins,
							{ lateral: [true], where: false, hashed: false },
							"the level's conjunct over T's fenced rows and S moves beneath the fence, binding T there"
						)
						c.note("a reader's conjunct moved beneath a fence, binding the read there")
						break
					}
					case "union": {
						const appends = Arr.flatMap(bound.plan.levels, (level) =>
							level.kind === "append" ? [level] : []
						)
						const topItems = Arr.flatMap(bound.plan.levels, (level) =>
							level.kind === "joins" && level.name.kind === "top"
								? [[firstItemOf(level.problem).alias, ...Arr.map(level.appended, (i) => i.alias)]]
								: []
						)
						const members: ReadonlyArray<string> =
							drawn.place.at === "top"
								? Arr.flatMap(appends, (level) =>
										level.name.kind === "top" ? Arr.map(level.members, (i) => i.alias) : []
									)
								: Arr.flatMap(topItems, (aliases) => aliases.slice(1))
						const named = new Set<string>(
							Arr.flatMap(bound.plan.levels, (level) =>
								level.kind === "joins" && level.name.kind === "named" ? [level.name.name] : []
							)
						)
						assert.ok(
							members.length === 2 &&
								Arr.every(members, (m) => named.has(m)) &&
								(drawn.place.at === "top"
									? appends.length === 1 && topItems.length === 0
									: appends.length === 0 && topItems.length === 1),
							`each arm of the UNION ALL is one member, planned apart under its alias, of the append relation ${drawn.place.at === "top" ? "of the statement's level" : "of its reader's item"} (members ${Arr.join(members, ", ")})`
						)
						c.note(
							drawn.place.at === "top"
								? "a UNION ALL's append level, each arm's one item a member"
								: drawn.place.at === "derived"
									? "a derived UNION ALL's members appended to its reader's item"
									: "a derived UNION ALL in parentheses, its members appended to its reader's item"
						)
						if (spec.kind === "whole" && Arr.contains(held, "f")) {
							c.note("a whole read of few values alone")
						}
						break
					}
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
					case "nested":
						c.note(
							"a reader's conjunct moved through every arm of a fenced UNION nested in another's arm, binding the read there"
						)
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
				original:
					"\t\t\t).some(\n\t\t\t\t([i, o]) => readsWithin(read(i), inner) && readsWithin(read(o), outer) && !fixedSide(o)\n",
				replacement:
					"\t\t\t).some(\n\t\t\t\t([i, o]) => readsWithin(read(i), inner) && readsWithin(read(o), outer)\n",
				why: "An outer join's equality keys a hash where its outer side's class holds a fixed value: PostgreSQL throws the clause back as TRUE (equivclass.c reconsider_outer_join_clauses), so page-keys' dashboardJoined window carried HASH_JOIN(r15@r10), the NOT EXISTS over (VALUES (10)) at r12.c55 beside r12.c55 = 7, which PostgreSQL could not plan (Law 1: matched, failed, its Nested Loop disabled)."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t? pulledUnion(q.body)\n",
				replacement: "\t\t? false\n",
				why: "A derived UNION ALL in parentheses is bound as a level of its own, an append level named by the derived table's alias, where PostgreSQL's parser reads the parentheses as the UNION ALL itself and pulls its members up into the reader's level: serving's read of A's boolean key beside Task's span carried NO_GATHER(r3@r2), PostgreSQL planning NO_GATHER(r3@r1)."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\trs.length > 0 &&\n",
				replacement: "\t\t\trs.length > 99 &&\n",
				why: "Byte strings bound together are bound one equality each, which no index serves: the index engine refuses the lookup, where the binding states one equality of their row that a hash index over it serves."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\tif (c.kind !== "exists" || !c.not) {\n',
				replacement: '\t\tif (c.kind !== "exists" || c.not) {\n',
				why: "A NOT EXISTS PostgreSQL makes an anti join of its level names no item there: its set is joined by a hash the advice carries no JOIN_ORDER or HASH_JOIN of (LAWS' Law 1 on existence-witness's fold by count, JOIN_ORDER(v1 r6), HASH_JOIN(r6))."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\t\tthis.#joinedBy(q, env) === undefined\n\t\t\t\t? this.sublink(q, env)\n\t\t\t\t: this.query(wrapper(q, false), env, undefined)\n",
				replacement: "\t\t\tthis.sublink(q, env)\n",
				why: "An EXISTS of a set correlated in its WHERE is left as written: PostgreSQL makes it a semi join of the level, whose order, method and unique form no advice carries."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					'\t\t(q.offset !== undefined && (past === "nothing" || !fenceOnly(q.offset))) ||\n',
				replacement: "\t\tq.offset !== undefined ||\n",
				why: "A level's conjunct over a fenced LATERAL derived table and an item before it stays the join's condition: its derived read is unbound beneath the fence, and the join reads the bound column of the item before it in its condition (LAWS' Law 2 on cross-step, v1@r11.path)."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\t\t\t"take seek"\n',
				replacement: '\t\t\t\t"join key"\n',
				why: "A probe of a group in its order, or of its last row, asks for a lookup of its group and order columns, each fixed by equality in any order, which an index of its order first and its group after serves: read through it, the probe reads every row of its group and sorts them for each row it is driven by, as replace-cost's counted family read its tags' last index for each tag it appended (10,300, 40,600 and 161,200 rows at 100, 200 and 400 tags, lane REDS5's diagnosis at main 83aaa65f), where the ordered seek reads one row."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\tif (one === undefined || two === undefined || !isDefinedEach(rest)) {\n",
				replacement: "\t\t\tif (true) {\n",
				why: "A reader's conjunct over a set operation is pushed into none of its arms: a fenced UNION nested in another's arm reads its stored rows whole, as rule-whole's reach of a region's roots read every node of every document for each write's judgement (10,017 rows at 2,500 documents, 20,017 at 5,000; INDEX_SCAN(node_ix_kind) and SEQ_SCAN where the region's document binds the read)."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: 'const valuesFence = " OFFSET 0"\n',
				replacement: 'const valuesFence = ""\n',
				why: "A VALUES list in FROM unfenced: PostgreSQL pulls it up into its level as `*VALUES*`, which no advice names, and the join order naming its alias is partially matched (LAWS' Law 1 on ready-keys' guard, JOIN_ORDER(v4@r22 r24@r22))."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					'\t\t\t\tif (b.op === "UNION ALL" && name !== undefined && !this.#recursions.has(b)) {\n',
				replacement: "\t\t\t\tif (name === undefined && name !== undefined) {\n",
				why: "A UNION ALL's query names no append level: PostgreSQL flattens it into an append relation of its arms' items, whose NO_GATHER no advice carries (LAWS' Law 1 on cross-step's and held-scope's served reads, NO_GATHER(r3), NO_GATHER(r5))."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\tappended: bound.items\n",
				replacement: "\t\t\tappended: []\n",
				why: "A derived UNION ALL PostgreSQL pulls up into its reader's level carries no member: each arm's item is planned in the reader's append relation, unadvised."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\t\t\treturn { ...read, item: { alias: marked, scan: { kind: "rows" } } }\n',
				replacement: "\t\t\t\treturn read\n",
				why: "The met rows' reader's item named by their source's alias, a query PostgreSQL pulls up into the reader's level: the level's join order and NO_GATHER name a relation PostgreSQL never plans there, and the marked rows it plans in its place go unadvised (LAWS' Law 1 on key-reach's writeWhole, NO_GATHER(r10#2@r3))."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t\tconst scan = this.#alias(source.scan)\n",
				replacement: "\t\t\t\tconst scan = sides\n",
				why: "The met rows' proposed side named as their sides: two relations of the marked rows' level share one alias, PostgreSQL numbers the second's occurrence, and an atom naming either matches both (Law 3)."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\tconst scope = new ViewScope(view.ordinal)\n\t\tconst nested = new Binder(scope, this.#catalog, this.#reads)\n",
				replacement:
					"\t\tconst scope = new ViewScope(view.ordinal + 1)\n\t\tconst nested = new Binder(scope, this.#catalog, this.#reads)\n",
				why: "A world view's body planned under another view's scope: its reads are named by aliases its installed body does not hold, and the advice of a read of it names no relation PostgreSQL plans."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\tlet query: OperandSelect = namedQuery(view.prepared, view.columns)\n",
				replacement: "\t\tlet query: OperandSelect = view.prepared\n",
				why: "A reader's qual is pushed into a world view's body by the body's own output names, not the view's: a qual of a view column its definition names otherwise finds no output, stays above the barrier PostgreSQL pushes it past, and the body is planned whole where PostgreSQL reads its table at the key."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t\t!passesBarrier(c, written, view.leaky) ||\n",
				replacement: "\t\t\t\ttrue ||\n",
				why: "No reader's qual passes a world view's barrier: the body is planned whole where PostgreSQL pushes the leakproof equality in and reads its table at the key, so the carried scan is not the one PostgreSQL runs."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\tpasses &&= table !== written || !leaky.has(column)\n",
				replacement: "\t\tpasses &&= true\n",
				why: "A qual of a leaky column pushed past a world view's barrier, which PostgreSQL keeps above it: the body's table is planned at a key PostgreSQL never binds."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> => distinctConjuncts(conjunctsIn(e))\n",
				replacement:
					"const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> => conjunctsIn(e)\n",
				why: "A conjunct a lowering states twice binds a read twice: PostgreSQL makes one an index condition and the other a filter of the same column (LAWS' Law 2 on ready-keys: `v1.number is bound, read outside its index condition`)."
			},
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
 * (test/support/unit/physical/constants.fixtures.ts): a login whose full role, reader and tagger hold Item and Tags whole.
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

/**
 * A read printed twice in one statement is an internal compiler error of its binding (sql/scope.ts, the scope walk, which
 * holds every statement as its lowering built it before print once or the binding rewrite it): a
 * statement that reads T's probe in two places, two conjuncts, two arms of a union, or a target and the order, through
 * one query object both places share is refused as a read printed twice, and the same statement with each place's own
 * probe binds, reading T once in each place, under two aliases of the scope. Law 3 by construction: a shared subtree,
 * which reads its rows twice and writes each alias in it twice, never reaches a printer (the nearest search's keyed
 * query vector, one subquery in its order and in its delivered distance; a family's recount, one NOT EXISTS in two arms
 * of its union).
 *
 * Oracle: the specification: a query body stands at one place of its statement.
 */
export const aReadPrintedTwiceInOneStatementIsAnInternalCompilerErrorOfItsBinding =
	property.exhaust(finite(twiceCaseGen), {
		needs: {},
		situations: [
			"two conjuncts",
			"two arms",
			"a target and the order",
			"shared and refused"
		] satisfies ReadonlyArray<TwicePlace | "shared and refused">,
		check: (_, c: Case<TwicePlace | "shared and refused">) => (drawn) =>
			Effect.sync(() => {
				const bind = () => bindSelect(printedTwiceOf(drawn), new AdviceScope(), catalog)
				if (drawn.shared) {
					assert.throws(
						bind,
						(e) => Str.includes("a read printed twice in one statement")(String(e)),
						`${drawn.place}: one probe read in both places is refused at its binding`
					)
					c.note("shared and refused")
					return
				}
				const bound = bind()
				const tAliases = Arr.flatMap(bound.plan.levels, (level) =>
					Arr.flatMap(levelItems(level), (item) =>
						item.scan.kind === "index" && item.scan.index.relation === "T"
							? [String(item.alias)]
							: []
					)
				)
				assert.equal(
					new Set(tAliases).size,
					2,
					`${drawn.place}: each place's own probe binds, T read once in each under an alias of its own (${Formatter.format(tAliases)})`
				)
				c.note(drawn.place)
			}),
		oracle: {
			kind: "specification",
			name: "a query body stands at one place of its statement: one read in two places is two reads, each place's own"
		},
		box: "T's probe in two conjuncts, two arms of a union, or a target and the order, shared by both places or each place's own",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/scope.ts",
				original: "\t\t\tif (this.#printed.has(core)) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "A query body met twice binds twice: one probe of T shared by two places prints twice, its rows read twice and its aliases written twice, and the binding refuses nothing."
			}
		]
	})

/**
 * A read of PostgreSQL's system catalog is planned as one (sql/plan.ts PlanScan `catalog`), alone at its level: the
 * session tables' standing and overgrowth (sql/print.ts sessionTablesStanding, sessionTableOvergrown) read pg_class, the
 * live source's slot drop pg_replication_slots, each by PostgreSQL's costs over the catalog's real statistics, which no
 * advice holds; a level joining a catalog's relation to another, a join no plan of grizzle's states, is an internal
 * compiler error. Over pg_class read alone and read beside T.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aReadOfTheSystemCatalogIsPlannedAsOneAloneAtItsLevel = property.exhaust(
	finite((source) => source.draw(element(["alone", "beside T"] as const))),
	{
		needs: {},
		situations: ["a catalog's relation read alone", "a catalog's relation joined to another"],
		check:
			(_, c: Case<"a catalog's relation read alone" | "a catalog's relation joined to another">) =>
			(place) =>
				Effect.sync(() => {
					const statement = select(
						keyedSet(
							[target(col("c", "relname"))],
							place === "alone"
								? [table("pg_catalog", "pg_class", "c")]
								: [table("pg_catalog", "pg_class", "c"), table("app", "t", "t")],
							undefined,
							"a read of pg_class"
						)
					)
					if (place === "beside T") {
						c.note("a catalog's relation joined to another")
						assert.throws(
							() => bindSelect(statement, new AdviceScope(), catalog),
							(e: unknown) => Str.includes("system catalog")(String(e)),
							"a level joining pg_class to T is an internal compiler error"
						)
						return
					}
					c.note("a catalog's relation read alone")
					const bound = bindSelect(statement, new AdviceScope(), catalog)
					assert.deepEqual(
						Arr.flatMap(bound.plan.levels, (level) =>
							Arr.map(scannedItems(level), (i) => i.scan.kind)
						),
						["catalog"],
						"pg_class is read as a catalog's relation, the level's one item"
					)
				}),
		oracle: {
			kind: "specification",
			name: "a system catalog's relation, its schema pg_catalog's, is PostgreSQL's to plan, alone at its level"
		},
		box: "pg_class read alone and beside T",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					'\t\t\t\t\tscan: systemCatalog(source.table) ? { kind: "catalog" } : { kind: "rows" }\n',
				replacement: '\t\t\t\t\tscan: { kind: "rows" }\n',
				why: "A read of the system catalog is planned as a session table's rows: its advice holds a NO_GATHER of it, and Law 1 and the budget judge PostgreSQL's cost choice of a relation grizzle proves no plan of."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\tif (catalog !== undefined && bound.length + antis.length > 1) {\n",
				replacement: "\t\tif (false) {\n",
				why: "A level joins a catalog's relation to another: the join stands in a plan grizzle carries advice for, of a relation PostgreSQL chooses the plan of."
			}
		]
	}
)
