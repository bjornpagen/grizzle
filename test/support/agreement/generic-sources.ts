import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import * as Result from "#compiler/core/result.ts"
import type { RowScalars, Statement } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { schema } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	checkBuilder,
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	keyBuilder,
	mirrorsBuilder,
	monoids,
	onBuilder,
	orderedBuilder,
	selectBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import {
	A,
	Arm,
	B,
	Folded,
	IA,
	IB,
	IM,
	Kind,
	Members,
	MKind,
	MN,
	MOwner,
	Other,
	Slots,
	Slots2,
	SlotsM,
	T1,
	T2,
	Target,
	TM,
	W
} from "#test/support/agreement/generic-schema.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import { preludeAt, type PreludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"

/**
 * The generic-source agreement: every statement builder written inside a helper generic over the relations its source
 * may be, `<S extends typeof X | typeof Y>(m: S) => statement`, each with its verdict, and the one TypeScript program
 * that states every verdict as types, which the type tier checks (test/types/schema/generic.test.ts). A builder infers
 * a generic source's name and heading from its constraint (types/schema/statements.ts Shows), so a check over it is
 * decided where it is written.
 *
 * The box is exhausted: each construct over each shape of its source family, and each fault over each shape whose
 * relations share one heading. A shape is the ordered list of relations a helper's constraint names. Its relations
 * share one heading where one of them holds every field of its own at the descriptor every other holds it at,
 * TypeScript's common supertype of their headings (generic-schema.ts states each field once, so a shared descriptor is
 * a shared carrier). A helper over such a shape typechecks exactly when the engine compiles its statement over every
 * relation of the shape, and is refused with the refusal its fault names otherwise; a helper over a shape whose
 * relations share no heading is refused, `a generic source's relations share one heading`, whatever its statement
 * reads.
 */

/** The relations a helper may be generic over. */
const sources = {
	A,
	B,
	W,
	MOwner,
	MKind,
	MN,
	IA,
	IB,
	IM,
	Slots,
	Slots2,
	SlotsM,
	T1,
	T2,
	TM
} as const
type SourceName = keyof typeof sources
type SourceValue = (typeof sources)[SourceName]

/** The rosters every schema the engine judges holds, beside the relations a helper's statement reads. */
const rosters = { Kind, Other } as const

/**
 * The source families: members, indexed members, owners and trees. Each family's shapes are one relation, two of one
 * heading in either order, one and one that holds its heading and a field more in either order, and one and each that
 * holds a field at another carrier in either order.
 */
type Family = "member" | "indexed" | "owner" | "tree"

const pairs = (
	base: SourceName,
	others: ReadonlyArray<SourceName>
): ReadonlyArray<Arr.NonEmptyReadonlyArray<SourceName>> =>
	Arr.flatMap(others, (o) => [[base, o] as const, [o, base] as const])

const shapes: {
	readonly [F in Family]: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<SourceName>>
} = {
	member: [["A"], ...pairs("A", ["B", "W", "MOwner", "MKind", "MN"])],
	indexed: [["IA"], ...pairs("IA", ["IB", "IM"])],
	owner: [["Slots"], ...pairs("Slots", ["Slots2", "SlotsM"])],
	tree: [["T1"], ...pairs("T1", ["T2", "TM"])]
}

/** A source's fields, each its name and its descriptor. */
const fieldsOf = (source: SourceValue): ReadonlyArray<readonly [string, unknown]> =>
	Rec.toEntries<string, unknown>(source.fields)

/** Whether `base` holds each of its fields at the descriptor `other` holds it at. */
const within = (base: SourceValue, other: SourceValue): boolean =>
	Arr.every(fieldsOf(base), ([name, d]) =>
		Option.exists(
			Arr.findFirst(fieldsOf(other), ([n]) => n === name),
			([, o]) => o === d
		)
	)

/** Whether a shape's relations share one heading: one of them lies within every one. */
const sharesHeading = (shape: Arr.NonEmptyReadonlyArray<SourceName>): boolean =>
	Arr.some(shape, (b) => Arr.every(shape, (o) => within(sources[b], sources[o])))

/**
 * A construct or fault: the family it is generic over, its statement or query as the program writes it over the
 * helper's parameter `v`, and what it builds over one relation of its family through the runtime builders, which the
 * engine judges: statements beside the relations they read, which a schema compiles, or a query over Members, which the
 * engine compiles.
 */
type Form = {
	readonly family: Family
	readonly text: (v: string) => string
} & (
	| {
			readonly kind: "statement"
			readonly reads: ReadonlyArray<AnyRelation>
			readonly build: (source: SourceValue) => ReadonlyArray<Statement>
	  }
	| { readonly kind: "query"; readonly build: (source: SourceValue) => unknown }
)

/** A row predicate over a member, as select and check take it: every member's row has A's fields. */
type MemberRow = RowScalars<typeof A>

const over =
	(family: Family, reads: ReadonlyArray<AnyRelation>) =>
	(
		text: (v: string) => string,
		build: (source: SourceValue) => ReadonlyArray<Statement>
	): Form => ({ kind: "statement", family, reads, text, build })

/**
 * A query over a member, generic over the members: `query(Members).rule((r) => { … })` as the program writes it, its
 * rule's body; and as the runtime builders build it over one member, through the query builder's JavaScript view.
 */
const memberQuery = (
	body: (v: string) => string,
	build: (r: RuleValue, source: SourceValue) => unknown
): Form => ({
	kind: "query",
	family: "member",
	text: (v) => `query(Members).rule((r) => { ${body(v)} })`,
	build: (source) => queryOver(Members).rule((r: RuleValue) => build(r, source))
})

/** A member's rule body over its scope `x`, as the program writes it and as the runtime builders build it. */
const overScope = (
	body: (v: string) => string,
	build: (r: RuleValue, source: SourceValue, x: Readonly<Record<string, unknown>>) => unknown
): Form =>
	memberQuery(
		(v) => `const x = v(${v}, "x"); ${body(v)}`,
		(r, source) => build(r, source, varsOver(source, "x"))
	)

const member = (reads: ReadonlyArray<AnyRelation>) => over("member", reads)

/** A count fold over a family of `member` into Folded, stepping over `step`, its family's statement first. */
const countFold = (member: SourceValue, step: SourceValue): ReadonlyArray<Statement> => {
	const family = countedBuilder(onBuilder(member, ["owner"]), finBuilder(Folded, "k"))
	return [
		family,
		foldBuilder(
			family,
			monoids.count,
			onBuilder(step, ["owner"]),
			onBuilder(Folded, ["id", "size"])
		)
	]
}

/** The constructs, each a statement builder, or a family and its fold, written over a generic source. */
const constructs: Readonly<Record<string, Form>> = {
	"contained in a relation": member([Target])(
		(v) => `contained(on(${v}, "owner"), on(Target, "id"))`,
		(m) => [containedBuilder(onBuilder(m, ["owner"]), onBuilder(Target, ["id"]))]
	),
	"containing a relation": member([Target])(
		(v) => `contained(on(Target, "id"), on(${v}, "id"))`,
		(m) => [containedBuilder(onBuilder(Target, ["id"]), onBuilder(m, ["id"]))]
	),
	mirrors: member([Target])(
		(v) => `mirrors(on(${v}, "id"), on(Target, "id"))`,
		(m) => [mirrorsBuilder(onBuilder(m, ["id"]), onBuilder(Target, ["id"]))]
	),
	"a selection contained": member([Target])(
		(v) => `contained(on(select(${v}, (row) => row.eq(row.kind, "a")), "owner"), on(Target, "id"))`,
		(m) => [
			containedBuilder(
				onBuilder(
					selectBuilder(m, (row: MemberRow) => row.eq(row.kind, "a")),
					["owner"]
				),
				onBuilder(Target, ["id"])
			)
		]
	),
	"a selection by a list": member([Target])(
		(v) =>
			`contained(on(select(${v}, (row) => row.in(row.kind, ["a"])), "owner"), on(Target, "id"))`,
		(m) => [
			containedBuilder(
				onBuilder(
					selectBuilder(m, (row: MemberRow) => row.in(row.kind, ["a"])),
					["owner"]
				),
				onBuilder(Target, ["id"])
			)
		]
	),
	"a key": member([])(
		(v) => `key(on(${v}, "owner", "n"))`,
		(m) => [keyBuilder(onBuilder(m, ["owner", "n"]))]
	),
	"a key over a selection": member([])(
		(v) => `key(on(select(${v}, (row) => row.gt(row.n, 0)), "owner"))`,
		(m) => [
			keyBuilder(
				onBuilder(
					selectBuilder(m, (row: MemberRow) => row.gt(row.n, 0)),
					["owner"]
				)
			)
		]
	),
	"a check": member([])(
		(v) => `check("Positive", ${v}, (row) => row.gt(row.n, 0))`,
		(m) => [checkBuilder("Positive", m, (row: MemberRow) => row.gt(row.n, 0))]
	),
	alternatives: member([Arm])(
		(v) => `alternatives(${v}, "kind", Kind, { a: Arm })`,
		(m) => [alternativesBuilder(m, "kind", Kind, { a: Arm })]
	),
	"a counted family and its fold": member([Folded])(
		(v) =>
			`[counted(on(${v}, "owner"), fin(Folded, "k"))].flatMap((f) => [f, fold(f, Monoid.count, on(${v}, "owner"), on(Folded, "id", "size"))])`,
		(m) => countFold(m, m)
	),
	"an ordered family": over("indexed", [Slots])(
		(v) => `ordered(on(${v}, "owner", "at"), fin(Slots, "k"))`,
		(m) => [orderedBuilder(onBuilder(m, ["owner", "at"]), finBuilder(Slots, "k"))]
	),
	"slots of a generic owner": over("owner", [A])(
		(v) => `counted(on(A, "owner"), fin(${v}, "k"))`,
		(o) => [countedBuilder(onBuilder(A, ["owner"]), finBuilder(o, "k"))]
	),
	"a tree": over("tree", [])(
		(v) => `tree(on(${v}, "parent", "at"), fin(${v}, "children"), { root: ["doc"] })`,
		(t) => [
			treeBuilder(onBuilder(t, ["parent", "at"]), finBuilder(t, "children"), { root: ["doc"] })
		]
	),
	"a query's match": overScope(
		(v) => `return r.match(${v}, { id: x.id, owner: x.owner }).find({ id: x.id })`,
		(r, m, x) => r.match(m, { id: x["id"], owner: x["owner"] }).find({ id: x["id"] })
	),
	"a query's join": overScope(
		(v) =>
			`return r.match(${v}, { id: x.id, owner: x.owner }).match(Target, { id: x.owner }).find({ id: x.id })`,
		(r, m, x) =>
			r
				.match(m, { id: x["id"], owner: x["owner"] })
				.match(Target, { id: x["owner"] })
				.find({ id: x["id"] })
	),
	"a query's filter": overScope(
		(v) =>
			`return r.match(${v}, { id: x.id, n: x.n }).where(r.gt(x.n, 0)).find({ id: x.id, n: x.n })`,
		(r, m, x) =>
			r.match(m, { id: x["id"], n: x["n"] }).where(r.gt(x["n"], 0)).find({ id: x["id"], n: x["n"] })
	),
	"a query's constant": overScope(
		(v) => `return r.match(${v}, { id: x.id, kind: "a" }).find({ id: x.id })`,
		(r, m, x) => r.match(m, { id: x["id"], kind: "a" }).find({ id: x["id"] })
	),
	"a query's fold": overScope(
		(v) =>
			`return r.match(${v}, { id: x.id, owner: x.owner }).find({ owner: x.owner, total: r.count() })`,
		(r, m, x) =>
			r.match(m, { id: x["id"], owner: x["owner"] }).find({ owner: x["owner"], total: r.count() })
	),
	"a query's negation": memberQuery(
		(v) =>
			`const t = v(Target, "t"); return r.match(Target, { id: t.id }).where(r.not(${v}, { owner: t.id })).find({ id: t.id })`,
		(r, m) => {
			const t = varsOver(Target, "t")
			return r
				.match(Target, { id: t["id"] })
				.where(r.not(m, { owner: t["id"] }))
				.find({ id: t["id"] })
		}
	)
}

/** The faults a statement over a generic source may plant, each with the refusal the types name it by. */
const faults: Readonly<Record<string, { readonly refusal: Refused; readonly form: Form }>> = {
	"a side of another type": {
		refusal: "the sides' field types differ",
		form: member([Target])(
			(v) => `contained(on(${v}, "n"), on(Target, "id"))`,
			(m) => [containedBuilder(onBuilder(m, ["n"]), onBuilder(Target, ["id"]))]
		)
	},
	"an arm that may be the parent": {
		refusal: "an arm is a relation other than its parent",
		form: member([A])(
			(v) => `alternatives(${v}, "kind", Kind, { a: A })`,
			(m) => [alternativesBuilder(m, "kind", Kind, { a: A })]
		)
	},
	"a family over another key": {
		refusal: "a counted family's side is its owner's key",
		form: member([Slots])(
			(v) => `counted(on(${v}, "n"), fin(Slots, "k"))`,
			(m) => [countedBuilder(onBuilder(m, ["n"]), finBuilder(Slots, "k"))]
		)
	},
	"a fold stepping over another relation": {
		refusal:
			"a fold's step is its family's member: its group, its value, then an accumulated pair per plane",
		form: member([B, Folded])(
			(v) =>
				`[counted(on(${v}, "owner"), fin(Folded, "k"))].flatMap((f) => [f, fold(f, Monoid.count, on(B, "owner"), on(Folded, "id", "size"))])`,
			(m) => countFold(m, B)
		)
	},
	"a tree over another tree's slots": {
		refusal:
			"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end",
		form: over("tree", [T1])(
			(v) => `tree(on(${v}, "parent", "at"), fin(T1, "children"), { root: ["doc"] })`,
			(t) => [
				treeBuilder(onBuilder(t, ["parent", "at"]), finBuilder(T1, "children"), { root: ["doc"] })
			]
		)
	},
	"a query's fold reading a fact twice": {
		refusal:
			"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values",
		form: overScope(
			(v) => `return r.match(${v}, { owner: x.owner }).find({ owner: x.owner, total: r.count() })`,
			(r, m, x) => r.match(m, { owner: x["owner"] }).find({ owner: x["owner"], total: r.count() })
		)
	}
}

/** What the types say of a helper: it typechecks, or its statement's line raises a diagnostic naming a refusal. */
type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly refusal: Refused }

/** One helper: its construct or fault, its shape, and its verdict. */
interface GenericCase {
	readonly name: string
	readonly form: Form
	readonly shape: Arr.NonEmptyReadonlyArray<SourceName>
	readonly verdict: Verdict
}

/** A schema of the rosters, the relations the form reads, the source, and the statements, compiled. */
const compiles = (
	reads: ReadonlyArray<AnyRelation>,
	source: SourceValue,
	statements: ReadonlyArray<Statement>
): Result.Result<unknown, CompileError> => {
	const relations: Readonly<Record<string, AnyRelation | AnyClosed>> = {
		...rosters,
		...Rec.fromEntries(Arr.map(reads, (r) => [r.name, r] as const)),
		[source.name]: source
	}
	return Result.flatMap(
		catchCompileError(() => schema("Generic", relations, statements, [])),
		(built) => testArtifacts(built, testCompile)
	)
}

/** Whether the engine builds and compiles the form's statements or query over the relation. */
const admits = (form: Form, source: SourceValue): boolean => {
	switch (form.kind) {
		case "statement":
			return Result.flatMap(
				catchCompileError(() => form.build(source)),
				(statements) => compiles(form.reads, source, statements)
			).ok
		case "query":
			return Result.flatMap(
				catchCompileError(() => form.build(source)),
				(query) => compileTemplate(query, undefined, testCompile)
			).ok
	}
}

/**
 * A helper's verdict: refused where its shape's relations share no heading; else admitted exactly where the engine
 * admits its statement over every relation of the shape, refused for its fault's reason otherwise. A construct the
 * engine refuses over a shared heading is a defect of the box, which fails the run.
 */
const verdictOf = (
	name: string,
	form: Form,
	shape: Arr.NonEmptyReadonlyArray<SourceName>,
	refusal: Option.Option<Refused>
): Verdict => {
	if (!sharesHeading(shape)) {
		return { kind: "refused", refusal: "a generic source's relations share one heading" }
	}
	if (Arr.every(shape, (s) => admits(form, sources[s]))) {
		return { kind: "admitted" }
	}
	return Option.match(refusal, {
		onNone: () => {
			throw new Error(
				`the engine refuses ${name} over ${Arr.join(shape, ", ")}, whose relations share one heading`
			)
		},
		onSome: (r): Verdict => ({ kind: "refused", refusal: r })
	})
}

/** Every helper of the box: each construct over each shape of its family, each fault over each shared shape. */
const genericCases = (): ReadonlyArray<GenericCase> => [
	...Arr.flatMap(Rec.toEntries(constructs), ([name, form]) =>
		Arr.map(shapes[form.family], (shape) => ({
			name,
			form,
			shape,
			verdict: verdictOf(name, form, shape, Option.none())
		}))
	),
	...Arr.flatMap(Rec.toEntries(faults), ([name, { refusal, form }]) =>
		Arr.map(Arr.filter(shapes[form.family], sharesHeading), (shape) => ({
			name,
			form,
			shape,
			verdict: verdictOf(name, form, shape, Option.some(refusal))
		}))
	)
]

/** The helper's parameter, by its family. */
const parameters: { readonly [F in Family]: string } = {
	member: "m",
	indexed: "m",
	owner: "o",
	tree: "t"
}

/** One helper's block: the helper, generic over its shape, its statement under its directive. */
const blockOf = (c: GenericCase, i: number): string =>
	Arr.join(
		[
			`/** ${c.name} over ${Arr.join(c.shape, " | ")} */`,
			`export const g${i} = <S extends ${Arr.join(
				Arr.map(c.shape, (s) => `typeof ${s}`),
				" | "
			)}>(${parameters[c.form.family]}: S) =>`,
			...(c.verdict.kind === "refused"
				? [`\t// @ts-expect-error -- refusal: ${c.verdict.refusal}`]
				: []),
			`\t${c.form.text(parameters[c.form.family])}`,
			""
		],
		"\n"
	)

/** The generic-source program's prelude (test/support/programs/generic-sources.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/generic-sources.ts"))

export const genericEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over the box: one module, its imports the names its helpers read. */
export const genericModule = (entries: PreludeAt): string => {
	const body = Arr.join(Arr.map(genericCases(), blockOf), "\n")
	return preludeProgram(
		"// Generated by test/support/agreement/generic-sources.ts: the generic-source agreement.",
		entries,
		body
	)
}
