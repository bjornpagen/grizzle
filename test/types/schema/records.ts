import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { recordPathsOf, recordsBuilder } from "#compiler/program/records.ts"
import {
	ownerOf,
	ownerText,
	type RecordsShape,
	type StatedShape,
	shapeQuery,
	shapeText,
	statedNames,
	statedText
} from "#test/support/agreement/records.ts"
import { Shelves } from "#test/support/fixtures/records/shelves.ts"
import { identifiers, preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The records program: for each drawn query over Shelves (test/support/agreement/records.ts), its attachments' paths as
 * RecordPaths types them, exactly the paths recordPaths lists at run time, and the records of it
 * (records(stem, query, owner, ownerKey, { names }), a name stated for the books' or the chapters' path or none) typed
 * as the engine builds them, a stray path among names written apart from the call refused by name, each relation's
 * name, key and fields the runtime records' own (the oracle, each case's records built by the engine as the program's
 * are typed), the records
 * listed by a level over Shelves, as schema.extend takes their relations and laws, their read (recordsQuery) of the
 * query's own records under either reading, and their insert (recordsFacts) taken by insertAll over the level; and
 * their read served by a login, its workload a reader's of the level.
 */

/** A relation as the runtime records build it: its name, its key in order and its fields' names. */
interface Built {
	readonly name: string
	readonly key: ReadonlyArray<string>
	readonly fields: ReadonlyArray<string>
}

/** The relations of a shape's records as the engine builds them, and the names of those an insert states apart. */
const builtOf = (
	stated: StatedShape
): { readonly relations: ReadonlyArray<Built>; readonly apart: ReadonlyArray<string> } => {
	const { shape } = stated
	const owner = ownerOf(shape)
	const kept = recordsBuilder("Kept", shapeQuery(Shelves, shape), owner.fields, owner.key, [
		{ names: statedNames(stated) }
	])
	/** The relations an insert states apart, as the runtime records hold them: a query built at run time types none. */
	const apart: ReadonlyArray<{ readonly name: string }> = kept.apart
	return {
		relations: Arr.map(kept.relations, (r) => ({
			name: r.name,
			key: r.primaryKey,
			fields: Rec.keys(r.fields)
		})),
		apart: Arr.map(apart, (r) => r.name)
	}
}

/**
 * A level of a shape's records in the order the engine builds its relations, the root first, then each attachment
 * before those under it: the type of the records it holds, an expression of the program's names, its head literals and
 * its attachments, each array's among them.
 */
interface Held {
	readonly records: string
	readonly literals: ReadonlyArray<string>
	readonly attachments: ReadonlyArray<string>
	readonly arrays: ReadonlyArray<string>
}

/** The records of the attachment `name` of a parent's records `parent`, as its delivery holds them. */
const childRecords = (parent: string, name: string, delivery: string): string =>
	delivery === "array"
		? `ElementOf<${parent}["${name}"]>`
		: delivery === "one"
			? `${parent}["${name}"]`
			: `SomeOf<${parent}["${name}"]>`

/** A level of no attachment and no head literal, of the records `records`. */
const leaf = (records: string): Held => ({ records, literals: [], attachments: [], arrays: [] })

/** The levels of a shape's records (Held), in the engine's order. */
const heldOf = (shape: RecordsShape, q: string): ReadonlyArray<Held> => {
	const b = shape.books
	const books = `ElementOf<HeadOf<typeof ${q}>["${b.name}"]>`
	const below: ReadonlyArray<Option.Option<{ readonly name: string; readonly delivery: string }>> =
		[b.blurb, b.spine, b.paper, b.digital]
	const leaves = Arr.getSomes(below)
	const chapters = Option.map(b.chapters, (c) => ({
		records: `ElementOf<${books}["${c.name}"]>`,
		literals: [],
		attachments: Option.match(c.remark, { onNone: () => [], onSome: (r) => [r.name] }),
		arrays: Option.match(c.remark, {
			onNone: () => [],
			onSome: (r) => (r.delivery === "array" ? [r.name] : [])
		})
	}))
	return [
		{ records: `HeadOf<typeof ${q}>`, literals: [], attachments: [b.name], arrays: [b.name] },
		{
			records: books,
			literals: b.literal ? ["source"] : [],
			attachments: [
				...Arr.map(leaves, (l) => l.name),
				...Option.match(b.chapters, { onNone: () => [], onSome: (c) => [c.name] })
			],
			arrays: [
				...Arr.flatMap(leaves, (l) => (l.delivery === "array" ? [l.name] : [])),
				...Option.match(b.chapters, { onNone: () => [], onSome: (c) => [c.name] })
			]
		},
		...Arr.map(Arr.getSomes([b.blurb]), (l) => leaf(childRecords(books, l.name, l.delivery))),
		...Option.match(b.spine, {
			onNone: () => [],
			onSome: (spine) => {
				const records = childRecords(books, spine.name, spine.delivery)
				return [
					{
						records,
						literals: [],
						attachments: Option.match(spine.ink, { onNone: () => [], onSome: (i) => [i.name] }),
						arrays: Option.match(spine.ink, {
							onNone: () => [],
							onSome: (i) => (i.delivery === "array" ? [i.name] : [])
						})
					},
					...Option.match(spine.ink, {
						onNone: () => [],
						onSome: (i) => [leaf(childRecords(records, i.name, i.delivery))]
					})
				]
			}
		}),
		...Arr.map(Arr.getSomes([b.paper, b.digital]), (l) =>
			leaf(childRecords(books, l.name, l.delivery))
		),
		...Option.match(chapters, {
			onNone: () => [],
			onSome: (c) => [
				c,
				...Option.match(
					Option.flatMap(b.chapters, (ch) => ch.remark),
					{
						onNone: () => [],
						onSome: (r) => [
							{
								records: childRecords(c.records, r.name, r.delivery),
								literals: [],
								attachments: [],
								arrays: []
							}
						]
					}
				)
			]
		})
	]
}

/** A union's text of names, `never` for none. */
const unionText = (names: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(names)
		? Arr.join(
				Arr.map(names, (n) => `"${n}"`),
				" | "
			)
		: "never"

/** The owner's values of a shape, as a call states them. */
const ownerValues = (shape: RecordsShape): string =>
	shape.owner === "run"
		? '{ run: toId("00000000-0000-4000-8000-000000000001") }'
		: '{ run: toId("00000000-0000-4000-8000-000000000001"), step: 1 }'

/** One case's lines: the query, its records, their relations against the engine's, their level, read and insert. */
const caseLines = (stated: StatedShape, at: number): ReadonlyArray<string> => {
	const { shape } = stated
	const built = builtOf(stated)
	const owner = ownerText(shape)
	const rels = `Rels${at}`
	return [
		`export const q${at} = ${shapeText(shape)}`,
		`export type Paths${at} = Expect<Equals<RecordPaths<typeof q${at}>, ${unionText(recordPathsOf(shapeQuery(Shelves, shape)))}>>`,
		`export const kept${at} = records("Kept", q${at}, ${owner.fields}, ${owner.key}${statedText(stated)})`,
		`type ${rels} = (typeof kept${at})["relations"][number]`,
		`export type Names${at} = Expect<Equals<${rels}["name"], ${unionText(Arr.map(built.relations, (r) => r.name))}>>`,
		...Arr.flatMap(built.relations, (r, i) => [
			`export type Key${at}_${i} = Expect<Equals<Extract<${rels}, { readonly name: "${r.name}" }>["primaryKey"], readonly [${Arr.join(
				Arr.map(r.key, (k) => `"${k}"`),
				", "
			)}]>>`,
			`export type Fields${at}_${i} = Expect<Equals<keyof Extract<${rels}, { readonly name: "${r.name}" }>["fields"], ${unionText(r.fields)}>>`
		]),
		...Arr.map(Arr.zip(built.relations, heldOf(shape, `q${at}`)), ([r, held], i) => {
			const relation = `Extract<${rels}, { readonly name: "${r.name}" }>`
			return `export type Stored${at}_${i} = Expect<Equals<Omit<Fact<${relation}>, ${unionText([...r.key, ...held.arrays])}>, Omit<${held.records}, ${unionText([...held.attachments, ...held.literals])}>>>`
		}),
		`export type Apart${at} = Expect<Equals<(typeof kept${at})["apart"][number]["name"], ${unionText(built.apart)}>>`,
		`export const level${at} = schema.extend([Shelves], "Kept", kept${at}.relations, kept${at}.rules)`,
		`export const read${at} = recordsQuery(level${at}, kept${at})`,
		`export type Head${at} = Expect<Equals<HeadOf<typeof read${at}>, HeadOf<typeof q${at}>>>`,
		`export type Immediate${at} = Expect<Equals<ImmediateHeadOf<typeof read${at}>, ImmediateHeadOf<typeof q${at}>>>`,
		`export const write${at} = (rows: ReadonlyArray<HeadOf<typeof q${at}>>) => ChangeSet.empty(level${at}).insertAll(recordsFacts(level${at}, kept${at})(rows.map((row) => [${ownerValues(shape)}, row] as const)))`,
		`export const Reader${at} = role(level${at}, "reader", wholeEntriesOf(level${at}))`,
		`export const App${at} = login(level${at}, "app", [Reader${at}], { workload: [workload(Reader${at}, { read: read${at} })] })`,
		`const strayNames${at} = { "${shape.books.name}": "Okay", nowhere: "Stray" } as const`,
		"// @ts-expect-error -- refusal: records' names name only the query's attachments, each by its path",
		`export const stray${at} = records("Stray", q${at}, ${owner.fields}, ${owner.key}, { names: strayNames${at} })`,
		""
	]
}

const prelude = await Effect.runPromise(preludeAt("test/support/programs/records.ts"))

/** The program over a batch's shapes, every name read from the records prelude. */
export const recordsProgram = (
	shapes: Arr.NonEmptyReadonlyArray<StatedShape>,
	entry: Entry
): Program => {
	const cases = Arr.map(shapes, (shape, at) => caseLines(shape, at))
	const read = identifiers(Arr.join(Arr.flatten(cases), "\n"))
	return [
		preludeModule(
			"index.ts",
			"// Generated by test/types/schema/records.ts: the records agreement program.",
			preludeFrom(prelude, entry),
			[
				{
					owner: batchOwned,
					lines: [
						"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
						"type Expect<T extends true> = T",
						...(read.has("ElementOf")
							? ["type ElementOf<T> = T extends ReadonlyArray<infer E> ? E : never"]
							: []),
						...(read.has("SomeOf")
							? [
									'type SomeOf<T> = T extends { readonly _tag: "Some"; readonly value: infer V } ? V : never'
								]
							: []),
						""
					]
				},
				...Arr.map(cases, (lines, at) => ({ owner: caseOwned(at), lines }))
			]
		)
	]
}
