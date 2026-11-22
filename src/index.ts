/**
 * dsh-tg-archiver — 把 telegram-channel-archiver（Python CLI）包装成 DSH 原生工具。
 * 设计原则：插件不复制下载逻辑，只做「进程编排 + 状态读取 + 结果裁剪」。
 * 所有资源挂 ctx.effect，热重载/卸载自动清理。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = '@lanbaolu/dsh-tg-archiver'
export const inject = ['tools']

export interface Config {
  /** tgarchiver 工具目录（含 tgarchiver.py 与 state/） */
  tgHome: string
  /** Python 解释器；留空则按 TG_PYTHON 环境变量、再按 python 兜底 */
  pythonPath: string
  /** 状态目录；留空则 <tgHome>/state */
  stateDir: string
}

export const Config = z.object({
  tgHome: z.string().default(''),
  pythonPath: z.string().default(''),
  stateDir: z.string().default(''),
})

function home(c: Config): string {
  return c.tgHome || process.env.TGARCHIVER_HOME || process.env.TG_BATCH_DOWNLOAD_HOME || ''
}

function py(c: Config): string {
  return c.pythonPath || process.env.TG_PYTHON || 'python'
}

function stateOf(c: Config): string {
  const h = home(c)
  return c.stateDir || (h ? path.join(h, 'state') : '')
}

function readJson<T = any>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return null }
}

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(i === 1 ? 0 : 2)) + ' ' + u[i]
}

function fmtSpeed(bps: number): string {
  const tiers: [number, string][] = [[10 * 1024, '很慢'], [300 * 1024, '偏慢'], [1024 * 1024, '一般'], [3 * 1024 * 1024, '良好'], [Infinity, '很快']]
  const label = tiers.find(([t]) => bps < t)![1]
  return fmtBytes(bps) + '/s · ' + label
}

function tail(p: string, n = 8): string[] {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-n)
  } catch { return [] }
}

/** 跑一次 CLI 并收集输出（短任务：new / index / list） */
function runCli(c: Config, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const h = home(c)
  if (!h) return Promise.resolve({ code: null, out: '未配置工具目录：请在插件设置里填 tgarchiver 的安装目录（含 tgarchiver.py）' })
  const cli = path.join(h, 'tgarchiver.py')
  if (!fs.existsSync(cli)) return Promise.resolve({ code: null, out: '找不到 ' + cli })
  return new Promise((resolve) => {
    const p = spawn(py(c), ['-u', cli, ...args], { cwd: h, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    let out = ''
    const t = setTimeout(() => { try { p.kill() } catch { /* noop */ } }, timeoutMs)
    p.stdout.on('data', (b) => { out += String(b) })
    p.stderr.on('data', (b) => { out += String(b) })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: out + '\n' + e.message }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
  })
}

function summarizeStatus(c: Config, job?: string): string {
  const sd = stateOf(c)
  if (!sd) return '未配置工具目录：请在插件设置里填 tgarchiver 的安装目录'
  const jobsDir = path.join(sd, 'jobs')
  const names: string[] = fs.existsSync(jobsDir)
    ? fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    : []
  if (!job) {
    if (!names.length) return '还没有任务。用 tg_archive_new 建一个（需要频道 + 输出目录）。'
    const rows = names.map((n) => {
      const s = readJson<any>(path.join(sd, n + '_speed.json'))
      if (!s) return '- ' + n + '：尚未运行'
      return '- ' + n + '：' + fmtSpeed(Number(s.bps) || 0) + '，已完成 ' + (s.files_done ?? '?') + '/' + (s.files_total ?? '?') + '，本次累计 ' + (s.session_mb ?? '?') + ' MB，线路 ' + (s.proxy ?? '?')
    })
    return '任务（' + names.length + '）：\n' + rows.join('\n')
  }
  const s = readJson<any>(path.join(sd, job + '_speed.json'))
  const prog = readJson<Record<string, any>>(path.join(sd, job + '_progress.json')) || {}
  const inflight = Object.keys(prog).filter((k) => k !== '#names')
  const parts: string[] = []
  if (s) {
    parts.push('任务 ' + job)
    parts.push('速度：' + fmtSpeed(Number(s.bps) || 0) + '（' + (s.mbps ?? 0) + ' MB/s）')
    parts.push('进度：已完成 ' + (s.files_done ?? 0) + ' / 共 ' + (s.files_total ?? 0) + '，本次累计 ' + (s.session_mb ?? 0) + ' MB')
    if (s.current) parts.push('当前：' + s.current)
    parts.push('线路：' + (s.proxy ?? '?') + '，失败计数 ' + (s.fail ?? 0))
    parts.push('遥测时间：' + (s.ts ?? '?'))
    const ageSec = s.ts ? (Date.now() - new Date(String(s.ts).replace(' ', 'T')).getTime()) / 1000 : NaN
    if (Number.isFinite(ageSec) && ageSec > 60) parts.push('警告：遥测已过期 ' + Math.round(ageSec) + ' 秒 —— 下载进程可能已退出')
  } else {
    parts.push('任务 ' + job + ' 还没有遥测（可能从未运行）。')
  }
  if (inflight.length) parts.push('进行中分片文件：' + inflight.length + ' 个')
  const log = tail(path.join(sd, job + '.log'), 6)
  if (log.length) parts.push('最近日志：\n' + log.map((l) => '  ' + l).join('\n'))
  return parts.join('\n')
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tg_archive_env',
    description: '自检 tgarchiver 运行环境（工具目录 / Python / telethon / 登录会话 / .env），出问题先跑它。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute() {
      const h = home(config)
      const sd = stateOf(config)
      const chk = h ? path.join(h, 'skill', 'tgarchiver', 'scripts', 'check_env.py') : ''
      if (chk && fs.existsSync(chk)) {
        const r = await runCliRaw(config, [chk], 60000)
        return r.out + '\n\n（由 skill/tgarchiver/scripts/check_env.py 生成）'
      }
      return [
        '工具目录：' + (h || '未配置'),
        'Python：' + py(config),
        '状态目录：' + (sd || '未配置'),
        '提示：工具目录里没有 skill/tgarchiver/scripts/check_env.py，只能做浅检查。',
      ].join('\n')
    },
  })), 'dsh-tg-archiver: env')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tg_archive_status',
    description: '读下载进度与速度（省略 job 则列出全部任务）。',
    parameters: {
      job: { type: 'string', description: '任务名；留空列全部' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { job?: string }) {
      return summarizeStatus(config, args.job)
    },
  })), 'dsh-tg-archiver: status')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tg_archive_index',
    description: '扫频道索引，返回命中条数与总体积（不下载）。',
    parameters: {
      job: { type: 'string', required: true, description: '任务名' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { job: string }) {
      const r = await runCli(config, ['index', args.job], 900000)
      return 'exit=' + r.code + '\n' + r.out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
    },
  })), 'dsh-tg-archiver: index')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tg_archive_run',
    description: '启动或停止后台下载进程（start 立即返回，进度用 tg_archive_status 看）。',
    parameters: {
      job: { type: 'string', required: true, description: '任务名' },
      action: { type: 'string', description: 'start（默认）或 stop' },
      limit: { type: 'number', description: '只处理前 N 个文件（试跑）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { job: string; action?: string; limit?: number }) {
      const sd = stateOf(config)
      const act = args.action || 'start'
      if (act === 'stop') {
        const pidFile = path.join(sd, args.job + '_run.pid')
        const pid = Number((readJson<any>(pidFile) || {}).pid || 0)
        if (!pid) return '没有记录到运行中的进程（' + pidFile + ' 不存在或为空）'
        try {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          fs.rmSync(pidFile, { force: true })
          return '已请求结束进程树 pid=' + pid
        } catch (e: any) {
          return '停止失败：' + (e?.message || String(e))
        }
      }
      const argl = ['-u', path.join(home(config), 'tgarchiver.py'), 'run', args.job]
      if (args.limit) argl.push('--limit', String(args.limit))
      const logFile = path.join(sd, args.job + '_run.log')
      fs.mkdirSync(sd, { recursive: true })
      const out = fs.openSync(logFile, 'a')
      const p = spawn(py(config), argl, {
        cwd: home(config), detached: true, windowsHide: true, stdio: ['ignore', out, out],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      p.unref()
      fs.writeFileSync(path.join(sd, args.job + '_run.pid'), JSON.stringify({ pid: p.pid, at: new Date().toISOString() }))
      return '已启动 pid=' + p.pid + '，日志 ' + logFile + '\n首轮建连约 10~30 秒后 tg_archive_status 才有数据。'
    },
  })), 'dsh-tg-archiver: run')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tg_archive_new',
    description: '建下载任务（频道 + 输出目录 + 筛选方式），同名任务已存在会拒绝。',
    parameters: {
      name: { type: 'string', required: true, description: '任务名' },
      channel: { type: 'string', required: true, description: '@name 或 https://t.me/name' },
      out: { type: 'string', required: true, description: '输出目录，支持 UNC' },
      selector: { type: 'string', description: 'caption（默认）/ keyword / all' },
      nameMode: { type: 'string', description: 'caption（默认）/ orig / msgid' },
      keywords: { type: 'string', description: 'selector=keyword 时的关键词，逗号分隔' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { name: string; channel: string; out: string; selector?: string; nameMode?: string; keywords?: string }) {
      const a = ['new', '--name', args.name, '--channel', args.channel, '--out', args.out,
        '--selector', args.selector || 'caption', '--name-mode', args.nameMode || 'caption']
      if (args.keywords) a.push('--keywords', args.keywords)
      const r = await runCli(config, a, 120000)
      return 'exit=' + r.code + '\n' + r.out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n') +
        (r.code === 0 ? '\n下一步：tg_archive_index 看命中多少，再 tg_archive_run 开下。' : '')
    },
  })), 'dsh-tg-archiver: new')
}

/** 直接跑一个 python 脚本（不算 CLI 子命令） */
function runCliRaw(c: Config, scriptArgs: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(py(c), scriptArgs, { cwd: home(c), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    let out = ''
    const t = setTimeout(() => { try { p.kill() } catch { /* noop */ } }, timeoutMs)
    p.stdout.on('data', (b) => { out += String(b) })
    p.stderr.on('data', (b) => { out += String(b) })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: out + e.message }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
  })
}
