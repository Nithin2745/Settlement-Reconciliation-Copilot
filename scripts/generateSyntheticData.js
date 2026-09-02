// scripts/generateSyntheticData.js
//
// Day 2 CLI: generates the synthetic bank statement + ledger (+ internal
// ground truth) and writes them to fixtures/synthetic/. Re-run any time —
// it's deterministic for a given seed, so the demo dataset never drifts.
//
// Usage:
//   node scripts/generateSyntheticData.js        # size=120, seed=42
//   node scripts/generateSyntheticData.js 200 7  # size=200, seed=7

const fs = require('fs');
const path = require('path');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');

const size = parseInt(process.argv[2], 10) || 120;
const seed = parseInt(process.argv[3], 10) || 42;

const { settlementRecon, bankStatement, ledger, groundTruth } = generateSyntheticBatch({
  size,
  seed,
});

const outDir = path.join(__dirname, '..', 'fixtures', 'synthetic');
fs.mkdirSync(outDir, { recursive: true });

const files = {
  'settlement-recon.json': settlementRecon,
  'bank-statement.json': bankStatement,
  'ledger.json': ledger,
  // Kept separate and clearly labeled: this file is NEVER read by
  // matchEngine.js or the Day 3 LLM layer. It exists purely for Day 3's
  // evaluation layer to score results against reality.
  'ground-truth.internal.json': groundTruth,
};

for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2));
}

console.log(`Generated synthetic batch: size=${size}, seed=${seed}`);
console.log('Case type distribution:', groundTruth.caseTypeCounts);
console.log(`Settlements: ${settlementRecon.items.length}`);
console.log(`Bank statement lines: ${bankStatement.length}`);
console.log(`Ledger entries: ${ledger.length}`);
console.log(`Written to ${outDir}`);
