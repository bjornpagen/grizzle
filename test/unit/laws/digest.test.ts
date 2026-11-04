import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { FamilyRecord, ResidualRecord } from "#compiler/deploy/snapshot/residual.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { dagDigestWithin } from "#compiler/ir/dag.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	type AlternativesSketch,
	type ArmSketch,
	alternativesGen,
	residualSchema
} from "#test/support/laws/residual-schemas.ts"
import { asDrafted, compile, draftChain, fromEmpty } from "#test/support/migrate/kit.ts"

/**
 * A residual law's record decides whether a migration revalidates it, so it must cover everything the law means.
 *
 * The oracle is the law's violation query, normalized (dag.ts dagDigestWithin): its meaning, independent of the
 * identities and the order compilation gave its nodes. A drawn alternatives law, and one edit of one component of its
 * residual record that keeps the law's identity, which for alternatives is its parent and discriminator. Drafting the
 * edited schema from the base's snapshot:
 *
 * - the edit changes the record's digest whenever it changes the violation;
 * - the draft revalidates the law (a Validate transaction of its own) exactly when the violation changed, and otherwise
 *   only changes its units in Publish: declaring or removing `mutable` changes no violation.
 *
 * The edits come from a table keyed by the record's components, so a component added to the record without its edits
 * fails the typecheck. Re-arming an arm relation to another handle is among them: the change a digest that left the
 * arms out let through unvalidated.
 */

type EditName =
	| "move an arm relation to another handle"
	| "arm a new handle"
	| "share an arm relation"
	| "grow the roster"
	| "flip the parent's mutability"
	| "change the parent key's width"

/** A component of an alternatives law's residual record. */
type Component =
	| Exclude<keyof ResidualRecord, "family">
	| Exclude<keyof Extract<FamilyRecord, { readonly family: "alternativesReverse" }>, "family">

/** The edits of each component of the record. The discriminator is the law's identity, so another is another law;
 * the absent-anchor rule is fixed by the family. */
const editsOf: { readonly [C in Component]: ReadonlyArray<EditName> } = {
	discriminator: [],
	absentAnchor: [],
	checks: [
		"move an arm relation to another handle",
		"arm a new handle",
		"share an arm relation",
		"grow the roster"
	],
	participants: ["flip the parent's mutability", "arm a new handle", "share an arm relation"],
	anchor: ["change the parent key's width"],
	indexes: ["change the parent key's width"],
	detail: ["change the parent key's width"]
}

const editNames: Arr.NonEmptyReadonlyArray<EditName> = [
	"move an arm relation to another handle",
	"arm a new handle",
	"share an arm relation",
	"grow the roster",
	"flip the parent's mutability",
	"change the parent key's width"
]

/** The handles a roster of the sketch leaves unarmed. */
const unarmed = (a: AlternativesSketch): ReadonlyArray<number> => {
	const armed = new Set(Arr.flatMap(a.arms, (arm) => arm.handles))
	return Arr.filter(
		Arr.makeBy(a.roster, (i) => i),
		(i) => !armed.has(i)
	)
}

/** A sketch with its roster one handle longer: the new handle is the last. */
const grown = (a: AlternativesSketch): AlternativesSketch => ({ ...a, roster: a.roster + 1 })

/** One edit, applied: every edit changes the sketch, and keeps the law's parent and discriminator. */
const edited = (edit: EditName, a: AlternativesSketch): AlternativesSketch => {
	const [first, second, ...rest] = a.arms
	switch (edit) {
		case "move an arm relation to another handle": {
			if (second !== undefined) {
				return {
					...a,
					arms: [
						{ ...first, handles: second.handles },
						{ ...second, handles: first.handles },
						...rest
					]
				}
			}
			const [to] = unarmed(a)
			const target = to ?? a.roster
			const [, ...others] = first.handles
			return {
				...(to === undefined ? grown(a) : a),
				arms: [{ ...first, handles: [target, ...others] }]
			}
		}
		case "arm a new handle": {
			const fresh: ArmSketch = { handles: [a.roster], mutable: false }
			return { ...grown(a), arms: [...a.arms, fresh] }
		}
		case "share an arm relation":
			return second !== undefined
				? { ...a, arms: [{ ...first, handles: [...first.handles, ...second.handles] }, ...rest] }
				: { ...grown(a), arms: [{ ...first, handles: [...first.handles, a.roster] }] }
		case "grow the roster":
			return grown(a)
		case "flip the parent's mutability":
			return { ...a, parentMutable: !a.parentMutable }
		case "change the parent key's width":
			return { ...a, keyWidth: a.keyWidth === 1 ? 2 : 1 }
	}
}

interface EditCase {
	readonly edit: EditName
	readonly base: AlternativesSketch
}

const editCaseGen: Gen<EditCase> = (s) => ({
	edit: s.draw(element(editNames)),
	base: s.draw(alternativesGen)
})

type DigestFeature =
	| `edit ${EditName}`
	| `component ${string}`
	| "revalidated"
	| "published unvalidated"

/** Each component of the record an edit changes, as the table lists it. */
const componentsOf = (edit: EditName): ReadonlyArray<DigestFeature> =>
	Arr.flatMap(Rec.toEntries(editsOf), ([component, edits]): ReadonlyArray<DigestFeature> =>
		edits.includes(edit) ? [`component ${component}`] : []
	)

/** Every component some edit changes. */
const editedComponents: ReadonlyArray<DigestFeature> = Arr.flatMap(
	Rec.toEntries(editsOf),
	([component, edits]): ReadonlyArray<DigestFeature> =>
		edits.length > 0 ? [`component ${component}`] : []
)

/** The one residual law of an installation, and its violation's normalized digest. */
const meaningOf = (
	installation: Installation
): { readonly law: LawId; readonly meaning: string } => {
	const [law, ...more] = installation.laws.residuals
	assert.ok(law !== undefined && more.length === 0, "the schema holds one residual law")
	const meaning = succeeded(
		dagDigestWithin(installation.laws.theory.dag, [law.violation], "violation")
	)
	return { law: law.lawId, meaning }
}

/** A snapshot's record digest of a residual law. */
const digestOf = (snapshot: DeploySnapshot, law: LawId): string => {
	const record = snapshot.theory.laws[law]
	assert.ok(record?.kind === "residual", `the snapshot records ${law} as a residual law`)
	return record.residual.digest
}

describe("residual law records", () => {
	it.effect(
		"an edit of a law's record changes its digest whenever it changes the law's meaning, and the draft revalidates exactly then",
		(ctx) => {
			const situations: Situations<DigestFeature> = [
				...Arr.map(editNames, (e): DigestFeature => `edit ${e}`),
				...editedComponents,
				"revalidated",
				"published unvalidated"
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/laws/digest",
						draw: drawn(editCaseGen),
						literal: Formatter.format,
						coverage: required<DigestFeature>(situations, { cases: 120, sense: notesOnly }),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ edit, base }, c) =>
						Effect.sync(() => {
							c.note(`edit ${edit}`)
							c.noteAll(componentsOf(edit))
							const before = residualSchema(base)
							const after = residualSchema(edited(edit, base))
							const was = meaningOf(compile(before, asDrafted))
							const now = meaningOf(compile(after, asDrafted))
							assert.equal(now.law, was.law, "the edit keeps the law's identity")
							const [drafted, migrated] = draftChain(
								[
									{ desc: before, options: asDrafted },
									{ desc: after, options: asDrafted }
								],
								fromEmpty
							)
							assert.ok(drafted !== undefined && migrated !== undefined, "both drafts are made")
							const changed = was.meaning !== now.meaning
							if (changed) {
								assert.notEqual(
									digestOf(migrated.snapshot, now.law),
									digestOf(drafted.snapshot, was.law),
									`${edit} changes the law's meaning and its record's digest`
								)
							}
							const revalidated = Arr.some(
								migrated.plan.steps,
								(s) => s.slot === "validate.law" && s.law === now.law
							)
							assert.equal(
								revalidated,
								changed,
								`${edit}: the draft revalidates the law exactly when its meaning changed`
							)
							c.note(revalidated ? "revalidated" : "published unvalidated")
						})
				)
			)
		}
	)
})
