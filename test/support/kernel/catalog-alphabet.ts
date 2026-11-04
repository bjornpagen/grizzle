import { Array as Arr, Effect, String as Str } from "effect"
import { pgPin } from "#test/support/env.ts"
import { fileText } from "#test/support/files.ts"

/**
 * The alphabet of the names PostgreSQL itself holds where grizzle writes names: every type and function of pg_catalog
 * and of the vector extension, read from the pinned build (scripts/pg/pin.env), never written by hand, so a repin's new
 * builtin name is drawn with no list to update.
 *
 * pg_catalog's are the rows of pg_type and pg_proc in the build's bootstrap catalog (share/postgres.bki, the data
 * initdb loads): each `insert ( <oid> <name> ... )` between `create pg_type` / `create pg_proc` and its `close`. The
 * vector extension's are the types and functions its pinned install script creates
 * (share/extension/vector--<version>.sql): each `CREATE TYPE <name>` and `CREATE FUNCTION <name>(`.
 */

/** The second field of each `insert` row of the bootstrap catalog `catalog`: its name column, after its oid. */
const bootstrapNames = (bki: string, catalog: string): ReadonlyArray<string> => {
	const names: Array<string> = []
	let inside = false
	for (const line of Str.split(bki, "\n")) {
		const words = Arr.filter(Str.split(Str.trim(line), " "), (w) => w !== "")
		const [first, second, , name] = words
		if (first === "create") {
			inside = second === catalog
		} else if (first === "close") {
			inside = false
		} else if (inside && first === "insert" && name !== undefined) {
			names.push(name)
		}
	}
	return names
}

/** The name each of a script's `CREATE <kind> <name>` lines creates: `CREATE TYPE <name>`, `CREATE FUNCTION <name>(`. */
const scriptNames = (script: string, created: "TYPE" | "FUNCTION"): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(script, "\n"), (line) => {
		const words = Arr.filter(Str.split(Str.trim(line), " "), (w) => w !== "")
		const [create, kind, named] = words
		if (create !== "CREATE" || named === undefined || kind !== created) {
			return []
		}
		const [name] = Str.split(Str.replaceAll(";", "")(named), "(")
		return name === undefined || name === "" ? [] : [name]
	})

const share = `${pgPin.prefix}/share`

const [bki, vectorScript] = await Effect.runPromise(
	Effect.all([
		fileText(`${share}/postgres.bki`),
		fileText(`${share}/extension/vector--${pgPin.vectorVersion}.sql`)
	])
)

/** Every distinct type name of pg_catalog and the vector extension, in first-seen order. */
export const catalogTypeAlphabet: ReadonlyArray<string> = Arr.dedupe([
	...bootstrapNames(bki, "pg_type"),
	...scriptNames(vectorScript, "TYPE")
])

/** Every distinct type and function name of pg_catalog and the vector extension, in first-seen order. */
export const catalogAlphabet: ReadonlyArray<string> = Arr.dedupe([
	...catalogTypeAlphabet,
	...bootstrapNames(bki, "pg_proc"),
	...scriptNames(vectorScript, "FUNCTION")
])
