export type Kind = 'inspiration' | 'memory' | 'draft' | 'topic'
export type AgentMode = 'local' | 'web'
export interface WebSource { title: string; url: string; source: string; accessedAt: string }
export interface Note {
  id: string; kind: Kind; title: string; body: string; hash: string; path: string
  tags: string[]; createdAt: string; updatedAt: string; author?: string; source?: string
  publishedAt?: string; sortOrder?: number
  deleted?: boolean; groupId?: string; parentId?: string; userEdited?: boolean
  sources?: string[]; webSources?: WebSource[]; agentMode?: AgentMode; instruction?: string
  scheduledDate?: string; completed?: boolean; completedAt?: string
  partial?: boolean; capturedImages?: string[]
  generationProvider?: { id: string; name: string; model: string }
}
export interface ArchiveProgress {
  phase: string
  found: number
  saved: number
  imagesDone: number
  imagesFailed: number
  lastSuccessAt?: string
  cursor?: string
  mode?: 'single' | 'bookmarks'
  checked?: number
  skipped?: number
  failed?: number
  queued?: number
}
export interface BookmarkBreaker { reason: string; at: string; until?: string }
export interface BookmarkGuardInfo {
  newToday: number; articlesToday: number; dailyLimit: number; articleLimit: number
  historyComplete: boolean; lastRunAt?: string; lastStopReason?: string; breaker?: BookmarkBreaker
}
export interface BookmarkRunResult { checked: number; created: number; skipped: number; failed: number; articlesQueued: number; stopReason: string }
export interface Conflict { id: string; noteId: string; title: string; current: Note; incoming: Note; createdAt: string; currentRaw?: string; incomingRaw?: string; currentMetadata?: Record<string, unknown>; incomingMetadata?: Record<string, unknown> }
export interface Settings {
  theme: 'system' | 'light' | 'dark'
  closeToTray: boolean; repo?: string; branch: string; hasGithubKey?: boolean
  githubTokenType?: 'fine-grained' | 'classic' | 'invalid'; githubTokenSavedAt?: string
  legacyXCleanedAt?: string; openAtLogin?: boolean; openAtLoginAvailable?: boolean
}
export interface SearchQuery { query?: string; kind?: Kind; tag?: string; author?: string; from?: string; to?: string; deleted?: boolean; sort?: 'relevance' | 'date' }
export interface SearchHit extends Note { snippet: string; score: number }
export interface Snapshot { notes: Note[]; conflicts: Conflict[]; settings: Settings; library: string; status: string; xStatus: string; syncStatus: string; archive: ArchiveProgress; xLoggedIn: boolean; bookmarks: BookmarkGuardInfo }
export interface Bridge {
  snapshot(): Promise<Snapshot>
  editorDirty(dirty: boolean): void
  recoverUnsaved(note: { id: string; title: string; body: string }): Promise<string>
  save(note: Partial<Note> & { body: string; title: string; kind: Kind }, expected?: string): Promise<Note>
  remove(id: string, restore?: boolean): Promise<void>
  search(query: SearchQuery): Promise<SearchHit[]>
  resolve(id: string, action: 'current' | 'incoming' | 'both' | 'merge', body?: string): Promise<void>
  image(data: number[], name: string): Promise<string>
  asset(path: string, notePath?: string): Promise<string>
  copyImage(path: string, notePath?: string): Promise<void>
  showImageMenu(path: string, notePath?: string): Promise<void>
  selectLibrary(): Promise<void>
  openLibrary(): Promise<void>
  exportNote(id: string): Promise<void>
  settings(value: Partial<Settings>, secret?: { githubKey?: string }): Promise<void>
  setOpenAtLogin(enabled: boolean): Promise<void>
  loginX(): Promise<void>
  connectX(): Promise<void>
  showX(): Promise<void>
  disconnectX(): Promise<void>
  collectUrl(url: string): Promise<{ id: string; result: 'created' | 'updated' | 'unchanged' }>
  collectBookmarks(limit: 20 | 50 | 100): Promise<BookmarkRunResult>
  pauseScan(): Promise<void>
  sync(): Promise<void>
  checkSync(): Promise<void>
  external(url: string): Promise<void>
  onChange(fn: () => void): () => void
  onBeforeClose(fn: (recover: boolean) => Promise<void>): () => void
}
declare global { interface Window { xm: Bridge } }
