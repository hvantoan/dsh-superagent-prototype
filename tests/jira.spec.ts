import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { bodyText, commentTrigger, issueTrigger, IssueSchema } from '../src/sources/jira-trigger.ts'
import { jiraKind, pollRound, sendJiraComment, watch, type JiraConfig } from '../src/sources/jira.ts'

const description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users cannot log in' }] }] }
const issue = IssueSchema.parse({ key: 'PROJ-12',
  fields: { summary: 'Fix login', created: '2026-11-09T10:00:00.000+0000', description, creator: { accountId: 'acc-1', displayName: 'An' } } })

  expect(issueTrigger({ ...issue, fields: { ...issue.fields,
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'help @agent-bot' }] }] } } }, 'agent-bot')?.addressed).toBe('mention')
const config: JiraConfig = { cli: 'jira', baseUrl: 'https://acme.atlassian.net', selfName: 'agent-bot', projects: 'PROJ',
  jql: '', pollSeconds: 120, failuresBeforeError: 3, readPageSize: 20 }

it('normalizes issues and comments into triggers', () => {
  const t = issueTrigger(issue, 'agent-bot')
  expect(t?.source).toBe('jira')
  expect(t?.text).toContain('Users cannot log in')
  expect(t?.threads[0]?.id).toBe('PROJ-12')
  expect(issueTrigger({ ...issue, fields: { ...issue.fields,
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'help @agent-bot' }] }] } } }, 'agent-bot')?.addressed).toBe('mention')
  const c = { id: '1001', author: { accountId: 'acc-2', displayName: 'Binh' }, created: '2026-11-09T11:00:00.000+0000', body: description }
  expect(commentTrigger(c, 'PROJ-12', 'agent-bot')?.addressed).toBeUndefined()
  expect(commentTrigger({ ...c, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fix @agent-bot' }] }] } }, 'PROJ-12', 'agent-bot')?.addressed).toBe('mention')
  expect(commentTrigger({ ...c, author: { accountId: 'x', displayName: 'agent-bot' } }, 'PROJ-12', 'agent-bot')).toBeUndefined()
  expect(bodyText(issue.fields.description)).toBe('Users cannot log in')
})

/** A Commands stub whose `jira`/`run` record calls and return canned jira-cli output. */
function commandsStub(canned: { jira?: (args: string[]) => unknown; run?: (program: string, args: string[]) => string }) {
  const calls: { jira: string[][]; run: { program: string; args: string[] }[] } = { jira: [], run: [] }
  const commands = {
    calls,
    withSignal: () => commands as unknown as Commands,
    jira: async <T>(cli: string, args: string[]): Promise<T> => { calls.jira.push(args); return canned.jira?.(args) as T },
    run: async (program: string, args: string[]): Promise<string> => { calls.run.push({ program, args }); return canned.run?.(program, args) ?? '' },
  }
  return commands
}
/** A SourceContext stub enabled with `config`, recording received triggers and state writes. */
function contextStub(canned: { jira?: (args: string[]) => unknown }) {
  const commands = commandsStub(canned)
  const received: unknown[] = []
  const state = new Map<string, unknown>()
  const ctx = {
    commands: commands as unknown as Commands,
    config: <C,>(kind: string) => kind === 'jira' ? config as C : undefined,
    receive: async (trigger: unknown) => { received.push(trigger); return 'stored' as const },
    state: { get: <V,>(key: string) => state.get(key) as V, set: <V,>(key: string, value: V | undefined): void => { if (value === undefined) state.delete(key); else state.set(key, value) },
      keys: () => [] },
    threads: { get: () => undefined, subscribed: () => [], describe: () => undefined, patch: () => undefined },
    tickets: { get: () => undefined, open: () => [], bindThread: () => undefined, threadClosed: () => undefined },
  }
  return { ctx: ctx as unknown as SourceContext, commands, received, state }
}

const listedIssue = (hoursAgo: number) => ({
  key: 'PROJ-12',
  fields: { summary: 'Fix login', created: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    updated: new Date(Date.now() - 600_000).toISOString(),
    description, creator: { accountId: 'acc-1', displayName: 'An' }, status: { name: 'Open' },
    comment: { comments: [{ id: '1001', author: { accountId: 'acc-2', displayName: 'Binh' }, created: new Date(Date.now() - 600_000).toISOString(), body: description }] } },
})
const listed = listedIssue(3)

it('polls the JQL stream shaped as a bare issue array, emitting issue and comment triggers', async () => {
  const { ctx, commands, received, state } = contextStub({
    // ankitpokhrel/jira-cli prints the array itself for `issue list --raw`.
    jira: args => args[0] === 'issue' && args[1] === 'list' ? [listedIssue(0)] : listedIssue(0),
  })
  await pollRound(ctx, new AbortController().signal)
  expect(commands.calls.jira[0]?.slice(0, 3)).toEqual(['issue', 'list', '--jql'])
  expect(commands.calls.jira[0]?.[3]).toContain('project IN (PROJ)')
  const kinds = received.map(trigger => (trigger as { meta: { kind?: string } }).meta.kind)
  // `since` defaults to the round start: a just-created issue lands, its ten-minute-old comment does not.
  expect(kinds).toEqual(['issue'])
  expect(state.get('jira-since')).toBeTypeOf('string')
})

it('advancing the cursor ingests a newly created issue', async () => {
  const { ctx, received, state } = contextStub({
    jira: args => args[0] === 'issue' && args[1] === 'list' ? [listed] : listedIssue,
  })
  state.set('jira-since', new Date(Date.now() - 4 * 3600_000).toISOString())
  await pollRound(ctx, new AbortController().signal)
  const kinds = received.map(trigger => (trigger as { meta: { kind?: string } }).meta.kind)
  expect(kinds).toEqual(['issue', 'comment'])
})

it('pauses on its own setup problem instead of polling', async () => {
  const reports: { entry: string; value: unknown }[] = []
  const problem = { place: 'jira', code: 'jiraCliFailed', values: {}, detail: 'The Jira CLI does not work.' }
  const ctx = { ready: Promise.resolve(), configured: () => true, problem,
    report: (entry: string, value: unknown) => reports.push({ entry, value }) } as unknown as SourceContext
  await watch(ctx, new AbortController().signal)
  expect(reports).toEqual([{ entry: 'jira', value: { state: 'paused', detail: problem.detail } }])
})

const message = (id: string): OutboundMessage =>
  ({ id, channel: { source: 'jira', thread: 'jira:PROJ-12', address: { issue: 'PROJ-12' } }, text: 'working on it', kind: 'reply' })

it('posts a reply through `comment add` plain output, marked for idempotency', async () => {
  const commands = commandsStub({ jira: () => listed, run: () => 'Comment added to PROJ-12\nhttps://acme.atlassian.net/browse/PROJ-12?focusedCommentId=1002' })
  expect(await sendJiraComment(commands as never, config, message('msg-1'))).toBe('sent')
  expect(commands.calls.run).toHaveLength(1)
  const posted = commands.calls.run[0]!
  expect(posted.args.slice(0, 4)).toEqual(['issue', 'comment', 'add', 'PROJ-12'])
  expect(posted.args[4]).toContain('working on it')
  expect(posted.args[4]).toContain('<!-- msg-1 -->')
})

it('skips reposting when the marker already landed on a previous attempt', async () => {
  const withMarker = { ...listed, fields: { ...listed.fields,
    comment: { comments: [...listed.fields.comment.comments,
      { id: '1002', author: { accountId: 'me', displayName: 'agent-bot' }, created: '2026-11-09T12:00:00.000Z', body: 'working on it\n\n<!-- msg-1 -->' }] } } }
  const commands = commandsStub({ jira: () => withMarker })
  expect(await sendJiraComment(commands as never, config, message('msg-1'))).toBe('sent')
  expect(commands.calls.run).toHaveLength(0)
})
