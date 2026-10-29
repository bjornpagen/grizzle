import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, String as Str } from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { AlternativeStep, Draft, Offer } from "#compiler/deploy/diff/plan.ts"
import { splitRenames } from "#compiler/deploy/render/chosen.ts"
import { readDecisions, writeMeta } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	findMarkers,
	placeholderToken,
	splitStatements,
	statementTokens
} from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	closed,
	f,
	ge,
	literal,
	relation,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { emptyState, interpret, load, type State } from "#test/support/migrate/interpret.ts"
import {
	asDrafted,
	compile,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous,
	draftedAt
} from "#test/support/migrate/kit.ts"

import {
	leftUnfilled,
	type Placeholder,
	plainPlan,
	renderReviewed,
	review
} from "#test/support/migrate/review.ts"
import { indices } from "#test/support/oracle/pick.ts"

/** Rename candidates that depend on another candidate, over every case of a small box, with no database.
 *
 * The box is one relation, Item(id, amount), whose amount field is of a type: a contract over bigint, or a closed
 * relation's enum. Its successor renames any of the three: the type, the relation and the field. Each draft is decided
 * every way its candidates can be decided, and the rules restated from diff.ts and chosen.ts are:
 *
 * - A field renamed with its type is offered as a field rename that requires the type's rename. A removed field and an
 *   added one pair when the type candidate makes the removed field's type the added one's, the same as fields of one
 *   type do. Choosing the field without the type is refused as an orphan.
 * - A field renamed with its relation is offered as a candidate nested in the relation's rename. A field that keeps its
 *   name while its type is renamed with its relation has its in-place conversion nested in the same way, and the type's
 *   rename deletes that conversion. A nested candidate chosen without the relation's rename, which leaves the
 *   alternative commented, is refused as an orphan.
 * - meta.json records each candidate's requirements and each nested choice's candidate, and reads back as written.
 * - Every review whose choices are closed under those dependencies:
 *   - passes grizzle check's reading: no marker left, no candidate decided two ways, no stray rename, each candidate
 *     decided exactly as its instruction says, so a commented alternative not taken stays with any placeholder it holds,
 *     and a note of the reviewer's in a block comment names the placeholder too;
 *   - with every placeholder of the SQL left unfilled, is refused at exactly the lines that hold one;
 *   - spells the reviewed plan;
 *   - runs on the host model of PostgreSQL's DDL from A installed with one row.
 *   That row's amount then holds its value exactly when its relation's and its field's renames, where offered, are
 *   chosen, and its type's is chosen or the type is a contract: two contracts over bigint hold the same values, so
 *   the field's conversion from one to the other is its cast, which keeps the value, where an enum's is the
 *   reviewer's. Otherwise it holds the reviewer's placeholder value. A relation kept as new holds no row at all. */
const schemaName = "Shop"
const schema = identifierOf(identity.schema(parsedSchemaName(schemaName)))

type TypeKind = "contract" | "closed"

interface Box {
	readonly type: TypeKind
	readonly typeRenamed: boolean
	readonly relationRenamed: boolean
	readonly fieldRenamed: boolean
}

type Feature =
	| "a field's rename requiring its type's"
	| "a field's rename nested in its relation's"
	| "a conversion a type's rename makes unnecessary"
	| "a value carried"
	| "a value given at its placeholder"
	| "a relation kept as new"
	| "an orphan refused"
	| "a placeholder left in a commented alternative"
	| "a placeholder left unfilled refused"

const featureNames: ReadonlyArray<Feature> = [
	"a field's rename requiring its type's",
	"a field's rename nested in its relation's",
	"a conversion a type's rename makes unnecessary",
	"a value carried",
	"a value given at its placeholder",
	"a relation kept as new",
	"an orphan refused",
	"a placeholder left in a commented alternative",
	"a placeholder left unfilled refused"
]

const boxes: Gen<Box> = (source) => ({
	type: source.draw(element<TypeKind>(["contract", "closed"])),
	typeRenamed: source.draw(boolean),
	relationRenamed: source.draw(boolean),
	fieldRenamed: source.draw(boolean)
})

/** The names of each part, before and after. */
const names = (box: Box, after: boolean) => ({
	type:
		box.type === "contract"
			? after && box.typeRenamed
				? "Money"
				: "Cents"
			: after && box.typeRenamed
				? "Category"
				: "Kind",
	relation: after && box.relationRenamed ? "Product" : "Item",
	field: after && box.fieldRenamed ? "price" : "amount"
})

const schemaOf = (box: Box, after: boolean): SchemaDesc => {
	const n = names(box, after)
	const field =
		box.type === "contract"
			? f.contract(n.type, f.bigint, ge(value, literal(0n)))
			: f.closedId(n.type)
	return {
		name: schemaName,
		extends: undefined,
		relations: [
			...(box.type === "closed" ? [closed(n.type, ["a", "b"])] : []),
			relation(n.relation, { id: f.uuid, [n.field]: field }, ["id"])
		],
		statements: []
	}
}

/** The row's amount, and the value a reviewer writes at a placeholder of it. */
const original = (box: Box): TypedLiteral =>
	box.type === "contract" ? { kind: "int", value: 5n } : { kind: "enum", handle: "a" }

const placeholderValue = (box: Box): TypedLiteral =>
	box.type === "contract" ? { kind: "int", value: 7n } : { kind: "enum", handle: "b" }

const literalValue =
	(box: Box) =>
	(p: Placeholder): TypedLiteral => {
		if (p.kind === "placeholderHandles") {
			throw new Error("no roster of the box changes")
		}
		return placeholderValue(box)
	}

const sqlValue = (): string => "0"

type RenameOffer = Extract<Offer, { readonly kind: "rename" }>

/** The rename offers a draft holds, those nested in an alternative included. */
const renameOffers = (d: Draft | AlternativeStep): ReadonlyArray<RenameOffer> =>
	d.kind === "choice"
		? Arr.flatMap(d.offers, (o) =>
				o.kind === "rename" ? [o, ...Arr.flatMap(o.alternative, renameOffers)] : []
			)
		: []

type Part = "type" | "relation" | "field"

/** What a rename offer renames, read off its first statement. */
const partOf = (o: RenameOffer): Part | "other" => {
	const [first] = o.alternative
	if (first.kind !== "statement") {
		return "other"
	}
	const s = first.statement
	if (s.kind === "renameColumn") {
		return "field"
	}
	if (s.kind !== "rename") {
		return "other"
	}
	return s.object === "TABLE"
		? "relation"
		: s.object === "DOMAIN" || s.object === "TYPE"
			? "type"
			: "other"
}

/** Each part's candidates. */
const candidatesOf = (g: GenerateResult): ReadonlyMap<Part | "other", ReadonlyArray<number>> => {
	const out = new Map<Part | "other", Array<number>>()
	for (const o of Arr.flatMap(g.plan.steps, (s) => renameOffers(s.draft))) {
		const part = partOf(o)
		out.set(part, [...(out.get(part) ?? []), o.candidate])
	}
	return out
}

/** Every subset of the candidates. */
const subsets = (n: number): ReadonlyArray<ReadonlySet<number>> =>
	Arr.map(
		indices(2 ** n),
		(bits) => new Set(Arr.filter(indices(n), (i) => ((bits >> i) & 1) === 1))
	)

/** The candidate a nested-only candidate is offered within, read from meta.json: every choice offering it nested in that
 * candidate's alternative. */
const parentsOf = (g: GenerateResult): ReadonlyMap<number, number> => {
	const out = new Map<number, number>()
	for (const candidate of g.folder.meta.decisions.candidates.keys()) {
		const offering = Arr.filter(g.folder.meta.decisions.choices, (choice) =>
			Arr.some(choice.offers, (o) => o.candidate === candidate)
		)
		const within = Arr.flatMap(offering, (choice) =>
			choice.within.kind === "within" ? [choice.within.candidate] : []
		)
		const [parent] = within
		if (parent !== undefined && within.length === offering.length) {
			out.set(candidate, parent)
		}
	}
	return out
}

const draftOf = (desc: SchemaDesc, previous: Previous, name: string, ordinal: number) =>
	succeeded(
		generate({
			installation: compile(desc, asDrafted),
			timestamp: draftedAt(ordinal),
			previous,
			workload: noWorkload,
			name
		})
	)

/** A review closed under the dependencies: check's reading, the plan's text, and the rows. The review fills every
 * placeholder of the SQL, so a token it leaves is in a comment. */
const property = (box: Box, c: Case<Feature>): void => {
	const where = `${box.type}, type ${box.typeRenamed ? "renamed" : "kept"}, relation ${box.relationRenamed ? "renamed" : "kept"}, field ${box.fieldRenamed ? "renamed" : "kept"}`
	const before = names(box, false)
	const after = names(box, true)
	const first = draftOf(schemaOf(box, false), fromEmpty, "first", 1)
	const installed = interpret(schema, emptyState, plainPlan(first), literalValue(box))
	if (Result.isFailure(installed)) {
		assert.fail(`${where}: A's install fails: ${installed.failure.reason}`)
	}
	const state: State = load(
		installed.success,
		identifierOf(identity.table(parsedName(before.relation))),
		[
			new Map<string, TypedLiteral>([
				[
					identifierOf(identity.column(parsedName("id"))),
					{ kind: "uuid", value: "00000000-0000-4000-8000-000000000001" }
				],
				[identifierOf(identity.column(parsedName(before.field))), original(box)]
			])
		]
	)
	const g = draftOf(schemaOf(box, true), fromSnapshot(first.snapshot), "second", 2)
	const meta = g.folder.meta
	assert.deepEqual(
		decodeMeta(succeeded(writeMeta(meta))),
		Result.succeed(meta),
		`${where}: meta.json`
	)
	const read = succeeded(readDecisions(meta.decisions))
	const parts = candidatesOf(g)
	const one = (part: Part, renamed: boolean): number | undefined => {
		const found = parts.get(part) ?? []
		assert.equal(found.length, renamed ? 1 : 0, `${where}: the ${part}'s candidates`)
		return found[0]
	}
	const type = one("type", box.typeRenamed)
	const rel = one("relation", box.relationRenamed)
	const field = one("field", box.fieldRenamed)
	assert.deepEqual(parts.get("other") ?? [], [], `${where}: a candidate renaming something else`)
	const parents = parentsOf(g)
	const requires = (candidate: number): ReadonlyArray<number> =>
		meta.decisions.candidates[candidate]?.requires ?? []
	if (field !== undefined) {
		assert.deepEqual(
			requires(field),
			type === undefined ? [] : [type],
			`${where}: what the field's rename requires`
		)
		assert.equal(parents.get(field), rel, `${where}: the rename the field's is nested in`)
		if (type !== undefined) {
			c.note("a field's rename requiring its type's")
		}
		if (rel !== undefined) {
			c.note("a field's rename nested in its relation's")
		}
	}
	const conversions = Arr.filter(
		meta.decisions.choices,
		(choice) =>
			choice.within.kind === "within" && Arr.some(choice.offers, (o) => o.candidate === type)
	)
	assert.equal(
		conversions.length,
		type !== undefined && rel !== undefined && field === undefined ? 1 : 0,
		`${where}: the conversions the type's rename deletes inside the relation's`
	)
	if (conversions.length > 0) {
		c.note("a conversion a type's rename makes unnecessary")
	}
	for (const chosen of subsets(meta.decisions.candidates.length)) {
		const at = `${where}, chosen {${Arr.join(
			Arr.map([...chosen], (k) => String(k)),
			", "
		)}}`
		/** What the reviewer's text can write: a nested candidate only inside its chosen rename. One chosen outside is
		 * planted as the reviewer uncommenting its rename alone. */
		const unparented = Arr.filter([...chosen], (x) => {
			const parent = parents.get(x)
			return parent !== undefined && !chosen.has(parent)
		})
		const writable = new Set(Arr.filter([...chosen], (x) => !unparented.includes(x)))
		const reviewed = review(g, { chosen: writable, losses: "written", value: sqlValue })
		if (Result.isFailure(reviewed)) {
			assert.fail(
				`${at}: candidates ${Arr.join(
					Arr.map(reviewed.failure.candidates, (k) => String(k)),
					" and "
				)} decide one statement`
			)
		}
		const files = Arr.map(reviewed.success.files, (file) => ({
			name: file.name,
			text: `${file.text}${Arr.join(
				Arr.flatMap(unparented, (x) => {
					const w = read.candidates[x]?.witness
					return w !== undefined && w.file === file.name ? [`\n${w.statement};\n`] : []
				}),
				""
			)}`
		}))
		const orphans = Arr.filter(
			[...chosen],
			(x) => unparented.includes(x) || Arr.some(requires(x), (r) => !chosen.has(r))
		)
		const refused = splitRenames(read, files)
		if (orphans.length > 0) {
			c.note("an orphan refused")
			assert.deepEqual(
				Arr.filter(refused, (r) => r.kind !== "orphan"),
				[],
				`${at}: a refusal other than an orphan's`
			)
			for (const x of orphans) {
				const label = meta.decisions.candidates[x]?.label ?? `candidate ${x}`
				assert.ok(
					Arr.some(refused, (r) => Str.startsWith(label)(r.detail)),
					`${at}: ${label} is not refused as an orphan: ${Arr.join(
						Arr.map(refused, (r) => r.detail),
						" | "
					)}`
				)
			}
			continue
		}
		if (Arr.some(files, (x) => Str.includes(placeholderToken)(x.text))) {
			c.note("a placeholder left in a commented alternative")
		}
		assert.deepEqual(
			Arr.flatMap(files, (x) =>
				Arr.map(
					findMarkers(`${x.text}/* ${placeholderToken} */\n`),
					(m) => `${x.name}:${m.line} ${m.kind}`
				)
			),
			[],
			`${at}: markers left`
		)
		const left = leftUnfilled(g, writable, reviewed.success)
		if (left.lines.length > 0) {
			c.note("a placeholder left unfilled refused")
		}
		assert.deepEqual(
			Arr.flatMap(left.files, (x) =>
				Arr.map(findMarkers(x.text), (m) => `${x.name}:${m.line} ${m.kind}`)
			),
			Arr.map(left.lines, (l) => `${l.file}:${l.line} placeholder`),
			`${at}: the placeholders left unfilled`
		)
		assert.deepEqual(refused, [], `${at}: refused`)
		assert.deepEqual(
			Arr.map(files, (x) => Arr.map(splitStatements(x.text), statementTokens)),
			Arr.map(reviewed.success.plan, (x) =>
				Arr.map(splitStatements(renderReviewed(x, sqlValue)), statementTokens)
			),
			`${at}: the reviewed text is not the reviewed plan`
		)
		const ran = interpret(schema, state, reviewed.success.plan, literalValue(box))
		if (Result.isFailure(ran)) {
			assert.fail(`${at}: ${ran.failure.file}, action ${ran.failure.action}: ${ran.failure.reason}`)
		}
		const table = ran.success.tables.get(identifierOf(identity.table(parsedName(after.relation))))
		if (table === undefined) {
			assert.fail(`${at}: no table ${identifierOf(identity.table(parsedName(after.relation)))}`)
		}
		const taken = (x: number | undefined) => x === undefined || chosen.has(x)
		if (!taken(rel)) {
			c.note("a relation kept as new")
			assert.equal(table.rows.length, 0, `${at}: rows in the relation kept as new`)
			continue
		}
		const carried = taken(field) && (taken(type) || box.type === "contract")
		c.note(carried ? "a value carried" : "a value given at its placeholder")
		assert.deepEqual(
			Arr.map(table.rows, (row) => row.get(identifierOf(identity.column(parsedName(after.field))))),
			[{ kind: "value", value: carried ? original(box) : placeholderValue(box) }],
			`${at}: the row's ${after.field}`
		)
	}
}

describe("rename candidates that depend on another, over every rename of a type, a relation and a field", () => {
	it.effect(
		"offers each field's rename under the candidates it depends on, refuses it chosen without them, and carries the row exactly when every renamed part is chosen or converted by its cast",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/nested",
						generator: boxes,
						literal: Formatter.format,
						limit: 64,
						features: features<Feature>(featureNames),
						caseHang: Duration.minutes(2)
					},
					(box, c) => Effect.sync(() => property(box, c))
				)
			)
	)
})
