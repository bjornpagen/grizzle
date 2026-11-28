/** What the property of edits.test.ts reads: its space, schema and fixture. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg, span } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { type SpanKeyedOwner, spanOwnersGen } from "#test/support/families/generate.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

export const SpanOwner = relation(
	"SpanOwner",
	{
		id: pg.integer,
		during: span(pg.integer),
		label: pg.integer,
		n: drawn(natural),
		end: accumulated(pg.integer, 0)
	},
	["id", "during"]
)

export const SpanMember = relation(
	"SpanMember",
	{ member: pg.integer, g: pg.integer, gd: span(pg.integer), x: pg.integer },
	["member"]
)

const spanFamily = counted(on(SpanMember, "g", "gd"), fin(SpanOwner, "n"))

/** The int4 sum over a counted family whose owner is keyed by an id and a span WITHOUT OVERLAPS, both mutable. */
export const SpanEdited = schema(
	"fin_span_edits",
	[SpanOwner, SpanMember],
	[
		spanFamily,
		fold(
			spanFamily,
			Monoid.sum,
			on(SpanMember, "g", "gd", "x"),
			on(SpanOwner, "id", "during", "end")
		),
		mutable(SpanOwner),
		mutable(SpanMember),
		unit("Spanned", { id: pg.integer }),
		unit("Counted", { member: pg.integer })
	]
)

/** The span-keyed owners' workload: their insert with their members, and an owner's put, each from its call's facts. */
const spanPrograms = Object.freeze({
	insertOwners: ChangeSet.empty(SpanEdited).insert(SpanOwner, []).insert(SpanMember, []),
	putOwner: ChangeSet.empty(SpanEdited).put(SpanOwner, [])
})

/** Span-keyed owners with their families, each owner's label, each member's step value, and the put: one owner's
 * new label, another than its own. */
interface SpanSketch {
	readonly owners: Arr.NonEmptyReadonlyArray<SpanKeyedOwner>
	readonly labels: ReadonlyArray<number>
	readonly xs: ReadonlyArray<number>
	readonly put: { readonly at: number; readonly label: number }
}

export const spanSketchGen: Gen<SpanSketch> = (source) => {
	const owners = nonEmpty(
		source.draw(spanOwnersGen({ owners: { min: 1, max: 3 }, long: { min: 3, max: 4 } }))
	)
	const labels = source.draw(array(int(0, 4), { min: owners.length, max: owners.length }))
	const total = Arr.reduce(owners, 0, (sum, owner) => sum + owner.members.length)
	const xs = source.draw(array(int(0, 4), { min: total, max: total }))
	const at = source.draw(int(0, owners.length - 1))
	const from = defined(labels[at], "the put owner's label")
	const label = source.draw(element(nonEmpty(Arr.filter([0, 1, 2, 3, 4], (l) => l !== from))))
	return { owners, labels, xs, put: { at, label } }
}

export type SpanFeature =
	| "a span-keyed owner put in place"
	| "a span-keyed owner put in place over its family's members"
	| "a span-keyed owner put in place beside an owner of its id over another span"

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const spannedInstall = Object.freeze({ label: "span_edits", programs: spanPrograms })

/** SpanEdited installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const spannedTemplate = fixtureTemplate(import.meta, SpanEdited, spannedInstall)
