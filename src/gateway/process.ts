import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';
import { markStartupInProgress, markStartupSuccess, markStartupFailed } from './state';

const STARTUP_LOG_PATH = '/tmp/moltbot-startup.log';

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "clawdbot devices list"
      // Note: CLI is still named "clawdbot" until upstream renames it
      const isGatewayProcess = 
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand = 
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 * 
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  markStartupInProgress();

  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Moltbot gateway is reachable');
      markStartupSuccess();
      return existingProcess;
    } catch (e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');
  const envVars = buildEnvVars(env);
  // Redirect stdout/stderr to a log file so we can read it even after the process exits
  const command = `/usr/local/bin/start-moltbot.sh > ${STARTUP_LOG_PATH} 2>&1`;

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    markStartupFailed(startErr instanceof Error ? startErr.message : String(startErr));
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');
    markStartupSuccess();

    // Log startup output for debugging
    const startupLogs = await readStartupLogs(sandbox);
    if (startupLogs) console.log('[Gateway] startup logs:', startupLogs);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);

    // Read logs from the file - this works even after the process has exited
    const startupLogs = await readStartupLogs(sandbox);
    console.error('[Gateway] startup failed. Logs:', startupLogs || '(empty)');

    const errorMsg = startupLogs
      ? `Moltbot gateway failed to start:\n${startupLogs}`
      : `Moltbot gateway failed to start: ${e instanceof Error ? e.message : String(e)}`;
    markStartupFailed(errorMsg);
    throw new Error(errorMsg);
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');

  return process;
}

/**
 * Read the startup log file from the sandbox.
 * Returns the log content, or null if the file doesn't exist or can't be read.
 */
async function readStartupLogs(sandbox: Sandbox): Promise<string | null> {
  try {
    const proc = await sandbox.startProcess(`cat ${STARTUP_LOG_PATH} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    return logs.stdout || null;
  } catch {
    return null;
  }
}
