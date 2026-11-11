import { Array as Arr, String as Str } from "effect"

/**
 * Whether a repository-relative path in the superlint options names a file or lies above it. A path that ends in "/"
 * names a directory and holds every file beneath it; any other path names one file. Both are matched against the
 * file's absolute name at a "/" boundary, since a rule knows the file but not the repository root.
 */
export const isAt =
	(fileName: string) =>
	(path: string): boolean =>
		Str.endsWith("/")(path)
			? Str.includes(`/${path}`)(fileName)
			: Str.endsWith(`/${path}`)(fileName)

/** Whether any of the paths names the file or a directory above it. */
export const isAtAny = (paths: ReadonlyArray<string>, fileName: string): boolean =>
	Arr.some(paths, isAt(fileName))

/** The directories above a file, nearest first; the root directory is the empty name. */
export const directoriesAbove = (fileName: string): ReadonlyArray<string> => {
	const segments = Str.split("/")(fileName)
	return Arr.makeBy(segments.length - 1, (index) =>
		Arr.join(Arr.take(segments, segments.length - 1 - index), "/")
	)
}

/** The smallest name a default library file has: `lib.` and `.d.ts` around at least one character. */
const SHORTEST_LIBRARY_NAME = "lib.x.d.ts".length

/** TypeScript's default library, wherever the compiler package is installed: `lib.es5.d.ts` and its siblings in the
 * `lib` directory of `typescript` or of a platform package under `@typescript`. */
export const isDefaultLibraryPath = (file: string): boolean => {
	const [name, directory, owner, scope, above] = Arr.reverse(Str.split("/")(file))
	if (
		directory !== "lib" ||
		name.length < SHORTEST_LIBRARY_NAME ||
		!Str.startsWith("lib.")(name) ||
		!Str.endsWith(".d.ts")(name)
	) {
		return false
	}
	return (
		(owner === "typescript" && scope === "node_modules") ||
		(owner !== undefined && scope === "@typescript" && above === "node_modules")
	)
}
