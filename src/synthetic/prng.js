// src/synthetic/prng.js
//
// Tiny seeded PRNG (mulberry32) so the synthetic batch is reproducible run
// to run — same seed always produces the same records, same ground truth,
// same demo. That matters for a live pitch: no surprise record counts.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    float: () => rand(),
    int: (min, max) => Math.floor(rand() * (max - min + 1)) + min, // inclusive
    choice: (arr) => arr[Math.floor(rand() * arr.length)],
    bool: (pTrue = 0.5) => rand() < pTrue,
    // pick a case type from a weighted distribution, e.g. [['CLEAN', 0.45], ...]
    weighted: (weights) => {
      const r = rand();
      let cum = 0;
      for (const [key, w] of weights) {
        cum += w;
        if (r <= cum) return key;
      }
      return weights[weights.length - 1][0];
    },
  };
}

module.exports = { makeRng };
