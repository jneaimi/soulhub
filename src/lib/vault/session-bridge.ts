import { getVaultEngine } from './index.js';
import { readLogTail, type SessionMeta } from '../pty/store.js';
import { loadAgentRunRecord } from '../sessions/run-record.js';

/**
 * Save a completed PTY session as a vault note.
 * Non-blocking — errors are caught and logged.
 */
export async function captureSessionToVault(sessionId: string, meta: SessionMeta): Promise<void> {
  const engine = getVaultEngine();
  if (!engine) {
    console.warn('[vault/session] Engine not initialized — skipping session capture');
    return;
  }

  // Skip very short sessions (< 5 seconds or < 100 bytes logged)
  if (meta.logSize < 100) return;
  const startTime = new Date(meta.startedAt).getTime();
  const endTime = meta.endedAt ? new Date(meta.endedAt).getTime() : Date.now();
  if (endTime - startTime < 5000) return;

  try {
    // Read last portion of log (cap at 20KB) — the fallback body when no
    // transcript is available (interactive terminals set no --session-id).
    const rawLog = readLogTail(sessionId, 20_000);
    // Strip ANSI escape codes for clean markdown
    const log = rawLog.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

    // ADR-002 Layer 1 — agent dispatches set a deterministic Claude session id;
    // when present, prefer Claude Code's structured transcript over the raw log.
    const record = meta.claudeSessionId
      ? await loadAgentRunRecord(meta.claudeSessionId, { cwd: meta.cwd, timeoutMs: 2000 })
      : null;

    // Detect project from cwd (for tagging, not zone routing)
    const cwdParts = meta.cwd.split('/');
    const devIdx = cwdParts.indexOf('dev');
    const projectName = devIdx >= 0 && cwdParts[devIdx + 1] ? cwdParts[devIdx + 1] : null;

    // Sessions go to operations/sessions/ (valid vault zone)
    const zone = 'operations';

    // Generate filename with sessions/ subdir
    const date = meta.startedAt.slice(0, 10);
    const shortId = sessionId.slice(0, 8);
    const filename = `sessions/${date}-session-${shortId}.md`;

    // Calculate duration
    const durationSec = Math.floor((endTime - startTime) / 1000);
    const durationStr = durationSec < 60 ? `${durationSec}s` :
      durationSec < 3600 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` :
      `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m`;

    // Build content — link back to project so graph shows the connection
    let content = `# Session ${shortId}\n\n`;
    if (projectName) {
      content += `Part of [[projects/${projectName}/index|${projectName}]]\n\n`;
    }
    content += `## Context\n\n`;
    content += `- **Working Directory**: \`${meta.cwd}\`\n`;
    content += `- **Started**: ${meta.startedAt}\n`;
    if (meta.endedAt) content += `- **Ended**: ${meta.endedAt}\n`;
    content += `- **Duration**: ${durationStr}\n`;
    content += `- **Exit Code**: ${meta.exitCode ?? 'N/A'}\n`;
    content += `- **Log Size**: ${(meta.logSize / 1024).toFixed(1)} KB\n`;
    if (meta.prompt) {
      content += `\n**Initial Prompt**:\n\`\`\`\n${meta.prompt.slice(0, 500)}\n\`\`\`\n`;
    }
    if (record) {
      content += `\n## Result\n\n`;
      content += record.finalAssistantText
        ? `${record.finalAssistantText}\n`
        : `_No assistant text in transcript._\n`;
      content += `\n## Activity\n\n`;
      content += `- **Assistant turns**: ${record.assistantTurns}\n`;
      content += `- **Tool calls**: ${record.toolCallCount}\n`;
      const tb = record.summary.toolBreakdown;
      const tools = Object.keys(tb);
      if (tools.length) content += `- **Tools**: ${tools.map((t) => `${t}×${tb[t]}`).join(', ')}\n`;
      if (record.summary.cost.totalUsd != null)
        content += `- **Cost**: $${record.summary.cost.totalUsd.toFixed(4)}\n`;
      content += `- **Transcript**: \`${record.jsonlPath}\`\n`;
    } else {
      content += `\n## Session Log (last ${Math.min(meta.logSize, 20000)} bytes)\n\n`;
      content += `\`\`\`\n${log}\n\`\`\`\n`;
    }

    const tags = ['session'];
    if (projectName) tags.push(projectName);
    if (meta.exitCode != null && meta.exitCode !== 0) tags.push('error');

    const result = await engine.createNote({
      zone,
      filename,
      meta: {
        type: 'session-log',
        created: date,
        tags,
        project: projectName || undefined,
        session_id: sessionId,
        claude_session_id: meta.claudeSessionId || undefined,
        exit_code: meta.exitCode,
        duration_sec: durationSec,
      },
      content,
    });

    if (result.success) {
      console.log(`[vault/session] Captured: ${result.path}`);
    } else if ('error' in result) {
      console.log(`[vault/session] Skipped: ${result.error}`);
    }
  } catch (err) {
    console.error(`[vault/session] Failed:`, err instanceof Error ? err.message : err);
  }
}
