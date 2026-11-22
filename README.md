# dsh-tg-archiver —— Telegram 频道批量归档的 DSH 原生工具

> **一句话**：把 Python 写的 `telegram-channel-archiver` 命令行工具，包装成 5 个能在 DSH 里直接调用的原生工具（自检环境 / 看进度 / 扫索引 / 启停下载 / 建任务），让你不用记命令行参数、不用开着终端就能管理频道归档任务。
>
> **适合谁**：已经在用 DSH（DeepSeek Harness）做日常自动化、又想批量归档 Telegram 频道视频与文件的人。
>
> **解决什么问题**：归档工具本身是 Python CLI，参数多（频道、输出目录、筛选方式、命名规则、关键词），跑起来还得盯日志。这个插件把「进程编排 + 状态读取 + 结果裁剪」包成工具调用，**不复制下载逻辑**，Python 侧改了插件自动跟着生效。

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 前置条件与安装](#2-前置条件与安装)
- [3. 5 个工具逐项说明](#3-5-个工具逐项说明)
- [4. 完整操作示例](#4-完整操作示例)
- [5. 配置详解](#5-配置详解)
- [6. 工作原理](#6-工作原理)
- [7. 排错手册](#7-排错手册)
- [8. 常见问题 FAQ](#8-常见问题-faq)
- [9. 目录结构](#9-目录结构)
- [10. 开发与构建](#10-开发与构建)
- [11. 已知限制与安全说明](#11-已知限制与安全说明)
- [12. 许可](#12-许可)

---

## 1. 这是什么

| 项目 | 内容 |
|---|---|
| 包名 | `@lanbaolu/dsh-tg-archiver` |
| 版本 | 0.0.1 |
| 类型 | DSH 插件（cordis 插件，TypeScript 编写） |
| 入口 | `lib/index.js`（由 `src/index.ts` 构建） |
| 注入依赖 | `export const inject = ['tools']` |
| 依赖的外部程序 | `telegram-channel-archiver`（Python CLI，**不在本包内**） |
| 工具数量 | 5 个 |
| 源码规模 | src/index.ts 260 行，lib/index.js 209 行 |
| 许可 | AGPL-3.0 |

### 设计原则（源码注释原文）

> 插件不复制下载逻辑，只做「进程编排 + 状态读取 + 结果裁剪」。所有资源挂 `ctx.effect`，热重载/卸载自动清理。

这句话很重要：它意味着**本插件自己一行下载代码都没有**，TG 协议、分片续传、代理池全在 Python 那侧。插件只负责 spawn 进程、读状态文件、把结果整理成人能看懂的一段文字。

---

## 2. 前置条件与安装

### 2.1 必须先有 Python 侧工具

本插件**不能单独工作**。你需要先准备好 `telegram-channel-archiver` 目录，里面至少有：

| 文件 / 目录 | 作用 |
|---|---|
| `tgarchiver.py` | 被插件 spawn 的主程序（`tg_archive_run` 直接调它） |
| `state/` | 任务状态与日志目录（默认状态目录） |
| `skill/tgarchiver/scripts/check_env.py` | 环境自检脚本（有它 `tg_archive_env` 才能做完整检查） |
| `.env` | TG API ID / HASH / 会话（**凭据，不要提交到仓库**） |

这个 Python 工具在另一个仓库：<https://github.com/duma520/telegram-channel-archiver>。

### 2.2 装本插件

本插件通过 DSH 的 bundle 机制加载，`package.json` 里声明了：

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

即 DSH 启动时读 `cordis.patch.yml` 把这个插件挂进运行时。安装方式按你所用 DSH 版本的插件安装流程（通常是放进插件目录或通过 `npm` 链接），装好后**重启 DSH**，在工具列表里应能看到 `tg_archive_*` 开头的 5 个工具。

### 2.3 配一次路径

见 [第 5 节 配置详解](#5-配置详解)。最少只需要设 `tgHome` 指向 Python 工具目录。

---

## 3. 5 个工具逐项说明

### 3.1 `tg_archive_env` —— 环境自检

| 项 | 内容 |
|---|---|
| 参数 | 无 |
| 返回 | 一段文本：工具目录 / Python 解释器 / 状态目录 / telethon 是否装好 / 会话是否已登录 / .env 是否就位 |
| 什么时候用 | **出任何问题先跑它**。它是唯一能不下载就告诉你「哪里没配好」的工具 |

实现细节：优先执行 `<tgHome>/skill/tgarchiver/scripts/check_env.py`，超时 60 秒；如果这个脚本不存在，就退化成浅检查（只报三个配置路径 + 一句提示）。

### 3.2 `tg_archive_status` —— 看进度

| 项 | 内容 |
|---|---|
| 参数 | `job`（任务名，留空则列出全部任务） |
| 返回 | 每个任务的已完成数 / 总数 / 已下载体积 / 当前速度（带「很慢 / 偏慢 / 正常」等口语化评价）/ 最近几行日志 |
| 什么时候用 | 下载启动后每隔一会儿刷一次；或忘了自己有哪些任务 |

速度评价的实现是分档的：低于 10 KB/s 算「很慢」、低于 300 KB/s 「偏慢」、1 MB/s 以上算正常档（具体分档见 `fmtSpeed`）。

### 3.3 `tg_archive_index` —— 扫索引（不下载）

| 项 | 内容 |
|---|---|
| 参数 | `job`（必填，任务名） |
| 返回 | `exit=<返回码>` + 最后一行为止的输出（命中条数、总体积） |
| 超时 | 900 秒（15 分钟）—— 大频道扫全量索引确实慢 |
| 什么时候用 | **正式下载前必跑**。先看清有多少条、多大，再决定要不要限流或缩范围 |

它内部调 `tgarchiver.py index <job>`。

### 3.4 `tg_archive_run` —— 启停下载

| 项 | 内容 |
|---|---|
| 参数 | `job`（必填）、`action`（`start` 默认 / `stop`）、`limit`（只处理前 N 个，试跑用） |
| 返回 | start：立即返回 `pid=N` 与日志路径；stop：返回「已请求结束进程树 pid=N」 |
| 关键行为 | **start 是立刻返回的**，不等下载完。进度靠 `tg_archive_status` 另查 |

实现要点：

- 用 `spawn(py, ['-u', '<tgHome>/tgarchiver.py', 'run', job], {detached: true, stdio: ['ignore', out, out]})` 拉起后台进程，`-u` 保证 Python 输出不缓冲（否则日志半天不刷新）。
- stdout / stderr 都追加写到 `<stateDir>/<job>_run.log`。
- 进程号写到 `<stateDir>/<job>_run.pid`（JSON，含 `pid` 与 `at` 时间戳）。
- stop 读这个 pid 文件，`taskkill /PID <pid> /T /F` 连子进程一起杀，然后删掉 pid 文件。
- 环境变量强制 `PYTHONIOENCODING=utf-8` 与 `PYTHONUTF8=1`，避免中文日志在 Windows 下乱码。

> 首轮建连约 10~30 秒后 `tg_archive_status` 才会有数据，刚点完立刻查是空的，这是正常现象。

### 3.5 `tg_archive_new` —— 建任务

| 项 | 内容 |
|---|---|
| 参数 | `name`（任务名，必填）、`channel`（`@name` 或 `https://t.me/name`，必填）、`out`（输出目录，必填，支持 UNC 路径）、`selector`（`caption` 默认 / `keyword` / `all`）、`nameMode`（`caption` 默认 / `orig` / `msgid`）、`keywords`（关键词，配合 selector=keyword） |
| 返回 | 建任务结果 |
| 注意 | **同名任务已存在会被拒绝**，不会覆盖 |

三个 selector 的区别：

| selector | 含义 |
|---|---|
| `caption` | 只下载文案里能匹配到的（默认） |
| `keyword` | 按 `keywords` 里给的关键词筛 |
| `all` | 全部下载，不筛 |

三个 nameMode 的区别：

| nameMode | 落盘文件名怎么取 |
|---|---|
| `caption` | 用消息文案（默认） |
| `orig` | 用原始文件名 |
| `msgid` | 用消息 ID，最不容易撞名 |

---

## 4. 完整操作示例

### 示例 A：最小用法（第一次跑通）

```text
1) tg_archive_env
   → 确认「工具目录 / Python / 登录会话 / .env」全绿

2) tg_archive_new  name=demo  channel=@somechannel  out=D:\TG\demo  selector=all
   → 建好名为 demo 的任务

3) tg_archive_index  job=demo
   → 看清有多少条、共多大（可能要等几分钟）

4) tg_archive_run  job=demo  limit=3
   → 只下前 3 个，验证路径、命名、速度都正常

5) tg_archive_status  job=demo
   → 看到「3/3」就说明链路通了
```

### 示例 B：常见组合（按关键词挑，全量下载）

```text
tg_archive_new  name=lesson  channel=https://t.me/xxx  out=\\nas\media\lesson \
                selector=keyword  keywords=课程,第1讲,第2讲  nameMode=caption
tg_archive_index job=lesson
tg_archive_run   job=lesson
tg_archive_status job=lesson          # 隔一会儿再刷
tg_archive_run   job=lesson  action=stop   # 想停随时停
```

> 注意 `out` 支持 UNC（`\\主机\共享`），可以直接落到 NAS。路径里带空格也可以，插件是作为独立参数传的，不会被拆词。

### 示例 C：进阶玩法（网络慢时先试跑再全量）

```text
tg_archive_run  job=lesson  limit=10
tg_archive_status job=lesson
   → 看速度分档：如果显示「很慢」（<10KB/s），先别全量
tg_archive_run  job=lesson  action=stop
   → 挂代理 / 换时段，再重来
tg_archive_run  job=lesson
```

---

## 5. 配置详解

配置 schema 来自 `src/index.ts` 的 `Config` 定义（schemastery，`z.object`）：

| 字段 | 类型 | 默认值 | 作用 | 回退顺序 |
|---|---|---|---|---|
| `tgHome` | string | `''` | tgarchiver 工具目录（含 `tgarchiver.py` 与 `state/`） | 配置值 → 环境变量 `TGARCHIVER_HOME` → `TG_BATCH_DOWNLOAD_HOME` → 空 |
| `pythonPath` | string | `''` | Python 解释器 | 配置值 → 环境变量 `TG_PYTHON` → `python` |
| `stateDir` | string | `''` | 状态目录（pid / log / 任务状态） | 配置值 → `<tgHome>/state` → 空 |

### 配置示例

仓库里的 `settings.example.json`（照抄改名 `settings.json` 即可）：

```json
{
  "tgHome": "G:\\Python_Code\\telegram-channel-archiver",
  "pythonPath": "python"
}
```

### 改错会怎样

| 配错的字段 | 症状 |
|---|---|
| `tgHome` 指向不存在的目录 | `tg_archive_env` 报「未配置」；`tg_archive_run` 起进程后立即失败（找不到 tgarchiver.py），日志里是 `can't open file` |
| `pythonPath` 指向不存在的解释器 | `spawn` 抛 ENOENT；日志文件为空 |
| `pythonPath` 指到没有 telethon 的环境 | 进程能起但立即退出，日志里有 `ModuleNotFoundError: No module named 'telethon'` |
| `stateDir` 指向无写权限目录 | 建 pid / log 失败，工具返回「停止失败」或 start 无输出 |

---

## 6. 工作原理

```text
DSH 调用 tg_archive_xxx
      |
      +-- home(config) / py(config) / stateOf(config)  → 解析三个路径
      |
      +-- spawn(python, [tgarchiver.py, <子命令>, <任务名>])
      |        |
      |        +-- stdout+stderr → <stateDir>/<job>_run.log
      |        +-- pid → <stateDir>/<job>_run.pid
      |
      +-- 读 state 文件 → 裁剪成一段中文文本返回
```

### 关键约束

1. **所有资源挂 `ctx.effect`**：每个 `ctx.effect(() => ctx.tools.register(...), 'dsh-tg-archiver: <名字>')` 都带一个字符串标识，热重载或卸载时框架按这个标识回收，不会留下重复注册的工具。
2. **不阻塞 DSH 主线程**：跑下载用的是 `detached: true` + `p.unref()`，工具调用立即返回，DSH 不会被一个跑几小时的下载卡住。
3. **超时分级**：env 自检 60 秒；index 900 秒；run 是 0 秒（立即返回）。改代码时不要把所有子命令都设成同一个超时。
4. **编码统一**：起进程时注入 `PYTHONIOENCODING=utf-8` 与 `PYTHONUTF8=1`，否则 Windows 下中文文案会按 GBK 写出乱码日志。

---

## 7. 排错手册

| 现象 | 原因 | 解决 |
|---|---|---|
| 工具列表里根本没有 `tg_archive_*` | 插件没加载 | 确认 `cordis.patch.yml` 在，重启 DSH；看启动日志有没有本包名 |
| `tg_archive_env` 说「未配置」 | `tgHome` 空 | 填配置或用环境变量 `TGARCHIVER_HOME` |
| `tg_archive_run` 返回 pid 但状态一直是 0 | Python 侧建连失败 / 没登录 | 看 `<stateDir>/<job>_run.log`，常见是 `AuthKeyUnregisteredError` 或手机号未验证 |
| status 里速度永远是「很慢」 | 代理不通或带宽不足 | 换代理；参考 Python 侧 README 的代理池说明 |
| `tg_archive_index` 超时 | 频道太大，15 分钟扫不完 | 先在 Python 侧用更窄的筛选（selector=keyword）再 index |
| stop 报「没有记录到运行中的进程」 | pid 文件不存在（进程已自然结束，或状态目录被清） | 用任务管理器按 python 进程名手动确认，没有就不用管 |
| stop 报「已请求结束」但进程还在 | `taskkill /T /F` 被权限拦 | 用管理员身份重启 DSH，或手动任务管理器结束 |
| 日志中文乱码 | 编码环境没生效 | 确认没在自定义 spawn 里覆盖 env；保留 `PYTHONUTF8=1` |

---

## 8. 常见问题 FAQ

**Q1：这个插件会自己下载吗？**
A：不会。`src/index.ts` 顶部注释明确写了「插件不复制下载逻辑，只做进程编排 + 状态读取 + 结果裁剪」，所以下载能力完全取决于 Python 侧工具在不在、配没配对。

**Q2：能同时跑多个任务吗？**
A：可以，每个任务有独立的 `<job>_run.pid` 与 `<job>_run.log`。但两个任务写同一个输出目录会有撞名风险，建议分开目录。

**Q3：能不能不开 DSH 直接跑？**
A：能，直接在 Python 侧 `python tgarchiver.py run <job>`。本插件只是外壳，不是必需品。

**Q4：为什么 start 不告诉我下载了多少？**
A：因为它是异步的（`detached: true`），设计上就不等。要进度必须另调 `tg_archive_status`。

**Q5：任务配置存在哪？**
A：Python 侧的 `<tgHome>/state/`（或你配的 `stateDir`），不是存在插件里。插件本身不落任何业务数据。

**Q6：换机器要重新建任务吗？**
A：把 Python 侧的 `state/` 目录整个带走就不用；只拷插件没用，因为任务定义在 Python 那侧。

**Q7：支持 macOS / Linux 吗？**
A：**不支持**。`stop` 用的是 Windows 的 `taskkill /PID /T /F`，非 Windows 平台这个工具会失败（start 仍可用）。

**Q8：插件会不会把 .env 里的凭据读走？**
A：不会。它只读 `state/` 下的 pid / log / 状态文件，`.env` 是 Python 进程自己读的。插件代码里没有任何读取 `.env` 的语句。

**Q9：为什么要设置 900 秒的 index 超时？**
A：大频道扫全量索引是逐个消息翻页的，几千条就要几分钟。给短了会误判超时。

**Q10：升级 Python 侧工具，插件要跟着改吗？**
A：只要 `tgarchiver.py` 的 `index` / `run` 子命令名和 `state/` 下的文件名不变，就不用。改了命令名或状态文件格式，才需要同步改插件。

---

## 9. 目录结构

```text
dsh-tg-archiver/
├── src/index.ts            # 源码（260 行）
├── lib/index.js            # 构建产物（209 行，package.json main 指向它）
├── scripts/build.sh        # 构建脚本
├── cordis.patch.yml        # DSH bundle 加载声明
├── settings.example.json   # 配置示例（tgHome / pythonPath）
├── settings.json           # 你本机的实际配置（**含本地路径，勿提交**）
├── package.json            # 包元数据 + dsh.bundle 声明
└── README.md               # 本文件
```

---

## 10. 开发与构建

```bash
# 构建（把 src/index.ts 编成 lib/index.js）
bash scripts/build.sh

# 或者直接用 tsc（如果有）
npx tsc src/index.ts --outDir lib
```

改代码注意三点：

1. 新增工具必须包在 `ctx.effect(() => ctx.tools.register(...), '<包名>: <用途>')` 里，否则热重载会重复注册。
2. 所有工具返回类型都是 `string`（`output.schema = {type: 'string'}`），`render` 里直接 `String(v)`。想返回结构化数据要先改 schema。
3. 别在 `execute` 里 `await` 一个跑很久的子进程；要长任务就学 `tg_archive_run` 用 detached + unref。

---

## 11. 已知限制与安全说明

- **Windows only**：stop 依赖 `taskkill`。
- **不自带下载能力**：必须配 Python 侧工具，否则 5 个工具大部分不可用。
- **状态解析依赖文件名约定**：插件读 `<job>_run.pid` / `<job>_run.log` / `state/` 下的状态文件，Python 侧改了命名就断。
- **无鉴权隔离**：任何能调 DSH 工具的人都能建任务、启停下载，没有角色权限。
- **凭据不落地**：插件不读不写 `.env`；但 Python 侧会读，请确保 `.env` 已进 `.gitignore`。
- **本仓库不含凭据**：`settings.json` 只放本地路径，无 token / 无 API HASH。

---

## 12. 许可

AGPL-3.0（见 `package.json` 的 `license` 字段）。
