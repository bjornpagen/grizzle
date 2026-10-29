/**
 * A value as the list it is. Array.isArray narrows `unknown` to `any[]`, which would let an untyped element flow on;
 * this narrows it to a list of unknown elements, each of which its reader then checks.
 */
import { Array as Arr } from "effect"
export const isList = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)
