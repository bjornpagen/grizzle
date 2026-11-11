import type { SourceLoc } from "#compiler/core/loc.ts"

/**
 * Where a location is, as a refusal's contract names it: its label and its path, never its call site, which is where
 * a builder happened to run, and never its printed text, which formats the two.
 */
export type Place = Readonly<{ label: string; path: ReadonlyArray<string | number> }>

/** The place of a location. */
export const placeOf = (loc: SourceLoc): Place => ({ label: loc.label, path: loc.path })
