declare const column: string
export const quoted = "SELECT 'a::b' AS \"c::d\""
export const commented = "SELECT 1 -- x::text"
export const block = "SELECT /* x::text /* nested */ y::int */ 1"
export const dollar = "DO $tag$ x::text $tag$"
export const doubled = "SELECT 'it''s::fine'"
export const parameter = "$1 is a parameter, not a quote"
export const prose = `the column ${column} holds a value`
