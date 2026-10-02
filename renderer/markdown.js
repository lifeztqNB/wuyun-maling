'use strict';

/**
 * markdown.js —— 极简 Markdown 渲染
 *
 * 为什么自己写：渲染进程里不想引任何第三方库（这个项目刻意保持零运行时依赖），
 * 而模型输出用到的语法其实很有限 —— 标题、列表、表格、引用、行内样式、围栏代码块。
 *
 * 安全：**先整体转义 HTML，再做语法替换**，所以模型输出里的 <script> 只会变成文本。
 * 顺序不能反，反了就是一个现成的 XSS。
 */

(function (global) {
  const CODE_SENTINEL = '\u0000CB';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 行内语法。入参必须是已经转义过的文本。 */
  function inline(s) {
    let out = s;
    // 行内代码优先，里面的内容不再做任何替换
    const codes = [];
    out = out.replace(/`([^`\n]+)`/g, (_m, c) => {
      codes.push(c);
      return `${CODE_SENTINEL}I${codes.length - 1}\u0000`;
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s（(])\*([^*\n]+)\*(?=[\s）).，,。!！?？]|$)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    out = out.replace(new RegExp(`${CODE_SENTINEL}I(\\d+)\\u0000`, 'g'), (_m, i) => `<code>${codes[Number(i)]}</code>`);
    return out;
  }

  function renderTable(rows) {
    const head = rows[0];
    const body = rows.slice(1);
    const th = head.map((c) => `<th>${inline(c.trim())}</th>`).join('');
    const tb = body
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`)
      .join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|');
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }

  /** 渲染成 HTML 字符串 */
  function render(src) {
    const text = String(src ?? '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');

    // 第一步：把围栏代码块抽出来，避免里面的内容被当成 Markdown
    const blocks = [];
    const kept = [];
    let inFence = false;
    let fenceLang = '';
    let fenceBuf = [];

    for (const line of lines) {
      const m = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
      if (!inFence && m) {
        inFence = true;
        fenceLang = m[1] || '';
        fenceBuf = [];
        continue;
      }
      if (inFence && /^\s*```+\s*$/.test(line)) {
        inFence = false;
        blocks.push({ lang: fenceLang, code: fenceBuf.join('\n') });
        kept.push(`${CODE_SENTINEL}B${blocks.length - 1}\u0000`);
        continue;
      }
      if (inFence) fenceBuf.push(line);
      else kept.push(line);
    }
    if (inFence) {
      // 没闭合的围栏，当成普通段落
      kept.push(...fenceBuf.map((l) => '```' + l));
    }

    // 第二步：逐行解析块级结构
    const out = [];
    let i = 0;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
        para = [];
      }
    };

    while (i < kept.length) {
      const line = kept[i];

      // 代码块占位
      const cb = new RegExp(`^${CODE_SENTINEL}B(\\d+)\\u0000$`).exec(line.trim());
      if (cb) {
        flushPara();
        const b = blocks[Number(cb[1])];
        const langLabel = b.lang ? esc(b.lang) : 'text';
        out.push(
          `<div class="codeblock">` +
            `<div class="codeblock-head"><span>${langLabel}</span>` +
            `<button class="codeblock-copy" data-copy="${esc(b.code)}">复制</button></div>` +
            `<pre>${esc(b.code)}</pre>` +
            `</div>`
        );
        i++;
        continue;
      }

      // 空行
      if (!line.trim()) {
        flushPara();
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      // 标题
      const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        const lvl = h[1].length;
        out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
        i++;
        continue;
      }

      // 表格：当前行有 |，下一行是分隔行
      if (line.includes('|') && i + 1 < kept.length && isTableSep(kept[i + 1])) {
        flushPara();
        const rows = [splitRow(line)];
        i += 2;
        while (i < kept.length && kept[i].includes('|') && kept[i].trim()) {
          rows.push(splitRow(kept[i]));
          i++;
        }
        out.push(renderTable(rows));
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < kept.length && /^\s*>\s?/.test(kept[i])) {
          buf.push(kept[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
        continue;
      }

      // 列表
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < kept.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(kept[i]);
          if (!m) {
            // 允许列表项里继续缩进的行
            if (kept[i].trim() && /^\s{2,}/.test(kept[i]) && items.length) {
              items[items.length - 1] += '\n' + kept[i].trim();
              i++;
              continue;
            }
            break;
          }
          items.push(m[3]);
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`);
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();

    return out.join('\n');
  }

  /** 纯文本摘要，用于会话列表等地方 */
  function plain(src, max = 90) {
    const s = String(src ?? '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*`_~|-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  global.WuyunMD = { render, esc, plain };
})(window);
