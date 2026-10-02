'use strict';

/**
 * safety.js —— 安全层
 *
 * 一个能读写文件、能跑命令的 Agent，最怕两件事：
 *   1. 它跑到工作区外面去动你的文件（比如把 C:\Users 下的东西删了）
 *   2. 它执行一条毁灭性的命令（比如 format C:、rm -rf、reg delete）
 *
 * 这里用两层来兜：
 *   - 路径围栏：所有文件操作的路径 resolve 之后必须落在工作区根目录内。
 *     这一层是「硬」的，任何权限模式下都不放开。
 *   - 危险命令识别：命令文本命中危险特征表时，在 auto 模式下必须人工确认。
 *     这一层是「软」的，full 模式下会跳过（但路径围栏依然生效）。
 *
 * 注意：危险命令识别是「特征匹配」，不是沙箱。它能拦住常见的自毁操作，
 * 但拦不住刻意绕过。真要跑不可信的代码，请用虚拟机或容器。
 */

const fs = require('fs');
const path = require('path');

/* ============================================================
 * 一、路径围栏
 * ============================================================ */

/** 把工作区根目录规范化为绝对路径；能取到真实路径就取真实路径（解开符号链接） */
function normalizeRoot(root) {
  const abs = path.resolve(String(root || process.cwd()));
  return realpathBestEffort(abs);
}

/**
 * 尽量取真实路径，但允许路径「还不存在」。
 *
 * 为什么不能直接用 fs.realpathSync：write_file 要写一个新文件，此时目标
 * 不存在，realpathSync 会抛错。所以这里从叶子往上找，找到第一个存在的
 * 祖先取真实路径，再把剩下的尾巴拼回去。
 *
 * 这一步不能省：否则一个指向工作区外面的符号链接就能骗过围栏。
 */
function realpathBestEffort(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      /* 不存在就继续往上找 */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p); // 到根了还是不存在，原样返回
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/** target 是否在 root 之内（root 自身算在内） */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

class PathOutOfBoundsError extends Error {
  constructor(target, root) {
    super(
      `路径越界：${target}\n` +
        `Agent 只能操作工作区内的文件，当前工作区是 ${root}。\n` +
        `如果确实需要操作别处，请先把工作区切换到那个目录。`
    );
    this.name = 'PathOutOfBoundsError';
    this.code = 'OUT_OF_BOUNDS';
  }
}

/**
 * 把模型给的路径解析成工作区内的绝对路径。
 * 相对路径按工作区根解析；越界直接抛 PathOutOfBoundsError。
 */
function resolveInWorkspace(root, p, { mustExist = false } = {}) {
  if (p === undefined || p === null || String(p).trim() === '') {
    const e = new Error('缺少 path 参数');
    e.code = 'BAD_ARGS';
    throw e;
  }
  const raw = String(p).trim();
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const real = realpathBestEffort(abs);

  if (!isInside(root, real)) throw new PathOutOfBoundsError(abs, root);

  if (mustExist && !fs.existsSync(real)) {
    const e = new Error(`路径不存在：${real}`);
    e.code = 'ENOENT_TOOL';
    throw e;
  }
  return real;
}

/* ============================================================
 * 二、危险命令识别
 * ============================================================ */

/**
 * 危险特征表。每条 = { re: 正则, why: 给用户看的原因 }。
 *
 * 宁可多报也别漏报：漏报的代价是数据没了，多报的代价只是点一下「允许」。
 * 但也不要过度：像 `dir` / `type` / `git status` 这类读操作绝不该弹窗，
 * 否则用户很快就会养成「无脑点允许」的习惯，那这层防护就形同虚设。
 */
const DANGER_RULES = [
  // —— 删除类 ——
  { re: /\brm\b(?=[^\n]*\s-)[^\n]*\s-[a-z]*[rf]/i, why: '递归或强制删除（rm -rf）' },
  { re: /\brm\b[^\n]*\s--(recursive|force|no-preserve-root)/i, why: '递归或强制删除' },
  { re: /\b(rmdir|rd)\b[^\n]*\s\/s/i, why: '递归删除目录（rmdir /s）' },
  { re: /\bdel\b[^\n]*\s\/[a-z]*[fsq]/i, why: '强制或递归删除文件（del /f /s /q）' },
  { re: /\berase\b[^\n]*\s\/[a-z]*[fsq]/i, why: '强制删除文件' },
  { re: /\bRemove-Item\b[^\n]*\s-(Recurse|Force|r|f)\b/i, why: 'PowerShell 递归或强制删除' },
  { re: /\bgit\s+clean\b[^\n]*\s-[a-z]*[fd]/i, why: 'git clean 会删掉未跟踪文件' },
  { re: /\bgit\s+reset\b[^\n]*--hard/i, why: 'git reset --hard 会丢弃本地改动' },
  { re: /\bgit\s+push\b[^\n]*(--force\b|-f\b)/i, why: '强推会覆盖远端历史' },
  { re: /\bgit\s+checkout\b[^\n]*--\s+\S/i, why: 'git checkout -- 会丢弃指定文件的改动' },

  // —— 磁盘 / 引导 / 分区 ——
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区工具' },
  { re: /\b(mkfs(\.\w+)?|dd\s+if=|sdelete|cipher\s+\/w)\b/i, why: '磁盘级擦写操作' },
  { re: /\b(bcdedit|bootrec|bootsect)\b/i, why: '修改引导配置，可能导致系统无法启动' },

  // —— 系统状态 ——
  { re: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, why: '关机或重启' },
  { re: /\breg\s+(delete|add|import|restore)\b/i, why: '修改注册表' },
  { re: /\bregedit\b/i, why: '打开注册表编辑器' },
  { re: /\b(taskkill|Stop-Process)\b/i, why: '强制结束进程' },
  { re: /\b(sc\s+(delete|stop|config)|Stop-Service|Set-Service)\b/i, why: '改动系统服务' },
  { re: /\bnet\s+(user|localgroup|share)\b/i, why: '改动账户、用户组或共享' },
  { re: /\b(New-LocalUser|Set-LocalUser|Add-LocalGroupMember)\b/i, why: '改动本机账户' },
  { re: /\b(takeown|icacls|cacls)\b/i, why: '改动文件权限与所有权' },
  { re: /\battrib\b[^\n]*\s[+-][rhs]/i, why: '改动文件属性' },
  { re: /\bSet-ExecutionPolicy\b/i, why: '改动脚本执行策略' },
  { re: /\bwmic\b[^\n]*\bdelete\b/i, why: '通过 WMI 删除对象' },

  // —— 下载即执行（最典型的供应链攻击形态）——
  {
    re: /\b(iwr|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^\n]*\|\s*(iex|Invoke-Expression|bash|sh|zsh|python)\b/i,
    why: '从网络下载内容并直接执行',
  },
  { re: /\b(iex|Invoke-Expression)\b[^\n]*(http|DownloadString)/i, why: '从网络下载内容并直接执行' },
  { re: /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i, why: '从网络下载内容并直接执行' },

  // —— 写入工作区之外 ——
  { re: />\s*[a-z]:\\(?!.*<)/i, why: '重定向写入盘符根路径' },
  { re: /\bout-file\b[^\n]*\s[a-z]:\\/i, why: '写出到工作区之外' },
  { re: /\bcopy\b[^\n]*\s[a-z]:\\[^\n]*\s[a-z]:\\/i, why: '跨盘复制' },
  { re: /\bmove\b[^\n]*\s[a-z]:\\/i, why: '移动文件到盘符根路径' },

  // —— 其它 ——
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: 'fork 炸弹' },
  { re: /\bnpm\s+publish\b/i, why: '发布包到 npm' },
  { re: /\b(pip|pip3)\s+install\b/i, why: '安装 Python 包（会改动环境）' },
];

/** 判断一条命令是否危险，返回 { dangerous, reasons[] } */
function classifyCommand(command) {
  const cmd = String(command || '');
  const reasons = [];
  for (const rule of DANGER_RULES) {
    if (rule.re.test(cmd)) reasons.push(rule.why);
  }
  return { dangerous: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/* ============================================================
 * 三、权限模式
 * ============================================================ */

/**
 * 三档权限，对齐 Codex 的心智模型：
 *   read-only —— 只读。只能 read_file / list_dir / search_files。
 *   auto      —— 默认。读写与命令都放行，但危险操作要人工确认。
 *   full      —— 全部放行。注意：路径围栏依然生效，只是不再弹确认。
 */
const MODES = ['read-only', 'auto', 'full'];

const MODE_LABELS = {
  'read-only': '只读',
  auto: '自动',
  full: '完全放行',
};

function isValidMode(m) {
  return MODES.includes(m);
}

module.exports = {
  normalizeRoot,
  realpathBestEffort,
  isInside,
  resolveInWorkspace,
  PathOutOfBoundsError,
  classifyCommand,
  DANGER_RULES,
  MODES,
  MODE_LABELS,
  isValidMode,
};
