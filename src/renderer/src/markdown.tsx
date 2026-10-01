import DOMPurify from "dompurify";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";
import { useMemo } from "react";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    code({ text, lang }) {
      const language = lang?.split(/\s+/)[0]?.toLowerCase() ?? "";
      const known = language && hljs.getLanguage(language) ? language : "";
      const highlighted = known
        ? hljs.highlight(text, { language: known }).value
        : escapeHtml(text);
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(known || "text")}</span><button type="button" data-copy="${encodeURIComponent(text)}">复制</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
  return DOMPurify.sanitize(String(raw), {
    ADD_ATTR: ["class", "data-copy"],
    ADD_TAGS: ["button"],
  });
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);
  if (!html) return null;
  return (
    <div
      className="md"
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
        if (!button) return;
        const encoded = button.getAttribute("data-copy") || "";
        void navigator.clipboard.writeText(decodeURIComponent(encoded)).then(() => {
          const previous = button.textContent;
          button.textContent = "已复制";
          window.setTimeout(() => {
            button.textContent = previous;
          }, 1200);
        });
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
