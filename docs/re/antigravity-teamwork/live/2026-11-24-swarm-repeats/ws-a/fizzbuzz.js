/**
 * Return the FizzBuzz string for a given number.
 * @param {number} n
 * @returns {string}
 */
function fizzbuzz(n) {
  if (n % 15 === 0) return 'FizzBuzz';
  if (n % 3 === 0) return 'Fizz';
  if (n % 5 === 0) return 'Buzz';
  return String(n);
}

module.exports = { fizzbuzz };
