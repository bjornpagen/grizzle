import { Array as Arr, Effect } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The generic-role programs: a ChangeSet over a level taken over a role by ChangeSet.over, the role given built, or as a
 * parameter, `<W extends Bound>(role: W) => ChangeSet.over(role, program)`, its bound the least level the program needs,
 * `RoleOver<typeof Root>` or `RoleOver<typeof Graded>`, or the weakest, AnyRole, instantiated over each role. Each cell
 * is printed into one program the type batch checks.
 *
 * The oracle is the level rule the engine holds ChangeSet.over to, computed here apart from the types (`overVerdict`):
 * a ChangeSet is taken over a role exactly where its schema is one of the role's levels, a full role's base and every
 * level below it, a role holding a lower level whole that level and every one below it. A parameter's call knows its
 * bound's least level alone, so it is refused there where the program's schema is none of that level's levels, and
 * every call over AnyRole, which knows none; its instantiation admits exactly the roles that hold the bound's level
 * whole, every relation of it under its own name (RoleOver). Where a cell is admitted, its ChangeSet is over the role
 * itself: it is a ChangeSet of the role, writing the program's relation.
 */

/** How the role is given: built, or a parameter bounded by the level its program needs, or by AnyRole. */
export type Given = "built" | "RoleOver<Root>" | "RoleOver<Graded>" | "AnyRole"

/** The level the program is written over: Root, or Graded over it. */
export type ProgramLevel = "Root" | "Graded"

/**
 * The role the ChangeSet is taken over: RootWriter and GradedWriter, full roles over Root and Graded; SittingWriter, a
 * role over Graded holding Root's relations alone, whose levels are Root's; ElsewhereWriter, a full role over a schema
 * of which neither is a level.
 */
export type RoleName = "RootWriter" | "GradedWriter" | "SittingWriter" | "ElsewhereWriter"

/** A cell: a program over one level, taken over one role given one way. */
export interface GenericRoleCell {
	readonly given: Given
	readonly program: ProgramLevel
	readonly role: RoleName
}

const givens: Arr.NonEmptyReadonlyArray<Given> = [
	"built",
	"RoleOver<Root>",
	"RoleOver<Graded>",
	"AnyRole"
]
const programs: Arr.NonEmptyReadonlyArray<ProgramLevel> = ["Root", "Graded"]
const roles: Arr.NonEmptyReadonlyArray<RoleName> = [
	"RootWriter",
	"GradedWriter",
	"SittingWriter",
	"ElsewhereWriter"
]

/**
 * The cells of genericRoleBox, minted as a dictionary in its door (test/types/changeset/generic-role.dictionary.ts):
 * every way of giving the role, program level and role.
 */
export const genericRoleBoxItems: Arr.NonEmptyReadonlyArray<GenericRoleCell> = Arr.flatMap(
	givens,
	(given) =>
		Arr.flatMap(programs, (program) =>
			Arr.map(roles, (role): GenericRoleCell => ({ given, program, role }))
		)
)

/** What a line is refused by: a named refusal, a refusal the checker states as no named one, or none. */
type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refusal"; readonly refusal: Refused }
	| { readonly kind: "refused"; readonly why: string }

const admitted: Verdict = { kind: "admitted" }
const notALevel: Verdict = {
	kind: "refusal",
	refusal: "ChangeSet.over takes a ChangeSet over a level of its role"
}

/** A level's levels: itself and every level below it. */
const levelsOfLevel = (level: ProgramLevel): ReadonlySet<ProgramLevel> =>
	new Set<ProgramLevel>(level === "Graded" ? ["Graded", "Root"] : ["Root"])

/** A role's levels among the programs' (the role itself aside): its full base's, none for ElsewhereWriter's. */
const levelsOfRole = (role: RoleName): ReadonlySet<ProgramLevel> => {
	switch (role) {
		case "RootWriter":
		case "SittingWriter":
			return levelsOfLevel("Root")
		case "GradedWriter":
			return levelsOfLevel("Graded")
		case "ElsewhereWriter":
			return new Set()
	}
}

/** Whether a role holds a level whole, every relation of it under its own name: what RoleOver bounds a parameter by. */
const holdsWhole = (role: RoleName, level: ProgramLevel): boolean => levelsOfRole(role).has(level)

/** The verdict of a ChangeSet over `program` taken over a role whose levels are `levels`. */
const overVerdict = (program: ProgramLevel, levels: ReadonlySet<ProgramLevel>): Verdict =>
	levels.has(program) ? admitted : notALevel

/** The bound's least level, none for AnyRole. */
const boundLevel = (given: Exclude<Given, "built">): ProgramLevel | undefined => {
	switch (given) {
		case "RoleOver<Root>":
			return "Root"
		case "RoleOver<Graded>":
			return "Graded"
		case "AnyRole":
			return undefined
	}
}

/** The verdict at a parameter's call: the program over the bound's least level, refused over AnyRole, which knows none. */
const callVerdict = (given: Exclude<Given, "built">, program: ProgramLevel): Verdict => {
	const level = boundLevel(given)
	return level === undefined
		? { kind: "refused", why: "a role parameter bounded by AnyRole, of which no level is known" }
		: overVerdict(program, levelsOfLevel(level))
}

/** The verdict at a parameter's instantiation: the role holds the bound's level whole (RoleOver). */
const instantiationVerdict = (given: Exclude<Given, "built">, role: RoleName): Verdict => {
	const level = boundLevel(given)
	return level === undefined || holdsWhole(role, level)
		? admitted
		: { kind: "refused", why: `${role} holds no relation of ${level} whole under its name` }
}

/** A directive for a line the verdict refuses, none for one it admits. */
const directive = (verdict: Verdict, why: string): ReadonlyArray<string> => {
	switch (verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${why}, ${verdict.why}`]
	}
}

/** The program over each level, and the relation it writes. */
const programOf = (level: ProgramLevel): { readonly name: string; readonly writes: string } =>
	level === "Root"
		? { name: "overRoot", writes: "Sitting" }
		: { name: "overGraded", writes: "Gradebook" }

/** The probe that an admitted ChangeSet is over the role itself: a ChangeSet of the role writing the program's relation. */
const ofRole = (at: number, c: GenericRoleCell): string =>
	`export const ofRole${at}: ChangeSet<typeof ${c.role}, unknown, "${programOf(c.program).writes}"> = over${at}`

/**
 * A cell's lines: a built role's call, refused where the program's level is none of the role's; or a parameter's call,
 * refused by its bound's verdict, and, where admitted, its instantiation over the role, refused where the role holds the
 * bound's level not whole; and, where the ChangeSet is admitted, the probe that it is over the role.
 */
const cellLines = (c: GenericRoleCell, at: number): ReadonlyArray<string> => {
	const program = programOf(c.program).name
	if (c.given === "built") {
		const verdict = overVerdict(c.program, levelsOfRole(c.role))
		return [
			`// ${c.program}'s program taken over ${c.role}, built`,
			...directive(verdict, "the built role's call"),
			`export const over${at} = ChangeSet.over(${c.role}, ${program})`,
			...(verdict.kind === "admitted" ? [ofRole(at, c)] : []),
			""
		]
	}
	const bound = c.given === "AnyRole" ? "AnyRole" : `RoleOver<typeof ${boundLevel(c.given)}>`
	const call = callVerdict(c.given, c.program)
	const instantiation = instantiationVerdict(c.given, c.role)
	return [
		`// ${c.program}'s program taken over a role parameter bounded by ${c.given}, instantiated over ${c.role}`,
		...directive(call, "the parameter's call"),
		`export const of${at} = <W extends ${bound}>(role: W) => ChangeSet.over(role, ${program})`,
		...(call.kind === "admitted"
			? [
					...directive(instantiation, "the instantiation"),
					`export const over${at} = of${at}(${c.role})`,
					...(instantiation.kind === "admitted" ? [ofRole(at, c)] : [])
				]
			: []),
		""
	]
}

/**
 * The schema every cell reads: Root, holding Sitting; Graded over it, holding Gradebook; Elsewhere, a schema of its own
 * holding Note; a full role over each, and SittingWriter, a role over Graded holding Sitting alone; a program over Root
 * writing Sitting and one over Graded writing Gradebook. Beside them, a schema taken as a role, refused: it is no role.
 */
const genericRoleHeader = (): ReadonlyArray<string> => [
	'export const Sitting = relation("Sitting", { number: natural }, ["number"])',
	'export const Root = schema("Root", [Sitting], [])',
	'export const Gradebook = relation("Gradebook", { number: natural }, ["number"])',
	'export const Graded = schema.extend([Root], "Graded", [Gradebook], [])',
	'export const Note = relation("Note", { number: natural }, ["number"])',
	'export const Elsewhere = schema("Elsewhere", [Note], [])',
	'export const RootWriter = role(Root, "root_writer", wholeEntriesOf(Root), { insert: ["Sitting"] })',
	'export const GradedWriter = role(Graded, "graded_writer", wholeEntriesOf(Graded), { insert: ["Sitting", "Gradebook"] })',
	'export const SittingWriter = role(Graded, "sitting_writer", { Sitting }, { insert: ["Sitting"] })',
	'export const ElsewhereWriter = role(Elsewhere, "elsewhere_writer", wholeEntriesOf(Elsewhere), { insert: ["Note"] })',
	"export const overRoot = ChangeSet.empty(Root).insert(Sitting, [])",
	"export const overGraded = ChangeSet.empty(Graded).insert(Gradebook, [])",
	"// @ts-expect-error -- refused: a schema taken over itself as a role, which it is not",
	"export const overSchema = ChangeSet.over(Root, overRoot)",
	""
]

/** The program's prelude (test/support/programs/generic-role.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/generic-role.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const genericRoleProgram = (
	cells: Arr.NonEmptyReadonlyArray<GenericRoleCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/changeset/generic-role.ts: a ChangeSet over a level taken over a role, built or a parameter.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: genericRoleHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
