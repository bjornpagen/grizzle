import { Array as Arr, String as Str } from "effect"

/**
 * Whether a path of the superlint options, relative to `root` (the repository's, or the fixtures' for a fixture run),
 * names a file or lies above it. A path that ends in "/" names a directory and holds every file beneath it; any other
 * path names one file. Both are matched from `root` itself, so `scripts/` is the root's scripts directory and never a
 * package's of the same name, and case-insensitively, since the checker keys a declaration's file by a path it may fold
 * to lower case.
 */
const isAt =
	(root: string, fileName: string) =>
	(path: string): boolean => {
		const file = Str.toLowerCase(fileName)
		const named = Str.toLowerCase(`${root}/${path}`)
		return Str.endsWith("/")(path) ? Str.startsWith(named)(file) : file === named
	}

/** Whether any of the paths, relative to `root`, names the file or a directory above it. */
export const isAtAny = (root: string, paths: ReadonlyArray<string>, fileName: string): boolean =>
	Arr.some(paths, isAt(root, fileName))

/**
 * Whether a declaration's file is a module of an installed package: under `node_modules/<package>/`, its name before
 * the first dot `<module>` (`effect/dist/Duration.d.ts` is effect's Duration, `@types/node/process.d.ts` is
 * @types/node's process). The checker keys a declaration's file by a path it may fold to lower case, so names compare
 * case-insensitively.
 */
export const isPackageModule = (
	path: string,
	target: Readonly<{ package: string; module: string }>
): boolean => {
	const folded = Str.toLowerCase(path)
	if (!Str.includes(`/node_modules/${Str.toLowerCase(target.package)}/`)(folded)) {
		return false
	}
	const name = Arr.lastNonEmpty(Str.split("/")(folded))
	const [stem] = Str.split(".")(name)
	return stem === Str.toLowerCase(target.module)
}

/** Whether a declaration's file is a repository module, by its repository-relative path, compared as
 * isPackageModule compares. */
export const isRepositoryModule = (path: string, module: string): boolean =>
	Str.endsWith(`/${Str.toLowerCase(module)}`)(Str.toLowerCase(path))

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
