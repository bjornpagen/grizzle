/** What the properties of check-identity.test.ts read: their spaces, the schema's versions and the checks they draft. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import { type LawChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Bit, closedId, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A law of the schema, each over what no other reads: Positive over D1, Small over D2, Tiered over the closed tiers;
 * and over D3, each reading the closed caps by a closed read alone, Capped by C.at its cap, Listed by C.has its key set
 * and Covered by C.row its key set.
 */
export const laws = ["Positive", "Small", "Tiered", "Capped", "Listed", "Covered"] as const

export type Law = (typeof laws)[number]

/**
 * What the second version changes: nothing; Positive's bound; D1's definition, the selection Positive's rule reads;
 * D2's, Small's; a closed row, Tiered's; a cap, the payload Capped's C.at reads; a cap's tier added, the key set every
 * closed read of the caps reads; or a cap's note, a payload no law reads.
 */
const changes = [
	"none",
	"bound",
	"first definition",
	"second definition",
	"closed row",
	"cap",
	"capped tier",
	"cap note"
] as const

export type Change = (typeof changes)[number]

/**
 * One case: its change, and its judge, whole, T and U immutable, or probed, T and U mutable inside the unit of their
 * document and each definition joining W, mutable in a unit of its own, so every rule reads the rows of two units.
 */
export interface Shape {
	readonly change: Change
	readonly judge: "whole" | "probed"
}

export const shapeGen: Gen<Shape> = (s) => ({
	change: s.draw(element(changes)),
	judge: s.draw(element(["whole", "probed"] as const))
})

/** The laws a change changes the meaning of, by its oracle, the schema's own reads: each law reads its own relation. */
export const changedBy = (change: Change): ReadonlyArray<Law> => {
	switch (change) {
		case "none":
			return []
		case "bound":
		case "first definition":
			return ["Positive"]
		case "second definition":
			return ["Small"]
		case "closed row":
			return ["Tiered"]
		case "cap":
			return ["Capped"]
		case "capped tier":
			return ["Capped", "Listed", "Covered"]
		case "cap note":
			return []
	}
}

const Tier = closed.ordered("Tier", ["low", "mid", "high"])

/**
 * The schema of `shape` at `version`: T's facts by document and place; D1, those of T whose `a` is one, and D2, whose
 * `a` is two, each a derived relation; Positive, D1's `b` at least its bound, and Small, D2's `b` at most 100, each a
 * rule over a query; TierRank and TierNext, closed, and Tiered, TierNext's next a ranked tier, a law over closed
 * relations alone; U's facts by document, each of a tier, D3 all of them, and Cap, closed, each capped tier's cap and
 * note; and over D3, each a rule over a query reading Cap by a closed read alone, Capped, its `b` at most its tier's
 * cap, Listed, its tier one Cap holds, and Covered, its tier among those Cap holds. The second version holds the case's
 * change.
 */
const schemaOf = (shape: Shape, version: "first" | "second") => {
	const changed = (c: Change): boolean => version === "second" && shape.change === c
	const T = relation("T", { doc: int4, at: int4, a: int4, b: int4 }, ["doc", "at"])
	const TierRank = closed.relation(
		"TierRank",
		{ tier: closedId(Tier), rank: int4 },
		["tier"],
		changed("closed row")
			? [
					{ tier: "low", rank: 1 },
					{ tier: "mid", rank: 2 },
					{ tier: "high", rank: 3 }
				]
			: [
					{ tier: "low", rank: 1 },
					{ tier: "high", rank: 3 }
				]
	)
	const TierNext = closed.relation(
		"TierNext",
		{ tier: closedId(Tier), next: closedId(Tier) },
		["tier"],
		[{ tier: "low", next: "high" }]
	)
	const U = relation("U", { doc: int4, tier: closedId(Tier), b: int4 }, ["doc"])
	const Cap = closed.relation(
		"Cap",
		{ tier: closedId(Tier), cap: int4, note: int4 },
		["tier"],
		changed("capped tier")
			? [
					{ tier: "low", cap: 10, note: 1 },
					{ tier: "mid", cap: 15, note: 1 },
					{ tier: "high", cap: 20, note: 1 }
				]
			: [
					{ tier: "low", cap: 10, note: changed("cap note") ? 2 : 1 },
					{ tier: "high", cap: changed("cap") ? 30 : 20, note: 1 }
				]
	)
	const W = relation("W", { wdoc: int4 }, ["wdoc"])
	const probed = shape.judge === "probed"
	const Base = schema(
		"check_identity",
		[T, U, W, Tier, TierRank, TierNext, Cap],
		probed
			? [
					unit("Document", { doc: int4 }),
					unit("Ws", { wdoc: int4 }),
					mutable(T),
					mutable(U),
					mutable(W)
				]
			: []
	)
	const selected = (a: number) =>
		query(Base).rule((r) => {
			const { doc, at, b } = v(T, "t")
			const matched = r.match(T, { doc, at, a, b })
			return probed
				? matched.match(W, { wdoc: doc }).find({ doc, at, b })
				: matched.find({ doc, at, b })
		})
	const D1 = derived("D1", selected(changed("first definition") ? 3 : 1))
	const D2 = derived("D2", selected(changed("second definition") ? 4 : 2))
	const D3 = derived(
		"D3",
		query(Base).rule((r) => {
			const { doc, tier, b } = v(U, "u")
			const matched = r.match(U, { doc, tier, b })
			return probed
				? matched.match(W, { wdoc: doc }).find({ doc, tier, b })
				: matched.find({ doc, tier, b })
		})
	)
	const bound = changed("bound") ? 1 : 0
	return schema.extend(
		[Base],
		"check_identity_1",
		[D1, D2, D3],
		[
			check("Positive", D1, (d) => d.ge(d.b, bound)),
			check("Small", D2, (d) => d.le(d.b, 100)),
			contained(on(TierNext, "next"), on(TierRank, "tier")),
			check("Capped", D3, (d) => d.le(d.b, Cap.at("cap", d.tier))),
			check("Listed", D3, (d) => Cap.has(d.tier)),
			check("Covered", D3, (d) => d.eq(Bit.subset(Bit.singleton(d.tier), Cap.row()), true))
		]
	)
}

/** Each law's stem, as the naming door spells its identifier (core/identity.ts): its own name's. */
const stems: Readonly<Record<Law, string>> = {
	Positive: "positive",
	Small: "small",
	Tiered: "tier_next",
	Capped: "capped",
	Listed: "listed",
	Covered: "covered"
}

/** The law of a check's identifier, by its stem. */
export const lawOf = (id: string): Law =>
	Option.getOrThrowWith(
		Arr.findFirst(laws, (law) => Str.includes(stems[law])(Str.toLowerCase(id))),
		() => new Error(`a law of the schema, not ${id}`)
	)

/** The laws a draft checks over the rows it finds: each violation step of its plan, by its law. */
const checkedLaws = (plan: Parameters<typeof planFiles>[0]): ReadonlyArray<Law> =>
	Arr.flatMap(planFiles(plan), (file) =>
		Arr.flatMap(file.drafts, (d) => (d.kind === "violation" ? [lawOf(d.law)] : []))
	)

/** The laws the second version's draft checks, and the first's: the first drafted from no installation. */
export const drafted = (
	shape: Shape
): { readonly first: ReadonlyArray<Law>; readonly second: ReadonlyArray<Law> } => {
	const [first, second] = draftChain(
		[
			{ desc: schemaOf(shape, "first"), options: asDrafted, declared: noDeclarations },
			{ desc: schemaOf(shape, "second"), options: asDrafted, declared: noDeclarations }
		],
		fromEmpty
	)
	return {
		first: checkedLaws(defined(first, "the first migration").plan),
		second: checkedLaws(defined(second, "the second migration").plan)
	}
}

/** The checks of the first version installed in the PostgreSQL schema `name`. */
export const checksIn = (shape: Shape, name: string): LawChecks => {
	const owned = succeeded(
		own(defined(schemaDescOf(schemaOf(shape, "first")), "the case's description"))
	)
	const levels = Arr.map(owned.levels, (_, i) => identity.schema(parsedSchemaName(`${name}_${i}`)))
	return lawChecks(
		succeeded(
			compileInstallation(
				owned,
				completeInstallOptions(owned, levels, [], [], firstCodebook(rostersOf(owned)))
			)
		)
	)
}
