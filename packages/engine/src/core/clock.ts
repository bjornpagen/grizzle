/**
 * The units a reading of the database's clock counts since the Unix epoch, floored: `micros`, PostgreSQL's own
 * resolution, the exact reading; `millis`, the unit of JavaScript's Date and Effect's DateTime.
 */
export const clockUnits = ["micros", "millis"] as const
export type ClockUnit = (typeof clockUnits)[number]

/** Whether a value is the name of a clock unit (clockUnits). */
export const isClockUnit = (value: unknown): value is ClockUnit =>
	value === "micros" || value === "millis"
