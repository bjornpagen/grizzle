/**
 * A level's join tree (sql/bind.ts levelJoins): the binding states each level's join problem as the tree PostgreSQL's
 * join search builds (joinrels.c join_search_one_level), so the plan advice holding PostgreSQL to it names an order
 * PostgreSQL can build. PostgreSQL joins a set of relations to one it is linked to (a clause reads both, an equivalence
 * class holds a member of each, or one reads the other laterally), and to one it is not only where the set is linked to
 * nothing at all; a relation reading another laterally joins on the inner side of a join whose outer side holds it, or
 * within a group that join builds on its inner side. Magic-sets' read by slot, `course r1, LATERAL (seat at $2) r2,
 * LATERAL (seat_grade at r1's and r2's columns) r4`, carried JOIN_ORDER(v3 r2 r4), whose join of v3 and r2 PostgreSQL
 * never builds (its plan JOIN_ORDER(v3 (r2 r4))), and page-keys' dashboard windows the same (JOIN_ORDER(v4@r10 (r12@r10
 * r13@r10) r15@r10)).
 *
 * A case draws a level of one to twelve entries, each a scan of one MATERIALIZED CTE or a LATERAL derived table of its
 * scan fenced by OFFSET 0, with clauses between drawn pairs (equalities and orders), each the level's where its later
 * entry is a scan and a lateral read of the earlier where it is a derived table, and CTE scans' columns fixed by a
 * parameter.
 *
 * Property, for every level: the top level's tree holds every entry once; past join_collapse_limit its first eight
 * entries are a problem of their own, the first member of the next, and so on (initsplan.c deconstruct_recurse); in
 * each join every member's lateral reads are held by the members before it or by an enclosing join's, every member is
 * linked to the members before it unless those are linked to nothing outside them (or, the first join of two entries,
 * the second is, PostgreSQL trying each entry's joins at its search's first level), or hold every entry of their problem
 * linked to nothing and are linked to none of the rest, which PostgreSQL's last-ditch join joins clauselessly
 * (joinrels.c join_search_one_level), and a level linked left-deep in its
 * FROM's order is joined in that order, flat; a member reading the members before it laterally joins by a nested loop,
 * and a set join by a hash exactly where a class of no fixed value holds a member of it and one of the members before
 * it (equivclass.c generate_join_implied_equalities).
 *
 * Oracle: a specification, the links, lateral reads and classes read off the drawn level (join-tree.fixtures.ts
 * levelFacts), apart from the binding's.
 *
 * Features: a level linked left-deep; an entry reading one nothing before it is linked to, joined in a group; a cross
 * product; a level past join_collapse_limit; a set join hashed and one whose classes hold fixed values; a group read by
 * a nested loop.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import type { FromSource, Select } from "#compiler/sql/ast.ts"
import { bindSelect } from "#compiler/sql/bind.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { type JoinMember, memberItems } from "#compiler/sql/plan.ts"
import { catalog } from "#test/unit/sql/bind.fixtures.ts"
import {
	levelFacts,
	type TreeFeature,
	treeCaseGen,
	treeFeatures,
	treeStatement
} from "#test/unit/sql/join-tree.fixtures.ts"

/** The places `from` to `to`, none where `to` is below `from`. */
const span = (from: number, to: number): ReadonlyArray<number> =>
	Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)

/** The written alias of each entry of a bound statement's top level, in FROM order. */
const topAliases = (bound: Select): ReadonlyArray<string> => {
	const body = bound.body
	const from = body.kind === "core" ? body.from : []
	const sources = Arr.flatMap(from, (item): ReadonlyArray<FromSource> =>
		item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (s) => s.source)] : [item]
	)
	return Arr.map(sources, (s) => defined(s.alias, "an entry's alias"))
}

/** A level's join tree is the one PostgreSQL's join search builds, and each join's method one it can run. */
export const aLevelsJoinTreeIsOnePostgreSqlsJoinSearchBuildsAndEachMethodOneItCanRun =
	property.explore(treeCaseGen, {
		needs: {},
		situations: treeFeatures,
		check: (_, c: Case<TreeFeature>) => (drawn) =>
			Effect.sync(() => {
				const bound = bindSelect(treeStatement(drawn), new AdviceScope(), catalog)
				const placeOf = new Map(Arr.map(topAliases(bound.statement), (a, at) => [a, at] as const))
				const top = Option.getOrUndefined(
					Arr.findFirst(bound.plan.levels, (l) => l.kind === "joins" && l.name.kind === "top")
				)
				const root = defined(
					top?.kind === "joins" ? top.problem : undefined,
					"the top level's join problem"
				)
				const facts = levelFacts(drawn)
				const n = drawn.entries.length
				const all = span(0, n - 1)
				const placesOf = (member: JoinMember<unknown>): ReadonlyArray<number> =>
					Arr.map(memberItems(member), (i) => defined(placeOf.get(i.alias), `entry ${i.alias}`))
				const sorted = (places: ReadonlyArray<number>): ReadonlyArray<number> =>
					Arr.sort(places, Order.Number)
				const named = (places: Iterable<number>) => Arr.join(Arr.map([...places], String), ", ")
				assert.deepEqual(sorted(placesOf(root)), all, "the tree holds every entry once")
				/** Each problem's own entries, nested past join_collapse_limit: the first's eight, each next's seven. */
				const problemsOf = (m: JoinMember<unknown>): ReadonlyArray<ReadonlyArray<number>> =>
					m.kind === "tree" && m.tree.first.kind === "tree"
						? [
								...problemsOf(m.tree.first),
								sorted(Arr.flatMap(m.tree.joined, (j) => placesOf(j.member)))
							]
						: [sorted(placesOf(m))]
				const problems = problemsOf(root)
				const expected: Array<ReadonlyArray<number>> = [span(0, Math.min(n, 8) - 1)]
				for (let from = 8; from < n; from += 7) {
					expected.push(span(from, Math.min(n, from + 7) - 1))
				}
				assert.deepEqual(
					problems,
					expected,
					"past join_collapse_limit, each problem holds its own entries"
				)
				if (problems.length > 1) {
					c.note("a level past join_collapse_limit, nested")
				}
				const linkedTo = (places: ReadonlySet<number>, to: ReadonlySet<number>) =>
					Arr.some([...places], (p) => Arr.some([...(facts.linked[p] ?? [])], (q) => to.has(q)))
				const holds = (k: { readonly entries: ReadonlySet<number> }, places: ReadonlySet<number>) =>
					Arr.some([...k.entries], (e) => places.has(e))
				const keyedBy = (inner: ReadonlySet<number>, outer: ReadonlySet<number>) =>
					Arr.some(facts.classes, (k) => !k.fixed && holds(k, inner) && holds(k, outer))
				/** Every join of `member`'s tree, its first a problem of its own where it is a tree, beneath `outer`. */
				const free = (p: number) => (facts.linked[p]?.size ?? 0) === 0
				const judge = (
					member: JoinMember<unknown>,
					outer: ReadonlySet<number>,
					problem: ReadonlySet<number>
				): void => {
					if (member.kind === "item") {
						return
					}
					judge(member.tree.first, outer, new Set(placesOf(member.tree.first)))
					const before = new Set(placesOf(member.tree.first))
					for (const j of member.tree.joined) {
						const own = new Set(placesOf(j.member))
						const reads = new Set(
							Arr.filter(
								Arr.flatMap([...own], (p) => [...(facts.reads[p] ?? [])]),
								(p) => !own.has(p)
							)
						)
						assert.ok(
							Arr.every([...reads], (p) => before.has(p) || outer.has(p)),
							`entries ${named(own)} join where their lateral reads ${named(reads)} are held`
						)
						const linked = linkedTo(own, before)
						const isolated = !linkedTo(before, new Set(Arr.filter(all, (p) => !before.has(p))))
						const left = Arr.filter([...problem], (p) => !before.has(p))
						const lastDitch =
							Arr.every(Arr.filter([...problem], free), (p) => before.has(p)) &&
							!linkedTo(new Set(left), before)
						const levelTwo =
							before.size === 1 &&
							own.size === 1 &&
							!linkedTo(own, new Set(Arr.filter(all, (p) => !own.has(p))))
						assert.ok(
							linked || isolated || levelTwo || lastDitch,
							`entries ${named(own)} join entries ${named(before)} linked to them, either linked to nothing else, or by the last-ditch join`
						)
						if (!linked) {
							c.note("entries linked to nothing before them, a cross product")
						}
						const lateral =
							j.member.kind === "item"
								? Arr.some([...own], (p) => drawn.entries[p] === "lateral")
								: Arr.some([...reads], (p) => before.has(p))
						const expected = lateral ? "nestedLoop" : keyedBy(own, before) ? "hash" : "nestedLoop"
						assert.equal(
							j.join,
							expected,
							`entries ${named(own)} join entries ${named(before)} by their method`
						)
						if (j.member.kind === "tree") {
							c.note("an entry reading one no entry before it is linked to, joined in a group")
							if (lateral) {
								c.note(
									"a group on a join's inner side reading the entries before it, a nested loop"
								)
							}
							judge(j.member, new Set([...outer, ...before]), problem)
						} else if (!lateral && expected === "hash") {
							c.note("a set join keyed by a class of no fixed value, hashed")
						} else if (
							!lateral &&
							Arr.some(facts.classes, (k) => holds(k, own) && holds(k, before))
						) {
							c.note("a set join whose classes each hold a fixed value, a nested loop")
						}
						for (const p of own) {
							before.add(p)
						}
					}
				}
				judge(root, new Set(), new Set(placesOf(root)))
				const linkedLeftDeep = Arr.every(span(1, n - 1), (k) =>
					linkedTo(new Set([k]), new Set(span(0, k - 1)))
				)
				if (linkedLeftDeep && n > 1) {
					c.note("a level linked left-deep in its FROM's order")
					const flat = (m: JoinMember<unknown>): ReadonlyArray<number> =>
						m.kind === "item"
							? placesOf(m)
							: [
									...flat(m.tree.first),
									...Arr.flatMap(m.tree.joined, (j) =>
										j.member.kind === "item" ? placesOf(j.member) : [-1]
									)
								]
					assert.deepEqual(flat(root), all, "a level linked left-deep joins in its FROM's order")
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's join search: the links, lateral reads and equivalence classes of the drawn level"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "const joinCollapseLimit = 8\n",
				replacement: "const joinCollapseLimit = 64\n",
				why: "A level past join_collapse_limit is one problem: PostgreSQL plans its first eight entries apart, and the flat tree names no problem it plans."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\t\t\t(reaching === undefined\n\t\t\t\t\t? undefined\n\t\t\t\t\t: unitOf(spineOf(groupOf(reaching, left), new Set([...outer, ...joinedPlaces])), [])) ??\n",
				replacement: "",
				why: "Every level is joined left-deep: an entry reading one no entry before it is linked to joins as a cross product, a join PostgreSQL never builds while the entries before it are linked to another (magic-sets' JOIN_ORDER(v3 r2 r4), its plan v3 (r2 r4))."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\t\t...components.filter((c) => !past(c)).toSorted(byPlace),\n\t\t\t...components.filter(past).toSorted(bySize)\n",
				replacement: "\t\t\t...components.toSorted(byPlace)\n",
				why: "A problem's components join in the FROM's order whatever they link past it: an entry linked to one of a later problem drives a cross product, a join PostgreSQL builds only of a set linked to nothing outside it (a level of nine CTE scans, the first compared with the ninth, joined (e0 e1 …))."
			}
		]
	})
