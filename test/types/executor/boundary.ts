import { Array as Arr, Effect } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The executor's boundary: a program that runs is compiled over a plan an installation stands behind, ParamSource
 * `planned` or `recorded` (program/schema.ts InstalledSource), and never over an `unserved` one, which names a pattern
 * parameter's own domain where no installation installs it. The types hold it: a role's artifacts and a login's are
 * InstalledArtifacts (adapter/served/role.ts RoleContext; adapter/served/login.ts loginRoles), runtimeEntry takes the servable form of a ChangeEntry compiled over them (program/workload/change.ts
 * servableEntry, ServableEntry), and runWrite's input, a WriteEntry, is minted by
 * that door or by a served file's load (adapter/apply/compile.ts installedEntry, adapter/served/load.ts loadedEntry)
 * alone; and a bench gate's compiled query, which the gate runner runs, holds InstalledArtifacts
 * (bench/query/support/kit.ts Compiled).
 *
 * The box, exhausted and printed as one program the type batch checks disarmed: every source a harness has handed
 * baseArtifacts (a planned source, a recorded one, `unserved` written out, the `unserved` constant, and a source of any
 * kind), by every door a compiled program passes on its way to a run (a role's artifacts, a login's, a bench
 * gate's compiled query's, and runWrite over runtimeEntry over servableEntry over compileParsed over the artifacts, as a
 * role's compile of a ChangeSet passes it, adapter/served/forms.ts writeEntry); and an entry's parts
 * passed to runWrite, unminted and minted by loadedEntry.
 *
 * The oracle: a probe compiles exactly when its source is one an installation stands behind, and an entry exactly when
 * a door minted it. Each refused probe stands under a `refused` directive: the contract is that it does not compile,
 * whichever diagnostic the checker elaborates it to.
 */

/** A source of a plan's parameter types, as the program spells it, and whether an installation stands behind it. */
interface Source {
	readonly name: string
	readonly text: string
	readonly installed: boolean
}

const sources: Arr.NonEmptyReadonlyArray<Source> = [
	{ name: "a planned source", text: '{ kind: "planned", types: noServedTypes }', installed: true },
	{
		name: "a recorded source",
		text: '{ kind: "recorded", installed: recordedParams }',
		installed: true
	},
	{ name: "unserved written out", text: '{ kind: "unserved" }', installed: false },
	{ name: "the unserved constant", text: "unserved", installed: false },
	{ name: "a source of any kind", text: "anySource", installed: false }
]

/** A door a compiled program passes on its way to a run: the probe that hands it the artifacts over `source`. */
interface Door {
	readonly name: string
	readonly probe: (source: string, index: number) => string
}

const artifactsOver = (source: string): string => `value(baseArtifacts(basis, ${source}))`

const doors: Arr.NonEmptyReadonlyArray<Door> = [
	{
		name: "a role's artifacts",
		probe: (source, i) =>
			`export const role${i}: RoleContext = { ...role, artifacts: ${artifactsOver(source)} }`
	},
	{
		name: "a bench gate's compiled query",
		probe: (source, i) =>
			`export const bench${i}: Compiled = { ...benchCompiled, artifacts: ${artifactsOver(source)} }`
	},
	{
		name: "a login's artifacts",
		probe: (source, i) =>
			`export const login${i} = loginRoles(loginArgs[0], loginArgs[1], ${artifactsOver(source)}, loginArgs[3], loginArgs[4])`
	},
	{
		name: "runWrite over runtimeEntry",
		probe: (source, i) =>
			`export const run${i} = runWrite(runArgs[0], runArgs[1], runtimeEntry(servableEntry(value(compileParsed(${artifactsOver(source)}, ...parsedRest))), ...entryRest), runArgs[3], runArgs[4])`
	}
]

/** One probe of the box: a source through a door. */
interface Probe {
	readonly source: Source
	readonly door: Door
}

const probes: Arr.NonEmptyReadonlyArray<Probe> = Arr.flatMap(sources, (source) =>
	Arr.map(doors, (door): Probe => ({ source, door }))
)

/** A probe as the program states it, under a `refused` directive where its source has no installation behind it. */
const probeBlock = (p: Probe, index: number): ReadonlyArray<string> => [
	`// ${p.source.name}, through ${p.door.name}`,
	...(p.source.installed
		? []
		: [`// @ts-expect-error -- refused: ${p.source.name} reaches ${p.door.name}`]),
	p.door.probe(p.source.text, index)
]

/** A cell of the box: a probe, or an entry's parts reaching runWrite, minted by a served file's load or by no door. */
type BoundaryCell =
	| Readonly<{ kind: "probe"; probe: Probe }>
	| Readonly<{ kind: "entry"; minted: boolean }>

/** The cells of boundaryBox, minted as a dictionary in its door (test/types/executor/boundary.dictionary.ts). */
export const boundaryBoxItems: Arr.NonEmptyReadonlyArray<BoundaryCell> = [
	...Arr.map(probes, (probe): BoundaryCell => ({ kind: "probe", probe })),
	{ kind: "entry", minted: false },
	{ kind: "entry", minted: true }
]

/** A cell's lines. */
const cellLines = (cell: BoundaryCell, index: number): ReadonlyArray<string> => {
	switch (cell.kind) {
		case "probe":
			return probeBlock(cell.probe, index)
		case "entry":
			return cell.minted
				? [
						"// an entry's parts a served file's load minted",
						`export const loaded${index} = runWrite(runArgs[0], runArgs[1], loadedEntry(parts), runArgs[3], runArgs[4])`
					]
				: [
						"// an entry's parts no door minted",
						"// @ts-expect-error -- refused: an entry no door minted reaches runWrite",
						`export const unminted${index} = runWrite(runArgs[0], runArgs[1], parts, runArgs[3], runArgs[4])`
					]
	}
}

/** The program's prelude (test/support/programs/executor.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/executor.ts"))

/** What every probe hands its door, the batch's own. */
const boundaryHeader: ReadonlyArray<string> = [
	"export declare const basis: PlanBasis",
	"export declare const recordedParams: InstalledParams",
	"export declare const anySource: ParamSource",
	"export declare const role: RoleContext",
	"export declare const loginArgs: Parameters<typeof loginRoles>",
	"export declare const benchCompiled: Compiled",
	"type Tail<T extends ReadonlyArray<unknown>> = T extends readonly [unknown, ...infer R] ? R : never",
	"export declare const parsedRest: Tail<Parameters<typeof compileParsed>>",
	"export declare const entryRest: Tail<Parameters<typeof runtimeEntry>>",
	"export declare const runArgs: Parameters<typeof runWrite<unknown>>",
	"export declare const parts: WriteEntryParts",
	"export declare const value: <A>(result: { readonly ok: true; readonly value: A } | { readonly ok: false }) => A",
	""
]

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const boundaryProgram = (
	cells: Arr.NonEmptyReadonlyArray<BoundaryCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/executor/boundary.ts: sources through the doors to a run.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: boundaryHeader },
			...Arr.map(cells, (cell, at) => ({
				owner: caseOwned(at),
				lines: [...cellLines(cell, at), ""]
			}))
		]
	)
]
