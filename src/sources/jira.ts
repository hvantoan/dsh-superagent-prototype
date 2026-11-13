/** Jira source kind definition, JQL polling loop, subscribed-thread polling, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { record } from '../kv.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, Localized, SourceKind } from './kind.ts'
import { readJiraIssue, jiraThreadContext } from './jira-read.ts'
import { commentTrigger, CommentSchema, issueTrigger, IssueListSchema, IssueSchema, jiraIssueUrl, SOURCE, type JiraIssue } from './jira-trigger.ts'
import { checkedImText } from '../infra/text.ts'
import { bodyText } from './jira-trigger.ts'

/** The JQL `updated`/`created` comparison format Jira accepts (`yyyy/MM/dd HH:mm`, UTC). */
const jqlTime = (iso: string): string => {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}
const JIRA_SINCE = record<string>('jira-since')
const jiraCursor = (issue: string) => record<string>(`jira-cursor:${issue}`)

const JiraConfigSchema = z.object({
  cli: z.string().trim().default(''),
  baseUrl: z.string().trim().regex(/^(|https?:\/\/[^/\s]+(\/\S*)?)$/, 'https://host or https://host/path').default(''),
  selfName: z.string().trim().default(''),
  projects: z.string().trim().regex(/^(|[A-Za-z][A-Za-z0-9_]*( *, *[A-Za-z][A-Za-z0-9_]*)*)$/, 'Project keys, comma-separated').default(''),
  jql: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  readPageSize: z.number().int().min(5).max(50).default(20),
}).strict()
export type JiraConfig = z.infer<typeof JiraConfigSchema>

/** The JQL clause selecting which issues this Source receives; `projects` filters when no custom `jql` is given. */
export const watchJql = (config: JiraConfig): string =>
  config.jql || (config.projects ? `project IN (${config.projects})` : '')

/** The Source's context while its plugin runs; `channel.send` and `link` read config through it because the registry passes only commands. */
let active: SourceContext | undefined
const jiraConfig = (): JiraConfig | undefined => active?.config<JiraConfig>(SOURCE)
/** Posts the reply as a comment on the issue through `sendJiraComment`; needs a configured issue address and CLI. */
async function sendJira(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const config = jiraConfig()
  if (!message.channel.address.issue || !config?.cli) throw new Error('Missing Jira reply target')
  return sendJiraComment(host.commands, config, message)
}
/**
 * Posts the reply as a comment on `message.channel.address.issue`, best-effort idempotent by an invisible
 * `<!-- message.id -->` marker: jira-cli's `comment add` prints a success line (not JSON, so `Commands.run`) and has no
 * idempotency key, so before posting it reads the issue's comments and skips a retry whose marker already landed.
 * The read is bounded (`--comments readPageSize*5` in `readJiraIssue`, no `comment.total` completeness check), so on an
 * issue whose marker comment fell outside that window a retry posts again — dedup is best-effort, not guaranteed.
 * `gone` for a deleted issue.
 */
export async function sendJiraComment(commands: Pick<Commands, 'run' | 'jira' | 'withSignal'>, config: JiraConfig,
  message: OutboundMessage): Promise<'sent' | 'gone'> {
  const issue = message.channel.address.issue!
  const marker = `<!-- ${message.id} -->`
  try {
    const read = await readJiraIssue(commands, config, issue)
    const posted = validItems(CommentSchema, read.fields.comment?.comments ?? [])
      .some(comment => bodyText(comment.body).includes(marker))
    if (!posted) await commands.run(config.cli, ['issue', 'comment', 'add', issue, `${checkedImText(message.text)}\n\n${marker}`, '--no-input'])
  } catch (error) {
    if (error instanceof Error && /not exist|not found|404/i.test(error.message)) return 'gone'
    throw error
  }
  return 'sent'
}

export const jiraKind: SourceKind<JiraConfig> = {
  kind: SOURCE,
  title: { zh: 'Jira', en: 'Jira', vi: 'Jira' },
  description: { zh: '按 JQL 轮询 Jira 事务：新事务的描述、订阅事务的评论，以及 @ 智能体账号的评论。回复以评论发回事务。',
    en: 'Polls Jira issues by JQL: descriptions of new issues, comments on subscribed issues, and comments mentioning the agent account. Replies post as issue comments.',
    vi: 'Poll Jira issue bằng JQL: mô tả của issue mới, bình luận trên issue đã theo dõi, và bình luận nhắc @ tài khoản agent. Trả lời được đăng lại dưới dạng bình luận trên issue.' },
  schema: JiraConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'Jira CLI', en: 'Jira CLI', vi: 'Jira CLI' },
      hint: { zh: '命令名或绝对路径，指向以智能体账号登录的 Jira CLI（如配置好的 jira-cli）。轮询、读取和回复都调用它。', en: 'A command name or absolute path of a Jira CLI signed in as the agent account (such as a configured jira-cli). Polling, reading, and replying all invoke it.', vi: 'Tên lệnh hoặc đường dẫn tuyệt đối tới Jira CLI đã đăng nhập bằng tài khoản agent (ví dụ jira-cli đã cấu hình). Việc poll, đọc và trả lời đều gọi nó.' } },
    { key: 'baseUrl', type: 'text', label: { zh: 'Jira 站点地址', en: 'Jira base URL', vi: 'URL gốc Jira' }, pattern: '(|https?://[^/\\s]+(/\\S*)?)',
      hint: { zh: '形如 https://your-team.atlassian.net；用于给事务面板链接。', en: 'Such as https://your-team.atlassian.net; used to link issues in the panel.', vi: 'Dạng https://your-team.atlassian.net; dùng để tạo liên kết tới issue trên panel.' } },
    { key: 'selfName', type: 'text', label: { zh: '智能体的 Jira 账号', en: 'Agent Jira account', vi: 'Tài khoản Jira của agent' },
      hint: { zh: 'Jira CLI 登录的账号的显示名、邮箱或 accountId；用于识别自己的评论和 @ 提及。', en: 'Display name, email, or accountId of the account the Jira CLI is signed in to; identifies the agent\'s own comments and @ mentions.', vi: 'Tên hiển thị, email hoặc accountId của tài khoản mà Jira CLI đăng nhập; dùng để nhận ra bình luận của chính agent và các lần nhắc @.' } },
    { key: 'projects', type: 'text', label: { zh: '接收的项目', en: 'Projects', vi: 'Project nhận' }, pattern: '(|[A-Za-z][A-Za-z0-9_]*( *, *[A-Za-z][A-Za-z0-9_]*)*)',
      hint: { zh: '逗号分隔的项目键（如 PROJ, OPS）。留空且未设 JQL 时接收账号可见的全部事务。', en: 'Comma-separated project keys (such as PROJ, OPS). When empty and no JQL is set, receives every issue the account can see.', vi: 'Các project key cách nhau bằng dấu phẩy (ví dụ PROJ, OPS). Khi để trống và không đặt JQL, nhận mọi issue mà tài khoản có thể thấy.' } },
    { key: 'jql', type: 'text', advanced: true, label: { zh: '自定义 JQL 条件', en: 'Custom JQL clause', vi: 'Mệnh đề JQL tuỳ chỉnh' },
      hint: { zh: '填入后替代项目列表，如 project = PROJ AND issuetype = Bug。不要含 updated/created 时间条件和 ORDER BY，由来源追加。', en: 'Replaces the project list when set, such as project = PROJ AND issuetype = Bug. Do not include updated/created time clauses or ORDER BY; the Source appends them.', vi: 'Khi được đặt sẽ thay thế danh sách project, ví dụ project = PROJ AND issuetype = Bug. Không kèm điều kiện thời gian updated/created hay ORDER BY; Source sẽ tự thêm.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds', vi: 'Khoảng poll / giây' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error', vi: 'Số lần poll thất bại trước khi báo lỗi' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 5, max: 50, label: { zh: '每页评论数', en: 'Comments per page', vi: 'Số bình luận mỗi trang' } },
  ],
  health: ['jira'],
  facts: (deployment): Record<string, Localized | string> => deployment?.jira ? { cli: { zh: `当前账号 ${deployment.jira.name}`, en: `Current account ${deployment.jira.name}`, vi: `Tài khoản hiện tại ${deployment.jira.name}` } } : {},
  // Everything the poll produces is listened; the JQL/project filter already scoped it at the source.
  scope: () => ({ listened: true, observed: true }),
  channel: {
    allowed: address => !!address.issue,
    send: sendJira,
    link: address => {
      const base = (jiraConfig()?.baseUrl ?? '').replace(/\/$/, '')
      return { url: base && address.issue ? jiraIssueUrl(base, address.issue) : '', label: { zh: 'Jira 事务', en: 'Jira issue', vi: 'Jira issue' } }
    },
  },
  threadContext: jiraThreadContext,
  find: query => ({ threads: [...new Set(query.match(/[A-Z][A-Z0-9_]+-\d+/g) ?? [])].map(issue => `${SOURCE}:${issue}`), terms: [] }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id.toLowerCase())).size === users.length, 'Duplicate accounts').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Jira 用户', en: 'Jira users who may originate work', vi: 'Người dùng Jira được phép khởi tạo công việc' },
        hint: { zh: '优先填 accountId：Jira Cloud 用户的身份取 accountId，填显示名或邮箱不会匹配。', en: 'Prefer accountId: a Jira Cloud user\'s identity is their accountId, so a display name or email will not match.', vi: 'Nên điền accountId: danh tính người dùng Jira Cloud lấy theo accountId, nên điền tên hiển thị hay email sẽ không khớp.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'accountId', en: 'accountId', vi: 'accountId' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', vi: 'Tên' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人在事务描述或评论中 @ 智能体账号，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the agent account in an issue or comment always makes an explicit request; that needs no setting.', vi: 'Người trong danh sách nhắc @ tài khoản agent trong mô tả hoặc bình luận của issue luôn là một yêu cầu rõ ràng; không cần cấu hình.' },
  },
}

export const name = 'dsh-superagent-jira'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(jiraKind), 'jira: source kind')
  ctx.effect(() => {
    const source = active = sourceContext(ctx.orchestrator, jiraKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('jira', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Jira waits for the repository check the runtime gates on, then pauses on its own setup problem without stopping other Sources.
  if (!ctx.configured()) { ctx.report('jira', health('paused', 'setupPending')); return }
  if (ctx.problem) { ctx.report('jira', { state: 'paused', detail: ctx.problem.detail }); return }
  while (!signal.aborted) {
    const config = ctx.config<JiraConfig>(SOURCE)
    try {
      if (config?.cli) {
        await pollRound(ctx, signal)
        ctx.report('jira', { state: 'ready', detail: 'Polling Jira' })
      } else ctx.report('jira', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      if (signal.aborted) return
      failures += 1
      if (failures >= (config?.failuresBeforeError ?? 1)) ctx.report('jira', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause((ctx.config<JiraConfig>(SOURCE)?.pollSeconds ?? 120) * 1000, signal)
  }
}

/**
 * One polling round: a JQL search for issues updated or created since the cursor ingests new-issue descriptions and new
 * comments, then each subscribed Thread reads its own issue for comments missed by the JQL. Deterministic trigger IDs
 * deduplicate overlaps between the two reads. The cursor starts at the first round, so history before enabling is not read.
 */
export async function pollRound(ctx: SourceContext, signal: AbortSignal, tally: Tally = { skipped: 0 }): Promise<void> {
  const config = ctx.config<JiraConfig>(SOURCE)
  if (!config?.cli) return
  const started = new Date().toISOString()
  const since = ctx.state.get(JIRA_SINCE) ?? started
  const clause = watchJql(config)
  const jql = `${clause ? `(${clause}) AND ` : ''}updated >= "${jqlTime(since)}" ORDER BY updated ASC`
  const listed = IssueListSchema.parse(await ctx.commands.withSignal(signal)
    .jira<unknown>(config.cli, ['issue', 'list', '--jql', jql, '--paginate', '0:200', '--plain', '--raw']))
  for (const issue of validItems(IssueSchema, listed, tally)) {
    if (signal.aborted) return
    await intakeIssue(ctx, issue, since, config, tally)
  }
  ctx.state.set(JIRA_SINCE, cursorAt(started))
  await pollSubscribed(ctx, signal, config)
}

/** Ingests a JQL-listed issue: its description trigger when created since the cursor, comments since the cursor, and thread title/status. */
async function intakeIssue(ctx: SourceContext, issue: JiraIssue, since: string, config: JiraConfig,
  tally: Tally): Promise<void> {
  const created = Date.parse(issue.fields.created ?? '')
  if (Number.isFinite(created) && created >= Date.parse(since)) {
    const trigger = issueTrigger(issue, config.selfName)
    if (trigger) await ctx.receive(trigger)
  }
  await intakeComments(ctx, issue, since, config, tally)
  if (issue.fields.summary) {
    ctx.threads.patch(`jira:${issue.key}`, { title: issue.fields.summary })
    ctx.threads.describe(`jira:${issue.key}`, { label: `${issue.key} ${issue.fields.summary}`,
      url: config.baseUrl ? jiraIssueUrl(config.baseUrl.replace(/\/$/, ''), issue.key) : undefined,
      facts: { status: issue.fields.status?.name ? { value: issue.fields.status.name } : null } })
  }
}

async function intakeComments(ctx: SourceContext, issue: JiraIssue, since: string, config: JiraConfig, tally: Tally): Promise<void> {
  for (const comment of validItems(CommentSchema, issue.fields.comment?.comments ?? [], tally)) {
    const at = Date.parse(comment.updated ?? comment.created ?? '')
    if (!Number.isFinite(at) || at < Date.parse(since)) continue
    const trigger = commentTrigger(comment, issue.key, config.selfName)
    if (trigger) await ctx.receive(trigger)
  }
}

/** Polls subscribed Jira Threads within the horizon for comments newer than each thread's own cursor. */
export async function pollSubscribed(ctx: SourceContext, signal: AbortSignal, config = ctx.config<JiraConfig>(SOURCE)): Promise<void> {
  if (!config?.cli) return
  await pollEach(ctx, SOURCE, () => signal.aborted, async thread => {
    const since = ctx.state.get(jiraCursor(thread.ref.id)) ?? thread.createdAt
    const issue = await readJiraIssue(ctx.commands, config, thread.ref.id, signal)
    await intakeComments(ctx, issue, since, config, { skipped: 0 })
    ctx.state.set(jiraCursor(thread.ref.id), cursorAt(new Date().toISOString()))
  })
}
export { IssueSchema, SOURCE }
