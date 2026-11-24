/** What the properties of derived-evidence.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"

/**
 * A query over a stored derived relation rests on the key its table's installation enforces.
 *
 * A stored derived relation inherits a key from its definition (analysis/derived), which its installation enforces on
 * its table. The optimized artifact of a query over it is annotated under the schema's derived keys (logical/annotate.ts
 * queryEvidence), so a projection of the stored relation that keeps the inherited key is keyed by it, and the proof that
 * the projection delivers no duplicate rests on the table's key, which a certificate of the template names as a
 * premise. Annotated under the checker's evidence alone, the stored relation's Base is keyed by its whole heading, the
 * projection keeps a DISTINCT, and no premise names the key. A ChangeSet's read-back of the same projection is lowered
 * under the same evidence (write/readback/lower.ts), so the compiled write rests it on the same key.
 *
 * The space is exhaustive over a box of its own: Docs' lines of a document, each document a unit, and two stored
 * relations local to it, DocWords, each document's line count and word sum, keyed by doc, and LongLines, the lines
 * themselves, keyed by at and doc in heading order, each projected to its key and every proper subset of its other columns, so every
 * projection drops a column. The oracle is that specification: the table's key, named by the installation's own names
 * (viewKeyIndex), is a premise of the template's and of the write's certificates.
 *
 * Features: each stored relation, a read-back over one.
 */

/**
 * A stored derived relation of the box: the schema, the derived relation and the key it inherits from its definition
 * (test/unit/derived/keys.test.ts derives both).
 */
interface View {
	readonly schema: AnySchema
	readonly relation: { readonly name: ViewName; readonly heading: object }
	readonly key: ReadonlyArray<string>
}

type ViewName = "DocWords" | "LongLines"

export type EvidenceFeature = ViewName | "read-back over a stored relation"

/** A line of a document: its place and its word count. */
const Line = relation("Line", { doc: Id, at: pg.integer, words: pg.integer }, ["doc", "at"])

const Docs = schema("Docs", [Line], [unit("Document", { doc: Id })])

/** Each document's line count and word sum, keyed by the document, in its unit. */
const DocWords = derived(
	"DocWords",
	query(Docs).rule((r) => {
		const { doc, at, words } = v(Line, "line")
		return r.match(Line, { doc, at, words }).find({ doc, lines: r.count(), total: r.sum(words) })
	})
)

/** The lines themselves, keyed by their document and place, in the document's unit. */
const LongLines = derived(
	"LongLines",
	query(Docs).rule((r) => {
		const { doc, at, words } = v(Line, "line")
		return r.match(Line, { doc, at, words }).find({ doc, at, words })
	})
)

const Stored = schema.extend([Docs], "Stored", [DocWords, LongLines], [])

const views: Arr.NonEmptyReadonlyArray<View> = [
	{ schema: Stored, relation: DocWords, key: ["doc"] },
	{ schema: Stored, relation: LongLines, key: ["at", "doc"] }
]

/**
 * The view's unique index on its inherited key, as its schema's installation creates it, and the schema's artifacts,
 * whose names a write compiles under.
 */
interface Installed {
	readonly index: ConstraintName
	readonly artifacts: SchemaArtifacts
}

export const installedOf = (view: View): Installed => {
	const artifacts = testArtifacts(view.schema, testCompile)
	if (!artifacts.ok) {
		throw new Error(
			`the schema of ${view.relation.name} has no artifacts: ${artifacts.error.message}`
		)
	}
	return {
		index: installationNamesOf(installationOf(view.schema, { kind: "declared" })).viewKeyIndex(
			view.relation,
			view.key
		),
		artifacts: artifacts.value
	}
}

/** The query over a view's schema that matches the view and finds `columns`. */
export const projectionOf = (view: View, columns: ReadonlyArray<string>): unknown =>
	queryOver(view.schema).rule((r: RuleValue) => {
		const vars = varsOver(view.relation, "relation")
		const head = Record.fromEntries(
			Arr.map(columns, (column) => [column, defined(vars[column], `the variable of ${column}`)])
		)
		return r.match(view.relation, vars).find(head)
	})

export const shown = (constraints: ReadonlyArray<string>): string =>
	constraints.length === 0 ? "no premise" : Arr.join(constraints, ", ")

/** The columns of a view outside its key. */
const othersOf = (view: View): ReadonlyArray<string> =>
	Arr.filter(Record.keys(view.relation.heading), (column) => !view.key.includes(column))

/**
 * A subset of `items` that leaves at least one out, in their order: its size, smaller first, then each member after
 * the one before, each far enough from the end to leave room for the rest. Every proper subset is one case, smaller
 * subsets first, so an enumeration meets each once and discards none.
 */
const properSubset =
	<A>(items: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(source) => {
		const size = source.draw(int(0, items.length - 1))
		const kept: Array<A> = []
		let from = 0
		for (let left = size; left > 0; left -= 1) {
			const at = source.draw(int(from, items.length - left))
			kept.push(defined(items[at], `item ${at}`))
			from = at + 1
		}
		return kept
	}

/** Every projection of a view that keeps its key and drops at least one other column. */
export const space: Gen<{ readonly view: View; readonly columns: ReadonlyArray<string> }> = (
	source
) => {
	const view = source.draw(element(views))
	const kept = source.draw(properSubset(othersOf(view)))
	return { view, columns: [...view.key, ...kept] }
}
