/** What the properties of family-columns.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { NativeOf } from "#compiler/ir/law.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, login, relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, roleBuilder as role, wholeWritesOf } from "#compiler/schema/world.ts"
import type { SqlStatement, TableConstraint } from "#compiler/sql/ast.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	admittedFillSpecGen,
	buildFill,
	type FillSpec,
	treeOn
} from "#test/support/families/fill.ts"
import { Id } from "#test/support/ids.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import { owning } from "#test/support/policy.ts"

const Flag = closed.ordered("Flag", ["on", "off"])

const Item = relation("Item", { id: Id, kind: closedId(Flag) }, ["id"])

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

export const familyCaseGen: Gen<FamilyCase> = (source) => ({
	spec: source.draw(admittedFillSpecGen({ relations: relationsAtMost, families: 3, copies: 2 })),
	writings: source.draw(array(writingGen, { min: relationsAtMost, max: relationsAtMost })),
	viewer: source.draw(boolean)
})

/**
 * A case resolved: the schema built, its relations, and the relations each role writes: the writer's whole, and the
 * clerk's through a query entry, each relation drawn so whose key holds no field its family draws. A tree's relation
 * drawn so is keyed by its root fields and its drawn start (fill.ts keyOfRelation), which no fact through an entry
 * states, so a clerk declared with its entry is refused.
 */
interface Resolved {
	readonly c: FamilyCase
	readonly built: ReturnType<typeof buildFill>
	readonly relations: ReadonlyArray<AnyRelation>
	readonly whole: ReadonlyArray<string>
	readonly entries: ReadonlyArray<string>
	readonly treeEntries: ReadonlyArray<string>
}

export const resolve = (c: FamilyCase): Resolved => {
	const built = buildFill(c.spec)
	const relations = Rec.values(built.relations)
	const writtenAs = (w: Writing, keyed: (r: number) => boolean) =>
		Arr.flatMap(relations, (r, i) =>
			defined(c.writings[i], `${r.name}'s writing`) === w && keyed(i) ? [r.name] : []
		)
	const tree = (r: number): boolean => treeOn(c.spec, r) !== undefined
	return {
		c,
		built,
		relations,
		whole: writtenAs("whole", () => true),
		entries: writtenAs("entry", (r) => !tree(r)),
		treeEntries: writtenAs("entry", tree)
	}
}

/** Whether the login holds the viewer: drawn, or as its one role when no role writes. */
const viewedBy = (r: Resolved): boolean =>
	r.c.viewer || (r.whole.length === 0 && r.entries.length === 0)

/** The entry name of a relation a query entry writes. */
const entryName = (relationName: string): string => `${relationName}Entry`

/** A case's schema: its family relations beside Flag and Item. */
const familiesOf = (r: Resolved) =>
	schema("Families", [...Rec.values(r.built.relations), Flag, Item], r.built.statements)

/** The relation of the case named `name`. */
const relationNamed = (r: Resolved, name: string): AnyRelation =>
	defined(Option.getOrUndefined(Arr.findFirst(r.relations, (x) => x.name === name)), name)

/** The lists a role over `Families` names `names` under, each written by `entryOf`: an open relation's entry under its
 * write list, a closed one's under its insert list. */
const listsOver = (
	Families: ReturnType<typeof familiesOf>,
	names: ReadonlyArray<string>,
	entryOf: (name: string) => string
) => {
	const open = wholeWritesOf(Families).write
	const isOpen = (name: string): boolean => Arr.some(open, (o) => o === name)
	return {
		insert: Arr.map(
			Arr.filter(names, (n) => !isOpen(n)),
			entryOf
		),
		write: Arr.map(Arr.filter(names, isOpen), entryOf)
	}
}

/** The clerk over `Families`: a query entry of every field of each relation of `written`, each in its list. */
const clerkOf = (
	Families: ReturnType<typeof familiesOf>,
	r: Resolved,
	written: ReadonlyArray<string>
) =>
	role(
		Families,
		"clerk",
		Rec.fromEntries(
			Arr.map(written, (name) => {
				const relation = relationNamed(r, name)
				return [
					entryName(name),
					queryOver(Families).rule((rule: RuleValue) => {
						const vars = varsOver(relation, "written")
						return rule.match(relation, vars).find(vars)
					})
				] as const
			})
		),
		listsOver(Families, written, entryName)
	)

/** The installation of a case's schema with its login. */
const installationOf = (r: Resolved): Installation => {
	const Families = familiesOf(r)
	const byName = (name: string): AnyRelation => relationNamed(r, name)
	const writer = () =>
		role(
			Families,
			"writer",
			Rec.fromEntries(Arr.map(r.whole, (name) => [name, byName(name)] as const)),
			listsOver(Families, r.whole, (name) => name)
		)
	const clerk = () => clerkOf(Families, r, r.entries)
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
			{ write: [] }
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

/** The CREATE TABLE of `relationName`'s table object, which states the relation's own fields alone: each law column is
 * an object of its own, which the script states in the table's CREATE TABLE (physical/ddl/whole.ts wholeTables). */
const tableOf = (i: Installation, relationName: string): CreateTable =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				Arr.flatMap(i.manifest.objects, (o) => o.ddl),
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

export type FamilyFeature =
	| "a drawn law column"
	| "a drawn law column a query entry writes"
	| "a generated field"
	| "a generated field a query entry writes"
	| "a cascading foreign key"
	| "a deferred foreign key"
	| "a decoding view"
	| "a relation written whole"
	| "a tree's relation written through a query entry refused when declared"

/**
 * A clerk declared with a query entry of every relation the case draws written so, in relation order, is refused
 * exactly where one writes a tree's relation: at the first such entry, whose relation's key holds its drawn start.
 * Where none does, the installation's clerk is that clerk.
 */
const treeEntryRefused = (r: Resolved, k: Case<FamilyFeature>): void => {
	const [first] = r.treeEntries
	if (first === undefined) {
		return
	}
	const Families = familiesOf(r)
	const drawn = Arr.filter(
		Arr.map(r.relations, (x) => x.name),
		(name) => Arr.contains(r.entries, name) || Arr.contains(r.treeEntries, name)
	)
	const error = throwsRefused(
		() => clerkOf(Families, r, drawn),
		"RoleRefused",
		`a clerk writing ${first} through a query entry`
	)
	assert.deepEqual(
		error.reason._tag === "RoleRefused"
			? { role: error.reason.role, rule: error.reason.rule }
			: undefined,
		{
			role: "clerk",
			rule: {
				kind: "writeUnwritable",
				entry: entryName(first),
				why: { kind: "keyHoldsFamily", field: "start" }
			}
		},
		"the clerk is refused at its first entry over a tree's relation, whose key holds the drawn start"
	)
	k.note("a tree's relation written through a query entry refused when declared")
}

export const property = (r: Resolved, k: Case<FamilyFeature>) =>
	Effect.sync(() => {
		treeEntryRefused(r, k)
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
				`${o.column} is no column of ${o.relation.name}'s table object's CREATE TABLE`
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
			if (spec.generated.kind === "none") {
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
