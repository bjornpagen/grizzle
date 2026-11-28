/**
 * A rule over a recursion is judged whole over the units a transaction wrote, and so compiles, exactly where the
 * recursion is unit-local (analysis/theory/unit.ts unitLocalRecursion): every relation it reads immutable or all of
 * them in one declared unit no wider than the walk's, its base
 * delivering the unit from a stored relation's leading key field, and every step carrying it from self through every
 * match into its head, a derived relation a step reads judged through its definition (analysis/theory/query.ts
 * liveQuery). Any other is refused when the schema compiles, since no probe reads a recursion.
 *
 * The box is every walk over a document's nodes (unit-recursion.fixtures.ts): seeded at every root of a document or at
 * a document its base states as a literal; stepping to a child, along a link to another document's node, to another
 * document's node at the same place, to a child whose document the step states, or through a live derived
 * relation of the children within a document or of the links across documents; under a containment of a claim into
 * the walk, a containment into it of each claimed node's parent, a check over it and a key over it; every relation
 * immutable, or Node mutable in the unit of its document or in the unit of a node's place, (doc, start), wider than the
 * walk's.
 *
 * The oracle is the rule restated as a model (a specification): a case compiles exactly when it is immutable or Node is
 * mutable in its document's unit, seeded
 * at its roots, and steps to a child, directly or through the derived relation within a document; every other case is
 * refused for the recursion no probe reads.
 *
 * Features: each step, seed and law admitted or refused, and a mutable relation's admission and refusal.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { compiledOf } from "#test/support/unit/analysis/theory/rule-query.fixtures.ts"
import {
	endedOf,
	type Law,
	localWalk,
	notLocalRefusal,
	type Step,
	walkCase,
	walkSchemaOf
} from "#test/unit/analysis/theory/unit-recursion.fixtures.ts"

type WalkFeature =
	| `admitted stepping ${Extract<Step, "child" | "derived child">}`
	| `refused stepping ${Step}`
	| "refused seeded at a fixed document"
	| "admitted over a mutable relation in its walk's unit"
	| "refused over a mutable relation in a unit wider than its walk's"
	| `admitted under ${Law}`

/** A rule over a recursion compiles exactly where the recursion carries its unit through every step. */
export const aRuleOverARecursionCompilesExactlyWhereEveryStepCarriesItsUnitFromSelfIntoItsHead =
	property.exhaust(finite(walkCase), {
		needs: {},
		situations: [
			"admitted stepping child",
			"admitted stepping derived child",
			"refused stepping child",
			"refused stepping link",
			"refused stepping other document",
			"refused stepping a fixed document",
			"refused stepping derived child",
			"refused stepping derived link",
			"refused seeded at a fixed document",
			"admitted over a mutable relation in its walk's unit",
			"refused over a mutable relation in a unit wider than its walk's",
			"admitted under contained",
			"admitted under parent contained",
			"admitted under check",
			"admitted under key"
		] satisfies ReadonlyArray<Reached<WalkFeature>>,
		check: (_, c: Case<WalkFeature>) => (walk) =>
			Effect.sync(() => {
				const ended = endedOf(compiledOf(walkSchemaOf(walk)))
				if (localWalk(walk)) {
					assert.equal(ended, "compiled", `${Formatter.format(walk)} carries its unit`)
					if (walk.step === "child" || walk.step === "derived child") {
						c.note(`admitted stepping ${walk.step}`)
					}
					c.note(`admitted under ${walk.law}`)
					if (walk.mutability === "Node mutable in its document") {
						c.note("admitted over a mutable relation in its walk's unit")
					}
					return
				}
				assert.equal(ended, notLocalRefusal, `${Formatter.format(walk)} leaves its unit`)
				c.note(`refused stepping ${walk.step}`)
				if (walk.seed === "a fixed document") {
					c.note("refused seeded at a fixed document")
				}
				if (walk.mutability === "Node mutable in its place") {
					c.note("refused over a mutable relation in a unit wider than its walk's")
				}
			}),
		oracle: {
			kind: "specification",
			name: "analysis/theory/unit.ts: a rule over a recursion is whole, and compiles, exactly where every relation is immutable or all of them sit in one declared unit no wider than the walk's, the base delivers the unit from a stored key and every step carries it from self into its head"
		},
		box: "every seed of two, every step of six, every law of four, every relation immutable or Node mutable in its document's unit or its place's",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t(all.some((r) => r.mutable) &&",
				replacement: "\t\t\t(false &&",
				why: "A rule over a mutable relation judged whole wherever it is unit-local, whatever unit its relations sit in: a walk over Node mutable in the unit of a node's place, which no borrow of one place covers, compiles."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\t\t"condition" in\n',
				replacement: '\t\t\t\ttrue ||\n\t\t\t\t"condition" in\n',
				why: "Every rule over a mutable relation probed, as before, its declared unit unread: a walk over Node mutable in its document's unit, every write of whose rows borrows the document, is refused for the recursion no probe reads."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\treturn h?.kind === "var" && h.var === unit[j]',
				replacement: "\t\t\treturn true",
				why: "A step whose head delivers another document admitted; a walk along a link compiles."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tif (w.self === undefined) {",
				replacement: "\t\t\tif (w.self !== undefined) {",
				why: "Self read as no unit, so a step's unit is its other matches' alone; a step to another document's node compiles."
			}
		]
	})
