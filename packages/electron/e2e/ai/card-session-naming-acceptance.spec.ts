/**
 * LEO-23 acceptance for card-linked session naming, run against the branch
 * build in a disposable workspace that has no agent instructions
 * (no AGENTS.md / CLAUDE.md), so every name below comes from the app itself.
 *
 * Cases: Launch Session, Launch Worktree and a review launch from one card;
 * a first turn; provider switch; a second linked card; card rename; custom
 * name and return to automatic; a deleted primary card; a general chat;
 * restart and resume; navigation from the key back to the card.
 *
 * Fixture data is SYNTHETIC. Soft assertions let every case report; the
 * observed values are written to results.json beside the screenshots in
 * e2e_test_output/card-session-naming-acceptance/.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempWorkspace, launchElectronApp, waitForAppReady } from '../helpers';
import { submitChatPrompt, switchToAgentMode } from '../utils/testHelpers';

const OUT = path.resolve(__dirname, '../../../../e2e_test_output/card-session-naming-acceptance');
const MAIN_PATH = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.resolve(__dirname, '../../out2/main/index.js');
const LONG_TITLE = 'SYNTHETIC Verify that a chat launched from a tracker card keeps the card title and its purpose through a first turn, a provider switch, a second linked card and a full application restart';
const RENAMED = 'SYNTHETIC Card renamed during acceptance';
const SECOND_TITLE = 'SYNTHETIC Second card linked later';
const GONE_TITLE = 'SYNTHETIC Card that will be deleted';
const KEY = 'SYN-23';

let app: ElectronApplication;
let page: Page;
let workspace: string;
const results: Array<{ case: string; expected: unknown; observed: unknown; pass: boolean }> = [];

test.setTimeout(300_000);

function record(name: string, expected: unknown, observed: unknown): void {
  const pass = JSON.stringify(expected) === JSON.stringify(observed);
  results.push({ case: name, expected, observed, pass });
  expect.soft(observed, name).toEqual(expected);
}

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(({ channel, args }) => (window as any).electronAPI.invoke(channel, ...args), { channel, args });
}

async function session(id: string): Promise<{ title: string; provider: string; metadata: any }> {
  const result = await invoke('sessions:get', id);
  const s = result?.session ?? result;
  const metadata = typeof s?.metadata === 'string' ? JSON.parse(s.metadata) : (s?.metadata ?? {});
  return { title: s?.title, provider: s?.provider, metadata };
}

async function sessionIdByTitle(title: string): Promise<string> {
  let id: string | undefined;
  await expect.poll(async () => {
    const list = await invoke('sessions:list', workspace, { includeArchived: true });
    const entries: any[] = Array.isArray(list) ? list : (list?.sessions ?? []);
    id = entries.find((entry) => entry.title === title)?.id;
    return id;
  }, { timeout: 15_000, message: `session titled ${title}` }).toBeTruthy();
  return id!;
}

async function createItem(title: string): Promise<string> {
  const id = `task_${randomUUID().slice(0, 8)}`;
  const created = await page.evaluate(({ id, workspace, title }) => (window as any).electronAPI.documentService.createTrackerItem({
    id, type: 'task', title, status: 'to-do', priority: 'medium', workspace,
  }), { id, workspace, title });
  expect(created).toMatchObject({ success: true });
  return id;
}

async function openItem(id: string): Promise<void> {
  // From Agent mode the item opens as a docked panel without launch buttons; leave Agent mode first.
  await page.locator('[data-mode="files"]').first().click();
  await page.waitForTimeout(500);
  await page.evaluate((itemId) => window.dispatchEvent(new CustomEvent('nimbalyst:navigate-tracker-item', { detail: { itemId } })), id);
  await expect(page.locator('.tracker-sessions-section:visible').first()).toBeVisible({ timeout: 15_000 });
}

async function choosePurpose(purpose: string): Promise<void> {
  await page.locator('[data-testid="tracker-launch-purpose-trigger"]:visible').first().click();
  await page.getByTestId('tracker-launch-purpose-menu').getByRole('menuitemradio', { name: purpose }).click();
  await expect(page.locator('[data-testid="tracker-launch-purpose-trigger"]:visible').first()).toContainText(purpose);
}

async function launch(preserve: boolean): Promise<void> {
  app = await launchElectronApp({ workspace, mainPath: MAIN_PATH, permissionMode: 'allow-all', preserveTestDatabase: preserve });
  page = await app.firstWindow();
  if (!preserve) {
    await waitForAppReady(page);
  } else {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('[data-mode="agent"]', { timeout: 30_000 });
  }
}

const row = (label: string) => page.locator(`[aria-label^="Session: ${label},"]`).first();

test.beforeAll(async () => {
  // Launching Electron plus a reload can exceed the 15 s hook default on a loaded machine.
  test.setTimeout(120_000);
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  workspace = await createTempWorkspace();
  // A git repository so Launch Worktree is offered; no agent instruction files.
  await fs.writeFile(path.join(workspace, 'README.md'), '# SYNTHETIC LEO-23 acceptance workspace\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('-c', 'user.name=SYNTHETIC', '-c', 'user.email=synthetic@example.invalid', 'add', '.');
  git('-c', 'user.name=SYNTHETIC', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'SYNTHETIC fixture');
  await launch(false);
  // Launch Worktree is a developer feature; enable it in this throwaway profile only.
  await invoke('developer-mode:set', true);
  await invoke('developer-features:set', { worktrees: true });
  await page.reload();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify({ workspace, results }, null, 2));
  await app?.close();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

test('card-linked names survive ordinary use without workspace instructions', async () => {
  const entries = await fs.readdir(workspace);
  record('workspace has no agent instruction files', [], entries.filter((name) => /^(AGENTS|CLAUDE)\.md$/i.test(name)));

  // 1. Launch Session, Launch Worktree and a review launch from one card (real UI).
  const cardId = await createItem(LONG_TITLE);
  await openItem(cardId);
  await page.screenshot({ path: path.join(OUT, '01-card-before-launch.png') });
  const section = page.locator('.tracker-sessions-section:visible').first();
  await section.getByRole('button', { name: 'Launch Session' }).click();
  await expect(page.locator('.agent-mode')).toBeVisible({ timeout: 15_000 });
  const implementationTitle = `${LONG_TITLE} — Implementation`;
  const implementationId = await sessionIdByTitle(implementationTitle);
  record('Launch Session title', implementationTitle, (await session(implementationId)).title);

  await openItem(cardId);
  await choosePurpose('Independent review');
  await section.getByRole('button', { name: 'Launch Session' }).click();
  await expect(page.locator('.agent-mode')).toBeVisible({ timeout: 15_000 });
  const reviewTitle = `${LONG_TITLE} — Independent review`;
  const reviewId = await sessionIdByTitle(reviewTitle);
  record('review launch title', reviewTitle, (await session(reviewId)).title);

  await openItem(cardId);
  await choosePurpose('Investigation');
  await section.getByRole('button', { name: 'Launch Worktree' }).click();
  await expect(page.getByTestId('worktree-base-branch-picker')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(OUT, '02-worktree-picker.png') });
  await page.getByTestId('worktree-base-branch-create').click();
  const worktreeTitle = `${LONG_TITLE} — Investigation`;
  const worktreeId = await sessionIdByTitle(worktreeTitle);
  const worktreeSession = await session(worktreeId);
  record('Launch Worktree title', worktreeTitle, worktreeSession.title);
  record('three launches share the primary card', [cardId, cardId, cardId], [
    (await session(implementationId)).metadata.cardIdentity?.primaryTrackerId,
    (await session(reviewId)).metadata.cardIdentity?.primaryTrackerId,
    worktreeSession.metadata.cardIdentity?.primaryTrackerId,
  ]);

  // 2. First turn on a card chat: the first-prompt title must not replace the card name.
  await switchToAgentMode(page);
  await row(implementationTitle).click();
  await submitChatPrompt(page, 'SYNTHETIC first message that would normally become the provisional title');
  await page.waitForTimeout(25_000); // let a real turn finish, including any agent rename attempt
  record('card chat title after first turn', implementationTitle, (await session(implementationId)).title);
  await page.screenshot({ path: path.join(OUT, '03-after-first-turn.png') });

  // Control: a general chat still takes its provisional title from the first message.
  const generalId = randomUUID();
  await invoke('sessions:create', { session: { id: generalId, title: 'New Session', provider: 'claude-code' }, workspaceId: workspace });
  await page.reload();
  await page.waitForSelector('[data-mode="agent"]', { timeout: 30_000 });
  await switchToAgentMode(page);
  await row('New Session').click();
  await submitChatPrompt(page, 'SYNTHETIC general question about release notes');
  await expect.poll(async () => (await session(generalId)).title, { timeout: 10_000 }).not.toBe('New Session');
  const generalTitle = (await session(generalId)).title;
  record('general chat takes a provisional title and no card mode', { changed: true, namingMode: undefined },
    { changed: generalTitle !== 'New Session', namingMode: (await session(generalId)).metadata.namingMode });

  // 3. Provider switch.
  await invoke('sessions:update-provider-and-model', implementationId, 'openai-codex', 'openai-codex:gpt-6.1-sol');
  const switched = await session(implementationId);
  record('provider switch keeps the card name', { provider: 'openai-codex', title: implementationTitle, namingMode: 'card' },
    { provider: switched.provider, title: switched.title, namingMode: switched.metadata.namingMode });

  // 4. A second linked card does not take over; renaming it changes nothing here.
  const secondId = await createItem(SECOND_TITLE);
  await invoke('tracker:link-session', { trackerId: secondId, sessionId: reviewId });
  await page.evaluate(({ itemId, title }) => (window as any).electronAPI.documentService.updateTrackerItem({
    itemId, updates: { title },
  }), { itemId: secondId, title: `${SECOND_TITLE} (edited)` });
  await page.waitForTimeout(1500);
  const afterSecond = await session(reviewId);
  record('second link keeps primary card and title', { primary: cardId, title: reviewTitle, linked: true },
    { primary: afterSecond.metadata.cardIdentity?.primaryTrackerId, title: afterSecond.title,
      linked: (afterSecond.metadata.linkedTrackerItemIds ?? []).includes(secondId) });

  // 5. Custom name, then a card rename: card chats follow, the custom name stays.
  await invoke('sessions:update-title', worktreeId, 'SYNTHETIC my own worktree name');
  await page.evaluate(({ itemId, title }) => (window as any).electronAPI.documentService.updateTrackerItem({
    itemId, updates: { title },
  }), { itemId: cardId, title: RENAMED });
  await expect.poll(async () => (await session(implementationId)).title, { timeout: 10_000 }).toBe(`${RENAMED} — Implementation`);
  record('card rename reaches card-named chats', [`${RENAMED} — Implementation`, `${RENAMED} — Independent review`],
    [(await session(implementationId)).title, (await session(reviewId)).title]);
  const custom = await session(worktreeId);
  record('custom name kept through card rename', { title: 'SYNTHETIC my own worktree name', namingMode: 'custom' },
    { title: custom.title, namingMode: custom.metadata.namingMode });

  // The identity editor in a worktree chat's header.
  await page.reload();
  await page.waitForSelector('[data-mode="agent"]', { timeout: 30_000 });
  await switchToAgentMode(page);
  await page.locator('[aria-label^="Session: SYNTHETIC my own worktree name"]').first().click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, '04a-worktree-chat-header.png') });
  // Header geometry: how much width the title column keeps, and what sits on the editor button's centre.
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('.workstream-header') as HTMLElement | null;
    const width = (selector: string) => (header?.querySelector(selector) as HTMLElement | null)?.getBoundingClientRect().width ?? null;
    const trigger = [...document.querySelectorAll('[data-testid="session-identity-editor-trigger"]')]
      .find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
    const box = trigger?.getBoundingClientRect();
    const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return {
      header: width(':scope > .workstream-header-main'),
      titleColumn: width('.workstream-header-content'),
      layoutControls: width('.layout-controls'),
      archiveButton: width('.workstream-archive-button'),
      triggerCentreHitsTrigger: !!(trigger && hit && trigger.contains(hit)),
      worktreeChipInsideTitleColumn: (() => {
        const column = header?.querySelector('.workstream-header-content')?.getBoundingClientRect();
        const chip = header?.querySelector('.workstream-header-worktree-chip')?.getBoundingClientRect();
        return column && chip ? chip.right <= column.right + 0.5 : null;
      })(),
      hitElement: hit ? `${hit.tagName.toLowerCase()}.${String((hit as HTMLElement).className).split(' ')[0]}` : null,
    };
  });
  await fs.writeFile(path.join(OUT, '04a-worktree-header-geometry.json'), JSON.stringify(geometry, null, 2));
  // Clickable, not merely rendered: a trial click fails if another control covers the trigger.
  const worktreeEditorVisible = await page.locator('[data-testid="session-identity-editor-trigger"]:visible').first()
    .click({ trial: true, timeout: 3000 }).then(() => true, () => false);
  record('identity editor clickable from a worktree chat', true, worktreeEditorVisible);
  record('worktree name chip stays inside the title column', true, geometry.worktreeChipInsideTitleColumn);
  // Wide window: the header has room again, so the text labels come back.
  // The page's own window: getAllWindows() also holds helper windows.
  const pageUrl = page.url();
  const resize = await app.evaluate(({ BrowserWindow, screen }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url) ?? BrowserWindow.getAllWindows()[0];
    const before = win.getSize();
    const state = { fullScreen: win.isFullScreen(), maximized: win.isMaximized(), max: win.getMaximumSize(),
      workArea: screen.getDisplayMatching(win.getBounds()).workAreaSize };
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setSize(1920, 1000);
    return { before, after: win.getSize(), ...state };
  }, pageUrl);
  await fs.writeFile(path.join(OUT, '04d-resize.json'), JSON.stringify(resize, null, 2));
  await page.waitForTimeout(1000);
  const visibleHeaderLabels = () => page.evaluate(() => {
    const header = [...document.querySelectorAll('.workstream-header')].find((el) => (el as HTMLElement).offsetParent !== null);
    const shown = (selector: string) => !!(header?.querySelector(selector) as HTMLElement | null)?.offsetParent;
    return { innerWidth: window.innerWidth, headerWidth: Math.round(header?.getBoundingClientRect().width ?? 0),
      archive: shown('.workstream-archive-label'), layout: shown('.layout-label') };
  });
  const wide = await visibleHeaderLabels();
  await page.screenshot({ path: path.join(OUT, '04d-worktree-header-wide.png') });
  record('wide header keeps the text labels', { archive: true, layout: true }, { archive: wide.archive, layout: wide.layout });
  await fs.writeFile(path.join(OUT, '04d-wide-header.json'), JSON.stringify(wide, null, 2));
  await app.evaluate(({ BrowserWindow }, { url, size }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url) ?? BrowserWindow.getAllWindows()[0];
    win.setSize(size[0], size[1]);
  }, { url: pageUrl, size: resize.before as [number, number] });
  await page.waitForTimeout(600);
  // Return to automatic: through the editor when reachable, otherwise through the same IPC the editor uses.
  const editor = page.getByTestId('session-identity-editor');
  if (worktreeEditorVisible) {
    await page.locator('[data-testid="session-identity-editor-trigger"]:visible').first().click();
    await editor.getByRole('radio', { name: 'Follow the card (automatic)' }).check();
    await editor.getByTestId('session-identity-apply').click();
  } else {
    await invoke('sessions:set-card-identity', worktreeId, { primaryTrackerId: cardId, cardTitle: RENAMED, purpose: 'Investigation' }, {});
  }
  await expect.poll(async () => (await session(worktreeId)).title, { timeout: 10_000 }).toBe(`${RENAMED} — Investigation`);
  record('return to automatic takes the current card title', { title: `${RENAMED} — Investigation`, namingMode: 'card' },
    { title: (await session(worktreeId)).title, namingMode: (await session(worktreeId)).metadata.namingMode });

  // Custom name and back to automatic through the header editor on an ordinary chat (real UI).
  await row(`${RENAMED} — Implementation`).click();
  await page.locator('[data-testid="session-identity-editor-trigger"]:visible').first().click();
  await expect(editor).toBeVisible();
  await editor.getByRole('radio', { name: 'Custom name' }).check();
  await editor.getByTestId('session-identity-custom-name').fill('SYNTHETIC custom via editor');
  await page.screenshot({ path: path.join(OUT, '04b-identity-editor-custom.png') });
  await editor.getByTestId('session-identity-apply').click();
  await expect.poll(async () => (await session(implementationId)).title, { timeout: 10_000 }).toBe('SYNTHETIC custom via editor');
  await page.locator('[data-testid="session-identity-editor-trigger"]:visible').first().click();
  await editor.getByRole('radio', { name: 'Follow the card (automatic)' }).check();
  await page.screenshot({ path: path.join(OUT, '04c-identity-editor-automatic.png') });
  await editor.getByTestId('session-identity-apply').click();
  await expect.poll(async () => (await session(implementationId)).title, { timeout: 10_000 }).toBe(`${RENAMED} — Implementation`);
  record('editor: custom name, then back to automatic', { title: `${RENAMED} — Implementation`, namingMode: 'card' },
    { title: (await session(implementationId)).title, namingMode: (await session(implementationId)).metadata.namingMode });

  // 6. Keyed SYNTHETIC purpose, and a primary card that is deleted.
  const syntheticId = randomUUID();
  await invoke('sessions:create', { session: { id: syntheticId, title: 'New Session', provider: 'openai-codex' }, workspaceId: workspace });
  const synthetic = await invoke('sessions:set-card-identity', syntheticId,
    { primaryTrackerId: cardId, issueKey: KEY, cardTitle: RENAMED, purpose: 'SYNTHETIC Codex check' }, { numberRepeatedPurpose: true });
  await invoke('tracker:link-session', { trackerId: cardId, sessionId: syntheticId });
  record('keyed SYNTHETIC purpose', `${KEY} · ${RENAMED} — SYNTHETIC Codex check`, synthetic.title);

  // Simultaneous launches from one card, through the real IPC and database: distinct purposes.
  const raceCardId = await createItem('SYNTHETIC Card launched three times at once');
  const raceIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of raceIds) {
    await invoke('sessions:create', { session: { id, title: 'New Session', provider: 'claude-code' }, workspaceId: workspace });
  }
  const raced = await page.evaluate(({ ids, cardId }) => Promise.all(ids.map((id) => (window as any).electronAPI.invoke(
    'sessions:set-card-identity', id,
    { primaryTrackerId: cardId, cardTitle: 'SYNTHETIC Card launched three times at once', purpose: 'Implementation' },
    { numberRepeatedPurpose: true },
  ))), { ids: raceIds, cardId: raceCardId });
  record('simultaneous launches get distinct purposes', ['Implementation', 'Implementation 2', 'Implementation 3'],
    raced.map((result: any) => result.cardIdentity?.purpose).sort());

  const goneId = await createItem(GONE_TITLE);
  const orphanId = randomUUID();
  await invoke('sessions:create', { session: { id: orphanId, title: 'New Session', provider: 'claude-code' }, workspaceId: workspace });
  await invoke('sessions:set-card-identity', orphanId, { primaryTrackerId: goneId, cardTitle: GONE_TITLE, purpose: 'Implementation' }, {});
  await invoke('tracker:link-session', { trackerId: goneId, sessionId: orphanId });
  const deleted = await page.evaluate(({ itemId }) => (window as any).electronAPI.documentService.deleteTrackerItem({ itemId }), { itemId: goneId });
  expect.soft(deleted).toMatchObject({ success: true });
  await page.waitForTimeout(1500);
  const orphan = await session(orphanId);
  record('deleted primary card: last identity kept, no substitute', { title: `${GONE_TITLE} — Implementation`, primary: goneId },
    { title: orphan.title, primary: orphan.metadata.cardIdentity?.primaryTrackerId });

  // 7. Restart, then resume a chat.
  await app.close();
  await launch(true);
  await switchToAgentMode(page);
  const afterRestart = {
    implementation: (await session(implementationId)).title,
    review: (await session(reviewId)).title,
    worktree: (await session(worktreeId)).title,
    synthetic: (await session(syntheticId)).title,
    orphan: (await session(orphanId)).title,
    implementationProvider: (await session(implementationId)).provider,
  };
  record('titles and provider after restart', {
    implementation: `${RENAMED} — Implementation`,
    review: `${RENAMED} — Independent review`,
    worktree: `${RENAMED} — Investigation`,
    synthetic: `${KEY} · ${RENAMED} — SYNTHETIC Codex check`,
    orphan: `${GONE_TITLE} — Implementation`,
    implementationProvider: 'openai-codex',
  }, afterRestart);
  await expect.soft(row(`${RENAMED} — Independent review`)).toBeVisible();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, '05-after-restart.png') });

  await row(`${RENAMED} — Independent review`).click();
  await submitChatPrompt(page, 'SYNTHETIC resumed message after restart');
  await page.waitForTimeout(25_000);
  record('resumed chat keeps its name', `${RENAMED} — Independent review`, (await session(reviewId)).title);

  // 8. Navigation: header key (keyed chat) opens the card; the card lists its chats.
  await row(`${KEY} · ${RENAMED} — SYNTHETIC Codex check`).click();
  const header = page.locator('.workstream-header-title').first();
  await expect.soft(header.getByTestId('session-identity-key')).toHaveText(KEY);
  await page.screenshot({ path: path.join(OUT, '06-header-keyed.png') });
  await header.getByTestId('session-identity-key').click();
  await expect(page.locator('.tracker-sessions-section:visible').first()).toBeVisible({ timeout: 15_000 });
  const linkedCount = await page.locator('.tracker-linked-session:visible').count();
  record('key opens the card, which lists its four chats', 4, linkedCount);
  await page.screenshot({ path: path.join(OUT, '07-card-linked-sessions.png') });

  const snapshot = await page.locator('body').ariaSnapshot();
  await fs.writeFile(path.join(OUT, '08-aria-snapshot.yaml'), snapshot);
});
