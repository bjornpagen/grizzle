/** What the property of data-step-recheck.test.ts reads: the schema each case installs, its data step and its oracle. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { type MigrateError } from "#adapter/migrate/errors.ts"
import { type FolderTexts } from "#adapter/migrate/input.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { type Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyRelation,
	check,
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { steps } from "#test/pg/migrate/data-step-recheck.dictionary.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { type Version } from "#test/support/install-migrate.ts"
import { customDataStep, noDeclarations } from "#test/support/migrate/kit.ts"
import { draftNext, installFirst, serverOf } from "#test/support/pg/closed/codes.fixtures.ts"
import { apply, noFurther, openMigrator } from "#test/support/pg/migrate/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

export type Step = (typeof steps)[number]

/** A version's change from the first (`versionOf`). */
type Change = "first" | "grown" | "noted" | "memo" | "widened"

/**
 * A family's rows, every relation closed: Parent, keyed by its family g and p beside a cap, in the unit of g; Toy, a
 * parent's toy t, in the same unit; and Child, keyed by c in the unit of c, of a parent (g, p). Child(g, p) ⊆
 * Parent(g, p) and Toy(g, p) ⊆ Parent(g, p), each a foreign key checked at COMMIT, Parent holding a field neither
 * references.
 *
 * - Childless, each parent no child is of, read across the two units, so its rule is the rule judge's, probed: Child
 *   read under a negation, the side of what a write removes of it, which no served write has of a closed relation, so
 *   no probe reads it (analysis/theory/query.ts probedTouches);
 * - Capped, each child beside its parent's cap, its rule the judge's too: Parent's key pinned by Child, Parent closed,
 *   so no probe reads the rows a write adds to Parent (Cover `fresh`);
 * - Toys, each toy beside its parent's cap, read within the unit of g at the parent, a unit wider than g's, so grizzle
 *   stores it, its key (g, p, t) and its cap past the key: its upkeep reads no row a write removes of Parent or Toy,
 *   and none an UPDATE of Parent's cap gives.
 */
const familyOf = (name: string) => {
	const Parent = relation("Parent", { g: pg.integer, p: pg.integer, cap: pg.integer }, ["g", "p"])
	const Toy = relation("Toy", { g: pg.integer, p: pg.integer, t: pg.integer }, ["g", "p", "t"])
	const Child = relation("Child", { c: pg.integer, g: pg.integer, p: pg.integer }, ["c"])
	const Base = schema(
		name,
		[Parent, Toy, Child],
		[
			contained(on(Child, "g", "p"), on(Parent, "g", "p")),
			contained(on(Toy, "g", "p"), on(Parent, "g", "p")),
			unit("Family", { g: pg.integer }),
			unit("Kin", { c: pg.integer })
		]
	)
	const Childless = derived(
		"Childless",
		query(Base).rule((r) => {
			const { g, p } = v(Parent, "parent")
			return r.match(Parent, { g, p }).where(r.not(Child, { g, p })).find({ g, p })
		})
	)
	const Capped = derived(
		"Capped",
		query(Base).rule((r) => {
			const { c, g, p } = v(Child, "child")
			const { cap } = v(Parent, "parent")
			return r.match(Child, { c, g, p }).match(Parent, { g, p, cap }).find({ c, cap })
		})
	)
	const Toys = derived(
		"Toys",
		query(Base).rule((r) => {
			const { g, p, t } = v(Toy, "toy")
			const { cap } = v(Parent, "parent")
			return r.match(Toy, { g, p, t }).match(Parent, { g, p, cap }).find({ g, p, t, cap })
		})
	)
	const Top = schema.extend(
		[Base],
		`${name}_top`,
		[Childless, Capped, Toys],
		[
			check("Childless_none", Childless, (d) => d.lt(d.p, 0)),
			check("Capped_within", Capped, (d) => d.le(d.c, d.cap))
		]
	)
	return { Parent, Top }
}

/**
 * The level above a family of its notes and marks (`versionOf`): Note, a relation no rule reads, holding one row, with
 * a field memo; and Mark, a parent's mark v, keyed by m apart from every unit, and Marked, each mark beside its parent
 * at m, read across two units, so its rule, every mark at least 1, is the judge's. A later version gives Note a field
 * tier, whose value a placeholder asks (`grown`), opens Note, `mutable(Note)`, which writes no row (`noted`), widens
 * Note's memo to bigint, a fill no rule reads (`memo`), or widens Mark's v to bigint, a fill Marked's rule reads
 * (`widened`, `markedOf`).
 */
const notedOf = (
	name: string,
	family: ReturnType<typeof familyOf>,
	change: Exclude<Change, "widened">
): Version => {
	const Mark = relation("Mark", { m: pg.integer, g: pg.integer, v: pg.integer }, ["m"])
	const Marking = schema.extend([family.Top], `${name}_mark`, [Mark], [])
	const Marked = derived(
		"Marked",
		query(Marking).rule((r) => {
			const { m, g, v: mark } = v(Mark, "mark")
			return r.match(Mark, { m, g, v: mark }).match(family.Parent, { g, p: m }).find({ m, mark })
		})
	)
	const Note: AnyRelation =
		change === "grown"
			? relation("Note", { n: pg.integer, memo: pg.integer, tier: pg.integer }, ["n"])
			: change === "memo"
				? relation("Note", { n: pg.integer, memo: pg.bigint }, ["n"])
				: relation("Note", { n: pg.integer, memo: pg.integer }, ["n"])
	const Marks = schema.extend(
		[Marking],
		`${name}_marks`,
		[Marked],
		[check("Marked_low", Marked, (d) => d.ge(d.mark, 1))]
	)
	return {
		schema: schema.extend(
			[Marks],
			`${name}_note`,
			[Note],
			[unit("Noted", { n: pg.integer }), ...(change === "noted" ? [mutable(Note)] : [])]
		),
		logins: []
	}
}

/** The level of notes and marks (`notedOf`) with Mark's v widened to bigint, which the version's fill sets. */
const markedOf = (name: string, family: ReturnType<typeof familyOf>): Version => {
	const Mark = relation("Mark", { m: pg.integer, g: pg.integer, v: pg.bigint }, ["m"])
	const Marking = schema.extend([family.Top], `${name}_mark`, [Mark], [])
	const Marked = derived(
		"Marked",
		query(Marking).rule((r) => {
			const { m, g, v: mark } = v(Mark, "mark")
			return r.match(Mark, { m, g, v: mark }).match(family.Parent, { g, p: m }).find({ m, mark })
		})
	)
	const Note = relation("Note", { n: pg.integer, memo: pg.integer }, ["n"])
	const Marks = schema.extend(
		[Marking],
		`${name}_marks`,
		[Marked],
		[check("Marked_low", Marked, (d) => d.ge(d.mark, 1n))]
	)
	return {
		schema: schema.extend([Marks], `${name}_note`, [Note], [unit("Noted", { n: pg.integer })]),
		logins: []
	}
}

/** The installation's version under `change` (Change): the family (`familyOf`) and the level above it. */
const versionOf = (name: string, change: Change): Version =>
	change === "widened" ? markedOf(name, familyOf(name)) : notedOf(name, familyOf(name), change)

/**
 * What a draft holds of the re-check under `change` (`recheckCase`): whether its Structure holds a data step, whether it
 * refills Toys, and the rules it checks there, by name. A placeholder's field is a step a reviewer writes: everything
 * re-checked; a fill grizzle drafts re-checks the rules that read the column it fills, Marked's for Mark's v and none
 * for Note's memo; a relation opened is no data step.
 */
const draftedOf: Readonly<
	Record<
		Exclude<Change, "first">,
		{
			readonly slot: boolean
			readonly refills: boolean
			readonly checks: ReadonlyArray<string>
		}
	>
> = {
	grown: { slot: true, refills: true, checks: ["Childless_none", "Capped_within", "Marked_low"] },
	noted: { slot: false, refills: false, checks: [] },
	memo: { slot: true, refills: false, checks: [] },
	widened: { slot: true, refills: false, checks: ["Marked_low"] }
}

/** The laws a refusal's constraint names: a rule's check names its law itself, a table's constraint through the map. */
const refusedLaws = (installation: Installation, e: MigrateError): ReadonlyArray<string> => {
	const server = serverOf(e)
	const constraint = defined(server.constraint, `the refusal names a constraint: ${e.message}`)
	const table = server.table
	return table === undefined
		? [constraint]
		: Arr.map(
				lawsOfConstraint(
					installation.constraintToLaw,
					{ kind: "table", name: table },
					constraint
				) ?? [],
				String
			)
}

/** The display of the law of `installation` whose id is `law`, which names the check it states. */
const displayOf = (installation: Installation, law: string): string =>
	defined(
		Arr.findFirst(installation.laws.rules, (r) => r.law.id === law).pipe(
			Option.map((r) => r.law.named.display),
			Option.getOrUndefined
		),
		`the law ${law}, a rule of the installation's`
	)

/**
 * One case: the family installed, its rows inserted by the owner (family 1's parents 1 and 2 at cap 5, each with child
 * c = p and toy 0), then `step` migrated through the runner as the installation's owner. Answers the laws a refusal
 * names, by display, none where the migration applied; and whether every stored row of Toys is a row of its definition
 * and the other way round, read after it.
 */
export const recheckCase = (step: Step) =>
	Effect.gen(function* () {
		const { m } = yield* installFirst("data_step_recheck", (name) => ({
			version: versionOf(name, "first")
		}))
		const table = (r: string) => printObjectName(m.names.relation(r))
		const column = (r: string, f: string) => quoteIdent(m.names.column(r, f))
		assert.ok(
			m.installation.checked.holdings.get("Toys")?.kind === "stored",
			"Toys is stored: its definition reads the unit of g alone, at a parent"
		)
		yield* m.owner.begin
		for (const p of [1, 2]) {
			yield* m.owner.query(
				`INSERT INTO ${table("Parent")} (${column("Parent", "g")}, ${column("Parent", "p")}, ${column("Parent", "cap")}) VALUES (1, ${p}, 5)`,
				[]
			)
			yield* m.owner.query(
				`INSERT INTO ${table("Child")} (${column("Child", "c")}, ${column("Child", "g")}, ${column("Child", "p")}) VALUES (${p}, 1, ${p})`,
				[]
			)
			yield* m.owner.query(
				`INSERT INTO ${table("Toy")} (${column("Toy", "g")}, ${column("Toy", "p")}, ${column("Toy", "t")}) VALUES (1, ${p}, 0)`,
				[]
			)
		}
		yield* m.owner.query(
			`INSERT INTO ${table("Note")} (${column("Note", "n")}, ${column("Note", "memo")}) VALUES (1, 7)`,
			[]
		)
		yield* m.owner.query(
			`INSERT INTO ${table("Mark")} (${column("Mark", "m")}, ${column("Mark", "g")}, ${column("Mark", "v")}) VALUES (1, 1, 5)`,
			[]
		)
		yield* m.owner.commit
		const lonely = `DELETE FROM ${table("Child")} WHERE ${column("Child", "c")} = 1;`
		const family = [
			`DELETE FROM ${table("Toy")} WHERE ${column("Toy", "p")} = 2;`,
			`DELETE FROM ${table("Child")} WHERE ${column("Child", "p")} = 2;`,
			`DELETE FROM ${table("Parent")} WHERE ${column("Parent", "p")} = 2;`
		] as const
		const capped = (cap: number) =>
			`UPDATE ${table("Parent")} SET ${column("Parent", "cap")} = ${cap} WHERE ${column("Parent", "p")} = 1;`
		const lawOf = (name: string) =>
			defined(
				Arr.findFirst(m.installation.laws.rules, (r) =>
					Str.includes(name)(r.law.named.display)
				).pipe(
					Option.map((r) => r.law.id),
					Option.getOrUndefined
				),
				`the rule ${name}`
			)
		const draftWith = (change: Exclude<Change, "first">, statements: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				const next = yield* draftNext(
					m,
					m.snapshot,
					versionOf(m.declared, change),
					m.folders.length + 1,
					noDeclarations
				)
				const immediate = "SET CONSTRAINTS ALL IMMEDIATE;"
				const expected = draftedOf[change]
				const structure = Arr.findFirst(next.folder.files, (f) =>
					Str.includes(immediate)(joined(f.text))
				).pipe(
					Option.map((f) => joined(f.text)),
					Option.getOrElse(() => "")
				)
				const validate = Arr.join(
					Arr.map(
						Arr.filter(next.folder.files, (f) => Str.includes("validate")(f.name)),
						(f) => joined(f.text)
					),
					"\n"
				)
				const checked = (name: string, text: string) =>
					Str.includes(`-- The full violation query of law ${lawOf(name)}.`)(text)
				assert.equal(structure !== "", expected.slot, "the draft's Structure holds a data step")
				assert.equal(
					Str.includes("MERGE INTO")(structure),
					expected.refills,
					"the draft refills Toys exactly where a step a reviewer writes may move its rows"
				)
				assert.deepEqual(
					Arr.filter(["Childless_none", "Capped_within", "Marked_low"], (name) =>
						checked(name, structure)
					),
					[...expected.checks],
					"the draft's Structure re-checks exactly the rules its steps' writes meet"
				)
				for (const name of expected.checks) {
					assert.ok(
						!checked(name, validate),
						`${name}, re-checked in Structure, is checked in Validate no more`
					)
				}
				const folder: FolderTexts = {
					...next.folder,
					files: Arr.map(next.folder.files, (f) =>
						Str.includes(immediate)(joined(f.text))
							? {
									...f,
									text: chunked(
										Str.replace(
											immediate,
											Arr.join([immediate, ...statements], "\n")
										)(joined(f.text))
									)
								}
							: f
					)
				}
				return { snapshot: next.snapshot, folder }
			})
		const migrated = (() => {
			switch (step) {
				case "a custom step deletes a parent's last child":
					return Effect.succeed({
						snapshot: m.snapshot,
						folder: customDataStep(m.snapshot, m.folders.length, [lonely])
					})
				case "a custom step deletes a family":
					return Effect.succeed({
						snapshot: m.snapshot,
						folder: customDataStep(m.snapshot, m.folders.length, family)
					})
				case "a custom step lowers a cap under a child":
					return Effect.succeed({
						snapshot: m.snapshot,
						folder: customDataStep(m.snapshot, m.folders.length, [capped(0)])
					})
				case "a custom step raises a cap":
					return Effect.succeed({
						snapshot: m.snapshot,
						folder: customDataStep(m.snapshot, m.folders.length, [capped(9)])
					})
				case "a draft's step deletes a parent's last child":
					return draftWith("grown", [lonely])
				case "a draft's step raises a cap":
					return draftWith("grown", [capped(9)])
				case "a draft with no data step":
					return draftWith("noted", [])
				case "a draft's generated fill of a column no rule reads":
					return draftWith("memo", [])
				case "a draft's generated fill of a column a rule reads":
					return draftWith("widened", [])
			}
		})()
		const { snapshot, folder } = yield* migrated
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		const outcome = yield* Effect.result(
			apply(migrator, { snapshot, folders: [...m.folders, folder] }, noFurther)
		)
		const refused =
			outcome._tag === "Failure"
				? Arr.map(refusedLaws(m.installation, outcome.failure), (law) =>
						displayOf(m.installation, law)
					)
				: []
		if (outcome._tag === "Failure" && !Arr.isReadonlyArrayNonEmpty(refused)) {
			return assert.fail(`the migration refused naming no law: ${outcome.failure.message}`)
		}
		const toys = `SELECT ${column("Toys", "g")}, ${column("Toys", "p")}, ${column("Toys", "t")}, ${column("Toys", "cap")} FROM ${table("Toys")}`
		const definition = `SELECT y.${column("Toy", "g")}, y.${column("Toy", "p")}, y.${column("Toy", "t")}, a.${column("Parent", "cap")} FROM ${table("Toy")} AS y JOIN ${table("Parent")} AS a ON a.${column("Parent", "g")} = y.${column("Toy", "g")} AND a.${column("Parent", "p")} = y.${column("Toy", "p")}`
		const counted = yield* m.owner.values(
			`SELECT count(*) FROM ((${toys} EXCEPT ${definition}) UNION ALL (${definition} EXCEPT ${toys})) AS d`,
			[]
		)
		const apart = defined(counted[0], "one count")[0]
		return { refused, equal: Number(apart) === 0, applied: outcome._tag === "Success" }
	})

/** The law each case's step breaks, none where it breaks none. */
export const brokenBy: Rec.ReadonlyRecord<Step, string | undefined> = {
	"a custom step deletes a parent's last child": "Childless_none",
	"a custom step deletes a family": undefined,
	"a custom step lowers a cap under a child": "Capped_within",
	"a custom step raises a cap": undefined,
	"a draft's step deletes a parent's last child": "Childless_none",
	"a draft's step raises a cap": undefined,
	"a draft with no data step": undefined,
	"a draft's generated fill of a column no rule reads": undefined,
	"a draft's generated fill of a column a rule reads": "Marked_low"
}
