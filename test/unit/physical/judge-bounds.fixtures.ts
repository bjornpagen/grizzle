/** What the property of judge-bounds.test.ts reads: its space, its schemas, and each case's check. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { owning } from "#test/support/policy.ts"

/** The learner key every learner relation leads with, and the field every read of one must be looked up by. */
const learner = "child"

const RS = relation("RS", { child: pg.integer, n: pg.integer, at: pg.bigint }, ["child", "n", "at"])
const IS = relation("IS", { child: pg.integer, n: pg.integer, stage: pg.integer }, ["child", "n"])
const TS = relation("TS", { child: pg.integer, stage: pg.integer }, ["child", "stage"])
const TV = relation("TV", { child: pg.integer, stage: pg.integer, k: pg.integer, at: pg.bigint }, [
	"child",
	"stage",
	"k"
])
const TU = relation("TU", { child: pg.integer, stage: pg.integer, k: pg.integer, at: pg.bigint }, [
	"child",
	"stage",
	"k"
])
const TE = relation("TE", { child: pg.integer, stage: pg.integer, at: pg.bigint }, [
	"child",
	"stage"
])
const SG = relation("SG", { child: pg.integer, n: pg.integer, at: pg.bigint, given: pg.bigint }, [
	"child",
	"n",
	"at"
])
const TB = relation(
	"TB",
	{ child: pg.integer, stage: pg.integer, k: pg.integer, remaining: pg.bigint },
	["child", "stage", "k"]
)
const learnerRelations = [RS, IS, TS, TV, TU, TE, SG, TB] as const

/**
 * The learner's relations, mutable: those keyed by a learner's stage inside the unit of the stage, those keyed by a
 * learner's item inside the unit of the item, each wider than the learner every rule over them reads within, so every
 * rule reads the rows of two units, or several of one, and is probed.
 */
const Base = schema("Bounds", learnerRelations, [
	unit("Sitting", { child: pg.integer, stage: pg.integer }),
	unit("Item", { child: pg.integer, n: pg.integer }),
	...Arr.map(learnerRelations, (t) => mutable(t))
])

/** A learner's snapshots beside their item session's stage, an import of one rule, as the ledger's testSnapshots. */
const snapshots = query(Base).rule((r) => {
	const { child, n, at } = v(RS, "s")
	const { stage } = v(IS, "i")
	return r
		.match(RS, { at, child, n })
		.match(IS, { child, n, stage })
		.match(TS, { child, stage })
		.find({ at, child, n, stage })
})

/** The item sessions of a sitting, an import of one rule. */
const sessions = query(Base).rule((r) => {
	const { child, n, stage } = v(IS, "i")
	return r.match(IS, { child, n, stage }).match(TS, { child, stage }).find({ child, n, stage })
})

/** The snapshots read through `sessions`, an import one level below another. */
const nestedSnapshots = query(Base).rule((r) => {
	const { child, n, at } = v(RS, "s")
	const { stage } = v(sessions, "i")
	return r
		.match(RS, { at, child, n })
		.match(sessions, { child, n, stage })
		.find({ at, child, n, stage })
})

/** Each snapshot of an open visit, of a suspended one and of an ended one: a definition of three rules over `snapshots`. */
const insideOf = (negated: boolean) =>
	query(Base)
		.rule((r) => {
			const { child, stage, n, at } = v(snapshots, "o")
			const { k, at: began } = v(TV, "v")
			const matched = r
				.match(snapshots, { at, child, n, stage })
				.match(TV, { at: began, child, k, stage })
			return (
				negated
					? matched.where(
							r.le(began, at),
							r.not(TU, { child, k, stage }),
							r.not(TE, { child, stage })
						)
					: matched.where(r.le(began, at))
			).find({ at, began, child, k, n, stage })
		})
		.rule((r) => {
			const { child, stage, n, at } = v(snapshots, "o")
			const { k, at: began } = v(TV, "v")
			const { at: until } = v(TU, "u")
			return r
				.match(snapshots, { at, child, n, stage })
				.match(TV, { at: began, child, k, stage })
				.match(TU, { at: until, child, k, stage })
				.where(r.le(began, at), r.le(at, until))
				.find({ at, began, child, k, n, stage })
		})
		.rule((r) => {
			const { child, stage, n, at } = v(snapshots, "o")
			const { k, at: began } = v(TV, "v")
			const { at: end } = v(TE, "e")
			return r
				.match(snapshots, { at, child, n, stage })
				.match(TV, { at: began, child, k, stage })
				.match(TE, { at: end, child, stage })
				.where(r.le(began, at), r.le(at, end))
				.find({ at, began, child, k, n, stage })
		})

/** The same definition over `nestedSnapshots`, two rules. */
const nestedInside = query(Base)
	.rule((r) => {
		const { child, stage, n, at } = v(nestedSnapshots, "o")
		const { k, at: began } = v(TV, "v")
		return r
			.match(nestedSnapshots, { at, child, n, stage })
			.match(TV, { at: began, child, k, stage })
			.where(r.le(began, at), r.not(TU, { child, k, stage }))
			.find({ at, began, child, k, n, stage })
	})
	.rule((r) => {
		const { child, stage, n, at } = v(nestedSnapshots, "o")
		const { k, at: began } = v(TV, "v")
		const { at: until } = v(TU, "u")
		return r
			.match(nestedSnapshots, { at, child, n, stage })
			.match(TV, { at: began, child, k, stage })
			.match(TU, { at: until, child, k, stage })
			.where(r.le(began, at), r.le(at, until))
			.find({ at, began, child, k, n, stage })
	})

/**
 * The shapes, each a check over a definition of several rules whose every rule reads an import of the learner's
 * snapshots beside a visit, as the ledger's "Response in time" reads SessionSnapshot:
 *
 * - `given and budget`: the snapshot's given time and the visit's budget joined at their keys, the first rule negating
 *   the visit's suspension and its sitting's end (the ledger's shape);
 * - `unnegated`: the same, no rule negating;
 * - `given alone`: the given time joined, no budget;
 * - `nested`: the snapshots read through an import of an import, a definition of two rules, the budget joined.
 */
const shapes = {
	"given and budget": () => {
		const inside = insideOf(true)
		const Timed = derived(
			"Timed",
			query(Base).rule((r) => {
				const { child, stage, n, at, k, began } = v(inside, "t")
				const { given } = v(SG, "g")
				const { remaining } = v(TB, "b")
				return r
					.match(inside, { at, began, child, k, n, stage })
					.match(SG, { at, child, given, n })
					.match(TB, { child, k, remaining, stage })
					.find({ child, n, stage, ran: given, remaining })
			})
		)
		return schema.extend(
			[Base],
			"Bounds_1",
			[Timed],
			[check("In_time", Timed, (t) => t.le(t.ran, t.remaining))]
		)
	},
	unnegated: () => {
		const inside = insideOf(false)
		const Timed = derived(
			"Timed",
			query(Base).rule((r) => {
				const { child, stage, n, at, k, began } = v(inside, "t")
				const { given } = v(SG, "g")
				const { remaining } = v(TB, "b")
				return r
					.match(inside, { at, began, child, k, n, stage })
					.match(SG, { at, child, given, n })
					.match(TB, { child, k, remaining, stage })
					.find({ child, n, stage, ran: given, remaining })
			})
		)
		return schema.extend(
			[Base],
			"Bounds_1",
			[Timed],
			[check("In_time", Timed, (t) => t.le(t.ran, t.remaining))]
		)
	},
	"given alone": () => {
		const inside = insideOf(true)
		const Timed = derived(
			"Timed",
			query(Base).rule((r) => {
				const { child, stage, n, at, k, began } = v(inside, "t")
				const { given } = v(SG, "g")
				return r
					.match(inside, { at, began, child, k, n, stage })
					.match(SG, { at, child, given, n })
					.find({ child, n, stage, ran: given, remaining: began })
			})
		)
		return schema.extend(
			[Base],
			"Bounds_1",
			[Timed],
			[check("In_time", Timed, (t) => t.le(t.ran, t.remaining))]
		)
	},
	nested: () => {
		const Timed = derived(
			"Timed",
			query(Base).rule((r) => {
				const { child, stage, n, at, k, began } = v(nestedInside, "t")
				const { remaining } = v(TB, "b")
				return r
					.match(nestedInside, { at, began, child, k, n, stage })
					.match(TB, { child, k, remaining, stage })
					.find({ child, n, stage, ran: at, remaining })
			})
		)
		return schema.extend(
			[Base],
			"Bounds_1",
			[Timed],
			[check("In_time", Timed, (t) => t.le(t.ran, t.remaining))]
		)
	}
} as const

export type Shape = keyof typeof shapes

export const shapeGen: Gen<Shape> = element([
	"given and budget",
	"unnegated",
	"given alone",
	"nested"
] as const)

export type Feature =
	| "a definition of three rules"
	| "an import nested in an import"
	| "a negated rule"
	| "no rule negating"

/**
 * Every index the judge of `shape`'s installation asks for a read of a learner's relation (a law-maintenance request,
 * physical/ddl/rules.ts requestsOf: each step's lookup by the columns the steps before it bound) holds the learner key
 * among its columns: each read of a learner's rows is a lookup of that learner's alone, so its predicate locks are the
 * learner's own, never every learner's at the other columns.
 */
export const judged = (shape: Shape, note: (f: Feature) => void): void => {
	const owned = owning(shapes[shape]())
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	assert.ok(
		Arr.every(installation.laws.rules, (r) => r.rule.kind !== "whole"),
		"every rule over the learner's relations is probed"
	)
	const learners = new Set<string>(Arr.map(learnerRelations, (t) => t.name))
	let asked = 0
	for (const index of installation.indexes) {
		for (const request of index.requests) {
			if (request.role !== "lawMaintenance" || !learners.has(request.relation)) {
				continue
			}
			asked++
			const fields = Arr.flatMap(request.blocks, (block) =>
				Arr.flatMap(block, (k) =>
					k.column.kind === "field"
						? [k.column.field.name]
						: k.column.kind === "suffix"
							? [k.column.of.field.name]
							: []
				)
			)
			assert.ok(
				Arr.contains(fields, learner),
				`${request.relation} is read by (${Arr.join(fields, ", ")}), every learner's rows at those columns, where a read of one learner's rows is looked up by ${learner}`
			)
		}
	}
	assert.ok(asked > 0, "the judge asks an index of a read of a learner's relation")
	note(shape === "nested" ? "an import nested in an import" : "a definition of three rules")
	note(shape === "unnegated" ? "no rule negating" : "a negated rule")
}
