/**
 * R07 over a closed relation's installed constants (lower/optimize/closed): which occurrences of a declared closed
 * relation become a membership test of its installed cells, and the simplifier's invariant that a Closed node holding
 * fewer facts than its relation carries no declared name. The oracle is the rule's specification as a checker
 * (membershipOf's doc comment): an occurrence is rewritten exactly when every key field is read as a variable another
 * occurrence binds, a literal or a parameter, and no payload field is read. A rewritten occurrence of a sparse relation is
 * read by a binary search of its installed cells, one of a roster is the tautology its domain makes it and reads nothing, and a kept one
 * is read from its facts. A roster's occurrence whose source another occurrence reads
 * laterally, through a constant, stays in its region, its reader's reference in scope; one read by no other occurrence,
 * or beside a lateral read of another source, is its membership test. A Closed node the simplifier narrows holds the
 * rows its filter keeps, as a set.
 *
 * Features: each verdict and each reason a kept occurrence is kept; a whole, a narrowed and an empty roster; rewritten
 * and kept beside a lateral read.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta, type Heading } from "#compiler/ir/rel.ts"
import { closedPass } from "#compiler/lower/optimize/closed/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"
import {
	type ClosedFeature,
	featureOf,
	holdsOf,
	kindHandle,
	kindHandles,
	type LateralCase,
	type LateralRead,
	membership,
	type NarrowedFeature,
	occurrenceGen,
	predExpr,
	predGen,
	Rewrite,
	rosterMembership,
	specified
} from "#test/unit/lower/rewrite/closed.fixtures.ts"
import { scopedStay } from "#test/unit/lower/rewrite/guarded.ts"
import {
	ledgerCatalog,
	nodesOf,
	passContext,
	queryOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** R07 over closed constants rewrites an occurrence exactly when it reads every key field as one value and no payload. */
export const r07OverClosedConstantsRewritesAnOccurrenceExactlyWhenItReadsEveryKeyFieldAsOneValueAndNoPayload =
	property.exhaust(finite(occurrenceGen), {
		needs: {},
		situations: [
			"rewritten",
			"a roster rewritten",
			"kept: a key field left free",
			"kept: a key field the relation alone binds",
			"kept: the payload read"
		] satisfies ReadonlyArray<Reached<ClosedFeature>>,
		check: (_, c: Case<ClosedFeature>) => (o) =>
			Effect.sync(() => {
				const template = succeeded(
					compileTemplate(
						o.kind === "Grid" ? membership(o.k0, o.k1, o.w) : rosterMembership(o.id),
						Rewrite,
						testCompile
					)
				)
				const rewritten = Arr.some(
					template.certificates,
					(cert) => cert.rule === "R07.closedMembership"
				)
				c.note(featureOf(o))
				assert.equal(rewritten, specified(o), Formatter.format(o))
				const shapes = Arr.map(programAsts(template.programs.optimized), shapeOf)
				assert.equal(
					Arr.some(shapes, (shape) => has(shape, "from values")),
					!rewritten,
					`a rewritten occurrence is read from no VALUES, a kept one from its facts: ${Formatter.format(o)}`
				)
				assert.equal(
					Arr.some(shapes, (shape) => has(shape, "call width_bucket")),
					rewritten && o.kind === "Grid",
					`a rewritten Grid is read by a search of its cells, a rewritten roster through no constant: ${Formatter.format(o)}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "membershipOf's rule: every key field a variable bound elsewhere, a literal or a parameter, and no payload read"
		},
		box: "every read of Grid's two key fields (an item's variable, a literal, a parameter, free, or Grid's own variable) with every read of its payload (none, an item's variable, a literal), and every read of the roster Kind's key field: 80 queries",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/closed/index.ts",
				original:
					"\tif (\n\t\to.bindings.some((b) => !evidence.key.includes(b.column)) ||\n\t\to.constants.some((c) => !evidence.key.includes(c.column))\n\t) {",
				replacement: "\tif (o.constants.some((c) => !evidence.key.includes(c.column))) {",
				why: "An occurrence that binds a payload field is admitted as a membership; the closed-membership search fails."
			}
		]
	})

/** R07 over closed constants names a Closed node the simplifier narrows after no declared relation, and keeps a whole one's name. */
export const r07OverClosedConstantsNamesAClosedNodeTheSimplifierNarrowsAfterNoDeclaredRelationAndKeepsAWholeOnesName =
	property.exhaust(finite(predGen), {
		needs: {},
		situations: [
			"the whole roster kept",
			"a narrowed roster",
			"nothing kept"
		] satisfies ReadonlyArray<Reached<NarrowedFeature>>,
		check: (_, c: Case<NarrowedFeature>) => (p) =>
			Effect.sync(() => {
				const heading: Heading = [{ name: "id", type: T.kind }]
				const q = new Q()
				const source = q.closed(
					"Kind",
					heading,
					Arr.map(kindHandles, (h) => [kindHandle(h)])
				)
				const root = q.project(
					q.filter(source, predExpr(q, source, p)),
					[["id", "id"]],
					conservativeMeta
				)
				const ran = succeeded(
					runPasses(
						queryOf(q.build(root).dag, []),
						[simplifyPass],
						passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					)
				)
				const kept = Arr.filter(kindHandles, (h) => holdsOf(p, h))
				c.note(
					kept.length === kindHandles.length
						? "the whole roster kept"
						: kept.length === 0
							? "nothing kept"
							: "a narrowed roster"
				)
				const [only, ...others] = nodesOf(ran.query.dag, "Closed")
				assert.ok(only !== undefined && others.length === 0, "one Closed node")
				unorderedEqual(
					only.rows,
					Arr.map(kept, (h) => [kindHandle(h)]),
					"the Closed node holds the rows the predicate keeps"
				)
				assert.equal(
					only.closed === "Kind",
					kept.length === kindHandles.length,
					`the declared name only on every fact: ${only.closed}`
				)
				assert.ok(
					only.closed === "Kind" || Str.startsWith("__")(only.closed),
					`a narrowed Closed node names no declared relation: ${only.closed}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the predicate's meaning on each row, and a declared name only on every fact"
		},
		box: "every predicate over the roster's id of at most one connective (not, and, or) over constants and comparisons with each handle: 40 filters",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original: "\t\t\tkept.length === source.rows.length ? source.closed : narrowedClosedName,",
				replacement: "\t\t\tsource.closed,",
				why: "A Closed node the simplifier narrows keeps its relation's declared name; the closed-narrowed search fails."
			}
		]
	})

/** R07 beside a lateral read keeps a closed occurrence whose source another occurrence reads, and rewrites one no other occurrence reads. */
export const r07BesideALateralReadKeepsAClosedOccurrenceWhoseSourceAnotherOccurrenceReadsAndRewritesOneNoOtherOccurrenceReads =
	property.exhaust(
		finite((source): LateralCase => ({
			read: source.draw(element<LateralRead>(["nothing", "the task's kind", "the roster's id"])),
			bound: source.draw(boolean)
		})),
		{
			needs: {},
			situations: ["rewritten", "kept"] satisfies ReadonlyArray<Reached<"rewritten" | "kept">>,
			check:
				(_, c: Case<"rewritten" | "kept">) =>
				({ read, bound }) =>
					Effect.sync(() => {
						const q = new Q()
						const roster = q.closed(
							"Kind",
							[{ name: "id", type: T.kind }],
							Arr.map(kindHandles, (h) => [kindHandle(h)])
						)
						const task = q.base(Task, conservativeMeta)
						const reader = q.base(Task, conservativeMeta)
						const constants: Record<string, ScalarExpr> =
							read === "nothing"
								? {}
								: { kind: read === "the task's kind" ? q.col(task, "kind") : q.col(roster, "id") }
						const region = q.region([
							{ source: roster, bind: { id: "k" }, constants: {} },
							{
								source: task,
								bind: bound ? { id: "t", kind: "k" } : { id: "t" },
								constants: {}
							},
							{ source: reader, bind: { id: "u" }, constants }
						])
						const query = queryOf(
							q.build(
								q.project(
									region,
									[
										["t", "t"],
										["u", "u"]
									],
									conservativeMeta
								)
							).dag,
							[]
						)
						const ran = succeeded(
							runPasses(
								query,
								[closedPass],
								passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
							)
						)
						const rewritten = Arr.some(
							ran.certificates,
							(certificate) => certificate.rule === "R07.closedMembership"
						)
						assert.equal(
							rewritten,
							bound && read !== "the roster's id",
							Formatter.format({ read, bound })
						)
						scopedStay(query.dag, ran.query.dag)
						c.note(rewritten ? "rewritten" : "kept")
					}),
			oracle: {
				kind: "specification",
				name: "membershipsOf: a key another occurrence binds, and no occurrence whose source a scope expression reads"
			},
			box: "a region of the roster Kind, a task binding its kind to the roster's id or not, and a task whose kind is fixed to nothing, the first task's kind or the roster's id",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/closed/index.ts",
					original: "\tif (bound.length === 1 && fixed.length === 0 && binding !== undefined) {",
					replacement: "\tif (bound.length === 0 && fixed.length === 0 && binding !== undefined) {",
					why: "Operator mutant (bound) at packages/engine/src/lower/optimize/closed/index.ts:63 in keyValue: `1` becomes `0`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
