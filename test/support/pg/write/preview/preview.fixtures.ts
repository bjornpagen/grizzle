/**
 * What the property of preview.test.ts reads: a case's schema, every relation of a drawn schema of families
 * (test/support/families/fill.ts, the fill order's and the fresh groups' specifications) beside a palette of closed ids
 * riding a counted family and a sequence, in the two versions of a history whose second leaves a hole among the
 * roster's codes; an instance of it, a fault aimed at each refusal; and one case's check, the preview against what the
 * same insertAll stores in a fresh installation and in a migrated one.
 */
import type * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import {
	aimed,
	boolean,
	element,
	type Gen,
	int,
	map,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import type { WrittenOutcome } from "#adapter/db/handles.ts"
import { rowEvaluator } from "#adapter/public/host.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import type { CallError, CallErrorOf } from "#compiler/live/index.ts"
import { type PreviewRowsByName, previewOver } from "#compiler/program/preview.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import { Text, Type } from "#compiler/public/compute.ts"
import {
	accumulated,
	Bits,
	bits,
	closedId,
	drawn,
	generated,
	natural,
	pg
} from "#compiler/public/fields.ts"
import {
	closed,
	contained,
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	pred,
	relation as typedRelation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import type { PreviewRefusal } from "#compiler/types/changeset/preview.ts"
import type { Unevaluated } from "#compiler/types/schema/evaluation.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	admittedFillSpecGen,
	buildFill,
	type FillSpec,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	mutableOrDrawn,
	relationName
} from "#test/support/families/fill.ts"
import { Id } from "#test/support/ids.ts"
import {
	type Installed,
	installGenerated,
	installGeneratedThrough
} from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { freshCases } from "#test/support/pg/write/fresh-groups/fresh-groups.fixtures.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { openServedDb } from "#test/support/served-db.ts"
import { type StateRow, tableState } from "#test/support/substrate/state.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A situation a case reaches. */
export type PreviewFeature =
	| "a fresh group of several members"
	| "a member of two counted families"
	| "a counted member nested in a sequence"
	| "a tree of several nodes"
	| "a predecessor copy at a sequence's base"
	| "an owner copy of a closed id along a counted family"
	| "a max fold over closed ids"
	| "a closed id the two installations code apart"
	| "a handle the history dropped, refused as input"
	| "two rows at one key, refused by the key"
	| "a generated NULL a fill reads, refused before any SQL"
	| "a generated NULL no fill reads, refused by PostgreSQL alone"
	| "a counted member whose owner the call does not insert, refused"
	| "a drawn value past its target domain, refused by the domain's law"

export const previewFeatures: Arr.NonEmptyReadonlyArray<PreviewFeature> = [
	"a fresh group of several members",
	"a member of two counted families",
	"a counted member nested in a sequence",
	"a tree of several nodes",
	"a predecessor copy at a sequence's base",
	"an owner copy of a closed id along a counted family",
	"a max fold over closed ids",
	"a closed id the two installations code apart",
	"a handle the history dropped, refused as input",
	"two rows at one key, refused by the key",
	"a generated NULL a fill reads, refused before any SQL",
	"a generated NULL no fill reads, refused by PostgreSQL alone",
	"a counted member whose owner the call does not insert, refused",
	"a drawn value past its target domain, refused by the domain's law"
]

/**
 * The roster Hue's handles in each version of the history: the first's, then the second's, which drops b, so its code
 * 1 is a hole, and appends e at code 4. A migrated installation codes c, d and e 2, 3 and 4, where the declared order
 * the preview binds under, a fresh installation's, codes them 1, 2 and 3.
 */
const firstHues = ["a", "b", "c", "d"] as const
const secondHues = ["a", "c", "d", "e"] as const

/** The handles a case's rows hold, the second version's; d is the one Glow holds no row of. */
type Hue = (typeof secondHues)[number]

/** A version of the history, by its roster's handles. */
type Hues = typeof firstHues | typeof secondHues

/**
 * A label: a text of at most 4 bytes, so a swatch's longer one is past its domain, and so is the tag its dabs copy of it.
 */
const Label = str.bytes(4, str.regex("^[a-z]*$"))

/**
 * The palette of a version: Hue, ordered; Glow, a closed relation of a lum per hue, holding none for d; Swatch(hue, id),
 * keyed by a closed id, its lum generated from Glow at its tone, NULL at d, owning Dab's counted family, with a max
 * fold of its members' shades and an or fold of their marks, and Stroke's ordered family; Dab, whose tone and lum are
 * copies of its swatch's along the counted family's owner axis, the lum a copy of a generated field the fresh fill
 * evaluates; Stroke, whose prior is a predecessor copy of its sequence's shades, a at its base. A swatch's label is a
 * Label, its tag the label collapsed and cast into Label, as a document's id is its lexical's (generated), and its width
 * the octets of that cast, a domain cast nested in its generation, which keeps its cast where a generation's own outer
 * cast into its field's type holds none (scalar/compute/evaluate.ts domainCast); each dab copies its swatch's tag and
 * width along the counted family's owner axis, copies of generated fields the fresh fill evaluates.
 */
const paletteOf = (hues: Hues) => {
	const Hue = closed.ordered("Hue", hues)
	const hue = closedId(Hue)
	const Glow = closed.relation(
		"Glow",
		{ hue, lum: pg.bigint },
		["hue"],
		hues[1] === "b"
			? [
					{ hue: "a", lum: 1n },
					{ hue: "b", lum: 2n },
					{ hue: "c", lum: 3n }
				]
			: [
					{ hue: "a", lum: 1n },
					{ hue: "c", lum: 3n },
					{ hue: "e", lum: 5n }
				]
	)
	const Swatch = typedRelation.generated(
		"Swatch",
		{
			hue,
			id: Id,
			tone: hue,
			n: drawn(natural),
			strokes: drawn(natural),
			peak: accumulated(hue, "a"),
			seen: accumulated(bits(Hue), Bits.of(Hue, [])),
			label: Label
		},
		["hue", "id"],
		(row) => ({
			lum: generated(pg.bigint, Glow.at("lum", row.tone)),
			tag: generated(Label, Type.cast(Text.collapse(row.label), Label)),
			width: generated(pg.integer, Text.octetLength(Type.cast(Text.collapse(row.label), Label)))
		})
	)
	const Dab = relation(
		"Dab",
		{
			id: Id,
			hue,
			swatch: Id,
			shade: hue,
			marks: bits(Hue),
			tone: accumulated(hue, "a"),
			lum: accumulated(pg.bigint, 0n),
			tag: accumulated(Label, ""),
			width: accumulated(pg.integer, 0)
		},
		["id"],
		[]
	)
	const Stroke = relation(
		"Stroke",
		{ id: Id, hue, swatch: Id, at: drawn(natural), shade: hue, prior: accumulated(hue, "a") },
		["id"],
		[]
	)
	const dabs = counted(on(Dab, "hue", "swatch"), fin(Swatch, "n"))
	const strokes = ordered(on(Stroke, "hue", "swatch", "at"), fin(Swatch, "strokes"))
	return {
		Hue,
		Swatch,
		Dab,
		Stroke,
		relations: [Hue, Glow, Swatch, Dab, Stroke],
		statements: [
			dabs,
			fold(dabs, Monoid.max, on(Dab, "hue", "swatch", "shade"), on(Swatch, "hue", "id", "peak")),
			fold(dabs, Monoid.or, on(Dab, "hue", "swatch", "marks"), on(Swatch, "hue", "id", "seen")),
			contained(on(Dab, "hue", "swatch", "tone"), on(Swatch, "hue", "id", "tone")),
			contained(on(Dab, "hue", "swatch", "lum"), on(Swatch, "hue", "id", "lum")),
			contained(on(Dab, "hue", "swatch", "tag"), on(Swatch, "hue", "id", "tag")),
			contained(on(Dab, "hue", "swatch", "width"), on(Swatch, "hue", "id", "width")),
			strokes,
			contained(
				on(Stroke, "hue", "swatch", pred("at"), "prior"),
				on(Stroke, "hue", "swatch", "at", "shade")
			)
		]
	}
}

/** A dab of a swatch: its number, its shade and its marks. */
interface DabRow {
	readonly id: number
	readonly shade: Hue
	readonly marks: ReadonlyArray<Hue>
}

/** A swatch, its dabs and its strokes in slot order, each stroke by its number and shade. */
interface SwatchRow {
	readonly hue: Hue
	readonly id: number
	readonly tone: Hue
	readonly dabs: ReadonlyArray<DabRow>
	readonly strokes: ReadonlyArray<{ readonly id: number; readonly shade: Hue }>
}

/**
 * What a case's call states beyond its drawn instance, each aimed at one refusal: nothing; a dab's shade b, the handle
 * the history dropped (InputRefused); its first swatch stated again with another tone (KeyConflict); its first swatch's
 * tone d, which Glow holds no lum of, where it has dabs, whose copy of the lum the fresh fill evaluates
 * (GeneratedNull), or where it has none, so PostgreSQL alone computes the NULL and its NOT NULL refuses it; a dab of a
 * swatch the call does not insert (OwnerAbsent); its first swatch's label of 5 bytes, past Label, where it has dabs,
 * whose copy of its tag, the label cast into Label, the fresh fill evaluates, which the domain refuses once PostgreSQL
 * stores it (a drawn value past its target domain).
 */
type Fault = "none" | "dropped handle" | "key conflict" | "dark tone" | "orphan dab" | "long label"

/** A case: a drawn schema of families and an instance of it, the palette's swatches, and the fault its call states. */
export interface PreviewCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
	readonly swatches: ReadonlyArray<SwatchRow>
	readonly fault: Fault
}

/** The handles a case's values are drawn from: every one Glow holds a lum of, d left to the faults. */
const lit: Arr.NonEmptyReadonlyArray<Hue> = ["a", "c", "e"]

/** A swatch numbered `id`, its dabs and strokes numbered after `next`, the next free number. */
const swatchGen =
	(id: number, next: number): Gen<SwatchRow> =>
	(source) => {
		const dabCount = source.draw(int(0, 3))
		const strokeCount = source.draw(int(0, 2))
		return {
			hue: source.draw(element(lit)),
			id,
			tone: source.draw(element(lit)),
			dabs: Array.from({ length: dabCount }, (_, i) => ({
				id: next + i,
				shade: source.draw(element(secondHues)),
				marks: source.draw(subset(secondHues, { min: 0, max: 3 }))
			})),
			strokes: Array.from({ length: strokeCount }, (_, i) => ({
				id: next + dabCount + i,
				shade: source.draw(element(secondHues))
			}))
		}
	}

/** One to three swatches, numbered 1, 11, 21 and their members after each, so no two rows share a number. */
const swatchesGen: Gen<ReadonlyArray<SwatchRow>> = (source) =>
	Array.from({ length: source.draw(int(1, 3)) }, (_, i) =>
		source.draw(swatchGen(10 * i + 1, 10 * i + 2))
	)

/** A drawn schema of families with an instance of it: the fresh groups' counted families, or the fill order's. */
const familiesGen: Gen<{ readonly spec: FillSpec; readonly rows: ReadonlyArray<InstanceRow> }> = (
	source
) => {
	if (source.draw(boolean)) {
		return source.draw(freshCases)
	}
	const spec = source.draw(
		mutableOrDrawn(admittedFillSpecGen({ relations: 4, families: 4, copies: 3 }))
	)
	return { spec, rows: source.draw(instanceGen(spec)) }
}

/** A case of `fault`. */
const caseOf =
	(fault: Gen<Fault>): Gen<PreviewCase> =>
	(source) => ({
		...source.draw(familiesGen),
		swatches: source.draw(swatchesGen),
		fault: source.draw(fault)
	})

/** A case whose first swatch holds a dab, so its dark tone's lum is one the fresh fill reads. */
const withDab = (k: PreviewCase): PreviewCase => {
	const [first, ...rest] = k.swatches
	return first === undefined || first.dabs.length > 0
		? k
		: {
				...k,
				swatches: [{ ...first, dabs: [{ id: first.id + 9, shade: "a", marks: [] }] }, ...rest]
			}
}

/** A case whose first swatch holds no dab, so its dark tone's lum is one no fill reads. */
const withoutDabs = (k: PreviewCase): PreviewCase => {
	const [first, ...rest] = k.swatches
	return first === undefined ? k : { ...k, swatches: [{ ...first, dabs: [] }, ...rest] }
}

/**
 * The cases: mostly faultless, now and then a fault, and each refusal aimed at by a case constructed to reach it, the
 * dark tone with dabs and without.
 */
export const caseGen = aimed(
	caseOf(
		weighted([
			[12, element(["none"] as const)],
			[
				1,
				element([
					"dropped handle",
					"key conflict",
					"dark tone",
					"orphan dab",
					"long label"
				] as const)
			]
		])
	),
	[
		[
			"a handle the history dropped, refused as input",
			caseOf(element(["dropped handle"] as const))
		],
		["two rows at one key, refused by the key", caseOf(element(["key conflict"] as const))],
		[
			"a generated NULL a fill reads, refused before any SQL",
			map(caseOf(element(["dark tone"] as const)), withDab)
		],
		[
			"a generated NULL no fill reads, refused by PostgreSQL alone",
			map(caseOf(element(["dark tone"] as const)), withoutDabs)
		],
		[
			"a counted member whose owner the call does not insert, refused",
			caseOf(element(["orphan dab"] as const))
		],
		[
			"a drawn value past its target domain, refused by the domain's law",
			map(caseOf(element(["long label"] as const)), withDab)
		]
	] as const
)

/** The uuid a palette row's number is written as, apart from the families' rows' (fill.ts uuidOfRow). */
const paletteUuid = (n: number): string =>
	`00000000-0000-4000-9000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The palette's facts as insertAll takes them, by relation name, its fault stated among them. */
const paletteFacts = (
	palette: ReturnType<typeof paletteOf>,
	swatches: ReadonlyArray<SwatchRow>,
	fault: Fault
): Readonly<Record<string, ReadonlyArray<unknown>>> => {
	const { Hue } = palette
	const [first] = swatches
	const stated = Arr.map(swatches, (s, i) => ({
		...s,
		tone: fault === "dark tone" && i === 0 ? "d" : s.tone
	}))
	const swatchFacts = Arr.map(stated, (s, i) => ({
		hue: s.hue,
		id: paletteUuid(s.id),
		tone: s.tone,
		label: fault === "long label" && i === 0 ? "abcde" : "ab",
		strokes: Arr.map(s.strokes, (st) => ({ id: paletteUuid(st.id), shade: st.shade }))
	}))
	const dabFacts = Arr.flatMap(stated, (s) =>
		Arr.map(s.dabs, (d, i) => ({
			id: paletteUuid(d.id),
			hue: s.hue,
			swatch: paletteUuid(s.id),
			shade: fault === "dropped handle" && i === 0 ? "b" : d.shade,
			marks: Bits.of(Hue, d.marks)
		}))
	)
	const extraSwatch =
		fault === "key conflict" && first !== undefined
			? [
					{
						hue: first.hue,
						id: paletteUuid(first.id),
						tone: first.tone === "a" ? "c" : "a",
						label: "ab",
						strokes: []
					}
				]
			: []
	const extraDab =
		fault === "orphan dab" && first !== undefined
			? [
					{
						id: paletteUuid(99),
						hue: first.hue,
						swatch: paletteUuid(98),
						shade: "a",
						marks: Bits.of(Hue, [])
					}
				]
			: []
	const dropped =
		fault === "dropped handle" &&
		Arr.every(stated, (s) => s.dabs.length === 0) &&
		first !== undefined
			? [
					{
						id: paletteUuid(97),
						hue: first.hue,
						swatch: paletteUuid(first.id),
						shade: "b",
						marks: Bits.of(Hue, [])
					}
				]
			: []
	return {
		Swatch: [...swatchFacts, ...extraSwatch],
		Dab: [...dabFacts, ...extraDab, ...dropped]
	}
}

/**
 * A case's schema in a version, under `name`: the families' relations and statements beside the palette's of the
 * version.
 */
const schemaOf = (k: PreviewCase, hues: Hues, name: string) => {
	const families = buildFill(k.spec)
	const palette = paletteOf(hues)
	return {
		families,
		palette,
		value: schema(
			name,
			[...Rec.values(families.relations), ...palette.relations],
			[...families.statements, ...palette.statements]
		)
	}
}

/**
 * A case's second version as a preview reads it, under no installation: its relations and statements, the families'
 * and the palette's, and its call's facts as insertAll takes them, by relation name, its fault stated among them; and
 * the palette's alone, its relations, statements and facts.
 */
export const previewInput = (k: PreviewCase) => {
	const families = buildFill(k.spec)
	const palette = paletteOf(secondHues)
	const familyFacts = instanceFacts(k.spec, k.rows)
	const paletteRows = paletteFacts(palette, k.swatches, k.fault)
	return {
		relations: [...Rec.values(families.relations), ...palette.relations],
		statements: [...families.statements, ...palette.statements],
		facts: {
			...Rec.fromEntries(
				Arr.map(
					insertedRelations(k.spec),
					(r) => [relationName(r), familyFacts.get(r) ?? []] as const
				)
			),
			...paletteRows
		},
		palette: { relations: palette.relations, statements: palette.statements, facts: paletteRows }
	}
}

/** The situations a case's schema and instance reach, before its call. */
const reached = (k: PreviewCase): ReadonlyArray<PreviewFeature> => {
	const { spec, rows, swatches } = k
	const members = (f: number, owner: number) =>
		Arr.filter(rows, (row) => Arr.some(row.memberOf, (m) => m.family === f && m.owner === owner))
	return [
		...(Arr.some(
			spec.families,
			(f, i) => f.kind === "counted" && Arr.some(rows, (row) => members(i, row.id).length > 1)
		) || Arr.some(swatches, (s) => s.dabs.length > 1)
			? (["a fresh group of several members"] as const)
			: []),
		...(Arr.some(
			spec.relations,
			(_, r) =>
				Arr.filter(spec.families, (f) => f.kind === "counted" && f.member === r).length > 1 &&
				Arr.some(rows, (row) => row.relation === r)
		)
			? (["a member of two counted families"] as const)
			: []),
		...(Arr.some(
			spec.families,
			(f) =>
				f.kind !== "counted" &&
				Arr.some(spec.families, (g) => g.kind === "counted" && g.member === f.member) &&
				Arr.some(rows, (row) => row.relation === f.member)
		)
			? (["a counted member nested in a sequence"] as const)
			: []),
		...(Arr.some(
			spec.families,
			(f) => f.kind === "tree" && Arr.filter(rows, (row) => row.relation === f.member).length > 1
		)
			? (["a tree of several nodes"] as const)
			: []),
		...(Arr.some(swatches, (s) => s.strokes.length > 0)
			? (["a predecessor copy at a sequence's base"] as const)
			: []),
		...(Arr.some(swatches, (s) => s.dabs.length > 0)
			? ([
					"an owner copy of a closed id along a counted family",
					"a max fold over closed ids"
				] as const)
			: []),
		...(Arr.some(swatches, (s) => s.hue !== "a" || s.tone !== "a")
			? (["a closed id the two installations code apart"] as const)
			: [])
	]
}

/** The situation a fault reaches, where its refusal is met. */
const faultFeature = (k: PreviewCase): Option.Option<PreviewFeature> => {
	switch (k.fault) {
		case "none":
			return Option.none()
		case "dropped handle":
			return Option.some("a handle the history dropped, refused as input")
		case "key conflict":
			return Option.some("two rows at one key, refused by the key")
		case "dark tone":
			return Option.some(
				Arr.some(k.swatches.slice(0, 1), (s) => s.dabs.length > 0)
					? "a generated NULL a fill reads, refused before any SQL"
					: "a generated NULL no fill reads, refused by PostgreSQL alone"
			)
		case "orphan dab":
			return Option.some("a counted member whose owner the call does not insert, refused")
		case "long label":
			return Arr.some(k.swatches.slice(0, 1), (s) => s.dabs.length > 0)
				? Option.some("a drawn value past its target domain, refused by the domain's law")
				: Option.none()
	}
}

/** A call's answer as the store gave it: its outcome, or the CallError it failed with. */
type StoredAnswer = Result.Result<WrittenOutcome, CallError>

/** A store's refusal by the schema's laws. */
type Refused = CallErrorOf<"refused">

/**
 * One installation of the case's schema, `installed`, its served Db over the app role, and its one write, insertAll over
 * every top-level relation: the write's answer to the call's facts, and each writable relation's stored rows, every
 * field, as host values.
 */
const storedBy = (
	installed: Installed,
	value: ReturnType<typeof schemaOf>["value"],
	relations: ReadonlyArray<AnyRelation>,
	insertable: ReadonlyArray<string>,
	facts: Readonly<Record<string, ReadonlyArray<unknown>>>
) =>
	Effect.gen(function* () {
		const world = fullWorld(value, {}, [])
		const db = yield* openServedDb(installed, world.server.roles.app, {})
		const whole = ChangeSet.empty(value).insertAll(
			Rec.fromEntries(Arr.map(insertable, (name) => [name, []] as const))
		)
		const served = yield* db.serve({ whole })
		const calls = defined(served.get("whole"), "the served insertAll")
		if (calls.shape !== "write") {
			return assert.fail("insertAll is a write member")
		}
		const answer: StoredAnswer = yield* Effect.result(
			calls.once({ params: {}, facts: { insert: facts } })
		)
		const rows = yield* Effect.forEach(relations, (relation) =>
			Effect.map(tableState(installed, relation), (state) => [relation.name, state] as const)
		)
		return { answer, rows: new Map(rows) }
	})

/**
 * One case (see preview.test.ts): the preview of the call's rows under the case's schema, and what the same insertAll
 * answers and stores in a fresh installation of it and in one migrated through the history's two versions.
 */
export const previewCase = (k: PreviewCase, c: Case<PreviewFeature>) =>
	Effect.gen(function* () {
		/** The case's schema under `name` with `hues`, and its full world's login over it. */
		const versionOf = (hues: Parameters<typeof schemaOf>[1], name: string) => {
			const { value } = schemaOf(k, hues, name)
			return { schema: value, logins: [fullWorld(value, {}, []).server] }
		}
		const { installed: fresh } = yield* installGenerated((name) => versionOf(secondHues, name), {
			ambient: ordinarySession,
			label: "preview_fresh"
		})
		const history = yield* installGeneratedThrough(
			[
				(name) => ({ ...versionOf(firstHues, name), declarations: noDeclarations }),
				(name) => ({
					...versionOf(secondHues, name),
					declarations: {
						renames: [],
						drops: [{ kind: "handle", roster: parsedName("Hue"), handle: "b" }]
					}
				})
			],
			{ label: "preview_migrated", ambient: ordinarySession }
		)
		const { installed: migrated } = yield* history.migrate
		const { facts } = previewInput(k)
		c.noteAll(reached(k))
		for (const installed of [fresh, migrated]) {
			const at = schemaOf(k, secondHues, installed.schema)
			const relations: ReadonlyArray<AnyRelation> = [
				...Rec.values(at.families.relations),
				at.palette.Swatch,
				at.palette.Dab,
				at.palette.Stroke
			]
			const preview = succeeded(
				previewOver(at.value, inForce(bindFrame)),
				"the case's schema compiles"
			)(facts)
			const stored = yield* storedBy(installed, at.value, relations, Rec.keys(facts), facts)
			judged(
				at.value,
				relations,
				k.fault,
				preview,
				stored,
				`${installed.schema}, ${Formatter.format(k)}`
			)
		}
		Option.map(faultFeature(k), (feature) => c.note(feature))
	})

/** A store's refusal by the schema's laws, or the case fails naming what the store answered instead. */
const refusedBy = (stored: StoredAnswer, what: string, where: string): Refused =>
	Result.isFailure(stored) && stored.failure.kind === "refused"
		? stored.failure
		: assert.fail(
				`the store refuses ${what} as the preview does, not ${Formatter.format(stored)}: ${where}`
			)

/**
 * The preview held to what the store answered and stored (see preview.test.ts): rows the store stores exactly, each
 * with its generated fields as rowEvaluator computes them, where every one has a value; refused by a generated field's
 * law where one is NULL, which PostgreSQL alone judges; refused by a field's domain law where a row is past its domain,
 * which the fill never refuses, a drawn value's included (a long label's); and each refusal the store's, its law and
 * witness.
 */
const judged = (
	value: ReturnType<typeof schemaOf>["value"],
	relations: ReadonlyArray<AnyRelation>,
	fault: Fault,
	preview: Engine.Result<PreviewRowsByName, PreviewRefusal>,
	stored: {
		readonly answer: StoredAnswer
		readonly rows: ReadonlyMap<string, ReadonlyArray<StateRow>>
	},
	where: string
): void => {
	if (fault === "long label") {
		assert.ok(
			preview.ok,
			`a drawn value past its target domain is the domain's to judge, never the fill's: the preview gives the rows, not ${Formatter.format(preview)}: ${where}`
		)
	}
	if (!preview.ok) {
		const refusal = preview.error
		switch (refusal._tag) {
			case "InputRefused":
				assert.ok(
					Result.isFailure(stored.answer) && stored.answer.failure.kind === "input",
					`the store refuses the call's input as the preview does (${refusal.failure._tag}), not ${Formatter.format(stored.answer)}: ${where}`
				)
				return
			case "KeyConflict":
			case "GeneratedNull": {
				const refused = refusedBy(stored.answer, refusal._tag, where)
				assert.ok(
					Arr.some(refusedEntries(refused.refused), (l) => sameLaw(l.law, refusal.law)),
					`the store refuses by the preview's law ${Formatter.format(refusal.law)}, among ${Formatter.format(refusedEntries(refused.refused))}: ${where}`
				)
				assert.deepEqual(
					refused.witness,
					refusal.witness,
					`the store's witness is the preview's: ${where}`
				)
				return
			}
			case "OwnerAbsent": {
				const refused = refusedBy(stored.answer, refusal._tag, where)
				assert.ok(
					Arr.some(refusedEntries(refused.refused), (l) => sameLaw(l.law, refusal.law)),
					`the store refuses the orphan by its counted family's law ${Formatter.format(refusal.law)}, among ${Formatter.format(refusedEntries(refused.refused))}: ${where}`
				)
				return
			}
			case "Uncompiled":
				return assert.fail(
					`the insert of the call's families compiles, as the installed write's does: ${Formatter.format(refusal.error)}: ${where}`
				)
		}
	}
	const evaluate = succeeded(rowEvaluator<AnySchema>(value), "the case's schema evaluates")
	const nulls: Array<{ readonly relation: string; readonly field: string }> = []
	const outside: Array<{ readonly relation: string; readonly field: string }> = []
	const expected = new Map(
		Arr.map(relations, (relation) => {
			const rows = defined(preview.value[relation.name], `the preview's rows of ${relation.name}`)
			return [
				relation.name,
				Arr.flatMap(rows, (row) => {
					const admitted = evaluate.admit(relation, row)
					if (Result.isFailure(admitted)) {
						outside.push({ relation: relation.name, field: admitted.failure.field })
						return []
					}
					/** Its generated fields' items by name, which an AnyRelation's type cannot name. */
					const items: Readonly<Record<string, Result.Result<unknown, Unevaluated>>> = evaluate(
						relation,
						admitted.success
					).generated
					const generated = Rec.map(items, (item, field) => {
						if (Result.isFailure(item)) {
							return assert.fail(
								`the host evaluates ${relation.name}.${field}: ${item.failure.why}`
							)
						}
						if (item.success === null) {
							nulls.push({ relation: relation.name, field })
						}
						return item.success
					})
					return [{ ...row, ...generated }]
				})
			] as const
		})
	)
	if (Arr.isReadonlyArrayNonEmpty(outside)) {
		const refused = refusedBy(stored.answer, "a row past its domain", where)
		assert.ok(
			Arr.some(
				refusedEntries(refused.refused),
				(l) =>
					l.law.kind === "pattern" &&
					Arr.some(
						outside,
						(o) =>
							l.law.kind === "pattern" && o.relation === l.law.relation && o.field === l.law.field
					)
			),
			`the store refuses a row past its domain, ${Formatter.format(outside)}, by the field's domain law, not ${Formatter.format(refusedEntries(refused.refused))}: ${where}`
		)
		return
	}
	if (Arr.isReadonlyArrayNonEmpty(nulls)) {
		const refused = refusedBy(stored.answer, "a generated NULL", where)
		assert.ok(
			Arr.some(
				refusedEntries(refused.refused),
				(l) =>
					l.law.kind === "generated" &&
					Arr.some(
						nulls,
						(n) =>
							l.law.kind === "generated" && n.relation === l.law.relation && n.field === l.law.field
					)
			),
			`the store refuses a generated field the preview's rows leave NULL, ${Formatter.format(nulls)}, not ${Formatter.format(refusedEntries(refused.refused))}: ${where}`
		)
		return
	}
	assert.ok(
		Result.isSuccess(stored.answer),
		`the store accepts the rows the preview gives, not ${Formatter.format(stored.answer)}: ${where}`
	)
	for (const relation of relations) {
		unorderedEqual<Readonly<Record<string, unknown>>>(
			defined(stored.rows.get(relation.name), `the stored rows of ${relation.name}`),
			defined(expected.get(relation.name), `the expected rows of ${relation.name}`),
			`${relation.name}'s stored rows, every field, are the preview's with their generated fields: ${where}`
		)
	}
}
