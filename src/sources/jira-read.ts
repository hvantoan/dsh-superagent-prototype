/** Bounded Jira issue context reader for assessments: issue description plus paged comments as model-facing messages. */
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import type { Trigger } from '../core/index.ts'
import { IssueSchema, jiraIssueUrl, actorId, actorName, bodyText, commentTriggerId, issueTriggerId, type JiraIssue } from './jira-trigger.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { CommentSchema } from './jira-trigger.ts'
import type { JiraConfig } from './jira.ts'

const issueKey = (trigger: Trigger): string => {
  const issue = trigger.source === 'jira' ? String(trigger.meta.issue ?? '') : ''
  if (!issue) throw new Error('A Jira source trigger is required')
  return issue
}
const jiraMessage = (id: string, author: { accountId?: string | null; emailAddress?: string | null; displayName?: string | null } | null | undefined,
  at: string | null | undefined, text: string): ContextMessage =>
  ({ id, from: actorName(author), at: at ?? '', text })

/**
 * Reads a Jira issue through the Source's configured CLI (`config.cli`, called as `jira issue view <key> --comments <n> --raw`),
 * returning the description as the first message of the first page followed by comments oldest first.
 */
export async function readJiraIssue(commands: Pick<Commands, 'jira' | 'withSignal'>, config: JiraConfig, issue: string, signal?: AbortSignal): Promise<JiraIssue> {
  const raw = await commands.withSignal(signal).jira<unknown>(config.cli,
    ['issue', 'view', issue, '--comments', String(config.readPageSize * 5), '--raw'])
  return IssueSchema.parse(raw)
}

export function issueMessages(issue: JiraIssue, pageSize: number, cursor: string | undefined, tally?: Tally): ContextPart {
  const description = jiraMessage(issueTriggerId(issue.key), issue.fields.creator, issue.fields.created,
    [issue.fields.summary ?? '', bodyText(issue.fields.description)].filter(Boolean).join('\n\n'))
  const all = [description,
    ...validItems(CommentSchema, issue.fields.comment?.comments ?? [], tally)
      .map(comment => jiraMessage(comment.id, comment.author, comment.created ?? comment.updated, bodyText(comment.body)))]
  const start = cursor ? Number.parseInt(cursor, 10) : 0
  const messages = all.slice(start, start + pageSize)
  const next = start + pageSize < all.length ? String(start + pageSize) : undefined
  return { messages, ...(next ? { next } : {}), body: { issue: issue.key, summary: issue.fields.summary ?? '', status: issue.fields.status?.name ?? '' },
    status: 'available' }
}

/** Thread context of a Jira trigger: the issue description is `root`/`parent`; `thread` pages the description plus comments. */
export const jiraThreadContext: ThreadContext<JiraConfig> = {
  messageId: trigger => trigger.meta.kind === 'issue' ? issueTriggerId(issueKey(trigger)) : String(trigger.meta.commentId ?? ''),
  read: async (commands, trigger, _part, cursor, config) =>
    issueMessages(await readJiraIssue(commands, config, issueKey(trigger)), config.readPageSize, cursor),
}
export { commentTriggerId, jiraIssueUrl }
