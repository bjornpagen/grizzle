const accent = "#ff0000" // violation
const quiet = "none"

export function PaintFixture({ on }: Readonly<{ on: boolean }>) {
	return (
		<svg viewBox="0 0 1 1">
			<path
				fill="red" // violation
				stroke={accent}
			/>
			<circle
				fill={on ? "var(--color-primary)" : quiet} // violation
			/>
			<stop
				stopColor="oklch(0.5 0.1 100)" // violation
			/>
			<rect fill="url(#gradient)" stroke="currentColor" />
			<rect fill="none" stroke="transparent" />
		</svg>
	)
}
