/** What the properties of discharge.test.ts read: the box's schemas, each law's discharge in an installation, and the
 * checks a drafted migration runs. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, retirement } from "#compiler/public/fields.ts"
import {
	contained,
	key,
	mutable,
	on,
	relation,
	retirable,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { defined } from "#test/support/assert.ts"

/** A unit's header, each of its groups open until retired. */
const H = relation("H", { g: pg.integer, retired: retirement }, ["g"])
/** A body of H's units, and a relation keyed by the same unit first. */
const B = relation("B", { g: pg.integer, i: pg.integer, kind: pg.integer }, ["g", "i"])
const C = relation("C", { g: pg.integer, i: pg.integer, kind: pg.integer }, ["g", "i"])
/** A relation keyed apart from the unit. */
const D = relation("D", { i: pg.integer, n: pg.integer }, ["i"])
/** A relation keyed by the unit first, each of its fields one of its key's. */
const E = relation("E", { g: pg.integer, i: pg.integer }, ["g", "i"])
/** A relation keyed by the unit first, with a field beyond a superkey of its key. */
const F = relation("F", { g: pg.integer, i: pg.integer, kind: pg.integer, n: pg.integer }, [
	"g",
	"i"
])
/** A relation keyed by the unit first, with a declared key (g, j) beside its primary key. */
const G = relation("G", { g: pg.integer, i: pg.integer, j: pg.integer }, ["g", "i"])

/**
 * The box's containments, by what decides each one's discharge (laws/model/plan.ts containmentDischarge):
 *
 * - fence and second fence: B's and C's groups in H's open groups, the fences of the unit of H whose bodies are B and
 *   C, each into a selected side of H, unit-local;
 * - selected: C's facts of kind 1 in B, from a side selected by a comparison, unit-local;
 * - listed: B's facts of kind 1 or 2 in C's of kind 2, between two selected sides, unit-local;
 * - plain: C in B at B's primary key, neither side selected, into a target holding a field its terms do not read,
 *   unit-local;
 * - into declared key: C in G at G's declared key (g, j), neither side selected, into a target holding a field its terms
 *   do not read, unit-local;
 * - into superkey: C in F at (g, i, kind), a superkey of F's primary key and not every field of F, neither side
 *   selected, unit-local;
 * - into whole: C in E, neither side selected, every field of E one of its terms, unit-local;
 * - selected into whole: C's facts of kind 4 in E, a selected side into a target every field of which it reads,
 *   unit-local;
 * - across: C's facts of kind 3 in D at i alone, from a selected side, joined across units;
 * - computed: C's facts whose kind plus one is at least 4 in B, a side selected by a computed value, unit-local.
 */
export const containments = [
	"fence",
	"second fence",
	"selected",
	"listed",
	"plain",
	"into declared key",
	"into superkey",
	"into whole",
	"selected into whole",
	"across",
	"computed"
] as const
export type Containment = (typeof containments)[number]

/**
 * The containment into a target no key holds apart a case adds, or none: B is keyed by (g, i) and D by i, so neither
 * B(g, kind) nor D(n) holds a key.
 *
 * - unkeyed: C in B at (g, kind), neither side selected, unit-local;
 * - unkeyed across: C in D at kind against n, joined across units;
 * - unkeyed computed: C's facts whose kind plus one is at least 4 in B at (g, kind), selected by a computed value.
 */
const unkeyeds = ["none", "unkeyed", "unkeyed across", "unkeyed computed"] as const
export type Unkeyed = (typeof unkeyeds)[number]

/** The relations a case declares mutable. */
const mutabilities = ["none", "B", "C", "B and C", "D"] as const
type Mutability = (typeof mutabilities)[number]

export interface Case {
	readonly mutable: Mutability
	readonly unkeyed: Unkeyed
}

export const caseGen: Gen<Case> = (s) => ({
	mutable: s.draw(element(mutabilities)),
	unkeyed: s.draw(element(unkeyeds))
})

/** The relations of `mutable`, each of the box's. */
const mutableOf = (m: Mutability) => {
	switch (m) {
		case "none":
			return []
		case "B":
			return [mutable(B)]
		case "C":
			return [mutable(C)]
		case "B and C":
			return [mutable(B), mutable(C)]
		case "D":
			return [mutable(D)]
	}
}

/** The statement of a case's unkeyed containment, none for none. */
const unkeyedOf = (u: Unkeyed) => {
	switch (u) {
		case "none":
			return []
		case "unkeyed":
			return [contained(on(C, "g", "kind"), on(B, "g", "kind"))]
		case "unkeyed across":
			return [contained(on(C, "kind"), on(D, "n"))]
		case "unkeyed computed":
			return [
				contained(
					on(
						select(C, (r) => Compute.ge(Compute.add(r.kind, 1), 4n)),
						"g",
						"kind"
					),
					on(B, "g", "kind")
				)
			]
	}
}

/** The box's relations, by name. */
type Name = "H" | "B" | "C" | "D" | "E" | "F" | "G"

/** Whether a case declares the relation `name` mutable. */
const isMutable = (m: Mutability, name: Name): boolean => {
	switch (m) {
		case "none":
			return false
		case "B and C":
			return name === "B" || name === "C"
		case "B":
		case "C":
		case "D":
			return name === m
	}
}

/** The case's schema: H, B, C, D, E, F and G, G's declared key, every containment of the box, the case's unkeyed one,
 * and its mutable relations. */
export const schemaOf = (c: Case): AnySchema =>
	schema(
		"discharge",
		[H, B, C, D, E, F, G],
		[
			retirable(H, [on(B, "g"), on(C, "g")]),
			key(on(G, "g", "j")),
			contained(
				on(
					select(C, (r) => r.eq(r.kind, 1)),
					"g",
					"i"
				),
				on(B, "g", "i")
			),
			contained(
				on(
					select(B, (r) => r.in(r.kind, [1, 2])),
					"g",
					"i"
				),
				on(
					select(C, (r) => r.eq(r.kind, 2)),
					"g",
					"i"
				)
			),
			contained(on(C, "g", "i"), on(B, "g", "i")),
			contained(on(C, "g", "i"), on(G, "g", "j")),
			contained(on(C, "g", "i", "kind"), on(F, "g", "i", "kind")),
			contained(on(C, "g", "i"), on(E, "g", "i")),
			contained(
				on(
					select(C, (r) => r.eq(r.kind, 4)),
					"g",
					"i"
				),
				on(E, "g", "i")
			),
			contained(
				on(
					select(C, (r) => r.eq(r.kind, 3)),
					"i"
				),
				on(D, "i")
			),
			contained(
				on(
					select(C, (r) => Compute.ge(Compute.add(r.kind, 1), 4n)),
					"g",
					"i"
				),
				on(B, "g", "i")
			),
			...unkeyedOf(c.unkeyed),
			...mutableOf(c.mutable)
		]
	)

/** How a law is discharged in an installation: whole by the rule judge, or by a foreign key that carries it. */
export type Discharged = "whole" | "native"

/**
 * The discharge the box's statement of each containment states (the specification, laws/model/plan.ts
 * ContainmentDischarge): whole exactly where it is no fence, it selects, each side selects by comparisons of its
 * fields, every term a field, every relation it reads is immutable, and its two sides join within one unit, which the
 * box's every statement but `across` does; native everywhere else, every plain containment among them, each into a
 * target a key holds apart, at a declared key's fields or a superkey's.
 */
export const expected = (c: Case, of: Containment): Discharged => {
	const reads: { readonly [K in Containment]: ReadonlyArray<Name> } = {
		fence: ["B", "H"],
		"second fence": ["C", "H"],
		selected: ["C", "B"],
		listed: ["B", "C"],
		plain: ["C", "B"],
		"into declared key": ["C", "G"],
		"into superkey": ["C", "F"],
		"into whole": ["C", "E"],
		"selected into whole": ["C", "E"],
		across: ["C", "D"],
		computed: ["C", "B"]
	}
	switch (of) {
		case "fence":
		case "second fence":
		case "plain":
		case "into declared key":
		case "into superkey":
		case "into whole":
		case "across":
		case "computed":
			return "native"
		case "selected":
		case "listed":
		case "selected into whole":
			return Arr.some(reads[of], (r) => isMutable(c.mutable, r)) ? "native" : "whole"
	}
}

/**
 * What the box's statement of a case's unkeyed containment states (the specification, laws/model/plan.ts
 * containmentDischarge): no native constraint states it, so it is whole where its sides select by comparisons of their
 * fields, every relation it reads is immutable and its two sides join within one unit, as unkeyed does over C and B;
 * and the schema is refused anywhere else, across units, selected by a computed value, or over a mutable relation.
 */
export const unkeyedExpected = (c: Case): "absent" | "whole" | "refused" => {
	switch (c.unkeyed) {
		case "none":
			return "absent"
		case "unkeyed":
			return isMutable(c.mutable, "B") || isMutable(c.mutable, "C") ? "refused" : "whole"
		case "unkeyed across":
		case "unkeyed computed":
			return "refused"
	}
}

/** The containment law of the box's statement `of` in a theory's laws. */
export const lawOf = (laws: ReadonlyArray<TheoryLaw>, of: Containment | "unkeyed"): TheoryLaw => {
	const found = Arr.filter(laws, (law) => {
		const d = law.detail
		if (d.kind !== "containment") {
			return false
		}
		const from = d.from.selection.conjuncts.length > 0
		const at = (name: string) => Arr.some(d.to.terms, (t) => t.column.name === name)
		switch (of) {
			case "fence":
				return law.source.kind === "retirable" && d.from.relation === "B"
			case "second fence":
				return law.source.kind === "retirable" && d.from.relation === "C"
			case "selected":
				return (
					d.from.relation === "C" &&
					d.to.relation === "B" &&
					at("i") &&
					from &&
					Arr.every(d.from.selection.conjuncts, (x) => x.kind === "fixed")
				)
			case "listed":
				return d.from.relation === "B" && d.to.relation === "C"
			case "plain":
				return d.from.relation === "C" && d.to.relation === "B" && at("i") && !from
			case "into declared key":
				return d.to.relation === "G"
			case "into superkey":
				return d.to.relation === "F"
			case "into whole":
				return d.to.relation === "E" && !from
			case "selected into whole":
				return d.to.relation === "E" && from
			case "across":
				return d.to.relation === "D" && at("i")
			case "computed":
				return (
					d.from.relation === "C" &&
					d.to.relation === "B" &&
					at("i") &&
					Arr.some(d.from.selection.conjuncts, (x) => x.kind === "general")
				)
			case "unkeyed":
				return (
					d.from.relation === "C" && (d.to.relation === "B" || d.to.relation === "D") && !at("i")
				)
		}
	})
	return defined(
		found.length === 1 ? found[0] : undefined,
		`the one law of the box's ${of} containment`
	)
}

/** The containments the theory gives evidence of: each whose source selects by fixed fields alone, or selects nothing
 * (analysis/theory/theory.ts evidenceSides), whatever its discharge. */
export const evidenced: ReadonlyArray<Containment> = [
	"fence",
	"second fence",
	"selected",
	"plain",
	"into declared key",
	"into superkey",
	"into whole",
	"selected into whole",
	"across"
]

/** How `installation` discharges the law `law`: whole where its judge holds it as a whole rule, native where a foreign
 * key carries it, and neither or both a defect of the law model. */
export const dischargedIn = (
	installation: Installation,
	law: LawId
): Discharged | "neither" | "both" => {
	const whole = Arr.some(
		installation.laws.rules,
		(r) => r.law.id === law && r.rule.kind === "whole"
	)
	const native = Arr.some(
		installation.laws.natives,
		(n) =>
			(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
			Arr.some(n.object.lawIds, (id) => id === law)
	)
	return whole && native ? "both" : whole ? "whole" : native ? "native" : "neither"
}

/** A migration's discharge of the selected containment before and after: absent, native or whole. */
const befores = ["absent", "native", "whole"] as const
const afters = ["native", "whole"] as const

export interface MigrationCase {
	readonly before: (typeof befores)[number]
	readonly after: (typeof afters)[number]
}

export const migrationCaseGen: Gen<MigrationCase> = (s) => ({
	before: s.draw(element(befores)),
	after: s.draw(element(afters))
})

/** The schema of one version of a migration case: B and C, the selected containment unless absent, native where B is
 * mutable, whole where it is not. */
export const versionOf = (discharge: MigrationCase["before"]): AnySchema =>
	schema(
		"discharge_migrated",
		[B, C],
		[
			...(discharge === "absent"
				? []
				: [
						contained(
							on(
								select(C, (r) => r.eq(r.kind, 1)),
								"g",
								"i"
							),
							on(B, "g", "i")
						)
					]),
			...(discharge === "native" ? [mutable(B)] : [])
		]
	)

/** The laws a drafted migration checks over every row in its Validate steps. */
export const checkedLaws = (drafted: GenerateResult): ReadonlyArray<LawId> =>
	Arr.flatMap(drafted.plan.steps, (step) =>
		step.draft.kind === "violation" ? [step.draft.law] : []
	)
