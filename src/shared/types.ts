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
}
export interface Conflict { id: string; noteId: string; title: string; current: Note; incoming: Note; createdAt: string; currentRaw?: string; incomingRaw?: string; currentMetadata?: Record<string, unknown>; incomingMetadata?: Record<string, unknown> }
export interface Provider { id: string; name: string; baseURL: string; model: string; hasKey?: boolean }
export interface Settings {
  theme: 'system' | 'light' | 'dark'; providers: Provider[]; activeProvider: string
  scanMinutes: number; collect: boolean; closeToTray: boolean
  cookieDirectory?: string; repo?: string; branch: string; hasGithubKey?: boolean
  githubTokenType?: 'fine-grained' | 'classic' | 'invalid'; githubTokenSavedAt?: string
}
export interface SearchQuery { query?: string; kind?: Kind; tag?: string; author?: string; from?: string; to?: string; deleted?: boolean; sort?: 'relevance' | 'date' }
export interface SearchHit extends Note { snippet: string; score: number }
export interface Snapshot { notes: Note[]; conflicts: Conflict[]; settings: Settings; library: string; status: string; xStatus: string; cookieStatus: string; syncStatus: string; archive: ArchiveProgress; xLoggedIn: boolean }
export interface RunEvent { type: 'text' | 'status' | 'done' | 'error'; text: string }
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
  settings(value: Partial<Settings>, secret?: { providerId?: string; apiKey?: string; githubKey?: string }): Promise<void>
  importCookies(): Promise<void>
  watchCookies(): Promise<void>
  loginX(): Promise<void>
  connectX(): Promise<void>
  showX(): Promise<void>
  disconnectX(): Promise<void>
  collectTestPosts(): Promise<void>
  pauseScan(): Promise<void>
  retryFailed(): Promise<void>
  sync(): Promise<void>
  checkSync(): Promise<void>
  generate(id: string, instruction: string, sources: string[], mode: 'short' | 'thread', agentMode: AgentMode): Promise<void>
  cancel(): Promise<void>
  external(url: string): Promise<void>
  onChange(fn: () => void): () => void
  onRun(fn: (event: RunEvent) => void): () => void
  onBeforeClose(fn: (recover: boolean) => Promise<void>): () => void
}
declare global { interface Window { xm: Bridge } }
