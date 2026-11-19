/** What the properties of describe.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { characterOf, codePoint, type Gen, string } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { descText } from "#compiler/ir/desc.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { succeeded } from "#test/support/assert.ts"
import { Work } from "#test/support/fixtures/api/work.ts"

/**
 * describeQuery and lowerQuery (packages/engine/src/program/describe.ts), the engine's internal inspection
 * vocabulary, with describeQuery's inverse (test/support/describe.ts queryFromDescription), over every generated query
 * read (test/support/oracle/public): a query rebuilt from its
 * Description, sent as JSON or not, is the same Description and lowers to the same statements; lowering is
 * byte-identical across runs; a bare Description, which names no schema, lowers to a MalformedDescription; and a
 * Description is checked against the schema it is given, a relation the schema lacks refused by its typed refusal.
 *
 * Oracles: the round trip (queryFromDescription ∘ describeQuery = id, as the Description's identity text, and lowering
 * a function of the Description), and the specification of the schema check. A relation the given schema lacks is
 * named by construction: its first letter begins none of the schema's relations.
 *
 * Features: every program form the public generator draws (programForms); a relation elsewhere.
 */

/** A Description as the rebuild receives it: the value itself, and the value read back from its JSON text. */
export const sentForms = (d: Json): ReadonlyArray<unknown> => [d, trustedJson<unknown>(jsonText(d))]

/** A query's Description, as its identity text. */
export const text = (q: unknown): string =>
	succeeded(descText(queryValueDesc(q)), "the query's Description text")

/** The first letters of Work's relations' names. */
const initials: ReadonlySet<string> = new Set(
	Arr.map(Rec.keys(Work.relations), (name) => Str.slice(0, 1)(name))
)

/** The capitals that begin none of Work's relations' names. */
const capitals = nonEmpty(
	Arr.filter(
		Arr.map(Arr.range(0x41, 0x5a), (point) => String.fromCodePoint(point)),
		(capital) => !initials.has(capital)
	),
	"a capital no relation of the schema begins with"
)

/**
 * The name of a relation the given schema lacks: a capital that begins none of its relations' names, then two to eight
 * small letters.
 */
export const named: Gen<string> = (source) =>
	`${source.draw(characterOf(capitals))}${source.draw(string(codePoint(0x61, 0x7a), { min: 2, max: 8 }))}`
