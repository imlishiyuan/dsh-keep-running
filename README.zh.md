# dsh-keep-running

[English](README.md) | **简体中文**

![npm version](https://img.shields.io/npm/v/dsh-keep-running)
![license](https://img.shields.io/npm/l/dsh-keep-running)

DeepSeek Harness 的 watchdog 插件：遇到 **配额/限流（HTTP 429）** 时，自动创建一个固定间隔的定时任务，到点持续投递「继续任务」的提示，直到任务成功或你手动接手。

> **依赖官方定时任务插件。** 本插件基于 `@deepseek-ai/dsh-schedule` 提供的事件落地，**必须先挂载它**，否则调度创建会被静默丢弃（见 [依赖](#依赖)）。

## 功能

- **自动复活**：配额耗尽（429）时自动建一个 `every` 调度，定时重发「继续」提示；
- **断点记录**：记录最近一条真实用户消息，恢复时能接续上下文；
- **只在不忙时触发**：调度由 schedule 运行时在 agent **空闲**时投递，不会打扰你手动干活；
- **成功即停**：任一 turn 正常结束（配额恢复）时自动删除调度；
- **两条快捷命令**：`/keep-running list`、`/keep-running cancel <id>`（见 [命令](#命令)）。

## 依赖

> ⚠️ **必须**挂载官方定时任务插件 `@deepseek-ai/dsh-schedule`。

keep-running 通过 `agent.session.append('schedule/change', ...)` 落地调度。而 `schedule/change` 事件类型与对应运行时**由 `@deepseek-ai/dsh-schedule` 提供**。若只挂 keep-running 而不挂它，`append` 会被 Session 当作**未知事件类型拒绝** → keep-running **静默失败**，调度不会创建（这是最常见的「没生效」原因）。

## 快速开始

1. 安装插件：

```sh
# A. 官方命令（底层走 pnpm，需先安装 pnpm）
npm i -g pnpm
dsh plugin --profile web add dsh-keep-running

# B. 直接用 npm 装进 profile 目录
cd ~/.dsh/profiles/web    # Windows: C:\Users\<你>\.dsh\profiles\web
npm install dsh-keep-running --save
```

并在同一 profile 安装其依赖插件：

```sh
cd ~/.dsh/profiles/web
npm install @deepseek-ai/dsh-schedule --save
```

2. **在 profile 的 `cordis.patch.yml` 里挂载。** 要*加载*插件必须用 `insert:`，而不是直接写 `- id:`（否则报 `entry "keep-running" not found` 被跳过）。**`dsh-schedule` 要排在 `keep-running` 之前**：

```yaml
- insert:
    - id: dsh-schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: keep-running
      name: 'dsh-keep-running'
      config:
        intervalSeconds: 1800        # 定时任务间隔（秒），最小 300
        continuePrompt: '请继续完成之前未完成的任务：{{task}}'
        quotaKeywords: []            # 空 = 只认 HTTP 429；可加厂商关键词扩展
```

3. 重启 `dsh web`，新建会话即可。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `intervalSeconds` | `1800` | 定时任务间隔（秒），每次到点重发「继续」提示；最小 300 |
| `continuePrompt` | `请继续完成之前未完成的任务：{{task}}` | 每次投递的提示；`{{task}}` 会替换成断点记录（最近一条用户消息，截 200 字）|
| `quotaKeywords` | `[]` | 配额关键词（小写）。`[]` 时**只认 HTTP 429**；要适配其它厂商时填它们的报错关键词 |

### quotaKeywords 说明

默认 `[]` = 只认 HTTP 429（并覆盖 `RATE_LIMIT` / `QUOTA` 这类 code 与 message 里的配额信号）。多厂商部署时，把各家报错的关键词填进来做泛化：

```yaml
config:
  quotaKeywords: ['quota exceeded', 'requests limit', '5-hour usage quota']
```

## 命令

插件注册了独有的 `/keep-running` 命令（独立命名空间，不与未来可能的 `/schedule` 命令冲突）：

- `/keep-running list` —— 列出**当前会话**所有活跃的 keep-running 定时任务（id、间隔、断点、下次时间）。
- `/keep-running cancel <id>` —— 取消指定 id 的定时任务（`id` 从 `list` 结果取）。

命令直接读会话的 `schedule/change` 事件，**不依赖大模型**，配额耗尽时也能用。

## 工作原理

1. 监听 `agent/error`：DeepSeek/OpenAI 的配额 429 在**请求一建立**就被拒，走 `step()`→`turn()` 的 `catch`→`throwError()`，**不触发** `agent/request-error` waterfall（它只在流式 `error` finish 时触发）。真正 emit 的是全局 `agent/error`，其 `payload.error.failure` 才是带 `status` 的 `LlmFailure`。
2. `isQuotaError` 识别配额：HTTP 429、`RATE_LIMIT`/`QUOTA` 稳定 code，或 code/message 里的配额信号，再叠加 `quotaKeywords`。
3. `ensureWatchdog` 追加 `schedule/change`（`kind:'every'`）创建调度；`active` 守卫防重复，并扫描会话做跨进程恢复。
4. 到点投递 `continuePrompt`；任一 turn 正常关闭（配额恢复）时 `turn-stopping` → `stopWatchdog` 停止。

## 使用场景

- 长任务跑到一半撞上「5 小时使用额度」等配额上限，希望自动续跑；
- 配额回来后不想每次手动重开任务；
- 手动开工时不想被打断（调度只在 agent 空闲时投递）；
- 用 `/keep-running list` / `cancel` 随时查看或取消。

## 开发

### 构建

```sh
npm install
npm run build      # 编译 src → lib/index.js
```

### 本地挂载

开发期可直接用 `file://` URL 挂载编译产物（同样要用 `insert:` 形式）：

```yaml
- insert:
    - id: dsh-schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: keep-running
      name: 'file:///D:/ui-workspace/dsh-keep-running/lib/index.js'
      config:
        intervalSeconds: 1800
```

把 URL 改成你的实际路径。

### 重启

```sh
dsh web
```

### 验证

确认两个插件都已挂载：

```sh
# Windows
dsh web --dump-config | findstr /C:"keep-running" /C:"dsh-schedule"

# Linux / macOS
dsh web --dump-config | grep -E "keep-running|dsh-schedule"
```

看到 `keep-running` 和 `dsh-schedule` 行且无 `not found` 警告，即挂载成功。

### 检查调度是否落盘

`schedule/change` 事件不会显示在 web 对话轨迹里（它是持久化日志事件，不是消息）。要确认调度真的创建了，用工程自带脚本，不依赖模型：

```sh
node scripts/check-schedule.mjs            # 扫全部 ~/.dsh/sessions
node scripts/check-schedule.mjs <会话目录>  # 只查指定会话
```

## 协议

[Apache-2.0](LICENSE)
