// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import {
  applyTrackerLaunchIdentity,
  assertTrackerItemInWorkspace,
  buildTrackerLaunchContext,
  createTrackerWorktreeSession,
  deriveTrackerWorktreeName,
  isTrackerLaunchForWorkspace,
} from '../trackerSessionLaunch';

function makeTrackerRecord(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: 'feature_1624',
    primaryType: 'feature',
    typeTags: ['feature'],
    issueKey: 'NIM-1624',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    fields: {
      title: 'Launch a Worktree from a Tracker',
      status: 'in-progress',
      priority: 'high',
      description: 'Create an isolated session with the tracker context pre-filled.',
    },
    system: {
      workspace: '/repo',
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('buildTrackerLaunchContext', () => {
  it('builds the native tracker link, shared draft, and worktree name', () => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(context).toEqual({
      workspacePath: '/repo',
      trackerLinkId: 'feature_1624',
      draftInput: [
        'implement tracker item NIM-1624: Launch a Worktree from a Tracker',
        'type: feature, status: in-progress, priority: high',
        '',
        'Create an isolated session with the tracker context pre-filled.',
        '',
        'Update this tracker item\'s status when done using tracker_update with id "NIM-1624".',
      ].join('\n'),
      worktreeName: 'nim-1624-launch-a-worktree-from-a-tracker',
      cardIdentity: {
        primaryTrackerId: 'feature_1624',
        issueKey: 'NIM-1624',
        cardTitle: 'Launch a Worktree from a Tracker',
        purpose: 'Implementation',
      },
      sessionTitle: 'NIM-1624 · Launch a Worktree from a Tracker — Implementation',
    });
  });

  it('uses the file tracker link and includes the document source', () => {
    const trackerItem = makeTrackerRecord({
      id: 'plan-branching',
      issueKey: undefined,
      primaryType: 'plan',
      typeTags: ['plan'],
      source: 'frontmatter',
      fields: {
        title: 'Branching Plan',
        status: 'to-do',
      },
      system: {
        workspace: '/repo',
        documentPath: 'nimbalyst-local/plans/branching.md',
        createdAt: '2026-07-16T12:00:00.000Z',
        updatedAt: '2026-07-16T12:00:00.000Z',
      },
    });

    const context = buildTrackerLaunchContext('plan-branching', trackerItem);

    expect(context.trackerLinkId).toBe('file:nimbalyst-local/plans/branching.md');
    expect(context.draftInput).toContain('implement tracker item plan-branching: Branching Plan');
    expect(context.draftInput).toContain('Source: @nimbalyst-local/plans/branching.md');
    expect(context.worktreeName).toBe('plan-branching-branching-plan');
    expect(context.sessionTitle).toBe('Branching Plan — Implementation');
  });

  // A draft card has no key until it is published; never invent one.
  it('titles a keyless draft card with its title alone', () => {
    const context = buildTrackerLaunchContext('task_1', makeTrackerRecord({
      id: 'task_1',
      issueKey: undefined,
      fields: { title: 'Draft card', status: 'to-do' },
    }));

    expect(context.sessionTitle).toBe('Draft card — Implementation');
    expect(context.cardIdentity).not.toHaveProperty('issueKey');
    expect(context.cardIdentity.primaryTrackerId).toBe('task_1');
  });

  it('keeps a long card title whole instead of truncating the key or purpose', () => {
    const longTitle = 'Keep card-linked chat names correct automatically across restart, resume, provider change and publication';
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord({
      fields: { title: longTitle, status: 'to-do' },
    }));

    expect(context.sessionTitle).toBe(`NIM-1624 · ${longTitle} — Implementation`);
  });
});

describe('assertTrackerItemInWorkspace', () => {
  it('accepts an item that belongs to the board project', () => {
    expect(() => assertTrackerItemInWorkspace(makeTrackerRecord(), '/repo')).not.toThrow();
  });

  // A board showing another project's items (#1822) must not start an agent
  // in the board's folder with a prompt about the other project.
  it('refuses an item from another project', () => {
    expect(() => assertTrackerItemInWorkspace(makeTrackerRecord(), '/other-repo'))
      .toThrow('/repo');
  });

  it('refuses an item that is not loaded', () => {
    expect(() => assertTrackerItemInWorkspace(undefined, '/repo')).toThrow();
  });
});

describe('isTrackerLaunchForWorkspace', () => {
  it('keeps a pending launch only while its own project is on screen', () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(isTrackerLaunchForWorkspace(pending, '/repo')).toBe(true);
    expect(isTrackerLaunchForWorkspace(pending, '/other-repo')).toBe(false);
    expect(isTrackerLaunchForWorkspace({ ...pending, workspacePath: undefined }, undefined)).toBe(false);
  });
});

describe('createTrackerWorktreeSession', () => {
  it('refuses a pending launch after the active project changes without creating a session', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn(async () => 'session');

    await expect(createTrackerWorktreeSession(pending, '/other-repo', { baseBranch: 'main' }, createSession))
      .rejects.toThrow(/project changed/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('passes the original draft and branch to creation in the originating project', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn(async () => 'session');

    await expect(createTrackerWorktreeSession(pending, '/repo', { baseBranch: 'main' }, createSession))
      .resolves.toBe('session');
    expect(createSession).toHaveBeenCalledWith({ baseBranch: 'main', initialDraft: pending.draftInput });
  });
});

describe('deriveTrackerWorktreeName', () => {
  it('produces a bounded branch-safe slug', () => {
    const name = deriveTrackerWorktreeName(
      'NIM-1624',
      'Launch worktree: preserve SAME tracker context?! with a deliberately long title',
    );

    expect(name).toMatch(/^nim-1624-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/-$/);
  });
});

describe('applyTrackerLaunchIdentity', () => {
  it('writes the card identity for the new session', async () => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const invoke = vi.fn(async () => ({ success: true }));

    await expect(applyTrackerLaunchIdentity('session', context, invoke)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('sessions:set-card-identity', 'session', context.cardIdentity);
  });

  it('does not fail the launch when naming fails', async () => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const invoke = vi.fn(async () => { throw new Error('ipc down'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(applyTrackerLaunchIdentity('session', context, invoke)).resolves.toBe(false);
    error.mockRestore();
  });
});
