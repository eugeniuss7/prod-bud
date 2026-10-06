'use strict';
// Asks Claude through the Claude Code CLI (`claude -p`), so it runs on your Claude subscription.
// The prompt goes in on stdin; the answer comes back as JSON matching `schema`.

// cross-spawn resolves claude.cmd/claude.exe on Windows and escapes arguments for cmd.exe.
const spawn = require('cross-spawn');

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

class ClaudeError extends Error {}

function cliArgs({ system, schema, model }) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    // cmd.exe can't carry newlines inside an argument, so keep it on one line.
    '--system-prompt', system.replace(/\s*\n\s*/g, ' '),
    // A plain question/answer: no tools, MCP servers, skills or saved session.
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  return args;
}

// Pull the structured answer out of the CLI's JSON envelope.
function parseCliOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  } catch {
    throw new ClaudeError(`Unexpected output from Claude CLI: ${stdout.slice(0, 300)}`);
  }
  if (envelope.is_error) {
    const msg = String(envelope.result || envelope.subtype || 'unknown error');
    if (/not logged in|\/login/i.test(msg)) {
      throw new ClaudeError('Claude Code is not logged in. Open a terminal, run `claude`, and log in once.');
    }
    throw new ClaudeError(`Claude CLI error: ${msg}`);
  }
  if (envelope.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  // Fallback: the first JSON object in the text result.
  const text = String(envelope.result || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw new ClaudeError(`Claude's answer wasn't valid JSON: ${text.slice(0, 300)}`);
}

function askClaude({ prompt, system, schema, command = 'claude', model = '', cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cliArgs({ system, schema, model }), {
      windowsHide: true,
      // Run outside any project so no CLAUDE.md or project settings leak into the answer.
      cwd,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClaudeError(`Claude took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new ClaudeError(`Claude Code CLI not found ("${command}"). Install Claude Code on Windows, or set claude.command in config.yaml.`)
          : err,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        const hint = /not recognized|not found/i.test(stderr) ? ' Is Claude Code installed on Windows?' : '';
        return reject(new ClaudeError(`Claude CLI exited with code ${code}.${hint} ${stderr.trim().slice(0, 300)}`));
      }
      try {
        resolve(parseCliOutput(stdout));
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(prompt);
  });
}

module.exports = { askClaude, parseCliOutput, cliArgs, ClaudeError };
