'use strict';
const cfg = require('../config');
function gauss(min, max) {
  let u = 0, v = 0;
  while (!u) u = Math.random(); while (!v) v = Math.random();
  let n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  n = Math.max(0, Math.min(1, n / 10 + 0.5));
  return min + n * (max - min);
}
const sleep  = (min = cfg.delay.min, max = cfg.delay.max) => new Promise(r => setTimeout(r, Math.round(gauss(min, max))));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
module.exports = { sleep, randInt, gauss };
