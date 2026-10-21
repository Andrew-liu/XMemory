export function pruneSecrets(secrets: Record<string, string>) {
  let removed = false
  for (const key of Object.keys(secrets)) if (key !== 'github') { delete secrets[key]; removed = true }
  return removed
}
