const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, 'logs');

app.use(express.json());
app.use(express.static(ROOT));
app.use('/output', express.static(path.join(ROOT, 'output')));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'code2docs-notion-wiki.html'));
});

function extractRepoName(repoUrl) {
  return repoUrl.split('/').pop().replace(/\.git$/, '');
}

function outputExists(repoName) {
  return fs.existsSync(path.join(ROOT, 'output', repoName, 'index.html'));
}

function logPath(repoName) {
  return path.join(LOGS_DIR, `${repoName}.log`);
}

function appendLog(repoName, line) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.appendFileSync(logPath(repoName), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
}

app.post('/api/generate-docs', (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) {
    return res.status(400).json({ success: false, error: 'Repository URL is required' });
  }

  const repoName = extractRepoName(repoUrl);
  const repoPath = path.join(ROOT, 'cloned-repos', repoName);

  // Reset log for this run
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(logPath(repoName), '', 'utf8');
  appendLog(repoName, `Starting documentation for: ${repoUrl}`);

  // Clone or pull
  try {
    if (fs.existsSync(repoPath)) {
      appendLog(repoName, `Repository already cloned — running git pull...`);
      const pullOut = execSync('git pull', { cwd: repoPath, stdio: 'pipe', timeout: 60000 });
      appendLog(repoName, `git pull: ${pullOut.toString().trim() || 'Already up to date.'}`);
    } else {
      appendLog(repoName, `Cloning repository...`);
      fs.mkdirSync(path.join(ROOT, 'cloned-repos'), { recursive: true });
      execSync(`git clone "${repoUrl}" "${repoPath}"`, { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
      appendLog(repoName, `Clone complete → ${repoPath}`);
    }
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.message;
    appendLog(repoName, `ERROR (git): ${msg}`);
    return res.status(500).json({ success: false, error: `Git error: ${msg}` });
  }

  const docsExist = outputExists(repoName);
  const action = docsExist ? 'Update' : 'Create';
  appendLog(repoName, `Documentation status: ${docsExist ? 'EXISTS — will update' : 'NOT FOUND — will create from scratch'}`);

  const prompt = docsExist
    ? `Update the documentation for my codebase at ./cloned-repos/${repoName}. Save the updated output to ./output/${repoName}/`
    : `Create the documentation for my codebase at ./cloned-repos/${repoName}. Save the output to ./output/${repoName}/`;

  const allowedTools = [
    'Write', 'Edit', 'Read', 'Glob', 'Grep',
    'Bash(git log:*)', 'Bash(git clone:*)', 'Bash(git pull:*)',
    'Bash(git fetch:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
    'Bash(git blame:*)', 'Bash(git branch:*)', 'Bash(git status:*)',
    'Bash(git tag:*)', 'Bash(git stash:*)',
    'Bash(ls:*)', 'Bash(find:*)', 'Bash(mkdir:*)',
    'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(pwd:*)'
  ].join(',');

  const claudeArgs = [
    '--agent', 'codebase-wiki-documenter',
    '--allowedTools', allowedTools,
    '--dangerously-skip-permissions',
    '--print',
    prompt
  ];

  appendLog(repoName, `Spawning claude agent (${action.toLowerCase()})...`);
  appendLog(repoName, `Command: claude ${claudeArgs.join(' ')}`);

  const logFd = fs.openSync(logPath(repoName), 'a');

  // shell: false so cmd.exe doesn't mangle parentheses/asterisks in --allowedTools
  const claudeProcess = spawn('claude', claudeArgs, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    shell: false
  });

  claudeProcess.on('error', (err) => {
    try {
      fs.appendFileSync(logPath(repoName), `[ERROR] Failed to spawn claude: ${err.message}\n`);
    } catch (_) {}
    fs.closeSync(logFd);
  });

  // Close the FD only after the child exits so Windows doesn't drop the handle early
  claudeProcess.on('close', () => {
    try { fs.closeSync(logFd); } catch (_) {}
  });

  claudeProcess.unref();

  res.json({
    success: true,
    repoName,
    action,
    outputUrl: `/output/${repoName}/`,
    message: `Documentation ${action.toLowerCase()} started in background`
  });
});

app.get('/api/doc-status/:repoName', (req, res) => {
  const { repoName } = req.params;
  res.json({
    hasIndex: outputExists(repoName),
    repoExists: fs.existsSync(path.join(ROOT, 'cloned-repos', repoName)),
    outputUrl: `/output/${repoName}/`
  });
});

app.get('/api/logs/:repoName', (req, res) => {
  const lp = logPath(req.params.repoName);
  if (!fs.existsSync(lp)) return res.json({ logs: '' });
  const content = fs.readFileSync(lp, 'utf8');
  // Return last 200 lines so the response stays small
  const lines = content.split('\n');
  res.json({ logs: lines.slice(-200).join('\n') });
});

app.listen(PORT, () => {
  console.log(`Code2Docs server running at http://localhost:${PORT}`);
});
