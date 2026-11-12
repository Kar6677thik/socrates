process.env.SOCRATES_EMBEDDINGS ??= 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fsrs, generatorParameters, createEmptyCard, type Grade } from 'ts-fsrs';
import { replay, fit, evaluate, DEFAULT_WEIGHTS, clipWeights, type History } from '../src/core/optimize.ts';

/** Small deterministic RNG so the synthetic history is the same every run. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('replay matches the ts-fsrs scheduler memory state', () => {
  const f = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: true }));
  const grades: Grade[] = [3, 3, 1, 3, 4, 2, 3];
  const gaps = [0, 1, 3, 1, 5, 12, 20];
  let card = createEmptyCard(new Date('2026-01-01T12:00:00Z'));
  let t = Date.parse('2026-01-01T12:00:00Z');
  for (let i = 0; i < grades.length; i++) {
    t += gaps[i] * 864e5;
    card = f.next(card, new Date(t), grades[i]).card;
  }
  const r = replay(DEFAULT_WEIGHTS, grades.map((g, i) => ({ t: gaps[i], g })));
  assert.ok(Math.abs(r.s - card.stability) / card.stability < 1e-3, `${r.s} vs ${card.stability}`);
  assert.ok(Math.abs(r.d - card.difficulty) < 1e-3, `${r.d} vs ${card.difficulty}`);
});

test('fitting recovers a better model from synthetic history', () => {
  // A learner who forgets faster than the defaults assume (lower initial stability, weaker growth).
  const truth = clipWeights(DEFAULT_WEIGHTS.map((w, i) => (i <= 3 ? w * 0.35 : i === 8 ? w * 0.75 : w)));
  const rand = rng(7);
  const hist: History = [];
  for (let c = 0; c < 300; c++) {
    const seq = [{ t: 0, g: 3 }];
    for (let k = 0; k < 6; k++) {
      const s = replay(truth, seq).s;
      const t = Math.max(1, Math.round(s * (0.5 + rand() * 1.5)));
      const r = replay(truth, [...seq, { t, g: 3 }]).r.at(-1)!;
      seq.push({ t, g: rand() < r ? 3 : 1 });
    }
    hist.push(seq);
  }
  const before = evaluate(DEFAULT_WEIGHTS, hist);
  const w = fit(hist, DEFAULT_WEIGHTS, 120);
  const after = evaluate(w, hist);
  const best = evaluate(truth, hist);
  // the defaults overestimate memory; the fit should close the gap to the true model
  assert.ok(after.log_loss < before.log_loss, `${before.log_loss} -> ${after.log_loss}`);
  assert.ok(after.log_loss <= best.log_loss + 0.002, `fit ${after.log_loss} vs truth ${best.log_loss}`);
  assert.ok(after.rmse < before.rmse, `calibration ${before.rmse} -> ${after.rmse}`);
  assert.ok(w[2] < DEFAULT_WEIGHTS[2], 'initial stability for Good should drop');
  assert.equal(w.length, 21);
});
