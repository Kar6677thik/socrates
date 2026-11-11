// `npm run seed`: a small sample bank so the UI is usable on day one. Safe to re-run (client_ref).
import { App } from './app.ts';

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

const res = app.questions.add(items.map((q, i) => ({ ...q, client_ref: `seed-${i}` })), { actor: 'user', status: 'active' });
const counts: Record<string, number> = {};
for (const r of res) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log('Seeded:', counts);
