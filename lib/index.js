/**
 * @lanbaolu/dsh-tg-archiver — 把 telegram-channel-archiver（Python CLI）包装成 DSH 原生工具。
 * 纯 JS、零构建：本机没有 DSH 源码 checkout，也解析不到 tsc（dev_build_plugin 直接报错），
 * 沿用 dsh-composer-butler 的「手写 ESM + ctx.tools.register 纯对象」路线。
 * 配置：插件目录 settings.json（实时落盘）→ 环境变量 TGARCHIVER_HOME / TG_PYTHON。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETTINGS = path.join(ROOT, 'settings.json')

export const name = '@lanbaolu/dsh-tg-archiver'
export const inject = ['tools']

function settings() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch { s = {} }
  const home = s.tgHome || process.env.TGARCHIVER_HOME || process.env.TG_BATCH_DOWNLOAD_HOME || ''
  const python = s.pythonPath || process.env.TG_PYTHON || 'python'
  const state = s.stateDir || (home ? path.join(home, 'state') : '')
  return { home, python, state }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(n) || 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(i === 1 ? 0 : 2)) + ' ' + u[i]
}

function speedLabel(bps) {
  const b = Number(bps) || 0
  const tiers = [[10 * 1024, '很慢'], [300 * 1024, '偏慢'], [1024 * 1024, '一般'], [3 * 1024 * 1024, '良好'], [Infinity, '很快']]
  return fmtBytes(b) + '/s · ' + tiers.find(([t]) => b < t)[1]
}

function tailLines(p, n) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-(n || 6))
  } catch { return [] }
}

const NO_HOME = '未配置工具目录：在插件目录 settings.json 写 {"tgHome": "<tgarchiver 安装目录>"}，或设环境变量 TGARCHIVER_HOME。'

function runPy(python, argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(python, argv, {
      cwd, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let out = ''
    const t = setTimeout(() => { try { p.kill() } catch (e) { /* noop */ } }, timeoutMs)
    p.stdout.on('data', (b) => { out += String(b) })
    p.stderr.on('data', (b) => { out += String(b) })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: out + e.message }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
  })
}

async function runCli(argv, timeoutMs) {
  const s = settings()
  if (!s.home) return { code: null, out: NO_HOME }
  const cli = path.join(s.home, 'tgarchiver.py')
  if (!fs.existsSync(cli)) return { code: null, out: '找不到：' + cli }
  return runPy(s.python, ['-u', cli, ...argv], s.home, timeoutMs)
}

function statusText(job) {
  const s = settings()
  if (!s.state) return NO_HOME
  const jobsDir = path.join(s.state, 'jobs')
  const names = fs.existsSync(jobsDir)
    ? fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    : []
  if (!job) {
    if (!names.length) return '还没有任务。用 tg_archive_new 建一个（需要频道 + 输出目录）。\n工具目录：' + (s.home || '未配置')
    const rows = names.map((n) => {
      const sp = readJson(path.join(s.state, n + '_speed.json'))
      if (!sp) return '- ' + n + '：尚未运行'
      return '- ' + n + '：' + speedLabel(sp.bps) + '，已完成 ' + (sp.files_done ?? '?') + '/' + (sp.files_total ?? '?') +
        '，本次累计 ' + (sp.session_mb ?? '?') + ' MB，线路 ' + (sp.proxy ?? '?')
    })
    return '任务（' + names.length + '）：\n' + rows.join('\n')
  }
  const sp = readJson(path.join(s.state, job + '_speed.json'))
  const prog = readJson(path.join(s.state, job + '_progress.json')) || {}
  const inflight = Object.keys(prog).filter((k) => k !== '#names')
  const out = []
  if (sp) {
    out.push('任务 ' + job)
    out.push('速度：' + speedLabel(sp.bps) + '（' + (sp.mbps ?? 0) + ' MB/s）')
    out.push('进度：已完成 ' + (sp.files_done ?? 0) + ' / 共 ' + (sp.files_total ?? 0) + '，本次累计 ' + (sp.session_mb ?? 0) + ' MB')
    if (sp.current) out.push('当前：' + sp.current)
    out.push('线路：' + (sp.proxy ?? '?') + '，失败计数 ' + (sp.fail ?? 0))
    out.push('遥测时间：' + (sp.ts ?? '?'))
    const age = sp.ts ? (Date.now() - new Date(String(sp.ts).replace(' ', 'T')).getTime()) / 1000 : NaN
    if (Number.isFinite(age) && age > 60) out.push('警告：遥测已过期 ' + Math.round(age) + ' 秒 —— 下载进程可能已退出')
  } else {
    out.push('任务 ' + job + ' 还没有遥测（可能从未运行）。')
  }
  if (inflight.length) out.push('进行中分片文件：' + inflight.length + ' 个')
  const log = tailLines(path.join(s.state, job + '.log'), 6)
  if (log.length) out.push('最近日志：\n' + log.map((l) => '  ' + l).join('\n'))
  return out.join('\n')
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'tg_archive_env',
    description: '自检 tgarchiver 运行环境（工具目录 / Python / telethon / 登录会话 / .env）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      const s = settings()
      const chk = s.home ? path.join(s.home, 'skill', 'tgarchiver', 'scripts', 'check_env.py') : ''
      if (chk && fs.existsSync(chk)) {
        const r = await runPy(s.python, [chk], s.home, 60000)
        return r.out.trim() + '\n（来自 skill/tgarchiver/scripts/check_env.py）'
      }
      return ['工具目录：' + (s.home || '未配置'), 'Python：' + s.python, '状态目录：' + (s.state || '未配置'), NO_HOME].join('\n')
    },
  }), 'dsh-tg-archiver: env')

  ctx.effect(() => ctx.tools.register({
    name: 'tg_archive_status',
    description: '读下载进度与速度（省略 job 则列出全部任务）。',
    parameters: { job: { type: 'string', description: '任务名；留空列全部' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) { return statusText(args && args.job) },
  }), 'dsh-tg-archiver: status')

  ctx.effect(() => ctx.tools.register({
    name: 'tg_archive_index',
    description: '扫频道索引，返回命中条数与总体积（不下载）。',
    parameters: { job: { type: 'string', required: true, description: '任务名' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const r = await runCli(['index', args.job], 900000)
      return 'exit=' + r.code + '\n' + r.out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
    },
  }), 'dsh-tg-archiver: index')

  ctx.effect(() => ctx.tools.register({
    name: 'tg_archive_run',
    description: '启动或停止后台下载进程（start 立即返回，进度用 tg_archive_status 看）。',
    parameters: {
      job: { type: 'string', required: true, description: '任务名' },
      action: { type: 'string', description: 'start（默认）或 stop' },
      limit: { type: 'number', description: '只处理前 N 个文件（试跑）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const s = settings()
      const act = (args && args.action) || 'start'
      if (act === 'stop') {
        const pidFile = path.join(s.state || '', args.job + '_run.pid')
        const pid = Number((readJson(pidFile) || {}).pid || 0)
        if (!pid) return '没有记录到运行中的进程（' + pidFile + ' 不存在或为空）'
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
        fs.rmSync(pidFile, { force: true })
        return '已请求结束进程树 pid=' + pid
      }
      if (!s.home || !fs.existsSync(path.join(s.home, 'tgarchiver.py'))) return NO_HOME
      fs.mkdirSync(s.state, { recursive: true })
      const logFile = path.join(s.state, args.job + '_run.log')
      const fd = fs.openSync(logFile, 'a')
      const argv = ['-u', path.join(s.home, 'tgarchiver.py'), 'run', args.job]
      if (args.limit) argv.push('--limit', String(args.limit))
      const p = spawn(s.python, argv, {
        cwd: s.home, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      p.unref()
      fs.writeFileSync(path.join(s.state, args.job + '_run.pid'), JSON.stringify({ pid: p.pid, at: new Date().toISOString() }))
      return '已启动 pid=' + p.pid + '，日志 ' + logFile + '\n首轮建连约 10~30 秒后 tg_archive_status 才有数据。'
    },
  }), 'dsh-tg-archiver: run')

  ctx.effect(() => ctx.tools.register({
    name: 'tg_archive_new',
    description: '建下载任务（频道 + 输出目录 + 筛选方式）；同名已存在会拒绝。',
    parameters: {
      name: { type: 'string', required: true, description: '任务名' },
      channel: { type: 'string', required: true, description: '@name 或 https://t.me/name' },
      out: { type: 'string', required: true, description: '输出目录，支持 UNC' },
      selector: { type: 'string', description: 'caption（默认）/ keyword / all' },
      nameMode: { type: 'string', description: 'caption（默认）/ orig / msgid' },
      keywords: { type: 'string', description: 'selector=keyword 时用，逗号分隔' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const argv = ['new', '--name', args.name, '--channel', args.channel, '--out', args.out,
        '--selector', args.selector || 'caption', '--name-mode', args.nameMode || 'caption']
      if (args.keywords) argv.push('--keywords', args.keywords)
      const r = await runCli(argv, 120000)
      const body = r.out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
      return 'exit=' + r.code + '\n' + body + (r.code === 0 ? '\n下一步：tg_archive_index 看命中多少，再 tg_archive_run 开下。' : '')
    },
  }), 'dsh-tg-archiver: new')
}
