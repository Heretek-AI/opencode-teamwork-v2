const test = require('node:test');
const assert = require('node:assert/strict');
const { fizzbuzz } = require('./fizzbuzz');

test('returns number as string when not divisible by 3 or 5', () => {
  assert.equal(fizzbuzz(1), '1');
  assert.equal(fizzbuzz(2), '2');
  assert.equal(fizzbuzz(7), '7');
});

test('returns Fizz for multiples of 3', () => {
  assert.equal(fizzbuzz(3), 'Fizz');
  assert.equal(fizzbuzz(6), 'Fizz');
  assert.equal(fizzbuzz(9), 'Fizz');
});

test('returns Buzz for multiples of 5', () => {
  assert.equal(fizzbuzz(5), 'Buzz');
  assert.equal(fizzbuzz(10), 'Buzz');
  assert.equal(fizzbuzz(20), 'Buzz');
});

test('returns FizzBuzz for multiples of 15', () => {
  assert.equal(fizzbuzz(15), 'FizzBuzz');
  assert.equal(fizzbuzz(30), 'FizzBuzz');
  assert.equal(fizzbuzz(0), 'FizzBuzz');
});
