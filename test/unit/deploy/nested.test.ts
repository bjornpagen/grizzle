import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import {
	type Candidate,
	candidateLabel,
	candidatesOf,
	type Offer,
	pathOf,
	rivals,
	samePath,
	type TopOffer
} from "#compiler/deploy/diff/plan.ts"
import { splitRenames } from "#compiler/deploy/render/chosen.ts"
import type { ReadCandidate } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { findMarkers, splitStatements, statementTokens } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
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
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous
} from "#test/support/migrate/kit.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	choosable,
	decisionText,
	leftUnfilled,
	type Placeholder,
	plainPlan,
	readsBack,
	recordFaults,
	renderReviewed,
	review
} from "#test/support/migrate/review.ts"

/** Rename candidates that depend on another candidate, over every case of a small box, with no database.
 *
 * The box is one relation, Item(id, amount), whose amount field is of a type: a contract over bigint, or a closed
 * relation's enum; with a twin, A also holds Twin, of Item's shape, which B removes. Its successor renames any of the
 * three: the type, the relation and the field. Each draft is decided every way its candidates can be decided, and the
 * rules restated from diff.ts and chosen.ts are:
 *
 * - A field renamed with its type is offered as a field rename that requires the type's rename. A removed field and an
 *   added one pair when the type candidate makes the removed field's type the added one's, the same as fields of one
 *   type do. Choosing the field without the type is refused as an orphan.
 * - A field renamed with its relation is offered as a candidate nested in the relation's rename, under that rename
 *   alone: with a twin, Item and Twin are rival candidates for the renamed relation, each with its own nested field's
 *   rename, the two spelt alike. A field that keeps its name while its type is renamed with its relation has its
 *   in-place conversion nested in the same way, and the type's rename deletes that conversion.
 * - meta.json is complete and reads back as written (the completeness oracle).
 * - Every decision the documented rules allow (`choosable`) reads back as itself, by path, with nothing refused (the
 *   read-back oracle); with every placeholder of the SQL left unfilled, it is refused at exactly the lines that hold one;
 *   its text spells the reviewed plan; and it runs on the host model of PostgreSQL's DDL from A installed with one row
 *   in each relation. That row's amount then holds its value exactly when its relation's and its field's renames, where
 *   offered, are chosen, and its type's is chosen or the type is a contract: two contracts over bigint hold the same
 *   values, so the field's conversion from one to the other is its cast, which keeps the value, where an enum's is the
 *   reviewer's. Otherwise it holds the reviewer's placeholder value. A relation kept as new holds no row at all.
 * - Every other subset of the candidates, written as far as the reviewer's text can write it (a nested field's rename
 *   only inside its chosen relation's, one of two rivals) and every candidate beyond written as its head alone, is
 *   refused: two rivals both chosen as twice, a field's rename without the type's it requires as an orphan. */
const schemaName = "Shop"
const schema = identifierOf(identity.schema(parsedSchemaName(schemaName)))

type TypeKind = "contract" | "closed"

interface Box {
	readonly type: TypeKind
	readonly typeRenamed: boolean
	readonly relationRenamed: boolean
	readonly fieldRenamed: boolean
	readonly twin: boolean
}

type Feature =
	| "a field's rename requiring its type's"
	| "a field's rename nested in its relation's"
	| "a field's rename nested in each of two rival relation renames"
	| "a conversion a type's rename makes unnecessary"
	| "a value carried"
	| "a value given at its placeholder"
	| "a relation kept as new"
	| "an orphan refused"
	| "two rival renames both chosen refused"
	| "a placeholder left in a commented alternative"
	| "a placeholder left unfilled refused"

const boxes: Gen<Box> = (source) => ({
	type: source.draw(element<TypeKind>(["contract", "closed"])),
	typeRenamed: source.draw(boolean),
	relationRenamed: source.draw(boolean),
	fieldRenamed: source.draw(boolean),
	twin: source.draw(boolean)
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
			relation(n.relation, { id: f.uuid, [n.field]: field }, ["id"]),
			...(box.twin && !after ? [relation("Twin", { id: f.uuid, [n.field]: field }, ["id"])] : [])
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

/** Every subset of the candidates, by their place in the plan. */
const subsets = (all: ReadonlyArray<Candidate>): ReadonlyArray<ReadonlySet<Candidate>> =>
	Arr.map(
		indices(2 ** all.length),
		(bits) => new Set(Arr.filter(all, (_, i) => ((bits >> i) & 1) === 1))
	)

/** Whether two decisions hold the same candidates. */
const sameDecision = (a: ReadonlySet<Candidate>, b: ReadonlySet<Candidate>): boolean =>
	a.size === b.size && Arr.every([...a], (c) => b.has(c))

/** The record's candidate a plan candidate is, by path. */
const recordedAs = (g: GenerateResult, c: Candidate): ReadCandidate => {
	const path = pathOf(c)
	const all = Arr.flatMap(g.record.candidates, (r): ReadonlyArray<ReadCandidate> =>
		r.kind === "relation" ? [r, ...r.fields] : [r]
	)
	const [found] = Arr.filter(all, (r) => samePath(r.path, path))
	if (found === undefined) {
		throw new Error(`the record holds no ${candidateLabel(c)}`)
	}
	return found
}

/** What the reviewer's text can write of a subset: each candidate in plan order, a nested field's rename only inside its
 * chosen relation's, and at most one of two rivals; the rest each written as its head alone. */
const writable = (
	chosen: ReadonlySet<Candidate>
): { readonly written: ReadonlySet<Candidate>; readonly heads: ReadonlyArray<Candidate> } => {
	const written: Array<Candidate> = []
	const heads: Array<Candidate> = []
	for (const c of chosen) {
		const parented = c.kind !== "nested field" || written.includes(c.parent)
		if (parented && !Arr.some(written, (w) => rivals(w, c))) {
			written.push(c)
		} else {
			heads.push(c)
		}
	}
	return { written: new Set(written), heads }
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

/** The candidates of a part: the type's, the relations', the fields'. */
const partOf = (c: Candidate): "type" | "relation" | "field" | "login" => {
	switch (c.kind) {
		case "type":
		case "relation":
		case "login":
			return c.kind
		case "field":
		case "nested field":
			return "field"
	}
}

/** A box's draft, decided every way: the record complete; every choosable decision read back and run; every other
 * subset refused. */
const property = (box: Box, c: Case<Feature>): void => {
	const where = `${box.type}, type ${box.typeRenamed ? "renamed" : "kept"}, relation ${box.relationRenamed ? "renamed" : "kept"}, field ${box.fieldRenamed ? "renamed" : "kept"}${box.twin ? ", with a twin" : ""}`
	const before = names(box, false)
	const after = names(box, true)
	const first = draftOf(schemaOf(box, false), fromEmpty, "first", 1)
	const installed = interpret(schema, emptyState, plainPlan(first), literalValue(box))
	if (Result.isFailure(installed)) {
		assert.fail(`${where}: A's install fails: ${installed.failure.reason}`)
	}
	const row = (id: string) =>
		new Map<string, TypedLiteral>([
			[identifierOf(identity.column(parsedName("id"))), { kind: "uuid", value: id }],
			[identifierOf(identity.column(parsedName(before.field))), original(box)]
		])
	const itemRow = "00000000-0000-4000-8000-000000000001"
	const twinRow = "00000000-0000-4000-8000-000000000002"
	const loaded = load(
		installed.success,
		identifierOf(identity.table(parsedName(before.relation))),
		[row(itemRow)]
	)
	const state: State = box.twin
		? load(loaded, identifierOf(identity.table(parsedName("Twin"))), [row(twinRow)])
		: loaded
	const g = draftOf(schemaOf(box, true), fromSnapshot(first.snapshot), "second", 2)
	assert.deepEqual(recordFaults(g), [], `${where}: meta.json is the complete record`)
	const all = candidatesOf(g.plan)
	const ofPart = (part: ReturnType<typeof partOf>) => Arr.filter(all, (x) => partOf(x) === part)
	const relations = box.relationRenamed ? (box.twin ? 2 : 1) : 0
	assert.equal(ofPart("type").length, box.typeRenamed ? 1 : 0, `${where}: the type's candidates`)
	assert.equal(ofPart("relation").length, relations, `${where}: the relations' candidates`)
	assert.equal(
		ofPart("field").length,
		box.fieldRenamed ? Math.max(relations, 1) : 0,
		`${where}: the fields' candidates`
	)
	assert.deepEqual(ofPart("login"), [], `${where}: a candidate renaming something else`)
	const [type] = ofPart("type")
	for (const field of ofPart("field")) {
		assert.deepEqual(
			field.kind === "field" || field.kind === "nested field" ? field.requires : undefined,
			type?.kind !== "type" ? { kind: "nothing" } : { kind: "type", candidate: type },
			`${where}: what the field's rename requires`
		)
		assert.equal(
			field.kind,
			box.relationRenamed ? "nested field" : "field",
			`${where}: the field's rename nested in its relation's exactly when the relation is renamed`
		)
		if (type !== undefined) {
			c.note("a field's rename requiring its type's")
		}
		if (field.kind === "nested field") {
			c.note("a field's rename nested in its relation's")
		}
	}
	if (relations === 2 && box.fieldRenamed) {
		c.note("a field's rename nested in each of two rival relation renames")
	}
	const nestedChoices = Arr.flatMap(g.plan.steps, (step) =>
		step.draft.kind === "choice"
			? Arr.flatMap(step.draft.offers, (o: TopOffer) =>
					o.kind === "relation rename"
						? Arr.flatMap(o.alternative, (a) => (a.kind === "choice" ? [a] : []))
						: []
				)
			: []
	)
	const conversions = Arr.filter(nestedChoices, (choice) =>
		Arr.some(choice.offers, (o: Offer) => type !== undefined && o.candidate === type)
	)
	assert.equal(
		conversions.length,
		type !== undefined && !box.fieldRenamed ? relations : 0,
		`${where}: the conversions the type's rename deletes inside each relation's`
	)
	if (conversions.length > 0) {
		c.note("a conversion a type's rename makes unnecessary")
	}
	const allowed = choosable(g)
	for (const chosen of subsets(all)) {
		const at = `${where}, ${decisionText(chosen)}`
		const { written, heads } = writable(chosen)
		const reviewed = review(g, { chosen: written, losses: "written", value: sqlValue })
		if (Result.isFailure(reviewed)) {
			assert.fail(
				`${at}: ${decisionText(new Set(reviewed.failure.candidates))} decide one statement`
			)
		}
		const files = Arr.map(reviewed.success.files, (file) => ({
			name: file.name,
			text: `${file.text}${Arr.join(
				Arr.flatMap(heads, (x) => {
					const recorded = recordedAs(g, x)
					return recorded.file === file.name ? [`\n${recorded.head.text};\n`] : []
				}),
				""
			)}`
		}))
		if (!Arr.some(allowed, (d) => sameDecision(d, chosen))) {
			const refused = splitRenames(g.record, files)
			assert.ok(refused.length > 0, `${at}: a decision the rules forbid passes check`)
			/**
			 * The candidates the review takes: those written, and those written as their head alone where a head is a
			 * branch to take, at the top or inside a written relation's rename; a nested field's head under a relation
			 * rename the review does not take is an orphan, no choice.
			 */
			const taken = [
				...written,
				...Arr.filter(heads, (h) => h.kind !== "nested field" || written.has(h.parent))
			]
			const twice = Arr.some(taken, (x) => Arr.some(taken, (y) => x !== y && rivals(x, y)))
			if (twice) {
				c.note("two rival renames both chosen refused")
				assert.ok(
					Arr.some(refused, (r) => r.kind === "twice"),
					`${at}: two rivals both chosen are not refused as twice`
				)
			}
			for (const x of taken) {
				if (
					(x.kind === "field" || x.kind === "nested field") &&
					x.requires.kind === "type" &&
					!chosen.has(x.requires.candidate)
				) {
					c.note("an orphan refused")
					assert.ok(
						Arr.some(
							refused,
							(r) => r.kind === "orphan" && Str.startsWith(candidateLabel(x))(r.detail)
						),
						`${at}: ${candidateLabel(x)} chosen without its type's rename is not refused as an orphan`
					)
				}
			}
			continue
		}
		assert.deepEqual(readsBack(g, chosen, files), [], `${at}: the review reads back as made`)
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
		const left = leftUnfilled(g, chosen, reviewed.success)
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
		const relation = Arr.findFirst([...chosen], (x) => x.kind === "relation")
		if (box.relationRenamed && Option.isNone(relation)) {
			c.note("a relation kept as new")
			assert.equal(table.rows.length, 0, `${at}: rows in the relation kept as new`)
			continue
		}
		const field = Arr.findFirst(
			ofPart("field"),
			(x) =>
				x.kind === "field" ||
				(x.kind === "nested field" && Option.exists(relation, (r) => x.parent === r))
		)
		const taken = (x: Candidate | undefined) => x === undefined || chosen.has(x)
		const carried = Option.match(field, { onNone: () => true, onSome: (x) => taken(x) })
		const kept = carried && (taken(type) || box.type === "contract")
		c.note(kept ? "a value carried" : "a value given at its placeholder")
		assert.deepEqual(
			Arr.map(table.rows, (r) => r.get(identifierOf(identity.column(parsedName(after.field))))),
			[{ kind: "value", value: kept ? original(box) : placeholderValue(box) }],
			`${at}: the row's ${after.field}`
		)
	}
}

describe("rename candidates that depend on another, over every rename of a type, a relation and a field", () => {
	it.effect(
		"offers each field's rename under the candidates it depends on, reads back every decision the rules allow as itself and refuses every other, and carries the row exactly when every renamed part is chosen or converted by its cast",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/nested",
						generator: boxes,
						literal: Formatter.format,
						limit: 64,
						coverage: requiredInSpace<Feature>([
							"a field's rename requiring its type's",
							"a field's rename nested in its relation's",
							"a field's rename nested in each of two rival relation renames",
							"a conversion a type's rename makes unnecessary",
							"a value carried",
							"a value given at its placeholder",
							"a relation kept as new",
							"an orphan refused",
							"two rival renames both chosen refused",
							"a placeholder left in a commented alternative",
							"a placeholder left unfilled refused"
						]),
						caseHang
					},
					(box, c) => Effect.sync(() => property(box, c))
				)
			)
	)
})
