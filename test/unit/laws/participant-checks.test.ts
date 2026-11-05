import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { type Reached, required, type Situations } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order } from "effect"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type AlternativesCheck,
	type ImageGuard,
	handleOf,
	type LawField,
	type LawUnit,
	lawUnits,
	type ResidualLaw
} from "#compiler/ir/law.ts"
import { inputsOf, type RelNode } from "#compiler/ir/rel.ts"
import { emitResidualLaw, type ResidualUnitObjects } from "#compiler/laws/residual/skeleton.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { Expr, PlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	handleName,
	type ParentArmSketch,
	type ResidualSketch,
	residualSchema,
	residualSketchGen
} from "#test/support/laws/residual-schemas.ts"
import { ownedInput, owning } from "#test/support/policy.ts"

/**
 * Each participant of a residual law re-checks exactly its delta: what a write to its relation can break, at the rows
 * that can break it, and nothing more.
 *
 * The oracle is the law's own violation query, a node of the theory's DAG, never the planner. Its terms are the branches
 * of its union (one term for every family but alternatives, one per armed handle there), and a write to a relation can
 * break exactly the terms that read it. So, per participant:
 *
 * - an alternatives participant's check names exactly the handles of the terms that read its relation: every armed one
 *   for the parent, which also lists the whole roster in roster order, armed exactly where a term is; only its own arms'
 *   for an arm relation (soundness, and precision: an arm unit carrying the roster fails);
 * - a participant of another family is read by the law's single term;
 * - a relation on a term's positive side threatens by insertion alone and one on its negative side by deletion alone, so
 *   an alternatives parent has no DELETE unit and an arm relation no INSERT unit;
 * - each emitted unit's function raises once per term it re-checks: a refusal belongs to one term in one function;
 * - each unit's trigger filter reads only the row images its event has, and exactly the columns of its images' guards
 *   and, for an UPDATE, its UPDATE OF fields; it is absent exactly when an INSERT's or a DELETE's image always threatens.
 *
 * These are properties of the IR and of the AST the skeleton returns, never of printed text or sizes. Beside them, the
 * generator's named invalid point, a parent drawn as its own arm, is refused where its schema compiles, as a malformed
 * description: it would hold its handle in every fact.
 */

type ParticipantFeature =
	| "all armed"
	| "an unarmed handle"
	| "an arm relation shared by two handles"
	| "a merged participant"
	| "a mutable arm"
	| "a mutable parent"
	| "a roster of at least 8"
	| "the parent as its own arm, refused"
	| `family ${ResidualLaw["family"]}`

/** A drawn residual law the compiler admits: every sketch but the named invalid point. */
type Admitted = Exclude<ResidualSketch, ParentArmSketch>

/** The installation options of a drawn schema: the owner's, under one installation identity. */
const checksOptions = (owned: Owned) => ({
	...installOptions(owned, "owner"),
	installation: identity.schema(parsedSchemaName("checks"))
})

/** A residual law's terms: its violation's union branches, one when it is no union. */
const termsOf = (law: ResidualLaw): Arr.NonEmptyReadonlyArray<RelNode> => {
	const query = law.violation.kind === "Forbid" ? law.violation.violation : law.violation
	if (query.kind !== "Union") {
		return [query]
	}
	const [first, ...rest] = query.groups
	return [...first.arms, ...Arr.flatMap(rest, (g) => g.arms)]
}

/** The stored relations a node reads, through every input. */
const readsOf = (node: RelNode): ReadonlySet<string> => {
	const out = new Set<string>()
	const seen = new Set<RelNode>()
	const walk = (n: RelNode): void => {
		if (seen.has(n)) {
			return
		}
		seen.add(n)
		if (n.kind === "Base") {
			out.add(n.relation)
		}
		for (const input of inputsOf(n)) {
			walk(input)
		}
	}
	walk(node)
	return out
}

/** The relations a term reads on its positive side and on its negative side: an anti-join's left and right. */
const sidesOf = (
	term: RelNode
): { readonly positive: ReadonlySet<string>; readonly negative: ReadonlySet<string> } =>
	term.kind === "AntiJoin"
		? { positive: readsOf(term.left), negative: readsOf(term.right) }
		: { positive: readsOf(term), negative: new Set() }

/** The roster handle a term of an alternatives law selects its parent by: the constant on its discriminator. */
const selectedHandle = (term: RelNode, discriminator: string): string | undefined => {
	const seen = new Set<RelNode>()
	const walk = (n: RelNode): string | undefined => {
		if (seen.has(n)) {
			return undefined
		}
		seen.add(n)
		if (n.kind === "MatchRegion") {
			for (const o of n.occurrences) {
				for (const c of o.constants) {
					if (
						c.column === discriminator &&
						c.expr.kind === "literal" &&
						c.expr.value.kind === "enum"
					) {
						return c.expr.value.handle
					}
				}
			}
		}
		for (const input of inputsOf(n)) {
			const found = walk(input)
			if (found !== undefined) {
				return found
			}
		}
		return undefined
	}
	return walk(term)
}

/** The handles a check re-checks: the armed handles of its roster, or its arms'. */
const checked = (check: AlternativesCheck): ReadonlyArray<string> => {
	switch (check.kind) {
		case "roster":
			return Arr.flatMap(check.handles, (h) => (h.kind === "armed" ? [h.arm.handle] : []))
		case "arms":
			return Arr.map(check.arms, (a) => a.handle)
	}
}

/** The number of RAISE statements a block's statements hold. */
const raises = (body: ReadonlyArray<PlStatement>): number =>
	Arr.reduce(body, 0, (sum, s) => {
		switch (s.kind) {
			case "raise":
				return sum + 1
			case "if":
				return sum + Arr.reduce(s.branches, 0, (n, b) => n + raises(b.body)) + raises(s.else)
			case "case":
				return sum + Arr.reduce(s.whens, 0, (n, w) => n + raises(w.body))
			case "forQuery":
			case "whenAbsent":
				return sum + raises(s.body)
			case "assign":
			case "perform":
			case "return":
				return sum
		}
	})

/** The columns an expression reads of each row image. */
const imageColumns = (
	e: Expr
): { readonly NEW: ReadonlySet<string>; readonly OLD: ReadonlySet<string> } => {
	const read = { NEW: new Set<string>(), OLD: new Set<string>() }
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "field" && x.record.kind === "plSpecial") {
				read[x.record.name].add(x.field)
			}
			return x
		}
	})
	return read
}

/** The columns an image's guard reads: its selections' fields. */
const guardColumns = (guard: ImageGuard): ReadonlyArray<string> => {
	switch (guard.kind) {
		case "always":
			return []
		case "selected":
			return Arr.flatMap(guard.selections, (s) => Arr.map(s, (x) => x.field.column))
	}
}

const sorted = (xs: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(xs), Order.String)

/** The trigger filter's contract for one unit, read against its IR unit. */
const filterHolds = (object: ResidualUnitObjects, unit: LawUnit): void => {
	const trigger = object.trigger
	assert.equal(trigger.event.kind, unit.event, "a unit's trigger fires on its own event alone")
	const always = Option.isSome(Arr.findFirst(unit.images, (i) => i.image.guard.kind === "always"))
	const guards = always ? [] : Arr.flatMap(unit.images, (i) => guardColumns(i.image.guard))
	const of: ReadonlyArray<LawField> = unit.event === "UPDATE" ? unit.unit.on.of : []
	const expected = sorted([...guards, ...Arr.map(of, (f) => f.column)])
	if (trigger.when === undefined) {
		assert.ok(
			unit.event !== "UPDATE" && always,
			"only an always-threatening INSERT or DELETE is unfiltered"
		)
		return
	}
	assert.ok(
		unit.event === "UPDATE" || !always,
		"an always-threatening INSERT or DELETE is unfiltered"
	)
	const read = imageColumns(trigger.when)
	if (unit.event === "INSERT") {
		assert.equal(read.OLD.size, 0, "an INSERT's filter reads no OLD")
	}
	if (unit.event === "DELETE") {
		assert.equal(read.NEW.size, 0, "a DELETE's filter reads no NEW")
	}
	assert.deepEqual(
		sorted([...read.NEW, ...read.OLD]),
		expected,
		"a filter reads exactly its guards' and its UPDATE OF columns"
	)
	for (const f of of) {
		assert.ok(
			read.NEW.has(f.column) && read.OLD.has(f.column),
			`an UPDATE's change test compares ${f.column} across OLD and NEW`
		)
	}
}

/** What a law's compiled participants make of the situations the suite requires. */
const featuresOf = (law: ResidualLaw): ReadonlyArray<Reached<ParticipantFeature>> => {
	const family: ParticipantFeature = `family ${law.family}`
	if (law.family !== "alternativesReverse") {
		return [family]
	}
	const out: Array<Reached<ParticipantFeature>> = [family]
	for (const p of law.participants) {
		const updates = p.events.update !== undefined
		switch (p.check.kind) {
			case "roster": {
				const unarmed = Arr.some(p.check.handles, (h) => h.kind === "unarmed")
				out.push(unarmed ? "an unarmed handle" : "all armed")
				if (p.check.handles.length >= 8) {
					out.push("a roster of at least 8")
					if (unarmed) {
						out.push(["a roster of at least 8", "an unarmed handle"])
					}
				}
				if (updates) {
					out.push("a mutable parent")
				}
				continue
			}
			case "arms":
				if (p.check.arms.length > 1) {
					out.push("an arm relation shared by two handles", "a merged participant")
				}
				if (updates) {
					out.push("a mutable arm")
					if (p.check.arms.length > 1) {
						out.push(["a mutable arm", "an arm relation shared by two handles"])
					}
				}
				continue
		}
	}
	return out
}

/** The units the skeleton emits for a law, in law order, beside the IR's. */
const emitted = (sketch: Admitted) => {
	const desc = residualSchema(sketch)
	const owned = owning(desc)
	const installation = succeeded(compileInstallation(owned, checksOptions(owned)))
	const [law, ...more] = installation.laws.residuals
	assert.ok(law !== undefined && more.length === 0, "a drawn schema holds one residual law")
	const objects = succeeded(
		emitResidualLaw(law, {
			schema: installation.names.schema,
			names: installation.names,
			holders: () => []
		})
	)
	return { law, objects }
}

/** The named invalid point: its schema refused where it compiles, as a malformed description. */
const refusedParentArm = (sketch: ParentArmSketch): ReadonlyArray<ParticipantFeature> => {
	refused(
		Result.flatMap(ownedInput(residualSchema(sketch)), (owned) =>
			compileInstallation(owned, checksOptions(owned))
		),
		"MalformedDescription",
		"a parent drawn as its own arm is refused"
	)
	return ["the parent as its own arm, refused"]
}

/** The property of one drawn law (see the header). */
const delta = (sketch: Admitted): ReadonlyArray<Reached<ParticipantFeature>> => {
	const { law, objects } = emitted(sketch)
	const terms = termsOf(law)
	const units = lawUnits(law)
	assert.equal(objects.units.length, units.length, "one emitted unit per IR unit")
	for (const [i, unit] of units.entries()) {
		const object = objects.units[i]
		assert.ok(object !== undefined, "every IR unit is emitted")
		filterHolds(object, unit)
	}
	switch (law.family) {
		case "alternativesReverse": {
			const discriminator = law.discriminator.name
			const termHandles = Arr.map(terms, (t) => {
				const h = selectedHandle(t, discriminator)
				assert.ok(
					h !== undefined,
					"every term of an alternatives law selects its parent by a handle"
				)
				return { handle: h, term: t, sides: sidesOf(t) }
			})
			for (const p of law.participants) {
				const relation = p.relation.name
				const expected = sorted(
					Arr.flatMap(termHandles, (t) => (readsOf(t.term).has(relation) ? [t.handle] : []))
				)
				assert.deepEqual(
					sorted(checked(p.check)),
					expected,
					`${relation} re-checks exactly its terms`
				)
				const positive = Arr.some(termHandles, (t) => t.sides.positive.has(relation))
				const negative = Arr.some(termHandles, (t) => t.sides.negative.has(relation))
				assert.equal(p.events.insert !== undefined, positive, `${relation} threatens by insertion`)
				assert.equal(p.events.delete !== undefined, negative, `${relation} threatens by deletion`)
				if (p.check.kind !== "roster") {
					continue
				}
				assert.ok(sketch.kind === "alternatives", "a roster check is an alternatives law's")
				assert.deepEqual(
					Arr.map(p.check.handles, handleOf),
					Arr.makeBy(sketch.roster, handleName),
					"the parent's roster is every handle, in roster order"
				)
				for (const h of p.check.handles) {
					assert.equal(
						h.kind === "armed",
						Arr.some(termHandles, (t) => t.handle === handleOf(h)),
						`${handleOf(h)} is armed exactly where a term selects it`
					)
				}
			}
			for (const object of objects.units) {
				const participant = Option.getOrThrowWith(
					Arr.findFirst(law.participants, (p) => p === object.participant),
					() => new Error("a unit's participant is the law's")
				)
				assert.equal(
					raises(object.function.body.body),
					checked(participant.check).length,
					"a unit raises once per term it re-checks"
				)
			}
			break
		}
		case "selectedSourceContainment":
		case "conditionalMirrors":
		case "scalarCapacity":
		case "selectedSourceCoverage": {
			/**
			 * One term, beside which a capacity whose bounds exclude zero, as the drawn capacity's low bound of 1 does, has
			 * its empty groups' (analysis/theory/laws.ts capacityViolation), which its law function checks in the same one
			 * comparison of the group's weight.
			 */
			const [term, ...rest] = terms
			assert.equal(
				rest.length,
				law.family === "scalarCapacity" ? 1 : 0,
				"the family's violation is one term, and a capacity's empty groups beside it"
			)
			for (const p of law.participants) {
				assert.ok(
					readsOf(term).has(p.relation.name),
					`${p.relation.name} is read by the law's term`
				)
			}
			for (const object of objects.units) {
				assert.equal(raises(object.function.body.body), 1, "a unit raises once, for the law's term")
			}
			break
		}
	}
	return featuresOf(law)
}

describe("residual law participants", () => {
	it.effect(
		"each participant re-checks exactly its delta, and each unit's trigger filters exactly its event's images",
		(ctx) => {
			const situations: Situations<ParticipantFeature> = [
				"all armed",
				"an unarmed handle",
				"an arm relation shared by two handles",
				"a merged participant",
				"a mutable arm",
				"a mutable parent",
				"a roster of at least 8",
				"the parent as its own arm, refused",
				"family alternativesReverse",
				"family selectedSourceContainment",
				"family conditionalMirrors",
				"family scalarCapacity",
				"family selectedSourceCoverage",
				["a roster of at least 8", "an unarmed handle"],
				["a mutable arm", "an arm relation shared by two handles"]
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/laws/participant-checks",
						draw: drawn(residualSketchGen),
						literal: Formatter.format,
						coverage: required<ParticipantFeature>(situations, { cases: 200, sense: notesOnly }),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(sketch, c) =>
						Effect.sync(() => {
							for (const reached of sketch.kind === "parentArm"
								? refusedParentArm(sketch)
								: delta(sketch)) {
								if (typeof reached === "string") {
									c.note(reached)
								} else {
									c.pair(reached[0], reached[1])
								}
							}
						})
				)
			)
		}
	)
})
