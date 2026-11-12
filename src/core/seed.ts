// `npm run seed`: a small sample bank so the UI is usable on day one. Safe to re-run (client_ref).
import { deflateSync, crc32 } from 'node:zlib';
import { App } from './app.ts';
import { saveImage } from './media.ts';

/** Draw a small PNG (no dependencies): three shapes on a light background, for the hotspot sample. */
function shapesPng(): Uint8Array {
  const W = 480, H = 240;
  const px = Buffer.alloc((W * 3 + 1) * H);
  const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  for (let y = 0; y < H; y++) {
    px[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let c = [244, 244, 245];
      if (x >= 40 && x < 140 && y >= 70 && y < 170) c = [113, 113, 122]; // square
      if (inCircle(x, y, 240, 120, 55)) c = [77, 87, 200]; // circle
      if (y >= 70 && y < 170 && x >= 330 && x < 440 && Math.abs(x - 385) <= (y - 70) * 0.55) c = [161, 161, 170]; // triangle
      px.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
}

const app = new App();
const tags = [
  'Math > Calculus > Derivatives',
  'Math > Calculus > Integrals',
  'Math > Linear Algebra',
  'Computer Science > Algorithms > Complexity',
  'Computer Science > Data Structures',
  'Programming > JavaScript',
  'Science > Physics > Mechanics',
  'Science > Biology > Cells',
  'Geography > Capitals',
];
for (const t of tags) app.tags.create(t);

const items = [
  { type: 'mcq_single', prompt: 'What is $\\frac{d}{dx} \\sin x$?', options: ['$\\cos x$', '$-\\cos x$', '$\\sin x$', '$-\\sin x$'], correct: 0, tags: ['math > calculus > derivatives'], difficulty: 1 },
  { type: 'numeric', prompt: 'Evaluate $\\displaystyle\\int_0^2 3x^2\\,dx$.', answer: 8, tags: ['math > calculus > integrals'], difficulty: 2, explanation: '$[x^3]_0^2 = 8$' },
  { type: 'fill_blank', prompt: 'By the chain rule, $\\frac{d}{dx} f(g(x)) = f\'(g(x)) \\cdot$ {{blank}}', blanks: [{ accept: ["g'(x)", 'g`(x)', 'dg/dx'] }], tags: ['math > calculus > derivatives'], difficulty: 2 },
  { type: 'true_false', prompt: 'Every square matrix is invertible.', correct: false, tags: ['math > linear algebra'], difficulty: 1, explanation: 'Only matrices with non-zero determinant are invertible.' },
  { type: 'mcq_multi', prompt: 'Which of these sorting algorithms run in $O(n \\log n)$ time in the **worst** case?', options: ['Merge sort', 'Heap sort', 'Quick sort', 'Insertion sort'], correct: [0, 1], tags: ['computer science > algorithms > complexity'], difficulty: 3, explanation: 'Quick sort is $O(n^2)$ in the worst case; insertion sort is $O(n^2)$.' },
  { type: 'mcq_single', prompt: 'Which data structure gives $O(1)$ average-time lookup by key?', options: ['Hash table', 'Balanced BST', 'Sorted array', 'Linked list'], correct: 0, tags: ['computer science > data structures'], difficulty: 1 },
  { type: 'mcq_single', prompt: 'What does this print?\n\n```js\nconsole.log([1, 2, 3].map(String).join("") + 1);\n```', options: ['`1231`', '`124`', '`7`', '`NaN`'], correct: 0, tags: ['programming > javascript'], difficulty: 2 },
  { type: 'short_answer', prompt: 'Explain the difference between `let` and `var` in JavaScript.', model_answer: '`var` is function-scoped and hoisted (initialized as undefined); `let` is block-scoped and in the temporal dead zone until its declaration. `let` cannot be redeclared in the same scope.', rubric: [{ criterion: 'Scope: function vs block', points: 2 }, { criterion: 'Hoisting / temporal dead zone', points: 1 }, { criterion: 'Redeclaration', points: 1 }], tags: ['programming > javascript'], difficulty: 3 },
  { type: 'numeric', prompt: 'A car accelerates from rest at $2\\,\\text{m/s}^2$ for $5\\,\\text{s}$. How far does it travel?', answer: 25, tolerance: 0.5, unit: 'm', tags: ['science > physics > mechanics'], difficulty: 2, hints: ['Use $s = \\tfrac12 a t^2$.'] },
  { type: 'flashcard', prompt: 'Function of the **mitochondria**', back: 'Produces ATP through cellular respiration.', tags: ['science > biology > cells'], difficulty: 1 },
  { type: 'fill_blank', prompt: 'The capital of Australia is {{blank}} and the capital of Canada is {{blank}}.', blanks: [{ accept: ['Canberra'] }, { accept: ['Ottawa'] }], tags: ['geography > capitals'], difficulty: 2 },
  { type: 'true_false', prompt: 'Matrix multiplication is commutative.', correct: false, tags: ['math > linear algebra'], difficulty: 1 },
];

// Phase 3 types. Kept in a second list so the client_refs above stay stable.
const shapes = saveImage(shapesPng()).url;
const more = [
  { type: 'matching', prompt: 'Match each data structure to its typical lookup time.', pairs: [{ left: 'Hash table', right: '$O(1)$ average' }, { left: 'Balanced BST', right: '$O(\\log n)$' }, { left: 'Linked list', right: '$O(n)$' }], distractors: ['$O(n^2)$'], tags: ['computer science > data structures'], difficulty: 2 },
  { type: 'ordering', prompt: 'Order these complexities from fastest to slowest growth.', items: ['$O(1)$', '$O(\\log n)$', '$O(n)$', '$O(n \\log n)$', '$O(n^2)$'], tags: ['computer science > algorithms > complexity'], difficulty: 2 },
  { type: 'cloze', prompt: 'Newton\'s second law: force equals {{c1::mass}} times {{c2::acceleration|a::rate of change of velocity}}.', tags: ['science > physics > mechanics'], difficulty: 1 },
  { type: 'code', prompt: 'Write `solution(xs)` that returns the **second largest distinct** number in an array, or `null` if there is none.', language: 'javascript', starter: 'function solution(xs) {\n  \n}\n', tests: [{ args: [[3, 1, 4, 1, 5]], expected: 4 }, { args: [[7, 7]], expected: null }, { args: [[-2, -5, -1]], expected: -2 }, { args: [[]], expected: null, hidden: true }, { args: [[10, 9, 10, 8]], expected: 9, hidden: true }], reference_solution: 'function solution(xs) {\n  const u = [...new Set(xs)].sort((a, b) => b - a);\n  return u.length > 1 ? u[1] : null;\n}', tags: ['programming > javascript'], difficulty: 3 },
  { type: 'code', prompt: 'Write a Python function `is_palindrome(s)` that ignores case and non-letters.', language: 'python', starter: 'def is_palindrome(s):\n    ', reference_solution: 'def is_palindrome(s):\n    t = [c.lower() for c in s if c.isalpha()]\n    return t == t[::-1]', tags: ['computer science > algorithms > complexity'], difficulty: 2 },
  { type: 'hotspot', prompt: 'Click the **circle**.', image: shapes, regions: [{ x: 0.385, y: 0.27, w: 0.23, h: 0.46, label: 'circle' }], tags: ['math > linear algebra'], difficulty: 1 },
];

const res = [
  ...app.questions.add(items.map((q, i) => ({ ...q, client_ref: `seed-${i}` })), { actor: 'user', status: 'active' }),
  ...app.questions.add(more.map((q, i) => ({ ...q, client_ref: `seed-p3-${i}` })), { actor: 'user', status: 'active' }),
];
const counts: Record<string, number> = {};
for (const r of res) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log('Seeded:', counts);
