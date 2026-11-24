const assert = require('node:assert/strict');
const { fizzbuzz } = require('./fizzbuzz');

const cases = [
  [1, '1'],
  [2, '2'],
  [3, 'Fizz'],
  [4, '4'],
  [5, 'Buzz'],
  [6, 'Fizz'],
  [10, 'Buzz'],
  [15, 'FizzBuzz'],
  [30, 'FizzBuzz'],
  [0, 'FizzBuzz'],
  [-1, '-1'],
  [-3, 'Fizz'],
  [-5, 'Buzz'],
  [-15, 'FizzBuzz'],
];

for (const [input, expected] of cases) {
  assert.equal(fizzbuzz(input), expected, `fizzbuzz(${input}) should be ${expected}`);
}

console.log(`All ${cases.length} fizzbuzz tests passed.`);
