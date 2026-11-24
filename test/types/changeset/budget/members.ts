import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import { assertClean, type Measuring, measuredEach } from "#test/types/batch/measured.ts"

/**
 * The ChangeSet-member programs, one per op and member kind, each written over a schema of `relations` relations with
 * a ChangeSet of `members` members (members.test.ts), applied through its workload's handle. The schema is edullm
 * pantry's import shape, which its replaceWrite writes one member per relation of: relations R0 … of four fields each,
 * a natural id and three texts of one type, Name, one of them named `params`, as pantry's Reference has one, keyed by
 * its package and id, under no law but each open, mutable inside the unit of its package, beside P, the package's own
 * relation, open too. The ChangeSet deletes P's rows under a
 * package parameter, a query member, then writes the first `members` relations, one member each, by one op: a delete, a
 * put or an insert, each a call of its own, one insertAll keyed by them, or one deleteWhere keyed by them. A member is a
 * query, the rows of its relation under the package parameter, as replaceWrite's are, an array of the relation's facts,
 * or a deleteWhere's selection of the relation's rows by the package parameter, as replaceWrite's are now. The
 * ChangeSet is joined with an empty one over E, an extension of S by one relation of its own, Q, and a workload over
 * Writer, a role of E writing every relation, serves the join, as edullm's qti-database joins pantry's insertWrite over
 * Qti with a write of its own over Ledger, levels above it (its publish): the join is over E, and each member it reads
 * is found at S, a level below. A function applies it through the handle's once, the package parameter with the facts
 * of its array members, as pantry's importPackage applies replaceWrite.
 */
type MemberShape = {
	readonly relations: number
	readonly members: number
} & MemberForm

/**
 * How a ChangeSet writes its members: by an op, a call each or one insertAll keyed by their relations, each member a
 * query over the schema or an array of facts; or by one deleteWhere keyed by their relations, each member a selection.
 */
export type MemberForm =
	| { readonly op: "delete" | "put" | "insert" | "insertAll"; readonly kind: "query" | "array" }
	| { readonly op: "insertAllComputed"; readonly kind: "array" }
	| { readonly op: "deleteWhere"; readonly kind: "selection" }

/** The cells of memberForms, minted as a dictionary in its door (test/types/changeset/budget/members.dictionary.ts). */
export const memberFormsItems: readonly [MemberForm, ...ReadonlyArray<MemberForm>] = [
	...Arr.flatMap(["delete", "put", "insert", "insertAll"] as const, (op) =>
		Arr.map(["query", "array"] as const, (kind): MemberForm => ({ op, kind }))
	),
	{ op: "insertAllComputed", kind: "array" },
	{ op: "deleteWhere", kind: "selection" }
]

/**
 * Member i of the ChangeSet, over relation i: a query of its rows under the package parameter, its declared facts, or a
 * selection of its rows by the package parameter.
 */
const memberOf = (i: number, kind: MemberForm["kind"]): string => {
	switch (kind) {
		case "query":
			return `query(S).rule((q) => {
	const stored = v(R${i}, "stored")
	return q.match(R${i}, stored).where(q.eq(stored.package, q.param("package", Name))).find(stored)
})`
		case "array":
			return `facts${i}`
		case "selection":
			return `{ package: param("package", Name) }`
	}
}

/** The ChangeSet's members: one call of the op for each, or one insertAll, insertAllComputed or deleteWhere keyed by
 * their relations, insertAllComputed's computing every relation's package from the package parameter, as pantry's
 * publish does. */
const membersOf = (shape: MemberShape): string => {
	const keyed = Arr.join(
		Arr.map(indices(shape.members), (i) => `\t\tR${i}: ${memberOf(i, shape.kind)}`),
		",\n"
	)
	switch (shape.op) {
		case "insertAll":
		case "deleteWhere":
			return `\t.${shape.op}({\n${keyed}\n\t})`
		case "insertAllComputed":
			return `\t.insertAllComputed({\n${keyed}\n\t}, { package: param("package", Name) })`
		case "delete":
		case "put":
		case "insert":
			return Arr.join(
				Arr.map(indices(shape.members), (i) => `\t.${shape.op}(R${i}, ${memberOf(i, shape.kind)})`),
				"\n"
			)
	}
}

/** Each array member's facts, declared at the relation's Fact, less its package where insertAllComputed computes it. */
const factsOf = (shape: MemberShape): string => {
	switch (shape.kind) {
		case "array":
			return Arr.join(
				Arr.map(indices(shape.members), (i) =>
					shape.op === "insertAllComputed"
						? `declare const facts${i}: ReadonlyArray<Omit<Fact<typeof R${i}>, "package">>\n`
						: `declare const facts${i}: ReadonlyArray<Fact<typeof R${i}>>\n`
				),
				""
			)
		case "query":
		case "selection":
			return ""
	}
}

/** The facts the handle's once takes: under the op that adds them, each array member's own; none for query members. */
const onceFactsOf = (shape: MemberShape): string => {
	switch (shape.kind) {
		case "array":
			return `{ ${shape.op === "insertAll" || shape.op === "insertAllComputed" ? "insert" : shape.op}: { ${Arr.join(
				Arr.map(indices(shape.members), (i) => `R${i}: facts${i}`),
				", "
			)} } }`
		case "query":
		case "selection":
			return "{}"
	}
}

/** A complete program at `shape`, its imports read through the gates' prelude as `entries` reaches it. */
const memberSource = (shape: MemberShape, entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/changeset/budget/members.ts at ${jsonText(shape)}.`,
		entries,
		`export const Name = str.bytes(64, str.regex("^[a-z]+$"))
export const P = relation("P", { id: natural, package: Name }, ["package", "id"])
${Arr.join(
	Arr.map(
		indices(shape.relations),
		(i) =>
			`export const R${i} = relation("R${i}", { id: natural, label: Name, package: Name, params: Name }, ["package", "id"])\n`
	),
	""
)}export const S = schema("S", [P, ${Arr.join(
			Arr.map(indices(shape.relations), (i) => `R${i}`),
			", "
		)}], [unit("Package", { package: Name }), ${Arr.join(
			Arr.map(["P", ...Arr.map(indices(shape.relations), (i) => `R${i}`)], (r) => `mutable(${r})`),
			", "
		)}])
export const Q = relation("Q", { id: natural, package: Name }, ["package", "id"])
export const E = schema.extend([S], "E", [Q], [])
export const Writer = role(E, "writer", wholeEntriesOf(E), wholeWritesOf(E))
${factsOf(shape)}export const written = ChangeSet.empty(S)
	.delete(P, query(S).rule((q) => {
	const stored = v(P, "stored")
	return q.match(P, stored).where(q.eq(stored.package, q.param("package", Name))).find(stored)
}))
${membersOf(shape)}
export const change = ChangeSet.union(written, ChangeSet.empty(E))
export const w = workload(Writer, { change })
export const run = (db: DbOf<typeof Writer, typeof w.programs>) =>
	db.workload.change.once({ params: { package: "abc" }, facts: ${onceFactsOf(shape)} })
`
	)

/**
 * The members of the first program, and the schemas' sizes. The second program writes twice as many members, each over
 * a relation of its own, so the small schema holds that many relations; the large one holds four times as many, so a
 * member that walks the schema walks every relation the large schema adds, three for each relation of the small one,
 * for each member the second program adds.
 */
const members = 5
const small = 2 * members
const large = 4 * small

/** The four programs of one op and kind, in order: `members` and twice as many members, over each schema. */
const memberShapes = [
	{ relations: small, members },
	{ relations: small, members: 2 * members },
	{ relations: large, members },
	{ relations: large, members: 2 * members }
] as const

/** How a form prints: its op and kind. */
export const memberFormName = (form: MemberForm): string => `${form.kind} members of ${form.op}`

/**
 * The cost of one op and kind's members, measured: its four programs typecheck with no diagnostic, and the members the
 * second program adds cost exactly as many instantiations over the large schema as over the small one.
 */
export const memberCost = (at: Measuring, form: MemberForm) =>
	Effect.gen(function* () {
		const { op, kind } = form
		const measured = yield* measuredEach(
			at,
			Arr.map(memberShapes, (shape) => ({
				size: shape.relations,
				source: (entries: PreludeAt) => memberSource({ ...shape, ...form }, entries)
			}))
		)
		for (const m of measured) {
			assertClean(m, `${op} of ${kind} members`)
		}
		const count = (i: number): number =>
			defined(measured[i], `the program of ${op} at ${i}`).instantiations
		const added = { small: count(1) - count(0), large: count(3) - count(2) }
		assert.equal(
			added.large,
			added.small,
			`the last ${members} ${kind} members of ${op} cost ${added.large} instantiations over ${large} relations and ${added.small} over ${small}`
		)
	})
