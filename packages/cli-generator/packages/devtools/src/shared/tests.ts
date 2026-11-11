import { Array as Arr, String as Str } from "effect"

/** Test files, by their suffix alone: the test rules hold there, and only there module state is a test's own. */
export const TEST_SUFFIXES: ReadonlyArray<string> = [".test.ts", ".test.tsx"]

export const isTestFile = (file: string): boolean =>
	Arr.some(TEST_SUFFIXES, (suffix) => Str.endsWith(suffix)(file))
