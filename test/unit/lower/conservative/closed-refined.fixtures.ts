/** What the properties of closed-refined.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { conservativeMeta, type Heading } from "#compiler/ir/rel.ts"
import { textOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { fixtureCodes } from "#test/support/unit/ir/fixture.ts"
import { Q, T } from "#test/support/unit/lower/conservative/fixtures.ts"

type Value = "abc" | "Abc"

/** The names the case lowers under: production's stand-ins, which name every pattern's domain by its definition, as an
 * installation holding the domain of every refinement its programs type a value by does. */
const names: PhysicalNames = productionNames(
	"Rosters",
	{ kind: "declared" },
	localVectorSchema,
	fixtureCodes
)

/** The name of the payload's pattern's domain, which a cast to it spells. */
export const domainName = defined(
	((text) => (text === undefined || typeof text === "string" ? undefined : names.textDomain(text)))(
		textOf(T.code)
	),
	"the names name a domain for the payload's pattern"
).name

/** Whether a statement names a type by `name` anywhere in its structure: a cast to the domain is the one such name. */
export const namesType = (statement: Select, name: string): boolean => {
	let named = false
	transformSelect(statement, {
		...identityHooks,
		typeRef: (type) => {
			if (type.kind === "named" && type.name === name) {
				named = true
			}
			return type
		}
	})
	return named
}

interface Case {
	readonly payload: ReadonlyArray<Value>
	readonly filtered: boolean
}

const payloadGen: Gen<ReadonlyArray<Value>> = element([
	[],
	["abc"],
	["Abc"],
	["abc", "abc"],
	["abc", "Abc"],
	["Abc", "Abc"]
])

export const caseGen: Gen<Case> = (source) => ({
	payload: source.draw(payloadGen),
	filtered: source.draw(element([false, true]))
})

export type Feature =
	| "an in-pattern payload delivered uncast"
	| "an out-of-pattern payload cast to its domain"
	| "an empty source delivered uncast"

const handles = ["Automatic", "Manual"] as const

export const lowered = (c: Case) => {
	const q = new Q()
	const heading: Heading = [
		{ name: "id", type: T.kind },
		{ name: "p0", type: T.code }
	]
	const rows: ReadonlyArray<ReadonlyArray<TypedLiteral>> = Arr.map(c.payload, (value, i) => [
		{ kind: "handle", handle: handles[i] ?? "Automatic" },
		{ kind: "text", value }
	])
	const source = q.closed("K0", heading, rows)
	const over = c.filtered ? q.filter(source, q.lit({ kind: "bool", value: true }, T.bool)) : source
	const root = q.project(
		over,
		[
			["id", "id"],
			["p0", "p0"]
		],
		conservativeMeta
	)
	const query = q.build(root)
	return lowerConservative(conservativeInput(query), {
		names,
		params: query.params,
		subject: { kind: "query" }
	})
}
