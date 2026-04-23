// This file starts empty. ClawBus is asked to add a `slugify` function.
//
// Spec (ClawBus reads from this comment):
//   slugify(input: string): string
//   - lowercase the input
//   - replace any run of non-alphanumeric characters with a single "-"
//   - trim leading/trailing "-"
//   Examples:
//     slugify("Hello World")           -> "hello-world"
//     slugify("  Foo--Bar !!  ")       -> "foo-bar"
//     slugify("Привет")                 -> "" (no ASCII alphanumeric)
//     slugify("v4.7-beta+build")       -> "v4-7-beta-build"

/**
 * Converts a string into a URL-friendly slug.
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
