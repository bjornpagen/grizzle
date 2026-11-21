/** What the properties of edits.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
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
	schema
} from "#compiler/public/schema.ts"
import { FOLD_SPECS } from "#test/pg/fin/folds.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { type SpanKeyedOwner, spanOwnersGen } from "#test/support/families/generate.ts"
import { upTo } from "#test/support/up-to.ts"

const Owner = relation(
	"Owner",
	{ id: pg.integer, n: drawn(natural), end: accumulated(pg.integer, 0) },
	["id"]
)

const Member = relation("Member", { member: pg.integer, g: pg.integer, x: pg.integer }, ["member"])

const family = counted(on(Member, "g"), fin(Owner, "n"))

/**
 * The int4 sum over a counted family, both relations mutable so a member's put and delete are planned: over the
 * immutable default grizzle refuses both at compile, an immutable owner's family being fixed when its owner is inserted,
 * its count a field the guard holds fixed (write/frontend/compile.ts fixedSentence, UnsupportedOperation).
 */
export const Edited = schema(
	"fin_edits",
	[Owner, Member],
	[
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
		mutable(Owner),
		mutable(Member)
	]
)

/** The seat's specification: the counted int4 sum's, over this schema. */
export const SPEC = Object.freeze({
	...defined(
		Arr.findFirst(FOLD_SPECS, (s) => s.label === "sum of int4 over a counted family").pipe(
			Option.getOrUndefined
		)
	),
	label: "a counted int4 sum, mutable",
	schema: Edited
})

/** An edit of owner 0's family: one member's delete, or its put to another of the five values. */
type Edit =
	| { readonly kind: "delete"; readonly at: number }
	| { readonly kind: "put"; readonly at: number; readonly to: number }

interface Sketch {
	readonly values: Arr.NonEmptyReadonlyArray<number>
	readonly edit: Edit
}

export const sketchGen: Gen<Sketch> = (source) => {
	const n = source.draw(int(1, 4))
	const values = nonEmpty(
		Arr.map(
			upTo(n, (i) => i + 1),
			() => source.draw(element([0, 1, 2, 3, 4] as const))
		)
	)
	const at = source.draw(int(0, n - 1))
	const from = Arr.getUnsafe(values, at)
	const edit: Edit =
		source.draw(element(["delete", "put"] as const)) === "delete"
			? { kind: "delete", at }
			: {
					kind: "put",
					at,
					to: source.draw(element(nonEmpty(Arr.filter([0, 1, 2, 3, 4], (v) => v !== from))))
				}
	return { values, edit }
}

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
		mutable(SpanMember)
	]
)

/** The counted family's workload: a member's delete and a member's put, each from its call's facts. */
const editPrograms = Object.freeze({
	deleteMember: ChangeSet.empty(Edited).delete(Member, []),
	putMember: ChangeSet.empty(Edited).put(Member, [])
})

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

export type EditFeature =
	| `${"delete" | "put"} of ${"the last slot" | "a slot before the last"} applied as the model states`
	| "a put of the first slot refilled every slot"

export const m = SPEC.monoid

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const editedInstall = Object.freeze({ label: "edits", programs: editPrograms })

/** Edited installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const editedTemplate = fixtureTemplate(import.meta, Edited, editedInstall)

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const spannedInstall = Object.freeze({ label: "span_edits", programs: spanPrograms })

/** SpanEdited installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const spannedTemplate = fixtureTemplate(import.meta, SpanEdited, spannedInstall)
