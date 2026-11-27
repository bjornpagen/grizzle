/**
 * What the property of sealed-reference.test.ts reads: the box's base, a package's content in a unit sealed at founding
 * and a learner's attempts in a unit of their own, its definitions, the holding the rule restated gives each, and what
 * the installation infers and keeps of each.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { UnitLocalityCondition } from "#compiler/core/causes.ts"
import {
	exprChildren,
	type InferredExpr,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type InferredStage
} from "#compiler/ir/desc.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	on,
	relation,
	schema,
	sealed,
	select,
	unit
} from "#compiler/public/schema.ts"

const childKey = Symbol("Child")
/** A learner, by a number of its own type, so no package's number leads a learner's key. */
const Child = contract<typeof childKey>()("Child", pg.integer)
const packageNoKey = Symbol("PackageNo")
/** A package, by a number of its own type, so no learner's number leads a package's key. */
const PackageNo = contract<typeof packageNoKey>()("PackageNo", pg.integer)

/** A package, the root of its content. */
const Package = relation("Package", { package: PackageNo }, ["package"])
/** An item of a package: whether it is adaptive, and its maximum. */
const Item = relation(
	"Item",
	{ package: PackageNo, item: pg.integer, adaptive: pg.boolean, max: pg.integer },
	["package", "item"]
)
/** A variable of an item an End Attempt binds, and whether it counts an attempt: ledger's uncountingResponses. */
const Hint = relation(
	"Hint",
	{ package: PackageNo, item: pg.integer, variable: pg.integer, counts: pg.boolean },
	["package", "item", "variable"]
)
/** A learner's attempt at an item of a package, numbered. */
const Attempt = relation(
	"Attempt",
	{ child: Child, package: PackageNo, item: pg.integer, n: pg.integer },
	["child", "package", "item", "n"]
)
/** A variable's value at an attempt. */
const Snapshot = relation(
	"Snapshot",
	{
		child: Child,
		package: PackageNo,
		item: pg.integer,
		n: pg.integer,
		variable: pg.integer,
		value: pg.boolean
	},
	["child", "package", "item", "n", "variable"]
)
/** A mark of an attempt, of a kind: only a mark of kind 1 names an item of a package, by its containment's selection. */
const Marked = relation(
	"Marked",
	{ child: Child, package: PackageNo, item: pg.integer, n: pg.integer, kind: pg.integer },
	["child", "package", "item", "n"]
)
/** A learner's note at an item of a package, which no containment holds to the package's content. */
const Note = relation("Note", { child: Child, package: PackageNo, item: pg.integer }, [
	"child",
	"package",
	"item"
])

/**
 * Whether the package unit is sealed at founding (`sealed`), so its rows at a key never change once founded, or only
 * declared (`unsealed`), its rows written under its borrow by any write.
 */
export type Sealing = "sealed" | "unsealed"

/** Whether the schema states that every attempt names an item of a package (`stated`), or states it nowhere. */
export type AttemptContainment = "stated" | "unstated"

/**
 * A definition of the box, each over a learner's rows and a package's content:
 *
 * - `credit`: each attempt with its item's maximum, ledger's AttemptCredit over MaximumOutcome, its item read at the
 *   attempt's package and item;
 * - `copied credit`: the credit, its items read through a copy of Item's rows, a query of the content alone that delivers
 *   every field of Item and states no condition, live as a copy (analysis/derived/storage.ts copiedRelation) and so read
 *   in place, a reference-only import its reader reaches at the attempt's package and item;
 * - `not adaptive`: each attempt at an item that is not adaptive, ledger's ItemSessionOpen, the item negated at the
 *   attempt's package and item;
 * - `counted`: each attempt not ended through a hint that counts none, ledger's CountedAttempt, the hints a query of the
 *   package's content alone read at the attempt's package and item, a reference-only import its reader reaches, stored
 *   where it is reached and read by its name, so the relation reads no content itself;
 * - `attempted items`: each attempted item's maximum, its attempts an import delivering the package and item, which it
 *   reaches at its head;
 * - `marked of kind 1`: each mark of kind 1 with its item's maximum, the marks the containment's selection admits;
 * - `marked of any kind`: each mark of any kind with its item's maximum, some marks outside the selection;
 * - `noted`: each note with its item's maximum, a note held to no content;
 * - `noted hints`: each note with its item's hints, the hints' import read at a key no containment reaches;
 * - `constant package`: each attempt with the maximum of package 0's item, read at a package no attempt names;
 * - `graded`: each attempt with its item's graded maximum, a stored relation of the content alone read by reference,
 *   ledger's AttemptCredit over the stored MaximumOutcome.
 */
export type Shape =
	| "credit"
	| "copied credit"
	| "not adaptive"
	| "counted"
	| "attempted items"
	| "marked of kind 1"
	| "marked of any kind"
	| "noted"
	| "noted hints"
	| "constant package"
	| "graded"

const shapes = [
	"credit",
	"copied credit",
	"not adaptive",
	"counted",
	"attempted items",
	"marked of kind 1",
	"marked of any kind",
	"noted",
	"noted hints",
	"constant package",
	"graded"
] as const satisfies ReadonlyArray<Shape>

/** A case: a definition, whether the package unit is sealed, and whether the attempts' containment is stated. */
export interface ReferenceCase {
	readonly shape: Shape
	readonly sealing: Sealing
	readonly containment: AttemptContainment
}

export const referenceCase: Gen<ReferenceCase> = (s) => ({
	shape: s.draw(element(shapes)),
	sealing: s.draw(element<Sealing>(["sealed", "unsealed"])),
	containment: s.draw(element<AttemptContainment>(["stated", "unstated"]))
})

/** The name of the box's derived relation, whose holding a case reads. */
export const derivedName = "Held"

/** The base of a case: the package's content and the learner's rows, the package unit sealed or not, the attempts'
 * containment stated or not. */
const baseOf = (c: ReferenceCase) =>
	schema(
		"SealedReference",
		[Package, Item, Hint, Attempt, Snapshot, Marked, Note],
		[
			unit("Learner", { child: Child }),
			c.sealing === "sealed"
				? sealed(unit("Package", { package: PackageNo }))
				: unit("Package", { package: PackageNo }),
			contained(on(Item, "package"), on(Package, "package")),
			contained(on(Hint, "package", "item"), on(Item, "package", "item")),
			contained(
				on(
					select(Marked, (m) => m.eq(m.kind, 1)),
					"package",
					"item"
				),
				on(Item, "package", "item")
			),
			...(c.containment === "stated"
				? [contained(on(Attempt, "package", "item"), on(Item, "package", "item"))]
				: [])
		]
	)

/**
 * Each item of a package with a maximum of 0 or more, a definition of the content alone over `base`: stored in the
 * package's unit, kept at its founding where the unit is sealed, at the item where it is not.
 */
const gradedOf = (base: ReturnType<typeof baseOf>) =>
	derived(
		"Graded",
		query(base).rule((r) => {
			const { package: p, item: i, max } = v(Item, "i")
			return r
				.match(Item, { package: p, item: i, max })
				.where(r.ge(max, 0))
				.find({ package: p, item: i, max })
		})
	)

/** The level of a case's content's stored relation, over its base, and that relation. */
const contentOf = (base: ReturnType<typeof baseOf>) => {
	const Graded = gradedOf(base)
	return { level: schema.extend([base], "SealedReferenceContent", [Graded], []), Graded }
}

/** The derived relation of shape `shape` over `content`, a level over `base`. */
const derivedOf = (
	shape: Shape,
	base: ReturnType<typeof baseOf>,
	content: ReturnType<typeof contentOf>
) => {
	/** Each variable of an item a hint that counts none binds, by its package and item: a query of content alone. */
	const uncounting = query(base).rule((r) => {
		const { package: p, item: i, variable: x } = v(Hint, "hint")
		return r
			.match(Hint, { package: p, item: i, variable: x, counts: false })
			.find({ package: p, item: i, variable: x })
	})
	switch (shape) {
		case "credit":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n } = v(Attempt, "a")
					const { max } = v(Item, "i")
					return r
						.match(Attempt, { child, package: p, item: i, n })
						.match(Item, { package: p, item: i, max })
						.find({ child, package: p, item: i, n, max })
				})
			)
		case "copied credit": {
			const items = query(base).rule((r) => {
				const { package: p, item: i, adaptive, max } = v(Item, "copied")
				return r
					.match(Item, { adaptive, package: p, item: i, max })
					.find({ adaptive, package: p, item: i, max })
			})
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n } = v(Attempt, "a")
					const { max } = v(items, "i")
					return r
						.match(Attempt, { child, package: p, item: i, n })
						.match(items, { package: p, item: i, max })
						.find({ child, package: p, item: i, n, max })
				})
			)
		}
		case "not adaptive":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n } = v(Attempt, "a")
					return r
						.match(Attempt, { child, package: p, item: i, n })
						.where(r.not(Item, { package: p, item: i, adaptive: true }))
						.find({ child, package: p, item: i, n })
				})
			)
		case "counted": {
			const uncounted = query(base).rule((r) => {
				const { child, package: p, item: i, n } = v(Attempt, "a")
				const { variable: x } = v(uncounting, "u")
				return r
					.match(Attempt, { child, package: p, item: i, n })
					.match(uncounting, { package: p, item: i, variable: x })
					.match(Snapshot, { child, package: p, item: i, n, variable: x, value: true })
					.find({ child, package: p, item: i, n })
			})
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n } = v(Attempt, "a")
					return r
						.match(Attempt, { child, package: p, item: i, n })
						.where(r.not(uncounted, { child, package: p, item: i, n }))
						.find({ child, package: p, item: i, n })
				})
			)
		}
		case "attempted items": {
			const attempted = query(base).rule((r) => {
				const { child, package: p, item: i } = v(Attempt, "a")
				return r.match(Attempt, { child, package: p, item: i }).find({ child, package: p, item: i })
			})
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i } = v(attempted, "a")
					const { max } = v(Item, "i")
					return r
						.match(attempted, { child, package: p, item: i })
						.match(Item, { package: p, item: i, max })
						.find({ child, package: p, item: i, max })
				})
			)
		}
		case "marked of kind 1":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n } = v(Marked, "m")
					const { max } = v(Item, "i")
					return r
						.match(Marked, { child, package: p, item: i, n, kind: 1 })
						.match(Item, { package: p, item: i, max })
						.find({ child, package: p, item: i, n, max })
				})
			)
		case "marked of any kind":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n, kind } = v(Marked, "m")
					const { max } = v(Item, "i")
					return r
						.match(Marked, { child, package: p, item: i, n, kind })
						.match(Item, { package: p, item: i, max })
						.find({ child, package: p, item: i, n, kind, max })
				})
			)
		case "noted":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i } = v(Note, "n")
					const { max } = v(Item, "i")
					return r
						.match(Note, { child, package: p, item: i })
						.match(Item, { package: p, item: i, max })
						.find({ child, package: p, item: i, max })
				})
			)
		case "noted hints":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i } = v(Note, "n")
					const { variable: x } = v(uncounting, "u")
					return r
						.match(Note, { child, package: p, item: i })
						.match(uncounting, { package: p, item: i, variable: x })
						.find({ child, package: p, item: i, variable: x })
				})
			)
		case "constant package":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { child, package: p, item: i, n } = v(Attempt, "a")
					const { max } = v(Item, "i")
					return r
						.match(Attempt, { child, package: p, item: i, n })
						.match(Item, { package: 0, item: i, max })
						.find({ child, package: p, item: i, n, max })
				})
			)
		case "graded": {
			const { level, Graded } = content
			return derived(
				derivedName,
				query(level).rule((r) => {
					const { child, package: p, item: i, n } = v(Attempt, "a")
					const { max } = v(Graded, "g")
					return r
						.match(Attempt, { child, package: p, item: i, n })
						.match(Graded, { package: p, item: i, max })
						.find({ child, package: p, item: i, n, max })
				})
			)
		}
	}
}

/** The schema of a case: its base, a level above it its content's stored relation, and above that its derived
 * relation. */
export const referenceSchemaOf = (c: ReferenceCase) => {
	const base = baseOf(c)
	const content = contentOf(base)
	return schema.extend(
		[content.level],
		"SealedReferenceTop",
		[derivedOf(c.shape, base, content)],
		[]
	)
}

/**
 * Where the installation keeps a case's derived relation: `stored`, at its table's unit fields, in the learner's unit,
 * reading the relations of `references` by reference; or `live`, by the condition its definition lacks.
 */
export type Holding =
	| {
			readonly kind: "stored"
			readonly fields: ReadonlyArray<string>
			readonly declared: string
			readonly references: ReadonlyArray<string>
	  }
	| { readonly kind: "live"; readonly lacks: UnitLocalityCondition | "unboundedUpkeep" | "other" }

/**
 * What a shape reads its content beside: the learner's relation whose rows name the package and item its reads of
 * content stand at, whether that relation's containment into the content is stated for every row it reads (`always`),
 * only where the case states the attempts' containment (`attempts`), or never; its table's unit fields; and the
 * content relations it reads by reference itself: none where it reads content only through an import whose canonical
 * relation is stored wherever it is, read by its name (analysis/schema.ts storedImport), as `counted` reads Hint through
 * the uncounted attempts, a stored relation that reads Hint by reference.
 */
interface Reading {
	readonly reached: "always" | "attempts" | "never"
	readonly fields: ReadonlyArray<string>
	readonly references: ReadonlyArray<string>
}

/** Each shape's reading (`Reading`). */
const readingOf = (shape: Shape): Reading => {
	const attempt = ["child", "package", "item", "n"]
	switch (shape) {
		case "credit":
		case "copied credit":
		case "not adaptive":
			return { reached: "attempts", fields: attempt, references: ["Item"] }
		case "counted":
			return { reached: "attempts", fields: attempt, references: [] }
		case "attempted items":
			return { reached: "attempts", fields: ["child", "package", "item"], references: ["Item"] }
		case "marked of kind 1":
			return { reached: "always", fields: attempt, references: ["Item"] }
		case "marked of any kind":
		case "constant package":
			return { reached: "never", fields: attempt, references: ["Item"] }
		case "graded":
			return { reached: "attempts", fields: attempt, references: ["Graded"] }
		case "noted":
			return { reached: "never", fields: ["child", "package", "item"], references: ["Item"] }
		case "noted hints":
			return { reached: "never", fields: ["child", "package", "item"], references: ["Hint"] }
	}
}

/**
 * The holding the rule restated gives a case (analysis/theory/unit.ts storedUnit): under an unsealed package unit, live,
 * its content leading its keys with a package where its learner's rows lead with a learner (`unitKey`); under a sealed
 * one, stored in the learner's unit at the learner's relation's key, its content read by reference, where every read of
 * content stands at a package and item a learner's row it reads beside names through a containment the schema states
 * over every row that read admits, and live for its reference (`reference`) where one does not.
 */
export const holdingOf = (c: ReferenceCase): Holding => {
	if (c.sealing === "unsealed") {
		return { kind: "live", lacks: "unitKey" }
	}
	const reading = readingOf(c.shape)
	const reached =
		reading.reached === "always" || (reading.reached === "attempts" && c.containment === "stated")
	return reached
		? {
				kind: "stored",
				fields: reading.fields,
				declared: "Learner",
				references: reading.references
			}
		: { kind: "live", lacks: "reference" }
}

/** The holding the compile states (`Holding`). */
export const holdingStated = (artifacts: SchemaArtifacts): Holding => {
	const holding = artifacts.laws.checked.holdings.get(derivedName)
	if (holding?.kind === "stored" && holding.relation.unit.kind === "unit") {
		const unit = holding.relation.unit
		return {
			kind: "stored",
			fields: unit.fields,
			declared: unit.declared.unit,
			references: unit.references
		}
	}
	if (holding?.kind === "live") {
		return {
			kind: "live",
			lacks:
				holding.why.kind === "notUnitLocal"
					? holding.why.lacks.condition
					: holding.why.kind === "unboundedUpkeep"
						? "unboundedUpkeep"
						: "other"
		}
	}
	return { kind: "live", lacks: "other" }
}

/** The relations whose deltas `query` reads, at any depth, each once. */
export const deltasReadIn = (query: InferredQuery): ReadonlySet<string> => {
	const out = new Set<string>()
	const inSource = (s: InferredSource): void => {
		if (s.kind === "delta") {
			out.add(s.relation)
		} else if (s.kind === "query" || s.kind === "step") {
			inStage(s.query.stage)
		}
	}
	const inExpr = (e: InferredExpr): void => {
		if (e.kind === "absent" || e.kind === "exists") {
			inSource(e.source)
		}
		for (const child of exprChildren(e)) {
			inExpr(child.term)
		}
	}
	const inRules = (rules: ReadonlyArray<InferredRule>): void => {
		for (const r of rules) {
			for (const m of r.matches) {
				inSource(m.source)
			}
			for (const e of r.where) {
				inExpr(e)
			}
		}
	}
	const inStage = (st: InferredStage): void => {
		switch (st.kind) {
			case "rules":
				inRules(st.arms)
				return
			case "union":
				inStage(st.input)
				inRules(st.arms)
				return
			case "named":
			case "attach":
			case "order":
			case "take":
			case "approx":
				inStage(st.input)
				return
			case "recursive":
				inRules(st.recursive.base)
				inRules(st.recursive.rec)
				return
		}
	}
	inStage(query.stage)
	return out
}
