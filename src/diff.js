'use strict';

/**
 * diff.js —— 极简行级 diff
 *
 * 为什么自己写而不装包：整个项目刻意保持「零运行时依赖」，
 * 而 Agent 需要的 diff 功能其实很小 —— 只需要能把「改前 / 改后」渲染成
 * 红绿两色的统一 diff 给用户看。为此拉一个依赖不划算。
 *
 * 算法：先剥掉公共前后缀（这一步能把绝大多数真实改动缩到几十行），
 * 再对中间部分做 LCS 动态规划。中间部分仍然过大时降级成「整段替换」，
 * 保证不会因为一个巨大的文件把内存吃爆。
 */

const MAX_DP_CELLS = 4_000_000; // 2000 × 2000 左右，再大就走降级

function splitLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  return s.replace(/\r\n?/g, '\n').split('\n');
}

/** 行级差异，返回 [{ type: 'equal'|'add'|'del', text }] */
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 1) 剥公共前缀
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  // 2) 剥公共后缀
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out = [];
  for (let i = 0; i < start; i++) out.push({ type: 'equal', text: a[i] });

  if (midA.length * midB.length > MAX_DP_CELLS) {
    // 降级：中间整段替换
    for (const line of midA) out.push({ type: 'del', text: line });
    for (const line of midB) out.push({ type: 'add', text: line });
  } else {
    out.push(...lcsDiff(midA, midB));
  }

  for (let i = endA; i < a.length; i++) out.push({ type: 'equal', text: a[i] });
  return out;
}

/** 对已经剥掉公共前后缀的两段做 LCS */
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: 'add', text }));
  if (m === 0) return a.map((text) => ({ type: 'del', text }));

  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        a[i] === b[j] ? dp[(i + 1) * W + (j + 1)] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/**
 * 生成统一 diff 文本（带 @@ 头）。hunks 之间用 context 行做上下文。
 */
function unifiedDiff(oldText, newText, { context = 3, oldLabel = 'a', newLabel = 'b', maxHunks = 40 } = {}) {
  const ops = diffLines(oldText, newText);

  // 先算出每行的新旧行号，方便后面切 hunk
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.type === 'equal') {
      rows.push({ ...op, oldNo: oldNo++, newNo: newNo++ });
    } else if (op.type === 'del') {
      rows.push({ ...op, oldNo: oldNo++, newNo: null });
    } else {
      rows.push({ ...op, oldNo: null, newNo: newNo++ });
    }
  }

  const changed = rows.map((r) => r.type !== 'equal');
  if (!changed.some(Boolean)) return '';

  // 把改动行按 context 合并成 hunk 区间
  const hunks = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    if (!changed[i]) continue;
    const lo = Math.max(0, i - context);
    const hi = Math.min(rows.length - 1, i + context);
    if (cur && lo <= cur.hi + 1) {
      cur.hi = Math.max(cur.hi, hi);
    } else {
      if (cur) hunks.push(cur);
      cur = { lo, hi };
    }
  }
  if (cur) hunks.push(cur);

  const limited = hunks.slice(0, maxHunks);
  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const h of limited) {
    const slice = rows.slice(h.lo, h.hi + 1);
    const oldStart = slice.find((r) => r.oldNo != null)?.oldNo ?? 0;
    const newStart = slice.find((r) => r.newNo != null)?.newNo ?? 0;
    const oldCount = slice.filter((r) => r.type !== 'add').length;
    const newCount = slice.filter((r) => r.type !== 'del').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const r of slice) {
      lines.push((r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + r.text);
    }
  }
  if (hunks.length > limited.length) {
    lines.push(`… 另有 ${hunks.length - limited.length} 处改动未展示`);
  }
  return lines.join('\n');
}

/** 统计增删行数，用于卡片上的 +N −M */
function diffStat(oldText, newText) {
  const ops = diffLines(oldText, newText);
  let add = 0;
  let del = 0;
  for (const op of ops) {
    if (op.type === 'add') add++;
    else if (op.type === 'del') del++;
  }
  return { add, del };
}

module.exports = { diffLines, unifiedDiff, diffStat, splitLines };
