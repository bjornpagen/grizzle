/** What the properties of rule-requests.test.ts read: its space and its judge. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { keyTermText, type PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { owning } from "#test/support/policy.ts"

/** The columns D joins T and U by beside their unit, `package`: g, h, or both. */
type Join = "g" | "h" | "gh"

/**
 * One case: whether T, U and S are immutable, so the containment over D is unit-local and judged whole, or mutable, T
 * and U in the unit of their package and S in the unit of its pack, so it reads the rows of two units and is probed;
 * the columns D joins T and U by beside `package`; whether D holds U's w to a literal; whether a second rule reads U
 * across units, E's g of every U row held in Q, keyed by g alone, whose probes of Q's deletes read U by g, every unit's
 * rows of it; and whether U declares a key over g alone, which a read of U that binds g looks it up by, a key its unit
 * does not lead.
 */
interface Shape {
	readonly unitLocal: boolean
	readonly join: Join
	readonly literal: boolean
	readonly crossing: boolean
	readonly keyedByG: boolean
}

export const shapeGen: Gen<Shape> = (s) => ({
	unitLocal: s.draw(boolean),
	join: s.draw(element<Join>(["g", "h", "gh"])),
	literal: s.draw(boolean),
	crossing: s.draw(boolean),
	keyedByG: s.draw(boolean)
})

export type Reached =
	| "a whole rule's read by a join"
	| "a probe's read by a join"
	| "a whole rule's read beside a read across units"
	| "a whole rule's read by a key its unit does not lead"

/** The columns of the join, beside `package`. */
const joinColumns = (join: Join): ReadonlyArray<"g" | "h"> => (join === "gh" ? ["g", "h"] : [join])

/**
 * The schema of a shape: T and U keyed by their unit, `package`, then a column of their own, S by its pack and x, and
 * D, T's x of each T row and U row that agree on the join, of one package where the rule is unit-local and of any two
 * where it is probed, so D is live in both, held in S at its pack.
 */
const schemaOf = (shape: Shape) => {
	const T = relation(
		"T",
		{ package: pg.integer, id: pg.integer, g: pg.integer, h: pg.integer, x: pg.integer },
		["package", "id"]
	)
	const U = relation(
		"U",
		{ package: pg.integer, id: pg.integer, g: pg.integer, h: pg.integer, w: pg.integer },
		["package", "id"]
	)
	const S = relation("S", { pack: pg.integer, x: pg.integer }, ["pack", "x"])
	const Q = relation("Q", { g: pg.integer }, ["g"])
	const Base = schema(
		"rule_requests",
		[T, U, S, Q],
		[
			...(shape.keyedByG ? [key(on(U, "g"))] : []),
			...(shape.unitLocal
				? []
				: [
						unit("Package", { package: pg.integer }),
						unit("Packs", { pack: pg.integer }),
						unit("Gs", { g: pg.integer }),
						mutable(T),
						mutable(U),
						mutable(S),
						mutable(Q)
					])
		]
	)
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { package: packageNo, g, h, x } = v(T, "t")
			const joined = shape.join === "g" ? { g } : shape.join === "h" ? { h } : { g, h }
			const together = shape.unitLocal ? { package: packageNo } : {}
			return r
				.match(T, { package: packageNo, ...joined, x })
				.match(U, { ...together, ...joined, ...(shape.literal ? { w: 1 } : {}) })
				.find({ package: packageNo, x })
		})
	)
	const E = derived(
		"E",
		query(Base).rule((r) => {
			const { g } = v(U, "u")
			return r.match(U, { g }).find({ g })
		})
	)
	return shape.crossing
		? schema.extend(
				[Base],
				"rule_requests_1",
				[D, E],
				[contained(on(D, "package", "x"), on(S, "pack", "x")), contained(on(E, "g"), on(Q, "g"))]
			)
		: schema.extend(
				[Base],
				"rule_requests_1",
				[D],
				[contained(on(D, "package", "x"), on(S, "pack", "x"))]
			)
}

/** The fields an index's keys name, in index order. */
const fieldsOf = (index: PlannedIndex): ReadonlyArray<string> =>
	Arr.map(index.keys, (k) => keyTermText(k.column))

/** Whether a read of U by the join looks it up by its key over g alone, a key its unit does not lead. */
const byKeyOfG = (shape: Shape): boolean => shape.keyedByG && shape.join !== "h"

/**
 * Judges the indexes of `shape`'s installation. Each probe reads the relation it joins the delta's rows to by the join's
 * columns and `package`, U also by its literal w, or U by its key over g alone where it declares one and the join binds
 * g: that read is a lookup an index serves, an index of U and one of T whose keys are exactly those columns. A whole
 * rule's statement reads D as a chain from its unit (analysis/theory/navigate.ts): first the relation the unit and the
 * literals bind most, U at the unit and its w where D holds it to a literal, then the other at each of its rows by the
 * join's columns and `package`, U by its key over g alone where it declares one and the join binds g, each an index of
 * exactly its columns; T, read first where no literal binds U, is a range of its key's index at the unit. A whole rule's
 * read binds its unit but by a key the unit does not lead, so every index it creates for its requests leads with
 * `package`, and its read by U's key over g asks for no index, the key's own serving it.
 */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const joined = ["package", ...joinColumns(shape.join)]
	const across = joinColumns(shape.join)
	const reads: ReadonlyArray<{
		readonly relation: string
		readonly fields: ReadonlyArray<string>
	}> = !shape.unitLocal
		? [
				{
					relation: "U",
					fields: byKeyOfG(shape) ? ["g"] : [...across, ...(shape.literal ? ["w"] : [])]
				},
				{ relation: "T", fields: across }
			]
		: shape.literal
			? [
					{ relation: "U", fields: ["package", "w"] },
					{ relation: "T", fields: joined }
				]
			: [{ relation: "U", fields: byKeyOfG(shape) ? ["g"] : joined }]
	for (const read of reads) {
		const serving = Arr.filter(
			installation.indexes,
			(index) =>
				index.relation === read.relation &&
				index.method === "btree" &&
				Arr.join(Arr.sort(fieldsOf(index), Order.String), ",") ===
					Arr.join(Arr.sort(read.fields, Order.String), ",")
		)
		assert.ok(
			serving.length > 0,
			`${read.relation} is read by (${Arr.join(read.fields, ", ")}), a read of ${shape.unitLocal ? "the whole rule's chain" : "a probe's chain"}, so an index of exactly those columns serves it`
		)
	}
	if (shape.unitLocal) {
		const whole = new Set<string>(
			Arr.flatMap(installation.laws.rules, (rule) =>
				rule.rule.kind === "whole" ? [String(rule.law.id)] : []
			)
		)
		assert.ok(
			whole.size > 0,
			"the containment over immutable relations of one unit is judged whole"
		)
		for (const index of installation.indexes) {
			const asked = Arr.some(
				index.requests,
				(r) =>
					r.role === "lawMaintenance" &&
					r.justification.kind === "law" &&
					whole.has(String(r.justification.law))
			)
			if (index.index.kind === "created" && asked) {
				assert.equal(
					fieldsOf(index)[0],
					"package",
					`${index.relation}(${Arr.join(fieldsOf(index), ", ")}), an index a whole rule asks for, leads with its unit's key`
				)
			}
		}
		note(
			shape.crossing
				? "a whole rule's read beside a read across units"
				: "a whole rule's read by a join"
		)
		if (byKeyOfG(shape) && !shape.literal) {
			note("a whole rule's read by a key its unit does not lead")
		}
	} else {
		note("a probe's read by a join")
	}
}
