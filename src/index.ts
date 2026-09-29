import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import z from '@deepseek-ai/schemastery'

export const name = 'keep-running'

// 'schedule' 是 DSH 0.1.7 起的唯一调度入口：看门狗通过 ctx.schedule 增删，
// 不再直接向会话日志 append 'schedule/change'。
export const inject = ['commands', 'schedule']

/** 插件配置。 */
export interface Config {
  /** 每个调度 tick 的间隔（秒），默认 1800（30 分钟），最小 300。 */
  intervalSeconds?: number
  /** 到点投递的「继续」提示词模板，`{{task}}` 会被替换为断点记录。 */
  continuePrompt?: string
  /** 识别配额/限流的关键词（小写），用于多厂商通用检测。 */
  quotaKeywords?: string[]
}

export const Config: z<Config> = z.object({
  intervalSeconds: z.number().min(300).default(1800),
  continuePrompt: z.string().default('请继续完成之前未完成的任务：{{task}}'),
  quotaKeywords: z.array(z.string()).default([]),
})

/** 本插件创建的看门狗统一使用这个任务名，用于在调度表里认出自己。 */
const WATCHDOG_TITLE = 'keep-running'

export function apply(ctx: Context, config: Config): void {
  const intervalSeconds = config.intervalSeconds ?? 1800
  const continuePrompt = config.continuePrompt ?? '请继续完成之前未完成的任务：{{task}}'
  const quotaKeywords = config.quotaKeywords ?? []

  // 每个 agent 当前活跃的看门狗记录，用于避免重复创建。
  const active = new WeakMap<Agent, ScheduleRecord>()

  // 监听「agent/error」而非「agent/request-error」：
  // DeepSeek/OpenAI 的配额 429 在「请求一建立」就被 HTTP 429 拒绝，走 step()->turn() 的
  // catch -> throwError()，**不触发** agent/request-error waterfall（它只在流式 error finish 时触发）。
  // agent/error 是 LLM 失败时 throwError 真正 emit 的全局事件，payload.error 为原始 LlmError，
  // 其 .failure 即带 status 的 LlmFailure。
  ctx.on('agent/error', ({ agent, error }) => {
    const failure = extractFailure(error)
    if (failure !== undefined && isQuotaError(failure, quotaKeywords)) {
      // 断点：取最近一条真实用户消息作为「当时在做什么」。
      void ensureWatchdog(ctx, agent, intervalSeconds, continuePrompt, breakpoint(agent), active)
      // 配额耗尽：不立即重试（会再次 429）。让本轮以失败结束，由 watchdog 后续自动恢复。
      // ensureWatchdog 的 active 守卫 + 调度表查询都会避免重复创建。
    }
  })

  // Phase 2 — 成功检测停止 + 手动接手停止：
  // 任一 turn 正常关闭（无 429，即配额已恢复）→ 停止 watchdog。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    void stopWatchdog(ctx, agent, active)
  })

  // Phase 3 — 「不活动才触发」：
  // 调度运行时用 agent.runMaintenance() 投递，仅在 agent 空闲阶段执行；
  // agent 活跃（用户手动干活）时 runMaintenance 会 reject 并 waitForIdle()，不会投递 continue。
  // 所以"仅在空闲时继续"由调度运行时天然保证，插件无需额外 gate。

  // Phase 4 — 快捷命令（独立命名空间，避免与 /schedule 命令冲突）：
  // /keep-running list            列出本会话所有活跃的 keep-running 定时任务
  // /keep-running cancel <id>     取消指定 id 的定时任务
  ctx.commands.register({
    name: 'keep-running',
    description: '查看或取消本会话的 keep-running 定时任务',
    input: { hint: 'list | cancel <id>' },
    handler: invocation => handleCommand(ctx, invocation),
  })
}

/** 从 agent/error 的 error 里提取 LlmFailure。结构化判断，避免跨副本 instanceof 不可靠。 */
function extractFailure(error: unknown): LlmFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = (error as { failure?: unknown }).failure
  if (candidate === undefined || typeof candidate !== 'object' || candidate === null) return undefined
  const failure = candidate as LlmFailure
  if (typeof failure.message !== 'string' || typeof failure.code !== 'string') return undefined
  return failure
}

/** 多厂商通用的配额/限流识别：HTTP 429、稳定 code（RATE_LIMIT/QUOTA）、message 配额信号，再叠加用户关键词。 */
function isQuotaError(failure: LlmFailure, keywords: string[]): boolean {
  // HTTP 429 状态（adapter 透传 status 时）
  if (failure.status === 429) return true
  // deepseek 429 -> RATE_LIMIT；其它配额 -> QUOTA / QUOTA_EXCEEDED
  const code = (failure.code ?? '').toLowerCase()
  if (code === 'rate_limit' || code.includes('quota')) return true
  // message 里显式出现配额信号（不依赖用户配置的兜底，覆盖 status 未透传的情况）
  const text = `${failure.code ?? ''} ${failure.message ?? ''}`.toLowerCase()
  if (/429|quota|rate[-_ ]?limit|ratelimit|toomanyrequests|accountquotaexceeded/.test(text)) return true
  // 用户扩展关键词（quotaKeywords 配套）
  if (keywords.length === 0) return false
  return keywords.some(keyword => text.includes(keyword.toLowerCase()))
}

/** 若无活跃 watchdog，则创建一个固定间隔的「every」调度，到点投递 continuePrompt。 */
async function ensureWatchdog(
  ctx: Context,
  agent: Agent,
  intervalSeconds: number,
  prompt: string,
  task: string,
  active: WeakMap<Agent, ScheduleRecord>,
): Promise<void> {
  if (active.has(agent)) return
  // 跨进程重启恢复：调度表里可能已有一个本插件的活跃任务，复用而不重复建。
  const existing = (await listWatchdogs(ctx, agent))[0]
  if (existing !== undefined) {
    active.set(agent, existing)
    return
  }
  try {
    const record = await ctx.schedule.create(agent.session.id, {
      title: WATCHDOG_TITLE,
      prompt: prompt.replaceAll('{{task}}', task),
      every_seconds: intervalSeconds,
    })
    active.set(agent, record)
  } catch {
    // 创建失败（规则校验、持久化失败）时不标记为已创建，让下一次配额错误重试。
    return
  }
}

/** 删除 watchdog 调度（任务成功或用户手动接手时调用）。 */
async function stopWatchdog(
  ctx: Context,
  agent: Agent,
  active: WeakMap<Agent, ScheduleRecord>,
): Promise<void> {
  const record = active.get(agent)
  if (record === undefined) return
  active.delete(agent)
  try {
    await ctx.schedule.delete({ sessionId: agent.session.id, id: record.id })
  } catch {
    // 删除失败时保持未跟踪状态；下一次配额错误会经 listWatchdogs 重新发现该任务。
    return
  }
}

/** 断点细化：从会话里取最近一条「真实用户消息」作为断点描述（过滤掉注入的 system-reminder/plugin 上下文）。 */
function breakpoint(agent: Agent): string {
  const messages = agent.session.deriveMessages()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text.slice(0, 200)
  }
  return '继续未完成的任务'
}

/** 读取本会话中由本插件创建的活跃调度。查询失败时返回空列表，让调用方按「无看门狗」处理。 */
async function listWatchdogs(ctx: Context, agent: Agent): Promise<ScheduleRecord[]> {
  let records: ScheduleRecord[]
  try {
    records = await ctx.schedule.list({ sessionId: agent.session.id })
  } catch {
    return []
  }
  return records.filter(record => record.title === WATCHDOG_TITLE)
}

/** 渲染一条调度的可读摘要。 */
function describeWatchdog(record: ScheduleRecord): string {
  const timing = record.kind === 'every' ? `every=${record.everySeconds}s` : `kind=${record.kind}`
  return `- ${record.id}\n    ${timing}  下次约 ${record.scheduledAt}\n    prompt=${record.prompt}`
}

/** `/keep-running` 命令入口：分发 list / cancel 子命令。 */
async function handleCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  if (input.length === 0 || input.toLowerCase() === 'list') return listResult(ctx, invocation.agent)
  const cancel = /^cancel(?:\s+(.+))?$/iu.exec(input)
  if (cancel !== null) return cancelResult(ctx, invocation.agent, cancel[1]?.trim() ?? '')
  return { kind: 'error', text: '用法：/keep-running list 或 /keep-running cancel <id>' }
}

/** 列出当前会话所有活跃的 keep-running 调度。 */
async function listResult(ctx: Context, agent: Agent): Promise<CommandResult> {
  const list = await listWatchdogs(ctx, agent)
  if (list.length === 0) return { kind: 'success', text: '当前会话没有活跃的 keep-running 定时任务。' }
  const body = list.map(describeWatchdog).join('\n')
  return { kind: 'success', text: `当前会话有 ${list.length} 个活跃的 keep-running 定时任务：\n${body}` }
}

/** 取消指定 id 的 keep-running 调度。 */
async function cancelResult(ctx: Context, agent: Agent, id: string): Promise<CommandResult> {
  if (id.length === 0) return { kind: 'error', text: '用法：/keep-running cancel <id>' }
  const target = (await listWatchdogs(ctx, agent)).find(record => String(record.id) === id)
  if (target === undefined) {
    return { kind: 'error', text: `未找到活跃调度：${id}（可用 /keep-running list 查看）` }
  }
  try {
    const result = await ctx.schedule.delete({ sessionId: agent.session.id, id: target.id })
    if (!result.deleted) return { kind: 'error', text: `取消失败：${id}` }
  } catch {
    return { kind: 'error', text: `取消失败：${id}` }
  }
  return { kind: 'success', text: `已取消定时任务：${id}` }
}
