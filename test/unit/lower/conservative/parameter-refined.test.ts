import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { closed, decodedSchema, f, relation } from "#test/support/fixtures/ir/desc.ts"
import { installationOf, localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { fixtureCodes } from "#test/unit/ir/fixture.ts"
import { Q, T } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * A parameter's value of a text pattern delivered by the conservative lowering (lower/conservative/refined.ts): the
 * caller supplies it, so the trace never proves it inside the pattern, and the delivery checks it by a cast to the
 * pattern's domain, which PostgreSQL evaluates for every delivered row.
 *
 * - **With the pattern's domain named** (a stored field declares the pattern), the delivered value is cast to it.
 * - **With none**, no domain can check it, and the lowering refuses with UnsupportedOperation, naming the pattern and
 *   the parameter the value came from: a relation parameter's field where its delivered column is checked, naming the
 *   column too; a scalar parameter where it is typed, which is by its domain: the README's limit on delivering a pattern
 *   no stored field declares.
 *
 * The box: a relation parameter's field, or a scalar parameter, of the pattern ^[a-z]+$, delivered as the column t,
 * under names with and without the pattern's domain.
 */
type Supplier = "relation" | "scalar"

interface Case {
	readonly supplier: Supplier
	readonly domain: boolean
}

/** The names the case lowers under: production's stand-ins, with no domain for any pattern, or with the domain an
 * installation whose stored field carries the parameter's pattern names for it. */
const plain: PhysicalNames = productionNames(
	"Rosters",
	{ kind: "declared" },
	localVectorSchema,
	fixtureCodes
)
const patterned = installationOf(
	decodedSchema({
		name: "Rosters",
		relations: [
			closed("Kind", ["Automatic", "Manual"]),
			relation("Word", { id: f.uuid, word: f.regex("^[a-z]+$", "u") }, ["id"])
		],
		statements: [],
		extends: undefined
	}),
	{ kind: "declared" }
).names.textDomain
const withDomain: PhysicalNames = { ...plain, textDomain: patterned }
/** The installed name of the pattern's domain, which a cast to it spells. */
const domainName = defined(
	T.code.carrier === "text" && T.code.text.regex !== "wildcard"
		? patterned(T.code.text.regex)
		: undefined,
	"the installation names a domain for the parameter's pattern"
).name

const caseGen: Gen<Case> = (source) => ({
	supplier: source.draw(element<Supplier>(["relation", "scalar"])),
	domain: source.draw(element([false, true]))
})

type Feature = `${Supplier} cast to its domain` | `${Supplier} refused without a domain`

/** What a case's refusal names: the pattern and the parameter, and for a relation parameter's field the delivered
 * column. */
const namedBy = (supplier: Supplier): ReadonlyArray<string> =>
	supplier === "relation"
		? ["t's refinement", "/^[a-z]+$/u", "the parameter xs.t"]
		: ["/^[a-z]+$/u", "the parameter p"]

const lowered = (c: Case) => {
	const q = new Q()
	const root =
		c.supplier === "relation"
			? q.project(q.input("xs", [{ name: "t", type: T.code }]), [["t", "t"]], conservativeMeta)
			: q.project(
					q.closed(
						"K0",
						[{ name: "id", type: T.kind }],
						[[{ kind: "handle", handle: "Automatic" }]]
					),
					[["t", [q.param("p", T.code, "emit"), T.code]]],
					conservativeMeta
				)
	const query = q.build(root)
	return lowerConservative(conservativeInput(query), {
		names: c.domain ? withDomain : plain,
		params: query.params,
		subject: { kind: "query" }
	})
}

describe("a parameter's value of a text pattern", () => {
	it.effect(
		"is cast to the pattern's domain where the installation names one, and refused, naming the parameter and the pattern, where it names none",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/conservative/parameter-refined",
						generator: caseGen,
						literal: Formatter.format,
						limit: 4,
						box: "a relation parameter's field or a scalar parameter of one pattern, with and without the pattern's domain",
						oracle: {
							kind: "specification",
							name: "a parameter's value is unproved, so it is delivered through its domain or not at all"
						},
						coverage: requiredInSpace<Feature>([
							"relation cast to its domain",
							"relation refused without a domain",
							"scalar cast to its domain",
							"scalar refused without a domain"
						]),
						caseHang
					},
					(c, seen) =>
						Effect.sync(() => {
							const r = lowered(c)
							if (!c.domain) {
								seen.note(`${c.supplier} refused without a domain`)
								refused(r, "UnsupportedOperation", Formatter.format(c))
								const message = r.ok ? "" : r.error.message
								for (const named of namedBy(c.supplier)) {
									assert.ok(Str.includes(named)(message), `the refusal names ${named}: ${message}`)
								}
								return
							}
							seen.note(`${c.supplier} cast to its domain`)
							const program = succeeded(r, Formatter.format(c))
							assert.ok(
								Arr.some(flight(program.roots), (s) => Str.includes(domainName)(s.sql.text)),
								`t is cast to its domain: ${Formatter.format(c)}`
							)
						})
				)
			)
	)
})
