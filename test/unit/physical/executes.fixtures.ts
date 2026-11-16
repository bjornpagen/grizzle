/** What the properties of executes.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Order } from "effect"

export type Feature =
	| "a constant only a written table's casts reach"
	| "a role that writes nothing"
	| "two roles"

export const sorted = (xs: Iterable<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)
