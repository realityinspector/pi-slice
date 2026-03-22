import { FeedServer } from '@slice/feed';
import { RepoInfo } from './repo-scanner.js';

export async function generateRepoReport(feed: FeedServer, repo: RepoInfo): Promise<void> {
  // Post a series of agent messages that review the repo

  // 1. Director introduces the workspace
  feed.addPost({
    agentName: 'Director',
    agentRole: 'director',
    content: `Scanned repo: **${repo.owner ? repo.owner + '/' : ''}${repo.name}**\n${repo.description || ''}\n\n` +
      `${repo.framework ? '**Framework:** ' + repo.framework + '\n' : ''}` +
      `**Branch:** ${repo.defaultBranch}\n` +
      `**Files:** ${repo.fileCount}\n` +
      `**Structure:** ${repo.structure.slice(0, 8).join(', ')}${repo.structure.length > 8 ? '...' : ''}`,
  });

  // 2. Worker reports on code health
  const healthItems: string[] = [];
  if (repo.hasTests) healthItems.push('✓ Tests directory found');
  else healthItems.push('⚠ No tests directory detected');
  if (repo.hasCICD) healthItems.push('✓ CI/CD workflows configured');
  else healthItems.push('⚠ No CI/CD workflows found');
  if (repo.hasDockerfile) healthItems.push('✓ Dockerfile present');
  if (repo.packageManager) healthItems.push(`✓ Package manager: ${repo.packageManager}`);

  feed.addPost({
    agentName: 'scout',
    agentRole: 'worker',
    content: `**Code Health Scan:**\n${healthItems.join('\n')}`,
  });

  // 3. If there are open issues, surface them
  if (repo.openIssues.length > 0) {
    const issueList = repo.openIssues.slice(0, 5)
      .map(i => `• #${i.number} ${i.title}${i.labels.length ? ' [' + i.labels.join(', ') + ']' : ''}`)
      .join('\n');

    feed.addPost({
      agentName: 'scout',
      agentRole: 'worker',
      content: `**Open Issues** (${repo.openIssues.length}):\n${issueList}${repo.openIssues.length > 5 ? '\n... and more' : ''}`,
    });
  }

  // 4. If there are open PRs, surface them
  if (repo.openPRs.length > 0) {
    const prList = repo.openPRs.slice(0, 5)
      .map(p => `• PR #${p.number} "${p.title}" by ${p.author}`)
      .join('\n');

    feed.addPost({
      agentName: 'carol',
      agentRole: 'steward',
      content: `**Open Pull Requests** (${repo.openPRs.length}):\n${prList}`,
    });
  }

  // 5. Recent activity summary
  if (repo.recentCommits.length > 0) {
    const commitList = repo.recentCommits.slice(0, 5)
      .map(c => `• ${c.message} (${c.author})`)
      .join('\n');

    feed.addPost({
      agentName: 'Director',
      agentRole: 'director',
      content: `**Recent Activity:**\n${commitList}`,
    });
  }

  // 6. Director asks questions to orient
  const questions: string[] = [];
  if (!repo.hasTests) questions.push('• Should I set up a testing framework?');
  if (!repo.hasCICD) questions.push('• Want me to create a CI/CD pipeline?');
  if (!repo.hasDockerfile) questions.push('• Should I add Docker support?');
  if (repo.openIssues.length > 0) questions.push('• Want me to triage the open issues?');
  if (repo.openPRs.length > 0) questions.push('• Should I review the open PRs?');
  questions.push('• What are the priorities for this workspace?');

  feed.addPost({
    agentName: 'Director',
    agentRole: 'director',
    content: `**Questions for you:**\n${questions.join('\n')}\n\nReply here or @mention me with what you'd like to focus on.`,
  });
}
