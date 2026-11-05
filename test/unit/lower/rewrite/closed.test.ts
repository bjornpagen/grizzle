import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type Heading } from "#compiler/ir/rel.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	ledgerCatalog,
	nodesOf,
	passContext,
	queryOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * R07 over a closed relation's installed constants (lower/optimize/closed): which occurrences of a declared closed
 * relation become a membership test of its installed key set, and the simplifier's invariant that a Closed node holding
 * fewer facts than its relation carries no declared name. The oracle is the rule's specification as a checker
 * (membershipOf's doc comment): an occurrence is rewritten exactly when every key field is read as a variable another
 * occurrence binds, a literal or a parameter, and no payload field is read. That the rewritten query delivers what the
 * VALUES join delivers is test/pg/closed/membership.test.ts's, on PostgreSQL.
 */

/** How the query reads one key field of Grid. */
const KEY_READS = ["item", "literal", "param", "free", "own"] as const
type KeyRead = (typeof KEY_READS)[number]

/** How the query reads Grid's payload `w`. */
const PAYLOAD_READS = ["unread", "item", "literal"] as const
type PayloadRead = (typeof PAYLOAD_READS)[number]

const Kind = closed("Kind", ["Open", "Done", "Held"])
const Tier = closed("Tier", ["Low", "High"])
/** A sparse relation keyed by (k0, k1), with a payload of Kind's closed id: 2 of its 6 key points. */
const Grid = closed.relation(
	"Grid",
	{ k0: closedId(Kind), k1: closedId(Tier), w: closedId(Kind) },
	["k0", "k1"],
	[
		{ k0: "Open", k1: "Low", w: "Done" },
		{ k0: "Held", k1: "High", w: "Open" }
	]
)
const Item = relation(
	"Item",
	{ id: pg.bigint, k0: closedId(Kind), k1: closedId(Tier), w: closedId(Kind) },
	["id"]
)
const Rewrite = schema("Rewrite", { Kind, Tier, Grid, Item }, [])

/** The items matched with Grid, its key fields read as `k0` and `k1` say and its payload as `w` says. */
const membership = (k0: KeyRead, k1: KeyRead, w: PayloadRead) =>
	query(Rewrite).rule((r) => {
		const item = v(Item, "item")
		const grid = v(Grid, "grid")
		const itemBinding = {
			id: item.id,
			...(k0 === "item" ? { k0: item.k0 } : {}),
			...(k1 === "item" ? { k1: item.k1 } : {}),
			...(w === "item" ? { w: item.w } : {})
		}
		const first =
			k0 === "item"
				? { k0: item.k0 }
				: k0 === "literal"
					? { k0: "Open" as const }
					: k0 === "param"
						? { k0: r.param("p0", Grid.fields.k0) }
						: k0 === "own"
							? { k0: grid.k0 }
							: {}
		const second =
			k1 === "item"
				? { k1: item.k1 }
				: k1 === "literal"
					? { k1: "High" as const }
					: k1 === "param"
						? { k1: r.param("p1", Grid.fields.k1) }
						: k1 === "own"
							? { k1: grid.k1 }
							: {}
		const payload = w === "item" ? { w: item.w } : w === "literal" ? { w: "Open" as const } : {}
		return r
			.match(Item, itemBinding)
			.match(Grid, { ...first, ...second, ...payload })
			.find({
				id: item.id,
				...(k0 === "own" ? { g0: grid.k0 } : {}),
				...(k1 === "own" ? { g1: grid.k1 } : {})
			})
	})

/** Whether the specification rewrites the occurrence: every key field one value, and no payload read. */
const specified = (k0: KeyRead, k1: KeyRead, w: PayloadRead): boolean => {
	const one = (read: KeyRead): boolean => read === "item" || read === "literal" || read === "param"
	return one(k0) && one(k1) && w === "unread"
}

type ClosedFeature =
	| "rewritten"
	| "kept: a key field left free"
	| "kept: a key field Grid alone binds"
	| "kept: the payload read"

const featureOf = (k0: KeyRead, k1: KeyRead, w: PayloadRead): ClosedFeature =>
	specified(k0, k1, w)
		? "rewritten"
		: k0 === "free" || k1 === "free"
			? "kept: a key field left free"
			: k0 === "own" || k1 === "own"
				? "kept: a key field Grid alone binds"
				: "kept: the payload read"

describe("R07 over closed constants", () => {
	it.effect(
		"rewrites an occurrence exactly when it reads every key field as one value and no payload",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/closed-membership",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element(KEY_READS)),
								source.draw(element(KEY_READS)),
								source.draw(element(PAYLOAD_READS))
							] as const,
						limit: KEY_READS.length * KEY_READS.length * PAYLOAD_READS.length,
						coverage: requiredInSpace<ClosedFeature>([
							"rewritten",
							"kept: a key field left free",
							"kept: a key field Grid alone binds",
							"kept: the payload read"
						]),
						caseHang,
						box: "every read of Grid's two key fields (an item's variable, a literal, a parameter, free, or Grid's own variable) with every read of its payload (none, an item's variable, a literal): 75 queries",
						oracle: {
							kind: "specification",
							name: "membershipOf's rule: every key field a variable bound elsewhere, a literal or a parameter, and no payload read"
						}
					},
					([k0, k1, w], c) =>
						Effect.sync(() => {
							const template = succeeded(
								compileTemplate(membership(k0, k1, w), Rewrite, testCompile)
							)
							const rewritten = Arr.some(
								template.certificates,
								(cert) => cert.rule === "R07.closedMembership"
							)
							c.note(featureOf(k0, k1, w))
							assert.equal(rewritten, specified(k0, k1, w), `k0 ${k0}, k1 ${k1}, w ${w}`)
							const sql = Arr.join(
								Arr.map(template.optimized, (s) => s.sql),
								"\n"
							)
							assert.equal(
								Str.includes("VALUES")(sql),
								!rewritten,
								`a rewritten Grid is read from its key set, a kept one from its facts:\n${sql}`
							)
						})
				)
			)
	)

	it.effect("reads a roster's membership as the tautology its domain makes it", () =>
		Effect.sync(() => {
			const template = succeeded(
				compileTemplate(
					query(Rewrite).rule((r) => {
						const item = v(Item, "item")
						return r.match(Item, { id: item.id, k0: item.k0 }).match(Kind, { id: item.k0 }).find({
							id: item.id
						})
					}),
					Rewrite,
					testCompile
				)
			)
			assert.ok(
				Arr.some(template.certificates, (cert) => cert.rule === "R07.closedMembership"),
				"R07 rewrites the roster's occurrence"
			)
			const sql = Arr.join(
				Arr.map(template.optimized, (s) => s.sql),
				"\n"
			)
			assert.ok(!Str.includes("VALUES")(sql), `the roster's occurrence is gone:\n${sql}`)
			assert.ok(!Str.includes("substring")(sql), `a roster is read through no constant:\n${sql}`)
		})
	)

	it.effect(
		"names a Closed node the simplifier narrows after no declared relation, and keeps a whole one's name",
		() =>
			Effect.sync(() => {
				const kind = (handle: string): TypedLiteral => ({ kind: "handle", handle })
				const heading: Heading = [{ name: "id", type: T.kind }]
				const rows = [[kind("Automatic")], [kind("Manual")]]
				for (const [keep, name] of [
					["Automatic", "__narrowed"],
					["both", "Kind"]
				] as const) {
					const q = new Q()
					const source = q.closed("Kind", heading, rows)
					const pred =
						keep === "both"
							? q.lit({ kind: "bool", value: true }, T.bool)
							: q.op("code:int2eq", [q.col(source, "id"), q.lit(kind(keep), T.kind)], T.bool)
					const root = q.project(q.filter(source, pred), [["id", "id"]], conservativeMeta)
					const dag = q.build(root).dag
					const ran = succeeded(
						runPasses(
							queryOf(dag, []),
							[simplifyPass],
							passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
						)
					)
					const names = Arr.map(nodesOf(ran.query.dag, "Closed"), (n) => n.closed)
					assert.deepEqual(names, [name], `keeping ${keep}`)
				}
			})
	)
})
