/** What the property of generated-key.test.ts reads: its fixture, its box and its model. */

import { array, element, type Gen, int, uniqueKeys } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Crypto } from "#compiler/public/compute.ts"
import { generated, sha256, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/**
 * A relation keyed by the digests of its two unbounded texts, as a QTI schema keys a stimulus reference by its package's
 * and its path's digests, beside a relation of uses that name a reference by its texts:
 *
 * - `byTexts`, a point read of Ref by the texts alone, parameters, no digest named;
 * - `uses`, every use with the reference its texts name attached as an Option, stated so: the types give the child at
 *   most one row per use, and the engine delivers it so, each by the texts determining their digests (ir/keys.ts
 *   GeneratedRead, types/evidence/evidence.ts GenerationsOf).
 */
/**
 * A text of at most 1024 bytes: two of them fit one B-tree entry (schema/representability.ts btreeEntry), so the reads by
 * the texts, which the workload's access index serves, install; the key is the digests' all the same.
 */
const boundedText = str.bytes(1024, str.regex("^.*$", "su"))

const Ref = relation.generated(
	"Ref",
	{ id: int4, pkg: boundedText, path: boundedText, note: int4 },
	["id"],
	(row) => ({
		pkgDigest: generated(sha256, Crypto.sha256(row.pkg)),
		pathDigest: generated(sha256, Crypto.sha256(row.path))
	})
)

const Use = relation("Use", { n: int4, pkg: boundedText, path: boundedText }, ["n"])

export const Digests = schema("Digests", [Ref, Use], [key(on(Ref, "pkgDigest", "pathDigest"))])

/** The reads a case holds to the model, each under its name in the workload, beside the load of its facts. */
const programs = Object.freeze({
	load: ChangeSet.empty(Digests).insert(Ref, []).insert(Use, []),
	byTexts: query(Digests).rule((r) => {
		const { id, pkg, path, note } = v(Ref, "ref")
		return r
			.match(Ref, { id, pkg, path, note })
			.where(
				r.eq(pkg, r.param("pkg", Ref.fields.pkg)),
				r.eq(path, r.param("path", Ref.fields.path))
			)
			.find({ id, note })
	}),
	uses: query(Digests)
		.rule((r) => {
			const { n, pkg, path } = v(Use, "use")
			return r.match(Use, { n, pkg, path }).find({ n, pkg, path })
		})
		.attach(
			"ref",
			(use) =>
				query(Digests).rule((r) => {
					const { id, note } = v(Ref, "ref")
					return r.match(Ref, { id, pkg: use.pkg, path: use.path, note }).find({ id, note })
				}),
			"option"
		)
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const digestsInstall = Object.freeze({ label: "generated_key", programs })

/** Digests installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const digestsTemplate = fixtureTemplate(import.meta, Digests, digestsInstall)

/**
 * The texts a case's facts hold: the empty text, short ones, one that differs from another only past its first
 * character, and one of 1024 bytes, at the texts' bound.
 */
const texts = ["", "a", "ab", "b", "é", Str.repeat(1024)("x")] as const

/** A pair of texts, a reference's package and path. */
export interface Texts {
	readonly pkg: string
	readonly path: string
}

/** Every pair of the texts, by its place: package by path. */
const pairs: ReadonlyArray<Texts> = Arr.flatMap(texts, (pkg) =>
	Arr.map(texts, (path) => ({ pkg, path }))
)

const pairAt = (i: number): Texts => Option.getOrThrow(Arr.get(pairs, i))

const textsGen: Gen<Texts> = (source) => pairAt(source.draw(int(0, pairs.length - 1)))

/** A reference: its id, its texts and its note. */
export interface RefRow extends Texts {
	readonly id: number
	readonly note: number
}

/** A use: its number and the texts it names a reference by. */
export interface UseRow extends Texts {
	readonly n: number
}

/** A case: references at distinct texts, uses of any texts, and the texts the point read asks for. */
export interface Sketch {
	readonly refs: ReadonlyArray<RefRow>
	readonly uses: ReadonlyArray<UseRow>
	readonly asked: Texts
}

export const sketchGen: Gen<Sketch> = (source) => {
	const at = Arr.map(source.draw(uniqueKeys(int(0, pairs.length - 1), { min: 0, max: 5 })), pairAt)
	const refs = Arr.map(at, (t, i) => ({
		id: i + 1,
		pkg: t.pkg,
		path: t.path,
		note: source.draw(int(-3, 3))
	}))
	const named = source.draw(array(textsGen, { min: 0, max: 4 }))
	const uses = Arr.map(named, (t, i) => ({ n: i + 1, pkg: t.pkg, path: t.path }))
	const asked =
		source.draw(element([false, true])) && Arr.isReadonlyArrayNonEmpty(refs)
			? source.draw(element(Arr.map(refs, (r): Texts => ({ pkg: r.pkg, path: r.path }))))
			: source.draw(textsGen)
	return { refs, uses, asked }
}

/** The facts a case loads. */
export const factsOf = (s: Sketch) => ({
	Ref: Arr.map(s.refs, (r) => ({ id: r.id, pkg: r.pkg, path: r.path, note: r.note })),
	Use: Arr.map(s.uses, (u) => ({ n: u.n, pkg: u.pkg, path: u.path }))
})

/** The reference at a pair of texts, if one is. */
const refAt = (s: Sketch, t: Texts): Option.Option<RefRow> =>
	Arr.findFirst(s.refs, (r) => r.pkg === t.pkg && r.path === t.path)

/** The model's point read: the one reference at the asked texts, or none. */
export const byTextsExpected = (
	s: Sketch
): ReadonlyArray<{ readonly id: number; readonly note: number }> =>
	Option.match(refAt(s, s.asked), {
		onNone: () => [],
		onSome: (r) => [{ id: r.id, note: r.note }]
	})

/** A use as the model and a delivered row are compared: its number, and its reference's id and note or none. */
export const useText = (
	n: number,
	ref: Option.Option<{ readonly id: number; readonly note: number }>
): string =>
	`${n}:${Option.match(ref, { onNone: () => "none", onSome: (r) => `${r.id}/${r.note}` })}`

/** The model's uses: each use with the reference its texts name, or none, by its number. */
export const usesExpected = (s: Sketch): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(s.uses, (u) =>
			useText(
				u.n,
				Option.map(refAt(s, u), (r) => ({ id: r.id, note: r.note }))
			)
		),
		Order.String
	)

export type Feature =
	| "a point read finding its reference"
	| "a point read finding none"
	| "a use whose reference is stored"
	| "a use naming no reference"
	| "a text at its byte bound"

/** The features a case reaches. */
export const featuresOf = (s: Sketch): ReadonlyArray<Feature> => [
	Option.isSome(refAt(s, s.asked))
		? "a point read finding its reference"
		: "a point read finding none",
	...(Arr.some(s.uses, (u) => Option.isSome(refAt(s, u)))
		? ["a use whose reference is stored" as const]
		: []),
	...(Arr.some(s.uses, (u) => Option.isNone(refAt(s, u)))
		? ["a use naming no reference" as const]
		: []),
	...(Arr.some(s.refs, (r) => r.pkg.length === 1024 || r.path.length === 1024)
		? ["a text at its byte bound" as const]
		: [])
]
