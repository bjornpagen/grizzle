import { assertVariant } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema, tree } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import {
	changeSetDesc,
	changeSetOver as ChangeSet,
	parseChangeSet
} from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"

/**
 * The insertAllComputed box (test/types/changeset/insert-all-computed.ts): over Packages, every relation of which but
 * Loose is keyed by its package as pantry's Qti is, an insertAllComputed of `package` from its one parameter as pantry's
 * publish writes it, each case one form of it: admitted over an owner nesting its ordered members, a tree nesting its
 * nodes and two relations at once, each member row leaving `package` out, the nested ones filled from their owner's
 * value; and each refusal by its name, one fault a case. Each case's engine verdict is the oracle: the JavaScript
 * ChangeSet its text writes, built, compiled and bound (insertAllComputedVerdict).
 */

/** A package's name, as pantry's: up to eight letters. */
export const PackageName = str.regex("^[a-z]{1,8}$")

/** A document of a package, nesting its tokens in order at `tokens`, as pantry's item nests its tokens. */
const Doc = relation(
	"Doc",
	{ package: PackageName, id: natural, title: PackageName, tokens: drawn(natural) },
	["package", "id"]
)

/** A token of a document, an ordered family's member: written only nested under its document. */
const Token = relation(
	"Token",
	{ package: PackageName, id: natural, at: drawn(natural), text: PackageName },
	["package", "id", "at"]
)

/** A tree of cells per package and root cell, as pantry's CellLeaf's tree: every node nested under its root. */
const Cell = relation(
	"Cell",
	{
		package: PackageName,
		root: natural,
		start: drawn(natural),
		end: drawn(natural),
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		leaf: PackageName
	},
	["package", "root", "start"]
)

/** A plain relation of a package. */
const Ref = relation("Ref", { package: PackageName, id: natural, target: natural }, [
	"package",
	"id"
])

/** A relation of no package, which no computed `package` writes. */
const Loose = relation("Loose", { id: natural, note: PackageName }, ["id"])

export const Packages = schema(
	"Packages",
	[Doc, Token, Cell, Ref, Loose],
	[
		ordered(on(Token, "package", "id", "at"), fin(Doc, "tokens")),
		tree(on(Cell, "parent", "at"), fin(Cell, "children"), { root: ["package", "root"] })
	]
)

/**
 * One case: the program's call and the engine's ChangeSet of it, and the refusal its fault meets, none for an admitted
 * case. Each case is one form or one fault:
 * - `owner`: Doc, its tokens nested, each leaving `package` out;
 * - `tree`: Cell, its root nesting a child, each leaving `package` out;
 * - `two`: Doc and Ref at once;
 * - `lacking`: Doc beside Loose, which holds no `package`;
 * - `member`: Token by its own key, an ordered family's member;
 * - `none`: a record of no field, its rows stating `package`;
 * - `type`: `package` by a parameter of another type;
 * - `stranger`: a field no relation holds;
 * - `stated`: a document's row stating `package`;
 * - `nested`: a token stating `package`.
 */
export const insertAllComputedCases = [
	"owner",
	"tree",
	"two",
	"lacking",
	"member",
	"none",
	"type",
	"stranger",
	"stated",
	"nested"
] as const

export type InsertAllComputedCase = (typeof insertAllComputedCases)[number]

/** A row a case writes: its text in the program, and the value the engine reads. */
interface WrittenRow {
	readonly text: string
	readonly value: Readonly<Record<string, unknown>>
}

/** A document with one token, `package` stated where `pkg` says, its token's where `nested` says. */
const docRow = (pkg: boolean, nested: boolean): WrittenRow => ({
	text: `{ ${pkg ? 'package: "p", ' : ""}id: 1n, title: "t", tokens: [{ ${nested ? 'package: "p", ' : ""}text: "x" }] }`,
	value: {
		...(pkg ? { package: "p" } : {}),
		id: 1n,
		title: "t",
		tokens: [{ ...(nested ? { package: "p" } : {}), text: "x" }]
	}
})

const cellRow: WrittenRow = {
	text: '{ root: 1n, leaf: "a", children: [{ leaf: "b", children: [] }] }',
	value: { root: 1n, leaf: "a", children: [{ leaf: "b", children: [] }] }
}
const refRow: WrittenRow = { text: "{ id: 1n, target: 2n }", value: { id: 1n, target: 2n } }
const looseRow: WrittenRow = { text: '{ id: 1n, note: "n" }', value: { id: 1n, note: "n" } }
const tokenRow: WrittenRow = { text: '{ id: 1n, text: "x" }', value: { id: 1n, text: "x" } }

/** A case's rows by relation: one Doc with one token, one Cell with one child, one Ref, one Loose, one Token, each with
 * `package` where the case states it. */
const rowsOf = (c: InsertAllComputedCase): Readonly<Record<string, ReadonlyArray<WrittenRow>>> => {
	const doc = docRow(c === "none" || c === "stated", c === "nested")
	switch (c) {
		case "owner":
		case "type":
		case "stranger":
		case "stated":
		case "nested":
		case "none":
			return { Doc: [doc] }
		case "tree":
			return { Cell: [cellRow] }
		case "two":
			return { Doc: [doc], Ref: [refRow] }
		case "lacking":
			return { Doc: [doc], Loose: [looseRow] }
		case "member":
			return { Token: [tokenRow] }
	}
}

/** A case's computed record, as the program writes it and the engine builds it. */
const computedOf = (
	c: InsertAllComputedCase
): { readonly text: string; readonly value: () => Readonly<Record<string, unknown>> } => {
	switch (c) {
		case "none":
			return { text: "{}", value: () => ({}) }
		case "type":
			return {
				text: '{ package: param("package", pg.integer) }',
				value: () => ({ package: param("package", pg.integer) })
			}
		case "stranger":
			return {
				text: '{ stranger: param("stranger", PackageName) }',
				value: () => ({ stranger: param("stranger", PackageName) })
			}
		case "owner":
		case "tree":
		case "two":
		case "lacking":
		case "member":
		case "stated":
		case "nested":
			return {
				text: '{ package: param("package", PackageName) }',
				value: () => ({ package: param("package", PackageName) })
			}
	}
}

/** A case's call, as the program writes it after `ChangeSet.empty(Packages)`. */
export const callText = (c: InsertAllComputedCase): string =>
	`.insertAllComputed({ ${Arr.join(
		Arr.map(
			Rec.toEntries(rowsOf(c)),
			([relation, rows]) =>
				`${relation}: [${Arr.join(
					Arr.map(rows, (r) => r.text),
					", "
				)}]`
		),
		", "
	)} }, ${computedOf(c).text})`

/** The call's parameters, the record's: `package`, or `stranger`, each a package's name. */
const paramsOf = (c: InsertAllComputedCase): Readonly<Record<string, unknown>> =>
	c === "stranger" ? { stranger: "p" } : c === "type" ? { package: 1 } : { package: "p" }

/** What a ChangeSet over Packages compiles against. */
const packages = (() => {
	const artifacts = succeeded(testArtifacts(Packages, testCompile))
	return { checked: checking(Packages), options: realityWrite(artifacts) }
})()

/**
 * A case's ChangeSet as the engine builds, compiles and binds it: whether it is refused, and the reason when it is. Its
 * rows are its facts, so the bind reads each as the call states it.
 */
export const insertAllComputedVerdict = (
	c: InsertAllComputedCase
): { readonly kind: "admitted" } | { readonly kind: "refused"; readonly reason: string } => {
	const built = catchCompileError(() =>
		ChangeSet.empty(Packages).insertAllComputed(
			Rec.map(rowsOf(c), (rows) => Arr.map(rows, (r) => r.value)),
			computedOf(c).value()
		)
	)
	if (!built.ok) {
		return { kind: "refused", reason: built.error.reason._tag }
	}
	const desc = changeSetDesc(built.value)
	const parsed = parseChangeSet(built.value)
	if (desc === undefined || parsed === undefined) {
		return { kind: "refused", reason: "not a ChangeSet" }
	}
	const compiled = compileWrite(packages.checked, desc, packages.options)
	if (!compiled.ok) {
		return { kind: "refused", reason: compiled.error.reason._tag }
	}
	const program = compiled.value
	const members = Effect.runSync(collectInputs(program.binding.groups, parsed.inputs))
	const bound = bindWrite(flightOf(servableWrite(program), program.frontend.codes), {
		members,
		params: paramsOf(c),
		transport: inForce(bindFrame)
	})
	if (!bound.ok) {
		return { kind: "refused", reason: bound.error._tag }
	}
	assertVariant(bound.value, "kind", "bound", `the case ${c}'s facts are lawful`)
	return { kind: "admitted" }
}
