export const Bare = () => <svg viewBox="0 0 1 1" /> // violation
export const Late = () => <svg viewBox="0 0 1 1"><path d="M0 0" /><title>Late</title></svg> // violation
export const Empty = () => <svg viewBox="0 0 1 1"><title></title></svg> // violation
export const Unnamed = () => <svg role="img" viewBox="0 0 1 1" /> // violation
export const Titled = () => <svg viewBox="0 0 1 1"><title>Logo</title></svg>
export const Hidden = () => <svg aria-hidden="true" viewBox="0 0 1 1" />
export const Named = () => <svg role="img" aria-label="Logo" viewBox="0 0 1 1" />
