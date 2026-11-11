/**
 * The columns and references a family installs (physical/ddl/tables.ts), against the law model's natives, a second
 * representation of what the installation must hold.
 *
 * Each case draws a family schema (test/support/families/fill.ts: relations with a generated field or none, ordered and
 * counted families and trees between them, folds and copies on their axes), one the fill reference admits, beside a
 * roster and a relation Item with a closed id over it; and a login holding a role that writes a drawn set of the
 * relations whole, a role that writes each relation of another drawn set through a query entry of all its fields, so
 * its writes are column grants, or a role that reads Item through a query entry, so its view decodes the closed id,
 * at least one of them.
 *
 * - every installed statement keeps the emission discipline (oracle/verify checkedStatements), a decoding query entry's
 *   view included;
 * - every law column, drawn or generated, is its own object of one `ALTER TABLE ... ADD COLUMN` after its table, a drawn
 *   one a plain column with no generation, so NOT NULL like every column, and every role that writes its table through
 *   column grants holds INSERT on it (D13, D14); a generated field is GENERATED ALWAYS AS (e) STORED and holds no
 *   INSERT grant; a table holds INSERT column grants exactly where a query entry writes its relation;
 * - every foreign key is installed ON UPDATE CASCADE exactly where its native cascades (a family's owner axis), and
 *   DEFERRABLE INITIALLY DEFERRED exactly where its native defers; a PERIOD foreign key takes its native's deferral and
 *   never an action.
 *
 * A family's first migration drafting, and a family added to relations that stand, are the families' suites'
 * (test/pg/fin, which installs each drawn family through its first migration) and the backfill's
 * (test/unit/deploy/backfill.test.ts, which drafts and runs every drawn family added to stored rows).
 *
 * Oracles: the law model's natives, a second representation of what the installation must hold, and the emission
 * audit (oracle/verify). A drawn specification the fill reference refuses is given up (test/support/families/fill.ts
 * draws both, and builds no admitted one alone).
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): family-columns-no-cascade.patch (no foreign key cascades on update).
 *
 * Features: a drawn law column, alone and written by a query entry; a generated field, alone and written by a query
 * entry; a cascading and a deferred foreign key; a decoding view; a relation written whole.
 */
import { describe, it } from "@effect/vitest"
import { type Case, explore, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { NativeOf } from "#compiler/ir/law.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { closedId, uuid } from "#compiler/public/fields.ts"
import { closed, login, relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, role } from "#compiler/schema/world.ts"
import type { SqlStatement, TableConstraint } from "#compiler/sql/ast.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { buildFill, type FillSpec, fillSpecGen, verdictOf } from "#test/support/families/fill.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import { owning } from "#test/support/policy.ts"

const Flag = closed("Flag", ["on", "off"])
const Item = relation("Item", { id: uuid, kind: closedId(Flag) }, ["id"])

/** How a login's roles write one relation of the family schema: not at all, whole, or through a query entry. */
type Writing = "none" | "whole" | "entry"

interface FamilyCase {
	readonly spec: FillSpec
	/** Each relation's writing, by its index: as many as the specification may draw relations. */
	readonly writings: ReadonlyArray<Writing>
	readonly viewer: boolean
}

const writingGen: Gen<Writing> = (source) => {
	switch (source.draw(int(0, 2))) {
		case 0:
			return "none"
		case 1:
			return "whole"
		default:
			return "entry"
	}
}

/** The most relations a drawn specification holds. */
const relationsAtMost = 3

const familyCaseGen: Gen<FamilyCase> = (source) => ({
	spec: source.draw(fillSpecGen({ relations: relationsAtMost, families: 3, copies: 2 })),
	writings: source.draw(array(writingGen, { min: relationsAtMost, max: relationsAtMost })),
	viewer: source.draw(boolean)
})

/** A case resolved: the schema built, its relations, and the relations each role writes. */
interface Resolved {
	readonly c: FamilyCase
	readonly built: ReturnType<typeof buildFill>
	readonly relations: ReadonlyArray<AnyRelation>
	readonly whole: ReadonlyArray<string>
	readonly entries: ReadonlyArray<string>
}

const resolve = (c: FamilyCase): Resolved => {
	const built = buildFill(c.spec)
	const relations = Rec.values(built.relations)
	const writtenAs = (w: Writing) =>
		Arr.flatMap(relations, (r, i) =>
			defined(c.writings[i], `${r.name}'s writing`) === w ? [r.name] : []
		)
	return { c, built, relations, whole: writtenAs("whole"), entries: writtenAs("entry") }
}

/** Whether the login holds the viewer: drawn, or as its one role when no role writes. */
const viewedBy = (r: Resolved): boolean =>
	r.c.viewer || (r.whole.length === 0 && r.entries.length === 0)

/** The entry name of a relation a query entry writes. */
const entryName = (relationName: string): string => `${relationName}Entry`

/** The installation of a case's schema with its login. */
const installationOf = (r: Resolved): Installation => {
	const Families = schema("Families", { ...r.built.relations, Flag, Item }, r.built.statements)
	const byName = (name: string): AnyRelation =>
		defined(Option.getOrUndefined(Arr.findFirst(r.relations, (x) => x.name === name)), name)
	const writer = () =>
		role(
			Families,
			"writer",
			Rec.fromEntries(Arr.map(r.whole, (name) => [name, byName(name)] as const)),
			{ write: r.whole, refresh: [] }
		)
	const clerk = () =>
		role(
			Families,
			"clerk",
			Rec.fromEntries(
				Arr.map(r.entries, (name) => {
					const written = byName(name)
					return [
						entryName(name),
						queryOver(Families).rule((rule: RuleValue) => {
							const vars = varsOver(written, "written")
							return rule.match(written, vars).find(vars)
						})
					] as const
				})
			),
			{ write: Arr.map(r.entries, entryName), refresh: [] }
		)
	const viewer = () =>
		role(
			Families,
			"viewer",
			{
				Kinds: queryOver(Families).rule((rule: RuleValue) => {
					const vars = varsOver(Item, "item")
					return rule.match(Item, vars).find(vars)
				})
			},
			{ write: [], refresh: [] }
		)
	const roles = nonEmpty(
		[
			...(r.whole.length > 0 ? [writer()] : []),
			...(r.entries.length > 0 ? [clerk()] : []),
			...(viewedBy(r) ? [viewer()] : [])
		],
		"the login's roles"
	)
	const desk = login(Families, "desk", roles)
	const owned = owning(Families)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				installationsOf(owned),
				[succeeded(ownLogin(defined(loginDescOf(desk), "a login built by login(...)")))],
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

type CreateTable = Extract<SqlStatement, { readonly kind: "createTable" }>

const tableOf = (i: Installation, relationName: string): CreateTable =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				i.statements,
				(s): s is CreateTable =>
					s.kind === "createTable" && s.table.name === i.names.relation(relationName).name
			)
		),
		`the table of ${relationName}`
	)

/** Every foreign key the installation adds, by its constraint's name. */
const foreignKeysOf = (
	i: Installation
): ReadonlyMap<string, Extract<TableConstraint, { readonly kind: "foreignKey" }>> =>
	new Map(
		Arr.flatMap(i.statements, (s) =>
			s.kind === "alterTable"
				? Arr.flatMap(s.actions, (a) =>
						a.kind === "addConstraint" && a.constraint.kind === "foreignKey"
							? [[a.constraint.name, a.constraint] as const]
							: []
					)
				: []
		)
	)

type FamilyFeature =
	| "a drawn law column"
	| "a drawn law column a query entry writes"
	| "a generated field"
	| "a generated field a query entry writes"
	| "a cascading foreign key"
	| "a deferred foreign key"
	| "a decoding view"
	| "a relation written whole"

const property = (r: Resolved, k: Case<FamilyFeature>) =>
	Effect.sync(() => {
		const i = installationOf(r)
		checkedStatements(i.statements, "installation statement")
		if (viewedBy(r)) {
			k.note("a decoding view")
			const decoded = `${i.names.column("Item", "kind")}_name`
			assert.ok(
				Arr.some(i.statements, (s) => s.kind === "createView" && Arr.contains(s.columns, decoded)),
				"the viewer's view decodes Item's closed id"
			)
		}
		if (r.whole.length > 0) {
			k.note("a relation written whole")
		}
		const natives = i.laws.natives
		const columnGrants = Arr.filter(
			i.statements,
			(s): s is Extract<SqlStatement, { readonly kind: "grantColumns" }> =>
				s.kind === "grantColumns" && s.privilege === "INSERT"
		)
		for (const relationName of [...Arr.map(r.relations, (x) => x.name), "Item"]) {
			const table = tableOf(i, relationName)
			assert.equal(
				Arr.some(columnGrants, (g) => g.table.name === table.table.name),
				Arr.contains(r.entries, relationName),
				`${relationName}'s table holds INSERT column grants exactly where a query entry writes it`
			)
		}
		const drawnColumns = Arr.flatMap(natives, (n) =>
			n.object.kind === "LawColumn" && n.object.value.kind === "drawn" ? [n.object] : []
		)
		for (const o of drawnColumns) {
			k.note("a drawn law column")
			const table = tableOf(i, o.relation.name)
			assert.ok(
				!Arr.some(table.columns, (col) => col.name === o.column),
				`${o.column} is no column of ${o.relation.name}'s CREATE TABLE`
			)
			const object = defined(
				Option.getOrUndefined(
					Arr.findFirst(
						i.manifest.objects,
						(m) => m.kind === "lawColumn" && Str.endsWith(`.${o.column}`)(m.ident)
					)
				),
				`the law column object of ${o.column}`
			)
			const [statement, ...more] = object.ddl
			assert.equal(more.length, 0, `${o.column}'s object is one statement`)
			const added =
				statement?.kind === "alterTable" && statement.actions.length === 1
					? statement.actions[0]
					: undefined
			assert.ok(
				added?.kind === "addColumn" && added.column.name === o.column,
				`${o.column}'s object is its ALTER TABLE ... ADD COLUMN`
			)
			assert.equal(added.column.generated, undefined, `${o.column} is no generated column`)
			const grants = Arr.filter(columnGrants, (g) => g.table.name === table.table.name)
			if (grants.length > 0) {
				k.note("a drawn law column a query entry writes")
			}
			for (const g of grants) {
				assert.ok(Arr.contains(g.columns, o.column), `${g.to} may insert ${o.column}`)
			}
		}
		for (const [index, spec] of r.c.spec.relations.entries()) {
			if (!spec.generated) {
				continue
			}
			k.note("a generated field")
			const relationName = defined(r.relations[index], `relation ${index}`).name
			const table = tableOf(i, relationName)
			const g = defined(
				Option.getOrUndefined(
					Arr.findFirst(table.columns, (col) => col.name === i.names.column(relationName, "g"))
				),
				`${relationName}.g`
			)
			assert.equal(
				g.generated?.kind,
				"stored",
				"a generated field is GENERATED ALWAYS AS (e) STORED"
			)
			for (const grant of Arr.filter(columnGrants, (x) => x.table.name === table.table.name)) {
				k.note("a generated field a query entry writes")
				assert.ok(!Arr.contains(grant.columns, g.name), "no role inserts a generated field")
			}
		}
		const installed = foreignKeysOf(i)
		for (const n of natives) {
			if (n.namespace !== "constraint") {
				continue
			}
			const o = n.object
			if (o.kind !== "ForeignKey" && o.kind !== "PeriodForeignKey") {
				continue
			}
			const fk = defined(
				installed.get(identifierOf(n.named)),
				`the foreign key ${identifierOf(n.named)}`
			)
			if (o.deferrable) {
				k.note("a deferred foreign key")
			}
			assert.equal(
				fk.deferrable,
				o.deferrable ? "INITIALLY DEFERRED" : undefined,
				`${fk.name} defers exactly where its native does`
			)
			const action: NativeOf<"ForeignKey">["onUpdate"] =
				o.kind === "ForeignKey" ? o.onUpdate : "noAction"
			if (action === "cascade") {
				k.note("a cascading foreign key")
			}
			assert.equal(
				fk.onUpdate,
				action === "cascade" ? "CASCADE" : undefined,
				`${fk.name} cascades exactly where its native does`
			)
		}
	})

describe("a family's columns and references", () => {
	it.effect(
		"keep the emission discipline, and drawn law columns, generated fields and foreign key actions follow their natives, whatever roles write them",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/physical/family-columns",
						draw: sketched(familyCaseGen, resolve),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the law model's natives, and the emission audit"
						},
						coverage: required<FamilyFeature>(
							[
								"a drawn law column",
								"a drawn law column a query entry writes",
								"a generated field",
								"a generated field a query entry writes",
								"a cascading foreign key",
								"a deferred foreign key",
								"a decoding view",
								"a relation written whole"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(r, k) =>
						Effect.gen(function* () {
							yield* k.assume(verdictOf(r.c.spec).kind === "admitted")
							yield* property(r, k)
						})
				)
			)
	)
})
