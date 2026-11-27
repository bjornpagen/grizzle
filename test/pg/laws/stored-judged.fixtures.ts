/** What the property of stored-judged.test.ts reads: its schemas and templates, its space, and each case's run. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	contained,
	derived,
	on,
	relation,
	schema,
	sealed,
	unit
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"

/** A declaration's base type, as QTI's baseType vocabulary names it, and the ones a mapping may have. */
const BaseType = closed.ordered("BaseType", ["integer", "file", "point"])
const Mappable = closed.relation(
	"Mappable",
	{ baseType: closedId(BaseType) },
	["baseType"],
	[{ baseType: "integer" }, { baseType: "point" }]
)

/**
 * A package's nodes, by path and start, each of a kind, under its parent; its declarations, by path and start, each of
 * a base type; and the base types each package allows a mapping of, an ordinary relation every write may change.
 * Every relation is keyed by its package first, the unit, and closed.
 */
const Node = relation(
	"Node",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, kind: pg.integer, parent: pg.integer },
	["pkg", "path", "start"]
)
const Decl = relation(
	"Decl",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, baseType: closedId(BaseType) },
	["pkg", "path", "start"]
)
const Allowed = relation("Allowed", { pkg: pg.integer, baseType: closedId(BaseType) }, [
	"pkg",
	"baseType"
])
/**
 * A package's anchors, by the place each stands at and its number there, so no place is a key of it: what each
 * declaration is held to stand at. Its name sorts before Decl, so it is the first holder of the unit of the law over
 * them, as Allowed is of the unit of "Allowed" and pantry's DataSsmlProperty of the unit of its "Data SSML".
 */
const Anchor = relation(
	"Anchor",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, n: pg.integer },
	["pkg", "path", "start", "n"]
)

/** The kind of a mapping's node: its declaration is its parent. */
const mappingKind = 7

/** Whether the package unit is sealed at founding, so its every row is written by the transaction that founds it. */
export type Seal = "sealed" | "unsealed"

/**
 * The schema of `seal`: pantry's MappableBaseType reduced (pantry qti/overlay-queries/declaration.ts) and three laws
 * beside it, each over a derivation the installation stores or keeps live by its own inference:
 *
 * - Mapped, each mapping beside its declaration's base type, by the mapping's place: unit-local at (pkg, path, start),
 *   wider than the package, so it is stored, sealed or not (MappingBaseType). "Mappable" contains its base type in the
 *   closed Mappable: a law that reads a stored derivation and a closed relation alone;
 * - Typed, the base types a package's mappings have, by package: unit-local at the package alone, so it is live where
 *   the package is unsealed, its upkeep re-deriving the package at every write, and stored where it is sealed, its
 *   rows founded with the package. "Typed mappable" contains its base type in Mappable, and "No point" checks it is no
 *   point, each a law over the derivation alone (pantry's identifier and title mismatches, its lookups);
 * - "Allowed" contains Mapped's base type in the package's Allowed, a law that also reads an ordinary relation: a
 *   whole rule over the stored Mapped and the closed Allowed, pantry's "Data SSML" (RequiredSsmlProperty in the closed
 *   DataSsmlProperty) reduced. Allowed sorts first among its unit's holders, and the rule's region reads it only where
 *   it loses rows, which only a data step does, whose bracket's re-check judges the rule whole, so the judge captures
 *   no side of it: the rule's block raises at Mapped, the holder whose writes change it (physical/ddl/rules.ts
 *   unitBlock), where it took the unit's first holder, for which no judged table stood, and pantry failed to generate;
 * - "Anchored" contains each declaration's place, through Declared, Decl's places read as Decl's own rows, in Anchor's,
 *   at no key of Anchor: a whole rule over closed relations alone, Anchor its unit's first holder again, read only where
 *   it loses rows, its block raising at Decl, whose rows a served write adds and so can break it.
 *
 * A law is held exactly as its derivation reads, stored or live: a write of the derivation's holders changes it
 * (laws/model/model.ts changedBy), so the rule judge holds every law over it at that write's COMMIT, the founding one
 * among them.
 */
const judgedSchema = (seal: Seal) => {
	const Package = unit("Package", { pkg: pg.integer })
	const Base = schema(
		seal === "sealed" ? "SealedJudged" : "UnsealedJudged",
		[BaseType, Mappable, Node, Decl, Allowed, Anchor],
		[seal === "sealed" ? sealed(Package) : Package]
	)
	const Mapped = derived(
		"Mapped",
		query(Base).rule((r) => {
			const { pkg, path, start, parent } = v(Node, "mapping")
			const { baseType } = v(Decl, "declaration")
			return r
				.match(Node, { pkg, path, start, kind: mappingKind, parent })
				.match(Decl, { pkg, path, start: parent, baseType })
				.find({ pkg, path, start, baseType })
		})
	)
	const Typed = derived(
		"Typed",
		query(Base).rule((r) => {
			const { pkg, path, parent } = v(Node, "mapping")
			const { baseType } = v(Decl, "declaration")
			return r
				.match(Node, { pkg, path, kind: mappingKind, parent })
				.match(Decl, { pkg, path, start: parent, baseType })
				.find({ pkg, baseType })
		})
	)
	const Declared = derived(
		"Declared",
		query(Base).rule((r) => {
			const { pkg, path, start } = v(Decl, "declaration")
			return r.match(Decl, { pkg, path, start }).find({ pkg, path, start })
		})
	)
	return schema.extend(
		[Base],
		`${Base.name}_1`,
		[Mapped, Typed, Declared],
		[
			contained(on(Mapped, "baseType"), on(Mappable, "baseType")),
			contained(on(Typed, "baseType"), on(Mappable, "baseType")),
			check("No_point", Typed, (t) => t.ne(t.baseType, "point")),
			contained(on(Mapped, "pkg", "baseType"), on(Allowed, "pkg", "baseType")),
			contained(on(Declared, "pkg", "path", "start"), on(Anchor, "pkg", "path", "start"))
		]
	)
}

/** The schema of `seal` installed by its first migration, with no login. */
const judgedTemplate = (seal: Seal) => {
	const value = judgedSchema(seal)
	return migratedTemplate({
		declaredIn: import.meta,
		name: `stored judged ${seal}`,
		content: { schema: value.name, logins: [] },
		versions: [{ schema: value, declarations: noDeclarations }],
		options: {
			label: `${seal}_judged`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

/** Each seal's template. */
export const judgedTemplates = {
	sealed: judgedTemplate("sealed"),
	unsealed: judgedTemplate("unsealed")
} as const satisfies Record<Seal, ReturnType<typeof judgedTemplate>>

type BaseTypeName = "integer" | "file" | "point"

/**
 * A case: the package's seal, and the founding transaction of package 1: its declarations, each at a start of path 1
 * with a base type; its mappings, each a node at a start of path 1 under one of the declarations; the base types it
 * allows; and the declaration it writes no anchor at, none where it anchors each.
 */
export interface JudgedCase {
	readonly seal: Seal
	readonly declarations: ReadonlyArray<{ readonly start: number; readonly baseType: BaseTypeName }>
	readonly mappings: ReadonlyArray<{ readonly start: number; readonly parent: number }>
	readonly allowed: ReadonlyArray<BaseTypeName>
	readonly unanchored: number | undefined
}

const baseTypes = ["integer", "file", "point"] as const satisfies ReadonlyArray<BaseTypeName>

/**
 * Declarations at starts 1 to 3, mappings at starts 11 to 13, each under any declaration's start, and an anchor at each
 * declaration's place, or at each but one.
 */
export const judgedCaseGen: Gen<JudgedCase> = (s) => {
	const declarations = Arr.map(s.draw(subset([1, 2, 3] as const, { min: 1, max: 3 })), (start) => ({
		start,
		baseType: s.draw(element(baseTypes))
	}))
	const parents = Arr.map(declarations, (d) => d.start)
	return {
		seal: s.draw(element(["sealed", "unsealed"] as const)),
		declarations,
		mappings: Arr.map(s.draw(subset([11, 12, 13] as const, { min: 0, max: 3 })), (start) => ({
			start,
			parent: s.draw(element(nonEmpty(parents, "the declarations a mapping is under")))
		})),
		allowed: s.draw(subset(baseTypes, { min: 0, max: 3 })),
		unanchored: s.draw(element<number | undefined>([undefined, ...parents]))
	}
}

export type JudgedFeature =
	| "refused, sealed"
	| "refused, unsealed"
	| "accepted, sealed"
	| "accepted, unsealed"
	| "a stored derivation's law over a closed relation alone broken"
	| "a package derivation's law over itself alone broken"
	| "a whole rule into its unit's first holder, closed, broken alone beside a stored derivation"
	| "a whole rule into its unit's first holder, closed, broken alone over closed relations alone"

/** The laws a case's state breaks, as the schema states them over the drawn rows (`judgedSchema`). */
const brokenLaws = (c: JudgedCase): ReadonlyArray<string> => {
	const typeAt = new Map(Arr.map(c.declarations, (d) => [d.start, d.baseType] as const))
	const mapped = Arr.flatMap(c.mappings, (m) => {
		const t = typeAt.get(m.parent)
		return t === undefined ? [] : [t]
	})
	return [
		...(Arr.some(mapped, (t) => t === "file") ? ["Mappable", "Typed mappable"] : []),
		...(Arr.some(mapped, (t) => t === "point") ? ["No point"] : []),
		...(Arr.some(mapped, (t) => !Arr.contains(c.allowed, t)) ? ["Allowed"] : []),
		...(c.unanchored === undefined ? [] : ["Anchored"])
	]
}

/** The INSERT of `rows` into `table`'s columns `fields`, none where there are none; a base type by its code. */
const insertOf = (
	installed: Installed,
	table: Parameters<ReturnType<typeof namesOf>["table"]>[0],
	fields: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<string> => {
	if (!Arr.isReadonlyArrayNonEmpty(rows)) {
		return []
	}
	const names = namesOf(installed)
	const columns = Arr.join(
		Arr.map(fields, (f) => quoteIdent(names.columnIdent(table, f))),
		", "
	)
	const values = Arr.join(
		Arr.map(rows, (row) => `(${Arr.join(Arr.map(row, String), ", ")})`),
		", "
	)
	return [`INSERT INTO ${names.table(table)} (${columns}) VALUES ${values}`]
}

/** A base type's code: its place in the roster, as the first codebook numbers it. */
const codeOf = (t: BaseTypeName): number => baseTypes.indexOf(t)

/**
 * One case in its one transaction, which the case's end rolls back: package 1 founded by the drawn rows, written
 * through the captures, then judged (SET CONSTRAINTS ALL IMMEDIATE), which must refuse exactly when a law breaks
 * (`brokenLaws`), under an integrity SQLSTATE.
 */
export const runJudged = (
	installed: Installed,
	connection: PgConnection,
	drawn: JudgedCase,
	c: Case<JudgedFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const statements = [
			...insertOf(
				installed,
				Decl,
				["pkg", "path", "start", "baseType"],
				Arr.map(drawn.declarations, (d) => [1, 1, d.start, codeOf(d.baseType)])
			),
			...insertOf(
				installed,
				Node,
				["pkg", "path", "start", "kind", "parent"],
				Arr.map(drawn.mappings, (m) => [1, 1, m.start, mappingKind, m.parent])
			),
			...insertOf(
				installed,
				Allowed,
				["pkg", "baseType"],
				Arr.map(drawn.allowed, (t) => [1, codeOf(t)])
			),
			...insertOf(
				installed,
				Anchor,
				["pkg", "path", "start", "n"],
				Arr.flatMap(drawn.declarations, (d) =>
					d.start === drawn.unanchored ? [] : [[1, 1, d.start, 0]]
				)
			)
		]
		for (const sql of statements) {
			yield* connection.query(sql, [])
		}
		const broken = brokenLaws(drawn)
		const refused = yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		assert.equal(
			Option.isSome(refused),
			broken.length > 0,
			`${Formatter.format(drawn)}: the judge ${Option.isSome(refused) ? "refused" : "accepted"} a state that breaks ${broken.length === 0 ? "no law" : Arr.join(broken, ", ")}`
		)
		if (Option.isSome(refused)) {
			assert.ok(
				Arr.contains(["23503", "23505", "23514"], refused.value.code),
				`${Formatter.format(drawn)}: the judge refused under ${refused.value.code}, an integrity SQLSTATE`
			)
		}
		c.note(`${broken.length > 0 ? "refused" : "accepted"}, ${drawn.seal}`)
		if (broken.includes("Mappable") && !broken.includes("Allowed")) {
			c.note("a stored derivation's law over a closed relation alone broken")
		}
		if (broken.includes("No point") && !broken.includes("Allowed")) {
			c.note("a package derivation's law over itself alone broken")
		}
		if (broken.length === 1 && broken.includes("Allowed")) {
			c.note(
				"a whole rule into its unit's first holder, closed, broken alone beside a stored derivation"
			)
		}
		if (broken.length === 1 && broken.includes("Anchored")) {
			c.note(
				"a whole rule into its unit's first holder, closed, broken alone over closed relations alone"
			)
		}
	})
