'use strict';

/**
 * tools.js —— Agent 能用的工具
 *
 * 七个工具，刻意做窄：读一个文件、列目录、搜内容、写文件、改文件、删文件、跑命令。
 * 没有「万能 shell」之外的逃生门，也没有任何绕过工作区围栏的接口。
 *
 * 设计约定：
 *   - 每个执行器返回 { content, meta }。
 *     content 是回给模型的文本（要短，别把整个文件塞回上下文）；
 *     meta 只给界面用（diff、行数统计这些），模型看不到。
 *   - 所有路径都必须过 resolveInWorkspace，越界直接抛错。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const { resolveInWorkspace, classifyCommand } = require('./safety');
const { unifiedDiff, diffStat } = require('./diff');

/* ============================================================
 * 常量
 * ============================================================ */

const MAX_READ_BYTES = 400_000; // 单次读文件上限
const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000; // 命令输出回给模型的上限
const MAX_SEARCH_RESULTS = 200;
const MAX_WALK_ENTRIES = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** 遍历目录时默认跳过的重目录 —— 跳它们既快又能避免噪声 */
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.gradle',
  '.cache',
  '.turbo',
  'coverage',
  '.DS_Store',
]);

/* ============================================================
 * 工具声明（喂给模型的 function schema）
 * ============================================================ */

const TOOL_SPECS = [
  {
    name: 'read_file',
    mutating: false,
    description:
      '读取工作区内某个文本文件的内容，返回带行号的文本。大文件请用 start_line / end_line 分段读。' +
      '返回内容里的行号只是给你定位用的，改文件时不要把它写进 old_string / new_string。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录，或绝对路径（必须落在工作区内）' },
        start_line: { type: 'integer', description: '起始行号，从 1 开始，默认 1' },
        end_line: { type: 'integer', description: '结束行号，默认读到文件末尾' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    mutating: false,
    description: '列出目录结构。默认会跳过 node_modules / .git / dist 这类目录，需要看它们时把 skip_common 设为 false。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认工作区根目录' },
        depth: { type: 'integer', description: '递归深度，默认 2，最大 5' },
        skip_common: { type: 'boolean', description: '是否跳过 node_modules 等常见目录，默认 true' },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    mutating: false,
    description: '在工作区里按正则搜索文件内容，返回「相对路径:行号: 该行内容」。找函数定义、找关键字、找 TODO 都用它。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则表达式，例如 "function\\s+login" 或 "TODO|FIXME"' },
        path: { type: 'string', description: '搜索起点，默认工作区根目录' },
        glob: { type: 'string', description: '只搜匹配该通配符的文件，例如 "*.js" 或 "src/**/*.ts"' },
        case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
        max_results: { type: 'integer', description: `最多返回多少条，默认 ${MAX_SEARCH_RESULTS}` },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    mutating: true,
    description:
      '把内容完整写入一个文件（不存在就新建，存在就整个覆盖）。父目录会自动创建。' +
      '如果只是想改动文件里的一小部分，优先用 edit_file，那样更安全也更省 token。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    mutating: true,
    description:
      '在文件里做精确字符串替换。old_string 必须与文件里的内容逐字符一致（包括缩进）。' +
      '默认要求 old_string 在文件里只出现一次；如果它出现多次，要么多带几行上下文，要么把 replace_all 设为 true。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换掉的原文，必须与文件内容完全一致' },
        new_string: { type: 'string', description: '替换成的新内容，传空字符串表示删除这段' },
        replace_all: { type: 'boolean', description: '是否替换所有出现的位置，默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_path',
    mutating: true,
    danger: true,
    description: '删除工作区内的一个文件或目录（目录会递归删除）。这个操作不可恢复，请谨慎使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件或目录路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    mutating: true,
    description:
      '在工作区内执行一条 shell 命令并返回输出。Windows 上默认用 PowerShell，可以用 shell 参数切到 cmd 或 bash。' +
      '命令是真实执行的，会真的改动你的系统，请先想清楚再调用。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，默认工作区根目录（必须落在工作区内）' },
        timeout_ms: { type: 'integer', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}` },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: '用哪个 shell，默认跟随设置' },
      },
      required: ['command'],
    },
  },
];

const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

/** 按权限模式过滤可用工具。read-only 下只剩三个只读工具。 */
function toolsForMode(mode) {
  if (mode === 'read-only') {
    return TOOL_SPECS.filter((t) => !t.mutating);
  }
  return TOOL_SPECS;
}

/** 转成 OpenAI function calling 需要的格式 */
function toOpenAITools(mode) {
  return toolsForMode(mode).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function specOf(name) {
  return TOOL_SPECS.find((t) => t.name === name) || null;
}

/* ============================================================
 * 通用小工具
 * ============================================================ */

/** 是不是二进制文件：看前 8KB 里有没有 NUL 字节 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 相对工作区的展示路径，统一用 / 分隔，跨平台看起来一致 */
function relPath(root, abs) {
  const r = path.relative(root, abs);
  const shown = r === '' ? '.' : r;
  return shown.split(path.sep).join('/');
}

/** 截断过长的输出，保留头尾 —— 中间被砍掉的部分往往是噪声 */
function truncateMiddle(text, limit = MAX_OUTPUT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const omitted = s.length - limit;
  return `${s.slice(0, head)}\n\n… 此处省略 ${omitted} 个字符 …\n\n${s.slice(-tail)}`;
}

/** glob → 正则，支持 * ? ** 和 {a,b} */
function globToRegExp(glob) {
  const src = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        out += '.*';
        i++;
        if (src[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const close = src.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        const alts = src
          .slice(i + 1, close)
          .split(',')
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        out += `(${alts.join('|')})`;
        i = close;
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/* ============================================================
 * 工具实现
 * ============================================================ */

/** read_file */
async function readFile(args, ctx) {
  const abs = resolveInWorkspace(ctx.workspace, args.path, { mustExist: true });
  const st = await fsp.stat(abs);
  if (st.isDirectory()) {
    const e = new Error(`${relPath(ctx.workspace, abs)} 是一个目录，请改用 list_dir`);
    e.code = 'IS_DIR';
    throw e;
  }

  const raw = await fsp.readFile(abs);
  if (looksBinary(raw)) {
    return { content: `[二进制文件，无法按文本读取] ${relPath(ctx.workspace, abs)}，${humanSize(raw.length)}` };
  }

  const truncatedBytes = raw.length > MAX_READ_BYTES;
  const text = (truncatedBytes ? raw.subarray(0, MAX_READ_BYTES) : raw).toString('utf8');
  const allLines = text.split(/\r?\n/);

  const start = Math.max(1, Number.parseInt(args.start_line ?? 1, 10) || 1);
  const requestedEnd = Number.parseInt(args.end_line ?? 0, 10) || allLines.length;
  const end = Math.min(allLines.length, Math.max(start, requestedEnd));

  const width = String(end).length;
  const body = allLines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
    .join('\n');

  const notes = [];
  if (truncatedBytes) notes.push(`文件较大，只读了前 ${humanSize(MAX_READ_BYTES)}`);
  if (end < allLines.length) notes.push(`还有 ${allLines.length - end} 行未显示，可用 start_line/end_line 继续读`);
  if (start > MAX_READ_LINES && end - start > MAX_READ_LINES) notes.push(`一次最多读 ${MAX_READ_LINES} 行`);

  const header = `# ${relPath(ctx.workspace, abs)}（第 ${start}-${end} 行，共 ${allLines.length} 行）`;
  return {
    content: [header, body, notes.length ? `\n（${notes.join('；')}）` : ''].filter(Boolean).join('\n'),
    meta: { kind: 'read', path: relPath(ctx.workspace, abs), lines: allLines.length, from: start, to: end },
  };
}

/** list_dir */
async function listDir(args, ctx) {
  const abs = resolveInWorkspace(ctx.workspace, args.path ?? '.', { mustExist: true });
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) {
    const e = new Error(`${relPath(ctx.workspace, abs)} 不是目录，请改用 read_file`);
    e.code = 'NOT_DIR';
    throw e;
  }

  const depth = Math.min(5, Math.max(1, Number.parseInt(args.depth ?? 2, 10) || 2));
  const skipCommon = args.skip_common !== false;
  const lines = [];
  let count = 0;
  let cut = false;

  async function walk(dir, prefix, level) {
    if (level > depth || cut) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const ent of entries) {
      if (count++ > MAX_WALK_ENTRIES) {
        cut = true;
        return;
      }
      const full = path.join(dir, ent.name);
      const isDir = ent.isDirectory();
      if (skipCommon && isDir && SKIP_DIRS.has(ent.name)) {
        lines.push(`${prefix}${ent.name}/  …（已跳过）`);
        continue;
      }
      if (isDir) {
        lines.push(`${prefix}${ent.name}/`);
        await walk(full, prefix + '  ', level + 1);
      } else {
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          /* 忽略 */
        }
        lines.push(`${prefix}${ent.name}  ${humanSize(size)}`);
      }
    }
  }

  await walk(abs, '', 1);
  const root = relPath(ctx.workspace, abs);
  const content = `# ${root}\n${lines.join('\n')}${cut ? '\n…（条目过多，已截断）' : ''}`;
  return { content, meta: { kind: 'tree', path: root, entries: lines.length } };
}

/** search_files */
async function searchFiles(args, ctx) {
  const startAbs = resolveInWorkspace(ctx.workspace, args.path ?? '.', { mustExist: true });
  const caseSensitive = args.case_sensitive === true;
  const limit = Math.min(1000, Math.max(1, Number.parseInt(args.max_results ?? MAX_SEARCH_RESULTS, 10) || MAX_SEARCH_RESULTS));

  let re;
  try {
    re = new RegExp(String(args.pattern), caseSensitive ? '' : 'i');
  } catch (err) {
    const e = new Error(`正则表达式无效：${err.message}`);
    e.code = 'BAD_REGEX';
    throw e;
  }
  const globRe = args.glob ? globToRegExp(args.glob) : null;

  const hits = [];
  let scanned = 0;
  let stopped = false;

  async function walk(dir) {
    if (stopped) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (stopped) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;

      const rel = relPath(ctx.workspace, full);
      if (globRe && !globRe.test(rel) && !globRe.test(ent.name)) continue;

      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (st.size > 2_000_000) continue; // 超大文件不搜

      scanned++;
      let buf;
      try {
        buf = await fsp.readFile(full);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;

      const text = buf.toString('utf8');
      const fileLines = text.split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i++) {
        if (re.test(fileLines[i])) {
          hits.push(`${rel}:${i + 1}: ${fileLines[i].trim().slice(0, 400)}`);
          if (hits.length >= limit) {
            stopped = true;
            return;
          }
        }
      }
    }
  }

  await walk(startAbs);

  if (!hits.length) {
    return {
      content: `没有找到匹配 ${JSON.stringify(args.pattern)} 的内容（已扫描 ${scanned} 个文件）。`,
      meta: { kind: 'search', matches: 0, scanned },
    };
  }
  return {
    content: `找到 ${hits.length} 处匹配（已扫描 ${scanned} 个文件）${stopped ? '，结果已达上限' : ''}：\n${hits.join('\n')}`,
    meta: { kind: 'search', matches: hits.length, scanned },
  };
}

/** write_file */
async function writeFile(args, ctx) {
  const abs = resolveInWorkspace(ctx.workspace, args.path);
  const rel = relPath(ctx.workspace, abs);
  const existed = fs.existsSync(abs);

  let previous = null;
  if (existed) {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      const e = new Error(`${rel} 是一个目录，不能写入`);
      e.code = 'IS_DIR';
      throw e;
    }
    previous = (await fsp.readFile(abs)).toString('utf8');
  }

  const content = String(args.content ?? '');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');

  const stat = diffStat(previous ?? '', content);
  const diff = unifiedDiff(previous ?? '', content, {
    oldLabel: existed ? `a/${rel}` : '/dev/null',
    newLabel: `b/${rel}`,
  });

  return {
    content: existed
      ? `已更新 ${rel}（+${stat.add} −${stat.del}，现共 ${content.split('\n').length} 行）`
      : `已新建 ${rel}（${content.split('\n').length} 行，${humanSize(Buffer.byteLength(content))}）`,
    meta: { kind: 'write', path: rel, created: !existed, diff, stat },
  };
}

/** edit_file */
async function editFile(args, ctx) {
  const abs = resolveInWorkspace(ctx.workspace, args.path, { mustExist: true });
  const rel = relPath(ctx.workspace, abs);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) {
    const e = new Error(`${rel} 是一个目录`);
    e.code = 'IS_DIR';
    throw e;
  }

  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  if (oldStr === '') {
    const e = new Error('old_string 不能为空。如果你想新建文件请用 write_file。');
    e.code = 'BAD_ARGS';
    throw e;
  }
  if (oldStr === newStr) {
    const e = new Error('old_string 与 new_string 完全相同，不需要改动。');
    e.code = 'NOOP';
    throw e;
  }

  const before = (await fsp.readFile(abs)).toString('utf8');

  // 统计出现次数（用 indexOf 逐次推进，避免正则特殊字符的坑）
  const positions = [];
  let from = 0;
  for (;;) {
    const idx = before.indexOf(oldStr, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + oldStr.length;
  }

  if (positions.length === 0) {
    const e = new Error(
      `在 ${rel} 里找不到 old_string。常见原因：缩进不一致、行尾换行符差异、或者内容已经变了。\n` +
        `建议先 read_file 看一下当前真实内容再重试。`
    );
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (positions.length > 1 && args.replace_all !== true) {
    const e = new Error(
      `old_string 在 ${rel} 里出现了 ${positions.length} 次，无法确定改哪一处。\n` +
        `请多带几行上下文让它唯一，或者把 replace_all 设为 true 全部替换。`
    );
    e.code = 'AMBIGUOUS';
    throw e;
  }

  const replaceAll = args.replace_all === true;
  let after;
  if (replaceAll) {
    after = before.split(oldStr).join(newStr);
  } else {
    const p = positions[0];
    after = before.slice(0, p) + newStr + before.slice(p + oldStr.length);
  }

  await fsp.writeFile(abs, after, 'utf8');

  const stat = diffStat(before, after);
  const diff = unifiedDiff(before, after, { oldLabel: `a/${rel}`, newLabel: `b/${rel}` });
  const times = replaceAll ? positions.length : 1;

  return {
    content: `已修改 ${rel}（${times} 处，+${stat.add} −${stat.del}）`,
    meta: { kind: 'edit', path: rel, created: false, diff, stat, times },
  };
}

/** delete_path */
async function deletePath(args, ctx) {
  const abs = resolveInWorkspace(ctx.workspace, args.path, { mustExist: true });
  const rel = relPath(ctx.workspace, abs);
  if (abs === ctx.workspace) {
    const e = new Error('拒绝删除工作区根目录本身。');
    e.code = 'REFUSED';
    throw e;
  }
  const st = await fsp.stat(abs);
  const isDir = st.isDirectory();
  await fsp.rm(abs, { recursive: true, force: true });
  return {
    content: `已删除${isDir ? '目录' : '文件'} ${rel}`,
    meta: { kind: 'delete', path: rel, isDir },
  };
}

/* ============================================================
 * run_command
 * ============================================================ */

/** 找到 Git Bash（如果装了的话），让 shell=bash 在 Windows 上也能用 */
function findGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'bash.exe'; // 交给 PATH
}

function defaultShell() {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

/**
 * 连子进程带孙进程一起干掉。
 *
 * 不能只 child.kill()：npm、gradle、make 这类命令会再拉起一堆子进程，
 * 杀了父进程它们会变成孤儿继续跑，端口照样占着、文件照样锁着。
 * Windows 上 taskkill /T 正好干这个；POSIX 上靠进程组（spawn 时 detached）。
 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

function buildSpawn(shell, command) {
  if (shell === 'cmd') {
    // chcp 65001：让 cmd 用 UTF-8 输出，否则中文在中文 Windows 上会变乱码
    return { exe: 'cmd.exe', argv: ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`] };
  }
  if (shell === 'bash') {
    return { exe: process.platform === 'win32' ? findGitBash() : 'bash', argv: ['-lc', command] };
  }
  // powershell（默认）
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const prelude =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ' +
    '$ErrorActionPreference="Continue"; ';
  return { exe, argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command] };
}

async function runCommand(args, ctx) {
  const command = String(args.command ?? '').trim();
  if (!command) {
    const e = new Error('command 不能为空');
    e.code = 'BAD_ARGS';
    throw e;
  }

  const cwd = args.cwd ? resolveInWorkspace(ctx.workspace, args.cwd, { mustExist: true }) : ctx.workspace;
  const shell = ['cmd', 'powershell', 'bash'].includes(args.shell) ? args.shell : ctx.shell || defaultShell();
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number.parseInt(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS));

  const { exe, argv } = buildSpawn(shell, command);

  const env = {
    ...process.env,
    // 关掉一切会「等人输入」的东西，否则命令会挂在那里直到超时
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
    npm_config_yes: 'true',
  };

  const started = Date.now();

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, argv, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ spawnError: err.message, stdout: '', stderr: '', code: null, timedOut: false });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    const CAP = 1_000_000; // 单流最多收 1MB，防止内存被刷爆

    child.stdout.on('data', (b) => {
      if (outLen < CAP) {
        outChunks.push(b);
        outLen += b.length;
      }
    });
    child.stderr.on('data', (b) => {
      if (errLen < CAP) {
        errChunks.push(b);
        errLen += b.length;
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeout);

    const onAbort = () => {
      timedOut = true;
      killTree(child.pid);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve({ spawnError: err.message, stdout: Buffer.concat(outChunks).toString('utf8'), stderr: '', code: null, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code,
        timedOut,
      });
    });
  });

  const durationMs = Date.now() - started;

  if (result.spawnError) {
    return {
      content: `命令启动失败：${result.spawnError}`,
      meta: { kind: 'command', command, shell, cwd: relPath(ctx.workspace, cwd), exitCode: null, durationMs, error: true },
      isError: true,
    };
  }

  const stdout = truncateMiddle(result.stdout);
  const stderr = truncateMiddle(result.stderr);

  const parts = [`$ ${command}`, `（${shell}，退出码 ${result.code ?? '—'}，耗时 ${durationMs} ms）`];
  if (result.timedOut) parts.push(`⚠ 已超时（${timeout} ms），进程被强制结束。`);
  if (stdout.trim()) parts.push(`\n--- stdout ---\n${stdout}`);
  if (stderr.trim()) parts.push(`\n--- stderr ---\n${stderr}`);
  if (!stdout.trim() && !stderr.trim()) parts.push('\n（命令没有任何输出）');

  return {
    content: parts.join('\n'),
    meta: {
      kind: 'command',
      command,
      shell,
      cwd: relPath(ctx.workspace, cwd),
      exitCode: result.code,
      durationMs,
      timedOut: result.timedOut,
      stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
      error: result.code !== 0 || result.timedOut,
    },
    isError: result.code !== 0 || result.timedOut,
  };
}

/* ============================================================
 * 分发
 * ============================================================ */

const EXECUTORS = {
  read_file: readFile,
  list_dir: listDir,
  search_files: searchFiles,
  write_file: writeFile,
  edit_file: editFile,
  delete_path: deletePath,
  run_command: runCommand,
};

/**
 * 执行一次工具调用。
 * 返回 { content, meta, isError }；抛错也会被包成 isError 的结果，让模型自己纠错重试。
 */
async function executeTool(name, args, ctx) {
  const exec = EXECUTORS[name];
  if (!exec) {
    return { content: `未知工具：${name}`, meta: { kind: 'unknown', name }, isError: true };
  }
  try {
    return await exec(args || {}, ctx);
  } catch (err) {
    const code = err && err.code ? ` [${err.code}]` : '';
    return {
      content: `工具执行失败${code}：${err && err.message ? err.message : String(err)}`,
      meta: { kind: 'error', name, code: err && err.code, message: err && err.message },
      isError: true,
    };
  }
}

/** 判断这次调用是否需要人工确认 */
function needsApproval(name, args, mode, sessionAllowlist) {
  if (mode === 'full') return { needed: false };
  const spec = specOf(name);
  if (!spec) return { needed: false };

  if (mode === 'read-only') {
    return { needed: false }; // 只读模式下这些工具压根不在列表里
  }

  // 工具本身标记为危险的（delete_path）
  if (spec.danger) {
    const key = `${name}:${args?.path ?? ''}`;
    if (sessionAllowlist.has(key)) return { needed: false };
    return { needed: true, key, reasons: ['这是不可恢复的删除操作'], title: `删除 ${args?.path ?? ''}` };
  }

  // 命令按特征表判断
  if (name === 'run_command') {
    const { dangerous, reasons } = classifyCommand(args?.command);
    if (!dangerous) return { needed: false };
    const key = `run_command:${args?.command ?? ''}`;
    if (sessionAllowlist.has(key)) return { needed: false };
    return { needed: true, key, reasons, title: args?.command ?? '' };
  }

  return { needed: false };
}

module.exports = {
  TOOL_SPECS,
  TOOL_NAMES,
  toolsForMode,
  toOpenAITools,
  specOf,
  executeTool,
  needsApproval,
  defaultShell,
  MAX_OUTPUT_CHARS,
};
