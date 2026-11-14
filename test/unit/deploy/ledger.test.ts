/**
 * The `<schema>.__migrations` ledger's state as `grizzle migrate` reads it (deploy/ledger/ledger.ts ledgerState),
 * generated: the rows any sequence of applies leaves, in any order the rows statement could return them, and the damage
 * no apply leaves.
 *
 * - **The model:** an apply records each folder in name order, the folder row in the transaction of its first file (or
 *   alone for a folder of no file) and each file's row in that file's own transaction, every row carrying the folder's
 *   source, target and file count. A folder is complete exactly when every one of its files has a row, the latest
 *   target is the last complete folder's (the empty snapshot's before any), and only the last folder may be partial,
 *   since a failed apply stops there. A drafted folder reaches a new snapshot; a custom one keeps its source, and one of
 *   no file completes on its folder row alone.
 * - **Planted damage, refused as MalformedArtifact naming the folder:** a folder's file rows without its folder row; a
 *   partial folder that another folder follows; one row of a folder disagreeing with its folder row on the source, the
 *   target or the file count.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): ledger-folders-in-row-order (the folders read in the order the rows
 * arrived, not by name).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	boolean,
	constant,
	element,
	type Gen,
	increasing,
	int,
	map,
	shuffled,
	weighted,
	type Weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import {
	type LedgerRow,
	type LedgerState,
	ledgerState,
	type RecordedFolder
} from "#compiler/deploy/ledger/ledger.ts"
import { metaFileName } from "#compiler/deploy/render/folder.ts"
import { folderOrdinal } from "#compiler/physical/ddl/ledger.ts"
import { artifactRefusal, assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

interface Folder {
	readonly name: string
	readonly custom: boolean
	/** Its SQL files' ordinals, in order. */
	readonly ordinals: ReadonlyArray<number>
	/** How many of its files completed, from the first: every one but in a partial folder. */
	readonly completed: number
}

/** A disagreeing row's field. */
type Disagreement = "source" | "target" | "files"

/** The damage planted into a ledger's rows, by the index of the folder it damages. */
type Damage =
	| { readonly kind: "none" }
	| { readonly kind: "folder row removed"; readonly folder: number }
	| { readonly kind: "partial before another"; readonly folder: number }
	| {
			readonly kind: "rows disagree"
			readonly folder: number
			readonly row: number
			readonly field: Disagreement
	  }

interface Ledger {
	readonly folders: ReadonlyArray<Folder>
	readonly damage: Damage
	/** The order the rows are read in: a permutation of their indices. */
	readonly order: ReadonlyArray<number>
}

type LedgerFeature =
	| "an empty ledger"
	| "a custom folder of no file"
	| "a custom folder of files"
	| "a partial folder"
	| "a partial folder of its folder row alone"
	| "three complete folders"
	| Exclude<Damage["kind"], "none">
	| `a row disagreeing on its ${Disagreement}`

/** The schema's empty snapshot, the latest target before any folder completes. */
const empty = SchemaFingerprint(Str.repeat(64)("e"))

/** The snapshot the `n`th drafted folder reaches, each apart from every other and from the empty one. */
const reached = (n: number): SchemaFingerprint =>
	SchemaFingerprint(Str.padStart(64, "0")(n.toString(16)))

/** A fingerprint no folder reaches, which a disagreeing row states. */
const stranger = SchemaFingerprint(Str.repeat(64)("f"))

/** A folder's name: its timestamp, `step` seconds into a day, and a name; names sort as the steps do. */
const folderName = (step: number): string => `20261012${Str.padStart(6, "0")(String(step))}_step`

const folderGen =
	(name: string, partial: boolean): Gen<Folder> =>
	(source) => {
		const ordinals = source.draw(increasing(1, 12, { min: partial ? 1 : 0, max: 3 }))
		return {
			name,
			custom: source.draw(boolean),
			ordinals,
			completed: partial ? source.draw(int(0, ordinals.length - 1)) : ordinals.length
		}
	}

/** A folder's place in the chain: the snapshot it starts from and the one it reaches. */
interface Link {
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
}

/** Each folder's link along the chain: a drafted folder reaches its own snapshot, a custom one its source. */
const chained = (folders: ReadonlyArray<Folder>): ReadonlyArray<Link> => {
	const links: Array<Link> = []
	let source = empty
	for (const [i, f] of folders.entries()) {
		const target = f.custom ? source : reached(i + 1)
		links.push({ source, target })
		source = target
	}
	return links
}

/** The folders, each with its link. */
const linked = (
	folders: ReadonlyArray<Folder>
): ReadonlyArray<{ readonly f: Folder; readonly link: Link }> => {
	const links = chained(folders)
	return Arr.map(folders, (f, i) => ({ f, link: defined(links[i], "a folder's link") }))
}

/** The rows an apply leaves for the folders, folder by folder, the folder row first. */
const rowsOf = (folders: ReadonlyArray<Folder>): ReadonlyArray<LedgerRow> =>
	Arr.flatMap(linked(folders), ({ f, link: { source, target } }) => {
		const row = (ordinal: number, file: string): LedgerRow => ({
			folder: f.name,
			ordinal,
			file,
			source,
			target,
			files: f.ordinals.length,
			digest: `${f.name}/${file}`
		})
		return [
			row(folderOrdinal, metaFileName),
			...Arr.map(Arr.take(f.ordinals, f.completed), (o) =>
				row(o, `${Str.padStart(2, "0")(String(o))}-step.sql`)
			)
		]
	})

/** The damage that applies to the folders: a fault and the folder it damages, drawn among those that have one. */
const damageGen = (folders: ReadonlyArray<Folder>): Gen<Damage> => {
	const withFiles = Arr.flatMap(folders, (f, i) => (f.completed > 0 ? [i] : []))
	const followed = Arr.filter(withFiles, (i) => i < folders.length - 1)
	const none: Weighted<Damage> = [3, constant({ kind: "none" })]
	const removed: ReadonlyArray<Weighted<Damage>> = Arr.isReadonlyArrayNonEmpty(withFiles)
		? [
				[1, map(element(withFiles), (folder): Damage => ({ kind: "folder row removed", folder }))],
				[
					1,
					(source): Damage => {
						const folder = source.draw(element(withFiles))
						const f = defined(folders[folder], "a folder with files")
						return {
							kind: "rows disagree",
							folder,
							row: source.draw(int(0, f.completed)),
							field: source.draw(element(["source", "target", "files"] as const))
						}
					}
				]
			]
		: []
	const partial: ReadonlyArray<Weighted<Damage>> = Arr.isReadonlyArrayNonEmpty(followed)
		? [
				[
					1,
					map(element(followed), (folder): Damage => ({ kind: "partial before another", folder }))
				]
			]
		: []
	return weighted([none, ...removed, ...partial])
}

const ledgerGen: Gen<Ledger> = (source) => {
	const steps = source.draw(increasing(0, 59, { min: 0, max: 4 }))
	const partial = steps.length > 0 && source.draw(boolean)
	const folders = Arr.map(steps, (step, i) =>
		source.draw(folderGen(folderName(step), partial && i === steps.length - 1))
	)
	const damage = source.draw(damageGen(folders))
	const rows = Arr.map(rowsOf(folders), (_, i) => i)
	const order = source.draw(shuffled(rows, { min: rows.length, max: rows.length }))
	return { folders, damage, order }
}

/** The rows of the folders with the damage planted, read in the drawn order. */
const plantedRows = (l: Ledger): ReadonlyArray<LedgerRow> => {
	const rows = rowsOf(l.folders)
	const named = (folder: number): string => defined(l.folders[folder], "a damaged folder").name
	const damaged = ((): ReadonlyArray<LedgerRow> => {
		const d = l.damage
		switch (d.kind) {
			case "none":
				return rows
			case "folder row removed":
				return Arr.filter(
					rows,
					(r) => !(r.folder === named(d.folder) && r.ordinal === folderOrdinal)
				)
			case "partial before another": {
				const last = Arr.findLastIndex(rows, (r) => r.folder === named(d.folder))
				return Option.match(last, { onNone: () => rows, onSome: (at) => Arr.remove(rows, at) })
			}
			case "rows disagree": {
				const at = Arr.findFirstIndex(rows, (r) => r.folder === named(d.folder))
				return Option.match(at, {
					onNone: () => rows,
					onSome: (first) =>
						Option.getOrElse(
							Arr.modify(rows, first + d.row, (r): LedgerRow => {
								switch (d.field) {
									case "source":
										return { ...r, source: stranger }
									case "target":
										return { ...r, target: stranger }
									case "files":
										return { ...r, files: r.files + 1 }
								}
							}),
							() => rows
						)
				})
			}
		}
	})()
	return Arr.getSomes(Arr.map(l.order, (i) => Arr.get(damaged, i)))
}

/** What the model says an undamaged ledger's state is, folder by folder. */
const modelState = (folders: ReadonlyArray<Folder>): LedgerState => {
	const recorded = Arr.map(linked(folders), ({ f, link: { source, target } }) => {
		const folder: RecordedFolder = {
			folder: f.name,
			source,
			target,
			files: f.ordinals.length,
			meta: `${f.name}/${metaFileName}`,
			completed: Arr.map(Arr.take(f.ordinals, f.completed), (o) => {
				const file = `${Str.padStart(2, "0")(String(o))}-step.sql`
				return { ordinal: o, file, digest: `${f.name}/${file}` }
			})
		}
		return { folder, complete: f.completed === f.ordinals.length }
	})
	const complete = Arr.map(
		Arr.filter(recorded, (r) => r.complete),
		(r) => r.folder
	)
	return {
		latest: Option.match(Arr.last(complete), { onNone: () => empty, onSome: (f) => f.target }),
		complete,
		partial: Option.getOrUndefined(
			Option.map(
				Arr.findFirst(recorded, (r) => !r.complete),
				(r) => r.folder
			)
		)
	}
}

const notesOf = (l: Ledger): ReadonlyArray<LedgerFeature> => {
	const d = l.damage
	if (d.kind !== "none") {
		return d.kind === "rows disagree" ? [d.kind, `a row disagreeing on its ${d.field}`] : [d.kind]
	}
	const partial = Arr.findFirst(l.folders, (f) => f.completed < f.ordinals.length)
	return Arr.flatMap(
		[
			["an empty ledger", l.folders.length === 0],
			[
				"a custom folder of no file",
				Arr.some(l.folders, (f) => f.custom && f.ordinals.length === 0)
			],
			["a custom folder of files", Arr.some(l.folders, (f) => f.custom && f.ordinals.length > 0)],
			["a partial folder", Option.isSome(partial)],
			[
				"a partial folder of its folder row alone",
				Option.exists(partial, (f) => f.completed === 0)
			],
			["three complete folders", l.folders.length - (Option.isSome(partial) ? 1 : 0) >= 3]
		] satisfies ReadonlyArray<readonly [LedgerFeature, boolean]>,
		([feature, holds]) => (holds ? [feature] : [])
	)
}

describe("the ledger's state", () => {
	it.effect(
		"is the model's for every ledger an apply leaves, in any row order, and refuses every damage no apply leaves, naming its folder",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/ledger-state",
						draw: drawn(ledgerGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "a model of what each apply records, folder by folder, and the damage planted into its rows"
						},
						coverage: required<LedgerFeature>(
							[
								"an empty ledger",
								"a custom folder of no file",
								"a custom folder of files",
								"a partial folder",
								"a partial folder of its folder row alone",
								"three complete folders",
								"folder row removed",
								"partial before another",
								"a row disagreeing on its source",
								"a row disagreeing on its target",
								"a row disagreeing on its files"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(l, c) =>
						Effect.sync(() => {
							c.noteAll(notesOf(l))
							const read = ledgerState(plantedRows(l), empty)
							const d = l.damage
							if (d.kind === "none") {
								assert.deepEqual(succeeded(read), modelState(l.folders))
								return
							}
							const refusal = artifactRefusal(refused(read, "MalformedArtifact"))
							assert.deepEqual(
								[refusal.artifact, refusal.at],
								["ledger", [defined(l.folders[d.folder], "the damaged folder").name]],
								"the refusal names the damaged folder"
							)
						})
				)
			)
	)
})
