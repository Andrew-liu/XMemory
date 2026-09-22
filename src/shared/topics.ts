import type { Note } from './types'

export const topicTemplate = '## 大纲\n\n\n## 长文\n\n'

export function sortTopics(notes: Note[]) {
  return [...notes].sort((a, b) => Number(!!a.completed) - Number(!!b.completed)
    || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}
