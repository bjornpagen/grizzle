/** What the properties of zero-sign.test.ts read: its fixture, spaces and model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { type PlanShape, planShapeNames } from "#test/support/plan-shapes.ts"
import { checking } from "#test/support/policy.ts"

/**
 * A float's -0 and +0 are one key under PostgreSQL's equality and two facts by their identity (scalar/values/identity.ts
 * canonicalText, keyText), through a served ChangeSet over three relations of a double precision field:
 *
 * - M, mutable, keyed by k, its x a payload: every put of it lowers in place, by the form its ChangeSet's shape chooses
 *   (write/put/choose.ts): an enumerated put an ON CONFLICT DO UPDATE, a put of M's own facts read with x a parameter an
 *   UPDATE ... FROM, a put of a relation parameter beside the deletion of M's other facts in its scope a MERGE; and an
 *   insert's repeat and an exact deletion compare a stored fact with the one written;
 * - I, mutable, keyed by k, whose put reads back the facts it removed, so it is the DELETE-then-insert pair
 *   (write/put/choose.ts removedRead), its deletion displacing a fact that differs;
 * - K, mutable, keyed by its float x.
 *
 * M and I sit in the unit of their k, and K in the unit of its x.
 *
 * The model is the fact identity: a write of a fact at a stored fact's key whose x differs from the stored x by a zero's
 * sign alone writes another fact, so a put stores the written zero and is accepted, an insert is refused by the key, a
 * deletion of it removes nothing; of the same zero, a put and an insert change nothing and a deletion removes it. Two
 * facts of K at -0 and +0 share K's key and are refused on it, before any SQL.
 */
const M = relation("M", { k: pg.bigint, g: pg.bigint, x: pg["double precision"] }, ["k"])

const I = relation("I", { k: pg.bigint, x: pg["double precision"] }, ["k"])

export const K = relation("K", { x: pg["double precision"], n: pg.bigint }, ["x"])

const P = relation("P", { id: pg.bigint, x: pg["double precision"] }, ["id"])

const C = relation("C", { id: pg.bigint, x: pg["double precision"] }, ["id"])

export const Zeros = schema(
	"Zeros",
	[M, I, K, P, C],
	[
		mutable(M),
		mutable(I),
		mutable(K),
		unit("Keyed", { k: pg.bigint }),
		unit("Zero", { x: pg["double precision"] })
	]
)

/** M's facts of a relation parameter, matched whole. */
const rowsOfM = query(Zeros).rule((r) => {
	const { k, g, x } = v(M, "m")
	return r.match(r.relation("rows", M), { k, g, x }).find({ k, g, x })
})

/** The writes of a case, each under its name in the workload, beside the load of its stored facts. */
const programs = Object.freeze({
	load: ChangeSet.empty(Zeros).insert(M, []).insert(I, []),
	loadFamilies: ChangeSet.empty(Zeros).insert(P, []).insert(C, []),
	parents: query(Zeros)
		.rule((r) => {
			const { id, x } = v(P, "p")
			return r.match(P, { id, x }).find({ id, x })
		})
		.attach(
			"children",
			(parent) =>
				query(Zeros).rule((r) => {
					const { id, x } = v(C, "c")
					return r.match(C, { id, x }).where(r.eq(x, parent.x)).find({ id, x })
				}),
			"array"
		),
	putEnumerated: ChangeSet.empty(Zeros).put(M, []),
	putDescribed: ChangeSet.empty(Zeros).put(
		M,
		query(Zeros).rule((r) => {
			const { k, g, x } = v(M, "m")
			return r
				.match(M, { k, g, x })
				.where(r.eq(k, r.param("k", pg.bigint)))
				.find({ k, g, x: r.param("x", pg["double precision"]) })
		})
	),
	putScoped: ChangeSet.empty(Zeros)
		.put(M, rowsOfM)
		.delete(
			M,
			query(Zeros).rule((r) => {
				const { k, g, x } = v(M, "m")
				return r
					.match(M, { k, g, x })
					.where(r.eq(g, r.param("g", pg.bigint)))
					.where(r.not(r.relation("rows", M), { k }))
					.find({ k, g, x })
			})
		),
	putDisplacing: ChangeSet.empty(Zeros)
		.put(I, [])
		.read("removed", (d) =>
			query(Zeros).rule((r) => {
				const { k, x } = v(d.removed(I), "removed")
				return r.match(d.removed(I), { k, x }).find({ k, x })
			})
		),
	insertMutable: ChangeSet.empty(Zeros).insert(M, []),
	deleteMutable: ChangeSet.empty(Zeros).delete(M, []),
	putKeys: ChangeSet.empty(Zeros).put(K, [])
})

/** A write of one fact at a stored fact's key, by the form its program takes. */
const writes = [
	"putEnumerated",
	"putDescribed",
	"putScoped",
	"putDisplacing",
	"insertMutable",
	"deleteMutable"
] as const satisfies ReadonlyArray<keyof typeof programs>
export type Write = (typeof writes)[number]

/** The zeros a float holds: -0 and +0, the values the fact identity branches on. */
const zeros: Arr.NonEmptyReadonlyArray<number> = [-0, 0]

/** A case: one write at the key of a stored fact, the stored fact's zero and the written one's. */
export interface Sketch {
	readonly write: Write
	readonly stored: number
	readonly written: number
}

export const sketchGen: Gen<Sketch> = (source) => ({
	write: source.draw(element(writes)),
	stored: source.draw(element(zeros)),
	written: source.draw(element(zeros))
})

/** Two facts of K, at a zero key each. */
export const keysGen: Gen<readonly [number, number]> = (source) =>
	[source.draw(element(zeros)), source.draw(element(zeros))] as const

/** What a write answers: its outcome's kind and the x the fact at its key holds after it, none where it removed it. */
export interface Answer {
	readonly outcome: "accepted" | "unchanged" | "refused" | "outsideWorld"
	readonly after: number | undefined
}

/** The model's answer, by fact identity: the written fact is the stored one exactly when its zero has the stored sign. */
export const expected = (s: Sketch): Answer => {
	const same = Object.is(s.stored, s.written)
	switch (s.write) {
		case "putEnumerated":
		case "putDescribed":
		case "putScoped":
		case "putDisplacing":
			return { outcome: same ? "unchanged" : "accepted", after: s.written }
		case "insertMutable":
			return { outcome: same ? "unchanged" : "refused", after: s.stored }
		case "deleteMutable":
			return same
				? { outcome: "accepted", after: undefined }
				: { outcome: "unchanged", after: s.stored }
	}
}

/** Where a case writes: its key and its scope. */
export const at = { k: 1n, g: 7n } as const

/** The relation a case's write writes. */
export const writtenRelation = (w: Write) => (w === "putDisplacing" ? I : M)

export type Feature =
	| `${Write} of the stored zero`
	| `${Write} of the other zero`
	| `put target ${PutChoice["target"]}`
	| "two zero keys refused as one key"
	| `children of both zeros under the ${PlanShape} plan`

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	...Arr.flatMap(writes, (w) => [
		`${w} of the stored zero` as const,
		`${w} of the other zero` as const
	]),
	"put target onConflictDoUpdate",
	"put target updateFrom",
	"put target merge",
	"put target deleteThenInsert",
	"two zero keys refused as one key"
]

/** The situations the attachment property reaches: children of both zeros under each plan shape. */
export const attachmentFeatures: Arr.NonEmptyReadonlyArray<Feature> = Arr.map(
	planShapeNames,
	(shape): Feature => `children of both zeros under the ${shape} plan`
)

/** The stored parents and children of the attachment case: one of each at each zero. */
export const families = {
	P: [
		{ id: 1n, x: 0 },
		{ id: 2n, x: -0 }
	],
	C: [
		{ id: 1n, x: 0 },
		{ id: 2n, x: -0 }
	]
} as const

/** Each write's put targets as the compiler chooses them over reality (write/put/choose.ts). */
const artifacts = testArtifacts(Zeros, testCompile)

export const putTargets = (w: Write): ReadonlyArray<PutChoice["target"]> => {
	if (!artifacts.ok) {
		throw artifacts.error
	}
	const desc = changeSetDesc(programs[w])
	if (desc === undefined) {
		throw new Error(`the program ${w} has no Description`)
	}
	const compiled = compileWrite(checking(Zeros), desc, realityWrite(artifacts.value))
	if (!compiled.ok) {
		throw compiled.error
	}
	return Arr.map(compiled.value.choices, (c) => c.target)
}

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const zerosInstall = Object.freeze({ label: "zero_sign", programs })

/** Zeros installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const zerosTemplate = fixtureTemplate(import.meta, Zeros, zerosInstall)
