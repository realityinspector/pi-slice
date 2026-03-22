import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RepoInfo {
  name: string;
  owner?: string;
  description?: string;
  defaultBranch: string;
  language?: string;
  languages: string[];
  hasPackageJson: boolean;
  hasDockerfile: boolean;
  hasCICD: boolean;
  hasTests: boolean;
  framework?: string;  // next, react, express, django, flask, fastapi, etc.
  packageManager?: string; // npm, pnpm, yarn, pip, cargo, go
  fileCount: number;
  recentCommits: Array<{ hash: string; message: string; author: string; date: string }>;
  openIssues: Array<{ number: number; title: string; labels: string[] }>;
  openPRs: Array<{ number: number; title: string; author: string }>;
  contributors: string[];
  readme?: string;
  structure: string[]; // top-level directories
}

export async function scanRepo(cwd: string): Promise<RepoInfo | null> {
  // Check if we're in a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' });
  } catch {
    return null; // Not a git repo
  }

  const info: RepoInfo = {
    name: path.basename(cwd),
    defaultBranch: 'main',
    languages: [],
    hasPackageJson: false,
    hasDockerfile: false,
    hasCICD: false,
    hasTests: false,
    fileCount: 0,
    recentCommits: [],
    openIssues: [],
    openPRs: [],
    contributors: [],
    structure: [],
  };

  // 1. Basic git info
  try {
    info.defaultBranch = execSync('git symbolic-ref --short HEAD', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    // Detached HEAD or other issue, keep default
  }

  // 2. Recent commits (last 10)
  try {
    const log = execSync('git log --oneline -10 --format="%H|%s|%an|%aI"', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    info.recentCommits = log.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, author, date] = line.split('|');
      return { hash, message, author, date };
    });
  } catch {
    // No commits yet or other error
  }

  // 3. Contributors from git log
  try {
    const authors = execSync('git log --format="%an" | sort -u | head -20', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    info.contributors = authors.trim().split('\n').filter(Boolean);
  } catch {
    // ignore
  }

  // 4. GitHub info via `gh` CLI (if available)
  try {
    const ghRepo = execSync('gh repo view --json name,owner,description', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const gh = JSON.parse(ghRepo);
    info.owner = gh.owner?.login;
    info.description = gh.description;

    // Open issues
    try {
      const issues = execSync('gh issue list --limit 10 --json number,title,labels', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      info.openIssues = JSON.parse(issues).map((i: any) => ({
        number: i.number, title: i.title, labels: i.labels?.map((l: any) => l.name) || []
      }));
    } catch {
      // ignore
    }

    // Open PRs
    try {
      const prs = execSync('gh pr list --limit 10 --json number,title,author', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      info.openPRs = JSON.parse(prs).map((p: any) => ({
        number: p.number, title: p.title, author: p.author?.login || ''
      }));
    } catch {
      // ignore
    }
  } catch {
    // gh not available, that's ok
  }

  // 5. Detect languages, frameworks, package managers
  info.hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  info.hasDockerfile = fs.existsSync(path.join(cwd, 'Dockerfile'));
  info.hasCICD = fs.existsSync(path.join(cwd, '.github/workflows'));
  info.hasTests = fs.existsSync(path.join(cwd, 'tests')) || fs.existsSync(path.join(cwd, '__tests__')) || fs.existsSync(path.join(cwd, 'test'));

  if (info.hasPackageJson) {
    info.languages.push('JavaScript/TypeScript');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) info.framework = 'Next.js';
      else if (deps.react) info.framework = 'React';
      else if (deps.express) info.framework = 'Express';
      else if (deps.fastify) info.framework = 'Fastify';
      // Detect package manager
      if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) info.packageManager = 'pnpm';
      else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) info.packageManager = 'yarn';
      else if (fs.existsSync(path.join(cwd, 'package-lock.json'))) info.packageManager = 'npm';
    } catch {
      // Malformed package.json
    }
  }

  if (fs.existsSync(path.join(cwd, 'requirements.txt')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    info.languages.push('Python');
    info.packageManager = info.packageManager || 'pip';
    const pyprojectPath = path.join(cwd, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        if (content.includes('django')) info.framework = 'Django';
        else if (content.includes('fastapi')) info.framework = 'FastAPI';
        else if (content.includes('flask')) info.framework = 'Flask';
      } catch {
        // ignore
      }
    }
  }

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    info.languages.push('Rust');
    info.packageManager = info.packageManager || 'cargo';
  }

  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    info.languages.push('Go');
    info.packageManager = info.packageManager || 'go';
  }

  if (info.languages.length > 0) {
    info.language = info.languages[0];
  }

  // 6. File structure (top-level dirs)
  try {
    info.structure = fs.readdirSync(cwd)
      .filter(f => !f.startsWith('.') && fs.statSync(path.join(cwd, f)).isDirectory())
      .slice(0, 20);
  } catch {
    // ignore
  }

  // 7. README
  for (const readme of ['README.md', 'readme.md', 'README.rst']) {
    const p = path.join(cwd, readme);
    if (fs.existsSync(p)) {
      try {
        info.readme = fs.readFileSync(p, 'utf8').slice(0, 3000); // First 3k chars
      } catch {
        // ignore
      }
      break;
    }
  }

  // 8. File count
  try {
    info.fileCount = parseInt(execSync('git ls-files | wc -l', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim());
  } catch {
    info.fileCount = 0;
  }

  return info;
}
