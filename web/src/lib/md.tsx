import { memo } from 'react';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

for (const [n, l] of Object.entries({ javascript, typescript, python, java, cpp, go, rust, sql, bash, json, xml, css })) hljs.registerLanguage(n, l);
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['c', 'c++', 'h'], { languageName: 'cpp' });
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['html'], { languageName: 'xml' });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const l = hljs.getLanguage(lang) ? lang : null;
      return l ? hljs.highlight(code, { language: l }).value : escape(code);
    },
  }),
  markedKatex({ throwOnError: false, nonStandard: true }),
  {
    // ⟦n⟧ marks a numbered fill-in blank inside a prompt.
    extensions: [
      {
        name: 'blank',
        level: 'inline',
        start: (src: string) => src.indexOf('⟦'),
        tokenizer(src: string) {
          const m = /^⟦(\d+)⟧/.exec(src);
          return m ? { type: 'blank', raw: m[0], n: m[1] } : undefined;
        },
        renderer: (t: any) => `<span class="blank-slot" aria-label="blank ${t.n}"><span class="blank-n">${t.n}</span></span>`,
      },
    ],
  },
  {
    gfm: true,
    breaks: true,
    // Question content may come from an agent: never render raw HTML.
    renderer: {
      html({ text }) {
        return escape(text);
      },
      link({ href, text }) {
        const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '#';
        return `<a href="${escape(safe)}" target="_blank" rel="noreferrer noopener">${text}</a>`;
      },
      image({ href, text }) {
        const safe = /^(https?:|data:image\/|\/)/i.test(href) ? href : '';
        return `<img src="${escape(safe)}" alt="${escape(text)}" loading="lazy" />`;
      },
    },
  },
);

const cache = new Map<string, string>();
export function renderMd(src: string): string {
  let html = cache.get(src);
  if (html === undefined) {
    html = marked.parse(src, { async: false }) as string;
    if (cache.size > 2000) cache.clear();
    cache.set(src, html);
  }
  return html;
}

/** Strip markdown to a single plain line (list previews). */
export function plain(src: string, max = 180): string {
  const t = src
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' [math] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\{\{\s*blank\s*\}\}/g, '___')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export const Md = memo(function Md({ src, className = '', inline = false }: { src: string; className?: string; inline?: boolean }) {
  return <div className={`md ${inline ? 'md-inline' : ''} ${className}`} dangerouslySetInnerHTML={{ __html: renderMd(src) }} />;
});
