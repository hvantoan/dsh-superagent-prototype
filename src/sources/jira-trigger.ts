/** Normalizes Jira issues and comments into domain Triggers and reply channel addresses. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'

export const SOURCE = 'jira'
/** Jira reply address: a comment on the issue; `issue` carries its key (such as `PROJ-123`). */
export const jiraChannel = (issue: string): ChannelRef => ({ source: SOURCE, thread: `jira:${issue}`, address: { issue } })
/** The browser URL of a Jira issue under the deployment's Jira base URL. */
export const jiraIssueUrl = (baseUrl: string, issue: string): string => `${baseUrl}/browse/${issue}`

const ActorSchema = z.looseObject({ accountId: z.string().nullish(), emailAddress: z.string().nullish(), displayName: z.string().nullish() })
export const CommentSchema = z.looseObject({
  id: z.string(), author: ActorSchema.nullish(), body: z.unknown().nullish(), created: z.string().nullish(), updated: z.string().nullish(),
})
export type JiraComment = z.infer<typeof CommentSchema>
export const IssueSchema = z.looseObject({
  key: z.string(), fields: z.looseObject({
    summary: z.string().nullish(), description: z.unknown().nullish(), created: z.string().nullish(), updated: z.string().nullish(),
    creator: ActorSchema.nullish(), assignee: ActorSchema.nullish(), status: z.looseObject({ name: z.string().nullish() }).nullish(),
    comment: z.looseObject({ comments: z.array(z.unknown()).default([]), total: z.number().optional() }).nullish(),
  }),
})
/** `jira issue list --raw` prints the issue array itself, not a wrapper object. */
export const IssueListSchema = z.array(z.unknown())
export type JiraIssue = z.infer<typeof IssueSchema>

/** Jira identifies an actor by accountId on Cloud, by email or display name elsewhere; empty names fall back to `unknown`. */
export const actorId = (actor: { accountId?: string | null; emailAddress?: string | null; displayName?: string | null } | null | undefined): string =>
  actor?.accountId ?? actor?.emailAddress ?? actor?.displayName ?? 'unknown'
export const actorName = (actor: { displayName?: string | null } | null | undefined): string => actor?.displayName ?? actorId(actor)

/** True when `text` mentions the Jira account the agent runs under (by name, email, or account ID in any spelling Jira renders). */
export const mentions = (text: string, self: string): boolean =>
  !!self && (new RegExp(`(?:^|[^\\p{L}\\p{N}_.@-])(?:@|\\[~|\\[accountid:)${escape(self)}(?:\\]|(?![\\p{L}\\p{N}_-]))`, 'iu').test(text))
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Best-effort plain text out of a Jira description or comment body, which may be an Atlassian document, a string, or absent. */
export function bodyText(body: unknown): string {
  if (typeof body === 'string') return body
  if (!body || typeof body !== 'object') return ''
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    const item = node as { type?: string; text?: string; content?: unknown; attrs?: { text?: string } }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (typeof item.attrs?.text === 'string') parts.push(item.attrs.text)
    if (Array.isArray(item.content)) item.content.forEach(walk)
    else if (item.type === 'paragraph' || item.type === 'heading') parts.push('\n')
  }
  walk(body)
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}
/** True when `self` (display name, email, or accountId) names this actor under any identity field. */
const isSelf = (actor: z.infer<typeof ActorSchema> | null | undefined, self: string): boolean =>
  !!actor && [actor.accountId, actor.emailAddress, actor.displayName].some(value => !!value && sameName(value, self))

/** Deterministic trigger IDs: an issue's description, or one of its comments. */
export const issueTriggerId = (issue: string): string => key(SOURCE, 'issue', issue)
export const commentTriggerId = (issue: string, commentId: string): string => key(SOURCE, 'comment', issue, commentId)

/**
 * Builds the trigger for a Jira issue created since the cursor: its summary and description.
 * `self` (the account the Jira CLI acts as) never produces a trigger.
 */
export function issueTrigger(issue: JiraIssue, self: string): Trigger | undefined {
  const creator = issue.fields.creator
  if (isSelf(creator, self)) return
  const text = [issue.fields.summary ?? '', bodyText(issue.fields.description)].filter(Boolean).join('\n\n')
  return { id: issueTriggerId(issue.key), source: SOURCE, threads: [{ source: SOURCE, id: issue.key }],
    actor: { source: SOURCE, id: actorId(creator) }, human: true,
    ...(mentions(text, self) ? { addressed: 'mention' as const } : {}),
    at: issue.fields.created ?? new Date(0).toISOString(), text,
    channel: jiraChannel(issue.key),
    meta: { issue: issue.key, kind: 'issue', summary: issue.fields.summary ?? '' } }
}

/**
 * Builds the trigger for a Jira comment; a comment that mentions `self` addresses the agent.
 * Returns undefined for the account's own comments.
 */
export function commentTrigger(comment: JiraComment, issue: string, self: string): Trigger | undefined {
  const author = comment.author
  const id = actorId(author)
  if (isSelf(author, self)) return
  const text = bodyText(comment.body)
  return { id: commentTriggerId(issue, comment.id), source: SOURCE, threads: [{ source: SOURCE, id: issue }],
    actor: { source: SOURCE, id }, human: true, ...(mentions(text, self) ? { addressed: 'mention' as const } : {}),
    at: comment.created ?? comment.updated ?? new Date(0).toISOString(), text,
    channel: jiraChannel(issue),
    meta: { issue, kind: 'comment', commentId: comment.id } }
}
