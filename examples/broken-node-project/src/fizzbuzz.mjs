/**
 * Classic fizzbuzz — but the implementation has a bug.
 * ClawBus's Planner/Worker/Approval loop is expected to find and fix it.
 *
 * Spec:
 *   - Multiples of 15 → "FizzBuzz"
 *   - Multiples of 3  → "Fizz"
 *   - Multiples of 5  → "Buzz"
 *   - Otherwise       → the number as a string
 */
export function fizzbuzz(n) {
  // BUG: the order of these branches is wrong. `n % 3 === 0` fires before
  // `n % 15 === 0`, so 15, 30, 45, ... return "Fizz" instead of "FizzBuzz".
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  if (n % 15 === 0) return "FizzBuzz";
  return String(n);
}
